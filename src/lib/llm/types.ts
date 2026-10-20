/**
 * LLM 调用的抽象层。
 *
 * 这个接口存在的理由：**换模型、改重试策略、加熔断，都只应该动 adapter 一个文件。**
 * 直接在业务代码里调 SDK 意味着这些横切关注点会渗透到每一个调用点，
 * 而 AI 应用的横切关注点恰恰是最多的：流式、重试、熔断、预算、计量、护栏。
 *
 * 具体 Provider 的能力差异（DeepSeek 的 thinking 模式、缓存计价等）
 * 被收敛在 adapter 内部，对上层只暴露统一的语义。
 */

export type FinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'error';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * 多轮对话消息。
 *
 * ## 为什么需要它（这是 Agent 的前置条件）
 *
 * 原来的 `LLMRequest` 只有 `system` + `prompt` 两个字符串 —— 那是**单轮**的形状。
 * 而工具调用的本质是多轮：
 *
 *     user → [assistant 发起 tool_call] → [tool 结果] → [assistant 再发起] → … → final
 *
 * 每一轮都必须把**完整的消息历史**回传，模型才知道自己刚才调了什么、拿到了什么。
 * 没有表达这个消息序列的地方，就写不出 Agent 循环。
 *
 * ## 向后兼容策略
 *
 * `system` / `prompt` 字段**保留且语义不变**。两者都传时以 `messages` 为准，
 * 但 `system` 仍会被使用（作为 system 消息前置）。
 * 这样现有 232 个单测与全部业务调用点不需要改动。
 *
 * ## 消息形状来自实测（见 ADR-0004）
 *
 *   - assistant 里的工具调用：`{type:'tool-call', toolCallId, toolName, input}`
 *     ⚠️ 字段是 `input`，不是 AI SDK v5 的 `args`
 *   - 工具结果必须包一层 `output`：`{type:'tool-result', …, output:{type:'json', value}}`
 */
export type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      /** 正文（可能为空 —— 模型直接发起工具调用时就没有正文） */
      content: string;
      /**
       * thinking 模式下模型产出的思维链。
       *
       * ⚠️ 只在 `thinking: 'enabled'` 时才有值，且**必须原样回传**，
       * 否则下一轮 API 返回 400（实测见 ADR-0004 探针 2 变体 C）。
       * thinking 关闭时它为 undefined，也不要求回传。
       */
      reasoning?: string;
      toolCalls?: ToolCall[];
    }
  | {
      role: 'tool';
      /** 一个 tool 消息可以携带多个结果（模型一轮可能并发发起多个调用） */
      results: {
        toolCallId: string;
        toolName: string;
        /** 成功时的结果（任意可 JSON 序列化的值） */
        output?: unknown;
        /** 失败时的错误文案。给模型看，让它自己决定重试还是换路 */
        error?: string;
      }[];
    };

export interface LLMRequest {
  model: string;
  /** 单轮的 system（与 messages 可共存） */
  system: string;
  /** 单轮的用户输入（与 messages 可共存） */
  prompt: string;
  /**
   * 多轮消息历史。提供时**优先使用它**，`prompt` 被忽略（`system`仍生效）。
   * Agent 循环用它回传工具调用与结果。
   */
  messages?: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 是否走流式 */
  stream?: boolean;
  /** 启用思考模式（DeepSeek 默认开启；摘要等低延迟场景应关闭） */
  thinking?: 'enabled' | 'disabled';
  /** 思考强度，仅在 thinking 开启时有意义 */
  reasoningEffort?: 'low' | 'high' | 'max';
  /** JSON 输出模式。⚠️ DeepSeek 仅 json_object，非 strict schema，详见 ADR-0003 */
  jsonMode?: boolean;
  tools?: LLMTool[];
  /** 输出预算：超出时调用方应降级而非直接失败 */
  budget?: { maxInputTokens: number; maxOutputTokens: number };
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LLMTool {
  name: string;
  description: string;
  /** JSON Schema 格式的参数定义 */
  parameters: Record<string, unknown>;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  /** 命中前缀缓存的输入 token 数。DeepSeek 按此分档计价，差异达 50 倍 */
  cachedTokens: number;
}

export interface LLMResult {
  text: string;
  provider: string;
  model: string;
  usage: LLMUsage;
  finishReason: FinishReason;
  /** 首token 延迟 —— AI 应用最关键的性能指标 */
  ttftMs: number;
  totalMs: number;
  toolCalls?: ToolCall[];
  /** 适配器附加信息（原样保留，便于排查各Provider 的差异） */
  meta?: Record<string, unknown>;
}

/**
 * 流式增量事件。
 * 区分 reasoning 与正文，是因为 DeepSeek 的思考模式会先输出一段思维链——
 * 这部分不该污染最终摘要内容，但可以单独展示给用户看「它在思考什么」。
 */
export type StreamEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'usage'; usage: LLMUsage }
  | { type: 'done'; finishReason: FinishReason };

export interface LLMProvider {
  readonly name: string;
  /** 支持的能力声明，供上层按需裁剪请求 */
  readonly capabilities: ProviderCapabilities;
  generate(req: LLMRequest): Promise<LLMResult>;
  stream(req: LLMRequest): AsyncGenerator<StreamEvent>;
  /** 是否有可用凭证，未配置时不参与路由 */
  isAvailable(): boolean;
}

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  jsonMode: boolean;
  /** 是否区分cache hit / miss 计价 */
  promptCaching: boolean;
  thinking: boolean;
}

/** 把错误归类，决定是否值得重试 */
export class LLMError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/**
 * 错误分类。
 *
 * 关键判断：**4xx 参数错误与内容过滤不重试**。
 * 重试一个必然失败的请求只是浪费 token 和时间，还会把熔断器的失败计数打脏。
 * 只有 429（限流）、5xx（服务端故障）、网络超时才值得退避重试。
 */
export function classifyError(e: unknown): LLMError {
  if (e instanceof LLMError) return e;

  const err = e as { statusCode?: number; status?: number; message?: string; name?: string };

  // 超时 / 中断
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return new LLMError(err.message ?? '请求超时', 'TIMEOUT', true);
  }

  const status = err?.statusCode ?? err?.status;
  if (typeof status === 'number') {
    if (status === 429) return new LLMError(err.message ?? '触发限流', 'RATE_LIMITED', true);
    if (status >= 500) return new LLMError(err.message ?? '上游服务异常', 'UPSTREAM_ERROR', true);
    if (status === 401 || status === 403) {
      return new LLMError(err.message ?? '凭证无效', 'UNAUTHORIZED', false);
    }
    if (status === 400) return new LLMError(err.message ?? '请求参数错误', 'BAD_REQUEST', false);
    if (status === 402) {
      return new LLMError(err.message ?? '余额不足', 'INSUFFICIENT_BALANCE', false);
    }
  }

  // 内容过滤
  if (err?.message?.includes('content_filter')) {
    return new LLMError('内容被安全策略拦截', 'CONTENT_FILTER', false);
  }

  // 网络层
  if (err?.message && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(err.message)) {
    return new LLMError(err.message, 'NETWORK_ERROR', true);
  }

  return new LLMError(err?.message ?? '未知错误', 'UNKNOWN', false);
}
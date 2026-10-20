import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  generateText,
  jsonSchema,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';

/**
 * providerOptions 的类型不导出，只能从 SDK 的参数类型反推。
 *这样避免了硬编码 SDK 的内部结构 —— SDK 升级时若类型变了，这里会立刻报错，
 *而不是等到运行时才发现参数被静默忽略。
 */
type ProviderOptionsShape = NonNullable<
  Parameters<typeof generateText>[0]['providerOptions']
>;
import {
  LLMError,
  classifyError,
  type LLMProvider,
  type LLMMessage,
  type LLMRequest,
  type LLMResult,
  type LLMTool,
  type ProviderCapabilities,
  type StreamEvent,
  type LLMUsage,
} from '../types';

// ============================================================
// 消息与工具的转换层
//
// 本项目的消息形状与 AI SDK 的形状有几处**必须转换**的差异，
// 而且都是实测出来的（见 ADR-0004）：
//   - 工具调用参数：我们用 `arguments`，SDK 用 `input`（v5 曾是 `args`）
//   - 工具结果必须包一层 `output: { type, value }`
//   - 工具的 JSON Schema 要经 `jsonSchema()` 标记，否则 SDK 会当普通对象
// 集中在这两个函数里，是为了让「SDK 升级导致形状变化」只有一个修改点。
// ============================================================

/** 本项目的 LLMMessage[] → AI SDK ModelMessage[] */
export function toModelMessages(messages: LLMMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const m of messages) {
    switch (m.role) {
      case 'system':
        out.push({ role: 'system', content: m.content });
        break;

      case 'user':
        out.push({ role: 'user', content: m.content });
        break;

      case 'assistant': {
        const content: Record<string, unknown>[] = [];

        /**
         * ⚠️ reasoning 必须排在 tool-call 之前，且只在 thinking 开启时才有值。
         *
         * 实测确认：thinking 模式下不回传 reasoning_content 会被 API 拒绝
         * （`The reasoning_content in the thinking mode must be passed back`）。
         * 顺序上放在最前，与模型原始输出顺序一致 —— 有些 provider 对顺序敏感。
         */
        if (m.reasoning) {
          content.push({ type: 'reasoning', text: m.reasoning });
        }
        if (m.content) {
          content.push({ type: 'text', text: m.content });
        }
        for (const call of m.toolCalls ?? []) {
          content.push({
            type: 'tool-call',
            toolCallId: call.id,
            toolName: call.name,
            input: call.arguments,
          });
        }

        // 内容为空数组时给一个空文本，避免某些 provider 报「content 不能为空」
        out.push({
          role: 'assistant',
          content: content.length > 0 ? (content as never) : '',
        });
        break;
      }

      case 'tool': {
        out.push({
          role: 'tool',
          content: m.results.map((r) => ({
            type: 'tool-result' as const,
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            /**
             * 工具失败时用 `error-text` 而不是抛出去中断循环。
             *
             * 这是 Agent 能自我修复的关键：把错误当作**观察结果**交给模型，
             * 它才能决定「换个关键词重试」还是「换一条路」。
             * 直接抛错会让一次工具失败升级成整个任务失败。
             */
            output:
              r.error !== undefined
                ? { type: 'error-text' as const, value: r.error }
                : { type: 'json' as const, value: (r.output ?? null) as never },
          })) as never,
        });
        break;
      }
    }
  }

  return out;
}

/** 本项目的 LLMTool[] → AI SDK ToolSet（不含 execute —— 由 Agent 循环自己执行） */
export function toToolSet(tools: LLMTool[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters as never),
      // ⚠️ 刻意不提供 execute：Agent 循环要自己控制执行、落库轨迹、限制额度。
      // 交给 SDK 自动执行就拿不到「每一步做了什么」的可见性。
    });
  }
  return set;
}

/**
 * 组装请求的消息。
 *
 * 优先用 `messages`（多轮 / Agent），否则回落到单轮的 system + prompt。
 * 这条回落保证了现有全部业务调用点**一行都不用改**。
 */
function buildMessages(req: LLMRequest): {
  instructions: string | undefined;
  messages: ModelMessage[] | undefined;
  prompt: string | undefined;
} {
  if (req.messages && req.messages.length > 0) {
    return {
      // system 仍走 instructions —— 它是缓存前缀的一部分，放这里更稳定
      instructions: req.system || undefined,
      messages: toModelMessages(req.messages),
      prompt: undefined,
    };
  }
  return { instructions: req.system, messages: undefined, prompt: req.prompt };
}

/**
 * DeepSeek 适配器。
 *
 * 核对日期 2026-10-11，来源 api-docs.deepseek.com。
 * 本文件把 DeepSeek 的能力约束「编译」进类型与参数裁剪，
 * 而不是依赖调用方自觉 —— 详见 docs/adr/0003-deepseek-capability-constraints.md。
 *
 * 三条最容易踩的坑，在这里被显式处理：
 *
 * 1. **thinking 模式下 temperature / presence_penalty / frequency_penalty 被静默忽略**
 *    注意是「不报错但无效果」。如果只是把 temperature 透传出去，
 *    代码看起来在控制随机性，实际完全没用，排障时会怀疑人生。
 *    所以这里在 thinking 开启时主动剔除这些参数。
 *
 * 2. **JSON Output 需要 prompt 中包含 "json" 字样并给出格式示例**
 *    仅设 response_format 不够。
 *
 * 3. **JSON Output 官方明示可能偶发返回空 content**
 *    因此上层必须处理空返回，而不是假设一定有值。
 */

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: true,
  jsonMode: true,
  promptCaching: true,
  thinking: true,
};

/**
 * 构造采样参数。
 *
 * ⚠️ AI SDK v7 的 API 变更（相对 v5）：
 *   - `system`      → `instructions`
 *   - `maxTokens`   → `maxOutputTokens`
 *   - `responseFormat` → `providerOptions`（各家自定义参数统一走这里）
 *
 * 这是本适配器最核心的逻辑：DeepSeek 会**静默忽略** thinking 模式下的采样参数，
 * 所以必须由我们自己裁剪，否则「设了 temperature=0.3 保证摘要稳定」其实是假的。
 */
export function buildSamplingParams(req: LLMRequest): {
  maxOutputTokens: number;
  temperature?: number;
  reasoningEffort?: string;
  providerOptions: ProviderOptionsShape;
} {
  const params: {
    maxOutputTokens: number;
    temperature?: number;
    reasoningEffort?: string;
    providerOptions: ProviderOptionsShape;
  } = {
    maxOutputTokens: req.maxTokens ?? 2000,
    // 必须初始化，否则 thinking 关闭时 providerOptions 为 undefined 会类型报错
    providerOptions: {},
  };

  const thinkingOn = (req.thinking ?? 'disabled') === 'enabled';

  if (thinkingOn) {
    // 思考模式：仅 reasoningEffort 有意义，采样参数全部剔除
    if (req.reasoningEffort) params.reasoningEffort = req.reasoningEffort;
  } else {
    // 非思考模式：temperature / top_p 才真正生效
    if (req.temperature !== undefined) params.temperature = req.temperature;
    // top_p 在非思考模式下固定为 1.0，传入会被忽略，故不设
  }

  // DeepSeek 的 thinking 与 reasoningEffort 都不是标准字段，
  // 必须通过 providerOptions 透传给 openai-compatible provider。
  // JSONObject 要求值必须是 JSON 兼容类型，故用具体字面量而非 unknown。
  // 类型定义为可变形态，以便按需追加 response_format。
  const deepseekOptions: {
    thinking: { type: 'enabled' | 'disabled' };
    response_format?: { type: 'json_object' };
  } = {
    thinking: { type: thinkingOn ? 'enabled' : 'disabled' },
  };

  // JSON 模式。注意 DeepSeek 只支持 json_object，不保证符合 JSON Schema，
  // 因此 schema 的约束必须靠 prompt 内嵌格式说明来施加。
  if (req.jsonMode) deepseekOptions.response_format = { type: 'json_object' };

  params.providerOptions = { deepseek: deepseekOptions };

  return params;
}

export class DeepSeekProvider implements LLMProvider {
  readonly name = 'deepseek';
  readonly capabilities = CAPABILITIES;

  /**
   * ⚠️ 这里存的是「工厂」而不是某一个模型实例。
   *
   * 早先的写法是构造函数里 `this.model = compatible('deepseek-flash')`，
   * 于是 `req.model` 被彻底忽略 —— 而 registry 的降级链正是靠
   * 「同一个 provider 传不同 model」来实现 flash → v4-pro 这一档换型号的。
   * 结果就是：flash 挂了以后，链路上的 v4-pro 那一步其实还是拿 flash 去打，
   * 白等一轮重试再掉到跨厂商。**降级链看起来四层，实际只有三层。**
   *
   * 把工厂存下来、每次请求按 req.model 建实例，这一档才真正生效。
   */
  private readonly compatible: ReturnType<typeof createOpenAICompatible>;

  /** 兜底默认模型：调用方没传 model 时用（正常路径不会走到） */
  private readonly defaultModel: string;

  constructor(apiKey: string, baseURL: string, defaultModel = 'deepseek-flash') {
    this.compatible = createOpenAICompatible({
      name: 'deepseek',
      apiKey,
      baseURL,
    });
    this.defaultModel = defaultModel;
  }

  /** 按请求解析出真正的模型。空字符串等异常值回落到默认模型 */
  private modelFor(req: LLMRequest): LanguageModel {
    return this.compatible(req.model || this.defaultModel);
  }

  isAvailable(): boolean {
    return true;
  }

  async generate(req: LLMRequest): Promise<LLMResult> {
    const startedAt = Date.now();

    try {
      const sampling = buildSamplingParams(req);
      const built = buildMessages(req);
      const result = await generateText({
        model: this.modelFor(req),
        ...(built.instructions ? { instructions: built.instructions } : {}),
        ...(built.messages ? { messages: built.messages } : { prompt: built.prompt ?? '' }),
        abortSignal: req.signal,
        // 只有传了工具才带上 tools/toolChoice，否则会多出一个空数组参数
        ...(req.tools && req.tools.length > 0
          ? { tools: toToolSet(req.tools), toolChoice: 'auto' as const }
          : {}),
        ...sampling,
      });

      // 非流式调用没有真实的「首 token」时刻，用整体耗时近似
      const totalMs = Date.now() - startedAt;
      const usage = normalizeUsage(result.usage, result.providerMetadata);

      /**
       * 从 steps 里收集工具调用。
       *
       * 非流式下一次请求可能产生多步（SDK 自动循环），所以要把每一步的
       * toolCalls 都收上来。Agent 循环虽然自己做编排，但这里保持完整，
       * 免得将来有人直接用 generate 走多步时漏掉调用记录。
       */
      const toolCalls = (result.steps ?? []).flatMap((step) => {
        const calls = (step as { toolCalls?: unknown[] }).toolCalls ?? [];
        return calls.map((c) => {
          const call = c as { toolCallId?: string; toolName?: string; input?: unknown };
          return {
            id: call.toolCallId ?? '',
            name: call.toolName ?? '',
            arguments: (call.input ?? {}) as Record<string, unknown>,
          };
        });
      });

      return {
        text: result.text ?? '',
        provider: this.name,
        model: req.model,
        usage,
        finishReason: mapFinishReason(result.finishReason),
        ttftMs: totalMs,
        totalMs,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        meta: {
          reasoning: extractReasoning(result.providerMetadata, result.steps),
          providerMetadata: result.providerMetadata,
        },
      };
    } catch (e) {
      throw wrapError(e);
    }
  }

  async *stream(req: LLMRequest): AsyncGenerator<StreamEvent> {
    let ttftSent = false;
    let firstTokenAt = 0;

    try {
      const sampling = buildSamplingParams(req);
      const built = buildMessages(req);
      const result = streamText({
        model: this.modelFor(req),
        ...(built.instructions ? { instructions: built.instructions } : {}),
        ...(built.messages ? { messages: built.messages } : { prompt: built.prompt ?? '' }),
        abortSignal: req.signal,
        ...(req.tools && req.tools.length > 0
          ? { tools: toToolSet(req.tools), toolChoice: 'auto' as const }
          : {}),
        ...sampling,
      });

      /**
       * 累积本次流里的工具调用。
       *
       * ⚠️ 实测（ADR-0004 流式探针）：流式下工具参数会先以
       * `tool-input-start` / `tool-input-delta`（JSON 字符串分片）/
       * `tool-input-end` 的形式到达，最后才有一个 `tool-call` 事件，
       * **且该事件自带完整解析好的参数**。
       *
       * 所以这里只需在 `tool-call` 事件上取值，不必自己拼分片 ——
       * 拼分片是容易写错且没必要的活。下面记录到的 delta 只用于
       * 在工具参数很大时给用户「正在生成参数」的进度感。
       */
      const collectedCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];

      // ⚠️ AI SDK v7 的事件结构变化：
      //   - reasoning 事件类型是 'reasoning-delta'（我最初写成 'reasoning'，不存在）
      //   - tool-call 的入参字段是 `input`（不是 v5 的 `args`）
      //   - finish 事件**不含** providerMetadata（usage 从 totalUsage 取）
      for await (const part of result.fullStream) {
        // 首 token 延迟：从开始到收到第一个增量
        if (!ttftSent && (part.type === 'text-delta' || part.type === 'reasoning-delta')) {
          firstTokenAt = Date.now();
          ttftSent = true;
        }

        switch (part.type) {
          case 'text-delta': {
            const delta = (part as { text?: string }).text ?? '';
            if (delta) yield { type: 'text', delta };
            break;
          }
          case 'reasoning-delta': {
            const delta = (part as { text?: string }).text ?? '';
            if (delta) yield { type: 'reasoning', delta };
            break;
          }
          case 'tool-call': {
            const call = part as unknown as {
              toolCallId: string;
              toolName: string;
              input?: unknown;
            };
            const normalized = {
              id: call.toolCallId,
              name: call.toolName,
              arguments: (call.input ?? {}) as Record<string, unknown>,
            };
            collectedCalls.push(normalized);
            yield { type: 'tool-call', call: normalized };
            break;
          }
          case 'finish': {
            const usage = normalizeUsage(part.totalUsage);
            yield { type: 'usage', usage };
            yield { type: 'done', finishReason: mapFinishReason(part.finishReason) };
            break;
          }
          case 'error': {
            throw part.error;
          }
          default:
            break;
        }
      }

      // TTFT 由 service 层从首个 text 事件的时间戳推算，这里无需额外传递
      void firstTokenAt;

    } catch (e) {
      throw wrapError(e);
    }
  }
}

/**
 * 归一化 usage。
 *
 * ⚠️ **服务端绝不信任客户端传来的 token 数**，一律以 Provider 返回为准。
 * 客户端可以伪造上报来掩盖成本，所以 token 统计只能在服务端做。
 *
 * DeepSeek 的缓存命中数在 providerMetadata 里（cacheHitInputTokens），
 * 不同 SDK 版本字段名有差异，这里做多字段兜底 —— 这是适配器该干的事，不该让上层操心。
 */
function normalizeUsage(
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  providerMetadata?: unknown,
): LLMUsage {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;

  let cachedTokens = 0;
  if (providerMetadata && typeof providerMetadata === 'object') {
    const meta = providerMetadata as Record<string, Record<string, unknown> | undefined>;
    for (const key of ['deepseek', 'openai-compatible']) {
      const entry = meta[key];
      if (!entry) continue;
      const candidates = [
        entry.cachedInputTokens,
        entry.cacheHitInputTokens,
        entry.promptTokensDetails && typeof entry.promptTokensDetails === 'object'
          ? (entry.promptTokensDetails as { cachedTokens?: number }).cachedTokens
          : undefined,
      ];
      const hit = candidates.find((c): c is number => typeof c === 'number');
      if (typeof hit === 'number') {
        cachedTokens = hit;
        break;
      }
    }
  }

  // 兜底：命中数不可能超过输入总量
  if (cachedTokens > inputTokens) cachedTokens = inputTokens;

  return { inputTokens, outputTokens, cachedTokens };
}

/**
 * 提取思维链文本。
 *
 * ## ⚠️ 实测纠正（ADR-0004）
 *
 * 原实现只在 `providerMetadata` 里找 `reasoning` 字段。实测发现：
 *
 *   - thinking **关闭**时，`root.reasoning` 是空字符串，
 *     且 `providerMetadata.deepseek` 是**空对象**（key 集为空）
 *   - thinking **开启**时，reasoning 的正式位置是
 *     **assistant 内容的 `ReasoningPart`**（`{type:'reasoning', text}`），
 *     同时响应根上有 `reasoningText`
 *
 * 所以「只翻 providerMetadata」的写法在两种模式下都拿不到值 —— 它会安静地
 * 返回 undefined，表现为「思维链功能没生效」，而不报任何错。
 *
 * 现在的查找顺序：根上的 reasoningText → steps 的 content parts → providerMetadata 兜底。
 */
function extractReasoning(providerMetadata?: unknown, steps?: unknown[]): string | undefined {
  // 1) steps 的 assistant 内容里找 ReasoningPart（最可靠的位置）
  if (Array.isArray(steps)) {
    const parts: string[] = [];
    for (const step of steps) {
      const content = (step as { content?: unknown[] }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const p = part as { type?: string; text?: string };
        if (p?.type === 'reasoning' && typeof p.text === 'string' && p.text) {
          parts.push(p.text);
        }
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }

  // 2) providerMetadata 兜底（其它 provider 可能放在这里）
  if (providerMetadata && typeof providerMetadata === 'object') {
    const meta = providerMetadata as Record<string, unknown>;
    for (const entry of Object.values(meta)) {
      if (entry && typeof entry === 'object') {
        const r = (entry as Record<string, unknown>).reasoning;
        if (typeof r === 'string' && r) return r;
      }
    }
  }

  return undefined;
}

function mapFinishReason(reason: string | undefined): LLMResult['finishReason'] {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'content-filter':
      return reason === 'content-filter' ? 'content_filter' : reason;
    case 'tool-calls':
      return 'tool_calls';
    case 'error':
      return 'error';
    default:
      return 'stop';
  }
}

function wrapError(e: unknown): LLMError {
  const err = classifyError(e);
  // DeepSeek 把部分错误放在 error.body 中，统一提取以便展示
  if (err.code === 'UNKNOWN' && e && typeof e === 'object') {
    const body = (e as { body?: string }).body;
    if (typeof body === 'string') {
      return new LLMError(body, 'UPSTREAM_ERROR', false);
    }
  }
  return err;
}
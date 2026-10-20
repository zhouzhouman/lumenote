import type {
  LLMProvider,
  LLMRequest,
  LLMResult,
  LLMMessage,
  StreamEvent,
  ProviderCapabilities,
} from '@/lib/llm/types';
import type { AgentToolContext } from '@/lib/agent/tools';
import type { TextChunk } from '@/lib/pipeline/chunk';

/**
 * Agent 测试用的共享替身与夹具。
 *
 * ## 为什么用「脚本化的假 provider」
 *
 * 状态机的正确性（预算到顶会不会收敛、额度用尽会不会死循环、
 * 重复调用会不会被拦住）必须能被确定性地测试。靠真实模型来测，
 * 断言就变成「模型这次应该调两次工具」—— 那是测模型不是测代码，必然 flaky。
 *
 * 脚本化 provider 按剧本逐个返回结果：剧本写「第 1 轮调 search_chunks，
 * 第 2 轮给结论」，代码就必须照此推进。这样每一条预算/护栏逻辑都能精确命中。
 */

export interface ScriptStep {
  text?: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** 适配器附加信息，例如 DeepSeek 的 reasoning */
  meta?: Record<string, unknown>;
  /** 设为 true 时这一步抛出错误，用于测失败路径 */
  throws?: Error;
}

export class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    tools: true,
    jsonMode: true,
    promptCaching: false,
    thinking: true,
  };

  /** 记录收到的请求，便于断言「消息历史是否被正确累积」「请求形状是否不变」 */
  readonly requests: LLMRequest[] = [];
  private index = 0;

  constructor(private readonly script: ScriptStep[]) {}

  isAvailable() {
    return true;
  }

  async generate(req: LLMRequest): Promise<LLMResult> {
    this.requests.push(req);
    const step = this.script[this.index];
    this.index += 1;

    if (!step) {
      // 剧本用尽：返回一个终止性的空结论，避免测试挂死
      return makeResult({ text: '{"conclusions":[]}' });
    }
    if (step.throws) throw step.throws;
    return makeResult(step);
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    throw new Error('scripted provider 不支持流式');
  }
}

export function makeResult(step: ScriptStep): LLMResult {
  return {
    text: step.text ?? '',
    provider: 'scripted',
    model: 'scripted-model',
    usage: {
      inputTokens: step.inputTokens ?? 100,
      outputTokens: step.outputTokens ?? 20,
      cachedTokens: step.cachedTokens ?? 0,
    },
    finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
    ttftMs: 10,
    totalMs: 20,
    ...(step.toolCalls ? { toolCalls: step.toolCalls } : {}),
    ...(step.meta ? { meta: step.meta } : {}),
  };
}

export function makeChunks(texts: string[]): TextChunk[] {
  return texts.map((content, index) => ({ index, content, tokens: 10 }));
}

export const CTX: AgentToolContext = {
  glossary: [],
  loadTaskOutput: async () => null,
};

export const FINAL_JSON = JSON.stringify({
  conclusions: [
    {
      text: '缓存命中率是最重要的成本指标',
      evidence: [{ source: 'chunk:1', quote: '缓存命中率' }],
      confidence: 'high',
    },
  ],
  limitations: [],
});

/** 取一个请求里所有 tool 消息（消息历史断言用） */
export type ToolMessage = Extract<LLMMessage, { role: 'tool' }>;

export function findToolMessages(req: LLMRequest | undefined): ToolMessage[] {
  return (req?.messages ?? []).filter((m): m is ToolMessage => m.role === 'tool');
}

/** 取一个请求里第 index 条消息的正文（tool 消息没有 content，返回空串） */
export function messageContentAt(req: LLMRequest | undefined, index: number): string {
  const message = req?.messages?.[index];
  return message && 'content' in message ? message.content : '';
}

/** 取一个请求最后一条消息的正文（收敛提示断言用） */
export function lastMessageContent(req: LLMRequest | undefined): string {
  return messageContentAt(req, (req?.messages?.length ?? 0) - 1);
}

/** 取一个请求里的 assistant 消息（多轮历史断言用） */
export type AssistantMessage = Extract<LLMMessage, { role: 'assistant' }>;

export function findAssistantMessages(req: LLMRequest | undefined): AssistantMessage[] {
  return (req?.messages ?? []).filter((m): m is AssistantMessage => m.role === 'assistant');
}

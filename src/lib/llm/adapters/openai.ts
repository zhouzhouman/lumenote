import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, type LanguageModel } from 'ai';
import {
  classifyError,
  type LLMProvider,
  type LLMRequest,
  type LLMResult,
  type ProviderCapabilities,
  type StreamEvent,
  type LLMUsage,
} from '../types';

/**
 * OpenAI 适配器（跨厂商降级备用）。
 *
 * 存在的意义不是「多 Provider 多漂亮」，而是**DeepSeek 整体不可用时用户不至于白屏**。
 * 降级到不同厂商会损失一些模型特性（比如 DeepSeek 的 thinking 模式），
 * 但拿到一个可用的回答，比拿到一个 500 强得多。
 *
 * 代价要说清楚：跨厂商降级后 Prompt 表现不一致，且无法跨厂商命中前缀缓存。
 * 所以它排在最后一位，只在主 Provider 熔断时才启用。
 */

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: true,
  jsonMode: true,
  promptCaching: true,
  thinking: false,
};

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly capabilities = CAPABILITIES;

  // 与 DeepSeek 适配器同理：存工厂而不是单个模型实例，
  // 否则 req.model 被忽略，降级链里指定备用模型那一步等于没写。
  private readonly openai: ReturnType<typeof createOpenAI>;
  private readonly defaultModel: string;

  constructor(apiKey: string, defaultModel = 'gpt-4o-mini') {
    this.openai = createOpenAI({ apiKey });
    this.defaultModel = defaultModel;
  }

  private modelFor(req: LLMRequest): LanguageModel {
    return this.openai(req.model || this.defaultModel);
  }

  isAvailable(): boolean {
    return true;
  }

  async generate(req: LLMRequest): Promise<LLMResult> {
    const startedAt = Date.now();
    try {
      const result = await generateText({
        model: this.modelFor(req),
        instructions: req.system,
        prompt: req.prompt,
        temperature: req.temperature ?? 0.3,
        maxOutputTokens: req.maxTokens ?? 2000,
        abortSignal: req.signal,
        ...(req.jsonMode
          ? { providerOptions: { openai: { response_format: { type: 'json_object' } } } }
          : {}),
      });

      return {
        text: result.text ?? '',
        provider: this.name,
        model: req.model,
        usage: normalize(result.usage),
        finishReason: 'stop',
        ttftMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
      };
    } catch (e) {
      throw classifyError(e);
    }
  }

  async *stream(req: LLMRequest): AsyncGenerator<StreamEvent> {
    try {
      const result = streamText({
        model: this.modelFor(req),
        instructions: req.system,
        prompt: req.prompt,
        temperature: req.temperature ?? 0.3,
        maxOutputTokens: req.maxTokens ?? 2000,
        abortSignal: req.signal,
        ...(req.jsonMode
          ? { providerOptions: { openai: { response_format: { type: 'json_object' } } } }
          : {}),
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            if (part.text) yield { type: 'text', delta: part.text };
            break;
          case 'finish':
            yield { type: 'usage', usage: normalize(part.totalUsage) };
            yield { type: 'done', finishReason: 'stop' };
            break;
          case 'error':
            throw part.error;
          default:
            break;
        }
      }
    } catch (e) {
      throw classifyError(e);
    }
  }
}

function normalize(usage: { inputTokens?: number; outputTokens?: number } | undefined): LLMUsage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedTokens: 0,
  };
}
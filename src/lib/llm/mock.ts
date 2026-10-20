import {
  classifyError,
  type LLMProvider,
  type LLMRequest,
  type LLMResult,
  type ProviderCapabilities,
  type StreamEvent,
  type LLMUsage,
} from './types';

/**
 * 本地模拟 Provider。
 *
 * 三个用途，都是真实需求而不是玩具：
 *  1. **预览环境省钱**：Vercel 每次 push 都部署，预览环境跑真实 LLM 会持续烧钱
 *  2. **无凭证开发**：拿不到 key 也能跑通端到端链路，不至于卡在第一步
 *  3. **测试确定性**：单测不该依赖外部网络与真实计费
 *
 * 模拟输出刻意做成「带延时的流式」，因为真实流式的行为（逐 token、
 * 可中止、可能中途失败）需要在开发阶段就被真实感受到。
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    tools: false,
    jsonMode: false,
    promptCaching: false,
    thinking: false,
  };

  isAvailable(): boolean {
    return true;
  }

  async generate(req: LLMRequest): Promise<LLMResult> {
    const startedAt = Date.now();
    const text = buildMockSummary(req.prompt);
    return {
      text,
      provider: this.name,
      model: req.model,
      usage: { inputTokens: estimateTokens(req.system + req.prompt), outputTokens: estimateTokens(text), cachedTokens: 0 },
      finishReason: 'stop',
      ttftMs: Date.now() - startedAt,
      totalMs: Date.now() - startedAt,
    };
  }

  async *stream(req: LLMRequest): AsyncGenerator<StreamEvent> {
    const startedAt = Date.now();
    const text = buildMockSummary(req.prompt);

    // 模拟首 token 延迟
    await sleep(60);
    const ttftMs = Date.now() - startedAt;

    // 逐字推送，模拟真实流式体验
    const pieces = text.match(/.{1,4}/gs) ?? [];
    for (const piece of pieces) {
      await sleep(12);
      yield { type: 'text', delta: piece };
    }

    const usage: LLMUsage = {
      inputTokens: estimateTokens(req.system + req.prompt),
      outputTokens: estimateTokens(text),
      cachedTokens: 0,
    };
    yield { type: 'usage', usage };
    yield { type: 'done', finishReason: 'stop' };
    void ttftMs;
  }
}

function buildMockSummary(prompt: string): string {
  const preview = prompt.replace(/\s+/g, ' ').slice(0, 120);
  return [
    '> ⚠️ 这是 **Mock 模式**输出，未调用真实模型。设置 `MOCK_LLM=false` 并配置 `DEEPSEEK_API_KEY` 可关闭。',
    '',
    '## 摘要（模拟）',
    '',
    `- 输入开头：${preview}…`,
    `- 估算长度：${estimateTokens(prompt)} tokens`,
    '',
    '## 建议关注',
    '',
    '1. 文档的核心论点与论据链条',
    '2. 作者给出的关键数据与前提假设',
    '3. 结论的适用边界（哪些场景下不成立）',
    '',
    '真实模式下的输出会随模型与 Prompt 版本变化，',
    '并在任务详情页记录所用的 Prompt 版本号与 Token 用量。',
  ].join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Token 粗略估算。
 *
 * 为什么不引入 tiktoken 之类的精确 tokenizer？
 * 因为 DeepSeek 的分词规则不公开，任何第三方 tokenizer 都是近似。
 * 而我们这里只需要「够用的量级判断」来驱动分块与预算控制，
 * 不需要精确计费 —— 真实计费一律以 Provider 返回的 usage 为准。
 *
 * 中英混排场景下，约 1 个汉字 ≈ 1 token，1 个英文单词 ≈ 1.3 token。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[一-鿿　-〿]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 3.2);
}

export { classifyError };
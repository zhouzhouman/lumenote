import type {
  LLMProvider,
  LLMRequest,
  LLMResult,
  ProviderCapabilities,
  StreamEvent,
} from '@/lib/llm/types';

/**
 * **脚本化的确定性 Provider（仅测试/报告演示用，不是生产 Provider）**。
 *
 * ## 它解决什么问题
 *
 * `MockProvider` 不支持工具调用（capabilities.tools = false），而 Agent 的
 * 完整链路 span（plan → tool → observe → finalize → evidence_check）必须先有
 * 一轮「模型发起工具调用」才可能出现。没有它，Agent 侧 tracing 的父子关系
 * 就只能靠人工 review 代码。
 *
 * 这个 Provider 按固定剧本返回：
 *   第 1 次 generate → 发起一次 search_chunks 工具调用
 *   第 2 次 generate → 返回带 `chunk:N` 证据引用的结构化 JSON 结论
 *
 * ## ⚠️ 它不代表任何模型质量
 *
 * 输出是**写死的**。它只能证明：
 *   - Agent 状态机在一次真实调用序列下能跑通；
 *   - trace 的父子关系/taskId 贯穿正确；
 *   - 证据链校验（checkEvidence）在「有合法引用」时返回 100%。
 * 绝不能把它的结果当作真实模型效果写进评测报告。
 *
 * 放在 `src/lib/eval` 而不是测试目录，是为了让「单测」与「评测报告脚本」
 * 共用同一份剧本，避免两处行为漂移。
 */

/** 剧本第 1 步发起的检索关键词 */
export const SCRIPTED_TOOL_QUERY = '缓存命中率';

/** 剧本第 2 步返回的证据引用（必须在被分析的文档里真实存在） */
export const SCRIPTED_EVIDENCE_QUOTE = '缓存命中率是 AI 应用里最重要的成本杠杆。';

export interface ScriptedProviderOptions {
  /** 第 2 步返回的结构化结论（默认引用 SCRIPTED_EVIDENCE_QUOTE） */
  conclusionText?: string;
  /** 工具调用参数 */
  toolArguments?: Record<string, unknown>;
}

export class ScriptedAgentProvider implements LLMProvider {
  readonly name = 'scripted-mock';
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    tools: true,
    jsonMode: true,
    promptCaching: false,
    thinking: false,
  };

  private calls = 0;

  constructor(private readonly options: ScriptedProviderOptions = {}) {}

  /** 已被调用次数（测试断言用） */
  get callCount(): number {
    return this.calls;
  }

  isAvailable(): boolean {
    return true;
  }

  async generate(req: LLMRequest): Promise<LLMResult> {
    this.calls += 1;
    const base = {
      provider: this.name,
      model: req.model,
      ttftMs: 5,
      totalMs: 5,
    } as const;

    if (this.calls === 1) {
      return {
        ...base,
        text: '',
        finishReason: 'tool_calls',
        usage: { inputTokens: 420, outputTokens: 12, cachedTokens: 0 },
        toolCalls: [
          {
            id: 'call_scripted_1',
            name: 'search_chunks',
            arguments: this.options.toolArguments ?? { query: SCRIPTED_TOOL_QUERY, topK: 3 },
          },
        ],
      };
    }

    const quote = this.options.conclusionText ?? SCRIPTED_EVIDENCE_QUOTE;
    const json = {
      conclusions: [
        {
          text: quote,
          evidence: [{ source: 'chunk:0', quote }],
          confidence: 'high',
        },
      ],
      limitations: ['脚本化 Provider：输出为固定剧本，不代表真实模型质量。'],
    };

    return {
      ...base,
      text: `根据检索结果：\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``,
      finishReason: 'stop',
      usage: { inputTokens: 760, outputTokens: 140, cachedTokens: 0 },
    };
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    throw new Error('ScriptedAgentProvider 只用于非流式 generate（测试/报告演示）');
  }
}

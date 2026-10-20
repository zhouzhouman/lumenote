import { describe, it, expect } from 'vitest';
import {
  runAgent,
  parseStructuredOutput,
  checkEvidence,
  checkTrajectory,
  normalizeForMatch,
  parseChunkRef,
  canonicalizeArgs,
  extractDisplayText,
  REPEAT_STOP_THRESHOLD,
  type AgentStructuredOutput,
} from '@/lib/agent/loop';
import {
  runSearchChunks,
  runListSections,
  runDiffWithText,
  appendChunks,
  TOOL_NAMES,
  TOOL_QUOTAS,
} from '@/lib/agent/tools';
import type { LLMProvider, LLMRequest, LLMResult, StreamEvent, ProviderCapabilities } from '@/lib/llm/types';
import type { TextChunk } from '@/lib/pipeline/chunk';

/**
 * Agent 状态机与工具的单测。
 *
 * ## 为什么这些测试用了「脚本化的假 provider」
 *
 * 状态机的正确性（预算到顶会不会收敛、额度用尽会不会死循环、
 * 重复调用会不会被拦住）**必须能被确定性地测试**。
 * 如果靠真实模型来测，断言就变成"模型这次应该调两次工具"——
 * 那是测模型不是测代码，必然 flaky（这个教训在阶段 1 已经吃过一次）。
 *
 * 所以这里注入一个按剧本返回结果的 provider：剧本写"第 1 轮调 search_chunks，
 * 第 2 轮给结论"，代码就必须照此推进。这样每一条预算/护栏逻辑都能精确命中。
 */

// ============================================================
// 测试替身
// ============================================================
interface ScriptStep {
  text?: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  inputTokens?: number;
  outputTokens?: number;
  /** 设为 true 时这一步抛出错误，用于测失败路径 */
  throws?: Error;
}

class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    tools: true,
    jsonMode: true,
    promptCaching: false,
    thinking: true,
  };

  /** 记录收到的请求，便于断言"消息历史是否被正确累积" */
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

function makeResult(step: ScriptStep): LLMResult {
  return {
    text: step.text ?? '',
    provider: 'scripted',
    model: 'scripted-model',
    usage: {
      inputTokens: step.inputTokens ?? 100,
      outputTokens: step.outputTokens ?? 20,
      cachedTokens: 0,
    },
    finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
    ttftMs: 10,
    totalMs: 20,
    ...(step.toolCalls ? { toolCalls: step.toolCalls } : {}),
  };
}

function makeChunks(texts: string[]): TextChunk[] {
  return texts.map((content, index) => ({ index, content, tokens: 10 }));
}

const CTX = {
  glossary: [],
  loadTaskOutput: async () => null,
};

const FINAL_JSON = JSON.stringify({
  conclusions: [
    {
      text: '缓存命中率是最重要的成本指标',
      evidence: [{ source: 'chunk:1', quote: '缓存命中率' }],
      confidence: 'high',
    },
  ],
  limitations: [],
});

// ============================================================
describe('runAgent：正常路径', () => {
  it('模型直接给结论 → succeeded，一步完成', async () => {
    const provider = new ScriptedProvider([{ text: FINAL_JSON }]);
    const result = await runAgent({
      provider,
      model: 'm',
      question: '缓存命中率为什么重要？',
      chunks: makeChunks(['缓存命中率决定了成本', '其它内容']),
      toolContext: CTX,
    });

    expect(result.status).toBe('succeeded');
    expect(result.stopReason).toBe('model_finalized');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.phase).toBe('finalize');
    expect(result.structured?.conclusions).toHaveLength(1);
  });

  it('检索一轮后给结论 → 两步，轨迹记录了工具调用与结果', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: 'c1', name: TOOL_NAMES.searchChunks, arguments: { query: '缓存', topK: 2 } },
        ],
      },
      { text: FINAL_JSON },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: '问题',
      chunks: makeChunks(['缓存命中率决定了成本', '无关内容', '缓存未命中更贵']),
      toolContext: CTX,
    });

    expect(result.status).toBe('succeeded');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.phase).toBe('act');
    expect(result.steps[0]?.toolCalls).toHaveLength(1);
    expect(result.steps[0]?.toolResults[0]?.ok).toBe(true);
    expect(result.steps[0]?.toolResults[0]?.display).toContain('命中');
    expect(result.steps[1]?.phase).toBe('finalize');
  });

  it('消息历史被正确累积（第二轮能看到第一轮的工具结果）', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.searchChunks, arguments: { query: '缓存' } }] },
      { text: FINAL_JSON },
    ]);

    await runAgent({
      provider,
      model: 'm',
      question: '问题',
      chunks: makeChunks(['缓存命中率决定了成本']),
      toolContext: CTX,
    });

    // 第二次请求应该带上 user + assistant(tool_call) + tool
    const second = provider.requests[1];
    expect(second?.messages).toBeDefined();
    const roles = second!.messages!.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool']);
    const toolMsg = second!.messages![2];
    expect(toolMsg.role).toBe('tool');
  });

  it('多轮工具调用（三次不同工具）全部记录', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.listSections, arguments: {} }] },
      { toolCalls: [{ id: 'c2', name: TOOL_NAMES.searchChunks, arguments: { query: 'A' } }] },
      { toolCalls: [{ id: 'c3', name: TOOL_NAMES.getGlossary, arguments: { term: 'x' } }] },
      { text: FINAL_JSON },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A 内容', 'B 内容']),
      toolContext: CTX,
    });

    expect(result.steps).toHaveLength(4);
    const tools = result.steps.flatMap((s) => s.toolCalls.map((c) => c.name));
    expect(tools).toEqual([
      TOOL_NAMES.listSections,
      TOOL_NAMES.searchChunks,
      TOOL_NAMES.getGlossary,
    ]);
  });

  it('同一步内并发多个工具调用都被执行', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: 'c1', name: TOOL_NAMES.searchChunks, arguments: { query: 'A' } },
          { id: 'c2', name: TOOL_NAMES.searchChunks, arguments: { query: 'B' } },
        ],
      },
      { text: FINAL_JSON },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A 内容', 'B 内容']),
      toolContext: CTX,
    });

    expect(result.steps[0]?.toolResults).toHaveLength(2);
    expect(result.steps[0]?.toolResults.every((r) => r.ok)).toBe(true);
  });
});

// ============================================================
describe('runAgent：预算控制（maxSteps）', () => {
  it('步数到顶 → give_up，且**仍然争取到阶段性结论**', async () => {
    // 前两轮不停调工具，第三轮（收敛调用）给结论
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.listSections, arguments: {} }] },
      { toolCalls: [{ id: 'c2', name: TOOL_NAMES.searchChunks, arguments: { query: 'A' } }] },
      // 收敛调用（不带 tools）会拿到这个
      { text: '{"conclusions":[{"text":"部分结论","evidence":[]}],"limitations":["步数用尽"]}' },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A 内容']),
      toolContext: CTX,
      budget: { maxSteps: 2 },
    });

    expect(result.stopReason).toBe('max_steps');
    expect(result.status).toBe('gave_up');
    // 关键：没有变成空结果，而是给出了部分成果
    expect(result.text).toContain('部分结论');
    expect(result.structured?.limitations).toContain('步数用尽');
    // 最后一步是 give_up 阶段
    expect(result.steps.at(-1)?.phase).toBe('give_up');
  });

  it('收敛调用不带 tools（从物理上保证输出文本）', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.listSections, arguments: {} }] },
      { text: '{"conclusions":[]}' },
    ]);

    await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A']),
      toolContext: CTX,
      budget: { maxSteps: 1 },
    });

    const wrapUpReq = provider.requests.at(-1);
    expect(wrapUpReq?.tools).toBeUndefined();
  });

  it('绝不超出 maxSteps 的模型调用次数（含收敛调用也不额外调工具）', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.listSections, arguments: {} }] },
      { toolCalls: [{ id: 'c2', name: TOOL_NAMES.listSections, arguments: {} }] },
      { toolCalls: [{ id: 'c3', name: TOOL_NAMES.listSections, arguments: {} }] },
      { text: '{"conclusions":[]}' },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A']),
      toolContext: CTX,
      budget: { maxSteps: 2 },
    });

    // 计划阶段最多 2 次 + 1 次收敛调用 = 3 次模型请求
    expect(provider.requests.length).toBeLessThanOrEqual(3);
    // act 步数不超过预算
    expect(result.steps.filter((s) => s.phase === 'act').length).toBeLessThanOrEqual(2);
  });
});

describe('runAgent：预算控制（maxTokens）', () => {
  it('token 到顶 → give_up 并收敛', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: 'c1', name: TOOL_NAMES.listSections, arguments: {} }],
        inputTokens: 5000,
        outputTokens: 1000,
      },
      { text: '{"conclusions":[{"text":"部分","evidence":[]}]}' },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A']),
      toolContext: CTX,
      // 第一轮就 6000 token，超过 5000 上限
      budget: { maxTokens: 5000 },
    });

    expect(result.stopReason).toBe('max_tokens');
    expect(result.status).toBe('gave_up');
    expect(result.text).toContain('部分');
  });

  it('使用量被累加（含收敛调用）', async () => {
    const provider = new ScriptedProvider([
      { text: FINAL_JSON, inputTokens: 100, outputTokens: 50 },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A']),
      toolContext: CTX,
    });

    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
  });
});

// ============================================================
describe('runAgent：单工具额度', () => {
  it('达到额度后拒绝执行，并把原因回给模型', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.listSections, arguments: {} }] },
      { toolCalls: [{ id: 'c2', name: TOOL_NAMES.listSections, arguments: {} }] },
      { text: FINAL_JSON },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A']),
      toolContext: CTX,
      // list_sections 只许 1 次
      toolQuotas: { [TOOL_NAMES.listSections]: 1 } as never,
    });

    // 第一次成功，第二次被额度拒绝
    expect(result.steps[0]?.toolResults[0]?.ok).toBe(true);
    const secondResults = result.steps[1]?.toolResults ?? [];
    // 第二次的调用被拒（或走到收敛）
    const rejected = result.steps
      .flatMap((s) => s.toolResults)
      .filter((r) => !r.ok);
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.some((r) => (r.error ?? '').includes('上限') || (r.error ?? '').includes('次数'))).toBe(true);
    void secondResults;
  });

  it('未知工具被拒绝（不给额度，杜绝绕过）', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'delete_everything', arguments: {} }] },
      { text: FINAL_JSON },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A']),
      toolContext: CTX,
    });

    const rejected = result.steps.flatMap((s) => s.toolResults).filter((r) => !r.ok);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.error).toContain('未知工具');
  });

  it('fetch_url 的默认额度是 3（唯一访问外网的工具）', () => {
    expect(TOOL_QUOTAS[TOOL_NAMES.fetchUrl]).toBe(3);
  });
});

// ============================================================
describe('runAgent：死循环检测', () => {
  it('相同工具+参数重复到阈值 → 停止并收敛（这是唯一能证明护栏生效的手段）', async () => {
    // 模型固执地用完全相同的参数反复调同一个工具
    const loopCall = {
      id: 'c',
      name: TOOL_NAMES.searchChunks,
      arguments: { query: '同一个词' },
    };
    const provider = new ScriptedProvider([
      { toolCalls: [{ ...loopCall, id: 'c1' }] },
      { toolCalls: [{ ...loopCall, id: 'c2' }] },
      { toolCalls: [{ ...loopCall, id: 'c3' }] },
      { toolCalls: [{ ...loopCall, id: 'c4' }] },
      { text: FINAL_JSON },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['同一个词 出现了']),
      toolContext: CTX,
      budget: { maxSteps: 8 },
      // 额度放大，确保拦住它的是**重复检测**而不是额度
      toolQuotas: { [TOOL_NAMES.searchChunks]: 99 } as never,
    });

    expect(result.stopReason).toBe('repeat_loop');

    // 第二次重复时被"注入提示"提醒（不拦截）
    const warnings = result.steps
      .flatMap((s) => s.toolResults)
      .filter((r) => (r.error ?? '').includes('已经'));
    expect(warnings.length).toBeGreaterThan(0);

    // 且确实没有无限循环下去
    expect(result.steps.length).toBeLessThan(8);
  });

  it('参数顺序不同但内容相同 → 仍算重复（规范化键排序）', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.searchChunks, arguments: { query: 'x', topK: 3 } }] },
      { toolCalls: [{ id: 'c2', name: TOOL_NAMES.searchChunks, arguments: { topK: 3, query: 'x' } }] },
      { toolCalls: [{ id: 'c3', name: TOOL_NAMES.searchChunks, arguments: { query: 'x', topK: 3 } }] },
      { text: FINAL_JSON },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['x 内容']),
      toolContext: CTX,
      budget: { maxSteps: 8 },
      toolQuotas: { [TOOL_NAMES.searchChunks]: 99 } as never,
    });

    // 键顺序不同不该被当成不同的调用
    expect(result.stopReason).toBe('repeat_loop');
  });

  it('canonicalizeArgs 对键顺序不敏感', () => {
    expect(canonicalizeArgs({ a: 1, b: 2 })).toBe(canonicalizeArgs({ b: 2, a: 1 }));
    expect(canonicalizeArgs({ a: 1 })).not.toBe(canonicalizeArgs({ a: 2 }));
  });

  it('不同参数的正常多次检索**不会**被误判为循环', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.searchChunks, arguments: { query: '缓存' } }] },
      { toolCalls: [{ id: 'c2', name: TOOL_NAMES.searchChunks, arguments: { query: '命中率' } }] },
      { toolCalls: [{ id: 'c3', name: TOOL_NAMES.searchChunks, arguments: { query: '成本' } }] },
      { text: FINAL_JSON },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['缓存 命中率 成本']),
      toolContext: CTX,
      budget: { maxSteps: 8 },
    });

    expect(result.stopReason).toBe('model_finalized');
    expect(result.status).toBe('succeeded');
  });
});

// ============================================================
describe('runAgent：错误处理', () => {
  it('模型调用失败 → failed（不是 give_up）', async () => {
    const provider = new ScriptedProvider([{ throws: new Error('上游 500') }]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A']),
      toolContext: CTX,
    });

    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('error');
    expect(result.error).toBeDefined();
  });

  it('工具内部错误不中断循环（作为观察结果回给模型）', async () => {
    const provider = new ScriptedProvider([
      // fetch_url 一个非法地址，会失败
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.fetchUrl, arguments: { url: 'not-a-url' } }] },
      { text: FINAL_JSON },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A']),
      toolContext: CTX,
    });

    expect(result.status).toBe('succeeded');
    expect(result.steps[0]?.toolResults[0]?.ok).toBe(false);
    // 失败信息被回传给了模型
    const second = provider.requests[1];
    const toolMsg = second?.messages?.find((m) => m.role === 'tool');
    expect(JSON.stringify(toolMsg)).toContain('error');
  });

  it('收敛调用失败时仍返回已有轨迹（不升级为 error）', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.listSections, arguments: {} }] },
      { throws: new Error('收敛也失败了') },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A']),
      toolContext: CTX,
      budget: { maxSteps: 1 },
    });

    // 有轨迹就有价值，不该因为抢救失败而丢掉
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.status).toBe('gave_up');
  });
});

// ============================================================
describe('runAgent：轨迹回调（SSE 用）', () => {
  it('每一步都触发 onStep', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.listSections, arguments: {} }] },
      { text: FINAL_JSON },
    ]);
    const seen: number[] = [];

    await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A']),
      toolContext: CTX,
      onStep: (s) => seen.push(s.seq),
    });

    expect(seen).toEqual([1, 2]);
  });

  it('轨迹的 seq 从 1 连续递增', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.listSections, arguments: {} }] },
      { toolCalls: [{ id: 'c2', name: TOOL_NAMES.searchChunks, arguments: { query: 'a' } }] },
      { text: FINAL_JSON },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['a']),
      toolContext: CTX,
    });

    expect(result.steps.map((s) => s.seq)).toEqual([1, 2, 3]);
  });

  it('累计 token 单调递增', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.listSections, arguments: {} }], inputTokens: 100 },
      { text: FINAL_JSON, inputTokens: 50 },
    ]);

    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A']),
      toolContext: CTX,
    });

    const cumulative = result.steps.map((s) => s.cumulativeTokens);
    for (let i = 1; i < cumulative.length; i++) {
      expect(cumulative[i]!).toBeGreaterThanOrEqual(cumulative[i - 1]!);
    }
  });
});

// ============================================================
describe('parseStructuredOutput：容错解析', () => {
  it('纯 JSON 直接解析', () => {
    const r = parseStructuredOutput('{"conclusions":[{"text":"a","evidence":[]}]}');
    expect(r?.conclusions).toHaveLength(1);
  });

  it('```json 代码块包裹也能解析（模型常见行为）', () => {
    const r = parseStructuredOutput('以下是结论：\n```json\n{"conclusions":[{"text":"a","evidence":[]}]}\n```\n希望有帮助');
    expect(r?.conclusions[0]?.text).toBe('a');
  });

  it('前后有解释文字也能解析出中间的 JSON', () => {
    const r = parseStructuredOutput('我分析后认为：{"conclusions":[{"text":"a","evidence":[{"source":"chunk:1","quote":"q"}]}]} 以上。');
    expect(r?.conclusions[0]?.evidence).toHaveLength(1);
  });

  it('空内容返回 null（ADR-0003 提到 JSON 模式可能返回空 content）', () => {
    expect(parseStructuredOutput('')).toBeNull();
    expect(parseStructuredOutput('   ')).toBeNull();
  });

  it('无法解析时返回 null 而不是抛错', () => {
    expect(parseStructuredOutput('这完全不是 JSON')).toBeNull();
  });

  it('conclusions 是字符串数组时也能用（证据为空）', () => {
    const r = parseStructuredOutput('{"conclusions":["结论一","结论二"]}');
    expect(r?.conclusions).toHaveLength(2);
    expect(r?.conclusions[0]?.evidence).toEqual([]);
  });

  it('缺少 evidence 字段时归一化为空数组（不丢弃整条结论）', () => {
    const r = parseStructuredOutput('{"conclusions":[{"text":"a"}]}');
    expect(r?.conclusions[0]?.evidence).toEqual([]);
  });

  it('证据字段类型不对时被过滤掉而保留结论', () => {
    const r = parseStructuredOutput(
      '{"conclusions":[{"text":"a","evidence":[{"source":"chunk:1","quote":"q"},{"bad":1},"字符串"]}]}',
    );
    expect(r?.conclusions[0]?.evidence).toHaveLength(1);
  });

  it('limitations 缺失时不报错', () => {
    const r = parseStructuredOutput('{"conclusions":[{"text":"a","evidence":[]}]}');
    expect(r?.limitations).toBeUndefined();
  });
});

// ============================================================
describe('extractDisplayText：剥掉机器格式，只留给人看的散文', () => {
  const structured: AgentStructuredOutput = {
    conclusions: [{ text: 'a', evidence: [] }],
  };

  it('剥掉 ```json 代码块，保留前后散文', () => {
    const text = '以下是分析结果：\n```json\n{"conclusions":[{"text":"a","evidence":[]}]}\n```\n希望有帮助';
    const out = extractDisplayText(text, structured);
    expect(out).toContain('以下是分析结果');
    expect(out).toContain('希望有帮助');
    expect(out).not.toContain('conclusions');
  });

  it('剥掉裸 JSON（没有代码块包裹）', () => {
    const out = extractDisplayText('{"conclusions":[{"text":"a","evidence":[]}]}', structured);
    // 剥完什么都不剩时保留原文，避免给用户空白
    expect(out.length).toBeGreaterThan(0);
  });

  it('**没有解析出结构时原样返回**（避免误删正文里的正常 JSON）', () => {
    const text = '这里是一个 JSON 示例：{"a":1}';
    expect(extractDisplayText(text, null)).toBe(text.trim());
  });

  it('剥完为空时保留原文（宁多勿空）', () => {
    const text = '```json\n{"conclusions":[]}\n```';
    const out = extractDisplayText(text, structured);
    expect(out.length).toBeGreaterThan(0);
  });

  it('空输入返回空串', () => {
    expect(extractDisplayText('', structured)).toBe('');
  });

  it('没有 JSON 的纯散文原样保留', () => {
    const text = '这是一段纯说明文字，没有任何 JSON。';
    expect(extractDisplayText(text, structured)).toBe(text);
  });
});

describe('checkEvidence：证据链校验（确定性质量维度）', () => {
  const chunks = makeChunks([
    '缓存命中率是 AI 应用最重要的成本指标。',
    '前缀缓存按最长公共前缀匹配，因此稳定内容应当前置。',
  ]);

  it('精确匹配 → verified 且记为 exact', () => {
    const structured: AgentStructuredOutput = {
      conclusions: [
        {
          text: '结论',
          evidence: [{ source: 'chunk:0', quote: '缓存命中率是 AI 应用最重要的成本指标。' }],
        },
      ],
    };
    const r = checkEvidence(structured, chunks);
    expect(r.total).toBe(1);
    expect(r.verified).toBe(1);
    expect(r.exact).toBe(1);
    expect(r.normalized).toBe(0);
    expect(r.rate).toBe(1);
  });

  it('空白/标点差异 → 归一化后匹配，记为 normalized', () => {
    const structured: AgentStructuredOutput = {
      conclusions: [
        {
          text: '结论',
          // 去掉了空格、把中文标点换成英文
          evidence: [{ source: 'chunk:0', quote: '缓存命中率是AI应用最重要的成本指标.' }],
        },
      ],
    };
    const r = checkEvidence(structured, chunks);
    expect(r.verified).toBe(1);
    expect(r.exact).toBe(0);
    expect(r.normalized).toBe(1);
  });

  it('引用了不存在的分块 → 记为 missing', () => {
    const structured: AgentStructuredOutput = {
      conclusions: [{ text: 'c', evidence: [{ source: 'chunk:99', quote: 'x' }] }],
    };
    const r = checkEvidence(structured, chunks);
    expect(r.verified).toBe(0);
    expect(r.missing[0]?.reason).toContain('不存在');
  });

  it('引用的原文片段不在该分块里 → 记为 missing', () => {
    const structured: AgentStructuredOutput = {
      conclusions: [
        { text: 'c', evidence: [{ source: 'chunk:0', quote: '这句话根本不在文档里' }] },
      ],
    };
    const r = checkEvidence(structured, chunks);
    expect(r.verified).toBe(0);
    expect(r.missing[0]?.reason).toContain('未在该分块中找到');
  });

  it('source 格式无法解析 → 明确报出（而不是静默算通过）', () => {
    const structured: AgentStructuredOutput = {
      conclusions: [{ text: 'c', evidence: [{ source: '某处', quote: 'x' }] }],
    };
    const r = checkEvidence(structured, chunks);
    expect(r.missing[0]?.reason).toContain('无法从 source');
  });

  it('quote 为空 → 记为 missing', () => {
    const structured: AgentStructuredOutput = {
      conclusions: [{ text: 'c', evidence: [{ source: 'chunk:0', quote: '  ' }] }],
    };
    const r = checkEvidence(structured, chunks);
    expect(r.missing[0]?.reason).toContain('quote 为空');
  });

  it('完整率按比例计算', () => {
    const structured: AgentStructuredOutput = {
      conclusions: [
        {
          text: 'c',
          evidence: [
            { source: 'chunk:0', quote: '缓存命中率' },
            { source: 'chunk:1', quote: '不存在的内容' },
          ],
        },
      ],
    };
    const r = checkEvidence(structured, chunks);
    expect(r.total).toBe(2);
    expect(r.verified).toBe(1);
    expect(r.rate).toBe(0.5);
  });

  it('没有证据时 rate 为 0（不假设通过）', () => {
    expect(checkEvidence({ conclusions: [] }, chunks).rate).toBe(0);
    expect(checkEvidence(null, chunks).rate).toBe(0);
  });

  it('parseChunkRef 支持多种写法', () => {
    expect(parseChunkRef('chunk:12')).toBe(12);
    expect(parseChunkRef('Chunk 3')).toBe(3);
    expect(parseChunkRef('chunk：7')).toBe(7);
    expect(parseChunkRef('第 5 段')).toBeNull();
  });

  it('normalizeForMatch 统一引号、破折号与中英标点', () => {
    expect(normalizeForMatch('“引号”')).toBe('"引号"');
    expect(normalizeForMatch('a—b')).toBe(normalizeForMatch('a-b'));
    expect(normalizeForMatch('中文，标点。')).toBe(normalizeForMatch('中文,标点.'));
    expect(normalizeForMatch('有 空 白')).toBe('有空白');
  });
});

// ============================================================
describe('checkTrajectory：轨迹确定性断言', () => {
  const base = {
    text: '',
    displayText: '',
    structured: null,
    stopReason: 'model_finalized' as const,
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 0 },
    finalChunks: [],
  };

  it('检测到死循环', () => {
    const r = checkTrajectory({
      ...base,
      status: 'gave_up',
      steps: Array.from({ length: REPEAT_STOP_THRESHOLD }, (_, i) => ({
        seq: i + 1,
        phase: 'act' as const,
        text: '',
        reasoning: '',
        toolCalls: [{ id: `c${i}`, name: 'search_chunks', arguments: { query: 'x' } }],
        toolResults: [],
        inputTokens: 10,
        outputTokens: 1,
        cumulativeTokens: 10 * (i + 1),
        latencyMs: 5,
      })),
    });
    expect(r.hasLoop).toBe(true);
  });

  it('不同参数不算循环', () => {
    const r = checkTrajectory({
      ...base,
      status: 'succeeded',
      steps: [
        {
          seq: 1,
          phase: 'act',
          text: '',
          reasoning: '',
          toolCalls: [{ id: 'c1', name: 'search_chunks', arguments: { query: 'a' } }],
          toolResults: [],
          inputTokens: 10,
          outputTokens: 1,
          cumulativeTokens: 10,
          latencyMs: 5,
        },
        {
          seq: 2,
          phase: 'act',
          text: '',
          reasoning: '',
          toolCalls: [{ id: 'c2', name: 'search_chunks', arguments: { query: 'b' } }],
          toolResults: [],
          inputTokens: 10,
          outputTokens: 1,
          cumulativeTokens: 20,
          latencyMs: 5,
        },
      ],
    });
    expect(r.hasLoop).toBe(false);
    expect(r.usedTools).toEqual(['search_chunks']);
  });

  it('统计「有结论但无证据」的条数', () => {
    const r = checkTrajectory({
      ...base,
      status: 'succeeded',
      steps: [],
      structured: {
        conclusions: [
          { text: 'a', evidence: [{ source: 'chunk:0', quote: 'q' }] },
          { text: 'b', evidence: [] },
          { text: 'c', evidence: [] },
        ],
      },
    });
    expect(r.unsupportedConclusions).toBe(2);
  });

  it('超预算能被检出', () => {
    const r = checkTrajectory(
      { ...base, status: 'gave_up', steps: [], usage: { inputTokens: 99999, outputTokens: 1, cachedTokens: 0 } },
      { maxTokens: 1000 },
    );
    expect(r.overTokens).toBe(true);
  });
});

// ============================================================
describe('工具：纯函数实现', () => {
  it('runSearchChunks 按命中词数排序', () => {
    const chunks = makeChunks(['只有缓存', '缓存命中率成本', '无关内容']);
    const r = runSearchChunks(chunks, '缓存 命中率', 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 命中两个词的排最前
    expect(r.data.hits[0]?.chunkIndex).toBe(1);
    expect(r.data.hits[0]?.matched).toContain('缓存');
    expect(r.data.hits[0]?.matched).toContain('命中率');
  });

  it('runSearchChunks 空关键词报错（不返回空结果冒充成功）', () => {
    const r = runSearchChunks(makeChunks(['a']), '  ');
    expect(r.ok).toBe(false);
  });

  it('runSearchChunks 摘录以命中位置为中心（不是直接截开头）', () => {
    const long = `${'前'.repeat(500)}关键词${'后'.repeat(500)}`;
    const r = runSearchChunks(makeChunks([long]), '关键词', 1, 100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.hits[0]?.excerpt).toContain('关键词');
  });

  it('runSearchChunks 无命中时返回空 hits 而不是错误', () => {
    const r = runSearchChunks(makeChunks(['abc']), 'zzz');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.hits).toHaveLength(0);
  });

  it('runListSections 识别 Markdown 标题', () => {
    const r = runListSections(makeChunks(['# 第一章\n内容', '## 第二章\n内容', '没有标题']));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.sections[0]?.heading).toBe('第一章');
    expect(r.data.sections[1]?.heading).toBe('第二章');
    expect(r.data.sections[2]?.heading).toBeNull();
  });

  it('runDiffWithText 给出统计与差异样本', () => {
    const r = runDiffWithText('a\nb\nc', 'a\nX\nc', '旧版本');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.added).toBe(1);
    expect(r.data.removed).toBe(1);
    expect(r.data.summary).toContain('旧版本');
    expect(r.data.sample.length).toBeGreaterThan(0);
  });

  it('runDiffWithText 对空目标报错', () => {
    expect(runDiffWithText('a', '', 't').ok).toBe(false);
  });

  it('appendChunks 重编号避免证据引用冲突', () => {
    const existing = makeChunks(['a', 'b']);
    const added = makeChunks(['c', 'd']);
    const merged = appendChunks(existing, added);
    expect(merged.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(merged[2]?.content).toBe('c');
  });
});

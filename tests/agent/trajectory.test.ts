import { describe, it, expect } from 'vitest';
import {
  checkTrajectory,
  runAgent,
  REPEAT_STOP_THRESHOLD,
  type AgentRunResult,
  type AgentStepRecord,
} from '@/lib/agent/loop';
import { ScriptedProvider, makeChunks, CTX, FINAL_JSON } from './helpers';

/**
 * 轨迹记录结构与轨迹断言的表征测试。
 *
 * 轨迹是审计与评测的输入：seq 连续、累计 token 单调、阶段取值受限。
 * checkTrajectory 则是「护栏有没有生效」的确定性断言集合 ——
 * 它不依赖模型质量，只统计已经发生的调用，因此是回归的可靠信号。
 */

function step(overrides: Partial<AgentStepRecord> = {}): AgentStepRecord {
  return {
    seq: 1,
    phase: 'act',
    text: '',
    reasoning: '',
    toolCalls: [],
    toolResults: [],
    inputTokens: 10,
    outputTokens: 1,
    cumulativeTokens: 10,
    latencyMs: 5,
    ...overrides,
  };
}

function resultWith(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    status: 'succeeded',
    text: '',
    displayText: '',
    structured: null,
    steps: [],
    stopReason: 'model_finalized',
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 0 },
    finalChunks: [],
    ...overrides,
  };
}

// ============================================================
// 轨迹记录结构
// ============================================================
describe('轨迹记录结构（runAgent 产出）', () => {
  it('act 步的 toolCalls / toolResults / note / token 字段完整', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: 'c1', name: 'list_sections', arguments: {} }],
        inputTokens: 100,
        outputTokens: 20,
        meta: { reasoning: '先看结构' },
      },
      { text: FINAL_JSON },
    ]);
    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A 内容']),
      toolContext: CTX,
    });

    const act = result.steps[0]!;
    expect(Object.keys(act).sort()).toEqual(
      [
        'cumulativeTokens',
        'inputTokens',
        'latencyMs',
        'note',
        'outputTokens',
        'phase',
        'reasoning',
        'seq',
        'text',
        'toolCalls',
        'toolResults',
      ].sort(),
    );
    expect(act).toMatchObject({
      seq: 1,
      phase: 'act',
      reasoning: '先看结构',
      inputTokens: 100,
      outputTokens: 20,
      cumulativeTokens: 120,
      note: '执行 1 个工具调用',
    });
    expect(act.toolCalls).toEqual([{ id: 'c1', name: 'list_sections', arguments: {} }]);
    expect(act.toolResults[0]).toMatchObject({
      toolCallId: 'c1',
      name: 'list_sections',
      ok: true,
    });
    expect(typeof act.toolResults[0]?.display).toBe('string');
    expect(act.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('seq 从 1 连续递增，阶段取值只在状态机集合内', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'list_sections', arguments: {} }] },
      { text: FINAL_JSON },
    ]);
    const result = await runAgent({
      provider,
      model: 'm',
      question: 'q',
      chunks: makeChunks(['A']),
      toolContext: CTX,
    });

    expect(result.steps.map((s) => s.seq)).toEqual([1, 2]);
    for (const s of result.steps) {
      expect(['plan', 'act', 'observe', 'finalize', 'give_up']).toContain(s.phase);
    }
  });
});

// ============================================================
// checkTrajectory：确定性断言
// ============================================================
describe('checkTrajectory：确定性断言', () => {
  it('REPEAT_STOP_THRESHOLD 次相同调用才判死循环（阈值边界）', () => {
    const calls = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        step({ seq: i + 1, toolCalls: [{ id: `c${i}`, name: 'search_chunks', arguments: { query: 'x' } }] }),
      );

    expect(checkTrajectory(resultWith({ steps: calls(REPEAT_STOP_THRESHOLD - 1) })).hasLoop).toBe(false);
    expect(checkTrajectory(resultWith({ steps: calls(REPEAT_STOP_THRESHOLD) })).hasLoop).toBe(true);
  });

  it('参数键顺序不同仍算循环（复用 canonicalizeArgs）', () => {
    const steps = [
      step({ seq: 1, toolCalls: [{ id: 'c1', name: 'search_chunks', arguments: { query: 'x', topK: 3 } }] }),
      step({ seq: 2, toolCalls: [{ id: 'c2', name: 'search_chunks', arguments: { topK: 3, query: 'x' } }] }),
      step({ seq: 3, toolCalls: [{ id: 'c3', name: 'search_chunks', arguments: { query: 'x', topK: 3 } }] }),
    ];
    expect(checkTrajectory(resultWith({ steps })).hasLoop).toBe(true);
  });

  it('usedTools 去重并排序', () => {
    const steps = [
      step({ seq: 1, toolCalls: [{ id: 'c1', name: 'search_chunks', arguments: {} }] }),
      step({ seq: 2, toolCalls: [{ id: 'c2', name: 'list_sections', arguments: {} }] }),
      step({ seq: 3, toolCalls: [{ id: 'c3', name: 'search_chunks', arguments: { query: 'a' } }] }),
    ];
    expect(checkTrajectory(resultWith({ steps })).usedTools).toEqual([
      'list_sections',
      'search_chunks',
    ]);
  });

  it('overSteps 用严格大于（等于预算不算超）', () => {
    const steps = Array.from({ length: 3 }, (_, i) => step({ seq: i + 1 }));
    expect(checkTrajectory(resultWith({ steps }), { maxSteps: 3 }).overSteps).toBe(false);
    expect(checkTrajectory(resultWith({ steps }), { maxSteps: 2 }).overSteps).toBe(true);
    // 不传预算时使用默认 12
    expect(checkTrajectory(resultWith({ steps })).overSteps).toBe(false);
  });

  it('overTokens 用严格大于（等于预算不算超）', () => {
    const atLimit = resultWith({ usage: { inputTokens: 900, outputTokens: 100, cachedTokens: 0 } });
    expect(checkTrajectory(atLimit, { maxTokens: 1000 }).overTokens).toBe(false);
    expect(checkTrajectory(resultWith({ usage: { inputTokens: 901, outputTokens: 100, cachedTokens: 0 } }), { maxTokens: 1000 }).overTokens).toBe(true);
  });

  it('统计「有结论但完全没有证据」的条数', () => {
    const r = checkTrajectory(
      resultWith({
        structured: {
          conclusions: [
            { text: 'a', evidence: [{ source: 'chunk:0', quote: 'q' }] },
            { text: 'b', evidence: [] },
            { text: 'c', evidence: [] },
          ],
        },
      }),
    );
    expect(r.unsupportedConclusions).toBe(2);
    expect(checkTrajectory(resultWith()).unsupportedConclusions).toBe(0);
  });

  it('totalSteps 等于轨迹长度', () => {
    const steps = [step({ seq: 1 }), step({ seq: 2 })];
    expect(checkTrajectory(resultWith({ steps })).totalSteps).toBe(2);
  });
});

import { describe, it, expect } from 'vitest';
import {
  AgentBudgetTracker,
  CONVERGE_REASON_TEXT,
  DEFAULT_AGENT_BUDGET,
  RepeatCallTracker,
  REPEAT_STOP_THRESHOLD,
  REPEAT_WARN_THRESHOLD,
  documentTokens,
  isConvergeReason,
  repeatStopMessage,
  repeatWarning,
  resolveBudgetLimits,
} from '@/lib/agent/budget';
import { makeChunks } from './helpers';

/**
 * budget 模块的单测（拆分后新增，直接测模块 API）。
 *
 * 预算与重复检测是状态机里最容易差一（off-by-one）的两处：
 *   - token / 步数「到顶」是 >= 还是 >；
 *   - 第 2 次重复警告、第 3 次硬停，而不是第 1 次就停。
 * 在这里用纯函数/类精确覆盖边界，不必伪造整个 provider 跑完整循环。
 */

describe('resolveBudgetLimits：默认值与覆盖', () => {
  it('不传时使用默认预算', () => {
    expect(resolveBudgetLimits()).toEqual({ maxSteps: 12, maxTokens: 60_000 });
  });

  it('可单独覆盖任一维度（另一个保持默认）', () => {
    expect(resolveBudgetLimits({ maxSteps: 3 })).toEqual({ maxSteps: 3, maxTokens: 60_000 });
    expect(resolveBudgetLimits({ maxTokens: 1000 })).toEqual({
      maxSteps: DEFAULT_AGENT_BUDGET.maxSteps,
      maxTokens: 1000,
    });
  });

  it('显式 0 不会被 ?? 吞掉（由调用方决定语义）', () => {
    expect(resolveBudgetLimits({ maxSteps: 0 })).toEqual({ maxSteps: 0, maxTokens: 60_000 });
  });
});

describe('AgentBudgetTracker：双预算边界', () => {
  const usage = (inputTokens: number, outputTokens: number, cachedTokens = 0) => ({
    inputTokens,
    outputTokens,
    cachedTokens,
  });

  it('plan 调用同时累加步数与 token（输入 + 输出，不含 cached 的重复计算）', () => {
    const tracker = new AgentBudgetTracker({ maxSteps: 5, maxTokens: 1000 });
    tracker.recordPlanCall(usage(100, 20, 50));

    expect(tracker.steps).toBe(1);
    expect(tracker.tokens).toBe(120);
  });

  it('收敛调用只累计 token，不占步数预算', () => {
    const tracker = new AgentBudgetTracker({ maxSteps: 2, maxTokens: 1000 });
    tracker.recordPlanCall(usage(100, 20));
    tracker.recordUsage(usage(100, 20));

    expect(tracker.steps).toBe(1);
    expect(tracker.tokens).toBe(240);
  });

  it('步数「到顶」用 >=：等于上限即耗尽（不是必须超过）', () => {
    const tracker = new AgentBudgetTracker({ maxSteps: 2, maxTokens: 1000 });
    expect(tracker.exhaustedReason()).toBeNull();
    tracker.recordPlanCall(usage(1, 1));
    expect(tracker.exhaustedReason()).toBeNull();
    tracker.recordPlanCall(usage(1, 1));
    expect(tracker.exhaustedReason()).toBe('max_steps');
  });

  it('token「到顶」用 >=，且步数优先于 token', () => {
    const tracker = new AgentBudgetTracker({ maxSteps: 1, maxTokens: 100 });
    tracker.recordPlanCall(usage(90, 10));
    expect(tracker.exhaustedReason()).toBe('max_steps');

    const tokenOnly = new AgentBudgetTracker({ maxSteps: 10, maxTokens: 100 });
    tokenOnly.recordPlanCall(usage(90, 10));
    expect(tokenOnly.exhaustedReason()).toBe('max_tokens');
  });
});

describe('RepeatCallTracker：两级阈值', () => {
  it('阈值常量是 2 / 3', () => {
    expect(REPEAT_WARN_THRESHOLD).toBe(2);
    expect(REPEAT_STOP_THRESHOLD).toBe(3);
  });

  it('按 key 独立计数：allow → warn → stop', () => {
    const tracker = new RepeatCallTracker();
    expect(tracker.record('search_chunks|query=x')).toEqual({ count: 1, verdict: 'allow' });
    expect(tracker.record('search_chunks|query=x')).toEqual({ count: 2, verdict: 'warn' });
    expect(tracker.record('search_chunks|query=x')).toEqual({ count: 3, verdict: 'stop' });
    expect(tracker.record('search_chunks|query=x')).toEqual({ count: 4, verdict: 'stop' });
  });

  it('不同 key 互不影响', () => {
    const tracker = new RepeatCallTracker();
    tracker.record('search_chunks|query=x');
    tracker.record('search_chunks|query=x');
    expect(tracker.record('search_chunks|query=y').verdict).toBe('allow');
  });

  it('提示文案包含工具名与「为什么」', () => {
    expect(repeatWarning('fetch_url')).toContain('fetch_url');
    expect(repeatWarning('fetch_url')).toContain('换关键词');
    expect(repeatStopMessage('fetch_url', 3)).toContain('调用过 fetch_url 2 次');
    expect(repeatStopMessage('fetch_url', 3)).toContain('基于已有证据给出结论');
  });
});

describe('收敛原因策略', () => {
  it('四种原因被视为需要收敛，error/model_finalized 不需要', () => {
    for (const reason of ['max_steps', 'max_tokens', 'repeat_loop', 'tool_quota'] as const) {
      expect(isConvergeReason(reason)).toBe(true);
    }
    expect(isConvergeReason('error')).toBe(false);
    expect(isConvergeReason('model_finalized')).toBe(false);
  });

  it('每种收敛原因都有定制提示文案', () => {
    expect(Object.keys(CONVERGE_REASON_TEXT).sort()).toEqual([
      'max_steps',
      'max_tokens',
      'repeat_loop',
      'tool_quota',
    ]);
    for (const text of Object.values(CONVERGE_REASON_TEXT)) {
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe('documentTokens：优先使用分块自带 token 数', () => {
  it('有 tokens 时直接相加', () => {
    expect(documentTokens(makeChunks(['a', 'b']))).toBe(20);
  });

  it('缺失 tokens 时按内容估算', () => {
    const chunks = [
      { index: 0, content: 'abcd', tokens: 0 },
      { index: 1, content: 'ab', tokens: 0 },
    ];
    // ceil(4 / 3.2) + ceil(2 / 3.2) = 2 + 1
    expect(documentTokens(chunks)).toBe(3);
  });

  it('空文档为 0', () => {
    expect(documentTokens([])).toBe(0);
  });
});

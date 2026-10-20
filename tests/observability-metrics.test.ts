import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STUCK_TIMEOUT_MS,
  makeMetricsWindow,
  percentile,
  ratio,
  summarizeEvidence,
  summarizeLatency,
  summarizeOutcomes,
  summarizeToolSteps,
} from '@/lib/observability/metrics';

/**
 * 指标纯函数单测。
 *
 * 这些函数算错时**没有任何报错**，只会让评测报告里的数字看起来「差不多」。
 * 所以每一个边界都要锁：空数组、单样本、P95 的取法、护栏拒绝与真实失败的区分、
 * running 超阈值与显式超时的区分。
 */

describe('percentile', () => {
  it('空数组返回 0，单样本返回该值', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([42], 0.95)).toBe(42);
  });

  it('线性插值：偶数样本的 p50 取中间两数均值', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5);
  });

  it('p95 不会退化成最大值（4 个样本时）', () => {
    const p95 = percentile([10, 20, 30, 40], 0.95);
    expect(p95).toBeCloseTo(38.5, 1);
    expect(p95).toBeLessThan(40);
  });

  it('p0 / p1 分别是 min / max', () => {
    expect(percentile([5, 1, 9], 0)).toBe(1);
    expect(percentile([5, 1, 9], 1)).toBe(9);
  });

  it('过滤非有限值，且非法 q 抛 RangeError（不静默夹紧）', () => {
    expect(percentile([1, Number.NaN, 3], 0.5)).toBe(2);
    expect(() => percentile([1], 1.5)).toThrow(RangeError);
    expect(() => percentile([1], -0.1)).toThrow(RangeError);
  });
});

describe('ratio', () => {
  it('分母为 0 / 非法值返回 0，而不是 NaN', () => {
    expect(ratio(1, 0)).toBe(0);
    expect(ratio(Number.NaN, 10)).toBe(0);
    expect(ratio(3, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('正常比率保留 4 位小数', () => {
    expect(ratio(1, 3)).toBe(0.3333);
    expect(ratio(2, 4)).toBe(0.5);
  });
});

describe('summarizeLatency', () => {
  it('汇总 count/p50/p95/avg/min/max', () => {
    const summary = summarizeLatency([100, 200, 300, 400, 1000]);
    expect(summary.count).toBe(5);
    expect(summary.p50).toBe(300);
    expect(summary.p95).toBe(880);
    expect(summary.avg).toBe(400);
    expect(summary.min).toBe(100);
    expect(summary.max).toBe(1000);
  });

  it('忽略负数与 NaN；空输入返回全 0', () => {
    expect(summarizeLatency([-5, Number.NaN, 10]).count).toBe(1);
    expect(summarizeLatency([])).toEqual({ count: 0, p50: 0, p95: 0, avg: 0, min: 0, max: 0 });
  });
});

describe('summarizeToolSteps', () => {
  const steps = [
    {
      toolResults: [
        { name: 'search_chunks', ok: true },
        { name: 'search_chunks', ok: false, error: '检索关键词不能为空' },
        { name: 'fetch_url', ok: false, error: 'fetch_url 已达次数上限（3 次），请基于已有信息作答' },
      ],
    },
    // 兼容 JSON 字符串（不同 Prisma 序列化路径）
    {
      toolResults: JSON.stringify([
        { name: 'list_sections', ok: true },
        { name: 'unknown_tool', ok: false, error: '未知工具 unknown_tool' },
      ]),
    },
    { toolResults: null },
  ];

  it('区分真实失败与护栏拒绝', () => {
    const stats = summarizeToolSteps(steps);
    expect(stats.totalCalls).toBe(5);
    // 额度用尽 + 未知工具 → 护栏拒绝，不是工具坏了
    expect(stats.guardrailRejected).toBe(2);
    expect(stats.executionFailures).toBe(1);
    expect(stats.executedCalls).toBe(3);
    expect(stats.executionFailureRate).toBe(0.3333);
    expect(stats.stepsWithToolResults).toBe(2);
  });

  it('按工具名拆分且只统计真实失败', () => {
    const stats = summarizeToolSteps(steps);
    expect(stats.byTool.search_chunks).toEqual({ calls: 2, failures: 1 });
    expect(stats.byTool.fetch_url).toEqual({ calls: 1, failures: 0 });
    expect(stats.byTool.unknown_tool).toEqual({ calls: 1, failures: 0 });
  });

  it('无 toolResults / 坏 JSON 时安全返回 0', () => {
    expect(summarizeToolSteps([{}, { toolResults: '{bad json' }])).toEqual({
      totalCalls: 0,
      guardrailRejected: 0,
      executionFailures: 0,
      executedCalls: 0,
      executionFailureRate: 0,
      byTool: {},
      stepsWithToolResults: 0,
    });
  });
});

describe('summarizeEvidence', () => {
  it('统计结构化结论的证据覆盖率与无依据结论数', () => {
    const stats = summarizeEvidence([
      {
        taskType: 'agent',
        structured: {
          conclusions: [
            { text: 'a', evidence: [{ source: 'chunk:0', quote: 'q' }] },
            { text: 'b', evidence: [{ source: 'chunk:1', quote: 'q' }] },
            { text: 'c', evidence: [] },
          ],
          limitations: [],
        },
      },
      { taskType: 'agent', structured: null },
      { taskType: 'agent' },
    ]);

    expect(stats.tasksWithStructured).toBe(1);
    expect(stats.tasksWithoutStructured).toBe(2);
    expect(stats.conclusions).toBe(3);
    expect(stats.conclusionsWithEvidence).toBe(2);
    expect(stats.unsupportedConclusions).toBe(1);
    expect(stats.evidenceItems).toBe(2);
    expect(stats.evidenceCoverageRate).toBe(0.6667);
  });

  it('空输入返回 0 覆盖率', () => {
    expect(summarizeEvidence([]).evidenceCoverageRate).toBe(0);
    expect(summarizeEvidence([null, undefined]).tasksWithoutStructured).toBe(2);
  });
});

describe('summarizeOutcomes', () => {
  const now = new Date('2026-10-20T12:00:00Z');

  it('失败率 = failed / total', () => {
    const stats = summarizeOutcomes(
      [
        { status: 'succeeded' },
        { status: 'succeeded' },
        { status: 'failed', errorCode: 'UPSTREAM_ERROR' },
        { status: 'canceled' },
      ],
      { now, timeoutMs: DEFAULT_STUCK_TIMEOUT_MS },
    );
    expect(stats.total).toBe(4);
    expect(stats.failed).toBe(1);
    expect(stats.failureRate).toBe(0.25);
    expect(stats.statusBreakdown).toEqual({ succeeded: 2, failed: 1, canceled: 1 });
    expect(stats.errorCodeBreakdown).toEqual({ UPSTREAM_ERROR: 1 });
  });

  it('超时率同时计入「显式 TIMEOUT」与「running 超阈值」', () => {
    const stats = summarizeOutcomes(
      [
        { status: 'succeeded' },
        { status: 'failed', errorCode: 'TIMEOUT' },
        // 卡了 20 分钟仍在 running → 疑似卡死
        { status: 'running', createdAt: new Date(now.getTime() - 20 * 60_000) },
        // 刚跑 1 分钟仍在 running → 不算
        { status: 'running', createdAt: new Date(now.getTime() - 60_000) },
      ],
      { now, timeoutMs: DEFAULT_STUCK_TIMEOUT_MS },
    );
    expect(stats.explicitTimeouts).toBe(1);
    expect(stats.stuckOverThreshold).toBe(1);
    expect(stats.inFlight).toBe(2);
    expect(stats.timeoutRate).toBe(0.5);
  });

  it('空任务集不会除以 0', () => {
    const stats = summarizeOutcomes([], { now });
    expect(stats.total).toBe(0);
    expect(stats.failureRate).toBe(0);
    expect(stats.timeoutRate).toBe(0);
  });
});

describe('makeMetricsWindow', () => {
  it('窗口有明确的起止与可读标签（UTC）', () => {
    const window = makeMetricsWindow(30, new Date('2026-10-20T12:00:00Z'));
    expect(window.from.toISOString()).toBe('2026-09-20T12:00:00.000Z');
    expect(window.label).toContain('最近 30 天');
    expect(window.label).toContain('2026-09-20 12:00:00Z');
  });

  it('非法天数回退到 30 天', () => {
    const window = makeMetricsWindow(Number.NaN, new Date('2026-10-20T12:00:00Z'));
    expect(window.from.toISOString()).toBe('2026-09-20T12:00:00.000Z');
  });
});

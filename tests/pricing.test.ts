import { describe, it, expect } from 'vitest';
import { computeCostUsd, cacheHitRate, isPeakHour, PRICING } from '@/lib/llm/pricing';

/**
 * 计价测试。
 *
 * 这里的每一条断言都对应一个真实会算错的地方：
 * 缓存分档漏算、峰谷倍数作用范围搞错、缓存 token 超过 prompt 总数。
 * 成本算错不会报错，只会让账单悄悄离谱，所以必须测。
 */
describe('computeCostUsd', () => {
  // 用 UTC 03:00（北京时间 11:00）—— 工作日白天，确定属于高峰时段
  const peakAt = new Date('2026-03-04T03:00:00Z');
  // UTC 20:00（北京时间次日 04:00）—— 低谷
  const offPeakAt = new Date('2026-03-04T20:00:00Z');

  it('全部 cache hit 远便宜于全部 miss（这是 flash 的核心卖点）', () => {
    const hit = computeCostUsd({
      model: 'deepseek-flash',
      promptTokens: 100_000,
      cachedTokens: 100_000,
      completionTokens: 0,
      at: offPeakAt,
    });
    const miss = computeCostUsd({
      model: 'deepseek-flash',
      promptTokens: 100_000,
      cachedTokens: 0,
      completionTokens: 0,
      at: offPeakAt,
    });

    expect(hit.costUsd).toBeGreaterThan(0);
    // 官方定价：0.003 vs 0.15，差 50 倍
    expect(miss.costUsd / hit.costUsd).toBeCloseTo(50, 0);
  });

  it('输入被拆成 cache hit 与 miss 两段分别计价', () => {
    const cost = computeCostUsd({
      model: 'deepseek-flash',
      promptTokens: 1000,
      cachedTokens: 400,
      completionTokens: 0,
      at: offPeakAt,
    });
    const expected =
      (400 / 1e6) * PRICING['deepseek-flash']!.inputCacheHit +
      (600 / 1e6) * PRICING['deepseek-flash']!.inputCacheMiss;
    expect(cost.costUsd).toBeCloseTo(expected, 12);
  });

  it('高峰时段成本翻倍', () => {
    const args = { model: 'deepseek-flash', promptTokens: 10_000, completionTokens: 1000 };
    const off = computeCostUsd({ ...args, at: offPeakAt });
    const peak = computeCostUsd({ ...args, at: peakAt });

    expect(peak.peak).toBe(true);
    expect(off.peak).toBe(false);
    expect(peak.costUsd / off.costUsd).toBeCloseTo(2, 5);
  });

  it('cachedTokens 超过 promptTokens 时按 promptTokens 夹紧，不出现负成本', () => {
    // 上游偶发会报出比 promptTokens 更大的 cachedTokens
    const cost = computeCostUsd({
      model: 'deepseek-flash',
      promptTokens: 1000,
      cachedTokens: 5000,
      completionTokens: 0,
      at: offPeakAt,
    });
    expect(cost.costUsd).toBeCloseTo((1000 / 1e6) * PRICING['deepseek-flash']!.inputCacheHit, 12);
    expect(cost.costUsd).toBeGreaterThan(0);
  });

  it('输出 token 单价高于输入（约为 4 倍），这决定了 maxTokens 的预算策略', () => {
    const tier = PRICING['deepseek-flash']!;
    expect(tier.output).toBeGreaterThan(tier.inputCacheMiss);
  });

  /**
   * 未知模型不能按 0 计。
   * 按 0 计会让成本仪表盘显示「几乎免费」，是最危险的失败模式 ——
   * 它不会引起任何注意，直到账单出来才发现。
   */
  it('未知模型返回保守估计而非 0', () => {
    const cost = computeCostUsd({
      model: 'some-unknown-model',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      at: offPeakAt,
    });
    expect(cost.costUsd).toBeGreaterThan(0);
  });

  it('零 token 输入成本为 0，不产生 NaN', () => {
    const cost = computeCostUsd({ model: 'deepseek-flash', promptTokens: 0, completionTokens: 0 });
    expect(cost.costUsd).toBe(0);
    expect(Number.isNaN(cost.costUsd)).toBe(false);
  });
});

describe('cacheHitRate', () => {
  it('正常计算命中率', () => {
    expect(cacheHitRate(1000, 250)).toBe(0.25);
  });

  it('promptTokens 为 0 时返回 0 而非 NaN', () => {
    expect(cacheHitRate(0, 100)).toBe(0);
  });
});

describe('isPeakHour', () => {
  it('北京时间工作日上午属于高峰', () => {
    expect(isPeakHour(new Date('2026-03-04T03:00:00Z'))).toBe(true);
  });

  it('北京时间凌晨属于低谷', () => {
    expect(isPeakHour(new Date('2026-03-04T20:00:00Z'))).toBe(false);
  });

  it('周末不计入高峰（周末没人提交任务）', () => {
    // 2026-03-07 是周六
    expect(isPeakHour(new Date('2026-03-07T03:00:00Z'))).toBe(false);
  });
});
import { describe, it, expect } from 'vitest';
import { parseBatchInput } from '@/lib/batch/parse';
import { decideBudget, estimateItemCostCny } from '@/lib/batch/guard';

/**
 * 批次输入解析 + 预算闸门。
 *
 * 这两块的错误代价都很高：解析错 → 用户交的 20 份材料少跑了几份却不知道；
 * 预算错 → 用户的钱被多花。所以都做成纯函数并在这里钉死行为。
 */
describe('parseBatchInput', () => {
  it('单份材料：默认标题为「第 1 份」', () => {
    const r = parseBatchInput('这是一份需要摘要的正文，长度足够。');
    expect(r.problems).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.title).toBe('第 1 份');
    expect(r.items[0]!.inputType).toBe('text');
  });

  it('用 --- 分隔多份', () => {
    const r = parseBatchInput('第一篇正文内容。\n---\n第二篇正文内容。\n-----\n第三篇。');
    expect(r.problems).toEqual([]);
    expect(r.items).toHaveLength(3);
  });

  it('首行 # 标题 作为展示名，且不进入正文', () => {
    const r = parseBatchInput('# 2024 年报\n正文从这里开始。');
    expect(r.items[0]!.title).toBe('2024 年报');
    expect(r.items[0]!.content).toBe('正文从这里开始。');
  });

  it('整块是链接时识别为 url，标题取 host', () => {
    const r = parseBatchInput('https://example.com/report/2024');
    expect(r.items[0]!.inputType).toBe('url');
    expect(r.items[0]!.title).toBe('example.com');
  });

  it('链接与文本可以混在一批里', () => {
    const r = parseBatchInput('本地摘录的正文。\n---\nhttps://example.com/a');
    expect(r.items.map((i) => i.inputType)).toEqual(['text', 'url']);
  });

  it('空输入给出可操作的提示', () => {
    const r = parseBatchInput('   \n\n  ');
    expect(r.items).toHaveLength(0);
    expect(r.problems[0]).toContain('---');
  });

  it('只有分隔符不会产生空条目', () => {
    const r = parseBatchInput('---\n---\n正文。\n---');
    expect(r.items).toHaveLength(1);
  });

  it('超过上限时报告问题而不是静默丢弃', () => {
    const raw = Array.from({ length: 5 }, (_, i) => `第 ${i} 份正文。`).join('\n---\n');
    const r = parseBatchInput(raw, { maxItems: 3 });
    expect(r.items).toHaveLength(3);
    expect(r.problems.join()).toContain('最多 3 份');
  });

  it('单份超长要报具体是第几份', () => {
    const r = parseBatchInput('短的一篇。\n---\n' + 'x'.repeat(200), { maxCharsPerItem: 100 });
    expect(r.problems.join()).toContain('第 2 份');
    expect(r.items).toHaveLength(1);
  });

  it('合计超长要报出来（单份都没超也一样）', () => {
    const raw = ['a'.repeat(80), 'b'.repeat(80)].join('\n---\n');
    const r = parseBatchInput(raw, { maxCharsPerItem: 100, maxTotalChars: 100 });
    expect(r.problems.join()).toContain('合计');
  });
});

describe('decideBudget', () => {
  it('未设预算 = 不限制（不偷偷塞默认上限）', () => {
    expect(decideBudget({ spentCny: 999, budgetCny: null, nextEstimateCny: 5 }).action).toBe(
      'continue',
    );
    expect(decideBudget({ spentCny: 999, budgetCny: 0, nextEstimateCny: 5 }).action).toBe(
      'continue',
    );
  });

  it('已花达标即停', () => {
    const d = decideBudget({ spentCny: 2, budgetCny: 2, nextEstimateCny: 0.1 });
    expect(d.action).toBe('stop');
    expect(d.reason).toContain('预算已用尽');
  });

  it('下一条会超预算就停，而不是先跑了再说', () => {
    const d = decideBudget({ spentCny: 1.8, budgetCny: 2, nextEstimateCny: 0.5 });
    expect(d.action).toBe('stop');
    expect(d.reason).toContain('超出剩余预算');
  });

  it('刚好装得下就继续（边界不能误杀）', () => {
    expect(decideBudget({ spentCny: 1.5, budgetCny: 2, nextEstimateCny: 0.5 }).action).toBe(
      'continue',
    );
  });
});

describe('estimateItemCostCny', () => {
  it('按单价换算，且对负数输入不产生负成本', () => {
    const cny = estimateItemCostCny({
      promptTokens: -100,
      expectedOutputTokens: -5,
      costUsd: ({ promptTokens, completionTokens }) => (promptTokens + completionTokens) / 1_000_000,
      usdToCny: (usd) => usd * 7,
    });
    expect(cny).toBe(0);
  });

  it('正常换算：1M 输入 + 0 输出、单价 1 美元/M、汇率 7 → ¥7', () => {
    const cny = estimateItemCostCny({
      promptTokens: 1_000_000,
      expectedOutputTokens: 0,
      costUsd: ({ promptTokens, completionTokens }) => (promptTokens + completionTokens) / 1_000_000,
      usdToCny: (usd) => usd * 7,
    });
    expect(cny).toBeCloseTo(7, 5);
  });
});

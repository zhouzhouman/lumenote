import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 批次执行器的控制流：预算闸门、取消、结算。
 *
 * 这三条是批次功能的核心价值（「花到上限就停」「取消不白跑」「没跑的不能算失败」），
 * 而它们全靠 DB 状态驱动 —— 用 mock 把状态序列摆出来，比跑真库快且确定。
 */
const batchFindUnique = vi.fn();
const batchUpdate = vi.fn();
const taskFindFirst = vi.fn();
const taskUpdateMany = vi.fn();
const taskGroupBy = vi.fn();
const usageFindUnique = vi.fn();
const runPipeline = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    batch: {
      findUnique: (...a: unknown[]) => batchFindUnique(...a),
      update: (...a: unknown[]) => batchUpdate(...a),
    },
    task: {
      findFirst: (...a: unknown[]) => taskFindFirst(...a),
      updateMany: (...a: unknown[]) => taskUpdateMany(...a),
      groupBy: (...a: unknown[]) => taskGroupBy(...a),
    },
    usageLog: { findUnique: (...a: unknown[]) => usageFindUnique(...a) },
  },
}));
vi.mock('@/lib/pipeline/runner', () => ({
  runSummarizePipeline: (...a: unknown[]) => runPipeline(...a),
}));

const { runBatch } = await import('@/lib/batch/runner');

/** 组装一次「批次快照」，按调用次序返回不同内容 */
function batchState(seq: Array<Record<string, unknown>>) {
  let i = 0;
  batchFindUnique.mockImplementation(async () => seq[Math.min(i++, seq.length - 1)]);
}

beforeEach(() => {
  batchFindUnique.mockReset();
  batchUpdate.mockReset().mockResolvedValue({});
  taskFindFirst.mockReset();
  taskUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  taskGroupBy.mockReset();
  usageFindUnique.mockReset().mockResolvedValue({ estimatedCost: 0.001 });
  runPipeline.mockReset().mockResolvedValue({});
});

describe('runBatch：状态与幂等', () => {
  it('已结束的批次不会重跑（after 重试可能调用两次）', async () => {
    batchFindUnique.mockResolvedValue({ id: 'b1', status: 'succeeded', budgetCny: null, costUsd: 0, params: {} });
    expect(await runBatch('b1')).toBeNull();
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('批次不存在时直接返回 null', async () => {
    batchFindUnique.mockResolvedValue(null);
    expect(await runBatch('nope')).toBeNull();
  });
});

describe('runBatch：预算闸门', () => {
  it('已花超预算 → 剩余条目标为「未执行」，不再发请求', async () => {
    batchState([
      { id: 'b1', status: 'queued', budgetCny: 1, costUsd: 5, params: {} }, // 初始
      { cancelRequested: false, costUsd: 5, budgetCny: 1 }, // 循环内：已超
    ]);
    taskFindFirst.mockResolvedValue({ id: 't1', inputMeta: { tokenCount: 10 }, inputContent: 'x' });
    taskGroupBy.mockResolvedValue([{ status: 'canceled', _count: { _all: 2 } }]);

    const summary = await runBatch('b1');

    expect(runPipeline).not.toHaveBeenCalled();
    expect(taskUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorCode: 'SKIPPED_BUDGET' }) }),
    );
    expect(summary?.skipped).toBe(2);
  });

  it('预算足够时正常执行，并按 UsageLog 累计真实成本', async () => {
    batchState([
      { id: 'b1', status: 'queued', budgetCny: 10, costUsd: 0, params: { model: 'deepseek-flash' } },
      { cancelRequested: false, costUsd: 0, budgetCny: 10 },
      { cancelRequested: false, costUsd: 0, budgetCny: 10 },
      { costUsd: 0.001 },
    ]);
    taskFindFirst
      .mockResolvedValueOnce({ id: 't1', inputMeta: { tokenCount: 100 }, inputContent: 'x' })
      .mockResolvedValue(null);
    taskGroupBy.mockResolvedValue([{ status: 'succeeded', _count: { _all: 1 } }]);

    const summary = await runBatch('b1');

    expect(runPipeline).toHaveBeenCalledWith({ taskId: 't1' });
    // 成本用真实值累加，而不是预估值
    expect(batchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { costUsd: { increment: 0.001 } } }),
    );
    expect(summary?.status).toBe('succeeded');
  });
});

describe('runBatch：取消与结算', () => {
  it('用户取消 → 剩余标为 CANCELED，状态 forced 为 canceled', async () => {
    batchState([
      { id: 'b1', status: 'queued', budgetCny: null, costUsd: 0, params: {} },
      { cancelRequested: true, costUsd: 0, budgetCny: null },
    ]);
    taskFindFirst.mockResolvedValue({ id: 't1', inputMeta: {}, inputContent: 'x' });
    taskGroupBy.mockResolvedValue([{ status: 'canceled', _count: { _all: 1 } }]);

    const summary = await runBatch('b1');

    expect(runPipeline).not.toHaveBeenCalled();
    expect(taskUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorCode: 'CANCELED' }) }),
    );
    expect(summary?.status).toBe('canceled');
  });

  it('有成功也有跳过 → partial（不是 failed，也不是 succeeded）', async () => {
    batchState([
      { id: 'b1', status: 'queued', budgetCny: 1, costUsd: 9, params: {} },
      { cancelRequested: false, costUsd: 9, budgetCny: 1 },
    ]);
    taskFindFirst.mockResolvedValue({ id: 't1', inputMeta: {}, inputContent: 'x' });
    taskGroupBy.mockResolvedValue([
      { status: 'succeeded', _count: { _all: 1 } },
      { status: 'canceled', _count: { _all: 1 } },
    ]);

    const summary = await runBatch('b1');
    expect(summary?.status).toBe('partial');
    expect(summary?.succeeded).toBe(1);
    expect(summary?.skipped).toBe(1);
  });

  it('全部失败 → failed；全部跳过 → canceled（不能混为一谈）', async () => {
    batchState([
      { id: 'b1', status: 'queued', budgetCny: null, costUsd: 0, params: {} },
      { cancelRequested: false, costUsd: 0, budgetCny: null },
    ]);
    taskFindFirst.mockResolvedValue(null);

    taskGroupBy.mockResolvedValueOnce([{ status: 'failed', _count: { _all: 2 } }]);
    expect((await runBatch('b1'))?.status).toBe('failed');

    batchFindUnique.mockReset();
    batchState([
      { id: 'b2', status: 'queued', budgetCny: null, costUsd: 0, params: {} },
      { cancelRequested: false, costUsd: 0, budgetCny: null },
    ]);
    taskGroupBy.mockResolvedValueOnce([{ status: 'canceled', _count: { _all: 2 } }]);
    expect((await runBatch('b2'))?.status).toBe('canceled');
  });

  it('单条执行抛异常不会中断整批（错误由管线自己落库）', async () => {
    batchState([
      { id: 'b1', status: 'queued', budgetCny: null, costUsd: 0, params: {} },
      { cancelRequested: false, costUsd: 0, budgetCny: null },
      { cancelRequested: false, costUsd: 0, budgetCny: null },
      { costUsd: 0 },
    ]);
    taskFindFirst
      .mockResolvedValueOnce({ id: 't1', inputMeta: {}, inputContent: 'x' })
      .mockResolvedValue(null);
    runPipeline.mockRejectedValueOnce(new Error('model down'));
    taskGroupBy.mockResolvedValue([{ status: 'failed', _count: { _all: 1 } }]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const summary = await runBatch('b1');

    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(summary?.status).toBe('failed');
    spy.mockRestore();
  });
});

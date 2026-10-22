import { prisma } from '@/lib/db';
import { runSummarizePipeline } from '@/lib/pipeline/runner';
import { computeCostUsd, usdToCny } from '@/lib/llm/pricing';
import { estimateTokens } from '@/lib/llm/mock';
import { decideBudget, estimateItemCostCny } from './guard';

/**
 * 批次执行器。
 *
 * ## 为什么串行，而不是并发跑 N 条
 *
 * 1. **预算是「花到上限就停」**。并发跑的话，10 条同时发出去时预算还剩多少
 *    根本来不及判断 —— 闸门在起跑瞬间就失效了，只能事后发现超支。
 * 2. 项目本来就有「同一用户同时最多 1 个进行中任务」的约束（保护用户自己
 *    的 key 不被多标签页烧掉）。批次的串行是这条约束的自然延伸。
 * 3. 内部文档流水线的真实场景是「下班前交 20 份，明早看结果」，
 *    吞吐不是瓶颈，**可预测的花费**才是。
 *
 * 代价是大批次的墙钟时间长。如果以后要提速，正确做法是「分片 + 每片独立预算」，
 * 而不是简单加并发。
 *
 * ## 三种「没跑」必须区分开
 *
 *  - `failed`：跑了，模型/网络失败
 *  - `skipped`（任务记为 canceled + errorCode）：没跑，因为预算/取消
 *  - `queued`：还没轮到
 *
 * 把 skipped 算进 failed 会让「失败率」失真，用户会去排查根本不存在的模型问题。
 */

const SKIP_BUDGET = 'SKIPPED_BUDGET';
const SKIP_CANCELED = 'CANCELED';
/** 单条默认输出 token 预估（未指定要点数时的保守值） */
const DEFAULT_EXPECTED_OUTPUT_TOKENS = 800;

export interface BatchRunSummary {
  status: 'succeeded' | 'partial' | 'failed' | 'canceled';
  succeeded: number;
  failed: number;
  skipped: number;
  costCny: number;
}

export async function runBatch(batchId: string): Promise<BatchRunSummary | null> {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: { id: true, status: true, budgetCny: true, costUsd: true, params: true },
  });

  // 已被处理过（重复调用 / 已被取消）就不重跑：runner 可能因为 after() 重试被调用两次
  if (!batch || !['queued', 'running'].includes(batch.status)) {
    return null;
  }

  await prisma.batch.update({ where: { id: batchId }, data: { status: 'running' } });

  const model = readModel(batch.params);
  const expectedOutputTokens = readExpectedOutputTokens(batch.params);

  for (;;) {
    const [fresh, next] = await Promise.all([
      prisma.batch.findUnique({
        where: { id: batchId },
        select: { cancelRequested: true, costUsd: true, budgetCny: true },
      }),
      prisma.task.findFirst({
        where: { batchId, status: 'queued' },
        orderBy: { batchOrder: 'asc' },
        select: { id: true, inputMeta: true, inputContent: true },
      }),
    ]);

    if (!fresh) return null;

    // 用户取消：把剩下的标为跳过，不再发请求
    if (fresh.cancelRequested) {
      await skipRemaining(batchId, SKIP_CANCELED, '批次已被用户取消，本条未执行');
      return await finalize(batchId, 'canceled');
    }

    if (!next) break;

    // 预算闸门：**发请求之前**判断，超了就不发
    const promptTokens = readPromptTokens(next.inputMeta, next.inputContent);
    const estimateCny = estimateItemCostCny({
      promptTokens,
      expectedOutputTokens,
      costUsd: ({ promptTokens: p, completionTokens: c }) =>
        computeCostUsd({ model, promptTokens: p, completionTokens: c }).costUsd,
      usdToCny,
    });

    const decision = decideBudget({
      spentCny: usdToCny(fresh.costUsd),
      budgetCny: fresh.budgetCny,
      nextEstimateCny: estimateCny,
    });

    if (decision.action === 'stop') {
      await skipRemaining(batchId, SKIP_BUDGET, decision.reason ?? '超出预算，未执行');
      // 交给 finalize 自然推导：有成功 + 有跳过 = partial。
      // 不能硬塞 'partial'，否则「一条都没跑成」也会被报成部分成功
      return await finalize(batchId, null);
    }

    try {
      // 复用单篇任务管线：生命周期、落库、计量、降级都在里面，批次不重复实现
      await runSummarizePipeline({ taskId: next.id });
    } catch (e) {
      /*
       * 管线内部已经把失败状态与计量落库了，这里不再改任务状态 ——
       * 只记录日志，避免「外层把内层写好的 errorCode 覆盖掉」。
       */
      console.error(`[batch:${batchId}] 条目 ${next.id} 执行异常：`, e);
    }

    // 累计这一条的真实成本（以 UsageLog 为准，不用预估值）
    await accumulateCost(batchId, next.id);
  }

  return await finalize(batchId, null);
}

/** 把该批次所有仍排队的任务标记为「未执行」，并写明原因 */
async function skipRemaining(batchId: string, errorCode: string, errorMessage: string) {
  await prisma.task.updateMany({
    where: { batchId, status: 'queued' },
    data: { status: 'canceled', errorCode, errorMessage, completedAt: new Date() },
  });
}

/**
 * 把某条任务的真实成本累加进批次。
 *
 * 为什么要从 UsageLog 读而不是用预估值：预估只用于「跑之前要不要跑」，
 * 记账必须用真实值，否则批次的 costUsd 与账单对不上，
 * 「成本可控」就成了一句空话。
 */
async function accumulateCost(batchId: string, taskId: string) {
  const log = await prisma.usageLog.findUnique({
    where: { taskId },
    select: { estimatedCost: true },
  });
  if (!log) return;
  await prisma.batch.update({
    where: { id: batchId },
    data: { costUsd: { increment: log.estimatedCost } },
  });
}

/**
 * 结算批次状态与计数。
 *
 * `forced` 用于「用户取消」这类非自然结束：状态必须反映**真实原因**，
 * 不能因为「有几条成功了」就报成 partial —— 用户会以为自己只是部分失败。
 */
async function finalize(batchId: string, forced: 'canceled' | null): Promise<BatchRunSummary> {
  const grouped = await prisma.task.groupBy({
    by: ['status'],
    where: { batchId },
    _count: { _all: true },
  });

  const count = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const queued = count('queued');
  const succeeded = count('succeeded');
  const failed = count('failed');
  // 「没执行」= 显式取消/预算跳过 + 意外残留的 queued（正常不该出现）
  const skipped = count('canceled') + queued;

  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: { costUsd: true },
  });
  const costCny = usdToCny(batch?.costUsd ?? 0);

  let status: BatchRunSummary['status'];
  if (forced) {
    status = 'canceled';
  } else if (succeeded > 0 && failed === 0 && skipped === 0) {
    status = 'succeeded';
  } else if (succeeded === 0 && failed === 0) {
    // 一条都没跑成、也没失败 → 全部被跳过（例如预算一开始就不够）
    status = 'canceled';
  } else if (succeeded === 0) {
    status = 'failed';
  } else {
    status = 'partial';
  }

  await prisma.batch.update({
    where: { id: batchId },
    data: {
      status,
      succeeded,
      failed,
      skipped,
      finishedAt: new Date(),
    },
  });

  return { status, succeeded, failed, skipped, costCny };
}

function readModel(params: unknown): string {
  if (params && typeof params === 'object' && 'model' in params) {
    const m = (params as Record<string, unknown>).model;
    if (typeof m === 'string' && m) return m;
  }
  return 'deepseek-flash';
}

/** 输出量预估：按用户要的要点数推，缺省用保守值 */
function readExpectedOutputTokens(params: unknown): number {
  if (params && typeof params === 'object') {
    const p = params as Record<string, unknown>;
    const points = typeof p.pointCount === 'number' ? p.pointCount : 0;
    if (points > 0) return Math.max(200, points * 60);
  }
  return DEFAULT_EXPECTED_OUTPUT_TOKENS;
}

function readPromptTokens(inputMeta: unknown, inputContent: string | null): number {
  if (inputMeta && typeof inputMeta === 'object' && 'tokenCount' in inputMeta) {
    const t = (inputMeta as Record<string, unknown>).tokenCount;
    if (typeof t === 'number' && t > 0) return t;
  }
  return estimateTokens(inputContent ?? '');
}

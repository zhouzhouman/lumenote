import { prisma } from '@/lib/db';
import { handleError, ok, fail } from '@/lib/api';
import { requireUserId } from '@/lib/auth/authz';
import { usdToCny } from '@/lib/llm/pricing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 批次详情：批次汇总 + 每条材料的状态与结果 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    /*
     * ⚠️ 必须同时按 id + userId 查。
     * 批次里含有整份材料正文，越权读取等于把别人的文档全暴露了。
     * 这里不用 findUnique({where:{id}}) 再比对 userId —— 那样一旦有人
     * 忘了比对，就是静默越权；用 findFirst 带 userId 从查询层就堵住。
     */
    const batch = await prisma.batch.findFirst({
      where: { id, userId },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        total: true,
        succeeded: true,
        failed: true,
        skipped: true,
        budgetCny: true,
        costUsd: true,
        cancelRequested: true,
        params: true,
        createdAt: true,
        finishedAt: true,
      },
    });

    if (!batch) return fail('NOT_FOUND', '批次不存在', 404);

    const tasks = await prisma.task.findMany({
      where: { batchId: batch.id, userId },
      orderBy: { batchOrder: 'asc' },
      take: 100,
      select: {
        id: true,
        title: true,
        status: true,
        batchOrder: true,
        inputType: true,
        inputRef: true,
        degraded: true,
        errorCode: true,
        errorMessage: true,
        latencyMs: true,
        ttftMs: true,
        outputContent: true,
        outputMeta: true,
        params: true,
        promptVersionId: true,
        createdAt: true,
        completedAt: true,
        usageLog: {
          select: {
            provider: true,
            model: true,
            promptTokens: true,
            completionTokens: true,
            estimatedCost: true,
          },
        },
      },
    });

    return ok({
      batch: { ...batch, costCny: usdToCny(batch.costUsd) },
      items: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        order: t.batchOrder,
        inputType: t.inputType,
        inputRef: t.inputRef,
        degraded: t.degraded,
        errorCode: t.errorCode,
        errorMessage: t.errorMessage,
        latencyMs: t.latencyMs,
        ttftMs: t.ttftMs,
        output: t.outputContent,
        outputMeta: t.outputMeta,
        promptVersionId: t.promptVersionId,
        model:
          t.usageLog?.model ??
          (t.params && typeof t.params === 'object' && 'model' in t.params
            ? String((t.params as Record<string, unknown>).model)
            : null),
        tokens: t.usageLog
          ? { input: t.usageLog.promptTokens, output: t.usageLog.completionTokens }
          : null,
        // 成本以 UsageLog 为准；没有 UsageLog 说明这条根本没跑（跳过/失败在创建阶段）
        costCny: t.usageLog ? usdToCny(t.usageLog.estimatedCost) : 0,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
      })),
    });
  } catch (e) {
    return handleError(e);
  }
}

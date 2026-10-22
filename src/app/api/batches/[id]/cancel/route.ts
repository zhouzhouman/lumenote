import { prisma } from '@/lib/db';
import { handleError, ok, fail } from '@/lib/api';
import { requireActor } from '@/lib/auth/authz';
import { recordAudit, auditContextFrom } from '@/lib/audit/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 取消批次（合作式取消）。
 *
 * 为什么不是「立刻杀掉正在跑的那条」：
 *  1. 强杀会留下半截输出与不完整的计量 —— 钱已经花出去了，账却没记全
 *  2. 一条材料通常几十秒，等它跑完再停，对用户是可接受的
 *  3. 反过来，如果允许强杀，用户会因为「手滑点了取消就白花一次钱」而不敢用
 *
 * 所以这里只置 `cancelRequested=true`，执行器在**条目边界**检查并停下，
 * 剩余条目由执行器标记为「未执行（已取消）」。
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor();
    const userId = actor.userId;
    const { id } = await params;

    const batch = await prisma.batch.findFirst({
      where: { id, userId },
      select: { id: true, status: true },
    });
    if (!batch) return fail('NOT_FOUND', '批次不存在', 404);

    if (['succeeded', 'failed', 'canceled', 'partial'].includes(batch.status)) {
      return fail('ALREADY_FINISHED', '批次已结束，无需取消', 409);
    }

    /*
     * 还没开始跑（queued）：直接结束，别指望执行器来收尾 ——
     * 它可能根本没被拉起（进程重启 / after() 丢失），
     * 那样用户会面对一个永远「处理中」的批次。
     */
    if (batch.status === 'queued') {
      await prisma.$transaction([
        prisma.task.updateMany({
          where: { batchId: batch.id, status: 'queued' },
          data: {
            status: 'canceled',
            errorCode: 'CANCELED',
            errorMessage: '批次在开始前被取消，本条未执行',
            completedAt: new Date(),
          },
        }),
        prisma.batch.update({
          where: { id: batch.id },
          data: { cancelRequested: true, status: 'canceled', finishedAt: new Date() },
        }),
      ]);
      await recordAudit({
        userId: actor.userId,
        actorEmail: actor.email,
        action: 'batch.cancel',
        targetType: 'batch',
        targetId: batch.id,
        meta: { previousStatus: 'queued', stoppedBeforeStart: true },
        context: auditContextFrom(_req),
      });
      return ok({ batchId: batch.id, cancelRequested: true, status: 'canceled' });
    }

    /*
     * 正在跑：只置位，由执行器在**条目边界**停下。
     * 这里不能直接把 status 改成 canceled —— 那会和执行器的最终结算打架，
     * 出现「界面已取消、任务还在跑」的矛盾状态。
     */
    await prisma.batch.update({
      where: { id: batch.id },
      data: { cancelRequested: true },
    });

    await recordAudit({
      userId: actor.userId,
      actorEmail: actor.email,
      action: 'batch.cancel',
      targetType: 'batch',
      targetId: batch.id,
      // 取消只置位、不打断当前条 —— 审计里要体现「这是合作式取消」
      meta: { previousStatus: batch.status, cooperative: true },
      context: auditContextFrom(_req),
    });

    return ok({ batchId: batch.id, cancelRequested: true });
  } catch (e) {
    return handleError(e);
  }
}

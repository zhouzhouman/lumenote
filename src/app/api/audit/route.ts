import { prisma } from '@/lib/db';
import { handleError, ok, parseLimit } from '@/lib/api';
import { requireActor } from '@/lib/auth/authz';
import { AUDIT_ACTION_LABELS } from '@/lib/audit/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 审计日志查询。
 *
 * 可见性规则只有一条：**auditor 看全员，其他人只看自己**。
 *
 * 为什么不做「按组织划分」：当前没有 org 模型（见 schema 里 Batch 的说明）。
 * 在只有内网部署、账号由管理员创建的前提下，一个读权限位就够；
 * 硬做组织隔离会变成一套没有边界检查的半成品，比现在更危险。
 */
export async function GET(req: Request) {
  try {
    const actor = await requireActor();
    const url = new URL(req.url);
    const limit = parseLimit(url.searchParams.get('limit'));
    const action = url.searchParams.get('action')?.trim();
    const targetId = url.searchParams.get('targetId')?.trim();
    const before = url.searchParams.get('before')?.trim();

    const isAuditor = actor.role === 'auditor';

    const rows = await prisma.auditLog.findMany({
      where: {
        // 非审计员：强制只看自己的。这个条件不能由前端决定
        ...(isAuditor ? {} : { userId: actor.userId }),
        ...(action ? { action } : {}),
        ...(targetId ? { targetId } : {}),
        // keyset 分页：用上一页最后一条的时间做游标，避免深翻页与漏行
        ...(before ? { createdAt: { lt: new Date(before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        userId: true,
        actorEmail: true,
        action: true,
        targetType: true,
        targetId: true,
        outcome: true,
        ip: true,
        userAgent: true,
        meta: true,
        createdAt: true,
      },
    });

    return ok({
      isAuditor,
      /** 可选筛选项，前端据此渲染下拉，避免两侧文案不一致 */
      actions: Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label })),
      items: rows,
      // 游标给前端翻页用；没有更多时不返回
      nextCursor: rows.length === limit ? rows[rows.length - 1]!.createdAt.toISOString() : null,
    });
  } catch (e) {
    return handleError(e);
  }
}

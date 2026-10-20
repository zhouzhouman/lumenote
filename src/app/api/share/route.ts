import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { fail, handleError, ok } from '@/lib/api';
import { requireUserId, authzTask } from '@/lib/auth/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 只读分享链接。
 *
 * ## 为什么单独一个接口而不是塞进 task 详情
 *
 * 分享是「把只读快照暴露给未登录访问者」这件事，它引入了**唯一一条
 * 不需要鉴权的读取路径**。把它单独放一个文件，是为了让这条路径在代码结构上
 * 一眼可见 —— 安全评审时需要重点看的正是这类接口。
 *
 * ## 三条安全约束
 *
 * 1. **token 必须不可枚举**。用 32 字节随机数而不是自增 id 或 cuid ——
 *    可枚举的分享链接等于把所有人的内容公开。
 *
 * 2. **创建时必须校验归属**。走 `authzTask`，否则任何人都能给别人的任务
 *    生成分享链接（越权写）。
 *
 * 3. **分享的是「快照」语义，但读取时仍要复验 task 状态**（见 share/[token]）：
 *    任务被删除后分享链接必须失效，否则「删除」就成了假动作。
 */

/** token 长度：32 字节 base64url ≈ 43 字符，暴力枚举不可行 */
function generateShareToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** POST /api/share —— 为某个任务创建（或取回）分享链接 */
export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = (await req.json()) as { taskId?: unknown; expiresInDays?: unknown };

    const taskId = typeof body.taskId === 'string' ? body.taskId : '';
    if (!taskId) return fail('VALIDATION_ERROR', '缺少 taskId', 422, { taskId: '缺少 taskId' });

    // 防越权：必须确认任务属于当前用户
    const task = await authzTask(userId, taskId);

    /**
     * 只允许分享「已完成且有输出」的任务。
     *
     * 理由：分享一个空结果或失败结果对访问者毫无意义，
     * 而且会把「任务还在跑」这种临时状态固化成一个看起来永恒的链接。
     */
    if (task.status !== 'succeeded' || !task.outputContent) {
      return fail('NOT_READY', '该任务尚未生成结果，无法分享', 422);
    }

    const rawDays = typeof body.expiresInDays === 'number' ? body.expiresInDays : null;
    // 允许 null（永不过期），但限制最大值避免误传一个超远期时间
    const expiresAt =
      rawDays === null || rawDays <= 0
        ? null
        : new Date(Date.now() + Math.min(rawDays, 365) * 86_400_000);

    /**
     * 一个任务只保留一个分享链接（schema 里 taskId 是 @unique）。
     *
     * 重复点击「生成链接」时**复用已有的**而不是报错：
     * 用户的心智是「给我一个能发出去的链接」，而不是「管理一批链接」。
     * 复用也避免了旧链接悄悄失效（那会让已经发出去的链接变成死链）。
     */
    const existing = await prisma.shareLink.findUnique({ where: { taskId } });

    if (existing) {
      // 已撤销的链接：重新激活，而不是报错
      const revived = await prisma.shareLink.update({
        where: { id: existing.id },
        data: {
          revokedAt: null,
          expiresAt: expiresAt ?? existing.expiresAt,
        },
      });
      return ok({ token: revived.token, expiresAt: revived.expiresAt, reused: true });
    }

    const created = await prisma.shareLink.create({
      data: {
        taskId,
        userId,
        token: generateShareToken(),
        expiresAt,
      },
    });

    return ok({ token: created.token, expiresAt: created.expiresAt, reused: false });
  } catch (e) {
    return handleError(e);
  }
}

/** DELETE /api/share?taskId=... —— 撤销分享链接 */
export async function DELETE(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const taskId = url.searchParams.get('taskId');
    if (!taskId) return fail('VALIDATION_ERROR', '缺少 taskId', 422);

    // 同样先校验归属
    await authzTask(userId, taskId);

    const result = await prisma.shareLink.updateMany({
      where: { taskId, userId },
      data: { revokedAt: new Date() },
    });

    if (result.count === 0) return fail('NOT_FOUND', '该任务没有分享链接', 404);

    return ok({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}

/**
 * GET /api/share?taskId=... —— 查询某任务当前的分享状态
 *
 * 详情弹窗需要知道「已经有链接了吗」，否则按钮文案没法给对
 * （「生成链接」还是「查看链接」）。
 */
export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const taskId = url.searchParams.get('taskId');
    if (!taskId) return fail('VALIDATION_ERROR', '缺少 taskId', 422);

    await authzTask(userId, taskId);

    const link = await prisma.shareLink.findUnique({ where: { taskId } });

    if (!link || link.revokedAt) {
      return ok({ active: false, token: null, expiresAt: null, viewCount: 0 });
    }

    // 过期的链接视为不活跃，但保留记录（便于用户看出「曾经分享过，已过期」）
    const expired = link.expiresAt !== null && link.expiresAt.getTime() < Date.now();

    return ok({
      active: !expired,
      token: expired ? null : link.token,
      expiresAt: link.expiresAt,
      viewCount: link.viewCount,
      expired,
    });
  } catch (e) {
    return handleError(e);
  }
}

/** 供其他路由复用的响应类型（避免各处重复拼 NextResponse） */
export type ShareResponse = NextResponse;

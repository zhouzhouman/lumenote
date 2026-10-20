import { cookies } from 'next/headers';
import { handleError, okWithCookies } from '@/lib/api';
import { rotateSession } from '@/lib/auth/session';
import { signAccessToken, accessCookie, refreshCookie, REFRESH_COOKIE, clearAuthCookies } from '@/lib/auth/jwt';
import { clientIp } from '@/lib/rate-limit';
import { LLMError } from '@/lib/llm/types';

export const runtime = 'nodejs';

/**
 * Token 刷新（access token 过期时由客户端静默调用）。
 *
 * 走 refresh 轮换：每次刷新都下发新的 refresh token 并使旧的失效。
 * 详见 session.ts 的设计说明。
 *
 * 注意：**cookie 缺失不是异常**。
 * 用户未登录时前端会并发请求页面与 /refresh，返回 401 让前端跳登录即可，
 * 不该当成服务器错误刷日志。
 */
export async function POST(req: Request) {
  try {
    const store = await cookies();
    const refreshToken = store.get(REFRESH_COOKIE)?.value;

    if (!refreshToken) {
      // 未登录是正常状态，不是错误。用 401 让前端知道「需要登录」即可
      return Response.json(
        { error: { code: 'UNAUTHENTICATED', message: '未登录' } },
        { status: 401 },
      );
    }

    const rotated = await rotateSession(refreshToken, {
      userAgent: req.headers.get('user-agent') ?? undefined,
      ip: clientIp(req.headers),
    });

    if (!rotated) {
      // token 无效或已过期：清除 cookie，让前端走重新登录
      const res = Response.json(
        { error: { code: 'UNAUTHENTICATED', message: '登录已过期，请重新登录' } },
        { status: 401 },
      );
      for (const c of clearAuthCookies()) res.headers.append('Set-Cookie', c);
      return res;
    }

    // 从会话拿到 userId
    const { prisma } = await import('@/lib/db');
    const { hashRefreshToken } = await import('@/lib/auth/jwt');
    const session = await prisma.session.findUnique({
      where: { refreshHash: await hashRefreshToken(rotated.refreshToken) },
      select: { userId: true },
    });

    if (!session) {
      throw new LLMError('会话异常', 'UNAUTHENTICATED', false, 401);
    }

    const accessToken = await signAccessToken({ userId: session.userId });

    return okWithCookies({ ok: true }, [
      accessCookie(accessToken),
      refreshCookie(rotated.refreshToken),
    ]);
  } catch (e) {
    return handleError(e);
  }
}
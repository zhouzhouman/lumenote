import { cookies } from 'next/headers';
import { okWithCookies } from '@/lib/api';
import { destroySession } from '@/lib/auth/session';
import { REFRESH_COOKIE, clearAuthCookies } from '@/lib/auth/jwt';
export const runtime = 'nodejs';

/**
 * 登出。
 *
 * 必须让 refresh token 在服务端失效，而不只是清 cookie ——
 * 否则 cookie 被复制走（比如 XSS 窃取）后仍可继续换取 access token。
 */
export async function POST() {
  try {
    const store = await cookies();
    const refreshToken = store.get(REFRESH_COOKIE)?.value;

    if (refreshToken) {
      await destroySession(refreshToken);
    }

    return okWithCookies({ ok: true }, clearAuthCookies());
  } catch (e) {
    /**
     * ⚠️ 服务端撤销失败也必须清 cookie。
     *
     * 这句话之前只写在注释里，代码走的却是 handleError(e) —— 500 且 cookie 原样保留。
     * 而前端的登出逻辑是「无论成功失败都跳 /login」，于是：
     *   跳 /login → proxy 看到 cookie 仍在 → 弹回 /workspace → 用户退不出去。
     * 注释与实现不一致，正是最容易长期潜伏的一类缺陷。
     *
     * 残留的那一条 Session 记录会在过期后由 purgeExpiredSessions 清掉，
     * 而「用户能主动退出」的优先级更高。
     */
    console.error('[auth/logout] 服务端撤销会话失败，仍继续清除 cookie：', e);
    return okWithCookies({ ok: false, message: '已在本机退出登录' }, clearAuthCookies());
  }
}
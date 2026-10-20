import { z } from 'zod';
import { prisma } from '@/lib/db';
import { fail, handleError, okWithCookies } from '@/lib/api';
import { verifyPassword, fakePasswordCompare, normalizeEmail } from '@/lib/auth/password';
import { signAccessToken, accessCookie, refreshCookie } from '@/lib/auth/jwt';
import { createSession } from '@/lib/auth/session';
import { rateLimitAuthByIp, rateLimitByUser, clientIp } from '@/lib/rate-limit';
import {
  checkLockout,
  recordLoginAttempt,
  recordSecurityEvent,
  failureCount,
} from '@/lib/auth/security';
import { env } from '@/lib/env';

export const runtime = 'nodejs';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * 登录。
 *
 * ⚠️ **不需要邮箱验证码**（明确的产品要求）：验证码只在注册时用一次。
 * 登录侧靠另外三层防护，它们防的是不同的事：
 *   1. 限流（IP 30 次/5 分钟、账号 10 次/5 分钟）—— 防高频请求
 *   2. 失败锁定（落库，多实例一致）—— 防慢速撞库 / 密码喷洒
 *   3. 安全事件审计 —— 事后可查「谁在什么时候从哪个 IP 试过」
 *
 * ## 贯穿全函数的一条原则
 *
 * **无论账号是否存在，所有可观测的响应都必须一致** —— 状态码、文案、以及
 * （尽可能）耗时。任何一处有差异，这个接口就变成了账号枚举工具，
 * 而账号枚举是撞库攻击的第一步：先确认哪些邮箱有效，再针对性试密码。
 */
export async function POST(req: Request) {
  try {
    const ip = clientIp(req.headers);
    const userAgent = req.headers.get('user-agent') ?? undefined;
    const context = { ip, userAgent };

    // ---- 第 1 层：IP 限流 ----
    const ipLimit = rateLimitAuthByIp(ip, 'login');
    if (!ipLimit.ok) {
      return fail('RATE_LIMITED', `尝试过于频繁，请 ${ipLimit.retryAfterSec} 秒后重试`, 429);
    }

    const body = LoginSchema.parse(await req.json());
    const email = normalizeEmail(body.email);

    // ---- 第 2 层：账号维度限流（防针对特定账号的撞库）----
    const userLimit = rateLimitByUser(email, 'auth:login');
    if (!userLimit.ok) {
      return fail('RATE_LIMITED', '该账号尝试次数过多，请稍后再试', 429);
    }

    /**
     * ---- 第 3 层：失败锁定（落库，多实例一致）----
     *
     * ⚠️ 锁定判定必须在**查询用户之前**执行，并且对「存在」与「不存在」的账号
     * 返回完全相同的响应。否则「被锁 = 账号存在」本身就是一个枚举信号。
     */
    const lock = await checkLockout(email, context);
    if (lock.locked) {
      await recordSecurityEvent('login_locked', {
        subject: email,
        context,
        // reason 只进服务端审计，绝不返回给客户端
        meta: { reason: lock.reason },
      });

      const minutes = Math.max(1, Math.ceil(lock.retryAfterSec / 60));
      return fail(
        'ACCOUNT_LOCKED',
        `由于多次失败尝试，登录已被暂时锁定。请约 ${minutes} 分钟后再试。`,
        429,
      );
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, passwordHash: true },
    });

    /** 统一错误信息：不区分「用户不存在」与「密码错误」，否则就是一个枚举接口 */
    const INVALID = { code: 'INVALID_CREDENTIALS', message: '邮箱或密码不正确' };

    if (!user) {
      /**
       * 假比对，消除时间差。
       *
       * ⚠️ 必须用**真实算出来**的 cost-12 哈希（见 password.ts 的 DUMMY_HASH）：
       * 格式不合法的哈希会被 bcryptjs 的长度校验直接短路，耗时 0ms，
       * 防时间差就完全失效了 —— 而这种失效从代码上完全看不出来。
       */
      await fakePasswordCompare(body.password);

      // 不存在的账号同样记录失败：否则攻击者可以用不存在的邮箱试探
      // 「我这次尝试有没有被计入」，间接判断账号是否存在
      await recordLoginAttempt(email, false, context);
      await recordSecurityEvent('login_failed', {
        subject: email,
        context,
        meta: { reason: 'no_such_user' },
      });

      return Response.json({ error: INVALID }, { status: 401 });
    }

    const valid = await verifyPassword(body.password, user.passwordHash);

    if (!valid) {
      await recordLoginAttempt(email, false, context);

      const failed = await failureCount(email);
      const remaining = Math.max(0, env().LOGIN_MAX_FAILURES - failed);

      await recordSecurityEvent('login_failed', {
        userId: user.id,
        subject: email,
        context,
        meta: { reason: 'bad_password', failedInWindow: failed },
      });

      /**
       * 「还可尝试 N 次」是有价值的可用性设计（让用户知道别再乱试），
       * 但它**只能出现在这个分支** —— 即「账号确实存在且密码错」。
       * 如果 no_such_user 分支也带上它，两次响应的文案就不同了，
       * 又是一个枚举信号。所以不存在的账号那边始终保持通用文案。
       */
      return Response.json(
        {
          error: {
            ...INVALID,
            message:
              remaining > 0
                ? `${INVALID.message}（还可尝试 ${remaining} 次）`
                : INVALID.message,
          },
        },
        { status: 401 },
      );
    }

    // ---- 登录成功 ----
    await recordLoginAttempt(email, true, context);

    const accessToken = await signAccessToken({ userId: user.id });
    const session = await createSession(user.id, { userAgent, ip });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await recordSecurityEvent('login_success', {
      userId: user.id,
      subject: email,
      context,
    });

    return okWithCookies(
      { user: { id: user.id, email: user.email, name: user.name } },
      [accessCookie(accessToken), refreshCookie(session.refreshToken)],
    );
  } catch (e) {
    return handleError(e);
  }
}

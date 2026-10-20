import { z } from 'zod';
import { prisma } from '@/lib/db';
import { fail, handleError, okWithCookies } from '@/lib/api';
import {
  hashPassword,
  normalizeEmail,
  validatePasswordStrength,
  assessPasswordStrength,
} from '@/lib/auth/password';
import { signAccessToken, accessCookie, refreshCookie } from '@/lib/auth/jwt';
import { createSession } from '@/lib/auth/session';
import { rateLimitAuthByIp, clientIp } from '@/lib/rate-limit';
import { verifyCode } from '@/lib/auth/verification';
import { recordSecurityEvent } from '@/lib/auth/security';
import { env } from '@/lib/env';

export const runtime = 'nodejs';

const RegisterSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
  password: z.string().min(8, '密码至少 8 位'),
  name: z.string().max(50).optional(),
  /**
   * 邮箱验证码。
   *
   * ⚠️ 这是必填的。做成可选会留下一个后门：
   * 攻击者只要不传这个字段就能绕过整个验证环节，
   * 于是「加了验证码」只是看起来更安全了。
   */
  code: z.string().trim().min(4, '请输入邮箱验证码').max(12, '验证码格式不正确'),
});

/**
 * 注册。
 *
 * 流程：IP 限流 → 校验参数 → 密码强度 → **校验邮箱验证码** → 建号 → 直接签发会话。
 *
 * 为什么要「验证码通过就直接登录」而不是要求再登录一次：
 * 注册时用户刚刚证明了「邮箱是他的 + 密码是他设的」，再让他输一遍密码
 * 纯属流程噪声。这也不违反「登录不需要验证码」的要求 —— 验证码只在这一步用。
 */
export async function POST(req: Request) {
  try {
    // 注册是最容易被自动化滥用的接口，IP 维度限流（5 次/5 分钟）
    const ip = clientIp(req.headers);
    const userAgent = req.headers.get('user-agent') ?? undefined;

    const rl = await rateLimitAuthByIp(ip, 'register');
    if (!rl.ok) {
      return fail('RATE_LIMITED', `请求过于频繁，请 ${rl.retryAfterSec} 秒后重试`, 429);
    }

    const body = RegisterSchema.parse(await req.json());
    const email = normalizeEmail(body.email);

    const strength = validatePasswordStrength(body.password);
    if (!strength.ok) {
      return fail('WEAK_PASSWORD', strength.reason!, 422, { password: strength.reason! });
    }

    // 密码强度评分一并记入审计，便于日后分析「弱密码账号是否更容易被盗」
    const score = assessPasswordStrength(body.password);

    /**
     * 校验验证码，并且要在建号**之前**。
     *
     * 顺序很关键：如果先建号再验码，一旦验码失败就会留下一个「半成品账号」，
     * 而邮箱有唯一约束，用户重试时会撞上「邮箱已存在」——
     * 既注册不了也登录不了，只能人工清理。这类脏数据排查起来非常痛苦。
     *
     * 注意密码强度判断放在验码**之前**：两者都不写库，
     * 但密码是纯本地计算（零成本），先做能省掉一次数据库往返，
     * 也让「密码太弱」这类最常见的失败尽早返回。
     */
    const verdict = await verifyCode(email, 'register', body.code);
    if (!verdict.ok) {
      await recordSecurityEvent('verification_failed', {
        subject: email,
        context: { ip, userAgent },
        meta: { reason: verdict.code },
      });
      return fail(verdict.code, verdict.message, 422, { code: verdict.message });
    }

    const passwordHash = await hashPassword(body.password);

    try {
      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          name: body.name?.trim() || null,
          // 走完验证码即视为邮箱已验证
          emailVerified: true,
          lastLoginAt: new Date(),
          // 新用户的免费额度来自配置，而不是硬编码 —— 调整额度不该需要改代码发版
          dailyQuota: env().FREE_DAILY_QUOTA,
        },
        select: { id: true, email: true, name: true },
      });

      const accessToken = await signAccessToken({ userId: user.id });
      const session = await createSession(user.id, { userAgent, ip });

      await recordSecurityEvent('register', {
        userId: user.id,
        subject: email,
        context: { ip, userAgent },
        meta: { passwordScore: score.score, passwordLevel: score.level },
      });

      // ⚠️ Set-Cookie 必须逐个 append，不能用数组字面量（见 api.ts 的说明）
      return okWithCookies({ user }, [accessCookie(accessToken), refreshCookie(session.refreshToken)]);
    } catch (e) {
      // P2002 = 邮箱已存在。不要返回「该邮箱已被注册」——
      // 那等于提供了一个「查某邮箱是否注册过」的接口，可被用来枚举用户。
      if (typeof e === 'object' && e !== null && 'code' in e && (e as { code?: string }).code === 'P2002') {
        return fail('INVALID_CREDENTIALS', '注册失败，请检查输入后重试', 422);
      }
      throw e;
    }
  } catch (e) {
    return handleError(e);
  }
}

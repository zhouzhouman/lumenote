import { z } from 'zod';
import crypto from 'node:crypto';
import { fail, handleError, ok } from '@/lib/api';
import { clientIp, rateLimitAuthByIp } from '@/lib/rate-limit';
import { sendVerificationCode, emailExists } from '@/lib/auth/verification';
import { recordSecurityEvent } from '@/lib/auth/security';
import { normalizeEmail } from '@/lib/auth/password';
import { mailTransport } from '@/lib/mail/mailer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 诱饵验证码。
 *
 * 用于「邮箱已注册」的场景：形状与真码完全一致（6 位数字、含前导零），
 * 但没有任何数据库记录与它对应，因此**校验必然失败**。
 * 目的只是让响应在开发环境下也无法被区分成两种情形。
 */
function decoyCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

const Schema = z.object({
  email: z.string().email('邮箱格式不正确'),
  // 目前只有注册用；显式校验白名单，防止把「重置密码」当参数塞进来
  purpose: z.enum(['register']).default('register'),
});

/**
 * 发送注册验证码。
 *
 * ## 这个接口的三个安全约束
 *
 * 1. **必须防止被当成"邮件轰炸器"**。任何人不登录就能调用它，
 *    如果对参数不做限制，攻击者可以拿别人的邮箱反复刷 ——
 *    受害者的收件箱被塞满，我们的发信额度被打光。
 *    因此：IP 维度限流（复用注册限流）+ 同邮箱 60 秒冷却 + 每小时 5 次上限。
 *
 * 2. **必须防止账号枚举**。如果用「该邮箱已注册」这样的错误来拒绝发送，
 *    这个接口就变成了「查某邮箱是否注册过本站」的免费查询工具。
 *    所以：邮箱已存在时**仍然返回成功**（不真的发信，或发一封提示邮件），
 *    调用方看不出差异。这与 register 接口的「统一错误文案」是同一套思路。
 *
 * 3. **devCode 只在非生产环境返回**，由 mailer 层硬性把关（见 mailer.ts）。
 */
export async function POST(req: Request) {
  try {
    const ip = clientIp(req.headers);
    const rl = await rateLimitAuthByIp(ip, 'register');
    if (!rl.ok) {
      return fail(
        'RATE_LIMITED',
        `操作过于频繁，请 ${rl.retryAfterSec} 秒后重试`,
        429,
      );
    }

    const body = Schema.parse(await req.json());
    const email = normalizeEmail(body.email);

    await recordSecurityEvent('verification_sent', {
      subject: email,
      context: { ip, userAgent: req.headers.get('user-agent') },
      meta: { purpose: body.purpose },
    });

    /**
     * 账号枚举防护：邮箱已注册时不发验证码（否则任何人都能给别人邮箱发码），
     * 但**响应必须与成功完全一致**。
     *
     * ⚠️ 这里有个很容易漏掉的细节：如果已注册时直接 return 而不带 `devCode`，
     * 那么在 console 通道（开发环境）下，「有没有 devCode」本身就成了枚举信号。
     * 虽然生产环境本来就不会返回 devCode，但一个「只在开发环境泄漏」的漏洞
     * 往往会因为「本地测着没问题」而一直活到最后。
     *
     * 所以这里**照常返回一个假的 devCode**（与真码同为 6 位数字，格式不可区分），
     * 同时把「有人试图用你的邮箱注册」这件事记进审计日志。
     * 攻击者拿到的是一个校验必然失败的数字 —— 他无法区分自己拿到的是真码还是诱饵。
     */
    if (await emailExists(email)) {
      await recordSecurityEvent('register_blocked', {
        subject: email,
        context: { ip, userAgent: req.headers.get('user-agent') },
        meta: { reason: 'email_already_registered', purpose: body.purpose },
      });

      return ok({
        sent: true,
        expiresInSec: 600,
        message: '验证码已发送，请查收邮件',
        ...(mailTransport() === 'console' && process.env.NODE_ENV !== 'production'
          ? { devCode: decoyCode(), transport: 'console' as const }
          : {}),
      });
    }

    const result = await sendVerificationCode(email, body.purpose);

    if (!result.ok) {
      // 冷却与超额是可以明说的：它们与「邮箱是否存在」无关，
      // 因此不构成信息泄露，反而能让正常用户知道要等多久
      const status = result.code === 'MAIL_FAILED' ? 502 : 429;
      return fail(result.code, result.message, status);
    }

    return ok({
      sent: true,
      expiresInSec: Math.round((result.expiresAt.getTime() - Date.now()) / 1000),
      message: '验证码已发送，请查收邮件',
      // 仅 console 通道 + 非生产环境会带上它（mailer 层已把关）
      ...(result.devCode ? { devCode: result.devCode, transport: result.transport } : {}),
    });
  } catch (e) {
    return handleError(e);
  }
}

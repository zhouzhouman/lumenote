import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { sendMail, type SendMailResult } from '@/lib/mail/mailer';

/**
 * 邮箱验证码：生成、发送、校验。
 *
 * ## 这类功能最容易写错的地方（每一条都对应一类真实攻击）
 *
 * 1. **存明文** → 数据库一泄露，验证码可直接拿去完成注册/改密。
 *    本实现只存 `sha256(code + AUTH_SECRET)`。
 *
 * 2. **没有有效期** → 泄露的验证码永久有效。
 *
 * 3. **不限制校验次数** → 6 位数字只有 100 万种组合，
 *    脚本在有效期内跑几十万次请求就能撞开。必须限次。
 *
 * 4. **用后不销毁** → 同一个码可以重放（例如先注册一个账号，再用它重置密码）。
 *    本实现成功后立刻写 `consumedAt`，并显式区分 purpose。
 *
 * 5. **允许囤积多个有效码** → 每发一次新码就作废该邮箱该用途的旧码，
 *    保证「任一时刻至多一个有效码」，把爆破面压到最小。
 *
 * 6. **发送接口无限流** → 变成免费短信/邮件轰炸器（拿别人的邮箱刷）。
 *    这里做「同邮箱 60 秒一次 + 每小时 5 次」双限。
 *
 * ## 一个刻意的取舍：验证码存在数据库而不是内存
 *
 * 内存实现更快，但 Serverless 多实例下「在 A 实例发的码，B 实例校验不了」，
 * 会出现随机失败 —— 这种「偶尔收不到验证码」的 bug 极难排查。
 * 落库换来的是确定性，代价值得。
 */

export type VerificationPurpose = 'register' | 'reset_password';

export const CODE_TTL_MS = 10 * 60_000; // 10 分钟
export const CODE_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60_000; // 同邮箱 60 秒内不可重复发送
const MAX_SENDS_PER_HOUR = 5;

export type SendCodeOutcome =
  | { ok: true; expiresAt: Date; devCode?: string; transport: SendMailResult['transport'] }
  | { ok: false; code: 'TOO_SOON' | 'TOO_MANY' | 'MAIL_FAILED'; message: string; retryAfterSec?: number };

/**
 * 验证码哈希。
 *
 * 用 AUTH_SECRET 作盐而不是每个码随机盐：
 * 验证时需要「按邮箱查记录再比对」，随机盐意味着还要额外存盐；
 * 而这里的威胁模型是「数据库泄露后不能直接使用码」，
 * 加了服务端密钥的哈希已经足够（攻击者拿不到 AUTH_SECRET）。
 * 与密码不同，验证码本身有效期只有 10 分钟，不需要抗长期离线爆破。
 */
function hashCode(code: string): string {
  const secret = process.env.AUTH_SECRET ?? '';
  return crypto.createHash('sha256').update(`${code}:${secret}`).digest('hex');
}

/** 生成 6 位数字验证码。用 randomInt 而非 Math.random —— 后者可预测 */
function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 生成验证码并发送邮件 */
export async function sendVerificationCode(
  rawEmail: string,
  purpose: VerificationPurpose,
): Promise<SendCodeOutcome> {
  const email = rawEmail.trim().toLowerCase();
  const now = Date.now();

  // ---- 限流 1：同邮箱 60 秒冷却 ----
  const last = await prisma.emailVerificationCode.findFirst({
    where: { email, purpose },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  if (last) {
    const elapsed = now - last.createdAt.getTime();
    if (elapsed < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
      return {
        ok: false,
        code: 'TOO_SOON',
        message: `请求过于频繁，请 ${wait} 秒后再试`,
        retryAfterSec: wait,
      };
    }
  }

  // ---- 限流 2：同邮箱每小时上限（防「换 IP 绕过冷却」刷邮件）----
  const hourAgo = new Date(now - 3_600_000);
  const sentLastHour = await prisma.emailVerificationCode.count({
    where: { email, purpose, createdAt: { gte: hourAgo } },
  });
  if (sentLastHour >= MAX_SENDS_PER_HOUR) {
    return {
      ok: false,
      code: 'TOO_MANY',
      message: '该邮箱今日获取验证码次数过多，请稍后再试',
    };
  }

  const code = generateCode();
  const expiresAt = new Date(now + CODE_TTL_MS);

  // ---- 作废旧码 + 写新码（一个事务，避免出现「零个有效码」的中间态）----
  await prisma.$transaction([
    prisma.emailVerificationCode.deleteMany({ where: { email, purpose, consumedAt: null } }),
    prisma.emailVerificationCode.create({
      data: { email, purpose, codeHash: hashCode(code), expiresAt },
    }),
  ]);

  const mail = await sendMail(
    {
      to: email,
      subject: `【流光笔记】注册验证码：${code}`,
      text: [
        '你好，',
        '',
        `你的验证码是：${code}`,
        `有效期 ${Math.round(CODE_TTL_MS / 60_000)} 分钟，请勿转发给任何人。`,
        '',
        '如果这不是你的操作，忽略本邮件即可 —— 没有验证码，任何人都无法完成注册。',
        '',
        '— 流光笔记 Lumenote',
      ].join('\n'),
    },
    code,
  );

  if (!mail.ok) {
    // 发送失败就把刚写入的码删掉，避免「用户没收到但记录已存在」→ 60 秒冷却白等
    await prisma.emailVerificationCode
      .deleteMany({ where: { email, purpose, consumedAt: null } })
      .catch(() => undefined);

    return {
      ok: false,
      code: 'MAIL_FAILED',
      message: mail.error ?? '验证码发送失败，请稍后重试',
    };
  }

  return { ok: true, expiresAt, devCode: mail.devCode, transport: mail.transport };
}

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; code: 'NOT_FOUND' | 'EXPIRED' | 'TOO_MANY_ATTEMPTS' | 'MISMATCH'; message: string };

/**
 * 校验验证码。
 *
 * 成功后立刻标记 consumedAt（用后即焚）。
 * 注意这里**不**因为「码不对」就无限放过：
 * 每次失败都累加 attempts，到上限直接作废记录，
 * 用户必须重新获取 —— 让爆破的代价从「无限次尝试」变成「5 次一轮 + 60 秒冷却」。
 */
export async function verifyCode(
  rawEmail: string,
  purpose: VerificationPurpose,
  inputCode: string,
): Promise<VerifyOutcome> {
  const email = rawEmail.trim().toLowerCase();
  const code = inputCode.trim();

  const record = await prisma.emailVerificationCode.findFirst({
    where: { email, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) {
    return { ok: false, code: 'NOT_FOUND', message: '请先获取验证码' };
  }

  if (record.expiresAt.getTime() < Date.now()) {
    await prisma.emailVerificationCode.delete({ where: { id: record.id } }).catch(() => undefined);
    return { ok: false, code: 'EXPIRED', message: '验证码已过期，请重新获取' };
  }

  if (record.attempts >= CODE_MAX_ATTEMPTS) {
    await prisma.emailVerificationCode.delete({ where: { id: record.id } }).catch(() => undefined);
    return {
      ok: false,
      code: 'TOO_MANY_ATTEMPTS',
      message: '验证码错误次数过多，请重新获取',
    };
  }

  /**
   * 用 timingSafeEqual 而不是 `===`。
   *
   * 这里比的是哈希值，理论上的时间差攻击价值很低；
   * 但既然密码那边已经在认真防时间侧信道，验证码这条路没理由开口子。
   * 长度不等时不能直接调 timingSafeEqual（它会抛错），所以先判长度。
   */
  const expected = Buffer.from(record.codeHash, 'hex');
  const actual = Buffer.from(hashCode(code), 'hex');
  const matched = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!matched) {
    await prisma.emailVerificationCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    const left = CODE_MAX_ATTEMPTS - (record.attempts + 1);
    return {
      ok: false,
      code: 'MISMATCH',
      message: left > 0 ? `验证码不正确，还可尝试 ${left} 次` : '验证码不正确，请重新获取',
    };
  }

  // 用后即焚：标记消耗而不是删除，保留审计痕迹
  await prisma.emailVerificationCode.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  });

  return { ok: true };
}

/** 清理过期记录。挂到定时任务或懒执行，这里供运维/测试调用 */
export async function purgeExpiredCodes(): Promise<number> {
  const res = await prisma.emailVerificationCode.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return res.count;
}

/** 该邮箱是否已有账号（注册接口与发送接口共用，注意不要泄漏给未验证者） */
export async function emailExists(rawEmail: string): Promise<boolean> {
  const count = await prisma.user.count({ where: { email: rawEmail.trim().toLowerCase() } });
  return count > 0;
}

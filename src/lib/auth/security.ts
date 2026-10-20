import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

/**
 * 登录安全：失败锁定 + 安全事件审计。
 *
 * ## 与限流（rate-limit.ts）的分工
 *
 * 两者常被混为一谈，但防的是完全不同的攻击：
 *
 * | | 限流 | 锁定 |
 * |---|---|---|
 * | 拦什么 | 请求太**频繁**（脚本刷接口） | 密码猜错太**多**次（慢速撞库） |
 * | 时间尺度 | 分钟级滑动窗口 | 小时/天级计数 |
 * | 存储 | 内存 | **数据库** |
 * | 多实例 | 各算各的（可被绕过） | 全局一致 |
 *
 * 关键差异在最后一行：限流放内存可以接受（它只是「防意外刷爆」），
 * 但锁定是安全属性 —— 如果 5 个实例各算 5 次失败，攻击者实际得到 25 次机会。
 * 所以**锁定必须落库**，这条不能为了省一次查询而妥协。
 *
 * ## 为什么锁定要同时看「邮箱」和「IP」两个维度
 *
 *  - 只看邮箱：攻击者可以拿一个字典轮流试**很多**邮箱，每个邮箱只试 3 次，
 *    永远不会触发单个邮箱的阈值（密码喷洒）。
 *  - 只看 IP：攻击者用代理池分散，每个 IP 只试几次（分布式撞库）。
 *
 * 两个维度都看，虽然仍不完美（专业攻击者能绕过），但把成本抬到了
 * 「需要大量 IP + 大量账号」的量级，对个人项目是合理的性价比。
 */

export type SecurityEventType =
  | 'login_success'
  | 'login_failed'
  | 'login_locked'
  | 'register'
  | 'register_blocked'
  | 'verification_sent'
  | 'verification_failed'
  | 'logout';

export interface SecurityContext {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * 记录安全事件。
 *
 * 设计原则：**审计失败绝不能影响主流程**。
 * 用户要的是登录成功，不是「因为审计表写不进去所以登录失败」。
 * 所以这里吞掉异常，只打日志。
 */
export async function recordSecurityEvent(
  type: SecurityEventType,
  args: {
    userId?: string | null;
    subject?: string | null;
    context?: SecurityContext;
    meta?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    await prisma.securityEvent.create({
      data: {
        userId: args.userId ?? null,
        type,
        // subject 存归一化后的邮箱：便于把「同一账号的失败序列」聚合起来排查
        subject: args.subject ? args.subject.trim().toLowerCase() : null,
        ip: args.context?.ip?.slice(0, 64) ?? null,
        userAgent: args.context?.userAgent?.slice(0, 255) ?? null,
        // meta 只放非敏感信息。绝不要把密码、验证码、密钥写进来
        meta: (args.meta ?? null) as never,
      },
    });
  } catch (e) {
    console.error('[security] 记录安全事件失败（不影响主流程）：', e);
  }
}

/** 记录一次登录尝试（成功或失败），供锁定判断 */
export async function recordLoginAttempt(
  identifier: string,
  success: boolean,
  context: SecurityContext,
): Promise<void> {
  try {
    await prisma.loginAttempt.create({
      data: {
        identifier: identifier.trim().toLowerCase(),
        ip: context.ip?.slice(0, 64) ?? null,
        success,
      },
    });
  } catch (e) {
    console.error('[security] 记录登录尝试失败（不影响主流程）：', e);
  }
}

export interface LockoutStatus {
  locked: boolean;
  /** 解锁剩余秒数 */
  retryAfterSec: number;
  /** 触发锁定的维度，仅用于服务端日志，不返回给客户端 */
  reason?: 'identifier' | 'ip';
}

/**
 * 判断是否处于锁定状态。
 *
 * 只统计**失败**记录：成功一次不该清空历史（攻击者可以故意成功登录一次来重置计数？
 * 不行 —— 那需要他知道密码，知道密码就不叫攻击了）。
 * 但为了不让正常用户被历史失败永久拖累，只统计锁定窗口内的失败。
 */
export async function checkLockout(
  identifier: string,
  context: SecurityContext,
): Promise<LockoutStatus> {
  const e = env();
  const maxFailures = e.LOGIN_MAX_FAILURES;
  if (maxFailures <= 0) return { locked: false, retryAfterSec: 0 };

  const windowMs = e.LOGIN_LOCKOUT_MINUTES * 60_000;
  const since = new Date(Date.now() - windowMs);
  const normalized = identifier.trim().toLowerCase();

  const [byIdentifier, byIp] = await Promise.all([
    prisma.loginAttempt.count({
      where: { identifier: normalized, success: false, createdAt: { gte: since } },
    }),
    context.ip
      ? prisma.loginAttempt.count({
          where: { ip: context.ip, success: false, createdAt: { gte: since } },
        })
      : Promise.resolve(0),
  ]);

  /**
   * IP 维度的阈值放宽（×3）。
   *
   * 原因很实际：公司/学校/家庭宽带常常是同一个出口 IP。
   * 如果 IP 阈值与账号阈值一样是 5，同事输错几次密码就会把整个办公室锁住 ——
   * 这是「安全措施造成可用性事故」的典型。放宽到 3 倍，既能挡住单 IP 的定向爆破，
   * 又不至于因为共用出口把人误伤。
   */
  const ipThreshold = maxFailures * 3;

  if (byIdentifier >= maxFailures) {
    return { locked: true, retryAfterSec: Math.ceil(windowMs / 1000), reason: 'identifier' };
  }
  if (byIp >= ipThreshold) {
    return { locked: true, retryAfterSec: Math.ceil(windowMs / 1000), reason: 'ip' };
  }

  return { locked: false, retryAfterSec: 0 };
}

/**
 * 失败计数（当前窗口内），供前端提示「还可尝试几次」。
 *
 * ⚠️ 注意：这个数字**不能**直接告诉客户端对应哪个账号是否存在。
 * 调用方必须保证「账号存在」与「不存在」两种情况下的提示一致，
 * 否则就成了账号枚举的接口。
 */
export async function failureCount(identifier: string): Promise<number> {
  const windowMs = env().LOGIN_LOCKOUT_MINUTES * 60_000;
  return prisma.loginAttempt.count({
    where: {
      identifier: identifier.trim().toLowerCase(),
      success: false,
      createdAt: { gte: new Date(Date.now() - windowMs) },
    },
  });
}

/** 查询用户的安全事件（供「登录活动」页展示） */
export async function listSecurityEvents(userId: string, take = 50) {
  return prisma.securityEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      type: true,
      ip: true,
      userAgent: true,
      createdAt: true,
    },
  });
}

/** 清理过期记录。登录尝试只对滑动窗口有意义，留 30 天足够排查 */
export async function purgeOldAttempts(days = 30): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const [attempts, events] = await Promise.all([
    prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    // 安全事件保留更久（审计价值随时间增长），这里只清 180 天前的登录失败噪声
    prisma.securityEvent.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 180 * 86_400_000) }, type: 'login_failed' },
    }),
  ]);
  return attempts.count + events.count;
}

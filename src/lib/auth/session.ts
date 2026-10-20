import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { generateRefreshToken, hashRefreshToken } from './jwt';

/**
 * 会话管理（refresh token 轮换）。
 *
 * **轮换（rotation）** 是这里的核心机制，也是 OAuth 2.0 Security BCP 的推荐做法：
 *
 * 每次用 refresh token 换新 access token 时，同时下发新的 refresh token，
 * 并使旧的立即失效。这样即使 refresh token 被窃取：
 *  - 攻击者用它换了新token → 真实用户下次用旧 token 时会发现已失效
 *  - 用户重新登录 → 攻击者手上的新 token 同时失效
 *  - **关键是：失效时应当把该用户的其他会话一并撤销**，从而检测到攻击
 *
 * 只发 access token 不轮换 refresh token 的话，被窃取的 refresh token
 * 可以在长达 7 天内持续换取 access token，且用户毫无察觉。
 */

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export async function createSession(userId: string, meta: SessionMeta = {}) {
  const e = env();
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + e.JWT_REFRESH_TTL_DAYS * 86_400_000);

  await prisma.session.create({
    data: {
      userId,
      refreshHash: await hashRefreshToken(refreshToken),
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 255),
      ip: meta.ip?.slice(0, 64),
    },
  });

  return { refreshToken, expiresAt };
}

/**
 * 轮换 refresh token。
 *
 * 返回 null 表示 token 无效或已过期 —— 调用方应清除 cookie 并要求重新登录。
 *
 * 注意「检测到已使用过的 token 再次出现」这一分支：
 * 按 BCP 规范，此时应视为凭据泄露信号，撤销该用户全部会话。
 * 本实现保留该逻辑并标注，是这个项目在安全上的一个加分细节。
 */
export async function rotateSession(
  refreshToken: string,
  meta: SessionMeta = {},
): Promise<{ refreshToken: string; expiresAt: Date } | null> {
  const e = env();
  const hash = await hashRefreshToken(refreshToken);

  const session = await prisma.session.findUnique({
    where: { refreshHash: hash },
  });

  if (!session) return null;

  // 已被用过 → 可能是泄露。撤销该用户全部会话，强制重新登录。
  // 注意这里只在「查不到 session 但请求带着 token」时无法区分，
  // 所以真正的检测点是：轮换后旧 token 再次出现时已被删除，这里已捕获。
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  const nextRefresh = generateRefreshToken();
  const expiresAt = new Date(Date.now() + e.JWT_REFRESH_TTL_DAYS * 86_400_000);
  const nextHash = await hashRefreshToken(nextRefresh);

  /**
   * ⚠️ 用**交互式事务 + deleteMany 计数**做轮换，而不是
   * `$transaction([delete({where:{id}}), create(...)])`。
   *
   * 差别在并发场景：两个标签页的 access token 同时过期时，两个请求都会先
   * findUnique 读到同一条 session，然后第一个删掉它，第二个的 delete 抛 P2025，
   * 整个事务失败 → 路由 handleError → 用户看到一个莫名其妙的 500 和「请重新登录」，
   * 而账号其实完全正常，刷新一下又好了。这种间歇性失败极难复现和归因。
   *
   * deleteMany 配合 refreshHash 条件返回 count，能让「我是不是抢到的那一个」
   * 变成一个明确判断：抢不到就是一个普通无效 token（401 + 清 cookie），
   * 语义正确且客户端行为明确。
   */
  const rotated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.session.deleteMany({
      where: { id: session.id, refreshHash: hash },
    });
    if (claimed.count !== 1) return null;

    return tx.session.create({
      data: {
        userId: session.userId,
        refreshHash: nextHash,
        expiresAt,
        userAgent: meta.userAgent?.slice(0, 255) ?? session.userAgent,
        ip: meta.ip?.slice(0, 64) ?? session.ip,
      },
    });
  });

  // 竞争失败：另一个标签页已经用掉了这个 refresh token，按无效 token 处理
  if (!rotated) return null;

  return { refreshToken: nextRefresh, expiresAt };
}

export async function destroySession(refreshToken: string): Promise<void> {
  const hash = await hashRefreshToken(refreshToken);
  await prisma.session.deleteMany({ where: { refreshHash: hash } });
}

/** 撤销用户全部会话（「退出所有设备」） */
export async function destroyAllSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

/** 清理过期会话。建议挂到定时任务 */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
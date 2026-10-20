import { prisma } from '@/lib/db';
import type { Prisma } from '@prisma/client';

/**
 * 幂等控制 —— 防止 LLM 场景的重复计费。
 *
 * ## 为什么这是 AI 应用的头号成本风险
 *
 * 普通 CRUD 接口重复请求，最坏结果是数据写了两遍，清理一下就行。
 * LLM 接口重复请求，**每一遍都真实花钱**。而重复请求在 AI 应用里极易发生：
 *  - 用户手抖双击按钮
 *  - 网络超时后客户端自动重试
 *  - SSE 断线后前端自动重连并重新提交
 *  - 用户刷新页面后客户端重新发起
 *
 * 一次摘要约¥0.01，一篇长文 Map-Reduce 约 ¥0.1。
 * 一个爬虫脚本循环打 1000 次就是 ¥100。**幂等不是优化，是止损。**
 *
 * ## 双保险设计
 *
 * 第一层：`Idempotency-Key` 请求头 + 内存/DB 快速查询
 * 第二层：**数据库唯一约束 `Task @@unique([userId, idempotencyKey])`**
 *
 * 关键在于第二层不可绕过。内存缓存在多实例下会失效（请求打到不同实例），
 * 但数据库唯一约束是全局的。所以：
 * **正确性由数据库保证，缓存只做性能优化。**
 * 这一点如果搞反（比如只靠 Redis 判重），在多实例部署下就会出现重复计费。
 */

export interface IdempotentResult<T> {
  result: T;
  /** true = 命中已有结果，本次未产生新的 LLM 调用 */
  replayed: boolean;
}

/**
 * 在一个事务里执行「查重 → 创建」。
 *
 * 依赖数据库唯一索引做并发安全：如果两个请求同时通过查询，
 * 只有一个能成功插入，另一个会撞 P2002，我们捕获后回查已存在的记录。
 * 这种「先查再插」在有唯一约束的前提下是安全的 —— 约束保证了最终一致。
 */
export async function idempotentTask<T>(
  userId: string,
  idempotencyKey: string,
  create: () => Promise<T>,
  findExisting: (key: string) => Promise<T | null>,
): Promise<IdempotentResult<T>> {
  // 快路径：已存在则直接返回，完全不碰 LLM
  const existing = await findExisting(idempotencyKey).catch(() => null);
  if (existing) {
    return { result: existing, replayed: true };
  }

  try {
    const created = await create();
    return { result: created, replayed: false };
  } catch (e) {
    // 并发场景：另一个请求刚插入了同一条
    if (isUniqueViolation(e)) {
      const raced = await findExisting(idempotencyKey);
      if (raced) return { result: raced, replayed: true };
    }
    throw e;
  }
}

/** 生成幂等键。客户端负责，格式不限但建议 UUID */
export function normalizeIdempotencyKey(header: string | null): string {
  if (!header) return crypto.randomUUID();
  // 长度上限，防止超长 key 撑爆索引；限制字符集防注入
  return header.slice(0, 64).replace(/[^A-Za-z0-9._:-]/g, '');
}

export function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: string }).code === 'P2002'
  );
}

/**
 * 用户级并发保护：同一用户同时只允许 N 个进行中的任务。
 *
 * 与限流不同，限流防的是「请求太频繁」，并发限制防的是「同时烧太多钱」。
 * 一个用户开着 5 个标签页各跑一个长文任务，成本就是 5 倍 ——
 * 单看每个请求的限流都不超，但总成本在失控边缘。
 */
export async function assertConcurrencyWithinLimit(
  userId: string,
  limit: number,
): Promise<{ ok: boolean; active: number }> {
  const active = await prisma.task.count({
    where: {
      userId,
      status: { in: ['queued', 'running'] },
      deletedAt: null,
      createdAt: { gte: new Date(Date.now() - 10 * 60_000) }, // 只看近10 分钟
    },
  });

  return { ok: active < limit, active };
}

/**
 * 用户日配额检查。
 *
 * 查的是 Task 数而不是 Token 数：Token 数需要聚合查询，成本高；
 * 而配额本来就是按「次数」设计的（用户能理解「每天 20 次」，
 * 不能理解「每天 20000 tokens」）。这与用户的心理模型一致。
 */
export async function checkDailyQuota(userId: string, quota: number): Promise<{
  ok: boolean;
  used: number;
  remaining: number;
}> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const used = await prisma.task.count({
    where: { userId, createdAt: { gte: startOfDay }, deletedAt: null },
  });

  return { ok: used < quota, used, remaining: Math.max(0, quota - used) };
}

export type { Prisma };
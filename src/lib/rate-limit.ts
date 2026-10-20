import { env } from '@/lib/env';

/**
 * 限流。
 *
 * ## 为什么本项目用内存实现而不是 Upstash Redis
 *
 * 看起来像偷懒，其实是刻意的：
 *  - Redis 方案在多实例下才有意义，而本项目 Serverless 多实例，内存计数实际是「每实例限流」
 *  - 引入 Redis 会带来额外成本、额外故障点、额外一个必须维护的服务
 *  - **限流的第一目标是「防意外刷爆」，不是「精确限速」**
 *    内存限流已经能挡住爬虫式高频请求（单实例足够）
 *  - 真正的成本保护不靠限流，靠幂等 + 每日配额 + 并发上限（三者都是 DB 层面，全局有效）
 *
 * 要升级为全局限流时，替换的就是这个文件 —— 这正是抽象它的理由。
 *
 * ⚠️ Serverless 限制：实例可能被冻结回收，计数随之丢失（失效方向是「放行」，
 * 属于 fail-open）。这在安全上是可接受的折中，但不能声称它是严格限流。
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const globalForLimit = globalThis as unknown as { buckets?: Map<string, Bucket> };

function buckets(): Map<string, Bucket> {
  if (!globalForLimit.buckets) globalForLimit.buckets = new Map();
  return globalForLimit.buckets;
}

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** 建议的重试等待秒数 */
  retryAfterSec: number;
}

/** 固定窗口计数。实现简单、内存占用小，精度上的不足可接受 */
export function rateLimit(key: string, limit: number, windowSec: number): RateLimitResult {
  const now = Date.now();
  const map = buckets();
  const existing = map.get(key);

  if (!existing || existing.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return { ok: true, limit, remaining: limit - 1, retryAfterSec: 0 };
  }

  if (existing.count >= limit) {
    return {
      ok: false,
      limit,
      remaining: 0,
      retryAfterSec: Math.ceil((existing.resetAt - now) / 1000),
    };
  }

  existing.count += 1;
  return { ok: true, limit, remaining: limit - existing.count, retryAfterSec: 0 };
}

/** 每分钟请求上限（按 IP） */
export function rateLimitByIp(ip: string): RateLimitResult {
  const limit = env().RATE_LIMIT_PER_MINUTE;
  return rateLimit(`ip:${ip}`, limit, 60);
}

/** 按用户的高价值操作限流（创建任务）。比 IP 限流更严格 */
export function rateLimitByUser(userId: string, action: string): RateLimitResult {
  const limits: Record<string, number> = {
    'task:create': 20,
    'auth:login': 10,
    'auth:register': 5,
  };
  const limit = limits[action] ?? 10;
  const windowSec = action.startsWith('auth:') ? 300 : 60;
  return rateLimit(`user:${userId}:${action}`, limit, windowSec);
}

/** 按 IP 的注册/登录限流，防批量注册与密码喷洒 */
export function rateLimitAuthByIp(ip: string, action: 'register' | 'login'): RateLimitResult {
  const limit = action === 'register' ? 5 : 30;
  return rateLimit(`ipauth:${ip}:${action}`, limit, 300);
}

/** 清理过期桶，防止 Map 无限增长（Serverless 长驻实例下必须做） */
export function purgeBuckets(): number {
  const now = Date.now();
  let removed = 0;
  for (const [k, v] of buckets()) {
    if (v.resetAt <= now) {
      buckets().delete(k);
      removed += 1;
    }
  }
  return removed;
}

/** 从请求头取客户端 IP。注意 X-Forwarded-For 可被伪造，仅作限流用途 */
export function clientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return headers.get('x-real-ip') ?? 'unknown';
}
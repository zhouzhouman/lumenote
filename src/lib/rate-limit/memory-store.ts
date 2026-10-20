import type { RateLimitCount, RateLimitStore } from './types';

/**
 * 进程内存限流 Store。
 *
 * 适用场景（也是保留它的理由）：
 *  1. 本地开发 / 单实例部署：零依赖、零网络开销；
 *  2. Redis 故障时的 fail-open 降级目标（见 index.ts）：即使 Redis 挂了，
 *     限流也不会退化成「完全放行」，而是退化成「每实例限流」。
 *
 * ## 固定窗口
 *
 * 用最简单、最好解释的固定窗口：每个 key 一个 `{ count, resetAt }`。
 * 代价是窗口边界处最多可能放行 2 倍流量（前一个窗口末尾 + 新窗口开头），
 * 对于「防意外刷爆」这个目标可以接受；滑动窗口要存更多状态，而这里不值得。
 *
 * ## globalThis 挂载
 *
 * Next.js dev 模式会热重载模块，模块级变量会被重置 —— 那等于每次热更新
 * 都把限流计数清零，本地开发时很难察觉。挂到 globalThis 上可以跨 HMR 存活，
 * 与项目里其他进程级单例（熔断器、Prisma client）保持一致的写法。
 */
interface Bucket {
  count: number;
  resetAt: number;
}

/** 内存桶硬上限。超过就淘汰（淘汰方向是放行，见 evict 的说明） */
export const DEFAULT_MEMORY_MAX_KEYS = 10_000;

const globalForMemory = globalThis as unknown as {
  lumenoteRateLimitBuckets?: Map<string, Bucket>;
};

function sharedBuckets(): Map<string, Bucket> {
  if (!globalForMemory.lumenoteRateLimitBuckets) {
    globalForMemory.lumenoteRateLimitBuckets = new Map();
  }
  return globalForMemory.lumenoteRateLimitBuckets;
}

export interface MemoryStoreOptions {
  /** 注入时钟（测试窗口过期用，避免真实 sleep） */
  now?: () => number;
  /** 注入桶 Map（测试隔离用；默认用 globalThis 上的共享 Map） */
  buckets?: Map<string, Bucket>;
  /** 桶数量上限，默认 10000 */
  maxKeys?: number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  readonly kind = 'memory' as const;

  private readonly now: () => number;
  private readonly buckets: Map<string, Bucket>;
  private readonly maxKeys: number;

  constructor(options: MemoryStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.buckets = options.buckets ?? sharedBuckets();
    this.maxKeys = options.maxKeys ?? DEFAULT_MEMORY_MAX_KEYS;
  }

  /** 当前桶数量（测试/验证脚本观测用） */
  get size(): number {
    return this.buckets.size;
  }

  async increment(key: string, windowSec: number): Promise<RateLimitCount> {
    const now = this.now();

    // 先做容量保护，再做计数：保证 Map 不会无限增长
    if (this.buckets.size >= this.maxKeys) this.evict(now);

    const existing = this.buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      const ttlMs = Math.max(1, Math.round(windowSec * 1000));
      this.buckets.set(key, { count: 1, resetAt: now + ttlMs });
      return { count: 1, ttlMs };
    }

    existing.count += 1;
    return {
      count: existing.count,
      // resetAt 还没到，所以一定 > 0；Math.max 兜底时钟回拨等异常
      ttlMs: Math.max(1, existing.resetAt - now),
    };
  }

  async purge(): Promise<number> {
    const now = this.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // 内存实现没有连接可关
  }

  /** 清空全部桶（测试用） */
  clear(): void {
    this.buckets.clear();
  }

  /**
   * 过期清理 + 超限淘汰。
   *
   * 淘汰方向说明：被淘汰的桶 = 计数丢失 = 该 key 重新从 1 开始 = **放行**。
   * 也就是说内存上限保护是 fail-open 的。这是刻意的权衡：
   *  - 内存无限增长会拖垮整个进程（可用性问题，影响所有用户）；
   *  - 淘汰少量冷 key 只是让极少数请求暂时少算几次（安全性问题，影响可控）。
   * 生产多实例场景请切 Redis，内存上限只是单实例兜底。
   */
  private evict(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    if (this.buckets.size < this.maxKeys) return;

    // Map 的迭代顺序 = 插入顺序，所以这里淘汰的是「最早出现的 key」。
    // 简单、O(n) 但只在超限时触发，不引入 LRU 的数据结构成本。
    const overflow = this.buckets.size - this.maxKeys + 1;
    let removed = 0;
    for (const key of this.buckets.keys()) {
      if (removed >= overflow) break;
      this.buckets.delete(key);
      removed += 1;
    }
  }
}

/** 进程级共享的 memory store（Next dev HMR 下依然同一份桶） */
export function getSharedMemoryStore(): MemoryRateLimitStore {
  const globalForStore = globalThis as unknown as {
    lumenoteRateLimitMemoryStore?: MemoryRateLimitStore;
  };
  if (!globalForStore.lumenoteRateLimitMemoryStore) {
    globalForStore.lumenoteRateLimitMemoryStore = new MemoryRateLimitStore();
  }
  return globalForStore.lumenoteRateLimitMemoryStore;
}

/** 清空共享内存桶（测试/验证脚本用，生产不要调用） */
export function resetSharedMemoryStore(): void {
  sharedBuckets().clear();
}

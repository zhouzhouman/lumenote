/**
 * 限流 Store 抽象与共享类型。
 *
 * ## 为什么要抽 Store 接口
 *
 * 限流有两个场景，实现天差地别：
 *  - 单实例 / 本地开发：进程内存最快，零依赖；
 *  - 多实例 / Serverless：必须共享计数，否则 N 个实例 = N 倍限额。
 *
 * 调用方（API 路由）只关心 `{ ok, limit, remaining, retryAfterSec }`，
 * 不关心计数存在 Map 还是 Redis。把这一点固定成接口，切换后端时
 * 路由一行都不用改 —— 这也是「抽象」在这里唯一的正当理由。
 */

/**
 * 限流判定结果。
 *
 * ⚠️ 字段形状**刻意与旧版内存实现保持一致**，避免破坏调用方语义：
 * 路由只读 `ok / retryAfterSec`，健康检查/测试可能读 `remaining / limit`。
 */
export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** 建议的重试等待秒数。ok=false 时一定 > 0 */
  retryAfterSec: number;
}

/** 一次计数操作的原始结果（Store 层，还未映射成 RateLimitResult） */
export interface RateLimitCount {
  /** 当前固定窗口内的累计次数（本次请求已计入） */
  count: number;
  /** 当前窗口剩余毫秒数（用于换算 retryAfterSec） */
  ttlMs: number;
}

export type RateLimitDriver = 'memory' | 'redis';

/**
 * Redis 故障时的降级策略。
 *
 * - open：可用性优先，回退内存限流（默认）
 * - closed：安全优先，直接拒绝（调用方按 429 处理）
 */
export type RateLimitFailMode = 'open' | 'closed';

/**
 * 计数存储接口。
 *
 * 唯一的写操作必须是**原子**的 `increment`：固定窗口限流的正确性
 * 完全依赖「读当前计数 + 写回 +1 + 首次设置过期时间」不被打断。
 * 内存实现靠 JS 单线程天然原子；Redis 实现必须用 Lua 脚本（见 redis-store.ts）。
 */
export interface RateLimitStore {
  readonly kind: RateLimitDriver;
  /** 原子自增，返回窗口内计数与剩余 TTL */
  increment(key: string, windowSec: number): Promise<RateLimitCount>;
  /**
   * 主动清理过期项，返回清理条数。
   * memory 实现真的清；redis 实现返回 0（过期由 Redis TTL 负责）。
   */
  purge(): Promise<number>;
  /** 健康探测：Redis 实现在连接失败时返回 false 而不是抛错 */
  ping(): Promise<boolean>;
  /** 释放连接（测试断开 / 验证脚本退出） */
  close(): Promise<void>;
}

/** 从环境变量解析出的运行时配置（启动后不变） */
export interface RateLimitRuntimeSettings {
  driver: RateLimitDriver;
  failMode: RateLimitFailMode;
  redisUrl: string;
  redisPrefix: string;
  trustProxyHops: number;
}

/**
 * 单次限流调用的可选覆盖。
 *
 * 生产代码不传这些参数（用 env 配置）；测试/验证脚本用它注入
 * fake store 与降级策略，避免依赖真实 Redis，也避免改 process.env
 * （env() 在进程内是缓存的，改 process.env 不一定生效）。
 */
export interface RateLimitCallOptions {
  /** 覆盖主 store（依赖注入，测试用） */
  store?: RateLimitStore;
  /** 覆盖 fail-open 时的降级 store（默认进程内存） */
  fallbackStore?: RateLimitStore;
  /** 覆盖降级策略 */
  failMode?: RateLimitFailMode;
}

import { env } from '@/lib/env';
import { getSharedMemoryStore, MemoryRateLimitStore, resetSharedMemoryStore } from './memory-store';
import { RedisRateLimitStore, type RedisStoreOptions } from './redis-store';
import type {
  RateLimitCallOptions,
  RateLimitCount,
  RateLimitDriver,
  RateLimitFailMode,
  RateLimitResult,
  RateLimitRuntimeSettings,
  RateLimitStore,
} from './types';

/**
 * 限流的公开入口。
 *
 * ## 设计目标（和旧实现相比变在哪）
 *
 * 旧实现是「进程内存 Map + 同步函数」，只能做**每实例限流**。
 * 现在把计数后端抽象成 `RateLimitStore`：
 *  - `memory`：默认。本地开发、单实例、以及 **Redis 故障时的降级目标**；
 *  - `redis` ：多实例/Serverless 共享计数（`RATE_LIMIT_DRIVER=redis`）。
 *
 * 对外函数名与结果形状保持不变（`rateLimit` / `rateLimitByIp` / `rateLimitByUser` /
 * `rateLimitAuthByIp` / `purgeBuckets` / `clientIp`），但因为 store 是异步的，
 * 判定函数变成了 `Promise<RateLimitResult>` —— 全部调用点已同步改成 `await`。
 *
 * ## key 命名空间
 *
 * 逻辑 key（内存实现直接用，Redis 实现再拼 `RATE_LIMIT_REDIS_PREFIX`）：
 *
 *   ip:<ip>                  每 IP 请求频率，窗口 60s（RATE_LIMIT_PER_MINUTE）
 *   ipauth:<ip>:<action>     注册/登录按 IP 限流，窗口 300s（register 5 / login 30）
 *   user:<id>:<action>       按用户的操作限流；auth:* 窗口 300s，其余 60s
 *
 * 完整的 Redis key 形如：`lumenote:rl:ip:1.2.3.4`、`lumenote:rl:user:u_123:task:create`、
 * `lumenote:rl:ipauth:1.2.3.4:register`。前缀可由 RATE_LIMIT_REDIS_PREFIX 覆盖，
 * 多环境共用同一个 Redis 时必须改，否则计数互相污染。
 *
 * ## 故障降级（RATE_LIMIT_FAIL_MODE）
 *
 * 限流在**每个请求的关键路径**上，所以 Redis 出问题时绝不能让异常冒到业务层
 * （那会把「限流组件故障」放大成「全站 500」）：
 *  - `open`（默认）：回退到进程内存限流，记录 warn。可用性优先；
 *    代价是故障期间失去跨实例一致性（退化为每实例限流，仍强于完全放行）。
 *  - `closed`：返回 `ok:false`（调用方按 429 处理）。安全优先、可用性让位。
 *    这是**有意的严格模式**，不是 bug。
 *
 * 两种模式都不抛异常。降级 warn 做了节流（默认 30s 一次），避免 Redis 挂掉时
 * 日志被刷爆 —— 日志洪水本身会拖慢服务。
 *
 * ⚠️ **熔断器（src/lib/llm/breaker.ts）仍然是进程内存实现，本任务不做分布式熔断。**
 * 限流计数可以共享，但 LLM 熔断状态在多实例下依旧各算各的；多实例故障时
 * 每个实例都要各自撞几次失败才会打开熔断。
 */

const globalForRateLimit = globalThis as unknown as {
  lumenoteRateLimitRedis?: RedisRateLimitStore;
  lumenoteRateLimitFallbackWarnAt?: number;
};

/** 降级 warn 的节流间隔 */
const FALLBACK_WARN_INTERVAL_MS = 30_000;

/** 从 env 解析限流运行时配置（启动后固定；env() 自带缓存） */
export function rateLimitSettings(): RateLimitRuntimeSettings {
  const e = env();
  return {
    driver: e.RATE_LIMIT_DRIVER,
    failMode: e.RATE_LIMIT_FAIL_MODE,
    redisUrl: e.REDIS_URL,
    redisPrefix: e.RATE_LIMIT_REDIS_PREFIX,
    trustProxyHops: e.TRUST_PROXY_HOPS,
  };
}

/**
 * 按 driver 创建 store。
 *
 * 显式传参而不是内部直接读 env，是为了让「driver 选择」这段逻辑可被测试：
 * 本机/CI 没有 Redis，测试通过 `createRateLimitStore('redis', { redis: { client } })`
 * 注入 fake client，覆盖连接失败与降级路径。
 */
export function createRateLimitStore(
  driver: RateLimitDriver,
  dependencies: { redis?: RedisStoreOptions; memory?: ConstructorParameters<typeof MemoryRateLimitStore>[0] } = {},
): RateLimitStore {
  if (driver === 'redis') return new RedisRateLimitStore(dependencies.redis);
  return new MemoryRateLimitStore(dependencies.memory);
}

/** 进程级 Redis store 单例（Next dev HMR / Serverless 实例内复用连接） */
function redisStoreSingleton(settings: RateLimitRuntimeSettings): RedisRateLimitStore {
  if (!globalForRateLimit.lumenoteRateLimitRedis) {
    globalForRateLimit.lumenoteRateLimitRedis = new RedisRateLimitStore({
      url: settings.redisUrl,
      prefix: settings.redisPrefix,
    });
  }
  return globalForRateLimit.lumenoteRateLimitRedis;
}

function primaryStore(settings: RateLimitRuntimeSettings): RateLimitStore {
  if (settings.driver === 'redis') return redisStoreSingleton(settings);
  return getSharedMemoryStore();
}

/**
 * 降级 warn（节流）。
 *
 * 注意日志里只放错误消息，不放 key 里的 IP/用户标识 ——
 * 限流日志不该变成另一个隐私泄露点。
 */
function warnFallback(label: string, error: unknown): void {
  const now = Date.now();
  const last = globalForRateLimit.lumenoteRateLimitFallbackWarnAt ?? 0;
  if (now - last < FALLBACK_WARN_INTERVAL_MS) return;
  globalForRateLimit.lumenoteRateLimitFallbackWarnAt = now;

  const reason = error instanceof Error ? error.message : String(error);
  console.warn(
    `[rate-limit] 主限流后端不可用（${label}），已按 RATE_LIMIT_FAIL_MODE=open ` +
      `降级为进程内存限流。原因：${reason}`,
  );
}

/** 把计数映射成调用方熟悉的 RateLimitResult（形状与旧实现一致） */
function toResult(counted: RateLimitCount, limit: number): RateLimitResult {
  if (counted.count > limit) {
    return {
      ok: false,
      limit,
      remaining: 0,
      // TTL 一定 > 0（脚本/内存实现保证），ceil 后至少 1 秒
      retryAfterSec: Math.max(1, Math.ceil(counted.ttlMs / 1000)),
    };
  }

  return {
    ok: true,
    limit,
    remaining: Math.max(0, limit - counted.count),
    retryAfterSec: 0,
  };
}

/**
 * 通用限流：key 由调用方拼好，窗口与上限显式传入。
 *
 * @param key 逻辑 key（见文件头的命名空间说明）
 * @param limit 窗口内允许的次数上限
 * @param windowSec 固定窗口长度（秒）
 * @param options 测试/高级用法：注入 store 或覆盖 fail mode
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number,
  options: RateLimitCallOptions = {},
): Promise<RateLimitResult> {
  const settings = rateLimitSettings();
  const failMode: RateLimitFailMode = options.failMode ?? settings.failMode;

  let store = options.store;
  let counted: RateLimitCount | null = null;

  try {
    // Redis 客户端构造失败（如 REDIS_URL 非法）也走降级，不能冒到业务层
    if (!store) store = primaryStore(settings);
    counted = await store.increment(key, windowSec);
  } catch (error) {
    if (failMode === 'closed') {
      /**
       * 严格模式：限流器不可用 = 无法判断是否超限 = 拒绝。
       * 用 ok:false 而不是抛异常，调用方行为与「真的超限」一致（429）。
       */
      return {
        ok: false,
        limit,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil(windowSec)),
      };
    }

    warnFallback(store?.kind ?? settings.driver, error);

    // fail-open：本次请求回退到进程内存。计数仍然生效（每实例），不是完全放行。
    const fallback = options.fallbackStore ?? getSharedMemoryStore();
    try {
      counted = await fallback.increment(key, windowSec);
    } catch {
      // 连内存计数都失败（理论上不会发生）：保持可用性，放行本次请求。
      // 这里必须返回而不是抛出 —— 限流故障不能升级成业务故障。
      return { ok: true, limit, remaining: Math.max(0, limit - 1), retryAfterSec: 0 };
    }
  }

  if (!counted) return { ok: true, limit, remaining: Math.max(0, limit - 1), retryAfterSec: 0 };
  return toResult(counted, limit);
}

/** 每分钟请求上限（按 IP）。key: `ip:<ip>`，窗口 60s */
export async function rateLimitByIp(
  ip: string,
  options: RateLimitCallOptions = {},
): Promise<RateLimitResult> {
  const limit = env().RATE_LIMIT_PER_MINUTE;
  return rateLimit(`ip:${ip}`, limit, 60, options);
}

/** 按用户的高价值操作限流（创建任务/Agent、登录）。key: `user:<id>:<action>` */
export async function rateLimitByUser(
  userId: string,
  action: string,
  options: RateLimitCallOptions = {},
): Promise<RateLimitResult> {
  const limits: Record<string, number> = {
    'task:create': 20,
    'auth:login': 10,
    'auth:register': 5,
  };
  const limit = limits[action] ?? 10;
  const windowSec = action.startsWith('auth:') ? 300 : 60;
  return rateLimit(`user:${userId}:${action}`, limit, windowSec, options);
}

/** 按 IP 的注册/登录限流，防批量注册与密码喷洒。key: `ipauth:<ip>:<action>` */
export async function rateLimitAuthByIp(
  ip: string,
  action: 'register' | 'login',
  options: RateLimitCallOptions = {},
): Promise<RateLimitResult> {
  const limit = action === 'register' ? 5 : 30;
  return rateLimit(`ipauth:${ip}:${action}`, limit, 300, options);
}

/**
 * 清理过期桶，防止内存 Map 无限增长。
 *
 * 只对进程内存实现有意义：Redis 侧由 TTL 自动过期（Redis store 的 purge 返回 0）。
 * 在 Redis driver 下也建议定期调用，因为 fail-open 降级会用到内存 store。
 */
export async function purgeBuckets(options: { store?: RateLimitStore } = {}): Promise<number> {
  const store = options.store ?? getSharedMemoryStore();
  try {
    return await store.purge();
  } catch {
    return 0;
  }
}

/**
 * 重置限流运行时状态（测试/验证脚本专用，生产不要调用）。
 *
 * 会清空共享内存桶、断开 Redis 单例、重置 warn 节流。
 * 存在的理由：单测必须在每个用例前拿到干净状态，否则 globalThis 上的桶
 * 会跨用例污染（一个用例把 IP 打到超限，下一个用例就莫名 429）。
 */
export async function resetRateLimitRuntime(): Promise<void> {
  globalForRateLimit.lumenoteRateLimitFallbackWarnAt = 0;
  resetSharedMemoryStore();

  const redis = globalForRateLimit.lumenoteRateLimitRedis;
  globalForRateLimit.lumenoteRateLimitRedis = undefined;
  if (redis) await redis.close();
}

// 统一从子模块 re-export：调用方既可以 import 公开函数，也能拿到 store 类做测试
export { MemoryRateLimitStore, getSharedMemoryStore } from './memory-store';
export { RedisRateLimitStore, RATE_LIMIT_LUA_SCRIPT, type RedisRateLimitClient } from './redis-store';
export { clientIp, resolveClientIp, normalizeIp, UNKNOWN_CLIENT_IP } from './client-ip';
export type { ClientIpOptions } from './client-ip';
export type {
  RateLimitCallOptions,
  RateLimitCount,
  RateLimitDriver,
  RateLimitFailMode,
  RateLimitResult,
  RateLimitRuntimeSettings,
  RateLimitStore,
} from './types';

import Redis from 'ioredis';
import type { RateLimitCount, RateLimitStore } from './types';

/**
 * Redis 限流 Store（ioredis）。
 *
 * ## 为什么是 Lua 脚本，而不是 GET → +1 → SET
 *
 * 固定窗口限流需要「读取当前计数、加一、写回、首次设置 TTL」四个动作。
 * 如果用多条命令拼起来，并发请求会交错执行：
 *
 *   A: GET k -> 5     B: GET k -> 5
 *   A: SET k 6        B: SET k 6      ← 两次请求只计了一次，限流被稀释
 *
 * 更糟的是「INCR 成功但 PEXPIRE 没执行」：key 变成永不过期，
 * 该 IP/用户会被**永久封禁**，只能人工删 key。
 *
 * Redis 执行 Lua 脚本时是**单线程、不可中断**的：脚本内部的所有命令
 * 作为一个整体原子执行，期间不会插入其他客户端的命令。所以
 * `INCR` + 首次 `PEXPIRE` + `PTTL` 在一个脚本里就能得到一致的结果。
 *
 * 注意：Redis 的单线程指的是「命令执行」单线程，网络 I/O 是多路复用的。
 * 原子性来自「脚本执行期间不处理其他命令」，而不是「整个 Redis 只有一个线程」
 * 这种更宽泛（且不准确）的说法。
 *
 * ## 连接参数为什么这么严
 *
 * 限流处在**每个请求的关键路径**上。如果 Redis 挂掉时命令无限重试/排队，
 * 整个站点会跟着挂 —— 限流组件把业务拖死是最典型的次生故障。
 * 因此：
 *  - `lazyConnect`：进程启动不连，第一次限流才连（build/test 不碰网络）
 *  - `connectTimeout`：连接阶段有上限
 *  - `maxRetriesPerRequest: 1`：单条命令最多重试 1 次就失败
 *  - `enableOfflineQueue: false`：断线期间不把命令塞进队列无限等待
 *  - `retryStrategy`：重连次数有上限，之后进入失败状态（由 fail mode 接管）
 *
 * ⚠️ **熔断器仍然是进程内存实现（src/lib/llm/breaker.ts），本任务不实现分布式熔断。**
 * 本文件只负责限流计数的共享；LLM 熔断状态在多实例下依旧各自独立。
 */

/**
 * 最小 Redis 客户端接口。
 *
 * 用接口而不是直接依赖 `Redis` 类型，是为了测试能注入 fake client
 * （本机/CI 没有 Redis 服务，绝不能要求测试连接真实 Redis）。
 */
export interface RedisRateLimitClient {
  status?: string;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  ping(): Promise<string>;
  connect?(): Promise<void>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

/**
 * 原子计数脚本。
 *
 * KEYS[1] = 计数 key（已带前缀）
 * ARGV[1] = 窗口长度（毫秒）
 * 返回   = { 当前计数, 剩余 TTL(ms) }
 *
 * `current == 1` 时才设置 TTL：后续 INCR 不会重置窗口，
 * 否则每次请求都续期，窗口永远不过期（= 永久封禁）。
 */
export const RATE_LIMIT_LUA_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`.trim();

export const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
export const DEFAULT_REDIS_PREFIX = 'lumenote:rl:';
const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 1_500;
const MAX_RECONNECT_ATTEMPTS = 3;

export interface RedisStoreOptions {
  /** 连接串；不传用默认值（真实调用时应由 env 传入） */
  url?: string;
  /** key 前缀；不传用 `lumenote:rl:` */
  prefix?: string;
  /** 注入客户端（测试/验证脚本用） */
  client?: RedisRateLimitClient;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

function normalizePrefix(prefix: string): string {
  // 容忍误配成 `lumenote:rl`（少冒号）与重复冒号
  if (!prefix) return DEFAULT_REDIS_PREFIX;
  return prefix.endsWith(':') ? prefix : `${prefix}:`;
}

/** 给 Promise 加超时，避免任何一次连接/命令把请求无限挂起 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[rate-limit] Redis ${label} 超时（${timeoutMs}ms）`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function createRedisClient(url: string, connectTimeoutMs: number): RedisRateLimitClient {
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: connectTimeoutMs,
    enableReadyCheck: true,
    retryStrategy: (times) =>
      times > MAX_RECONNECT_ATTEMPTS ? null : Math.min(times * 200, 1_000),
  }) as unknown as RedisRateLimitClient;
}

export class RedisRateLimitStore implements RateLimitStore {
  readonly kind = 'redis' as const;

  private readonly client: RedisRateLimitClient;
  private readonly prefix: string;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private connectPromise: Promise<void> | null = null;

  constructor(options: RedisStoreOptions = {}) {
    this.prefix = normalizePrefix(options.prefix ?? DEFAULT_REDIS_PREFIX);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.client = options.client ?? createRedisClient(options.url ?? DEFAULT_REDIS_URL, this.connectTimeoutMs);
  }

  /** Redis 实际使用的 key（带命名空间前缀），暴露出来便于测试/排查 */
  keyFor(key: string): string {
    return `${this.prefix}${key}`;
  }

  async increment(key: string, windowSec: number): Promise<RateLimitCount> {
    await this.ensureConnected();

    const ttlMs = Math.max(1, Math.round(windowSec * 1000));
    const raw = await withTimeout(
      this.client.eval(RATE_LIMIT_LUA_SCRIPT, 1, this.keyFor(key), ttlMs),
      this.commandTimeoutMs,
      'EVAL',
    );

    const reply = Array.isArray(raw) ? raw : [];
    const count = Number(reply[0]);
    const reportedTtl = Number(reply[1]);

    if (!Number.isFinite(count) || count < 1) {
      throw new Error(`[rate-limit] Redis EVAL 返回了无法解析的计数：${JSON.stringify(raw)}`);
    }

    return {
      count,
      // PTTL 返回 -1（无过期）/ -2（key 不存在）时，用窗口长度兜底。
      // 理论上脚本保证 key 一定有 TTL，兜底是防御「人工改过 key」这类异常。
      ttlMs: Number.isFinite(reportedTtl) && reportedTtl > 0 ? reportedTtl : ttlMs,
    };
  }

  async purge(): Promise<number> {
    // Redis 侧靠 TTL 自动过期，没有需要手动扫描清理的桶。
    // 返回 0 而不是假装清理了 N 条，避免调用方误以为这里做了 GC。
    return 0;
  }

  async ping(): Promise<boolean> {
    try {
      await this.ensureConnected();
      const pong = await withTimeout(this.client.ping(), this.connectTimeoutMs, 'PING');
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    try {
      // 先 quit（等已发出的命令返回），失败再强制断开
      if (client.quit) await client.quit();
    } catch {
      // ignore：关闭失败不影响进程退出
    } finally {
      client.disconnect?.();
    }
  }

  /** 状态观测（验证脚本/测试用） */
  get status(): string | undefined {
    return this.client.status;
  }

  /**
   * 确保连接就绪。
   *
   * 并发首次请求共享同一个 connect promise，避免每个请求都尝试建连
   * （也避免「第二个请求在 connecting 阶段就失败」的抖动）。
   */
  private async ensureConnected(): Promise<void> {
    if (this.client.status === 'ready') return;

    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        const status = this.client.status;
        if (status === 'wait' || status === 'end' || status === 'close') {
          if (!this.client.connect) {
            throw new Error(`[rate-limit] Redis 客户端不可用（status=${status}）`);
          }
          await withTimeout(this.client.connect(), this.connectTimeoutMs, 'CONNECT');
          return;
        }

        // connecting / reconnecting / connect：不能再调用 connect()，
        // 用一次带超时的 PING 等它就绪。失败就交给 fail mode。
        const pong = await withTimeout(this.client.ping(), this.connectTimeoutMs, 'PING');
        if (pong !== 'PONG') {
          throw new Error(`[rate-limit] Redis 尚未就绪（status=${status}）`);
        }
      })().finally(() => {
        this.connectPromise = null;
      });
    }

    await this.connectPromise;
  }
}

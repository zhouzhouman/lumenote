import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimitStore, rateLimit, rateLimitByIp, resetRateLimitRuntime } from '@/lib/rate-limit';
import { MemoryRateLimitStore } from '@/lib/rate-limit/memory-store';
import {
  RATE_LIMIT_LUA_SCRIPT,
  RedisRateLimitStore,
  type RedisRateLimitClient,
} from '@/lib/rate-limit/redis-store';

/**
 * Redis 限流 Store 的单测。
 *
 * ## 为什么不连真实 Redis
 *
 * 本机/CI 都没有 Redis 服务（也刻意不引入 docker 依赖），
 * 而「Redis 不可用时的降级路径」恰恰是本任务最需要被证明的部分。
 * 所以这里用一个**进程内 fake client**：
 *  - 它按 ioredis 的 eval 协议模拟 INCR + PEXPIRE + PTTL 的语义
 *  - 可以随时切成「连接失败 / eval 抛错 / PTTL 异常」等故障形态
 *
 * 真实 Redis 的连接与原子性验证由 `scripts/verify/rate-limit-redis.mjs` 负责，
 * 那种验证必须真的连上 Redis 才有意义，绝不在这里伪装。
 */

interface FakeRedisOptions {
  now?: () => number;
  status?: string;
  /** eval 时抛出的错误（模拟 Redis 故障） */
  failEval?: Error;
  /** connect 时抛出的错误（模拟连接失败） */
  failConnect?: Error;
  /** ping 时抛出的错误 */
  failPing?: Error;
  /** 覆盖 PTTL 返回值（模拟 TTL 异常，如 -1 表示无过期） */
  pttlOverride?: number;
}

interface FakeRedis {
  client: RedisRateLimitClient;
  /** 每次 eval 的入参快照，用来断言 key 前缀与 Lua 原子脚本 */
  evals: { script: string; key: string; ttlMs: number }[];
  data: Map<string, { count: number; expiresAt: number }>;
  quitCalled: boolean;
  disconnectCalled: boolean;
}

function createFakeRedis(options: FakeRedisOptions = {}): FakeRedis {
  const now = options.now ?? Date.now;
  const data = new Map<string, { count: number; expiresAt: number }>();
  const evals: FakeRedis['evals'] = [];
  let quitCalled = false;
  let disconnectCalled = false;

  const client: RedisRateLimitClient = {
    status: options.status ?? 'ready',

    async eval(script, _numKeys, ...args) {
      const key = String(args[0]);
      const ttlMs = Number(args[1]);
      evals.push({ script, key, ttlMs });

      if (options.failEval) throw options.failEval;

      const nowMs = now();
      const existing = data.get(key);

      if (!existing || existing.expiresAt <= nowMs) {
        // 模拟 Lua 的 current == 1 分支：首次写入并设置 TTL
        data.set(key, { count: 1, expiresAt: nowMs + ttlMs });
        return [1, options.pttlOverride ?? ttlMs];
      }

      existing.count += 1;
      return [existing.count, options.pttlOverride ?? existing.expiresAt - nowMs];
    },

    async ping() {
      if (options.failPing) throw options.failPing;
      return 'PONG';
    },

    async connect() {
      if (options.failConnect) throw options.failConnect;
    },

    async quit() {
      quitCalled = true;
      return 'OK';
    },

    disconnect() {
      disconnectCalled = true;
    },
  };

  return {
    client,
    evals,
    data,
    get quitCalled() {
      return quitCalled;
    },
    get disconnectCalled() {
      return disconnectCalled;
    },
  } as FakeRedis;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetRateLimitRuntime();
});

describe('Redis Store：key 命名空间与 Lua 原子脚本', () => {
  it('key 带默认前缀，且 Lua 脚本包含 INCR + PEXPIRE（不是 GET/SET）', async () => {
    const fake = createFakeRedis();
    const store = new RedisRateLimitStore({ client: fake.client });

    const counted = await store.increment('ip:1.2.3.4', 60);

    expect(counted).toEqual({ count: 1, ttlMs: 60_000 });
    expect(fake.evals).toHaveLength(1);
    expect(fake.evals[0]!.key).toBe('lumenote:rl:ip:1.2.3.4');
    // 脚本里 INCR 与 PEXPIRE 在同一个原子脚本内：不会出现「INCR 成功但没设 TTL」
    expect(fake.evals[0]!.script).toContain("redis.call('INCR'");
    expect(fake.evals[0]!.script).toContain("redis.call('PEXPIRE'");
    // 不用先 GET 再 SET 的非原子写法
    expect(fake.evals[0]!.script).not.toContain("redis.call('GET'");
    expect(fake.evals[0]!.script).not.toContain("redis.call('SET'");
    // 一次计数只发一次 EVAL（原子性来自脚本本身，而不是客户端拼命令）
    expect(fake.evals).toHaveLength(1);
    expect(RATE_LIMIT_LUA_SCRIPT).toContain('PTTL');
  });

  it('自定义前缀会被规范化（补冒号），不会拼出双冒号', async () => {
    const fake = createFakeRedis();
    const store = new RedisRateLimitStore({ client: fake.client, prefix: 'staging:rl' });

    await store.increment('user:u_1:task:create', 60);
    expect(store.keyFor('ip:x')).toBe('staging:rl:ip:x');
    expect(fake.evals[0]!.key).toBe('staging:rl:user:u_1:task:create');
  });
});

describe('Redis Store：固定窗口与 TTL', () => {
  it('窗口内累加、超限由调用层判定、过期后重新计数', async () => {
    let nowMs = 1_000_000;
    const fake = createFakeRedis({ now: () => nowMs });
    const store = new RedisRateLimitStore({ client: fake.client });

    // limit=2
    expect((await rateLimit('ip:redis-win', 2, 60, { store })).ok).toBe(true);
    expect((await rateLimit('ip:redis-win', 2, 60, { store })).ok).toBe(true);
    const blocked = await rateLimit('ip:redis-win', 2, 60, { store });
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBe(60);

    // 30 秒后仍在同一窗口：retryAfterSec 应由 PTTL 换算（30s 而不是 60s）
    nowMs += 30_000;
    const halfway = await rateLimit('ip:redis-win', 2, 60, { store });
    expect(halfway.ok).toBe(false);
    expect(halfway.retryAfterSec).toBe(30);

    // 跨过窗口：TTL 过期，重新从 1 开始
    nowMs += 30_000;
    const resumed = await rateLimit('ip:redis-win', 2, 60, { store });
    expect(resumed.ok).toBe(true);
    expect(resumed.remaining).toBe(1);
  });

  it('PTTL 返回 -1（无过期）时用窗口长度兜底，retryAfterSec 不会变成 0', async () => {
    const fake = createFakeRedis({ pttlOverride: -1 });
    const store = new RedisRateLimitStore({ client: fake.client });

    expect((await rateLimit('ip:no-ttl', 1, 45, { store })).ok).toBe(true);
    const blocked = await rateLimit('ip:no-ttl', 1, 45, { store });
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBe(45);
  });

  it('purge 对 Redis 返回 0（过期由 TTL 负责，不伪装成手动 GC）', async () => {
    const fake = createFakeRedis();
    const store = new RedisRateLimitStore({ client: fake.client });
    expect(await store.purge()).toBe(0);
  });
});

describe('Redis 故障降级：fail-open（默认）', () => {
  it('eval 抛错时回退 memory store，业务不中断且记录 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = createFakeRedis({ failEval: new Error('READONLY Redis 主从切换中') });
    const redisStore = new RedisRateLimitStore({ client: fake.client });
    const memoryStore = new MemoryRateLimitStore({ buckets: new Map() });

    const first = await rateLimit('ip:fallback', 3, 60, {
      store: redisStore,
      fallbackStore: memoryStore,
      failMode: 'open',
    });
    expect(first).toEqual({ ok: true, limit: 3, remaining: 2, retryAfterSec: 0 });

    // 第二次仍然走降级路径，且 memory 计数在累加（不是每次都放行）
    const second = await rateLimit('ip:fallback', 3, 60, {
      store: redisStore,
      fallbackStore: memoryStore,
      failMode: 'open',
    });
    expect(second).toEqual({ ok: true, limit: 3, remaining: 1, retryAfterSec: 0 });
    expect(memoryStore.size).toBe(1);

    expect(warn).toHaveBeenCalled();
    const message = String(warn.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('降级');
  });

  it('连接失败（connect 抛错）时同样按 fail-open 放行', async () => {
    const fake = createFakeRedis({
      status: 'wait',
      failConnect: new Error('connect ECONNREFUSED 127.0.0.1:6379'),
    });
    const store = new RedisRateLimitStore({ client: fake.client });

    // store 层必须把错误暴露出来，由调用层决定降级（而不是自己吞掉）
    await expect(store.increment('ip:down', 60)).rejects.toThrow(/ECONNREFUSED/);

    const result = await rateLimit('ip:down', 2, 60, {
      store,
      fallbackStore: new MemoryRateLimitStore({ buckets: new Map() }),
      failMode: 'open',
    });
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(1);
  });
});

describe('Redis 故障降级：fail-closed（严格模式）', () => {
  it('eval 抛错时返回 ok:false（429 语义），且不污染 fallback store', async () => {
    const fake = createFakeRedis({ failEval: new Error('Redis timeout') });
    const redisStore = new RedisRateLimitStore({ client: fake.client });
    const memoryStore = new MemoryRateLimitStore({ buckets: new Map() });

    const result = await rateLimit('ip:closed', 5, 60, {
      store: redisStore,
      fallbackStore: memoryStore,
      failMode: 'closed',
    });

    expect(result).toEqual({ ok: false, limit: 5, remaining: 0, retryAfterSec: 60 });
    // 严格模式下不能悄悄用内存继续计数
    expect(memoryStore.size).toBe(0);
  });

  it('连接失败时同样拒绝（可用性让位于安全）', async () => {
    const fake = createFakeRedis({
      status: 'wait',
      failConnect: new Error('ECONNREFUSED'),
    });
    const store = new RedisRateLimitStore({ client: fake.client });

    const result = await rateLimit('ip:closed-conn', 2, 30, {
      store,
      failMode: 'closed',
    });
    expect(result.ok).toBe(false);
    expect(result.retryAfterSec).toBe(30);
  });
});

describe('driver 选择与连接生命周期', () => {
  it('createRateLimitStore 按 driver 返回对应实现', async () => {
    const fake = createFakeRedis();
    const redisStore = createRateLimitStore('redis', {
      redis: { client: fake.client, prefix: 'p:' },
    });
    const memoryStore = createRateLimitStore('memory');

    expect(redisStore.kind).toBe('redis');
    expect(memoryStore.kind).toBe('memory');

    // RATE_LIMIT_DRIVER=redis 但 Redis 不可用：由 fail mode 决定（这里 fake 正常，验证走了 redis 路径）
    const result = await rateLimit('ip:driver', 2, 60, { store: redisStore });
    expect(result.ok).toBe(true);
    expect(fake.evals[0]!.key).toBe('p:ip:driver');
  });

  it('close 会先 quit 再 disconnect，ping 失败返回 false 而不是抛错', async () => {
    const fake = createFakeRedis({ failPing: new Error('redis down') });
    const store = new RedisRateLimitStore({ client: fake.client });

    expect(await store.ping()).toBe(false);

    await store.close();
    expect(fake.quitCalled).toBe(true);
    expect(fake.disconnectCalled).toBe(true);
  });

  it('rateLimitByIp 使用 Redis store 时 key 带命名空间', async () => {
    const fake = createFakeRedis();
    const store = new RedisRateLimitStore({ client: fake.client });
    await rateLimitByIp('8.8.8.8', { store });
    expect(fake.evals[0]!.key).toBe('lumenote:rl:ip:8.8.8.8');
  });
});

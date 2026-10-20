import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import {
  purgeBuckets,
  rateLimit,
  rateLimitAuthByIp,
  rateLimitByIp,
  rateLimitByUser,
  rateLimitSettings,
  resetRateLimitRuntime,
} from '@/lib/rate-limit';
import { MemoryRateLimitStore } from '@/lib/rate-limit/memory-store';

/**
 * 内存 store 与公开限流函数的单测。
 *
 * ## 为什么用「注入时钟」而不是 fake timers
 *
 * 窗口过期是这里最核心的行为，但真实 sleep 60 秒不可接受。
 * 注入 now() 比 vi.useFakeTimers() 更直接：固定窗口的实现只依赖 Date.now()，
 * 把时间点当参数传进去，测试就是纯函数式的、没有隐式全局状态。
 */

function createStore(initialNow = 0) {
  const clock = { now: initialNow };
  const store = new MemoryRateLimitStore({
    now: () => clock.now,
    // 每个用例独立的 Map，避免跨用例污染
    buckets: new Map(),
  });
  return { store, clock };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetRateLimitRuntime();
});

describe('固定窗口：同一 key 超限', () => {
  it('第 N+1 次被拒绝，remaining 递减正确，retryAfterSec > 0', async () => {
    const { store } = createStore();

    const first = await rateLimit('ip:1.2.3.4', 3, 60, { store });
    expect(first).toEqual({ ok: true, limit: 3, remaining: 2, retryAfterSec: 0 });

    const second = await rateLimit('ip:1.2.3.4', 3, 60, { store });
    expect(second).toEqual({ ok: true, limit: 3, remaining: 1, retryAfterSec: 0 });

    const third = await rateLimit('ip:1.2.3.4', 3, 60, { store });
    expect(third).toEqual({ ok: true, limit: 3, remaining: 0, retryAfterSec: 0 });

    // 第 4 次（N+1）越限
    const blocked = await rateLimit('ip:1.2.3.4', 3, 60, { store });
    expect(blocked.ok).toBe(false);
    expect(blocked.limit).toBe(3);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBe(60);
  });
});

describe('固定窗口：过期后恢复', () => {
  it('窗口内剩余秒数随时间递减，跨过窗口后计数清零', async () => {
    const { store, clock } = createStore(1_000_000);

    // 用 limit=1 让第 2 次立刻越限，方便观察 retryAfterSec
    expect((await rateLimit('ip:9.9.9.9', 1, 60, { store })).ok).toBe(true);

    clock.now += 30_000;
    const halfway = await rateLimit('ip:9.9.9.9', 1, 60, { store });
    expect(halfway.ok).toBe(false);
    expect(halfway.retryAfterSec).toBe(30);

    clock.now += 29_999;
    const nearlyDone = await rateLimit('ip:9.9.9.9', 1, 60, { store });
    expect(nearlyDone.ok).toBe(false);
    expect(nearlyDone.retryAfterSec).toBe(1);

    // 跨过窗口（60_000ms）后是新的固定窗口
    clock.now += 1;
    const resumed = await rateLimit('ip:9.9.9.9', 1, 60, { store });
    expect(resumed).toEqual({ ok: true, limit: 1, remaining: 0, retryAfterSec: 0 });
  });
});

describe('不同 key 互不影响', () => {
  it('不同 IP、不同用户、不同 action 各有独立窗口', async () => {
    const { store } = createStore();

    for (let i = 0; i < 2; i += 1) {
      expect((await rateLimit('ip:1.1.1.1', 2, 60, { store })).ok).toBe(true);
    }
    expect((await rateLimit('ip:1.1.1.1', 2, 60, { store })).ok).toBe(false);

    // 另一个 IP 完全不受影响
    expect((await rateLimit('ip:2.2.2.2', 2, 60, { store })).ok).toBe(true);

    // 同一用户的 task:create 与 auth:login 是两个 key
    expect((await rateLimitByUser('u_1', 'task:create', { store })).ok).toBe(true);
    expect((await rateLimitByUser('u_1', 'auth:login', { store })).ok).toBe(true);
    // 另一个用户独立
    expect((await rateLimitByUser('u_2', 'task:create', { store })).ok).toBe(true);
  });
});

describe('公开策略函数：key 与限额保持旧语义', () => {
  it('rateLimitAuthByIp(register) 为 5 次 / 300s', async () => {
    const { store } = createStore();

    for (let i = 0; i < 5; i += 1) {
      const result = await rateLimitAuthByIp('5.5.5.5', 'register', { store });
      expect(result.ok).toBe(true);
      expect(result.limit).toBe(5);
    }

    const blocked = await rateLimitAuthByIp('5.5.5.5', 'register', { store });
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBe(300);
  });

  it('rateLimitAuthByIp(login) 为 30 次 / 300s', async () => {
    const { store } = createStore();
    const result = await rateLimitAuthByIp('6.6.6.6', 'login', { store });
    expect(result.ok).toBe(true);
    expect(result.limit).toBe(30);
  });

  it('rateLimitByUser(task:create) 为 20 次 / 60s', async () => {
    const { store } = createStore();
    const result = await rateLimitByUser('u_1', 'task:create', { store });
    expect(result.limit).toBe(20);
    expect(result.remaining).toBe(19);
  });

  it('rateLimitByIp 使用 RATE_LIMIT_PER_MINUTE 且窗口 60s', async () => {
    const { store, clock } = createStore();
    const limit = env().RATE_LIMIT_PER_MINUTE;

    const first = await rateLimitByIp('7.7.7.7', { store });
    expect(first.limit).toBe(limit);
    expect(first.ok).toBe(true);

    clock.now += 60_000;
    const afterWindow = await rateLimitByIp('7.7.7.7', { store });
    expect(afterWindow.limit).toBe(limit);
    expect(afterWindow.remaining).toBe(limit - 1);
  });
});

describe('并发安全（内存实现的天然原子性）', () => {
  it('20 个并发请求只会放行 limit 个', async () => {
    const { store } = createStore();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rateLimit('ip:concurrent', 10, 60, { store })),
    );

    const allowed = results.filter((r) => r.ok);
    const blocked = results.filter((r) => !r.ok);
    expect(allowed).toHaveLength(10);
    expect(blocked).toHaveLength(10);
    // remaining 不重复：放行的请求依次拿到 9,8,...,0
    expect(allowed.map((r) => r.remaining).sort((a, b) => b - a)).toEqual([
      9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
    ]);
  });
});

describe('内存回收：purge 与上限保护', () => {
  it('purgeBuckets 只清理过期桶并返回条数', async () => {
    const { store, clock } = createStore(0);
    await rateLimit('ip:a', 5, 60, { store });
    await rateLimit('ip:b', 5, 120, { store });

    // a 在 60s 过期，b 还在窗口内
    clock.now = 61_000;
    expect(await purgeBuckets({ store })).toBe(1);
    expect(store.size).toBe(1);
    // 再次 purge 没有可清理的了
    expect(await purgeBuckets({ store })).toBe(0);
  });

  it('超过 maxKeys 时淘汰旧桶，Map 不会无限增长', async () => {
    const clock = { now: 0 };
    const store = new MemoryRateLimitStore({
      now: () => clock.now,
      buckets: new Map(),
      maxKeys: 3,
    });

    for (let i = 0; i < 50; i += 1) {
      await rateLimit(`ip:${i}`, 5, 60, { store });
    }

    expect(store.size).toBeLessThanOrEqual(3);
    // 最早的 key 已被淘汰：重新计数从 1 开始（淘汰方向 = 放行，fail-open）
    const revived = await store.increment('ip:0', 60);
    expect(revived.count).toBe(1);
  });

  it('注入 buckets 的 store 与共享 store 互不干扰', async () => {
    const { store } = createStore();
    await rateLimit('ip:isolated', 1, 60, { store });
    const shared = await rateLimit('ip:isolated', 1, 60);
    expect(shared.ok).toBe(true);
    expect(shared.remaining).toBe(0);
  });
});

describe('运行时配置默认值', () => {
  it('默认 memory driver + open fail mode + 0 跳代理', () => {
    const settings = rateLimitSettings();
    expect(settings.driver).toBe('memory');
    expect(settings.failMode).toBe('open');
    expect(settings.redisUrl).toBe('redis://127.0.0.1:6379');
    expect(settings.redisPrefix).toBe('lumenote:rl:');
    expect(settings.trustProxyHops).toBe(0);
  });
});

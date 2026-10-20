#!/usr/bin/env node
/**
 * Redis 限流的真实连通性 / 原子性验证。
 *
 * ## 为什么单测之外还需要这个脚本
 *
 * `tests/rate-limit-redis.test.ts` 用的是进程内 fake client —— 它能证明
 * 「降级逻辑、key 前缀、Lua 脚本内容」是对的，但**证明不了真实 Redis 上的行为**：
 *  - Lua 脚本能不能被真实 Redis 接受（语法/返回值类型）
 *  - 并发下 INCR 是否真的不丢计数（单线程执行模型）
 *  - INCR 之后 TTL 是否一定被设置（不会出现永不过期的 key）
 * 这几件事只有连上真 Redis 才能验证，所以本脚本绝不伪装成功。
 *
 * ## 本机/CI 没有 Redis 时
 *
 * 打印明确的 SKIPPED 原因并以退出码 **2** 结束（0=全部通过，1=验证失败，
 * 2=Redis 不可用跳过）。这样 CI 或人工一眼能区分「没验证」和「验证通过」。
 *
 * ## 用法
 *
 *   docker compose up -d redis     # compose 里已包含 redis:7-alpine 服务
 *   pnpm test:redis                # = node scripts/verify/rate-limit-redis.mjs
 *
 * 可用 REDIS_URL / RATE_LIMIT_REDIS_PREFIX 覆盖默认值。
 * 脚本只操作带 `verify:` 子命名空间的临时 key，结束时全部删除。
 */

import { randomUUID } from 'node:crypto';

// 与 src/lib/rate-limit/redis-store.ts 中的脚本保持一致。
// 这里刻意复制一份而不是 import TS：本脚本要能在不经过 tsx/编译的情况下直接 node 运行，
// 用于验证「真正发给 Redis 的脚本」是否可用。
const RATE_LIMIT_LUA_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`.trim();

const CONNECT_TIMEOUT_MS = 1_500;
const COMMAND_TIMEOUT_MS = 2_000;
const SKIPPED_EXIT_CODE = 2;

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const PREFIX = process.env.RATE_LIMIT_REDIS_PREFIX ?? 'lumenote:rl:';
const RUN_ID = randomUUID().slice(0, 8);
const KEY_BASE = `${PREFIX.endsWith(':') ? PREFIX : `${PREFIX}:`}verify:${RUN_ID}`;

let passed = 0;
let failed = 0;
const createdKeys = [];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`);
  } else {
    failed += 1;
    log(`  ✗ ${name}${detail ? `（${detail}）` : ''}`);
  }
}

function key(name) {
  const full = `${KEY_BASE}:${name}`;
  createdKeys.push(full);
  return full;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function evalCount(client, fullKey, windowMs) {
  const reply = await withTimeout(
    client.eval(RATE_LIMIT_LUA_SCRIPT, 1, fullKey, windowMs),
    COMMAND_TIMEOUT_MS,
    'EVAL',
  );
  const count = Number(reply?.[0]);
  const ttl = Number(reply?.[1]);
  return { count, ttl };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // 读取 .env.local（Node >= 20.12 的 process.loadEnvFile），便于和 pnpm dev 用同一份配置
  try {
    process.loadEnvFile?.('.env.local');
  } catch {
    // 没有 .env.local 时忽略，用 process.env / 默认值
  }

  const url = process.env.REDIS_URL ?? REDIS_URL;
  const prefix = process.env.RATE_LIMIT_REDIS_PREFIX ?? PREFIX;

  log('Redis 限流真实验证');
  log(`  目标：${redactRedisUrl(url)}  前缀：${prefix}`);
  log('');

  // ---------- 1. 连接 ----------
  const { default: Redis } = await import('ioredis');
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    // 验证脚本不重连：连不上就尽快跳过，而不是挂在那里反复重试
    retryStrategy: () => null,
  });
  // 没有监听 error 会触发 unhandled 'error' 事件导致进程崩溃
  let lastConnectionError = null;
  client.on('error', (error) => {
    lastConnectionError = error;
  });

  try {
    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, 'CONNECT');
    const pong = await withTimeout(client.ping(), COMMAND_TIMEOUT_MS, 'PING');
    if (pong !== 'PONG') throw new Error(`PING 返回 ${JSON.stringify(pong)}`);
  } catch (error) {
    // ioredis 在 retryStrategy=null 时 connect() 只报 "Connection is closed."，
    // 真正的原因（ECONNREFUSED / 认证失败）在 error 事件里，优先用它。
    const reason =
      (lastConnectionError instanceof Error && lastConnectionError.message) ||
      (error instanceof Error ? error.message : String(error));
    log('[SKIPPED] Redis 不可用，已跳过真实 Redis 验证');
    log(`  原因：${reason}`);
    log('');
    log('如何启用：');
    log('  docker compose up -d redis        # compose 已包含 redis:7-alpine');
    log('  pnpm test:redis                   # 或 RATE_LIMIT_DRIVER=redis pnpm dev');
    log('');
    log('（退出码 2 = 跳过；0 = 通过；1 = 验证失败。未连接即不声称验证通过。）');
    try {
      client.disconnect();
    } catch {
      // ignore
    }
    process.exitCode = SKIPPED_EXIT_CODE;
    return;
  }

  try {
    // ---------- 2. Lua 脚本：原子 INCR + 首次 PEXPIRE ----------
    log('检查 1/5：Lua 原子计数与首次 TTL 设置');
    const k1 = key('atomic');
    const first = await evalCount(client, k1, 2_000);
    check('首次计数为 1', first.count === 1, `count=${first.count}`);
    check('首次写入即设置 TTL', first.ttl > 0 && first.ttl <= 2_000, `ttl=${first.ttl}ms`);

    const second = await evalCount(client, k1, 2_000);
    check('第二次计数为 2', second.count === 2, `count=${second.count}`);
    check('TTL 仍为正（key 不会永不过期）', second.ttl > 0 && second.ttl <= 2_000, `ttl=${second.ttl}ms`);

    // ---------- 3. 并发原子性：不丢计数 ----------
    log('');
    log('检查 2/5：并发下的原子性（50 个并发 EVAL 不得丢计数）');
    const k2 = key('concurrent');
    const concurrent = 50;
    const replies = await Promise.all(
      Array.from({ length: concurrent }, () => evalCount(client, k2, 60_000)),
    );
    const counts = replies.map((r) => r.count).sort((a, b) => a - b);
    const expected = Array.from({ length: concurrent }, (_, i) => i + 1);
    check(
      '计数恰好为 1..50（无丢失、无重复）',
      counts.length === expected.length && counts.every((value, index) => value === expected[index]),
      `得到 ${counts[0]}..${counts[counts.length - 1]}`,
    );
    check(
      '并发后 TTL 仍为正',
      replies.every((r) => r.ttl > 0),
      `min=${Math.min(...replies.map((r) => r.ttl))}ms`,
    );

    // ---------- 4. 固定窗口：超限判定 ----------
    log('');
    log('检查 3/5：固定窗口超限判定（limit=5）');
    const k3 = key('window');
    const windowReplies = [];
    for (let i = 0; i < 6; i += 1) windowReplies.push(await evalCount(client, k3, 10_000));
    const limit = 5;
    const allowed = windowReplies.filter((r) => r.count <= limit).length;
    const blocked = windowReplies.filter((r) => r.count > limit).length;
    check('前 5 次放行', allowed === 5, `allowed=${allowed}`);
    check('第 6 次被判定超限', blocked === 1, `blocked=${blocked}`);
    check(
      '被拒时仍能拿到正数重试等待',
      Math.ceil(windowReplies[5].ttl / 1000) > 0,
      `retryAfterSec=${Math.ceil(windowReplies[5].ttl / 1000)}`,
    );

    // ---------- 5. TTL 过期后窗口恢复 ----------
    log('');
    log('检查 4/5：TTL 过期后窗口恢复（窗口 800ms）');
    const k4 = key('expiry');
    const before = await evalCount(client, k4, 800);
    await sleep(1_100);
    const after = await evalCount(client, k4, 800);
    check('过期后重新从 1 开始计数', after.count === 1, `before=${before.count} → after=${after.count}`);
    check('新窗口 TTL 为正', after.ttl > 0 && after.ttl <= 800, `ttl=${after.ttl}ms`);

    // ---------- 6. key 命名空间 ----------
    log('');
    log('检查 5/5：key 命名空间');
    check(
      '临时 key 带预期前缀',
      createdKeys.every((k) => k.startsWith(prefix.endsWith(':') ? prefix : `${prefix}:`)),
      createdKeys[0],
    );
  } catch (error) {
    failed += 1;
    log('');
    log(`  ✗ 验证过程抛出异常：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // 清理：只删本脚本创建的临时 key
    try {
      if (createdKeys.length > 0) await client.del(...createdKeys);
    } catch (error) {
      log(`  清理临时 key 失败（可忽略）：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }

  log('');
  if (failed > 0) {
    log(`结果：FAIL（通过 ${passed} 项，失败 ${failed} 项）`);
    process.exitCode = 1;
    return;
  }

  log(`结果：PASS（通过 ${passed} 项，真实 Redis 已验证）`);
  process.exitCode = 0;
}

/** 打日志时隐藏 Redis URL 里的密码 */
function redactRedisUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return value;
  }
}

await main();

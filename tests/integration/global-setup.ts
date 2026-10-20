/**
 * 集成测试的 globalSetup（**整个 test run 只执行一次**）。
 *
 * 它负责把「一台干净的可测环境」造出来，顺序不能变：
 *
 *   1. 清空数据库（DROP SCHEMA public CASCADE; CREATE SCHEMA public;）
 *      —— 直接 drop schema 比逐表 truncate 更彻底：迁移产生的枚举、索引、
 *      序列会一起消失，避免上一次跑残留的对象造成「本地过了 CI 挂」。
 *   2. `prisma migrate deploy` —— 用真实的 Prisma CLI 而不是手写 DDL。
 *      这样「空库能否迁移成功」本身就被验证了，而不是只验证代码认为的表结构。
 *   3. `tsx prisma/seed.ts` —— 写入 4 个内置模板、demo 用户与演示 Agent 任务。
 *   4. 启动被测应用（next dev，**不 build**）：CI 的 integration job 没有 build 步骤，
 *      用 next dev 既省一次完整构建，也避免「测试跑的是旧构建产物」。
 *   5. 轮询 /api/health 直到数据库可用，把 baseUrl 通过 project.provide 交给测试。
 *
 * teardown 必须杀掉整棵进程树：`next dev` 会派生子进程，只 kill 父进程
 * 在 Windows 上会留下占着端口的孤儿进程，下一次运行直接失败。
 *
 * ## 为什么显式传 env 而不依赖 .env.local
 *
 * CI 没有 `.env.local`。如果这里依赖它，会得到「本地全绿、CI 全红」。
 * 所有测试需要的变量都在下方 serverEnv() 里显式给出：
 *   MOCK_LLM=true          —— 绝不产生真实付费模型调用
 *   TRUST_PROXY_HOPS=1     —— 让测试能用 X-Forwarded-For 分配独立的限流桶
 *   RATE_LIMIT_DRIVER=memory —— CI 没有 Redis；内存限流在单实例下足够
 *   MAIL_TRANSPORT=console —— 注册验证码从接口 devCode 回传，不需要真发邮件
 *   NODE_ENV=development   —— console 通道仅在非生产环境回传 devCode
 *
 * ## 允许复用外部服务
 *
 * 设置 `INTEGRATION_BASE_URL` 时跳过上述所有步骤（不重置数据库、不启动/杀进程），
 * 只做健康检查。用于「已经起好服务、只想重跑测试」的场景。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { GlobalSetupContext } from 'vitest/node';
import {
  detectDevBundlerArgs,
  nextCliPath,
  prismaCliPath,
  projectRoot,
  resolveAuthSecret,
  resolveBaseUrl,
  resolveDatabaseUrl,
  resolveDirectUrl,
  resolveIntegrationPort,
  tsxCliPath,
} from './helpers/config';

const IS_WIN = process.platform === 'win32';
const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 400;
/** 保留的服务端日志上限（字符） */
const LOG_LIMIT = 200_000;

const log = (msg: string) => console.info(`[integration] ${msg}`);

let server: ChildProcess | null = null;
let serverLogs = '';
let cleanupInstalled = false;

function appendLog(chunk: Buffer | string): void {
  serverLogs += chunk.toString();
  if (serverLogs.length > LOG_LIMIT) serverLogs = serverLogs.slice(-LOG_LIMIT);
}

function serverLogTail(maxLines = 80): string {
  if (!serverLogs.trim()) return '(服务端没有任何输出)';
  const lines = serverLogs.split(/\r?\n/);
  return lines.slice(-maxLines).join('\n');
}

/** 端口是否已被监听 */
function tcpOpen(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 杀掉进程树。Windows 上 `next dev` 会派生子进程，必须用 taskkill /T */
function killTree(pid: number): void {
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // 负 pid = 进程组（spawn 时 detached 才会成为组首）
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // 进程已经退出 / 权限不足：清理失败不做二次抛错，避免盖住真正的测试失败
  }
}

/** 找到占用端口的进程并杀掉（上一次运行崩溃时最常见的残留） */
function killPortOccupant(port: number): void {
  try {
    if (IS_WIN) {
      const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).stdout ?? '';
      const pids = new Set<string>();
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue;
        // 只匹配本地地址结尾的 :port（避免把 :32100 之类误判成 :3210）
        if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid)) pids.add(pid);
      }
      for (const pid of pids) {
        log(`· 端口 ${port} 被 pid=${pid} 占用，尝试杀掉残留进程`);
        spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
      }
    } else {
      const out = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).stdout ?? '';
      for (const pid of out.split(/\s+/).filter(Boolean)) {
        log(`· 端口 ${port} 被 pid=${pid} 占用，尝试杀掉残留进程`);
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch {
          /* 已退出 */
        }
      }
    }
  } catch {
    // 没有 netstat/lsof 也不该让整轮测试失败；下面会等待并给出清晰报错
  }
}

async function ensurePortFree(port: number): Promise<void> {
  if (!(await tcpOpen('127.0.0.1', port))) return;
  killPortOccupant(port);
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    if (!(await tcpOpen('127.0.0.1', port))) return;
  }
  throw new Error(
    `端口 ${port} 仍被占用。请先手动释放（或设置 INTEGRATION_PORT 换一个端口）后再运行集成测试。`,
  );
}

async function waitForPortReleased(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await tcpOpen('127.0.0.1', port, 300))) return;
    await sleep(250);
  }
  log(`⚠️ 端口 ${port} 在 ${timeoutMs}ms 内未释放，下一次运行前会被自动清理`);
}

/** 同步执行一个 CLI 步骤，失败时把 stdout/stderr 一起带进错误信息 */
function runCli(label: string, scriptPath: string, args: string[], env: NodeJS.ProcessEnv): void {
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`${label} 失败：找不到 ${scriptPath}（是否忘了 pnpm install / prisma generate？）`);
  }
  log(`· ${label} …`);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot(),
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });

  if (result.error) {
    throw new Error(`${label} 启动失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} 失败（退出码 ${String(result.status)}）：\n` +
        `--- stdout ---\n${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}`,
    );
  }
}

/** 清空测试库的 public schema。比逐表 truncate 更彻底（枚举/序列/索引一起消失） */
async function resetSchema(databaseUrl: string): Promise<void> {
  log('· 重置数据库 schema（DROP SCHEMA public CASCADE; CREATE SCHEMA public;）…');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl, max: 1 }),
  });
  try {
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  } finally {
    await prisma.$disconnect();
  }
}

/** 被测应用需要显式注入的 env（见文件头说明） */
function serverEnv(port: number, databaseUrl: string, directUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // 数据库
    DATABASE_URL: databaseUrl,
    DIRECT_URL: directUrl,
    // 认证：env.ts 要求 >= 16 字符
    AUTH_SECRET: resolveAuthSecret(),
    // 绝不产生真实付费调用
    MOCK_LLM: 'true',
    DEFAULT_MODEL: process.env.DEFAULT_MODEL ?? 'deepseek-flash',
    FALLBACK_MODEL: process.env.FALLBACK_MODEL ?? 'deepseek-v4-pro',
    // 限流：内存实现（CI 无 Redis），XFF 从右数第 1 段取 IP
    RATE_LIMIT_DRIVER: 'memory',
    RATE_LIMIT_FAIL_MODE: 'open',
    RATE_LIMIT_PER_MINUTE: '1000',
    TRUST_PROXY_HOPS: '1',
    // 邮件：console 通道会在非生产环境把验证码回传给注册流程
    MAIL_TRANSPORT: 'console',
    MAIL_FROM: 'Lumenote <no-reply@lumenote.local>',
    // 新用户配额与并发（测试里需要连续建任务，但每次都会等终态）
    FREE_DAILY_QUOTA: '500',
    MAX_CONCURRENT_TASKS_PER_USER: '1',
    // 应用自身
    NODE_ENV: 'development',
    NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
    NEXT_TELEMETRY_DISABLED: '1',
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
  };
}

async function waitForHealth(
  baseUrl: string,
  isExited: () => boolean,
): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = '尚未发出请求';

  while (Date.now() < deadline) {
    if (isExited()) {
      throw new Error(`应用进程在健康检查前退出。服务端日志尾部：\n${serverLogTail()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(5_000),
        redirect: 'manual',
      });
      const text = await res.text();
      if (res.status === 200) {
        const json = JSON.parse(text) as { db?: { ok?: boolean } };
        if (json.db?.ok === true) return;
        lastError = `HTTP 200 但 db.ok=${String(json.db?.ok)}`;
      } else {
        lastError = `HTTP ${res.status}: ${text.slice(0, 300)}`;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await sleep(HEALTH_POLL_MS);
  }

  throw new Error(
    `等待 /api/health 就绪超时（${HEALTH_TIMEOUT_MS}ms）。最后一次错误：${lastError}\n` +
      `服务端日志尾部：\n${serverLogTail()}`,
  );
}

async function startServer(
  port: number,
  databaseUrl: string,
  directUrl: string,
): Promise<string> {
  const root = projectRoot();
  const nextBin = nextCliPath(root);
  if (!fs.existsSync(nextBin)) {
    throw new Error(`找不到 Next CLI：${nextBin}（是否忘了 pnpm install？）`);
  }
  if (!fs.existsSync(path.join(root, 'node_modules', 'prisma', 'build', 'index.js'))) {
    throw new Error('找不到 Prisma CLI，集成测试需要 prisma migrate deploy');
  }

  await ensurePortFree(port);

  const baseUrl = `http://127.0.0.1:${port}`;
  const args = [
    nextBin,
    'dev',
    '-p',
    String(port),
    '-H',
    '127.0.0.1',
    ...detectDevBundlerArgs(root),
  ];

  log(`· 启动被测应用：next dev port=${port}（首次请求需要编译路由，会稍慢）`);
  serverLogs = '';

  server = spawn(process.execPath, args, {
    cwd: root,
    env: serverEnv(port, databaseUrl, directUrl),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX 下让子进程成为独立进程组，teardown 时能整组杀掉
    detached: !IS_WIN,
  });

  let exited = false;
  server.on('exit', (code, signal) => {
    exited = true;
    appendLog(`\n[integration] next dev exited code=${String(code)} signal=${String(signal)}\n`);
  });
  server.on('error', (e) => {
    exited = true;
    appendLog(`\n[integration] next dev spawn error: ${e.message}\n`);
  });
  server.stdout?.on('data', appendLog);
  server.stderr?.on('data', appendLog);

  // 进程被信号/异常终止时兜底清理（globalSetup 的 teardown 在崩溃路径上可能不执行）
  if (!cleanupInstalled) {
    cleanupInstalled = true;
    process.on('exit', () => {
      if (server?.pid) killTree(server.pid);
    });
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => {
        if (server?.pid) killTree(server.pid);
        process.exit(130);
      });
    }
  }

  try {
    await waitForHealth(baseUrl, () => exited);
  } catch (e) {
    await stopServer(port);
    throw e;
  }

  log(`· 应用已就绪：${baseUrl}`);
  return baseUrl;
}

async function stopServer(port: number): Promise<void> {
  const child = server;
  server = null;
  if (!child?.pid) return;

  log(`· 清理被测应用进程树（pid=${child.pid}）…`);
  killTree(child.pid);
  // 先等进程退出，再等端口释放；Windows 的 taskkill 是异步生效的
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.killed) break;
    await sleep(200);
  }
  await waitForPortReleased(port);
}

/**
 * Vitest 2 的 globalSetup 签名：接收 `{ provide }`，可返回 teardown 函数。
 * `provide` 的值在测试里通过 `inject('integrationBaseUrl')` 读取。
 */
export default async function globalSetup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const port = resolveIntegrationPort();
  const externalBaseUrl = process.env.INTEGRATION_BASE_URL?.trim();

  // ---- 复用外部服务：不清理任何东西，只验证它可用 ----
  if (externalBaseUrl) {
    const baseUrl = resolveBaseUrl();
    log(`· INTEGRATION_BASE_URL=${baseUrl}，跳过数据库重置与服务启动（复用外部服务）`);
    await waitForHealth(baseUrl, () => false);
    process.env.INTEGRATION_BASE_URL = baseUrl;
    provide('integrationBaseUrl', baseUrl);
    return async () => {
      log('· 外部服务模式：不清理');
    };
  }

  const databaseUrl = resolveDatabaseUrl();
  const directUrl = resolveDirectUrl();
  log(`· 测试数据库：${databaseUrl.replace(/:\/\/[^@]*@/, '://***@')}`);

  // 1) 空库
  await resetSchema(directUrl);

  // 2) 迁移（Prisma CLI 自身会读 prisma.config.ts；显式 env 优先于 .env.local）
  runCli('prisma migrate deploy', prismaCliPath(), ['migrate', 'deploy'], {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DIRECT_URL: directUrl,
  });

  // 3) seed（幂等，seed-idempotency 用例会再跑两次验证）
  runCli('prisma seed', tsxCliPath(), ['prisma/seed.ts'], {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DIRECT_URL: directUrl,
    NODE_ENV: 'development',
  });

  // 4) + 5) 启动应用并等待健康检查
  const baseUrl = await startServer(port, databaseUrl, directUrl);

  process.env.INTEGRATION_BASE_URL = baseUrl;
  process.env.INTEGRATION_PORT = String(port);
  provide('integrationBaseUrl', baseUrl);

  log('· 环境就绪，开始执行集成测试');

  return async () => {
    await stopServer(port);
    log('· teardown 完成');
  };
}

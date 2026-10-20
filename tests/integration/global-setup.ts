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
 * ## 可重复性加固（踩过一次 flaky 后补的）
 *
 * 1. **端口绝不静默复用**。默认端口被占用时先杀掉残留的 `next dev`；杀不掉就
 *    `listen(0)` 自动选一个空闲端口（并把新端口注入 baseUrl），绝不出现
 *    「health 检查打到上一次的旧服务」。启动后还会用 `/api/health` 的
 *    `uptimeSec` 与本次 spawn 的 elapsed 对比，确认响应来自**本次**进程。
 * 2. **子进程 env 优先级**：Next 的 loadEnvConfig 只补充 process.env 里
 *    **不存在**的键，因此显式传入的 env 不会被仓库 `.env.local` 覆盖。
 *    另外还强制把 `DEEPSEEK_API_KEY/OPENAI_API_KEY/RESEND_API_KEY` 置空字符串
 *    （空字符串也算「已存在」），即使 mock 开关意外失效，应用也会在启动期因
 *    「没有任何 LLM Key」直接失败，而**不会**产生真实付费调用。
 * 3. **数据库安全阀**：重置 schema 前校验 DATABASE_URL 的库名含 `test`，
 *    避免误把 `lumenote` 生产库 DROP 掉（需要显式设置
 *    `INTEGRATION_ALLOW_NON_TEST_DB=1` 才能跳过该检查）。
 * 4. **teardown 等待端口真正释放**：kill 进程树后轮询端口，超时则再杀一次并
 *    打印警告（含占用进程信息），便于下一次运行定位。
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
/** 本次实际使用的端口（可能与偏好端口不同；teardown 必须等它释放） */
let activePort: number | null = null;

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

/** 列出占用端口的进程 PID（Windows: netstat；POSIX: lsof） */
function portOccupantPids(port: number): string[] {
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
      return [...pids];
    }
    const out = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).stdout ?? '';
    return out.split(/\s+/).filter(Boolean);
  } catch {
    // 没有 netstat/lsof 也不该让整轮测试失败；调用方会按「杀不掉 → 换端口」处理
    return [];
  }
}

/** 找到占用端口的进程并杀掉（上一次运行崩溃时最常见的残留） */
function killPortOccupant(port: number): string[] {
  const pids = portOccupantPids(port);
  for (const pid of pids) {
    log(`· 端口 ${port} 被 pid=${pid} 占用，尝试杀掉残留进程（不会直接复用旧服务）`);
    try {
      if (IS_WIN) {
        spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(Number(pid), 'SIGKILL');
      }
    } catch {
      /* 已退出 / 权限不足：由调用方继续等待并决定是否换端口 */
    }
  }
  return pids;
}

/** 让操作系统分配一个空闲端口（listen(0) 后立即关闭） */
async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close((err) => {
        if (err) reject(err);
        else if (port > 0) resolve(port);
        else reject(new Error('无法从 listen(0) 获取端口'));
      });
    });
  });
}

/**
 * 选择本次运行实际使用的端口。
 *
 * 策略（**绝不静默复用旧服务**）：
 *  1. 偏好端口空闲 → 直接用；
 *  2. 被占用 → 打印占用进程并杀掉残留（上一次运行崩溃留下的 next dev），
 *     等待 ≤8s 确认释放；
 *  3. 杀不掉/释放不了 → 用 `listen(0)` 自动选空闲端口，并明确日志告知。
 */
async function choosePort(preferred: number): Promise<number> {
  if (!(await tcpOpen('127.0.0.1', preferred))) return preferred;

  log(`⚠️ 端口 ${preferred} 已被占用（不会静默复用该服务）`);
  const pids = killPortOccupant(preferred);
  if (pids.length === 0) {
    log(`⚠️ 未能识别端口 ${preferred} 的占用进程（可能权限不足）`);
  }

  for (let i = 0; i < 32; i += 1) {
    // 8s = 32 × 250ms；Windows taskkill 生效需要一点时间
    await sleep(250);
    if (!(await tcpOpen('127.0.0.1', preferred))) {
      log(`· 端口 ${preferred} 已重新释放，继续使用偏好端口`);
      return preferred;
    }
  }

  const fallback = await findFreePort();
  log(`⚠️ 端口 ${preferred} 在 8s 内仍被占用，自动改用空闲端口 ${fallback}（本次 baseUrl 会指向该端口）`);
  return fallback;
}

/** 等端口真正空闲（kill 进程树后必须确认，否则下一次运行会打到旧服务） */
async function waitForPortReleased(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await tcpOpen('127.0.0.1', port, 300))) return true;
    await sleep(250);
  }
  return false;
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

/**
 * 重置 schema 前的安全阀：库名必须看起来是测试库。
 *
 * 集成测试会 `DROP SCHEMA public CASCADE`，一旦 DATABASE_URL 被 shell/CI
 * 误指向 `lumenote`（生产/开发库），这是不可恢复的数据事故。宁可多一步报错。
 */
function assertSafeToResetDatabase(databaseUrl: string): void {
  if (process.env.INTEGRATION_ALLOW_NON_TEST_DB === '1') {
    log('⚠️ INTEGRATION_ALLOW_NON_TEST_DB=1：已显式允许对非 test 库执行 DROP SCHEMA');
    return;
  }

  let host = '';
  let dbName = '';
  try {
    const parsed = new URL(databaseUrl);
    host = parsed.hostname;
    dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    throw new Error(`无法解析 DATABASE_URL（${databaseUrl.replace(/:\/\/[^@]*@/, '://***@')}），拒绝执行 DROP SCHEMA`);
  }

  if (!/test/i.test(dbName)) {
    throw new Error(
      `拒绝运行：DATABASE_URL 指向数据库 "${dbName}"（host=${host}），看起来不是测试库。\n` +
        '集成测试会 DROP SCHEMA public CASCADE，请确认 DATABASE_URL 指向 *_test 库；\n' +
        '若确实要对非测试库执行，请显式设置 INTEGRATION_ALLOW_NON_TEST_DB=1。',
    );
  }
  log(`· 数据库安全检查通过：host=${host} db=${dbName}`);
}

/** 清空测试库的 public schema。比逐表 truncate 更彻底（枚举/序列/索引一起消失） */
async function resetSchema(databaseUrl: string): Promise<void> {
  assertSafeToResetDatabase(databaseUrl);
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
    /**
     * 绝不产生真实付费调用。
     *
     * MOCK_LLM 显式置 true；同时把各家 Key 强制置为空字符串。
     * Next 的 loadEnvConfig 只补充 process.env 中**不存在**的键，
     * 已存在（含空字符串）的键不会被 `.env.local` 覆盖 —— 这样即使
     * 仓库里的 `.env.local` 写着 MOCK_LLM=false + 真实 Key（main worktree 就是），
     * 本进程也只会看到空 Key：mock 关掉时应用会在启动期直接报
     * 「没有任何 LLM API Key」而失败，而不是偷偷发起真实调用。
     */
    MOCK_LLM: 'true',
    DEEPSEEK_API_KEY: '',
    OPENAI_API_KEY: '',
    RESEND_API_KEY: '',
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

interface HealthPayload {
  status?: string;
  uptimeSec?: number;
  version?: string;
}

/** 轮询 /api/health；返回健康检查载荷（供实例新鲜度校验） */
async function waitForHealth(
  baseUrl: string,
  isExited: () => boolean,
): Promise<HealthPayload> {
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
        const json = JSON.parse(text) as HealthPayload & { db?: { ok?: boolean } };
        if (json.db?.ok === true) return json;
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

/**
 * 实例新鲜度校验：确认 /api/health 响应来自**本次 spawn** 的进程。
 *
 * 这是「health 打到了别人的旧服务」的最后一道防线：
 * 旧服务的 `uptimeSec` 会明显大于本次子进程的已运行时长。
 * 只做下限宽松判断（+15s 余量），避免把正常启动误杀。
 */
function assertFreshInstance(health: HealthPayload, spawnedAt: number, port: number): void {
  if (typeof health.uptimeSec !== 'number') return; // 兼容没有该字段的旧服务端
  const elapsedSec = (Date.now() - spawnedAt) / 1000;

  if (health.uptimeSec > elapsedSec + 15) {
    const pids = portOccupantPids(port);
    throw new Error(
      `/api/health 返回 uptimeSec=${health.uptimeSec}s，但本次 next dev 只启动了 ${elapsedSec.toFixed(1)}s。\n` +
        `说明端口 ${port} 上响应的是旧服务（不是本次启动的进程），已中止 —— 不会用旧代码/旧 env 跑测试。\n` +
        `当前占用该端口的进程：${pids.join(', ') || '(未识别)'}。` +
        '请检查是否有其他 worktree 的 dev server 占用了同一端口。',
    );
  }

  log(`· 实例校验通过：health.uptimeSec=${health.uptimeSec}s ≤ 本次启动 ${elapsedSec.toFixed(1)}s + 15s`);
}

interface StartedServer {
  baseUrl: string;
  port: number;
}

/** 启动一次（内部失败会清理进程）；端口冲突/旧服务问题由调用方换端口重试 */
async function spawnServer(
  port: number,
  databaseUrl: string,
  directUrl: string,
): Promise<StartedServer> {
  const root = projectRoot();
  const baseUrl = `http://127.0.0.1:${port}`;
  const args = [
    nextCliPath(root),
    'dev',
    '-p',
    String(port),
    '-H',
    '127.0.0.1',
    ...detectDevBundlerArgs(root),
  ];

  log('· 子进程 env 已强制：MOCK_LLM=true + DEEPSEEK/OPENAI/RESEND key 置空（空字符串同样不可被 .env.local 覆盖）');
  log('· Next env 优先级：process.env 中已存在的键不会被 .env.local 覆盖，显式注入值优先生效');
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
  const spawnedAt = Date.now();

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
    const health = await waitForHealth(baseUrl, () => exited);
    if (exited) {
      throw new Error(`应用进程在健康检查后立即退出。服务端日志尾部：\n${serverLogTail()}`);
    }
    assertFreshInstance(health, spawnedAt, port);
  } catch (e) {
    await stopServer(port);
    throw e;
  }

  log(`· 应用已就绪：${baseUrl}`);
  return { baseUrl, port };
}

/**
 * 启动被测应用。
 *
 * 最多尝试两次：
 *  1. 偏好端口（被残留进程占用时先清理；清不掉则自动改用 listen(0) 的空闲端口）；
 *  2. 若第一次仍失败（端口竞争、旧服务未退干净），换一个全新的空闲端口再试。
 * 两次都失败才抛错，避免「第一次偶发失败就要整轮重跑」。
 */
async function startServer(databaseUrl: string, directUrl: string): Promise<StartedServer> {
  const root = projectRoot();
  const nextBin = nextCliPath(root);
  if (!fs.existsSync(nextBin)) {
    throw new Error(`找不到 Next CLI：${nextBin}（是否忘了 pnpm install？）`);
  }
  if (!fs.existsSync(path.join(root, 'node_modules', 'prisma', 'build', 'index.js'))) {
    throw new Error('找不到 Prisma CLI，集成测试需要 prisma migrate deploy');
  }

  const preferred = resolveIntegrationPort();
  let lastError: unknown = new Error('未尝试启动');

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const port = attempt === 1 ? await choosePort(preferred) : await findFreePort();
    log(`· 启动被测应用（第 ${attempt}/2 次尝试，port=${port}）`);
    try {
      const started = await spawnServer(port, databaseUrl, directUrl);
      activePort = started.port;
      return started;
    } catch (e) {
      lastError = e;
      const firstLine = (e instanceof Error ? e.message : String(e)).split('\n')[0];
      log(`⚠️ 第 ${attempt} 次启动失败：${firstLine}`);
      if (attempt < 2) log('· 换一个空闲端口重试（避免端口/旧服务残留造成整轮 flaky）');
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 杀掉应用进程树，并等待端口真正释放（失败只告警，不抛错以免掩盖测试失败） */
async function stopServer(port: number | null): Promise<void> {
  const targetPort = port ?? activePort;
  const child = server;
  server = null;
  activePort = null;

  if (!child?.pid) {
    if (targetPort !== null) await waitForPortReleased(targetPort, 5_000);
    return;
  }

  log(`· 清理被测应用进程树（pid=${child.pid}，port=${String(targetPort)}）…`);
  killTree(child.pid);
  // 先等进程退出，再等端口释放；Windows 的 taskkill 是异步生效的
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.killed) break;
    await sleep(200);
  }

  if (targetPort === null) return;

  let released = await waitForPortReleased(targetPort);
  if (!released) {
    log(`⚠️ kill 后 15s 端口 ${targetPort} 仍被监听，再杀一次占用进程…`);
    killPortOccupant(targetPort);
    released = await waitForPortReleased(targetPort, 5_000);
  }

  if (!released) {
    const pids = portOccupantPids(targetPort);
    log(
      `⚠️ 警告：端口 ${targetPort} 在 teardown 后仍未释放（占用 pid: ${pids.join(', ') || '未识别'}）。` +
        '下一次运行会自动清理；若持续出现请手动结束该进程。',
    );
  } else {
    log(`· 端口 ${targetPort} 已释放`);
  }
}

/**
 * Vitest 2 的 globalSetup 签名：接收 `{ provide }`，可返回 teardown 函数。
 * `provide` 的值在测试里通过 `inject('integrationBaseUrl')` 读取。
 */
export default async function globalSetup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const externalBaseUrl = process.env.INTEGRATION_BASE_URL?.trim();

  // ---- 复用外部服务：不清理任何东西，只验证它可用 ----
  if (externalBaseUrl) {
    const baseUrl = resolveBaseUrl();
    log(`· INTEGRATION_BASE_URL=${baseUrl}，跳过数据库重置与服务启动（复用外部服务）`);
    const health = await waitForHealth(baseUrl, () => false);
    log(
      `· 外部服务健康检查通过（uptimeSec=${String(health.uptimeSec ?? '未知')}；` +
        '外部模式不做实例新鲜度校验，也不会 kill 任何进程）',
    );
    process.env.INTEGRATION_BASE_URL = baseUrl;
    provide('integrationBaseUrl', baseUrl);
    return async () => {
      log('· 外部服务模式：不清理');
    };
  }

  const databaseUrl = resolveDatabaseUrl();
  const directUrl = resolveDirectUrl();
  log(`· 测试数据库：${databaseUrl.replace(/:\/\/[^@]*@/, '://***@')}`);

  // 1) 空库（resetSchema 内部有「必须是测试库」的安全阀）
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

  // 4) + 5) 启动应用并等待健康检查（端口与实例新鲜度校验在 startServer 内）
  const started = await startServer(databaseUrl, directUrl);

  process.env.INTEGRATION_BASE_URL = started.baseUrl;
  process.env.INTEGRATION_PORT = String(started.port);
  provide('integrationBaseUrl', started.baseUrl);

  log(`· 环境就绪（baseUrl=${started.baseUrl}），开始执行集成测试`);

  return async () => {
    await stopServer(started.port);
    log('· teardown 完成');
  };
}

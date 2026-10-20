/**
 * 冒烟脚本：用真实 HTTP 走一遍「登录 → 创建任务 → 轮询 → SSE → 幂等重放」，
 * 在 **Mock LLM 模式（不需要真实 API Key）** 下验证端到端链路真的可用。
 *
 * ## 为什么需要它
 *
 * 单测覆盖纯逻辑，但「两段式流式」的坑几乎全在**跨请求的生命周期**里：
 * POST 用 after() 异步跑管线、SSE 从数据库轮询补发、幂等键在第二个请求里命中 ——
 * 这些只有在真实 HTTP + 真实进程里才暴露。历史 bug（SSE 只回放不流式、
 * mock 模式下任务卡在 queued）都是被这类脚本抓到的。
 *
 * ## 用法
 *
 *   node scripts/smoke.mjs                    # 自动选端口启动应用，跑完整流程
 *   SMOKE_BASE_URL=http://127.0.0.1:3000 node scripts/smoke.mjs   # 对着已在跑的应用跑
 *   SMOKE_PORT=3210 node scripts/smoke.mjs    # 换端口
 *
 * 启动应用的优先级（未给 SMOKE_BASE_URL 时）：
 *   1. `.next/standalone/server.js`（生产 standalone 产物）
 *   2. 已有构建产物（`.next/BUILD_ID`）→ `next start`
 *   3. 以上都没有 → `next dev`（默认路径：本地开发 / CI 未构建时）
 *
 * 环境变量：
 *   SMOKE_BASE_URL        直接使用该地址，不启动应用
 *   SMOKE_PORT            自动启动时的端口（默认 3200，刻意避开常用的 3000）
 *   SMOKE_DEMO_EMAIL      演示账号（默认 demo@lumenote.dev）
 *   SMOKE_DEMO_PASSWORD   演示密码（默认 Lumenote2026!，与 prisma/seed.ts 一致）
 *   SMOKE_SKIP_DB=1       跳过「确保数据库就绪」的预检
 *   SMOKE_START_TIMEOUT_MS 等待 /api/health 就绪的上限（默认 120000）
 *   SMOKE_TASK_TIMEOUT_MS  等待任务终态的上限（默认 60000）
 *   SMOKE_STREAM_TIMEOUT_MS 单次 SSE 订阅的上限（默认 60000）
 *
 * 退出码：0 = 全部断言通过；1 = 有失败或环境问题。它会**清理自己启动的进程**。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDevBundlerArgs, explainBundlerChoice } from './demo/bundler.mjs';
import { config as loadEnv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

/**
 * 显式加载 `.env.local` / `.env`。
 *
 * 为什么必须自己做：`next dev` 与 `next start` 会由 Next 自动读 `.env.local`，
 * 但 **standalone 的 `node server.js` 不会**。冒烟脚本可能选中 standalone 产物
 * （构建过 BUILD_STANDALONE 后常见），若只依赖 Next 的自动加载，子进程会因
 * `DATABASE_URL` 未配置而启动成功、所有请求 500（曾真实发生）。
 * 这里统一加载，三种启动模式行为一致；进程里已有的同名变量优先（dotenv 默认不覆盖）。
 */
loadEnv({ path: [path.join(ROOT, '.env.local'), path.join(ROOT, '.env')], quiet: true });

const ENV = {
  baseUrl: process.env.SMOKE_BASE_URL?.replace(/\/+$/, '') ?? '',
  port: Number(process.env.SMOKE_PORT ?? 3200),
  email: process.env.SMOKE_DEMO_EMAIL ?? 'demo@lumenote.dev',
  password: process.env.SMOKE_DEMO_PASSWORD ?? 'Lumenote2026!',
  skipDb: process.env.SMOKE_SKIP_DB === '1',
  startTimeoutMs: Number(process.env.SMOKE_START_TIMEOUT_MS ?? 120_000),
  taskTimeoutMs: Number(process.env.SMOKE_TASK_TIMEOUT_MS ?? 60_000),
  streamTimeoutMs: Number(process.env.SMOKE_STREAM_TIMEOUT_MS ?? 60_000),
};

const log = (...a) => console.log('[smoke]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n);
/** 脚本启动时刻（供健康检查等独立函数计算耗时） */
const SCRIPT_STARTED_AT = nowMs();
/** 实际启动用的模式（dev/start/standalone），影响断言阈值：dev 首次请求要编译路由 */
let serverMode = 'external';

// ============================================================
// 断言与计时
// ============================================================

let passed = 0;
const failures = [];
/** 每步耗时：[{name, ms}] */
const timings = [];

function assert(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    log(`  ✓ ${name}`);
    return true;
  }
  failures.push({ name, detail });
  log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  return false;
}

async function step(name, fn) {
  const t0 = nowMs();
  log(`\n▸ ${name}`);
  try {
    await fn();
  } catch (e) {
    failures.push({ name, detail: e instanceof Error ? e.message : String(e) });
    log(`  ✗ 步骤异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }
  const ms = nowMs() - t0;
  timings.push({ name, ms });
  log(`  ⏱ ${ms}ms`);
}

// ============================================================
// HTTP 客户端（带 cookie jar 与超时）
// ============================================================

/** name -> "name=value"，保持登录后的两个 cookie（access + refresh） */
const cookieJar = new Map();

function cookieHeader() {
  return [...cookieJar.values()].join('; ');
}

function storeSetCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const pair = raw.split(';')[0];
    if (!pair || !pair.includes('=')) continue;
    const name = pair.slice(0, pair.indexOf('='));
    cookieJar.set(name, pair);
  }
}

/**
 * 发一个请求并返回结构化结果。
 *
 * 失败时把 HTTP 状态与响应片段一并返回（而不是直接 throw）——
 * 冒烟脚本最有用的信息就是「服务端到底回了什么」，丢掉它等于自废一半价值。
 */
async function request(method, pathname, { body, headers = {}, timeoutMs = 30_000 } = {}) {
  const url = `${baseUrl()}${pathname}`;
  const init = {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookieJar.size > 0 ? { Cookie: cookieHeader() } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  };
  const t0 = nowMs();
  const res = await fetch(url, init);
  const text = await res.text();
  const elapsedMs = nowMs() - t0;
  storeSetCookies(res);

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（例如 SSE / HTML 错误页）时保留原文 */
  }
  return { status: res.status, headers: res.headers, text, json, elapsedMs, url };
}

function snippet(text, max = 400) {
  if (!text) return '(空响应)';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 统一的 HTTP 断言：状态码 + （可选）响应片段，都打印出来便于失败定位 */
function assertHttp(name, r, expectedStatus) {
  const ok = assert(
    `${name}（HTTP ${r.status}，期望 ${expectedStatus}）`,
    r.status === expectedStatus,
    r.status === expectedStatus ? '' : `响应片段: ${snippet(r.text)}`,
  );
  return ok;
}

// ============================================================
// 服务启动 / 清理
// ============================================================

let baseOverride = ENV.baseUrl;
const baseUrl = () => baseOverride || `http://127.0.0.1:${ENV.port}`;

/** 本脚本启动的子进程；null 表示复用了外部服务（不清理） */
let serverChild = null;
let serverLogPath = null;
/** 清理是否已经执行过（process.on('exit') 与 finally 可能重复调用） */
let cleaned = false;

function tcpOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** 确保数据库可用：复用 dev.mjs 的探测/启动逻辑（--dry-run 只探测不启动 Next） */
function ensureDatabase() {
  if (ENV.skipDb) {
    log('· SMOKE_SKIP_DB=1，跳过数据库预检');
    return true;
  }
  log('· 检查 PostgreSQL（复用 scripts/dev.mjs --dry-run）…');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dev.mjs'), '--dry-run'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) {
    log('✗ 数据库未就绪，冒烟测试无法进行。先修好数据库（见上面 dev.mjs 的指引）再重试。');
    return false;
  }
  return true;
}

/** 判断用哪种方式启动应用 */
function chooseServerMode() {
  if (fs.existsSync(path.join(ROOT, '.next', 'standalone', 'server.js'))) return 'standalone';
  if (fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) return 'start';
  return 'dev';
}

function spawnServer() {
  const mode = chooseServerMode();
  serverMode = mode;
  const nextBin = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  const nextBinExists = fs.existsSync(nextBin);

  let cmd;
  let args;
  if (mode === 'standalone') {
    cmd = process.execPath;
    args = [path.join(ROOT, '.next', 'standalone', 'server.js')];
  } else if (mode === 'start' && nextBinExists) {
    cmd = process.execPath;
    args = [nextBin, 'start', '-p', String(ENV.port), '-H', '127.0.0.1'];
  } else if (nextBinExists) {
    cmd = process.execPath;
    // 与 dev.mjs 共用同一份判断：worktree 的 junction node_modules 需要 webpack
    const bundlerArgs = detectDevBundlerArgs(ROOT, []);
    const why = bundlerArgs.length > 0 ? explainBundlerChoice(ROOT) : '';
    if (why) log(`· ${why}`);
    args = [nextBin, 'dev', '-p', String(ENV.port), '-H', '127.0.0.1', ...bundlerArgs];
  } else {
    // 兜底：pnpm script（Windows 下需要 shell 才能执行 .cmd 垫片）
    cmd = 'pnpm';
    args = ['dev', '--', '-p', String(ENV.port), '-H', '127.0.0.1'];
  }

  serverLogPath = path.join(os.tmpdir(), `lumenote-smoke-${process.pid}.log`);
  const logStream = fs.createWriteStream(serverLogPath, { flags: 'w' });

  log(`· 启动应用：mode=${mode} port=${ENV.port}`);
  log(`  命令: ${cmd} ${args.join(' ')}`);
  log(`  日志: ${serverLogPath}`);

  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(ENV.port),
      HOSTNAME: '127.0.0.1',
      // 冒烟**永远**在 mock 模式：绝不因为环境残留（shell 里导出 MOCK_LLM=false、
      // .env.local 配了真实 Key）而真的调用付费模型。三个厂商 Key 一并清空，
      // 即使 mock 开关意外失效，应用也会在启动期直接失败，而不是静默产生费用。
      MOCK_LLM: 'true',
      DEEPSEEK_API_KEY: '',
      OPENAI_API_KEY: '',
      RESEND_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: cmd === 'pnpm' && IS_WIN,
  });

  child.stdout.on('data', (d) => logStream.write(d));
  child.stderr.on('data', (d) => logStream.write(d));
  child.on('exit', (code, signal) => {
    logStream.write(`\n[smoke] server exited code=${code} signal=${signal}\n`);
  });

  serverChild = child;
  return child;
}

/** 读服务端日志尾部：启动失败时最有用的诊断信息 */
function serverLogTail(maxLines = 40) {
  if (!serverLogPath || !fs.existsSync(serverLogPath)) return '(无日志)';
  const lines = fs.readFileSync(serverLogPath, 'utf8').split(/\r?\n/);
  return lines.slice(-maxLines).join('\n');
}

async function waitForHealth(child) {
  const deadline = Date.now() + ENV.startTimeoutMs;
  let lastErr = '';
  let exited = false;
  child?.once('exit', () => {
    exited = true;
  });

  while (Date.now() < deadline) {
    if (exited) {
      const tail = serverLogTail();
      throw new Error(`应用进程提前退出。服务端日志尾部：\n${tail}`);
    }
    try {
      const r = await request('GET', '/api/health', { timeoutMs: 5_000 });
      if (r.status === 200 && r.json?.db?.ok === true) {
        log(`· /api/health 就绪（启动后 ${nowMs() - SCRIPT_STARTED_AT}ms）`);
        return r.json;
      }
      lastErr = `HTTP ${r.status} ${snippet(r.text, 200)}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await sleep(500);
  }

  throw new Error(
    `等待 /api/health 超时（${ENV.startTimeoutMs}ms）。最后一次错误: ${lastErr}\n` +
      `服务端日志尾部：\n${serverLogTail()}`,
  );
}

function stopServer() {
  if (!serverChild || cleaned) return;
  cleaned = true;
  const pid = serverChild.pid;
  log(`· 清理子进程 (pid=${pid})…`);
  try {
    if (IS_WIN) {
      // Windows 上 next dev 会派生子进程，必须整棵树杀掉，否则 3200 端口会被占住
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      serverChild.kill('SIGTERM');
      setTimeout(() => {
        try {
          serverChild?.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      }, 3_000).unref();
    }
  } catch (e) {
    log(`  （清理失败，可手动 kill pid=${pid}：${e instanceof Error ? e.message : String(e)}）`);
  }
}

/** 无论怎么退出都清理自己启动的进程 */
function installCleanupHooks() {
  process.on('exit', () => {
    // 注意：exit 里不能跑异步逻辑，taskkill 用 spawnSync 是同步的，安全
    if (serverChild && !cleaned) {
      try {
        if (IS_WIN) spawnSync('taskkill', ['/PID', String(serverChild.pid), '/T', '/F'], { stdio: 'ignore' });
        else serverChild.kill('SIGTERM');
      } catch {
        /* 忽略 */
      }
    }
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log(`\n收到 ${sig}，中止并清理…`);
      stopServer();
      process.exit(130);
    });
  }
}

// ============================================================
// SSE 解析
// ============================================================

/**
 * 解析一个 SSE 帧（`event: X\ndata: {...}`）。
 * 注释帧（`: ping`，心跳）返回 null。
 */
function parseSseFrame(frame) {
  let event = 'message';
  const dataLines = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    /* 保留原文，断言时会打印 */
  }
  return { event, data, raw };
}

/**
 * 订阅任务 SSE，直到收到 done / error / 超时。
 *
 * 用 fetch + ReadableStream 而不是 EventSource：Node 没有内置 EventSource，
 * 且我们需要手动控制超时与「收到 done 就主动断开」。
 */
async function subscribeTaskStream(taskId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENV.streamTimeoutMs);
  const events = [];
  let response = null;

  try {
    response = await fetch(`${baseUrl()}/api/tasks/${taskId}/stream`, {
      headers: {
        Accept: 'text/event-stream',
        ...(cookieJar.size > 0 ? { Cookie: cookieHeader() } : {}),
      },
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      return { status: response.status, events, error: `SSE 订阅失败: HTTP ${response.status} ${snippet(text)}` };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const evt = parseSseFrame(frame);
        if (!evt) continue;
        events.push(evt);
        // 终止事件到达即可断开：服务端在 done 之后会关流，但客户端主动断开更省时
        if (evt.event === 'done') {
          reader.cancel().catch(() => {});
          return { status: response.status, events, error: null };
        }
      }
    }
    return { status: response.status, events, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: response?.status ?? 0,
      events,
      error: msg.includes('aborted') ? `SSE 订阅超时（${ENV.streamTimeoutMs}ms）` : `SSE 读取失败: ${msg}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 主流程
// ============================================================

const SUMMARIZE_DOC = [
  '# 可追溯的 AI 文本工作台',
  '',
  'AI 文本工具通常只关心「生成得快不快」，而忽略了一个更根本的问题：',
  '这条结果是怎么来的，半年后还能不能复现？',
  '',
  '## 三个可追溯的支点',
  '',
  '第一，Prompt 版本化。Prompt 存在数据库里并按版本递增，历史任务引用具体的版本行，',
  '因此修改提示词不会改变已经发生的事实，也不会让旧结果失去解释。',
  '',
  '第二，参数快照。温度、模型、分块大小、术语表这些影响输出的参数，',
  '在任务创建时随任务一起落库，而不是执行时现读 —— 后者会随着用户改配置而漂移。',
  '',
  '第三，用量与轨迹。Token 用量按任务结算一次（唯一约束保证幂等），',
  'Agent 任务还会记录每一步的工具调用与工具结果，供事后复盘推理路径。',
  '',
  '## 成本上的四条防线',
  '',
  '幂等键防止重复扣费；每日配额限制单用户总量；并发上限阻止一个人同时开五个标签页；',
  '前缀缓存把稳定内容前置，让输入 token 按 cache hit 计价。',
  '四条防线都落在数据库或请求层，不依赖「用户自觉」。',
].join('\n');

/** 当前跑批的唯一标识，用于标题与幂等键，避免与其他批次混淆 */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function main() {
  installCleanupHooks();
  const startedAt = nowMs();

  log('════════════════════════════════════════');
  log('Lumenote 冒烟测试（Mock LLM，无真实 API Key）');
  log(`目标: ${baseUrl()}   运行批次: ${RUN_ID}`);
  log('════════════════════════════════════════');

  // ---------- 0. 环境准备 ----------
  if (!baseOverride) {
    if (!ensureDatabase()) {
      process.exitCode = 1;
      return;
    }
    if (await tcpOpen('127.0.0.1', ENV.port)) {
      log(`✗ 端口 ${ENV.port} 已被占用。换一个端口：SMOKE_PORT=3210 node scripts/smoke.mjs`);
      process.exitCode = 1;
      return;
    }
    const child = spawnServer();
    try {
      await waitForHealth(child);
    } catch (e) {
      log(`✗ 应用启动失败：${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
      return;
    }
    // 用健康检查确认应用真的可服务（不是只开了端口）
    log('· 应用已就绪，开始跑链路');
  } else {
    // 外部服务：只做健康检查，不启动/不清理任何进程
    log('· 使用外部 SMOKE_BASE_URL，跳过启动');
    try {
      const r = await request('GET', '/api/health', { timeoutMs: 10_000 });
      if (!assertHttp('外部服务 /api/health', r, 200)) {
        process.exitCode = 1;
        return;
      }
    } catch (e) {
      log(`✗ 无法访问 ${baseUrl()}/api/health：${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
      return;
    }
  }
  let healthInfo = null;
  try {
    healthInfo = (await request('GET', '/api/health')).json;
  } catch {
    /* 已在上面校验过 */
  }

  // ---------- 1. 登录 ----------
  await step('登录演示账号', async () => {
    const r = await request('POST', '/api/auth/login', {
      body: { email: ENV.email, password: ENV.password },
    });
    assertHttp(`POST /api/auth/login`, r, 200);
    assert('响应包含用户信息', Boolean(r.json?.data?.user?.email), snippet(r.text));
    assert(
      '已收到 access cookie',
      cookieJar.has('lumenote_access'),
      `已收到的 cookie: ${[...cookieJar.keys()].join(', ') || '(无)'}`,
    );
    if (!cookieJar.has('lumenote_access')) {
      throw new Error(
        `登录未获得会话 cookie。若账号不存在，请先执行 pnpm prisma:seed（演示账号 ${ENV.email}）`,
      );
    }
  });

  // 登录失败就无须继续，否则后面所有请求都会 401，输出会一片噪声
  if (!cookieJar.has('lumenote_access')) {
    finishAndExit(startedAt);
    return;
  }

  // ---------- 1.5 预热路由（dev 模式首次请求要现场编译，不能算进性能断言） ----------
  await step('预热 /api/tasks 路由（丢弃一个无效请求）', async () => {
    // content 太短，必然 422；目的只是让 dev server 把该路由模块编译好
    const r = await request('POST', '/api/tasks', {
      headers: { 'Idempotency-Key': `smoke-warmup-${RUN_ID}` },
      body: { type: 'summarize', content: 'too short', params: {} },
    });
    assert(
      '预热请求被正确拒绝（参数校验）',
      r.status >= 400 && r.status < 500,
      `实际 HTTP ${r.status}: ${snippet(r.text)}`,
    );
    log(`  预热返回 HTTP ${r.status}（不影响后续断言）`);
  });

  const idempotencyKey = `smoke-${RUN_ID}`;
  let taskId = '';

  // ---------- 2. 创建摘要任务 ----------
  await step('创建摘要任务（带 Idempotency-Key）', async () => {
    const r = await request('POST', '/api/tasks', {
      headers: { 'Idempotency-Key': idempotencyKey },
      body: {
        type: 'summarize',
        inputType: 'text',
        title: `冒烟测试摘要 ${RUN_ID}`,
        content: SUMMARIZE_DOC,
        params: { style: '要点式', maxPoints: '5', targetReader: '普通读者' },
      },
    });
    assertHttp('POST /api/tasks', r, 200);
    taskId = String(r.json?.data?.taskId ?? '');
    assert('返回了 taskId', Boolean(taskId), snippet(r.text));
    assert('新建任务不是重放', r.json?.data?.replayed === false, `replayed=${r.json?.data?.replayed}`);
    /**
     * 两段式的核心指标：POST 只落库，绝不等待 LLM。
     *
     * dev 模式下第一次请求还要现场编译路由（几秒），所以阈值按模式区分 ——
     * 把编译时间算进「两段式性能」会得到一个随机失败的无意义断言。
     */
    const limitMs = serverMode === 'dev' ? 3_000 : 2_000;
    assert(
      `POST 快速返回（两段式：不执行 LLM，阈值 ${limitMs}ms）`,
      r.elapsedMs < limitMs,
      `实际耗时 ${r.elapsedMs}ms`,
    );
    log(`  taskId=${taskId}  POST 耗时=${r.elapsedMs}ms`);
    if (!taskId) throw new Error('没有 taskId，后续步骤无法进行');
  });

  if (!taskId) {
    finishAndExit(startedAt);
    return;
  }

  // ---------- 3. SSE 订阅 ----------
  let sseTokenText = '';
  let sseErrorEvent = null;
  let sseDone = null;

  await step('订阅 SSE 并校验事件流', async () => {
    const sse = await subscribeTaskStream(taskId);
    if (sse.error) {
      assert('SSE 订阅成功', false, sse.error);
      throw new Error(sse.error);
    }
    assert('SSE 订阅成功', true);
    const kinds = sse.events.map((e) => e.event);
    log(`  收到 ${sse.events.length} 个事件: ${[...new Set(kinds)].join(', ')}`);
    assert('收到 meta 事件（Prompt 指纹）', kinds.includes('meta'), `事件序列: ${kinds.join(' → ')}`);
    assert('收到 token 事件（正文增量）', kinds.includes('token'), `事件序列: ${kinds.join(' → ')}`);
    assert('收到 done 事件（终止态）', kinds.includes('done'), `事件序列: ${kinds.join(' → ')}`);

    sseTokenText = sse.events
      .filter((e) => e.event === 'token')
      .map((e) => (typeof e.data?.d === 'string' ? e.data.d : ''))
      .join('');
    sseTokenText = sseTokenText.trim();

    sseErrorEvent = sse.events.find((e) => e.event === 'error') ?? null;
    sseDone = sse.events.find((e) => e.event === 'done') ?? null;

    assert('token 拼接后有正文内容', sseTokenText.length > 0, `实际长度 ${sseTokenText.length}`);
    if (sseDone) {
      log(`  done.status=${sseDone.data?.status} degraded=${sseDone.data?.degraded}`);
    }
    if (sseErrorEvent) {
      log(`  error 事件: ${JSON.stringify(sseErrorEvent.data)}`);
    }
  });

  // ---------- 4. 轮询任务终态 ----------
  let detail = null;
  let terminal = null;

  await step('轮询 GET /api/tasks/:id 至终态', async () => {
    const deadline = Date.now() + ENV.taskTimeoutMs;
    let polls = 0;
    for (;;) {
      const r = await request('GET', `/api/tasks/${taskId}`);
      polls += 1;
      if (r.status !== 200) {
        assertHttp(`GET /api/tasks/${taskId}`, r, 200);
        throw new Error('轮询任务详情失败');
      }
      const d = r.json?.data;
      if (d && ['succeeded', 'failed', 'canceled'].includes(d.status)) {
        detail = d;
        terminal = d.status;
        log(`  第 ${polls} 次轮询到达终态: status=${d.status}`);
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `等待任务终态超时（${ENV.taskTimeoutMs}ms），最后状态=${d?.status ?? 'unknown'}`,
        );
      }
      await sleep(400);
    }
    assert(
      '任务到达终态（succeeded/failed/canceled）',
      Boolean(terminal),
      `terminal=${terminal}`,
    );
  });

  await step('校验任务终态与「Prompt 指纹」', async () => {
    if (!detail) {
      assert('任务详情可读', false, '详情为空');
      return;
    }
    if (detail.status === 'succeeded') {
      assert('任务 succeeded', true);
      assert(
        'outputContent 非空',
        typeof detail.outputContent === 'string' && detail.outputContent.length > 0,
        `实际长度 ${detail.outputContent?.length ?? 0}`,
      );
      assert(
        'SSE token 拼接内容与落库 outputContent 一致',
        sseTokenText.length > 0 && (detail.outputContent ?? '').includes(sseTokenText),
        `token=${sseTokenText.length} 字符, output=${(detail.outputContent ?? '').length} 字符`,
      );
      assert(
        '记录了 Prompt 版本（可追溯）',
        Boolean(detail.promptVersion?.templateName) && Number(detail.promptVersion?.version) > 0,
        JSON.stringify(detail.promptVersion ?? null),
      );
      assert(
        '记录了 Token 用量（成本可审计）',
        detail.usage !== null && Number(detail.usage?.outputTokens) > 0,
        JSON.stringify(detail.usage ?? null),
      );
      assert('未标记异常降级', detail.degraded === false, `degraded=${detail.degraded}`);
    } else {
      // 失败不是「静默通过」：必须带着明确的 errorCode / errorMessage 才算可解释
      const explainable = Boolean(detail.errorCode) && Boolean(detail.errorMessage);
      assert(
        '任务终态为 succeeded',
        false,
        `实际 ${detail.status}；errorCode=${detail.errorCode ?? '(无)'} message=${detail.errorMessage ?? '(无)'}` +
          (explainable ? '（失败原因明确，但仍视为冒烟失败）' : '（缺少可解释的失败原因）'),
      );
      log(`  ⚠️ 任务未成功：${detail.errorCode} — ${detail.errorMessage}`);
    }
    assert('任务耗时已记录', typeof detail.latencyMs === 'number' && detail.latencyMs >= 0, `latencyMs=${detail.latencyMs}`);
  });

  // ---------- 5. 幂等重放 ----------
  await step('幂等重放：同 key 不重复创建任务', async () => {
    const r = await request('POST', '/api/tasks', {
      headers: { 'Idempotency-Key': idempotencyKey },
      body: {
        type: 'summarize',
        inputType: 'text',
        title: `冒烟测试摘要 ${RUN_ID}`,
        content: SUMMARIZE_DOC,
        params: { style: '要点式', maxPoints: '5', targetReader: '普通读者' },
      },
    });
    assertHttp('重放 POST /api/tasks', r, 200);
    assert('重放被识别（replayed=true）', r.json?.data?.replayed === true, `replayed=${r.json?.data?.replayed}`);
    assert(
      '重放返回同一个 taskId',
      r.json?.data?.taskId === taskId,
      `期望 ${taskId}，实际 ${r.json?.data?.taskId}`,
    );
    // 重放的响应必须足够快：它根本不该碰到 LLM
    assert('重放响应 < 1s（未触发新任务）', r.elapsedMs < 1_000, `实际 ${r.elapsedMs}ms`);
    log(`  重放耗时=${r.elapsedMs}ms`);

    // 再取一次详情，确认状态与内容没有被重放改动
    const again = await request('GET', `/api/tasks/${taskId}`);
    assertHttp('重放后 GET 任务详情', again, 200);
    assert(
      '重放没有改变任务状态',
      again.json?.data?.status === detail?.status,
      `重放前=${detail?.status} 重放后=${again.json?.data?.status}`,
    );
    assert(
      '重放没有改变输出内容',
      again.json?.data?.outputContent === detail?.outputContent,
      'outputContent 发生变化',
    );
  });

  // ---------- 6. 健康信息（附带输出，便于排障） ----------
  if (healthInfo) {
    log(
      `\n· /api/health: db.ok=${healthInfo.db?.ok} db.latency=${healthInfo.db?.latencyMs}ms ` +
        `breakers=${healthInfo.breakers?.length ?? 0} uptime=${healthInfo.uptimeSec}s`,
    );
  }

  finishAndExit(startedAt);
}

function finishAndExit(startedAt) {
  const totalMs = nowMs() - startedAt;
  log('\n────────────────────────────────────────');
  log(`步骤耗时：${timings.map((t) => `${t.name}=${t.ms}ms`).join('，') || '(无)'}`);
  if (failures.length === 0) {
    log(`✓ 冒烟通过：${passed} 个断言全部成功，总耗时 ${totalMs}ms`);
    log('────────────────────────────────────────');
    process.exitCode = 0;
  } else {
    log(`✗ 冒烟失败：${passed} 个断言通过，${failures.length} 个失败，总耗时 ${totalMs}ms`);
    for (const f of failures) log(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
    log('────────────────────────────────────────');
    process.exitCode = 1;
  }
  stopServer();
}

main()
  .catch((e) => {
    log(`✗ 冒烟测试异常终止：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    stopServer();
  });

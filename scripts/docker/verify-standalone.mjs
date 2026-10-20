#!/usr/bin/env node
/**
 * ============================================================
 * standalone 产物端到端验证（Docker 不可用时的替代验证）
 * ============================================================
 *
 * 本机没有安装 Docker，`docker build` / `docker run` 无法执行。
 * 但镜像里真正需要被验证的东西不是 Docker 本身，而是：
 *
 *   1. `next build` 在 BUILD_STANDALONE=true 下真的产出了 standalone；
 *   2. 按 Dockerfile runner 的布局（standalone + static + public）摆放后，
 *      `node server.js` 能在 production 模式下启动；
 *   3. Prisma Client / pg / @prisma/adapter-pg 被 output tracing 正确带进
 *      standalone，因此 /api/health 返回 200 且 db.ok=true（连上真实 PostgreSQL）；
 *   4. 一条 mock 任务链路（注册 → 登录 → 建任务 → after() 执行完 → 查详情/SSE 回放）
 *      在 standalone 运行时可贯通 —— 这正是 Dockerfile 的 CMD 实际会跑的东西。
 *
 * 用法：
 *   node scripts/docker/verify-standalone.mjs [--keep]
 *
 * 前提（先构建）：
 *   $env:BUILD_STANDALONE='true'; pnpm build      # Windows PowerShell
 *   BUILD_STANDALONE=true pnpm build              # bash
 *
 * 注意（本地多 worktree 环境）：如果 node_modules 是指向主仓库的 junction，
 * Next 16 的 Turbopack 会直接 panic（"Symlink node_modules could not be resolved"）。
 * 这不是项目代码问题，先在当前 worktree 执行一次
 *   pnpm install --frozen-lockfile
 * 把它落成真实目录即可（不修改 package.json / pnpm-lock.yaml）。
 *
 * 运行期环境变量从 `.env.local` 读取（与本地开发一致），并强制覆盖：
 *   NODE_ENV=production、HOSTNAME=127.0.0.1、PORT（默认 3300，避免与本地 dev 冲突）。
 * 不会发起任何真实付费 LLM 调用：.env.local 里 MOCK_LLM=true。
 *
 * 退出码：0 = 全部断言通过；1 = 任一断言失败（会打印服务端日志尾部）。
 * ============================================================
 */

import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const standaloneDir = path.join(projectRoot, '.next', 'standalone');
const staticDir = path.join(projectRoot, '.next', 'static');
const publicDir = path.join(projectRoot, 'public');
const tmpRoot = path.join(projectRoot, '.tmp-standalone');
const keepTmp = process.argv.includes('--keep');
const port = Number(process.env.VERIFY_PORT ?? 3300);
const host = '127.0.0.1';
const baseUrl = `http://${host}:${port}`;

const failures = [];
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) failures.push({ name, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  return ok;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 .env.local 读取 KEY=VALUE（去掉引号与注释），与 Next.js 的约定一致 */
async function readEnvLocal() {
  const envPath = path.join(projectRoot, '.env.local');
  const text = await fs.readFile(envPath, 'utf8');
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2] ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

/** 在 .next/standalone 下找 server.js（兼容标准布局与 worktree 共享 node_modules 的嵌套布局） */
async function findServerJs(dir, depth = 0) {
  if (depth > 5) return null;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  // 同层优先，保证标准布局 .next/standalone/server.js 被最先命中
  if (entries.some((e) => e.isFile() && e.name === 'server.js')) {
    return path.join(dir, 'server.js');
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const found = await findServerJs(path.join(dir, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 建立目录链接（Windows 用 junction，Linux/macOS 用目录符号链接）。
 * 用途：在 .tmp-standalone 里挂载 .next 与 node_modules，避免复制整棵依赖树。
 */
async function linkDir(linkPath, targetPath) {
  if (process.platform === 'win32') {
    // mklink /J 创建 junction 不需要管理员/开发者模式权限
    const result = spawnSync('cmd', ['/d', '/c', 'mklink', '/J', linkPath, targetPath], {
      windowsHide: true,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`创建 junction 失败：${linkPath} -> ${targetPath}: ${result.stderr || result.stdout}`);
    }
    return;
  }
  await fs.symlink(targetPath, linkPath, 'dir');
}

/**
 * 清理 .tmp-standalone。
 *
 * ⚠️ 必须先删 .next / node_modules 这两个链接再递归删目录：
 * 某些 shell 的递归删除会跟随 junction 进入构建产物（曾经在 PowerShell 里踩到）。
 * Node 的 fs.rm 对符号链接只删链接本身，但这里仍显式先处理，避免依赖平台差异。
 */
async function removeTmpRoot() {
  if (!(await pathExists(tmpRoot))) return;
  for (const sub of ['node_modules', '.next']) {
    const target = path.join(tmpRoot, sub);
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      await fs.rm(target, { force: true }).catch(() => fs.rmdir(target).catch(() => {}));
    }
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

async function api(pathname, options = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
}

async function waitForHealth(deadlineMs) {
  const startedAt = Date.now();
  let lastError = 'no attempt';
  while (Date.now() - startedAt < deadlineMs) {
    try {
      const res = await api('/api/health');
      if (res.status === 200 || res.status === 503) return res;
      lastError = `status ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(400);
  }
  throw new Error(`等待 /api/health 超时（${deadlineMs}ms）：${lastError}`);
}

/** 注册需要一个真实验证码。console 通道会把它打印到服务端日志，这里从日志里取。 */
async function waitForVerificationCode(logPath, previousCount, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const log = await fs.readFile(logPath, 'utf8').catch(() => '');
    const codes = [...log.matchAll(/你的验证码是：(\d{6})/g)].map((m) => m[1]);
    if (codes.length > previousCount) return codes[codes.length - 1];
    await sleep(300);
  }
  throw new Error('15s 内没有在服务端日志里找到验证码');
}

async function countVerificationCodes(logPath) {
  const log = await fs.readFile(logPath, 'utf8').catch(() => '');
  return [...log.matchAll(/你的验证码是：(\d{6})/g)].length;
}

async function main() {
  console.log('== Lumenote standalone 产物验证 ==');
  console.log(`项目根目录: ${projectRoot}`);

  // ---------- 0. 构建产物是否齐全 ----------
  check('.next/standalone 存在', await pathExists(standaloneDir), standaloneDir);
  if (failures.length > 0) {
    console.error('\n请先构建：$env:BUILD_STANDALONE=\'true\'; pnpm build');
    process.exitCode = 1;
    return;
  }
  check('.next/static 存在', await pathExists(staticDir), staticDir);

  const serverJs = await findServerJs(standaloneDir);
  check('找到 standalone server.js', Boolean(serverJs), serverJs ?? '(未找到)');
  if (!serverJs) {
    process.exitCode = 1;
    return;
  }
  const nested = path.dirname(serverJs) !== standaloneDir;
  console.log(
    nested
      ? '布局: 嵌套（本地 worktree 共享 node_modules 时 Turbopack root 外移所致；容器内为标准布局）'
      : '布局: 标准（.next/standalone/server.js）',
  );

  // ---------- 1. 模拟镜像布局 ----------
  // Dockerfile runner 做的三件事：standalone → /app、.next/static → /app/.next/static、
  // public → /app/public。这里在 .tmp-standalone 里照做，入口仍是 `node server.js`。
  //
  // ⚠️ 不能直接整树复制：pnpm 的 node_modules 由大量 junction 组成，
  //    Node 的 fs.cp 在 Windows 上既不能重建 junction（EPERM，需要符号链接权限），
  //    展开复制又会破坏 pnpm 的兄弟依赖解析（典型症状：找不到 @swc/helpers）。
  //    所以这里把 server.js / package.json / public 复制成真实文件，
  //    而把 .next 与 node_modules 用目录链接挂到构建产物上 ——
  //    运行时解析到的模块与镜像里 node_modules 的内容是同一份 traced 产物。
  const appRoot = path.dirname(serverJs);
  await removeTmpRoot();
  await fs.mkdir(tmpRoot, { recursive: true });

  for (const file of ['server.js', 'package.json']) {
    const from = path.join(appRoot, file);
    if (await pathExists(from)) {
      await fs.copyFile(from, path.join(tmpRoot, file));
    }
  }
  // static 必须先进 appRoot/.next（对应 Dockerfile 的 COPY .next/static），
  // 否则通过 .next 链接访问不到它
  await fs.mkdir(path.join(appRoot, '.next'), { recursive: true });
  await fs.cp(staticDir, path.join(appRoot, '.next', 'static'), {
    recursive: true,
    force: true,
  });
  if (await pathExists(publicDir)) {
    await fs.cp(publicDir, path.join(tmpRoot, 'public'), { recursive: true, force: true });
  }
  await linkDir(path.join(tmpRoot, '.next'), path.join(appRoot, '.next'));
  await linkDir(path.join(tmpRoot, 'node_modules'), path.join(appRoot, 'node_modules'));

  const layoutOk =
    (await pathExists(path.join(tmpRoot, 'server.js'))) &&
    (await pathExists(path.join(tmpRoot, '.next', 'static'))) &&
    (await pathExists(path.join(tmpRoot, 'node_modules', 'next')));
  check('模拟镜像布局完成（node server.js + .next/static + public）', layoutOk, tmpRoot);
  if (!layoutOk) {
    process.exitCode = 1;
    return;
  }

  // ---------- 2. 运行期环境 ----------
  // 与 docker-compose 的 app environment 对齐：密钥只经 env 注入，镜像内没有 .env 文件。
  const envValues = await readEnvLocal();
  const childEnv = {
    ...process.env,
    ...envValues,
    NODE_ENV: 'production',
    HOSTNAME: host,
    PORT: String(port),
    NEXT_TELEMETRY_DISABLED: '1',
  };
  delete childEnv.BUILD_STANDALONE;
  delete childEnv.TURBOPACK_PROJECT_ROOT;

  check('MOCK_LLM=true（验证不会产生真实付费调用）', childEnv.MOCK_LLM === 'true', childEnv.MOCK_LLM);

  const logPath = path.join(tmpRoot, 'server.log');
  const outFd = openSync(logPath, 'a');
  const errFd = openSync(logPath, 'a');

  console.log(`\n启动: node server.js  (cwd=${tmpRoot}, ${host}:${port})`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: tmpRoot,
    env: childEnv,
    // 用文件描述符而非管道：容器里 stdout/stderr 也是文件描述符语义
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
  });

  const childExit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  try {
    // ---------- 3. /api/health：200 + db.ok=true ----------
    const health = await waitForHealth(60_000);
    const dbOk = Boolean(health.body?.db?.ok);
    check('/api/health 返回 200', health.status === 200, `status=${health.status}`);
    check(
      '/api/health db.ok=true（Prisma Client/驱动被 tracing 带入）',
      dbOk,
      `db.ok=${dbOk} latencyMs=${health.body?.db?.latencyMs}`,
    );
    console.log(
      `       health 响应: status=${health.body?.status} version=${health.body?.version} uptimeSec=${health.body?.uptimeSec}`,
    );

    // ---------- 4. 未登录访问受保护接口应 401 ----------
    const unauthorized = await api('/api/tasks?limit=1');
    check('未登录 GET /api/tasks 返回 401', unauthorized.status === 401, `status=${unauthorized.status}`);

    // ---------- 5. 注册（走真实验证码流程）----------
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const email = `standalone-verify-${stamp}@example.com`;
    const password = 'Lumenote-Verify-2026';
    const codesBefore = await countVerificationCodes(logPath);

    const verification = await api('/api/auth/verification', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, purpose: 'register' }),
    });
    check('POST /api/auth/verification 受理', verification.status === 200, `status=${verification.status}`);

    const code = await waitForVerificationCode(logPath, codesBefore, 15_000);
    check('从服务端日志取到 console 通道验证码', /^\d{6}$/.test(code), `code=${code.slice(0, 2)}****`);

    const register = await api('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, code }),
    });
    check('POST /api/auth/register 成功', register.status === 200, `status=${register.status}`);

    // ---------- 6. 登录（独立验证一次，后续用登录返回的 cookie）----------
    const login = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const loginCookies = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
    const cookie = loginCookies.join('; ');
    check('POST /api/auth/login 成功', login.status === 200, `status=${login.status}`);
    check('登录响应带会话 cookie', loginCookies.length > 0, `cookies=${loginCookies.length}`);

    // ---------- 7. 建任务：立即返回 taskId（两段式的第一段）----------
    const createStartedAt = Date.now();
    const content =
      'Lumenote 的 standalone 镜像验证文本。这里的内容不需要真实 LLM：' +
      'MOCK_LLM=true 时管线使用本地模拟流式输出，用于确认 after() 在独立进程里真的被执行。';
    const create = await api('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'summarize', content, title: 'standalone 验证任务' }),
    });
    const createMs = Date.now() - createStartedAt;
    const taskId = create.body?.data?.taskId;
    check('POST /api/tasks 返回已落库的 taskId', create.status === 200 && Boolean(taskId), `status=${create.status} taskId=${taskId ?? '-'}`);
    check('创建任务不等管线执行（两段式第一段 < 2s）', createMs < 2000, `耗时 ${createMs}ms`);

    // ---------- 8. after() 真的在运行时里跑完了 ----------
    let detail = null;
    const pollStartedAt = Date.now();
    while (Date.now() - pollStartedAt < 90_000) {
      const res = await api(`/api/tasks/${taskId}`, { headers: { cookie } });
      detail = res.body?.data ?? null;
      if (detail && (detail.status === 'succeeded' || detail.status === 'failed')) break;
      await sleep(500);
    }
    const finalStatus = detail?.status;
    check(
      'after() 异步管线在 standalone 运行时中完成（succeeded）',
      finalStatus === 'succeeded',
      `status=${finalStatus} latencyMs=${detail?.latencyMs ?? '-'}`,
    );
    check(
      '任务详情含落库的 outputContent',
      typeof detail?.outputContent === 'string' && detail.outputContent.length > 0,
      `outputContent=${detail?.outputContent?.length ?? 0} 字符`,
    );

    // ---------- 9. SSE 回放已完成任务（两段式的第二段）----------
    if (taskId) {
      const sse = await fetch(`${baseUrl}/api/tasks/${taskId}/stream`, {
        headers: { cookie, accept: 'text/event-stream' },
        signal: AbortSignal.timeout(30_000),
      });
      const sseText = await sse.text();
      check('GET /api/tasks/:id/stream 返回 SSE', sse.status === 200 && sseText.includes('event:'),
        `status=${sse.status} bytes=${sseText.length}`);
      check('SSE 回放包含 usage/done 事件',
        sseText.includes('event: usage') && sseText.includes('event: done'),
        `done=${sseText.includes('event: done')}`);
    }

    // ---------- 10. 列表接口（只读）----------
    const list = await api('/api/tasks?limit=5', { headers: { cookie } });
    check('GET /api/tasks 列表可用', list.status === 200 && Array.isArray(list.body?.data?.items),
      `status=${list.status} items=${list.body?.data?.items?.length ?? '-'}`);
  } catch (error) {
    check('验证流程未抛异常', false, error instanceof Error ? error.message : String(error));
  } finally {
    closeSync(outFd);
    closeSync(errFd);
    child.kill();
    const exited = await Promise.race([childExit, sleep(5000).then(() => null)]);
    if (exited === null && child.pid) {
      // Windows 上 SIGTERM 不一定能结束子进程，兜底强杀（仅本脚本自己起的进程）
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }
  }

  // ---------- 汇总 ----------
  const logTail = (await fs.readFile(logPath, 'utf8').catch(() => '')).trim().split(/\r?\n/).slice(-30);
  console.log('\n== 结果汇总 ==');
  const passed = checks.filter((c) => c.ok).length;
  console.log(`通过 ${passed}/${checks.length} 项断言`);
  for (const failure of failures) {
    console.log(`- 失败: ${failure.name}${failure.detail ? ` (${failure.detail})` : ''}`);
  }
  if (failures.length > 0) {
    console.log('\n== 服务端日志尾部 ==');
    console.log(logTail.join('\n'));
    process.exitCode = 1;
  }

  if (keepTmp) {
    console.log(`\n临时目录保留: ${tmpRoot}`);
    console.log(`服务端日志: ${logPath}`);
  } else {
    await removeTmpRoot();
    console.log('已清理 .tmp-standalone（如需保留请加 --keep）');
  }
}

main().catch((error) => {
  console.error('验证脚本异常：', error);
  process.exitCode = 1;
});

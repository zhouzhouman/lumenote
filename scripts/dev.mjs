/**
 * `pnpm dev` 的包装脚本：先确保 PostgreSQL 就绪，再启动 Next.js。
 *
 * 为什么需要它：
 *   项目依赖 PostgreSQL，但便携版/本地实例不随系统自启，以前要先手动
 *   双击 start-postgres.bat 再 pnpm dev，两步容易忘；现在一条命令搞定，
 *   且幂等 —— 数据库已在跑时直接跳过，不会重复启动。
 *
 * ## 数据库探测顺序（任何一步成功即停止，绝不静默假设数据库可用）
 *
 *   1. **已在运行** → 跳过启动（幂等）。探测方式二选一：
 *        - 找到 `pg_isready`（优先 PGHOME 内的 pgsql/bin 或 bin，其次 PATH），
 *          以它为准（端口 + 认证级别探测，最可靠）；
 *        - 找不到 pg_isready 时退化为 **TCP 连接探测**（只证明端口可连，
 *          不校验库/认证；跨平台无需安装客户端）。此时会打印一行说明。
 *   2. **设置了 PGHOME** → 用其中的 pg_ctl 启动本地实例。
 *      PGHOME 应指向含 `pgsql/bin`（或 `bin`）与 `pgdata`（或 `data`）的目录；
 *      可用 PGDATA / PGLOG 单独覆盖，适配 Linux 发行版把 bin 与 data 分开的布局。
 *   3. **未设置 PGHOME，但 docker 可用** → 安全回退
 *      `docker compose up -d postgres` 并等待健康（需要 docker-compose.yml）。
 *   4. 以上都不成立 → **明确报错并退出（非 0）**，附带可执行的修复指引。
 *
 * 换机器/换端口：设置 PGHOME / PGDATA / PGHOST / PGPORT / PGUSER / PGPASSWORD /
 * PGDATABASE 即可，无需改代码。敏感信息（密码）只以 *** 形式出现在日志里。
 *
 * ## 调试开关（方便在没有数据库的机器上验证「会不会正确失败」）
 *
 *   --dry-run   只做数据库探测/启动，然后退出，不启动 Next.js
 *   --skip-db   完全跳过数据库处理，直接启动 Next.js
 *   --help      打印用法
 *
 * 其余参数原样透传给 `next dev`（例如 `pnpm dev -- -p 3200`）。
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDevBundlerArgs, explainBundlerChoice } from './demo/bundler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

/** 只本脚本消费的开关，不透传给 next */
const LOCAL_FLAGS = new Set(['--dry-run', '--skip-db', '--help', '-h']);
const rawArgs = process.argv.slice(2);
const flags = {
  dryRun: rawArgs.includes('--dry-run'),
  skipDb: rawArgs.includes('--skip-db'),
  help: rawArgs.includes('--help') || rawArgs.includes('-h'),
};
/**
 * 去掉 `--` 分隔符本身。
 *
 * `pnpm dev -- -p 3200` 会把 `--` 之后的内容透传进来；而直接
 * `node scripts/dev.mjs -- -p 3200` 时 `--` 也会出现在 argv 里。
 * 若不剔除，Next 会把 `--` 当成「目录参数」的结束标记，
 * 于是 `-p` 被当作项目目录，报 "Invalid project directory provided"。
 */
const nextArgs = rawArgs.filter((a) => !LOCAL_FLAGS.has(a) && a !== '--');

/**
 * 连接参数：全部允许 PG* 环境变量覆盖。
 *
 * 默认值刻意用 127.0.0.1 而不是 localhost：
 * Windows 上 localhost 可能先解析到 ::1，而便携版 PostgreSQL 默认只监听 IPv4，
 * 表现为「服务明明在跑却连不上」。这是跨平台最常见的一类假故障。
 */
const HOST = process.env.PGHOST ?? '127.0.0.1';
const PORT = process.env.PGPORT ?? '5432';
const USER = process.env.PGUSER ?? 'lumenote';
const DATABASE = process.env.PGDATABASE ?? 'lumenote';
const PASSWORD = process.env.PGPASSWORD ?? '';
const READY_TIMEOUT_MS = Number(process.env.PG_READY_TIMEOUT_MS ?? 20_000);
const DOCKER_TIMEOUT_MS = Number(process.env.PG_DOCKER_TIMEOUT_MS ?? 120_000);

const log = (...a) => console.log('[lumenote]', ...a);
const warn = (...a) => console.warn('[lumenote]', ...a);

/** 只打印脱敏后的连接串，绝不把 PGPASSWORD 写进日志 */
function maskedConnectionUrl() {
  const auth = PASSWORD ? `${USER}:***` : USER;
  return `postgresql://${auth}@${HOST}:${PORT}/${DATABASE}`;
}

// ------------------------------------------------------------
// 工具查找（跨平台，处理 Windows 的 .exe 后缀）
// ------------------------------------------------------------

function withExe(p) {
  if (!p) return null;
  if (!IS_WIN || path.extname(p).toLowerCase() === '.exe') return p;
  const exe = `${p}.exe`;
  return fs.existsSync(exe) ? exe : p;
}

/** 返回第一个存在的文件路径；处理 Windows 下「传了无后缀路径」的情况 */
function firstExisting(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    const p = withExe(c);
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/** PGHOME 下的 bin 目录（兼容 pgsql/bin 与 bin 两种布局） */
function pgHomeBinDir() {
  const home = process.env.PGHOME;
  if (!home) return null;
  const candidates = [path.join(home, 'pgsql', 'bin'), path.join(home, 'bin')];
  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  return null;
}

/**
 * 查找 PostgreSQL 客户端工具。
 *
 * 顺序：PGHOME 内的 bin → 系统 PATH（Windows 用 where，其他平台用 which）。
 * 不假设任何机器绝对路径 —— 上一版把 `C:\Users\qwert\...` 写死，换机器即坏。
 */
function findPgTool(name) {
  const binDir = pgHomeBinDir();
  if (binDir) {
    const local = firstExisting([path.join(binDir, name)]);
    if (local) return local;
  }
  const lookup = spawnSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8' });
  if (lookup.status === 0) {
    const line = (lookup.stdout ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (line) return line;
  }
  return null;
}

/** docker 是否存在（没有 PGHOME 时的安全回退通道） */
function findDocker() {
  const lookup = spawnSync(IS_WIN ? 'where' : 'which', ['docker'], { encoding: 'utf8' });
  if (lookup.status !== 0) return null;
  const line = (lookup.stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line || null;
}

// ------------------------------------------------------------
// 就绪探测
// ------------------------------------------------------------

/**
 * pg_isready 探测。退出码 0 = 接受连接；1 = 拒绝（服务在跑但不可用）；
 * 2 = 无响应；3 = 参数错误。
 */
function pgIsReady(tool) {
  const r = spawnSync(
    tool,
    ['-h', HOST, '-p', PORT, '-U', USER, '-d', DATABASE, '-t', '5'],
    { stdio: 'pipe', encoding: 'utf8', env: process.env },
  );
  if (r.error) return { ready: false, reason: r.error.message };
  return { ready: r.status === 0, reason: (r.stderr || r.stdout || '').trim() };
}

/** TCP 端口探测：找不到 pg_isready 时的跨平台退化方案 */
function tcpProbe(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ready: ok, reason: reason ?? '' });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'TCP 连接超时'));
    socket.once('error', (e) => finish(false, e.message));
    socket.connect(Number(PORT), HOST);
  });
}

/** 探测数据库是否已经可用。保持同步语义便于调用方简单判断 */
async function isReady(pgIsReadyTool) {
  if (pgIsReadyTool) {
    const r = pgIsReady(pgIsReadyTool);
    return r.ready;
  }
  const r = await tcpProbe();
  return r.ready;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待就绪，每 5s 打一行进度，避免长时间静默 */
async function waitForReady(pgIsReadyTool, timeoutMs) {
  const startedAt = Date.now();
  let lastLogAt = 0;
  for (;;) {
    if (await isReady(pgIsReadyTool)) return true;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) return false;
    if (elapsed - lastLogAt >= 5_000) {
      lastLogAt = elapsed;
      log(`  等待 PostgreSQL 就绪…（${Math.round(elapsed / 1000)}s / ${Math.round(timeoutMs / 1000)}s）`);
    }
    await sleep(300);
  }
}

// ------------------------------------------------------------
// 失败指引
// ------------------------------------------------------------

function printNoDatabaseGuidance(pgIsReadyTool) {
  const probe = pgIsReadyTool
    ? `pg_isready (${pgIsReadyTool})`
    : 'TCP 端口探测（未找到 pg_isready，只能证明端口可连）';
  console.error('');
  console.error('[lumenote] ✗ 无法启动 PostgreSQL：既没有设置 PGHOME，本机也没有可用的 Docker。');
  console.error(`  探测目标: ${HOST}:${PORT}   探测方式: ${probe}`);
  console.error('  修复方式（任选一种）：');
  console.error('   1) 指向便携版 / 已安装的 PostgreSQL（目录需含 pgsql\\bin 与 pgdata）:');
  console.error(`        PowerShell:  $env:PGHOME = 'C:\\path\\to\\postgresql'; pnpm dev`);
  console.error(`        bash:        PGHOME=/opt/postgresql pnpm dev`);
  console.error('   2) 数据库其实已在运行：用 PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE 指向它后重试');
  console.error('   3) 安装 Docker Desktop 后执行:  docker compose up -d postgres');
  console.error('   提示：`node scripts/dev.mjs --dry-run` 只做数据库探测，便于排查；');
  console.error('         `--skip-db` 可跳过数据库处理直接启动 Next（数据库需自行保证可用）。');
  console.error('');
}

/** 进程级失败：统一以非 0 退出，绝不继续启动一个连不上库的应用 */
function die(message, extraLines = []) {
  console.error(`[lumenote] ✗ ${message}`);
  for (const line of extraLines) console.error(`  ${line}`);
  process.exit(1);
}

// ------------------------------------------------------------
// 分支 2：PGHOME 本地实例
// ------------------------------------------------------------

async function startFromPgHome(pgIsReadyTool, pgHome) {
  if (!fs.existsSync(pgHome) || !fs.statSync(pgHome).isDirectory()) {
    die(`PGHOME 指向的目录不存在: ${pgHome}`, [
      '请确认 PGHOME 指向含 pgsql/bin（或 bin）与 pgdata（或 data）的目录。',
      '若数据库本应在别处运行，请改用 PGHOST/PGPORT 指向它，或取消 PGHOME。',
    ]);
  }

  const binDir = pgHomeBinDir();
  if (!binDir) {
    die(`PGHOME 下找不到 pgsql/bin 或 bin 目录: ${pgHome}`, [
      '便携版 PostgreSQL 的典型布局: <PGHOME>/pgsql/bin + <PGHOME>/pgdata',
      'Linux 发行版通常是 bin 与 data 分离，请额外设置 PGDATA。',
    ]);
  }

  const pgCtl = firstExisting([path.join(binDir, 'pg_ctl')]);
  if (!pgCtl) {
    die(`在 ${binDir} 下找不到 pg_ctl`, [
      '该目录存在但不是 PostgreSQL 的 bin 目录？请检查 PGHOME。',
    ]);
  }

  /**
   * 数据目录：PGDATA 优先；否则在 PGHOME 下猜 pgdata / data。
   * 猜不到时用 pgdata 作为期望路径报错 —— 给的是「你该建在哪」的具体位置。
   */
  const dataCandidates = [
    process.env.PGDATA,
    path.join(pgHome, 'pgdata'),
    path.join(pgHome, 'data'),
  ].filter(Boolean);
  const dataDir = firstExisting(dataCandidates.filter((p) => p && fs.existsSync(p)));
  if (!dataDir) {
    die(`找不到 PostgreSQL 数据目录（PGHOME=${pgHome}）`, [
      `已尝试: ${dataCandidates.filter(Boolean).join(' / ')}`,
      '请用 PGDATA 显式指定数据目录，或先执行 initdb 初始化。',
    ]);
  }

  const logFile = process.env.PGLOG ?? path.join(pgHome, 'pg.log');
  log(`PostgreSQL 未就绪，正在通过 pg_ctl 启动 (${HOST}:${PORT}) …`);
  log(`  pg_ctl : ${pgCtl}`);
  log(`  PGDATA : ${dataDir}`);
  log(`  日志   : ${logFile}`);

  const r = spawnSync(
    pgCtl,
    ['-D', dataDir, '-l', logFile, '-o', `-p ${PORT}`, '-w', 'start'],
    { stdio: 'inherit', env: process.env },
  );

  if (r.status !== 0) {
    /**
     * 启动失败不立刻放弃：另一个终端/另一位开发者可能刚好同时把库拉起来了。
     * 重新探测一次，能起来就继续（并发启动是开发期的真实场景）。
     */
    if (await waitForReady(pgIsReadyTool, 5_000)) {
      log('✓ 检测到数据库已被其他进程启动，继续');
      return;
    }
    die('PostgreSQL 启动失败', [
      `请查看日志: ${logFile}`,
      '常见原因：端口被占用（改 PGPORT）、数据目录被另一个实例锁定、',
      '          数据目录版本与 bin 版本不一致、权限不足。',
    ]);
  }

  if (!(await waitForReady(pgIsReadyTool, READY_TIMEOUT_MS))) {
    die(`PostgreSQL 启动后 ${Math.round(READY_TIMEOUT_MS / 1000)}s 内仍未就绪`, [
      `请查看日志: ${logFile}`,
      '若日志显示 "database system is ready to accept connections"，',
      '但仍探测失败，请检查 PGHOST/PGPORT 是否与实例监听地址一致。',
    ]);
  }

  log(`✓ PostgreSQL 就绪: ${maskedConnectionUrl()}`);
}

// ------------------------------------------------------------
// 分支 3：docker compose 回退
// ------------------------------------------------------------

async function startWithDocker(pgIsReadyTool, docker) {
  const composeFile = path.join(ROOT, 'docker-compose.yml');
  if (!fs.existsSync(composeFile)) {
    die('未设置 PGHOME，虽然找到了 docker，但仓库内没有 docker-compose.yml，无法安全回退', [
      `期望文件: ${composeFile}`,
      '请设置 PGHOME 指向本地 PostgreSQL，或手动提供数据库。',
    ]);
  }

  log('未设置 PGHOME，检测到 docker —— 回退到 docker compose 启动 postgres 服务');
  /**
   * 何时必须开 shell：只有 PATH 上是 `.cmd` / `.bat` 垫片时才需要（企业环境常见），
   * 因为 Node 无法直接 spawn 批处理文件。
   *
   * ⚠️ 这里踩过坑：早期写成 `shell: IS_WIN` 一刀切，结果 `where docker` 返回的是
   * `C:\Program Files\Docker\Docker\resources\bin\docker.exe`，而 shell 模式下 Node
   * 把命令与参数**直接空格拼接**交给 cmd.exe —— 路径里的空格把命令切断了：
   *
   *     'C:\Program' is not recognized as an internal or external command
   *
   * 正确做法：真 `.exe` 时关掉 shell（spawn 自己处理含空格的路径，无需引号）；
   * 只有批处理垫片才开 shell，并且**显式加引号**。参数均为固定字面量，无注入面。
   */
  const isBatchShim = IS_WIN && /\.(cmd|bat)$/i.test(docker);
  const dockerCmd = isBatchShim ? `"${docker}"` : docker;
  const r = spawnSync(dockerCmd, ['compose', 'up', '-d', 'postgres'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: isBatchShim,
  });

  if (r.status !== 0) {
    die('docker compose up -d postgres 执行失败', [
      '若本机装有 PostgreSQL（便携版或系统安装），优先设置 PGHOME 指向它，不必用 Docker：',
      '  PowerShell:  $env:PGHOME=\'<含 pgsql/bin 与 pgdata 的目录>\'; pnpm dev',
      '否则确认 Docker Desktop / 守护进程已启动，然后重试；',
      '排查命令: docker compose ps && docker compose logs postgres',
    ]);
  }

  log(`等待容器健康（最长 ${Math.round(DOCKER_TIMEOUT_MS / 1000)}s）…`);
  if (!(await waitForReady(pgIsReadyTool, DOCKER_TIMEOUT_MS))) {
    die('docker compose 已执行，但 PostgreSQL 仍未就绪', [
      '排查命令: docker compose ps',
      '          docker compose logs postgres',
      '注意：docker-compose.yml 的 POSTGRES_DB 与 .env 的 DATABASE_URL 库名必须一致（当前均为 lumenote）；',
      '      若首次使用，请执行 pnpm prisma:deploy && pnpm prisma:seed。',
    ]);
  }

  log(`✓ PostgreSQL 就绪（docker）: ${maskedConnectionUrl()}`);
  log('  提示：容器库名由 docker-compose.yml 的 POSTGRES_DB 决定（当前 lumenote），');
  log('        与 .env.example 的 DATABASE_URL 保持一致；首次使用需跑 pnpm prisma:deploy。');
}

// ------------------------------------------------------------
// 数据库总入口
// ------------------------------------------------------------

async function ensureDatabase() {
  const pgIsReadyTool = findPgTool('pg_isready');
  const probeLabel = pgIsReadyTool ? path.basename(pgIsReadyTool) : 'TCP 端口探测';

  if (await isReady(pgIsReadyTool)) {
    log(`✓ PostgreSQL 已在运行 (${HOST}:${PORT})，跳过启动 [探测: ${probeLabel}]`);
    if (!pgIsReadyTool) {
      log('  说明：本机未找到 pg_isready，使用 TCP 端口探测（只证明端口可连，不校验库与认证）');
    }
    return;
  }

  if (!pgIsReadyTool) {
    log('本机未找到 pg_isready，使用 TCP 端口探测（只证明端口可连）');
  }
  log(`PostgreSQL 未就绪 (${HOST}:${PORT})，尝试自动启动…`);

  const pgHome = process.env.PGHOME?.trim();
  if (pgHome) return startFromPgHome(pgIsReadyTool, pgHome);

  const docker = findDocker();
  if (docker) return startWithDocker(pgIsReadyTool, docker);

  printNoDatabaseGuidance(pgIsReadyTool);
  process.exit(1);
}

// ------------------------------------------------------------
// 启动 next dev
// ------------------------------------------------------------

function startNext() {
  const localNext = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  const useLocal = fs.existsSync(localNext);

  /**
   * Next 16 的 dev 默认用 Turbopack，但它拒绝解析指向项目根之外的
   * node_modules 链接（多 worktree 的 junction 布局正是这种情况）。
   * 检测到该布局时自动改用 webpack，否则 dev server 会在启动阶段直接 panic。
   */
  const bundlerArgs = detectDevBundlerArgs(ROOT, nextArgs);
  if (bundlerArgs.length > 0) {
    const why = explainBundlerChoice(ROOT);
    if (why) log(why);
  }
  const devArgs = ['dev', ...nextArgs, ...bundlerArgs];

  /**
   * 用 `node <next 的 bin>` 而不是 shell 里的 `next`：
   *  - 免去 Windows 下 .cmd 垫片与 shell:true 的引号转义问题
   *  - 直接调用时也不要求 node_modules/.bin 在 PATH 里
   * 找不到本地 bin 时才退回 `next`（配合 shell 以兼容 .cmd 垫片）。
   */
  const child = useLocal
    ? spawn(process.execPath, [localNext, ...devArgs], {
        stdio: 'inherit',
        cwd: ROOT,
        env: process.env,
      })
    : spawn('next', devArgs, {
        stdio: 'inherit',
        cwd: ROOT,
        env: process.env,
        shell: IS_WIN,
      });

  if (!IS_WIN) {
    // POSIX 下派生的子进程不共享终端信号组，需要显式转发，Ctrl+C 才能优雅退出
    const forward = (signal) => () => {
      try {
        child.kill(signal);
      } catch {
        /* 子进程已退出 */
      }
    };
    process.on('SIGINT', forward('SIGINT'));
    process.on('SIGTERM', forward('SIGTERM'));
  }

  child.on('error', (e) => die(`无法启动 Next.js: ${e.message}`));
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

function printHelp() {
  console.log(`用法: node scripts/dev.mjs [next dev 参数] [选项]

确保 PostgreSQL 就绪后启动 Next.js 开发服务器。

选项:
  --dry-run   只做数据库探测/启动，然后退出（便于排查环境）
  --skip-db   跳过数据库处理，直接启动 Next.js
  --help      显示本帮助

环境变量:
  PGHOME      PostgreSQL 根目录（含 pgsql/bin 或 bin，以及 pgdata 或 data）
  PGDATA      数据目录（默认 <PGHOME>/pgdata 或 <PGHOME>/data）
  PGLOG       pg_ctl 日志文件（默认 <PGHOME>/pg.log）
  PGHOST      主机（默认 127.0.0.1）
  PGPORT      端口（默认 5432）
  PGUSER      用户（默认 lumenote）
  PGPASSWORD  密码（只以 *** 出现在日志中）
  PGDATABASE  数据库（默认 lumenote）
  PG_READY_TIMEOUT_MS   等待就绪上限（默认 20000）
  PG_DOCKER_TIMEOUT_MS  docker 回退等待上限（默认 120000）

示例:
  pnpm dev
  pnpm dev -- -p 3200
  PGHOME=/opt/postgresql pnpm dev
  node scripts/dev.mjs --dry-run`);
}

// ------------------------------------------------------------
// main
// ------------------------------------------------------------

async function main() {
  if (flags.help) {
    printHelp();
    return;
  }

  if (flags.skipDb) {
    warn('已指定 --skip-db，跳过数据库探测（应用可能因连不上库而报错）');
  } else {
    await ensureDatabase();
  }

  if (flags.dryRun) {
    log('✓ [--dry-run] 数据库探测完成，未启动 Next.js');
    return;
  }

  if (!flags.skipDb) log(`接下来启动 Next.js（数据库: ${maskedConnectionUrl()}）`);
  startNext();
}

main().catch((e) => {
  die(`启动失败: ${e instanceof Error ? e.message : String(e)}`);
});

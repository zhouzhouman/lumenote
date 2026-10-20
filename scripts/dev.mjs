/**
 * `pnpm dev` 的包装脚本：先确保便携版 PostgreSQL 就绪，再启动 Next.js。
 *
 * 为什么需要它：
 *   项目依赖 PostgreSQL，但便携版不随系统自启（没有注册 Windows 服务）。
 *   以前要先双击 start-postgres.bat 再 pnpm dev，两步容易忘；
 *   现在一条命令搞定，且幂等 —— 数据库已在跑时直接跳过，不会重复启动。
 *
 * 工作流程：
 *   1. pg_isready 探测 5432 端口（端口级探测，不依赖 pid 文件）
 *   2. 未运行 → pg_ctl start（postgres 由 pg_ctl 分离启动，不随本脚本退出而死）
 *   3. 轮询等待就绪（最长 20s），失败则打印日志位置并退出
 *   4. 就绪后以继承终端 stdio 的方式启动 next dev（Ctrl+C 正常退出）
 *
 * 换机器/换端口：设置环境变量 PGHOME / PGPORT 即可，无需改代码。
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PGHOME = process.env.PGHOME ?? 'C:\\Users\\qwert\\.workbuddy\\binaries\\postgresql';
const PGDATA = path.join(PGHOME, 'pgdata');
const PGLOG = path.join(PGHOME, 'pg.log');
const PGBIN = path.join(PGHOME, 'pgsql', 'bin');
const HOST = 'localhost';
const PORT = process.env.PGPORT ?? '5432';

/** 同步 sleep（阻塞主线程几毫秒级，仅启动期使用） */
const sleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** 端口级探测：0 = 接受连接。比 pg_ctl status 可靠（后者依赖 pid 文件，Windows 上会误判） */
function isReady() {
  const r = spawnSync(path.join(PGBIN, 'pg_isready.exe'), ['-h', HOST, '-p', PORT], {
    stdio: 'pipe',
  });
  return r.status === 0;
}

/** 轮询等待就绪，默认最长 20s */
function waitForReady(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isReady()) return true;
    sleep(300);
  }
  return false;
}

// ---------- 1. 确保数据库就绪 ----------
if (isReady()) {
  console.log(`[lumenote] PostgreSQL 已在运行 (${HOST}:${PORT})，跳过启动`);
} else {
  console.log(`[lumenote] PostgreSQL 未运行，正在启动 (${HOST}:${PORT}) ...`);
  const r = spawnSync(
    path.join(PGBIN, 'pg_ctl.exe'),
    ['-D', PGDATA, '-l', PGLOG, '-o', `-p ${PORT}`, 'start'],
    { stdio: 'inherit' },
  );
  if (r.status !== 0 || !waitForReady()) {
    console.error(`[lumenote] ✗ PostgreSQL 启动失败，请查看日志: ${PGLOG}`);
    process.exit(1);
  }
  console.log(`[lumenote] ✓ PostgreSQL 就绪: postgresql://lumenote:lumenote@${HOST}:${PORT}/lumenote`);
}

// ---------- 2. 启动 next dev ----------
// pnpm 执行 script 时会把 node_modules/.bin 加进 PATH，next 可直接调用；
// shell:true 兼容 Windows 下 .cmd 垫片。stdio 继承终端，Ctrl+C 一并退出。
const extraArgs = process.argv.slice(2);
const child = spawn('next', ['dev', ...extraArgs], {
  stdio: 'inherit',
  shell: true,
  cwd: path.resolve(__dirname, '..'),
});

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

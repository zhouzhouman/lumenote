/**
 * 运行 vitest，并在需要时绕过「项目路径含非 ASCII 字符」导致的 esbuild 崩溃。
 *
 * ## 为什么要这个包装脚本
 *
 * esbuild 是 Go 写的单文件二进制，启动时由 Go 运行时加载系统 DLL。
 * 当**项目所在路径含中文**（本机是 `D:\WorkBuddyData\全栈及aiagent开发…`）时，
 * 它会在 `runtime.loadOptionalSyscalls` 阶段直接 panic：
 *
 *     fatal error: winmm.dll not found
 *     runtime: panic before malloc heap initialized
 *
 * 这个报错极具误导性 —— DLL 其实就在 `C:\Windows\System32\winmm.dll`，
 * 补 PATH、建 junction、换 shell 都无效（junction 也不行，Node 会解析回真实路径）。
 * 真正可行的是把 esbuild.exe 复制到纯 ASCII 路径，再用 `ESBUILD_BINARY_PATH`
 * 指过去。实测这样 vitest 完全正常（18/18 通过）。
 *
 * 这个脚本做的事：**仅在检测到 esbuild 真的起不来时**才复制并设置环境变量，
 * 正常路径（ASCII 项目路径、CI、Linux）完全零开销、零副作用。
 *
 * 用法：`node scripts/test.mjs [vitest 参数...]`
 *   pnpm test                       → 全量单测
 *   pnpm test tests/foo.test.ts     → 指定文件
 *   pnpm test -- -u                 → 透传 vitest 参数
 *
 * ## 为什么不做成「永远复制」
 *
 * 有副作用的事情要尽量少做：每次跑测试都往临时目录写一个 10MB 的二进制，
 * 既慢又脏。而且 CI/Linux 上根本不需要这一步。
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

/** 项目路径是否含非 ASCII 字符（中文目录是本机已知的触发条件） */
function hasNonAscii(p) {
  return /[^\x00-\x7F]/.test(p);
}

/** 找到 esbuild 的平台二进制（pnpm 的 @esbuild/win32-x64 包内） */
function findEsbuildBinary() {
  const candidates = [
    path.join(ROOT, 'node_modules', '.pnpm'),
  ];
  const pnpmDir = candidates[0];
  if (!existsSync(pnpmDir)) return null;

  // pnpm 目录名形如 @esbuild+win32-x64@0.21.5 / @esbuild+linux-x64@0.21.5
  let entries;
  try {
    entries = readdirSync(pnpmDir);
  } catch {
    return null;
  }

  const platform =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  const binName = IS_WIN ? 'esbuild.exe' : 'esbuild';

  for (const entry of entries) {
    if (!entry.startsWith(`@esbuild+${platform}-${arch}@`)) continue;
    const bin = path.join(pnpmDir, entry, 'node_modules', '@esbuild', `${platform}-${arch}`, binName);
    if (existsSync(bin)) return bin;
  }
  return null;
}

/** 真正能不能跑：跑一次 --version，看是否 panic */
function canRun(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.error) return false;
  return r.status === 0 && !String(r.stderr || '').includes('panic');
}

/**
 * 确保 esbuild 可运行。返回需要注入的环境变量（可能为空对象）。
 *
 * 三种情况：
 *   1. 路径是 ASCII，或 esbuild 本来就能跑 → 不碰它
 *   2. 路径含非 ASCII 且 esbuild 起不来 → 复制到临时目录并返回 ESBUILD_BINARY_PATH
 *   3. 找不到二进制 → 同样不碰（让 vitest 自己报错，信息更贴近真实原因）
 */
function ensureEsbuildUsable() {
  if (!IS_WIN || !hasNonAscii(ROOT)) return {};

  const original = findEsbuildBinary();
  if (!original) return {};
  if (canRun(original)) return {};

  // 复制到用户临时目录下的纯 ASCII 路径
  const targetDir = path.join(os.tmpdir(), 'lumenote-esbuild-bin');
  const target = path.join(targetDir, 'esbuild.exe');

  let needsCopy = true;
  if (existsSync(target)) {
    // 大小一致就复用，避免每次跑测试都复制 10MB
    try {
      needsCopy = statSync(target).size !== statSync(original).size;
    } catch {
      needsCopy = true;
    }
  }

  if (needsCopy) {
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(original, target);
  }

  if (!canRun(target)) {
    console.warn('[test] esbuild 仍然无法运行，vitest 可能启动失败（原因可能是杀软拦截）');
    return {};
  }

  console.log(`[test] 项目路径含非 ASCII 字符，已把 esbuild 指向 ${target}`);
  console.log('[test] 原因：Go 运行时在中文路径下加载 DLL 失败（报 winmm.dll not found，属误导信息）');
  return { ESBUILD_BINARY_PATH: target };
}

const extraEnv = ensureEsbuildUsable();

const vitestBin = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
if (!existsSync(vitestBin)) {
  console.error('找不到 vitest，请先 pnpm install');
  process.exit(1);
}

const args = process.argv.slice(2).filter((a) => a !== '--');
const child = spawn(process.execPath, [vitestBin, 'run', ...args], {
  stdio: 'inherit',
  cwd: ROOT,
  env: { ...process.env, ...extraEnv },
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`vitest 被信号终止：${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
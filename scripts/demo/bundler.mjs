/**
 * 开发模式打包器选择（dev.mjs 与 smoke.mjs 共用）。
 *
 * ## 为什么需要它
 *
 * Next.js 16 的 `next dev` 默认走 Turbopack。Turbopack 在解析 symlink 时
 * 只允许目标落在项目根内；而本项目为了多 worktree 并行开发、节省磁盘，
 * 会把 `node_modules` 做成**指向主仓库的 junction/symlink**。
 * 这种情况下 Turbopack 启动即 panic：
 *
 *   TurbopackInternalError: Symlink node_modules could not be resolved:
 *   the symlink target leaves the filesystem root ...
 *
 * 表现是「编译到一半进程直接退出」，日志只在临时目录的 panic 文件里，
 * 排查成本很高。webpack 对此没有限制，所以检测到这种布局就自动加 `--webpack`。
 *
 * 优先级：
 *   1. 命令行显式给了 --turbo/--turbopack/--webpack → 尊重用户
 *   2. 环境变量 NEXT_DEV_BUNDLER=webpack|turbopack → 尊重显式配置
 *   3. node_modules 的真实路径在项目根之外 → webpack
 *   4. 其余情况 → 不加参数（用 Next 默认的 Turbopack）
 */

import fs from 'node:fs';
import path from 'node:path';

/** 该路径是否位于 root 之外（root 之外的 symlink 目标会让 Turbopack 报错） */
function isOutside(root, target) {
  const rel = path.relative(root, target);
  return rel.startsWith('..') || path.isAbsolute(rel);
}

/**
 * 返回需要追加到 `next dev` 的参数数组（可能为空）。
 *
 * @param {string} rootDir 项目根目录（绝对路径）
 * @param {string[]} explicitArgs 用户透传的参数
 * @returns {string[]}
 */
export function detectDevBundlerArgs(rootDir, explicitArgs = []) {
  const explicit = new Set(explicitArgs);
  if (explicit.has('--turbo') || explicit.has('--turbopack') || explicit.has('--webpack')) {
    return [];
  }

  const forced = (process.env.NEXT_DEV_BUNDLER ?? '').trim().toLowerCase();
  if (forced === 'webpack') return ['--webpack'];
  if (forced === 'turbopack') return [];

  try {
    const modulesDir = path.join(rootDir, 'node_modules');
    if (!fs.existsSync(modulesDir)) return [];
    const realRoot = fs.realpathSync(rootDir);
    const realModules = fs.realpathSync(modulesDir);
    if (isOutside(realRoot, realModules)) return ['--webpack'];
  } catch {
    // realpath 失败（权限、路径不存在）时不冒险改变行为，交给 Next 默认
  }
  return [];
}

/** 是否因为「node_modules 在项目根之外」而选择了 webpack（用于打印解释） */
export function explainBundlerChoice(rootDir) {
  try {
    const realRoot = fs.realpathSync(rootDir);
    const realModules = fs.realpathSync(path.join(rootDir, 'node_modules'));
    if (isOutside(realRoot, realModules)) {
      return `node_modules 指向项目根之外的 ${realModules}，Turbopack 无法解析该链接 → 使用 webpack 编译（NEXT_DEV_BUNDLER=turbopack 可强制覆盖）`;
    }
  } catch {
    /* 忽略 */
  }
  return '';
}

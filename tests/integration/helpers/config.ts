/**
 * 集成测试的共享配置解析（**零 vitest 依赖**）。
 *
 * 这个文件同时被 `vitest.integration.config.ts`（主进程加载配置时）和
 * `global-setup.ts`（主进程启动服务时）以及测试进程（helpers 里）引用，
 * 所以它不能 import vitest，也不能有副作用。
 *
 * 设计前提：
 *  - **不读 `.env.local`**。CI 没有这个文件，而本地有一个指向测试库的文件。
 *    依赖它会让「本地能跑、CI 挂」这种最难排查的问题出现。
 *  - 所有值优先取环境变量，取不到时回落到本机开发环境的既定事实
 *    （PostgreSQL 16 / 用户密码库名均为 lumenote / 测试库 lumenote_test）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 本机开发环境的测试库（与 worktree 的 .env.local 一致，但这里是显式默认值） */
export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://lumenote:lumenote@127.0.0.1:5432/lumenote_test?schema=public';

/** 集成测试默认端口。刻意避开 3000，避免撞上本地 dev server */
export const DEFAULT_INTEGRATION_PORT = 3210;

/** 项目根目录。vitest 的 cwd 恒为项目根（package.json 所在目录） */
export function projectRoot(): string {
  return process.cwd();
}

export function resolveDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_TEST_DATABASE_URL;
}

/**
 * Prisma CLI 迁移用的直连地址。
 *
 * 本地/CI 都是直连，因此默认与 DATABASE_URL 相同；只有接入 PgBouncer
 * 这类池化代理时才需要单独给 DIRECT_URL（DDL 在事务池下会失败）。
 */
export function resolveDirectUrl(): string {
  const raw = process.env.DIRECT_URL?.trim();
  return raw && raw.length > 0 ? raw : resolveDatabaseUrl();
}

export function resolveIntegrationPort(): number {
  const raw = Number(process.env.INTEGRATION_PORT ?? DEFAULT_INTEGRATION_PORT);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 65_535) return DEFAULT_INTEGRATION_PORT;
  return Math.floor(raw);
}

/**
 * AUTH_SECRET 兜底。
 *
 * env.ts 要求至少 16 字符。CI 的 integration job 已注入 AUTH_SECRET，
 * 这里兜底是为了「本地不配任何 env 也能跑」——这是集成测试能不能被
 * 日常使用的关键，需要手动 export 一堆变量的测试最终没人跑。
 */
export function resolveAuthSecret(): string {
  const raw = process.env.AUTH_SECRET?.trim();
  return raw && raw.length >= 16 ? raw : 'integration-test-secret-at-least-32-characters';
}

/** 被测应用地址：允许复用外部已启动的服务（INTEGRATION_BASE_URL） */
export function resolveBaseUrl(): string {
  const external = process.env.INTEGRATION_BASE_URL?.trim();
  if (external) return external.replace(/\/+$/, '');
  return `http://127.0.0.1:${resolveIntegrationPort()}`;
}

export function prismaCliPath(root = projectRoot()): string {
  return path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
}

export function tsxCliPath(root = projectRoot()): string {
  return path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
}

export function nextCliPath(root = projectRoot()): string {
  return path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
}

/**
 * `next dev` 的打包器选择。
 *
 * 与 `scripts/demo/bundler.mjs` 同一套判断（那里是 dev.mjs / smoke.mjs 共用的）：
 * Turbopack 无法解析「node_modules 是指向项目根之外的 junction/symlink」的布局，
 * 会直接 panic。本 worktree 已用真实 node_modules，但主仓库的其他 worktree
 * 可能仍是 junction，所以这里保留判断以保持行为一致。
 */
export function detectDevBundlerArgs(root = projectRoot()): string[] {
  const forced = (process.env.NEXT_DEV_BUNDLER ?? '').trim().toLowerCase();
  if (forced === 'webpack') return ['--webpack'];
  if (forced === 'turbopack') return [];

  try {
    const modulesDir = path.join(root, 'node_modules');
    if (!fs.existsSync(modulesDir)) return [];
    const realRoot = fs.realpathSync(root);
    const realModules = fs.realpathSync(modulesDir);
    const rel = path.relative(realRoot, realModules);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return ['--webpack'];
  } catch {
    // realpath 失败（权限/路径不存在）时不冒险改变行为，交给 Next 默认
  }
  return [];
}

import { defineConfig, configDefaults } from 'vitest/config';
import * as path from 'node:path';
import { resolveAuthSecret, resolveDatabaseUrl, resolveDirectUrl } from './tests/integration/helpers/config';

/**
 * 集成测试专用配置（`pnpm test:integration`）。
 *
 * 与默认的 `vitest.config.ts` 是**两套独立的 test 配置**，互不影响：
 *  - 默认配置只跑纯逻辑单测（不连库、不起服务），保持毫秒级反馈；
 *  - 本配置跑真实 Postgres + 真实 HTTP（next dev），因此有 globalSetup
 *    负责「重置库 → migrate deploy → seed → 起服务 → 等 /api/health」。
 *
 * ## 关键配置的取舍
 *
 * - `fileParallelism: false`：所有测试文件共享同一个数据库与同一个服务进程。
 *   并行文件会互相干扰（一个文件在跑 seed、另一个在断言行数）。
 *   代价是总耗时变成各文件之和，但换来的是确定性。
 * - `testTimeout: 60s`：dev 模式首次访问某个路由要现场编译（1-2s），
 *   加上 mock 管线本身 1-3s、长文多分块更久，30s 在慢 CI 上不够稳。
 * - `hookTimeout: 120s`：globalSetup 要跑 migrate + seed + next dev 启动。
 * - 测试进程自身也配了 DATABASE_URL / AUTH_SECRET / MOCK_LLM：
 *   部分用例需要 import 解析 `@/lib/pipeline/runner` 直接跑失败路径，
 *   而该模块的 env() 在模块加载时就会校验这些变量。
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    exclude: [...configDefaults.exclude],
    environment: 'node',

    /** 环境准备/清理（重置 DB、迁移、seed、启动/杀死 next dev） */
    globalSetup: ['tests/integration/global-setup.ts'],
    /** 每个测试文件结束时断开测试侧 Prisma 连接 */
    setupFiles: ['tests/integration/helpers/setup.ts'],

    /**
     * ⚠️ 共享数据库 + 共享服务进程 → 必须串行。
     * 这里同时关掉文件的并行与文件内测试的并发，避免时序互相污染。
     */
    fileParallelism: false,
    sequence: { concurrent: false },

    testTimeout: 60_000,
    hookTimeout: 120_000,

    /**
     * 测试进程（vitest worker）的环境变量。
     *
     * ⚠️ 这里不能读 `.env.local`：CI 没有该文件。所有值都从进程环境取，
     * 取不到时回落到本机开发环境的既定事实（见 helpers/config.ts）。
     * 这些变量主要供「在测试进程内 import @/lib/* 直接执行」的用例使用，
     * 被测应用（next dev）的 env 由 global-setup.ts 显式注入。
     */
    env: {
      NODE_ENV: 'test',
      AUTH_SECRET: resolveAuthSecret(),
      DATABASE_URL: resolveDatabaseUrl(),
      DIRECT_URL: resolveDirectUrl(),
      MOCK_LLM: 'true',
      DEFAULT_MODEL: 'deepseek-flash',
    },
  },
  resolve: {
    alias: {
      // 与 tsconfig paths 保持一致，让测试能用 '@/...' 导入 src 下的模块
      '@': path.resolve(__dirname, './src'),
    },
  },
});

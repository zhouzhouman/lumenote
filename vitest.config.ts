import { defineConfig, configDefaults } from 'vitest/config';
import * as path from 'node:path';

export default defineConfig({
  test: {
    /**
     * 只跑纯逻辑单测，不跑需要数据库/网络的集成测试。
     *
     * 理由：集成测试依赖真实 Postgres 与一个 next dev 进程，
     * 在 CI 与本地都要额外起服务，会掩盖「单元测试应当毫秒级反馈」这个核心价值。
     * 需要 DB/HTTP 的用例放在 `tests/integration/**`，由
     * `vitest.integration.config.ts`（`pnpm test:integration`）单独运行；
     * 两套配置共用同一批 `.test.ts` 后缀，所以必须在这里显式排除，
     * 否则 CI 的 verify job（没有数据库）会整批失败。
     *
     * 也收 .tsx：组件级的 SSR 安全测试需要真的渲染一次 React 树，
     * 那是唯一能发现「客户端组件在服务端读了 window」的手段
     * （tsc 和 ESLint 都不做运行环境检查）。
     */
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    /**
     * 排除集成/E2E 测试：它们需要 `pnpm test:integration` 的 globalSetup
     * （重置数据库、跑迁移、seed、启动应用）。漏掉这两条排除会直接
     * 让 `pnpm test` 连库失败 —— 这正是本配置要防的事。
     *
     * 用 configDefaults.exclude 展开而不是覆盖：默认排除项包含
     * node_modules / dist / 各类配置文件，覆盖掉会导致 vitest 扫描到
     * 依赖目录里的测试文件。
     */
    exclude: [...configDefaults.exclude, 'tests/integration/**', 'tests/e2e/**'],
    environment: 'node',

    /**
     * 单测里会import 一些模块，它们顶层就会读环境变量。
     * 这里给出最小可用的假值，避免因缺DATABASE_URL 而整批测试挂掉。
     */
    env: {
      NODE_ENV: 'test',
      AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/lumenote_test',
      MOCK_LLM: 'true',
      DEFAULT_MODEL: 'deepseek-flash',
    },

    // 单文件内部串行执行，避免共享内存态（如熔断器）互相干扰
    sequence: { concurrent: false },
    coverage: {
      provider: 'v8',
      /**
       * 覆盖率统计范围：只统计 `src/lib/**` 的纯逻辑。
       *
       * ## 为什么这样限定（局限要讲清楚）
       *
       * - 排除 `src/app/**`：路由是 HTTP 层，靠集成测试覆盖；它一被 import
       *   就会把 next/server 的请求上下文带进来，在纯单测里根本没有意义。
       * - 排除 `src/lib/db.ts` / `env.ts`：前者需要真实数据库连接，
       *   后者是启动期环境校验，都属于「集成测试才该验证」的部分。
       * - 因此这个百分比**只代表纯逻辑单测的覆盖**，不代表产品的整体验证程度：
       *   路由、SSE、数据库事务、越权与幂等这些真正容易出问题的路径
       *   由 `pnpm test:integration`（tests/integration）覆盖。
       *   不要把覆盖率数字当成「集成路径已被覆盖」的证据。
       */
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/db.ts', 'src/lib/env.ts', 'src/app/**'],
      /**
       * 防倒退阈值（thresholds）。
       *
       * 数据来自 **2026-10-20 最新实测基线**（`pnpm test:coverage`，32 个测试文件 /
       * 661 个单测通过；含 observability 与安全修复后的统计）：
       *   statements 41.03% / branches 82.90% / functions 71.64% / lines 41.03%
       * 阈值按基线**向下取整**（不取整会让 CI 因浮点微抖动变红）：
       *   41 / 82 / 71 / 41。
       *
       * 目的：现在必须通过，未来覆盖率下降会失败。**不要为了好看调高到会失败的值**；
       * 后续新增纯逻辑测试把覆盖率抬高后，应同步上调到新的「向下取整基线」。
       * （阈值必须跟着实测基线走，不能反过来 —— 历史上出现过阈值高于新基线导致
       *   门禁红灯的情况，原因是新增模块拉低了 functions 覆盖率。）
       */
      thresholds: {
        statements: 41,
        branches: 82,
        functions: 71,
        lines: 41,
      },
    },
  },
  resolve: {
    alias: {
      // 与 tsconfig paths 保持一致，让测试能用 '@/...' 导入
      '@': path.resolve(__dirname, './src'),
    },
  },
});
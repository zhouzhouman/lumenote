import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

export default defineConfig({
  test: {
    /**
     * 只跑纯逻辑单测，不跑需要数据库/网络的集成测试。
     *
     * 理由：集成测试依赖 Postgres 容器，在 CI 与本地都要额外起服务，
     * 反而掩盖了「单元测试应当毫秒级反馈」这个核心价值。
     * 涉及 DB 的部分（幂等、越权、配额）通过手工验收脚本覆盖
     * （见 scripts/verify-byok.e2e.mjs）。
     *
     * 也收 .tsx：组件级的 SSR 安全测试需要真的渲染一次 React 树，
     * 那是唯一能发现「客户端组件在服务端读了 window」的手段
     * （tsc 和 ESLint 都不做运行环境检查）。
     */
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
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
      include: ['src/lib/**/*.ts'],
      // 只统计纯逻辑，路由与页面靠手工验收
      exclude: ['src/lib/db.ts', 'src/lib/env.ts', 'src/app/**'],
    },
  },
  resolve: {
    alias: {
      // 与 tsconfig paths 保持一致，让测试能用 '@/...' 导入
      '@': path.resolve(__dirname, './src'),
    },
  },
});
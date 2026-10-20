import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 把超大依赖排除在客户端 bundle 之外
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  // standalone 产物，供 Dockerfile 使用。
  // Dockerfile 的 builder 阶段显式 `ENV BUILD_STANDALONE=true`，与这里的开关一致；
  // 本地 `pnpm start` 不设置该变量，走普通构建（保持本地开发路径不变）。
  output: process.env.BUILD_STANDALONE === 'true' ? 'standalone' : undefined,
};

export default nextConfig;

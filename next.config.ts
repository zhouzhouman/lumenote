import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 把超大依赖排除在客户端 bundle 之外
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  // standalone 产物，供 Dockerfile 使用（备选部署路径）
  output: process.env.BUILD_STANDALONE === 'true' ? 'standalone' : undefined,
};

export default nextConfig;
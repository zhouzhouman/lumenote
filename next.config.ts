import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 把超大依赖排除在客户端 bundle 之外
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  /*
   * nodemailer 不要被打包：它内部用动态 require 探测可选依赖
   * （如 SMTP 连接池），被 webpack/turbopack 静态化后会在运行时找不到模块。
   * 它只在 MAIL_TRANSPORT=smtp 时被动态 import，放 external 不影响其它部署形态。
   */
  serverExternalPackages: ['nodemailer'],
  // standalone 产物，供 Dockerfile 使用。
  // Dockerfile 的 builder 阶段显式 `ENV BUILD_STANDALONE=true`，与这里的开关一致；
  // 本地 `pnpm start` 不设置该变量，走普通构建（保持本地开发路径不变）。
  output: process.env.BUILD_STANDALONE === 'true' ? 'standalone' : undefined,
};

export default nextConfig;

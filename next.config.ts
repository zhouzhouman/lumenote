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
  /*
   * 显式把 nodemailer 塞进 standalone 产物。
   *
   * 它是**动态 import** 且被标记为 external，依赖打包器的追踪启发式来决定
   * 「要不要带上」是有风险的 —— 一旦漏掉，本地开发完全正常，镜像是
   * `MODULE_NOT_FOUND`，而报错发生在用户点「获取验证码」的时候。
   * 这类「只在镜像里坏」的问题排查成本极高，用几 MB 换确定性是划算的。
   */
  outputFileTracingIncludes: {
    '/**': ['./node_modules/nodemailer/**/*'],
  },
  // standalone 产物，供 Dockerfile 使用。
  // Dockerfile 的 builder 阶段显式 `ENV BUILD_STANDALONE=true`，与这里的开关一致；
  // 本地 `pnpm start` 不设置该变量，走普通构建（保持本地开发路径不变）。
  output: process.env.BUILD_STANDALONE === 'true' ? 'standalone' : undefined,
};

export default nextConfig;

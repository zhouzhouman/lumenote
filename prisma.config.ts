// Prisma CLI 配置（Prisma ORM v7 新方式）
//
// v7 的变化（相对 v6）：
//   1. 连接串从 schema.prisma 的 datasource.url 移到这里
//   2. datasource.directUrl 已被移除 —— 需要直连时用下面的 shadowDatabaseUrl / 单独跑迁移
//   3. PrismaClient 运行时不再靠 schema 里的 url，而是通过 driver adapter 接收连接
//
// 直连（绕过连接池）的做法：
//   本地/自建库：url 就填直连地址，无需额外配置
//   使用 PgBouncer 等池化（如 Neon）：迁移时用 `DIRECT_URL` 覆盖，
//   即 `DIRECT_URL=... pnpm prisma:migrate`
// 注意：dotenv 默认只读 .env，而本项目的环境变量在 .env.local（与 Next.js 约定一致）。
// 必须显式指定路径，否则 prisma migrate/seed 会报 "Connection url is empty"。
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // 直连优先：迁移类命令需要真实连接，池化地址会导致 DDL 失败
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '',
  },
});
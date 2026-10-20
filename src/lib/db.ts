import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Prisma 单例。
 *
 * Next.js 开发模式下模块会被反复热重载，若每次都new PrismaClient，
 * 连接池会不断累积直到数据库拒绝连接。挂到 globalThis 上是标准解法。
 *
 * Prisma ORM v7 不再从 schema 读连接串，改为通过 driver adapter 注入：
 * PrismaPg 包裹 node-postgres 的连接池，池大小由 max 明确指定 ——
 * 这比 v6 的内建池更可控，尤其在 Serverless 环境下（每个实例独立计数）。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL 未配置，无法初始化 Prisma Client');
  }

  // Serverless 单实例复用连接；开发环境放宽以适应热重载
  const max = process.env.VERCEL_ENV ? 1 : 5;
  const adapter = new PrismaPg({ connectionString: url, max });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
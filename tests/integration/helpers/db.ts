/**
 * 测试侧的 Prisma client（**直连真实测试库**）。
 *
 * 这里刻意不复用 `@/lib/db` 的单例：
 *  - 测试进程与被测应用是**两个独立进程**，各自持有连接池；
 *  - 测试需要在应用之外直接改库（例如把用户 dailyQuota 改成 1、插入一条坏任务），
 *    走独立的 client 语义更清楚，也不会影响应用侧行为。
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { resolveDatabaseUrl } from './config';

let client: PrismaClient | null = null;

export function db(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: resolveDatabaseUrl(), max: 3 }),
    });
  }
  return client;
}

export async function closeDb(): Promise<void> {
  const current = client;
  client = null;
  if (current) await current.$disconnect();
}

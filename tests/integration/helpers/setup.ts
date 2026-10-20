/**
 * 每个测试文件结束后断开测试侧 Prisma 连接（否则 worker 退出前会留下连接）。
 * 由 vitest.integration.config.ts 的 setupFiles 引入。
 */
import { afterAll } from 'vitest';
import { closeDb } from './db';

afterAll(async () => {
  await closeDb();
});

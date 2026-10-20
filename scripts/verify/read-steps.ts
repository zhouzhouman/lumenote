/**
 * 读取某任务的 Agent 轨迹（JSON 输出到 stdout）。
 *
 * ## 为什么单独一个脚本
 *
 * 验收脚本是 `.mjs`（node 直接跑，无 TS 依赖），但它需要查 `AgentStep` ——
 * 而 Prisma client 的加载在 .mjs 里要手写配置、容易与项目配置漂移。
 * 用一个 `.ts` 小工具（走 tsx + 项目自己的 prisma.config.ts）读数据，
 * 验收脚本用 spawnSync 调它并解析 JSON，两边职责清晰。
 *
 * 用法：npx tsx scripts/verify/read-steps.ts <taskId>
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const taskId = process.argv[2];

async function main() {
  if (!taskId) {
    console.error('用法：read-steps.ts <taskId>');
    process.exitCode = 1;
    return;
  }

  const steps = await prisma.agentStep.findMany({
    where: { taskId },
    orderBy: { seq: 'asc' },
  });

  // 只输出 JSON，便于调用方解析（日志走 stderr）
  process.stdout.write(JSON.stringify(steps));
}

main()
  .catch((e) => {
    console.error('[read-steps] 失败：', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

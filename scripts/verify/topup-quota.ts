/**
 * 验收脚本的配额准备工具。
 *
 * ## 为什么需要它
 *
 * 端到端验收会真实调用模型（那正是它的价值 —— 只有真实调用才能验证
 * 管线、计量、降级这些行为）。但站点的每日配额默认只有 20 次，
 * 跑几轮验收就会撞上 `QUOTA_EXCEEDED`，于是所有后续断言以 500/429 失败，
 * **看起来像功能坏了，其实只是测试把额度用光了**。
 *
 * 这个脚本把演示账号的 `dailyQuota` 调高，让验收可以连续跑。
 *
 * ⚠️ 它只改**指定账号**的配额列（不是环境变量），
 * 且默认只针对演示账号 —— 不会影响其他用户，也不会改变生产行为。
 *
 * 用法：npx tsx scripts/verify/topup-quota.ts [email] [quota]
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const email = (process.argv[2] ?? 'demo@lumenote.dev').trim().toLowerCase();
const quota = Number(process.argv[3] ?? 500);

async function main() {
  if (!Number.isInteger(quota) || quota <= 0) {
    console.error('配额必须是正整数');
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, dailyQuota: true },
  });

  if (!user) {
    console.error(`找不到账号：${email}`);
    process.exitCode = 1;
    return;
  }

  /**
   * 只增不减：避免误操作把某人的配额调低（那会真的限制他使用）。
   * 要调低请直接改数据库 —— 这种破坏性操作不该藏在一个「验收辅助脚本」里。
   */
  if (user.dailyQuota >= quota) {
    console.log(`[quota] ${email} 当前配额 ${user.dailyQuota} 已不低于 ${quota}，跳过`);
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { dailyQuota: quota } });

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const used = await prisma.task.count({
    where: { userId: user.id, createdAt: { gte: startOfDay }, deletedAt: null },
  });

  console.log(
    `[quota] ${email}: ${user.dailyQuota} → ${quota}（今日已用 ${used} 次，剩余 ${quota - used}）`,
  );
}

main()
  .catch((e) => {
    console.error('[quota] 失败：', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

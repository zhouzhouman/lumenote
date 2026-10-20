/**
 * 临时辅助脚本：为认证 E2E 清理状态并预置数据。
 *
 * ## 为什么要把「准备数据」写库而不是走 HTTP
 *
 * 验证码发送与注册共用「单 IP 5 次 / 5 分钟」的限流桶（都算 auth:register）。
 * 而 E2E 需要覆盖「注册流程 / 用后即焚 / 枚举防护 / 失败锁定」多个场景 ——
 * 全走 HTTP 必然撞限流，于是后面的断言会以 429 失败。
 * 那种失败看起来像功能坏了，其实只是限流在正常工作，
 * 是最浪费时间的一类假故障。
 *
 * 所以：验证码直接写库（哈希算法与 lib/auth/verification.ts 保持一致），
 * 锁定状态也直接写 LoginAttempt 行 —— 这样锁定判定可以在
 * 不消耗任何 HTTP 额度的前提下被确定性地验证。
 *
 * 输出 JSON 供验收脚本消费。用完即删。
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/** 必须与 lib/auth/verification.ts 的 hashCode 完全一致，否则码校验不过 */
function hashCode(code: string): string {
  const secret = process.env.AUTH_SECRET ?? '';
  return crypto.createHash('sha256').update(`${code}:${secret}`).digest('hex');
}

function stamp(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function main() {
  // 清掉历史锁定状态，否则上次运行的失败会立刻把新账号锁住
  await prisma.loginAttempt.deleteMany({});

  const emails = {
    /** 走完整注册流程：错码 → 对码 → 注册成功 */
    a: `authseed-a-${stamp()}@example.com`,
    /** 用后即焚 / 枚举防护用 */
    b: `authseed-b-${stamp()}@example.com`,
    /** 已写入失败计数，用于验证「已处于锁定态」的响应 */
    locked: `authseed-locked-${stamp()}@example.com`,
    /** 已写入失败计数，但账号**不存在** —— 用于验证锁定行为不泄漏账号是否存在 */
    ghost: `authseed-ghost-${stamp()}@example.com`,
  };

  const codes = {
    a: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
    b: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
  };

  for (const [key, email] of [
    ['a', emails.a],
    ['b', emails.b],
  ] as const) {
    await prisma.emailVerificationCode.deleteMany({ where: { email, purpose: 'register' } });
    await prisma.emailVerificationCode.create({
      data: {
        email,
        purpose: 'register',
        codeHash: hashCode(codes[key]),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
  }

  /**
   * 预置失败计数，把两个账号直接推进锁定态。
   *
   * 阈值来自 env（默认 5）。这里写 8 条，留出余量，
   * 免得因为配置改动让测试变成「差一条就锁不上」的脆弱断言。
   */
  const failures = Number(process.env.LOGIN_MAX_FAILURES ?? 5) + 3;
  const rows = [];
  for (const email of [emails.locked, emails.ghost]) {
    for (let i = 0; i < failures; i++) {
      rows.push({ identifier: email, ip: '127.0.0.1', success: false });
    }
  }
  await prisma.loginAttempt.createMany({ data: rows });

  console.log(JSON.stringify({ emails, codes, seededFailures: failures }));
}

main()
  .catch((e) => {
    console.error('seed 失败：', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

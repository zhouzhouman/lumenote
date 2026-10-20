/**
 * 测试用户：走**真实的注册接口**创建，而不是直接往数据库插行。
 *
 * 为什么不用 DB 直插（更快、更简单）：
 *  - 注册链路本身包含「限流 → 密码强度 → 验证码 → 建号 → 签发 cookie」，
 *    直接插行会跳过其中每一环；而集成测试的价值恰恰是覆盖这些链路；
 *  - 后续所有 API 请求都需要真实的 access cookie（由注册/登录签发），
 *    DB 直插还得自己伪造 JWT，那等于在测试里重写一遍生产逻辑。
 *
 * 注册需要邮箱验证码：MAIL_TRANSPORT=console + NODE_ENV=development 时，
 * /api/auth/verification 会把 devCode 直接回传（见 mailer.ts 的
 * assertNotProductionLeak：生产环境硬性禁止回传）。测试从这里取码再注册。
 */
import crypto from 'node:crypto';
import { ApiClient } from './api';

/** 固定的测试密码：长度足够、含字母数字符号，能通过 validatePasswordStrength */
export const TEST_PASSWORD = 'Integration-Test-Pass-2026';

let ipCounter = 0;

/**
 * 每个测试用户独占一个「客户端 IP」。
 *
 * 形如 10.<pid 段>.<序号>.1。注册接口按 IP 限流 5 次/5 分钟，
 * 一次注册消耗 2 次（发码 + 注册），所以只要每个用户 IP 不同就不会互相挤占。
 */
export function uniqueXff(): string {
  ipCounter += 1;
  const pidPart = (process.pid % 200) + 1;
  const counterPart = (ipCounter % 250) + 1;
  return `10.${pidPart}.${counterPart}.1`;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  name: string;
  client: ApiClient;
}

export interface RegisterOptions {
  name?: string;
  password?: string;
  /** 指定 XFF（默认自动分配唯一值） */
  xff?: string;
}

function uniqueEmail(): string {
  return `it-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}@example.test`;
}

/**
 * 注册一个测试用户并返回已带登录 cookie 的 client。
 * 任何一步失败都直接抛错（包含响应体），因为后续测试依赖它，静默继续只会更难排查。
 */
export async function registerTestUser(options: RegisterOptions = {}): Promise<TestUser> {
  const email = uniqueEmail();
  const password = options.password ?? TEST_PASSWORD;
  const name = options.name ?? '集成测试用户';
  const client = new ApiClient({ xff: options.xff ?? uniqueXff() });

  const sent = await client.post('/api/auth/verification', { email, purpose: 'register' });
  const devCode = sent.json?.data?.devCode;
  if (sent.status !== 200 || typeof devCode !== 'string' || !/^\d{4,6}$/.test(devCode)) {
    throw new Error(
      `发送注册验证码失败（HTTP ${sent.status}）：${sent.text.slice(0, 500)}\n` +
        '提示：集成测试要求被测应用以 MAIL_TRANSPORT=console 且 NODE_ENV!=production 启动。',
    );
  }

  const registered = await client.post('/api/auth/register', { email, password, name, code: devCode });
  if (registered.status !== 200) {
    throw new Error(
      `注册失败（HTTP ${registered.status}）：${registered.text.slice(0, 500)}`,
    );
  }

  const id = registered.json?.data?.user?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`注册响应缺少 user.id：${registered.text.slice(0, 500)}`);
  }
  if (!client.hasCookies()) {
    throw new Error('注册成功但没有拿到 access cookie，后续请求将全部 401');
  }

  return { id, email, password, name, client };
}

/** 用已有账号登录，返回新的 client（用于验证登录链路 / 双端会话） */
export async function loginTestUser(
  email: string,
  password: string,
  options: { xff?: string } = {},
): Promise<ApiClient> {
  const client = new ApiClient({ xff: options.xff ?? uniqueXff() });
  const res = await client.post('/api/auth/login', { email, password });
  if (res.status !== 200) {
    throw new Error(`登录失败（HTTP ${res.status}）：${res.text.slice(0, 500)}`);
  }
  return client;
}

/**
 * 认证安全与邮箱验证码的端到端验收。
 *
 * ## 调用预算（改这个脚本前必读）
 *
 * 「发码」与「注册」共用「单 IP 5 次 / 5 分钟」的限流桶。
 * 因此脚本对这两个接口的 HTTP 调用必须 ≤5 次，
 * 否则后面的断言会以 429 失败 —— 那种失败看起来像功能坏了，
 * 其实只是限流正常工作，是最浪费时间的一类假故障。
 *
 * 本脚本的分配：1 次发码 + 4 次注册 = 5 次，刚好用满。
 *
 * ## 锁定相关场景为什么不走 HTTP
 *
 * 锁定判定需要「窗口内累计 N 次失败」，走 HTTP 至少要 5~8 次调用，
 * 会立刻撞上登录限流（同账号 10 次/5 分钟）。
 * 所以锁定态由 `scripts/verify/auth-seed.ts` 直接写 LoginAttempt 行来构造 ——
 * 这样「锁定是否生效」「对存在/不存在的账号是否一致」都能在不消耗额度的前提下
 * 被确定性验证，而且不依赖上一次测试留下的状态。
 *
 * 用法（建议 server 刚重启，内存限流为干净状态）：
 *   npx tsx scripts/verify/auth-seed.ts > scripts/verify/.auth-seed.json
 *   node scripts/verify/auth.e2e.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SEED_FILE =
  // 默认与脚本同目录。本文件已在 scripts/verify/ 下，
  // 再 join 一次 'scripts/verify/...' 会拼成 scripts/verify/scripts/verify/...
  process.argv[3] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '.auth-seed.json');

let cookies = '';
let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  [OK] ${name}`);
  } else {
    fail += 1;
    console.log(`  [!!] ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function req(method, pathname, body, headers = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) {
    const jar = new Map(cookies.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c]));
    for (const c of setCookie) {
      const pair = c.split(';')[0];
      jar.set(pair.split('=')[0], pair);
    }
    cookies = [...jar.values()].join('; ');
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

const PASSWORD = 'Verify2026!strong';

async function main() {
  console.log(`\n=== 认证安全 + 邮箱验证码验收 @ ${BASE} ===\n`);

  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error(`health ${h.status}`);
  } catch (e) {
    console.error(`无法访问 ${BASE}，请先运行 pnpm dev。(${e.message})`);
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(SEED_FILE)) {
    console.error(`缺少预置数据：${SEED_FILE}`);
    console.error('请先运行：npx tsx scripts/verify/auth-seed.ts > scripts/verify/.auth-seed.json');
    process.exitCode = 1;
    return;
  }
  // PowerShell 的 Out-File -Encoding utf8 会写 BOM，JSON.parse 会因此报错，先剥掉
  const seedRaw = fs.readFileSync(SEED_FILE, 'utf8').replace(/^\uFEFF/, '');
  const seedLine = seedRaw.split('\n').find((l) => l.trim().startsWith('{'));
  if (!seedLine) {
    console.error('无法解析 seed 输出：', seedRaw.slice(0, 400));
    process.exitCode = 1;
    return;
  }
  const { emails, codes } = JSON.parse(seedLine);
  console.log('已读取预置的账号、验证码与失败计数\n');

  // ============================================================
  console.log('[1] 错误验证码 → 剩余次数提示');
  const wrong = await req('POST', '/api/auth/register', {
    email: emails.a,
    password: PASSWORD,
    code: codes.a === '000000' ? '111111' : '000000',
  });
  check('错误验证码注册失败（422）', wrong.status === 422, `status=${wrong.status}`);
  check(
    '返回剩余尝试次数（可用性）',
    /还可尝试/.test(wrong.json?.error?.message ?? ''),
    wrong.json?.error?.message,
  );

  console.log('\n[2] 正确验证码注册');
  const regA = await req('POST', '/api/auth/register', {
    email: emails.a,
    password: PASSWORD,
    name: '验收 A',
    code: codes.a,
  });
  check('注册成功（200）', regA.status === 200, `status=${regA.status} ${regA.text.slice(0, 160)}`);
  check('直接拿到登录态（Set-Cookie）', cookies.length > 0);

  console.log('\n[3] 验证码用后即焚（防重放）');
  const replay = await req('POST', '/api/auth/register', {
    email: emails.b,
    password: PASSWORD,
    code: codes.a,
  });
  check(
    '同一个码不能用于第二个账号',
    replay.status !== 200,
    `status=${replay.status} ${replay.text.slice(0, 120)}`,
  );

  console.log('\n[4] 后端强制密码强度（拦在验证码之前）');
  cookies = '';
  const weakReg = await req('POST', '/api/auth/register', {
    email: emails.b,
    password: '123456',
    code: '000000',
  });
  check('弱密码被拒（422）', weakReg.status === 422, `status=${weakReg.status}`);
  /**
   * ⚠️ 这里必须看 `fields.password`，不能只看 `message`。
   *
   * Zod 的字段级错误放在 fields 里，而顶层 message 是笼统的「请求参数有误」。
   * 只看 message 的话，一个「因为验证码错而被拒」的响应会看起来完全一样 ——
   * 断言就失去了区分能力（我第一版就是这么写的，结果误判成失败）。
   */
  check(
    '原因是密码强度而非验证码（拦截顺序：先判密码再验码）',
    /8 位|字母|数字/.test(weakReg.json?.error?.fields?.password ?? ''),
    JSON.stringify(weakReg.json?.error),
  );
  check(
    '不是被验证码错误拦下的（否则说明顺序反了）',
    !/验证码/.test(weakReg.json?.error?.fields?.code ?? ''),
    JSON.stringify(weakReg.json?.error?.fields),
  );

  console.log('\n[5] 参数层没有后门');
  const noCode = await req('POST', '/api/auth/register', {
    email: emails.b,
    password: PASSWORD,
  });
  check('不传验证码无法注册（422）', noCode.status === 422, `status=${noCode.status}`);
  check(
    '校验错误指向 code 字段',
    Boolean(noCode.json?.error?.fields?.code) || /验证码/.test(noCode.json?.error?.message ?? ''),
    JSON.stringify(noCode.json?.error),
  );

  // ============================================================
  // 以下场景**不消耗注册/发码额度**：用预置的失败计数直接构造锁定态
  console.log('\n[6] 已处于锁定态的账号被拒绝');
  cookies = '';
  const lockedResp = await req('POST', '/api/auth/login', {
    email: emails.locked,
    password: PASSWORD,
  });
  check(
    '锁定态返回 429 + ACCOUNT_LOCKED',
    lockedResp.status === 429 && lockedResp.json?.error?.code === 'ACCOUNT_LOCKED',
    `status=${lockedResp.status} code=${lockedResp.json?.error?.code}`,
  );
  check(
    '锁定提示含分钟数指引',
    /分钟/.test(lockedResp.json?.error?.message ?? ''),
    lockedResp.json?.error?.message,
  );
  check(
    '锁定提示不透露账号是否存在（不提「邮箱未注册」之类）',
    !/不存在|未注册|无此账号/.test(lockedResp.json?.error?.message ?? ''),
    lockedResp.json?.error?.message,
  );

  console.log('\n[7] 锁定行为对「存在」与「不存在」的账号完全一致');
  const ghostResp = await req('POST', '/api/auth/login', {
    email: emails.ghost,
    password: PASSWORD,
  });
  check(
    '不存在的账号（已达阈值）同样返回 429 + ACCOUNT_LOCKED',
    ghostResp.status === lockedResp.status &&
      ghostResp.json?.error?.code === lockedResp.json?.error?.code,
    `ghost=${ghostResp.status}/${ghostResp.json?.error?.code} vs locked=${lockedResp.status}/${lockedResp.json?.error?.code}`,
  );
  /**
   * ⚠️ 断言的是「文案结构一致」而不是逐字相同：
   * 提示里带的是动态的剩余分钟数，两次调用相隔毫秒，理论上可能取整不同。
   * 关键是**不含任何区分账号是否存在的词**。
   */
  check(
    '两侧文案结构相同（前缀一致、都不含账号存在性线索）',
    lockedResp.json?.error?.message?.replace(/\d+/g, 'N') ===
      ghostResp.json?.error?.message?.replace(/\d+/g, 'N'),
    `${lockedResp.json?.error?.message} vs ${ghostResp.json?.error?.message}`,
  );

  console.log('\n[8] 登录不需要验证码');
  // 用第 2 步注册成功的账号（emailA）登录：请求体里只有 email + password
  cookies = '';
  const goodLogin = await req('POST', '/api/auth/login', { email: emails.a, password: PASSWORD });
  check(
    '密码正确即可登录成功',
    goodLogin.status === 200,
    `status=${goodLogin.status} ${goodLogin.text.slice(0, 140)}`,
  );
  check('登录响应里没有要求验证码的字段', !/code|verification/i.test(goodLogin.text.slice(0, 200)));

  console.log('\n[9] 账号枚举防护（发码接口）');
  const existsResp = await req('POST', '/api/auth/verification', { email: emails.a });
  const freshResp = await req('POST', '/api/auth/verification', {
    email: `auth-fresh-${Date.now()}@example.com`,
  });
  check(
    '已注册与未注册邮箱的状态码一致',
    existsResp.status === freshResp.status,
    `${existsResp.status} vs ${freshResp.status}`,
  );
  check(
    'message 文案完全一致',
    existsResp.json?.data?.message === freshResp.json?.data?.message,
    `${existsResp.json?.data?.message} vs ${freshResp.json?.data?.message}`,
  );
  check(
    '响应键集合一致（devCode 的有无也不能成为枚举信号）',
    JSON.stringify(Object.keys(existsResp.json?.data ?? {}).sort()) ===
      JSON.stringify(Object.keys(freshResp.json?.data ?? {}).sort()),
    `${Object.keys(existsResp.json?.data ?? {}).join(',')} vs ${Object.keys(freshResp.json?.data ?? {}).join(',')}`,
  );

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('验收脚本异常：', e);
  process.exitCode = 1;
});

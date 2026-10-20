/**
 * 「自带 API Key（BYOK）」功能的端到端验收脚本。
 *
 * 这是接口层的验收，补的是单测覆盖不到的那一段：
 * 单测能证明加解密与地址校验是对的，但证明不了
 * 「密钥有没有从某个接口漏出去」—— 那种错误只有在真实 HTTP 响应体里才看得见。
 *
 * 用法：
 *   1. 先起服务：pnpm dev
 *   2. 再跑：node scripts/verify-byok.e2e.mjs [baseUrl]
 *
 * ⚠️ 每次运行会注册 2 个账号，而注册接口有「单 IP 5 次 / 5 分钟」的限流
 * （rate-limit.ts 里的 rateLimitAuthByIp），所以**短时间内不要连跑超过 2 次**：
 * 第 3 次会得到 429，随后所有断言都因为「没登录」而连环失败 ——
 * 那看起来像功能坏了，其实只是限流生效了。等 5 分钟再跑即可。
 *
 * 两个阶段都**不产生真实模型调用**：
 *   - 第一阶段只做 CRUD 与越权/泄露检查
 *   - 第二阶段把凭证指向本机未监听端口，让请求必然连接失败，
 *     从而在不花钱的前提下走完整条调用链
 */

const BASE = process.argv[2] ?? 'http://localhost:3000';

const DEAD_ENDPOINT = 'http://127.0.0.1:9/v1';
const SECRETS = [
  'sk-verify-secret-alpha-0123456789abcdef',
  'sk-verify-secret-beta-9876543210zyxwvu',
  'sk-verify-secret-gamma-5555555555qwerty',
  'sk-e2e-credential-secret-abcdef1234567890',
];

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

async function req(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  // 手工维护 cookie jar：Node 的 fetch 不自动保存 Set-Cookie
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    const jar = new Map(
      cookies
        .split('; ')
        .filter(Boolean)
        .map((c) => [c.split('=')[0], c]),
    );
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
  } catch {
    /* 非 JSON（HTML 页面） */
  }
  return { status: res.status, json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 注册一个全新账号。
 *
 * ⚠️ 注册现在**必须带邮箱验证码**（见 README 的「注册与登录安全」）。
 * 这个脚本原先只发 email + password，加了验证码功能后就一直是 422 ——
 * 表现为「BYOK 全线失败」，看起来像 BYOK 坏了，其实是认证流程变了。
 *
 * 这里走正常的两步：
 *   1. POST /api/auth/verification 拿 devCode
 *      （console 通道 + 非生产环境会把验证码回传，生产环境不会 ——
 *       所以这个脚本只在本地开发环境可用）
 *   2. 带上 code 完成注册
 *
 * 注意发码与注册共用「单 IP 5 次 / 5 分钟」的限流桶：
 * 本脚本要注册 2 个账号（阶段一、阶段二各一个），
 * 合计 4 次调用，未超限。连续重跑脚本会撞限流，重启 dev server 即可恢复。
 */
async function registerFresh(prefix) {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = 'Verify2026!strong';

  const send = await req('POST', '/api/auth/verification', { email, purpose: 'register' });
  const code = send.json?.data?.devCode;

  if (typeof code !== 'string') {
    return {
      email,
      password,
      status: send.status,
      error: `未拿到 devCode（status=${send.status}）—— 该脚本依赖 console 邮件通道，请在非生产环境运行`,
    };
  }

  const reg = await req('POST', '/api/auth/register', { email, password, name: '验收账号', code });
  return { email, password, status: reg.status };
}

// ============================================================
// 阶段一：CRUD、越权、泄露检查
// ============================================================
async function phaseCrud() {
  console.log('\n[阶段一] 接口契约、越权与泄露检查');

  console.log('\n  1) 未登录');
  const anon = await req('GET', '/api/credentials');
  check('凭证接口未登录返回 401', anon.status === 401, `实际 ${anon.status}`);

  console.log('\n  2) 注册并进入登录态');
  const account = await registerFresh('byok-crud');
  check('注册成功', account.status === 200 || account.status === 201, `status=${account.status}`);
  const biz = await req('GET', '/api/tasks?limit=1');
  check('登录态可访问业务接口', biz.status === 200, `status=${biz.status}`);

  console.log('\n  3) 初始列表');
  const list0 = await req('GET', '/api/credentials');
  check('列表 200', list0.status === 200, `status=${list0.status}`);
  check('初始为空', list0.json?.data?.items?.length === 0);
  check(
    '返回 provider 元数据',
    Array.isArray(list0.json?.data?.providers) && list0.json.data.providers.length >= 2,
  );

  console.log('\n  4) baseUrl 安全校验（这些都是真实攻击形态）');
  const attacks = [
    ['云元数据地址', 'https://169.254.169.254/latest/meta-data'],
    ['RFC1918 内网', 'https://10.0.0.5/v1'],
    ['非本机明文 http', 'http://api.example.com/v1'],
    ['file 协议', 'file:///etc/passwd'],
    ['带用户名密码', 'https://user:pass@example.com/v1'],
  ];
  for (const [label, url] of attacks) {
    const r = await req('POST', '/api/credentials', {
      label: `攻击形态：${label}`,
      provider: 'custom',
      model: 'x',
      baseUrl: url,
      apiKey: SECRETS[0],
    });
    check(`${label} 被拒（422）`, r.status === 422, `status=${r.status} ${r.text.slice(0, 100)}`);
  }

  console.log('\n  5) 创建凭证');
  const created = await req('POST', '/api/credentials', {
    label: '验收用 Key A',
    provider: 'deepseek',
    model: 'deepseek-flash',
    apiKey: SECRETS[0],
  });
  check('创建成功（201）', created.status === 201, `status=${created.status} ${created.text.slice(0, 160)}`);
  check('响应体不含明文密钥', !created.text.includes(SECRETS[0]));
  check('响应体不含密文字段', !created.text.includes('apiKeyEncrypted'));
  check(
    '返回掩码而非密钥本身',
    typeof created.json?.data?.apiKeyHint === 'string' && created.json.data.apiKeyHint.includes('…'),
  );
  check('首个凭证自动启用', created.json?.data?.active === true);
  const idA = created.json?.data?.id;

  console.log('\n  6) 列表接口不泄露');
  const list1 = await req('GET', '/api/credentials');
  check('列表不含明文密钥', !list1.text.includes(SECRETS[0]));
  check('列表不含密文字段', !list1.text.includes('apiKeyEncrypted'));
  check('列表含 1 条', list1.json?.data?.items?.length === 1);

  console.log('\n  7) 启用状态互斥');
  const created2 = await req('POST', '/api/credentials', {
    label: '验收用 Key B',
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: SECRETS[1],
  });
  check('第二条创建成功', created2.status === 201, `status=${created2.status}`);
  check('第二条不自动启用（已有启用项）', created2.json?.data?.active === false);
  const idB = created2.json?.data?.id;

  const activate = await req('PATCH', `/api/credentials?id=${idB}`, { active: true });
  check('启用第二条成功', activate.status === 200, `status=${activate.status}`);

  const list2 = await req('GET', '/api/credentials');
  const actives = (list2.json?.data?.items ?? []).filter((i) => i.active);
  check('同时只有一条启用', actives.length === 1, `active 数量=${actives.length}`);
  check('启用的确实是第二条', actives[0]?.id === idB);

  console.log('\n  8) 更换密钥');
  const patched = await req('PATCH', `/api/credentials?id=${idB}`, {
    label: '验收用 Key B（改名）',
    apiKey: SECRETS[2],
  });
  check('更新成功', patched.status === 200, `status=${patched.status}`);
  check('更新响应不含明文', !patched.text.includes(SECRETS[2]));
  check('掩码同步更新', patched.json?.data?.apiKeyHint === 'sk-…erty', patched.json?.data?.apiKeyHint);

  console.log('\n  9) 不存在的 id 不泄露资源是否存在');
  const delMissing = await req('DELETE', '/api/credentials?id=does-not-exist-id');
  check('删除不存在的凭证返回 404', delMissing.status === 404, `status=${delMissing.status}`);
  const patchMissing = await req('PATCH', '/api/credentials?id=does-not-exist-id', { label: 'x' });
  check('更新不存在的凭证返回 404', patchMissing.status === 404, `status=${patchMissing.status}`);

  console.log('\n  10) 页面可访问');
  const settings = await req('GET', '/settings');
  check('/settings 返回 200', settings.status === 200, `status=${settings.status}`);
  const workspace = await req('GET', '/workspace');
  check('/workspace 返回 200', workspace.status === 200, `status=${workspace.status}`);

  console.log('\n  11) 清理');
  const delA = await req('DELETE', `/api/credentials?id=${idA}`);
  const delB = await req('DELETE', `/api/credentials?id=${idB}`);
  check('删除两条均成功', delA.status === 200 && delB.status === 200);
  const list3 = await req('GET', '/api/credentials');
  check('删除后列表为空', list3.json?.data?.items?.length === 0);
}

// ============================================================
// 阶段二：凭证真正进入管线，且失败时不静默回退
// ============================================================
async function phasePipeline() {
  console.log('\n[阶段二] 凭证进入管线（不产生真实模型调用）');

  console.log('\n  1) 准备账号与一条必然失败的凭证');
  const account = await registerFresh('byok-pipe');
  check('注册成功', account.status === 200 || account.status === 201, `status=${account.status}`);

  const created = await req('POST', '/api/credentials', {
    label: '管线验收 Key',
    provider: 'custom',
    // 指向本机未监听端口：必然 ECONNREFUSED，不花钱也走完链路
    baseUrl: DEAD_ENDPOINT,
    model: 'dead-endpoint-model',
    apiKey: SECRETS[3],
  });
  check('凭证创建成功', created.status === 201, `status=${created.status} ${created.text.slice(0, 160)}`);
  check('凭证已启用', created.json?.data?.active === true);
  const credId = created.json?.data?.id;

  console.log('\n  2) 提交摘要任务');
  const taskRes = await req('POST', '/api/tasks', {
    type: 'summarize',
    inputType: 'text',
    content:
      '这是一段用于验收的测试正文。它需要足够长以通过输入校验，内容本身没有任何意义，' +
      '只用来驱动管线走完一次完整的调用链路。凭证被指向一个未监听的端口，' +
      '因此这次调用必定失败，从而既验证了凭证被正确使用，又不会产生任何真实费用。',
    params: { style: '要点式', maxPoints: '5', targetReader: '普通读者' },
  });
  check('任务创建成功', taskRes.status === 200, `status=${taskRes.status} ${taskRes.text.slice(0, 160)}`);
  const taskId = taskRes.json?.data?.taskId;
  check('拿到 taskId', typeof taskId === 'string' && taskId.length > 0);

  console.log('\n  3) 任务快照：凭证被记录，密钥不落库');
  let detail = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const r = await req('GET', `/api/tasks/${taskId}`);
    if (r.status === 200) {
      detail = r.json?.data;
      if (detail?.status === 'succeeded' || detail?.status === 'failed') break;
    }
  }

  check('能读到任务详情', Boolean(detail), '30 秒内未读到');
  if (!detail) return;

  const raw = JSON.stringify(detail);
  check('任务记录不含明文密钥', !raw.includes(SECRETS[3]), '明文密钥出现在任务记录里！');
  check('params 记录的是 credentialId', detail.params?.credentialId === credId);
  check('inputMeta 记录了凭证来源', detail.inputMeta?.credentialLabel === '管线验收 Key');
  check('模型名记录了用户选的模型', detail.params?.model === 'dead-endpoint-model');

  console.log('\n  4) 失败后的行为（关键：不能静默改用站点 key）');
  console.log(`     状态=${detail.status} degraded=${detail.degraded}`);
  check('任务有终态（不是卡死）', detail.status === 'succeeded' || detail.status === 'failed');
  if (detail.status === 'succeeded') {
    check('结果被明确标记为降级', detail.degraded === true);
    const reason = String(detail.outputMeta?.degradedReason ?? '');
    console.log(`     降级原因：${reason.slice(0, 150)}`);
    check('说明是「你的凭证」失败，而非「所有通道不可用」', reason.includes('你配置的凭证'));
    check('说明了不会自动改用站点通道（避免产生意外费用）', reason.includes('不会自动改用站点内置通道'));
  }

  console.log('\n  5) 设置页能看到失败状态');
  const listAfter = await req('GET', '/api/credentials');
  const item = (listAfter.json?.data?.items ?? []).find((i) => i.id === credId);
  check('凭证仍在列表中', Boolean(item));
  check('记录了最近失败的错误码', Boolean(item?.lastErrorCode));
  check('列表依旧不含明文密钥', !listAfter.text.includes(SECRETS[3]));

  console.log('\n  6) 清理');
  const del = await req('DELETE', `/api/credentials?id=${credId}`);
  check('凭证已删除', del.status === 200);
}

async function main() {
  console.log(`\n=== BYOK 端到端验收 @ ${BASE} ===`);

  // 先探活，避免后面每个断言都因为「服务没起」而失败，掩盖真实问题
  try {
    const health = await fetch(`${BASE}/api/health`);
    if (!health.ok) throw new Error(`health ${health.status}`);
  } catch (e) {
    console.error(`\n无法访问 ${BASE}，请先运行 pnpm dev。\n(${e.message})\n`);
    process.exitCode = 1;
    return;
  }

  await phaseCrud();
  await phasePipeline();

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('验收脚本异常：', e);
  process.exitCode = 1;
});

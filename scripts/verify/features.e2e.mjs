/**
 * 临时：验证分享链接与追问功能端到端可用。用完即删。
 */
const BASE = 'http://localhost:3000';

let cookies = '';

async function req(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
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
  return { status: res.status, json, text, location: res.headers.get('location') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

async function main() {
  console.log(`\n=== 分享 / 追问 / 导出 验收 @ ${BASE} ===\n`);

  const login = await req('POST', '/api/auth/login', {
    email: 'demo@lumenote.dev',
    password: 'Lumenote2026!',
  });
  if (login.status !== 200) {
    console.log('登录失败', login.status, login.text.slice(0, 200));
    return;
  }

  console.log('[1] 准备一个已完成的任务');
  const created = await req(
    'POST',
    '/api/tasks',
    {
      type: 'summarize',
      inputType: 'text',
      content:
        'Prompt 指纹记录了模板版本、模型与参数，使结果可以在数月后复现。' +
        '没有它就无法判断一次退化来自提示词还是模型，也无法回答「这条结果是怎么来的」。' +
        '因此我们把 Prompt 版本快照进每一个任务，并用数据库唯一约束保证计量只结算一次。',
      params: { style: '要点式', maxPoints: '3', targetReader: '开发者' },
    },
    { 'Idempotency-Key': `share-verify-${Date.now()}` },
  );
  check('任务创建成功', created.status === 200, `status=${created.status}`);
  const taskId = created.json?.data?.taskId;

  let detail = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const r = await req('GET', `/api/tasks/${taskId}`);
    if (r.status === 200 && ['succeeded', 'failed'].includes(r.json.data.status)) {
      detail = r.json.data;
      break;
    }
  }
  check('任务已完成', detail?.status === 'succeeded', `status=${detail?.status}`);

  console.log('\n[2] 分享链接');
  const shareGet0 = await req('GET', `/api/share?taskId=${taskId}`);
  check('查询分享状态返回 200', shareGet0.status === 200, `status=${shareGet0.status}`);
  check('初始未分享', shareGet0.json?.data?.active === false);

  const share = await req('POST', '/api/share', { taskId });
  check('创建分享链接成功', share.status === 200, `status=${share.status} ${share.text.slice(0, 150)}`);
  const token = share.json?.data?.token;
  check('token 是不可枚举的长随机串', typeof token === 'string' && token.length >= 32, `token 长度=${token?.length}`);

  const shareAgain = await req('POST', '/api/share', { taskId });
  check('重复创建复用同一个 token（不产生新链接）', shareAgain.json?.data?.token === token, `reused=${shareAgain.json?.data?.reused}`);
  check('并标记为 reused', shareAgain.json?.data?.reused === true);

  console.log('\n[3] 未登录访问分享页');
  const savedCookies = cookies;
  cookies = ''; // 清空 cookie，模拟匿名访问者

  const shared = await req('GET', `/share/${token}`);
  check('匿名可访问分享页（200）', shared.status === 200, `status=${shared.status}`);
  check('页面包含输出内容', shared.text.includes('Prompt') || shared.text.includes('指纹'));

  /**
   * 关键安全断言：分享页**不能包含输入正文的完整原文**。
   *
   * ⚠️ 第一版我用的是一句较短的子串做检查，结果误报 ——
   * 因为模型的摘要本来就会用到原文里的词（那是它的工作）。
   * 正确的断言是「整段输入原文没有出现在页面上」：
   * 摘要可以包含原文的词句，但不该把用户粘贴的整段素材原样搬到公开页面。
   */
  const inputText =
    'Prompt 指纹记录了模板版本、模型与参数，使结果可以在数月后复现。' +
    '没有它就无法判断一次退化来自提示词还是模型，也无法回答「这条结果是怎么来的」。' +
    '因此我们把 Prompt 版本快照进每一个任务，并用数据库唯一约束保证计量只结算一次。';

  check(
    '分享页不含输入正文的完整原文',
    !shared.text.includes(inputText),
    '整段输入原文出现在分享页里！',
  );
  // 同时确认页面确实渲染了内容（避免"因为页面是空的所以没泄漏"这种假阳性）
  check('页面确实有实质内容（长于 500 字符）', shared.text.length > 500, `长度=${shared.text.length}`);

  const badToken = await req('GET', '/share/definitely-not-a-real-token-1234567890');
  check('无效 token 返回 404', badToken.status === 404, `status=${badToken.status}`);

  // 恢复登录态
  cookies = savedCookies;

  console.log('\n[4] 撤销分享');
  const revoke = await req('DELETE', `/api/share?taskId=${taskId}`);
  check('撤销成功', revoke.status === 200, `status=${revoke.status}`);

  cookies = '';
  const afterRevoke = await req('GET', `/share/${token}`);
  check('撤销后匿名访问返回 404', afterRevoke.status === 404, `status=${afterRevoke.status}`);
  cookies = savedCookies;

  const statusAfter = await req('GET', `/api/share?taskId=${taskId}`);
  check('状态显示未激活', statusAfter.json?.data?.active === false);

  console.log('\n[5] 追问');
  const followup = await req('POST', '/api/followup', {
    parentTaskId: taskId,
    question: '把第一点用一句话再解释给完全不懂的人听。',
  });
  check('追问提交成功', followup.status === 200, `status=${followup.status} ${followup.text.slice(0, 150)}`);
  const childId = followup.json?.data?.taskId;
  check('返回子任务 id 且与父任务不同', typeof childId === 'string' && childId !== taskId);

  let child = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const r = await req('GET', `/api/tasks/${childId}`);
    if (r.status === 200 && ['succeeded', 'failed'].includes(r.json.data.status)) {
      child = r.json.data;
      break;
    }
  }
  check('子任务完成', child?.status === 'succeeded', `status=${child?.status}`);
  check('子任务记录了父子关系', child?.inputMeta?.parentTaskId === taskId, JSON.stringify(child?.inputMeta));
  check('沿用父任务的 Prompt 版本', child?.promptVersion?.templateName === detail?.promptVersion?.templateName);
  if (child?.outputContent) {
    console.log(`     追问回答：${child.outputContent.replace(/\s+/g, ' ').slice(0, 180)}`);
  }

  const chain = await req('GET', `/api/followup?taskId=${taskId}`);
  check('可以列出追问链', chain.status === 200 && chain.json?.data?.items?.length >= 1, `items=${chain.json?.data?.items?.length}`);

  console.log('\n[6] 追问的输入校验');
  const noQuestion = await req('POST', '/api/followup', { parentTaskId: taskId, question: '' });
  check('空问题被拒（422）', noQuestion.status === 422, `status=${noQuestion.status}`);
  const badParent = await req('POST', '/api/followup', {
    parentTaskId: 'cmnotarealtaskid00000000',
    question: '测试',
  });
  check('不存在的父任务返回 404', badParent.status === 404, `status=${badParent.status}`);

  console.log('\n[7] 术语表');
  const g0 = await req('GET', '/api/glossary');
  check('列出术语返回 200', g0.status === 200, `status=${g0.status}`);

  const gCreate = await req('POST', '/api/glossary', {
    source: 'prompt fingerprint',
    target: '提示词指纹',
    domain: '技术',
    note: '本项目的核心概念，必须统一',
  });
  check('新增术语成功', gCreate.status === 201, `status=${gCreate.status} ${gCreate.text.slice(0, 150)}`);
  const termId = gCreate.json?.data?.id;

  const gDup = await req('POST', '/api/glossary', {
    source: 'prompt fingerprint',
    target: '别的译法',
    domain: '技术',
  });
  check('重复术语返回 409 且提示可读', gDup.status === 409, `status=${gDup.status} ${gDup.json?.error?.message}`);

  const gList = await req('GET', '/api/glossary');
  check('列表含刚新增的术语', gList.json?.data?.items?.some((i) => i.id === termId));
  check('归纳出领域列表', Array.isArray(gList.json?.data?.domains) && gList.json.data.domains.includes('技术'));

  const gPatch = await req('PATCH', `/api/glossary?id=${termId}`, {
    source: 'prompt fingerprint',
    target: 'Prompt 指纹',
  });
  check('更新术语成功', gPatch.status === 200, `status=${gPatch.status}`);

  const gMissing = await req('DELETE', '/api/glossary?id=does-not-exist');
  check('删除不存在的术语返回 404', gMissing.status === 404, `status=${gMissing.status}`);

  // 清理
  const gDel = await req('DELETE', `/api/glossary?id=${termId}`);
  check('删除术语成功', gDel.status === 200, `status=${gDel.status}`);

  console.log('\n[8] 登录活动');
  const sec = await req('GET', '/api/security/events');
  check('安全事件接口返回 200', sec.status === 200, `status=${sec.status}`);
  check('含账号状态', Boolean(sec.json?.data?.account));
  check('含事件列表', Array.isArray(sec.json?.data?.events) && sec.json.data.events.length > 0);
  check('含活跃会话', Array.isArray(sec.json?.data?.sessions) && sec.json.data.sessions.length > 0);
  check(
    '事件带中文标签',
    typeof sec.json?.data?.events?.[0]?.label === 'string' &&
      sec.json.data.events[0].label !== sec.json.data.events[0].type,
    JSON.stringify(sec.json?.data?.events?.[0]),
  );

  // ============================================================
  console.log('\n[9] 版本对比');
  await verifyDiff();

  console.log('\n[10] 追问对话链');
  await verifyThread();

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

/**
 * 版本对比：对同一篇原文用不同参数生成两次，再对比。
 *
 * 这一段是**真实调用模型**的（不是构造假数据）——
 * 只有真实生成才能验证「参数差异会不会正确反映到结果差异上」，
 * 而伪造的输出无法证明这一点。
 */
async function verifyDiff() {
  const SOURCE =
    'Prompt 指纹记录了模板版本、模型与参数，使结果可以在数月后复现。' +
    '没有它就无法判断一次退化来自提示词还是模型，也无法回答这条结果是怎么来的。' +
    '因此我们把 Prompt 版本快照进每一个任务，并用数据库唯一约束保证计量只结算一次。';

  async function createAndWait(params, label) {
    const created = await req(
      'POST',
      '/api/tasks',
      { type: 'summarize', inputType: 'text', content: SOURCE, params },
      { 'Idempotency-Key': `diff-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    );
    if (created.status !== 200) return null;
    const taskId = created.json.data.taskId;
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      const r = await req('GET', `/api/tasks/${taskId}`);
      if (r.status === 200 && ['succeeded', 'failed'].includes(r.json.data.status)) return r.json.data;
    }
    return null;
  }

  const a = await createAndWait({ style: '要点式', maxPoints: '3', targetReader: '开发者' }, 'a');
  check('对比样本 A 生成成功', a?.status === 'succeeded', `status=${a?.status}`);
  const b = await createAndWait({ style: '执行摘要', maxPoints: '5', targetReader: '管理层' }, 'b');
  check('对比样本 B 生成成功', b?.status === 'succeeded', `status=${b?.status}`);
  if (!a || !b) return;

  const diff = await req('GET', `/api/diff?a=${a.id}&b=${b.id}`);
  check('对比接口返回 200', diff.status === 200, `status=${diff.status}`);

  const d = diff.json?.data;
  check('识别为同源（同一篇原文）', d?.sameSource === true);
  check('返回 diff 行', Array.isArray(d?.diff?.lines) && d.diff.lines.length > 0);
  check('返回统计（相似度等）', typeof d?.diff?.stats?.similarity === 'number');
  check(
    '参数差异捕获到 style / maxPoints / targetReader',
    ['style', 'maxPoints', 'targetReader'].every((k) => d?.paramDiff?.some((p) => p.key === k)),
    JSON.stringify(d?.paramDiff),
  );

  const same = await req('GET', `/api/diff?a=${a.id}&b=${a.id}`);
  check('同一个任务对比被拒（422）', same.status === 422, `status=${same.status}`);
  const ghost = await req('GET', `/api/diff?a=${a.id}&b=cmnotarealtaskid00000000`);
  check('不存在的任务返回 404', ghost.status === 404, `status=${ghost.status}`);

  console.log(
    `     相似度 ${(d.diff.stats.similarity * 100).toFixed(1)}% | ` +
      `新增 ${d.diff.stats.added} 行 | 删除 ${d.diff.stats.removed} 行`,
  );
}

/**
 * 追问对话链：问两轮，然后从任意一环都应该能拿到完整三条。
 *
 * ⚠️ 这里刻意验证**三轮**（根 + 两轮追问）而不是两轮：
 * 第一版接口只查了一层子任务，「追问的追问」被静默丢掉 ——
 * 只测两轮是发现不了这个 bug 的。
 */
async function verifyThread() {
  const created = await req(
    'POST',
    '/api/tasks',
    {
      type: 'summarize',
      inputType: 'text',
      content:
        '缓存命中率是 AI 应用最重要的成本指标。把稳定内容前置能显著提高命中率，'
        + '因为前缀缓存按最长公共前缀匹配。DeepSeek 的 cache hit 单价只有 miss 的约五十分之一。',
      params: { style: '要点式', maxPoints: '3', targetReader: '开发者' },
    },
    { 'Idempotency-Key': `thread-${Date.now()}` },
  );
  check('根任务创建成功', created.status === 200, `status=${created.status}`);
  if (created.status !== 200) return;
  const rootId = created.json.data.taskId;

  async function waitDone(taskId) {
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      const r = await req('GET', `/api/tasks/${taskId}`);
      if (r.status === 200 && ['succeeded', 'failed'].includes(r.json.data.status)) return r.json.data;
    }
    return null;
  }

  check('根任务完成', (await waitDone(rootId))?.status === 'succeeded');

  const f1 = await req('POST', '/api/followup', {
    parentTaskId: rootId,
    question: '第一点用一句话解释给完全不懂的人。',
  });
  check('第一轮追问创建成功', f1.status === 200, `status=${f1.status}`);
  const f1Id = f1.json?.data?.taskId;
  check('第一轮完成', (await waitDone(f1Id))?.status === 'succeeded');

  const f2 = await req('POST', '/api/followup', {
    parentTaskId: f1Id,
    question: '再给一个具体的数字例子。',
  });
  check('第二轮追问（追问的追问）创建成功', f2.status === 200, `status=${f2.status}`);
  const f2Id = f2.json?.data?.taskId;
  check('第二轮完成', (await waitDone(f2Id))?.status === 'succeeded');

  // 从任意一环出发都应拿到完整 3 条（这是「向上找根」的逻辑）
  for (const [label, anchor] of [['根', rootId], ['第一轮', f1Id], ['第二轮', f2Id]]) {
    const r = await req('GET', `/api/followup?taskId=${anchor}&whole=1`);
    check(`从${label}出发能拿到完整链（3 条）`, r.json?.data?.items?.length === 3, `items=${r.json?.data?.items?.length}`);
    check(`从${label}出发的 rootId 都是根任务`, r.json?.data?.rootId === rootId);
  }

  const chain = await req('GET', `/api/followup?taskId=${f2Id}&whole=1`);
  const items = chain.json?.data?.items ?? [];
  check('第一条是 root、后续是 followup', items[0]?.kind === 'root' && items[1]?.kind === 'followup');
  check('追问条目带出了原始问题文本', items[1]?.question?.includes('完全不懂'), `q=${items[1]?.question}`);
  check('第二轮问题也被带出', items[2]?.question?.includes('数字例子'), `q=${items[2]?.question}`);

  const direct = await req('GET', `/api/followup?taskId=${rootId}`);
  check('默认模式仍只列直接子任务', direct.json?.data?.items?.length === 1);

  const page = await req('GET', `/history/${rootId}`);
  check('追问独立页面可访问（200）', page.status === 200, `status=${page.status}`);

  const ghost = await req('GET', '/api/followup?taskId=cmnotarealtask00000000&whole=1');
  check('不存在的任务返回 404', ghost.status === 404, `status=${ghost.status}`);
}

main().catch((e) => {
  console.error('验收脚本异常：', e);
  process.exitCode = 1;
});

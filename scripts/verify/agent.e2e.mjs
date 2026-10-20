/**
 * 阶段 3 验收：Agent 任务的完整链路（HTTP + 数据库轨迹 + SSE）。
 *
 * ## 验证什么
 *
 *  1. `POST /api/agent` 创建任务（< 200ms，两段式的第一段）
 *  2. 任务真的被 after() 跑完，产出带证据的结论
 *  3. **轨迹落库**：AgentStep 行数、seq 连续、唯一约束生效
 *  4. `GET /api/tasks/:id` 的详情里能读到结构化结论
 *  5. SSE 订阅能收到 step 事件
 *  6. 越权：别人的 taskId 一律 404
 *
 * 用法：node scripts/verify/agent.e2e.mjs
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
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) {
    const jar = new Map(cookies.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c]));
    for (const c of sc) {
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
  return { status: res.status, json, text, res };
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

const DOCUMENT = `# 缓存命中率与成本

## 核心机制

前缀缓存按最长公共前缀匹配。当一次请求的开头部分与之前某次请求逐字节相同时，
这部分内容可以直接复用已算好的中间状态，不再重新计算。

## 成本影响

DeepSeek 的 cache hit 单价是 miss 的五十分之一。命中缓存的输入 token
只需要支付 2% 的价格。这个 50 倍的价差远大于峰谷时段的 2 倍差异，
因此缓存命中率是 AI 应用里最重要的成本杠杆。

## 提高方法

关键是把稳定内容前置：system prompt 与固定指令放在最前面，
用户的可变输入放在最后面。把日期或随机 id 放在开头会让前缀每次都不同，
命中率直接归零。

## 度量

DeepSeek 在 usage 里返回 prompt_cache_hit_tokens 与 prompt_cache_miss_tokens。
命中率 = hit / (hit + miss)。做得好的应用能稳定在 70% 以上。`;

/**
 * 读取某任务的 Agent 轨迹。
 *
 * 用 `npx tsx` 调一个小工具（它复用项目自己的 prisma.config.ts），
 * 而不是在 .mjs 里手写 Prisma client 配置 —— 后者会与项目配置漂移，
 * 且内联脚本的引号转义很容易出错（我第一版就踩了）。
 */
async function loadSteps(taskId) {
  const { spawnSync } = await import('node:child_process');
  const out = spawnSync('npx', ['tsx', 'scripts/verify/read-steps.ts', taskId], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (out.status !== 0) {
    console.log('    (读轨迹失败)', (out.stderr || out.stdout || '').slice(0, 300));
    return [];
  }
  // tsx 会把 "injected env" 之类的提示混进 stdout，取最后一个 JSON 数组
  const match = /\s*(\[[\s\S]*\])\s*$/.exec(out.stdout.trim());
  if (!match) {
    console.log('    (轨迹输出无法解析)', out.stdout.slice(0, 200));
    return [];
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return [];
  }
}

async function main() {
  console.log(`\n=== Agent 链路验收 @ ${BASE} ===\n`);

  const login = await req('POST', '/api/auth/login', {
    email: 'demo@lumenote.dev',
    password: 'Lumenote2026!',
  });
  if (login.status !== 200) {
    console.log('登录失败', login.status, login.text.slice(0, 200));
    return;
  }

  // ============================================================
  console.log('[1] 创建 Agent 任务（两段式第一段应很快返回）');
  const t0 = Date.now();
  const created = await req(
    'POST',
    '/api/agent',
    {
      content: DOCUMENT,
      question: '缓存命中率为什么是最重要的成本指标？具体差多少倍？',
      inputType: 'text',
      maxSteps: '12',
    },
    { 'Idempotency-Key': `agent-verify-${Date.now()}` },
  );
  const createMs = Date.now() - t0;

  check('创建返回 200', created.status === 200, `status=${created.status} ${created.text.slice(0, 200)}`);
  check(`创建响应快（${createMs}ms < 3000ms）`, createMs < 3000, `${createMs}ms`);
  const taskId = created.json?.data?.taskId;
  check('返回了 taskId', typeof taskId === 'string' && taskId.length > 0);

  if (!taskId) {
    console.log('\n无法继续，后续断言跳过');
    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
    process.exitCode = 1;
    return;
  }

  // ============================================================
  console.log('\n[2] 等待 Agent 跑完');
  let detail = null;
  for (let i = 0; i < 80; i++) {
    await sleep(1500);
    const r = await req('GET', `/api/tasks/${taskId}`);
    if (r.status === 200 && ['succeeded', 'failed'].includes(r.json.data.status)) {
      detail = r.json.data;
      break;
    }
  }

  check('任务到达终态', detail !== null, '超时未完成');
  if (!detail) {
    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`  状态=${detail.status} 降级=${detail.degraded}`);
  console.log(`  模型=${detail.outputMeta?.model ?? '?'} 步数=${detail.outputMeta?.stepCount ?? '?'}`);
  console.log(`  收敛原因=${detail.outputMeta?.stopReason ?? '?'}`);
  console.log(`  用到的工具=${JSON.stringify(detail.outputMeta?.usedTools ?? [])}`);
  console.log(`  成本=¥${detail.outputMeta?.costCny ?? '?'}`);

  check('任务成功', detail.status === 'succeeded', `status=${detail.status} err=${detail.errorMessage}`);
  check('类型是 agent', detail.type === 'agent', detail.type);
  check('有输出内容', (detail.outputContent ?? '').length > 0);

  // ============================================================
  console.log('\n[3] 结构化结论与证据链');
  const structured = detail.outputMeta?.structured;
  check('详情里带了结构化结论', Boolean(structured), JSON.stringify(structured)?.slice(0, 120));
  check('有结论条目', (structured?.conclusions?.length ?? 0) > 0, `${structured?.conclusions?.length ?? 0} 条`);

  const withEvidence = (structured?.conclusions ?? []).filter((c) => (c.evidence?.length ?? 0) > 0);
  check('结论都带证据', withEvidence.length === (structured?.conclusions?.length ?? 0), `${withEvidence.length}/${structured?.conclusions?.length ?? 0}`);

  // 证据链：引用的原文片段必须真的在文档里
  let totalEv = 0;
  let verifiedEv = 0;
  const normalize = (s) => s.toLowerCase().replace(/\s+/g, '');
  for (const c of structured?.conclusions ?? []) {
    for (const ev of c.evidence ?? []) {
      totalEv += 1;
      if (ev.quote && normalize(DOCUMENT).includes(normalize(ev.quote))) verifiedEv += 1;
    }
  }
  console.log(`  证据链：${verifiedEv}/${totalEv} 条引文能在原文中找到`);
  check('证据链完整率 ≥ 0.8', totalEv > 0 && verifiedEv / totalEv >= 0.8, `${verifiedEv}/${totalEv}`);

  // ============================================================
  console.log('\n[4] 轨迹落库');
  const steps = await loadSteps(taskId);
  console.log(`  AgentStep 行数 = ${steps.length}`);
  for (const s of steps) {
    const tools = Array.isArray(s.toolResults)
      ? s.toolResults.map((t) => `${t.name}(${t.ok ? 'ok' : 'fail'})`).join(', ')
      : '';
    console.log(`    #${s.seq} ${s.phase} tokens=${s.cumulativeTokens} ${s.note ?? ''} ${tools}`);
  }

  check('轨迹已落库', steps.length > 0, `${steps.length} 行`);
  check('seq 从 1 开始且连续', steps.every((s, i) => s.seq === i + 1), JSON.stringify(steps.map((s) => s.seq)));
  check('至少一步是 act（有工具调用）', steps.some((s) => s.phase === 'act'), JSON.stringify(steps.map((s) => s.phase)));
  check('最后一步是 finalize 或 give_up', ['finalize', 'give_up'].includes(steps.at(-1)?.phase), steps.at(-1)?.phase);
  check('步骤记录了 token', steps.some((s) => s.cumulativeTokens > 0));
  check('act 步骤记录了工具结果', steps.filter((s) => s.phase === 'act').every((s) => Array.isArray(s.toolResults) && s.toolResults.length > 0));

  // ============================================================
  console.log('\n[5] SSE 订阅（已完成任务 → 回放 + 轨迹补发）');
  const sseRes = await fetch(`${BASE}/api/tasks/${taskId}/stream`, {
    headers: { Cookie: cookies, Accept: 'text/event-stream' },
  });
  check('SSE 返回 200', sseRes.status === 200, `status=${sseRes.status}`);
  check('Content-Type 是 event-stream', (sseRes.headers.get('content-type') ?? '').includes('text/event-stream'));

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      sleep(1500).then(() => ({ value: undefined, done: false })),
    ]);
    if (done) break;
    if (value) {
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const f of frames) {
        const m = /^event: (\w+)\ndata: (.*)$/s.exec(f.trim());
        if (m) events.push({ event: m[1], data: m[2] });
      }
      if (events.some((e) => e.event === 'done')) break;
    }
  }
  reader.cancel().catch(() => undefined);

  const eventTypes = [...new Set(events.map((e) => e.event))];
  console.log(`  收到事件类型: ${eventTypes.join(', ')}`);
  const stepEvents = events.filter((e) => e.event === 'step');
  console.log(`  step 事件数: ${stepEvents.length}`);
  check('收到了 meta 事件', eventTypes.includes('meta'));
  check('收到了 done 事件', eventTypes.includes('done'));
  check('收到了 step 事件（轨迹补发）', stepEvents.length > 0, `${stepEvents.length} 个`);
  check('收到了 usage 事件', eventTypes.includes('usage'));

  if (stepEvents.length > 0) {
    try {
      const first = JSON.parse(stepEvents[0].data);
      console.log(`  首个 step: seq=${first.seq} phase=${first.phase} note="${first.note}"`);
      check('step 事件带 seq/phase', typeof first.seq === 'number' && typeof first.phase === 'string');
      check('step 事件带工具摘要', Array.isArray(first.tools));
    } catch {
      check('step 事件是合法 JSON', false);
    }
  }

  // ============================================================
  console.log('\n[6] 输入校验与越权');
  const noQuestion = await req('POST', '/api/agent', { content: DOCUMENT, question: '' });
  check('缺问题被拒（422）', noQuestion.status === 422, `status=${noQuestion.status}`);

  const shortContent = await req('POST', '/api/agent', { content: '太短', question: '这是什么？' });
  check('内容过短被拒（422）', shortContent.status === 422, `status=${shortContent.status}`);

  const badUrl = await req('POST', '/api/agent', {
    content: 'not-a-url',
    question: '这篇文章讲了什么？',
    inputType: 'url',
  });
  check('非法链接被拒（422）', badUrl.status === 422, `status=${badUrl.status}`);

  const ghost = await req('GET', '/api/tasks/cmnotarealtask00000000');
  check('不存在的任务 404', ghost.status === 404, `status=${ghost.status}`);

  const saved = cookies;
  cookies = '';
  const anon = await req('GET', `/api/tasks/${taskId}`);
  check('未登录访问详情 401', anon.status === 401, `status=${anon.status}`);
  const anonCreate = await req('POST', '/api/agent', { content: DOCUMENT, question: '测试问题' });
  check('未登录创建 401', anonCreate.status === 401, `status=${anonCreate.status}`);
  cookies = saved;

  // ============================================================
  console.log('\n[7] 幂等：同一 key 重复提交不产生新任务');
  const key = `agent-idem-${Date.now()}`;
  const a = await req('POST', '/api/agent', { content: DOCUMENT, question: '这份文档讲了什么？' }, { 'Idempotency-Key': key });
  const b = await req('POST', '/api/agent', { content: DOCUMENT, question: '这份文档讲了什么？' }, { 'Idempotency-Key': key });
  check('两次提交返回同一 taskId', a.json?.data?.taskId === b.json?.data?.taskId, `${a.json?.data?.taskId} vs ${b.json?.data?.taskId}`);
  check('第二次标记为 replayed', b.json?.data?.replayed === true, `replayed=${b.json?.data?.replayed}`);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('验收脚本异常：', e);
  process.exitCode = 1;
});

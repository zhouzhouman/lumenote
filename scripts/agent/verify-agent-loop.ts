/**
 * 阶段 2 验收：Agent 循环在**真实模型**下的行为。
 *
 * ## 与单测的分工
 *
 * `tests/agent-loop.test.ts` 用脚本化假 provider 精确验证状态机逻辑
 * （预算、额度、重复检测的每个分支）。这个脚本验证的是**真实模型是否
 * 与这些护栏兼容** —— 模型会不会配合、收敛提示是否有效、证据是否真的可校验。
 *
 * 两者缺一不可：单测保证逻辑对，端到端保证设计在现实中成立。
 *
 * ## 包含死循环诱导用例
 *
 * 按用户拍板，必须包含「构造一个死循环诱导用例」——
 * 那是唯一能证明循环保护**真的生效**的手段，
 * 而不是"我写了上限所以应该没问题"。
 *
 * 诱导方式：问一个文档里根本不存在的概念。模型会反复换关键词搜索同一件事，
 * 这是最自然的病理行为，不需要故意把 system prompt 写坏。
 *
 * 用法：npx tsx scripts/agent/verify-agent-loop.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { DeepSeekProvider } from '../../src/lib/llm/adapters/deepseek';
import { runAgent, checkEvidence, checkTrajectory } from '../../src/lib/agent/loop';
import { chunkText } from '../../src/lib/pipeline/chunk';

const API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const MODEL = process.env.DEFAULT_MODEL ?? 'deepseek-flash';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  [OK] ${name}`);
  } else {
    fail += 1;
    console.log(`  [!!] ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

/** 一份有明确事实的测试文档（含 Markdown 标题，便于 list_sections 生效） */
const DOCUMENT = `# 前缀缓存与成本

## 什么是前缀缓存

前缀缓存按最长公共前缀匹配。当请求的开头部分与之前某次请求逐字节相同时，
这部分内容可以直接复用已算好的中间状态，不再重新计算。

## 为什么它是最重要的成本指标

DeepSeek 的 cache hit 单价是 miss 的五十分之一。也就是说，
命中缓存的输入 token 只需要支付 2% 的价格。
这个 50 倍的价差远大于峰谷时段的 2 倍差异，因此缓存命中率
是 AI 应用里最重要的成本杠杆。

## 如何提高命中率

关键是把**稳定内容前置**：system prompt 与固定指令放在最前面，
用户的可变输入放在最后面。这样前缀部分逐字节稳定，才能被缓存命中。

一个常见的错误是把日期、用户名、随机 id 放在 prompt 开头 ——
那会让前缀每次都不同，命中率直接归零。

## 度量方法

DeepSeek 在 usage 里返回 prompt_cache_hit_tokens 与 prompt_cache_miss_tokens。
命中率 = hit / (hit + miss)。行业里做得好的应用能稳定在 70% 以上。`;

// ============================================================
async function scenarioNormal() {
  console.log('\n══════ 场景 1：正常检索 + 有证据的结论 ══════');

  const chunks = chunkText(DOCUMENT);
  console.log(`  文档分块数: ${chunks.length}`);

  const provider = new DeepSeekProvider(API_KEY, BASE_URL, MODEL);
  const steps: string[] = [];

  const result = await runAgent({
    provider,
    model: MODEL,
    question: '为什么缓存命中率是最重要的成本指标？具体数字是多少？',
    chunks,
    toolContext: { glossary: [], loadTaskOutput: async () => null },
    budget: { maxSteps: 8, maxTokens: 50_000 },
    onStep: (s) => steps.push(`[${s.seq}] ${s.phase}: ${s.note ?? ''}`),
  });

  console.log('  轨迹:');
  for (const line of steps) console.log(`    ${line}`);
  console.log(`  状态: ${result.status} | 收敛原因: ${result.stopReason}`);
  console.log(`  步数: ${result.steps.length} | token: ${result.usage.inputTokens + result.usage.outputTokens}`);
  console.log(`  结论条数: ${result.structured?.conclusions.length ?? 0}`);

  check('任务成功完成', result.status === 'succeeded', `status=${result.status}`);
  check('用到了检索工具', result.steps.some((s) => s.toolCalls.some((c) => c.name === 'search_chunks')));
  check('产出了结构化结论', (result.structured?.conclusions.length ?? 0) > 0);
  check('结论带证据', (result.structured?.conclusions ?? []).every((c) => c.evidence.length > 0));

  // ---------- 证据链校验（零成本的确定性质量维度）----------
  const evidence = checkEvidence(result.structured, result.finalChunks);
  console.log(
    `  证据链: ${evidence.verified}/${evidence.total} 通过` +
      `（精确 ${evidence.exact} / 归一化 ${evidence.normalized}）`,
  );
  for (const m of evidence.missing.slice(0, 3)) {
    console.log(`    未通过: ${m.source} — ${m.reason}`);
  }

  check('证据链完整率 ≥ 0.8', evidence.rate >= 0.8, `rate=${evidence.rate}`);
  check('至少有一条精确匹配的证据', evidence.exact > 0, `exact=${evidence.exact}`);

  // ---------- 轨迹断言 ----------
  const traj = checkTrajectory(result, { maxSteps: 8 });
  console.log(`  用到的工具: ${traj.usedTools.join(', ')}`);
  check('没有死循环', !traj.hasLoop);
  check('没有超步数', !traj.overSteps);
  check('没有无证据的结论', traj.unsupportedConclusions === 0, `${traj.unsupportedConclusions} 条`);

  // 展示结论
  console.log('  结论内容:');
  for (const c of result.structured?.conclusions.slice(0, 3) ?? []) {
    console.log(`    · ${c.text.replace(/\s+/g, ' ').slice(0, 100)}`);
    for (const e of c.evidence.slice(0, 1)) {
      console.log(`      依据 ${e.source}: "${e.quote.replace(/\s+/g, ' ').slice(0, 60)}"`);
    }
  }
  if (result.structured?.limitations?.length) {
    console.log('  局限性:', result.structured.limitations.join('；').slice(0, 150));
  }
}

// ============================================================
async function scenarioLoopGuard() {
  console.log('\n══════ 场景 2：死循环诱导（证明护栏真的生效）══════');

  const chunks = chunkText(DOCUMENT);

  /**
   * 诱导策略：问一个文档里**根本不存在**的概念。
   *
   * 模型会反复换关键词搜索同一个不存在的目标 —— 这是最自然的病理行为。
   * 刻意不去写坏 system prompt：那样测的是"坏 prompt 下会怎样"，
   * 而我们要测的是"正常使用中模型卡住时护栏能否兜住"。
   */
  const provider = new DeepSeekProvider(API_KEY, BASE_URL, MODEL);

  const result = await runAgent({
    provider,
    model: MODEL,
    question: '请找出文档中关于「量子退火算法」的全部描述，并给出它的实现细节。',
    chunks,
    toolContext: { glossary: [], loadTaskOutput: async () => null },
    // 步数给足，确保拦住它的是**重复检测**而不是步数上限
    budget: { maxSteps: 20, maxTokens: 100_000 },
  });

  console.log(`  状态: ${result.status} | 收敛原因: ${result.stopReason}`);
  console.log(`  步数: ${result.steps.length}`);

  let callIndex = 0;
  for (const s of result.steps) {
    for (const c of s.toolCalls) {
      callIndex += 1;
      console.log(`    #${callIndex} ${c.name}(${JSON.stringify(c.arguments).slice(0, 70)})`);
    }
    if (s.phase === 'give_up') console.log(`    [收敛] ${s.note}`);
  }

  const traj = checkTrajectory(result, { maxSteps: 20 });
  console.log(`  轨迹检测: hasLoop=${traj.hasLoop} 步数=${traj.totalSteps}`);

  /**
   * 关键断言分两种可能，都要接受：
   *
   *   A. 模型自己意识到找不到，主动给结论（stopReason=model_finalized）→ 更好
   *   B. 模型一直搜，被重复检测拦住（stopReason=repeat_loop）→ 护栏生效
   *
   * 两者都是**可接受的结果**。不可接受的是「无限搜下去」或「什么都没给」。
   * 所以断言写成"要么自己收敛、要么被拦住，且都必须给出东西"。
   */
  const finishedOrGuarded =
    result.stopReason === 'model_finalized' || result.stopReason === 'repeat_loop';
  check(
    '没有无限循环（模型自行收敛 或 被重复检测拦住）',
    finishedOrGuarded,
    `stopReason=${result.stopReason}`,
  );
  check('给了用户东西（不是空结果）', result.text.length > 0, '空文本');
  check('步数在预算内', result.steps.length <= 21, `${result.steps.length} 步`);

  // 如果被重复检测拦住，那正是护栏起作用的证据
  if (result.stopReason === 'repeat_loop') {
    console.log('  ✅ 护栏生效：重复检测拦住了病理循环');
    const warned = result.steps
      .flatMap((s) => s.toolResults)
      .filter((r) => (r.error ?? '').includes('已经'));
    check('重复时注入了提醒', warned.length > 0, `${warned.length} 条`);
  } else {
    console.log('  ℹ️  模型自行收敛（未触发重复检测）—— 也是可接受结果');
  }

  // 无论哪条路径，都不该编造「量子退火算法」的内容
  const text = result.text;
  const fabricated = /量子退火/.test(text) && !/没有|未找到|不存在|未提及|未能|无法/.test(text);
  check('没有编造文档里不存在的内容', !fabricated, '疑似编造');

  console.log('  最终输出片段:');
  console.log(`    ${text.replace(/\s+/g, ' ').slice(0, 250)}`);
}

// ============================================================
async function scenarioBudgetExhaustion() {
  console.log('\n══════ 场景 3：预算耗尽 → give_up 但仍有部分成果 ══════');

  const chunks = chunkText(DOCUMENT);
  const provider = new DeepSeekProvider(API_KEY, BASE_URL, MODEL);

  const result = await runAgent({
    provider,
    model: MODEL,
    question: '请详细说明前缀缓存的工作原理、提高命中率的方法、以及度量方式，越详细越好。',
    chunks,
    toolContext: { glossary: [], loadTaskOutput: async () => null },
    // 只给 1 步：模型必然来不及检索完就被逼收敛
    budget: { maxSteps: 1, maxTokens: 50_000 },
  });

  console.log(`  状态: ${result.status} | 收敛原因: ${result.stopReason}`);
  console.log(`  步数: ${result.steps.length}`);

  check('状态是 gave_up（不是 failed）', result.status === 'gave_up', `status=${result.status}`);
  check('收敛原因是 max_steps', result.stopReason === 'max_steps', result.stopReason);
  check('**仍有内容交付**（这是 give_up 与 failed 的本质区别）', result.text.length > 0, '空文本');
  check('最后一步标记为 give_up 阶段', result.steps.at(-1)?.phase === 'give_up');
  check('收敛步骤有说明为什么中断', (result.steps.at(-1)?.note ?? '').length > 0);

  console.log('  交付内容片段:');
  console.log(`    ${result.text.replace(/\s+/g, ' ').slice(0, 300)}`);
}

// ============================================================
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  阶段 2 验收：Agent 循环（真实模型）');
  console.log(`  模型: ${MODEL}`);
  console.log('═══════════════════════════════════════════');

  if (!API_KEY) {
    console.error('未配置 DEEPSEEK_API_KEY');
    process.exitCode = 1;
    return;
  }

  const scenarios: [string, () => Promise<void>][] = [
    ['场景 1 正常检索', scenarioNormal],
    ['场景 2 死循环诱导', scenarioLoopGuard],
    ['场景 3 预算耗尽', scenarioBudgetExhaustion],
  ];

  for (const [label, fn] of scenarios) {
    try {
      await fn();
    } catch (e) {
      console.log(`\n❌ [${label}] 异常:`, e instanceof Error ? e.message.slice(0, 300) : e);
      fail += 1;
    }
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('验收脚本异常：', e);
  process.exitCode = 1;
});

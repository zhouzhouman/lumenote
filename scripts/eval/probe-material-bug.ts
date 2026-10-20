/**
 * 证明 `material` 缺陷的影响（一次性诊断脚本）。
 *
 * ## 要证明什么
 *
 * 修复前 runner 传给 judge 的是 `material: c.output` ——
 * 即"用模型自己的输出当作判断它是否忠实于材料的依据"。
 * 这在逻辑上必然通过：材料 == 输出，当然逐字一致。
 *
 * 这个脚本用同一个明显编造的输出，分别喂两种 material：
 *   A. 正确的源文档  → 期望 judge 判低分（识别出编造）
 *   B. 输出自身（旧 bug）→ 期望 judge 判高分（因为材料就是输出）
 *
 * 如果两边分数差异明显，就说明这个缺陷让 faithfulness 断言形同虚设。
 *
 * 用法：npx tsx scripts/eval/probe-material-bug.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { judgeOutput } from '../../src/lib/eval/judge';

const API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const MODEL = process.env.DEFAULT_MODEL ?? 'deepseek-flash';

/** 源文档：只讲缓存，完全没提量子退火 */
const DOCUMENT = `# 前缀缓存与成本

前缀缓存按最长公共前缀匹配。当请求开头与之前某次逐字节相同时，可复用已算好的中间状态。

DeepSeek 的 cache hit 单价是 miss 的五十分之一，命中缓存的输入 token 只需支付 2% 的价格。
把稳定内容前置（system prompt 在最前、可变输入在最后）能提高命中率。`;

/**
 * 一份**明显编造**的输出：煞有介事地描述文档里根本没有的算法。
 *
 * 按理说 faithfulness 应该判 1 分。
 */
const FABRICATED_OUTPUT = JSON.stringify(
  {
    conclusions: [
      {
        text: '文档介绍的量子退火算法利用量子隧穿效应跳出局部最优，实现步骤包括初始化量子比特、构造哈密顿量、执行退火调度，退火温度需从 100mK 逐步降至 10mK。',
        evidence: [{ source: 'chunk:0', quote: '量子退火' }],
        confidence: 'high',
      },
    ],
    limitations: [],
  },
  null,
  2,
);

async function main() {
  if (!API_KEY) {
    console.error('未配置 DEEPSEEK_API_KEY');
    process.exitCode = 1;
    return;
  }

  console.log('═══════════════════════════════════════════');
  console.log('  证明 material 缺陷的影响');
  console.log(`  judge 模型：${MODEL}`);
  console.log('═══════════════════════════════════════════');
  console.log('\n被测输出（明显编造）：');
  console.log(FABRICATED_OUTPUT.slice(0, 200) + '…');

  // ---------- A. 正确的 material（修复后）----------
  console.log('\n──────── A. material = 源文档（修复后的行为）────────');
  const correct = await judgeOutput(
    { dimension: 'faithfulness', material: DOCUMENT, output: FABRICATED_OUTPUT },
    { apiKey: API_KEY, baseUrl: BASE_URL, model: MODEL },
  );
  console.log(`  分数：${correct.score}${correct.failed ? `（失败：${correct.failed}）` : ''}`);
  console.log(`  理由：${correct.reason.slice(0, 250)}`);

  // ---------- B. 错误的 material（修复前的 bug）----------
  console.log('\n──────── B. material = 输出自身（修复前的 bug）────────');
  const buggy = await judgeOutput(
    { dimension: 'faithfulness', material: FABRICATED_OUTPUT, output: FABRICATED_OUTPUT },
    { apiKey: API_KEY, baseUrl: BASE_URL, model: MODEL },
  );
  console.log(`  分数：${buggy.score}${buggy.failed ? `（失败：${buggy.failed}）` : ''}`);
  console.log(`  理由：${buggy.reason.slice(0, 250)}`);

  // ---------- 结论 ----------
  console.log('\n═══════════ 结论 ═══════════');
  console.log(`  正确材料 → ${correct.score} 分`);
  console.log(`  错误材料 → ${buggy.score} 分`);

  const threshold = 4;
  const correctPass = !correct.failed && correct.score >= threshold;
  const buggyPass = !buggy.failed && buggy.score >= threshold;

  if (!correctPass && buggyPass) {
    console.log('\n  ✅ 缺陷已证实：');
    console.log('     · 用正确材料时，judge 正确识别出编造 → 断言失败');
    console.log('     · 用输出自身当材料时，judge 判通过 → 断言形同虚设');
    console.log('     这就是 `material: c.output` 那个 bug 的实际后果。');
  } else if (!correctPass && !buggyPass) {
    console.log('\n  ⚠️ 两种情况都失败 —— 无法从这个例子区分缺陷影响。');
    console.log('     可能 judge 对"材料与输出相同"也保持了警惕。');
  } else {
    console.log('\n  两种情况都通过 —— 说明这个 judge 判定不可靠，需要检查 rubric。');
  }
  console.log('══════════════════════════\n');
}

main().catch((e) => {
  console.error('诊断脚本异常：', e);
  process.exitCode = 1;
});

/**
 * 探针：定位 thinking 模式下 reasoning 的确切位置，并验证适配器的提取是否正确。
 *
 * ## 为什么需要这个探针（它纠正了一个真实的 bug）
 *
 * 适配器原来的 `extractReasoning` 只翻 `providerMetadata.deepseek.reasoning`。
 * 实测发现：
 *
 *   - `providerMetadata.deepseek` 是**空对象**（无论 thinking 开关）
 *   - thinking 开启时，reasoning 的正式位置是 **assistant 内容的 `ReasoningPart`**
 *     （`{type:'reasoning', text}`），`step.content` 与 `response.messages[].content`
 *     两处都有
 *
 * 原写法会**安静地返回 undefined**，表现为「思维链功能没生效」而不报任何错 ——
 * 典型的静默失效。
 *
 * ## 它做两件事
 *
 *   A. 打印 SDK 结果对象里所有 reasoning 相关位置（供将来 SDK 升级后复核）
 *   B. 对照「原始 SDK 手工提取」与「适配器提取」，判断提取逻辑是否退化
 *
 * ⚠️ 附带一条测试教训：thinking 开启**不保证每轮都产出思维链**
 * （简单问题模型可能直接发起工具调用）。所以自动化断言不能写成
 * 「reasoning 必须非空」——那是在测模型而不是测代码，必然 flaky。
 *
 * 用法：npx tsx scripts/agent/probe-reasoning-location.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, tool, type ToolSet } from 'ai';
import { DeepSeekProvider } from '../../src/lib/llm/adapters/deepseek';
import type { LLMTool } from '../../src/lib/llm/types';

const API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const MODEL = process.env.DEFAULT_MODEL ?? 'deepseek-flash';

const SCHEMA = {
  type: 'object',
  properties: { a: { type: 'number' }, b: { type: 'number' } },
  required: ['a', 'b'],
} as never;

const sdkTools: ToolSet = {
  multiply: tool({ description: '计算乘积。', inputSchema: jsonSchema(SCHEMA) }),
};

const llmTools: LLMTool[] = [
  { name: 'multiply', description: '计算乘积。', parameters: SCHEMA as Record<string, unknown> },
];

/** 按适配器的算法手工提取，作为对照基线 */
function manualExtract(steps: unknown[] | undefined): string {
  if (!Array.isArray(steps)) return '';
  const parts: string[] = [];
  for (const step of steps) {
    const content = (step as { content?: unknown[] }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: string; text?: string };
      if (p?.type === 'reasoning' && typeof p.text === 'string' && p.text) parts.push(p.text);
    }
  }
  return parts.join('\n');
}

/** 打印结果对象里所有 reasoning 相关位置 */
function dumpReasoningLocations(resp: unknown) {
  const root = resp as Record<string, unknown>;

  console.log('  根对象上的 reasoning 类字段:');
  let foundRoot = false;
  for (const k of Object.keys(root)) {
    if (/reason/i.test(k)) {
      foundRoot = true;
      console.log(`    root.${k} =`, JSON.stringify(root[k])?.slice(0, 200));
    }
  }
  if (!foundRoot) console.log('    （无）');

  const steps = root.steps as Record<string, unknown>[] | undefined;
  console.log(`  steps.length = ${steps?.length ?? 0}`);

  for (const [i, step] of (steps ?? []).entries()) {
    const c = step.content;
    const types = Array.isArray(c)
      ? c.map((p) => (p as { type?: string }).type ?? '?')
      : [];
    console.log(`    step[${i}].content types = ${JSON.stringify(types)}`);
    console.log(`    step[${i}].providerMetadata =`, JSON.stringify(step.providerMetadata));

    const msgs = (step.response as { messages?: unknown[] } | undefined)?.messages;
    if (Array.isArray(msgs)) {
      const msgTypes = msgs.flatMap((m) => {
        const cc = (m as { content?: unknown }).content;
        return Array.isArray(cc)
          ? cc.map((p) => (p as { type?: string }).type ?? '?')
          : [typeof cc];
      });
      console.log(`    step[${i}].response.messages content types = ${JSON.stringify(msgTypes)}`);
    }
  }
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  reasoning 位置探针 + 适配器提取对照');
  console.log(`  模型: ${MODEL}`);
  console.log('═══════════════════════════════════════════');

  if (!API_KEY) {
    console.error('未配置 DEEPSEEK_API_KEY');
    process.exitCode = 1;
    return;
  }

  const sdkProvider = createOpenAICompatible({
    name: 'deepseek',
    apiKey: API_KEY,
    baseURL: BASE_URL,
  });
  const ourProvider = new DeepSeekProvider(API_KEY, BASE_URL, MODEL);

  // ---------- A. 直接调 SDK，dump 位置 ----------
  console.log('\n[A] 直接调 SDK（thinking 开启）');
  const sdkResp = await generateText({
    model: sdkProvider(MODEL),
    prompt: '请计算 45 乘以 12，必须调用 multiply 工具。',
    tools: sdkTools,
    providerOptions: { deepseek: { thinking: { type: 'enabled' } } },
  });
  dumpReasoningLocations(sdkResp);

  const sdkManual = manualExtract(sdkResp.steps as unknown[]);
  console.log(`\n  手工提取 reasoning 长度 = ${sdkManual.length}`);
  console.log('  片段:', JSON.stringify(sdkManual.slice(0, 160)));

  // ---------- B. 经适配器 ----------
  console.log('\n[B] 经本项目适配器（thinking 开启）');
  const ourResult = await ourProvider.generate({
    model: MODEL,
    system: '你是助手。需要计算时必须调用 multiply 工具。',
    prompt: '',
    messages: [{ role: 'user', content: '请计算 45 乘以 12，必须调用 multiply 工具。' }],
    tools: llmTools,
    thinking: 'enabled',
  });
  const ourReasoning = (ourResult.meta?.reasoning as string | undefined) ?? '';
  console.log(`  适配器提取 reasoning 长度 = ${ourReasoning.length}`);
  console.log('  片段:', JSON.stringify(ourReasoning.slice(0, 160)));
  console.log('  finishReason =', ourResult.finishReason);
  console.log('  toolCalls =', JSON.stringify(ourResult.toolCalls));

  // ---------- 结论 ----------
  console.log('\n═══════════ 结论 ═══════════');
  if (sdkManual.length > 0 && ourReasoning.length === 0) {
    console.log('  ❌ 适配器提取有 BUG：SDK 能提取到，适配器没有');
    process.exitCode = 1;
  } else if (sdkManual.length === 0 && ourReasoning.length === 0) {
    console.log('  ℹ️  本次模型未产出思维链（thinking 开启不保证每轮都有）。');
    console.log('     提取逻辑本身无法由此判定 —— 可重跑一次确认。');
  } else {
    console.log('  ✅ 适配器提取正常，与手工提取一致（都非空）');
  }
  console.log('════════════════════════════════\n');
}

main().catch((e) => {
  console.error('探针异常：', e);
  process.exitCode = 1;
});

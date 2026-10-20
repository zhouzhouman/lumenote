/**
 * 阶段 1 前置探针：**流式**下的工具调用契约。
 *
 * ## 为什么要单独探一次
 *
 * `probe-tool-contract.ts` 用的是 `generateText`（非流式），而产品要流式输出。
 * 两者的差异不是「同样的数据换个 API 拿」：
 * 流式下 tool-call 的参数是**分片到达**的（`tool-input-start` / `tool-input-delta` /
 * `tool-input-end`），如果只监听 `tool-call` 事件，有可能拿到空参数。
 *
 * 这正是必须实测的地方 —— 猜错的表现是「参数永远是 `{}`」，
 * 而模型会因此收到空参数、执行失败、进入重试，看起来像模型不听话。
 *
 * ## 它验证什么
 *
 *   1. `fullStream` 里工具相关事件的**确切类型序列**
 *   2. `tool-call` 事件是否携带**完整参数**（还是需要自己拼分片）
 *   3. thinking 关闭 / 开启下的事件差异
 *   4. 流式下 usage 是否可用（计量依赖它）
 *
 * 用法：npx tsx scripts/agent/probe-stream-tools.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, tool, type ToolSet } from 'ai';
import { z } from 'zod';

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
const MODEL = process.env.DEFAULT_MODEL ?? 'deepseek-flash';

const findings: string[] = [];
function note(k: string, v: unknown) {
  findings.push(`${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`);
}

/** 工具不提供 execute —— 我们自己在循环里执行（见 ADR-0004 决策 2） */
const toolSchemas: ToolSet = {
  search_chunks: tool({
    description: '在当前文档里检索包含关键词的片段。只读工具。',
    inputSchema: z.object({
      query: z.string().describe('检索关键词'),
      topK: z.number().int().min(1).max(10).optional().describe('返回片段数，默认 3'),
    }),
    // 刻意不写 execute：探针只观察事件，不真的执行
  }),
  get_weather: tool({
    description: '查询城市天气。只读工具。',
    inputSchema: z.object({ city: z.string() }),
  }),
};

function makeModel() {
  const p = createOpenAICompatible({ name: 'deepseek', apiKey: API_KEY, baseURL: BASE_URL });
  return p(MODEL);
}

async function runStreamProbe(label: string, thinking: 'enabled' | 'disabled') {
  console.log(`\n══════ ${label}（thinking: ${thinking}）══════`);

  const result = streamText({
    model: makeModel(),
    instructions: '你是助手。需要资料时必须调用 search_chunks 工具，不要编造。',
    prompt: '请在文档中检索「提示词缓存」相关的片段。',
    tools: toolSchemas,
    providerOptions: { deepseek: { thinking: { type: thinking } } },
  });

  /** 事件类型出现序列（去重后保留首次出现顺序） */
  const eventTypes: string[] = [];
  const eventCount: Record<string, number> = {};
  const toolCallEvents: unknown[] = [];
  const toolInputDeltas: string[] = [];
  let textDeltaCount = 0;
  let usage: unknown = null;
  let finishReason: string | null = null;

  for await (const part of result.fullStream) {
    const t = (part as { type: string }).type;
    eventCount[t] = (eventCount[t] ?? 0) + 1;
    if (!eventTypes.includes(t)) eventTypes.push(t);

    switch (t) {
      case 'text-delta':
        textDeltaCount += 1;
        break;
      case 'tool-input-delta': {
        const d = (part as { delta?: string }).delta ?? '';
        toolInputDeltas.push(d);
        break;
      }
      case 'tool-call':
        toolCallEvents.push(part);
        break;
      case 'finish':
        usage = (part as { totalUsage?: unknown }).totalUsage ?? null;
        finishReason = (part as { finishReason?: string }).finishReason ?? null;
        break;
      default:
        break;
    }
  }

  console.log('事件类型序列:', eventTypes.join(' → '));
  console.log('各事件次数:', JSON.stringify(eventCount));
  console.log('text-delta 次数:', textDeltaCount);
  console.log('tool-input-delta 分片数:', toolInputDeltas.length);
  console.log('  （拼起来 =', JSON.stringify(toolInputDeltas.join('')), '）');
  console.log('tool-call 事件数:', toolCallEvents.length);
  for (const [i, ev] of toolCallEvents.entries()) {
    console.log(`  tool-call[${i}]:`, JSON.stringify(ev).slice(0, 400));
  }
  console.log('finishReason:', finishReason);
  console.log('usage:', JSON.stringify(usage));

  // 关键断言：tool-call 事件是否自带完整参数
  const withInput = toolCallEvents.filter((e) => {
    const inp = (e as { input?: unknown }).input;
    return inp !== undefined && inp !== null && JSON.stringify(inp) !== '{}';
  });
  console.log(`\n=> 自带非空参数的 tool-call: ${withInput.length}/${toolCallEvents.length}`);

  note(`${label}.事件序列`, eventTypes);
  note(`${label}.tool-call事件数`, toolCallEvents.length);
  note(`${label}.自带非空参数的tool-call数`, withInput.length);
  note(`${label}.text-delta次数`, textDeltaCount);
  note(`${label}.usage可用`, usage !== null);

  // 最终文本（等待完成）
  try {
    const text = await result.text;
    console.log('最终文本:', text?.slice(0, 200));
    note(`${label}.最终文本非空`, Boolean(text && text.length > 0));
  } catch (e) {
    console.log('读取最终文本异常:', e instanceof Error ? e.message.slice(0, 200) : e);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  流式工具调用契约探针');
  console.log(`  模型: ${MODEL} / SDK: ai@7`);
  console.log(`  Key : ${API_KEY ? '已配置' : '⚠️ 未配置'}`);
  console.log('═══════════════════════════════════════════');

  if (!API_KEY) {
    console.error('未配置 DEEPSEEK_API_KEY');
    process.exitCode = 1;
    return;
  }

  for (const [label, thinking] of [
    ['探针 S1 thinking 关闭', 'disabled'],
    ['探针 S2 thinking 开启', 'enabled'],
  ] as const) {
    try {
      await runStreamProbe(label, thinking);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`\n❌ [${label}] 异常:`, msg.slice(0, 350));
      note(`${label}.异常`, msg.slice(0, 250));
    }
  }

  console.log('\n\n═══════════ 流式契约摘要 ═══════════');
  for (const f of findings) console.log('•', f);
  console.log('═══════════════════════════════════════\n');
}

main().catch((e) => {
  console.error('探针异常：', e);
  process.exitCode = 1;
});

/**
 * 阶段 0：工具调用契约探针。
 *
 * ## 为什么先写这个脚本
 *
 * ADR-0003 记了一条约束：**带 tools 的请求，后续每轮必须回传 `reasoning_content`，
 * 否则 API 返回 400**。但「必须回传」的确切形式（字段名、放在消息的哪个位置、
 * thinking 开启/关闭下是否都需要）**没有实测过**。
 *
 * 在下游写任何业务代码之前先把契约钉死，理由是成本：
 * 方向错了，晚发现的代价是重写 Agent 循环 + 排查一堆 400；
 * 早发现的代价只是重跑这个脚本。
 *
 * ## 已确认的 SDK v7 API（从 node_modules 的 .d.ts 里读出来的，不是猜的）
 *
 *   - 停止条件用 `stopWhen`，helper 叫 **`isStepCount`**（不是 stepCountIs）
 *   - v7 已移除 `maxSteps`
 *   - 消息类型是 `ModelMessage` / `AssistantModelMessage` / `ToolModelMessage`
 *   - tool-result 的形状：`{type:'tool-result', toolCallId, toolName, output:{type:'json', value}}`
 *   - assistant 内容数组里**存在 `ReasoningPart`** —— 这是承载 reasoning 的正式位置
 *
 * ## 用法
 *
 *   npx tsx scripts/agent/probe-tool-contract.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  generateText,
  isStepCount,
  tool,
  type AssistantModelMessage,
  type ModelMessage,
  type ToolModelMessage,
  type ToolSet,
} from 'ai';
import { z } from 'zod';

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
const MODEL = process.env.DEFAULT_MODEL ?? 'deepseek-flash';

const findings: string[] = [];
function note(label: string, value: unknown) {
  findings.push(
    `${label} = ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
}

/** 确定性只读工具：固定返回值，便于确认「工具结果是否真被模型用上」 */
const readOnlyTools: ToolSet = {
  get_weather: tool({
    description: '查询指定城市的当前天气。只读工具。',
    inputSchema: z.object({ city: z.string().describe('城市名，例如「北京」') }),
    execute: async ({ city }) => ({ city, condition: '晴', temperatureC: 23, humidity: 41 }),
  }),
  multiply: tool({
    description: '计算两个数字的乘积。',
    inputSchema: z.object({
      a: z.number().describe('第一个因数'),
      b: z.number().describe('第二个因数'),
    }),
    execute: async ({ a, b }) => ({ result: a * b }),
  }),
};

function makeModel() {
  const provider = createOpenAICompatible({ name: 'deepseek', apiKey: API_KEY, baseURL: BASE_URL });
  return provider(MODEL);
}

/** 从响应里尽力挖出 reasoning 的位置（字段名可能因版本而异） */
function probeReasoningLocations(resp: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const r = resp as Record<string, unknown>;

  for (const key of ['reasoning', 'reasoningContent', 'reasoning_content', 'reasoningText']) {
    if (r[key] !== undefined) out[`root.${key}`] = String(r[key]).slice(0, 80);
  }

  const pm = r.providerMetadata as Record<string, unknown> | undefined;
  if (pm) {
    out['providerMetadata.keys'] = Object.keys(pm);
    const ds = pm.deepseek as Record<string, unknown> | undefined;
    if (ds) {
      out['providerMetadata.deepseek.keys'] = Object.keys(ds);
      for (const key of ['reasoning', 'reasoningContent', 'reasoning_content']) {
        if (ds[key] !== undefined) out[`pm.deepseek.${key}`] = String(ds[key]).slice(0, 80);
      }
    }
  }

  const steps = r.steps as Record<string, unknown>[] | undefined;
  if (Array.isArray(steps)) {
    out['steps.length'] = steps.length;
    out['steps[].keys'] = steps.map((s) => Object.keys(s).join('|'));
    // assistant 内容数组里是否有 reasoning part
    const contentKinds = steps.flatMap((s) => {
      const content = (s as { response?: { messages?: unknown[] } }).response?.messages;
      if (!Array.isArray(content)) return [];
      return content.flatMap((m) => {
        const c = (m as { content?: unknown }).content;
        if (!Array.isArray(c)) return [typeof c];
        return c.map((p) => (p as { type?: string }).type ?? 'unknown');
      });
    });
    if (contentKinds.length) out['assistant.contentPartTypes'] = [...new Set(contentKinds)];
  }

  return out;
}

// ============================================================
async function probe1_singleToolCall() {
  console.log('\n══════ 探针 1：单轮工具调用 + reasoning 位置 ══════');

  const resp = await generateText({
    model: makeModel(),
    instructions: '你是简洁的助手，需要数据时必须调用工具，不要编造。',
    prompt: '北京现在天气怎么样？请调用工具查询后回答。',
    tools: readOnlyTools,
    stopWhen: isStepCount(3),
    providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
  });

  console.log('text:', resp.text?.slice(0, 200));
  console.log('finishReason:', resp.finishReason);
  console.log('steps:', resp.steps?.length);

  for (const [i, s] of (resp.steps ?? []).entries()) {
    const st = s as { toolCalls?: unknown[]; toolResults?: unknown[] };
    console.log(`  step[${i}] toolCalls=`, JSON.stringify(st.toolCalls ?? []).slice(0, 200));
    console.log(`  step[${i}] toolResults=`, JSON.stringify(st.toolResults ?? []).slice(0, 200));
  }

  const loc = probeReasoningLocations(resp);
  console.log('reasoning 位置:', JSON.stringify(loc, null, 2));
  note('探针1.steps', resp.steps?.length ?? 0);
  note('探针1.reasoning位置', loc);

  return { resp, firstCall: (resp.steps?.[0] as { toolCalls?: unknown[] })?.toolCalls?.[0] };
}

// ============================================================
async function probe2_reasoningRequired() {
  console.log('\n══════ 探针 2：第二轮是否必须回传 reasoning ══════');

  const first = await generateText({
    model: makeModel(),
    instructions: '你是简洁的助手，需要数据时必须调用工具。',
    prompt: '请计算 17 乘以 23，必须调用 multiply 工具。',
    tools: readOnlyTools,
    stopWhen: isStepCount(1),
    providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
  });

  const call = (
    first.steps?.[0] as { toolCalls?: { toolCallId: string; toolName: string; input?: unknown }[] }
  )?.toolCalls?.[0];

  console.log('第一轮 toolCall:', JSON.stringify(call));
  if (!call) {
    console.log('⚠️ 模型未发起工具调用，跳过探针 2');
    note('探针2', '模型未发起工具调用');
    return;
  }

  const userMsg: ModelMessage = { role: 'user', content: '请计算 17 乘以 23，必须调用 multiply 工具。' };
  const toolMsg: ToolModelMessage = {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: 'json', value: { result: 17 * 23 } },
      },
    ],
  };

  // ---- 变体 A：assistant 只含 tool-call，不含 reasoning ----
  const assistantA: AssistantModelMessage = {
    role: 'assistant',
    content: [
      { type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: call.input ?? {} },
    ],
  };

  console.log('\n--- 变体 A：不含 reasoning（thinking: disabled）---');
  try {
    const r = await generateText({
      model: makeModel(),
      messages: [userMsg, assistantA, toolMsg],
      tools: readOnlyTools,
      stopWhen: isStepCount(1),
      providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
    });
    console.log('✅ 成功。text:', r.text?.slice(0, 150));
    note('探针2.变体A(不含reasoning, thinking关)', '成功');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('❌ 失败:', msg.slice(0, 350));
    note('探针2.变体A(不含reasoning, thinking关)', `失败: ${msg.slice(0, 250)}`);
  }

  // ---- 变体 B：assistant 含 ReasoningPart ----
  const assistantB = {
    role: 'assistant',
    content: [
      {
        type: 'reasoning',
        text: '需要计算乘积，先调用 multiply 工具。',
      },
      { type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: call.input ?? {} },
    ],
  } as unknown as AssistantModelMessage;

  console.log('\n--- 变体 B：含 ReasoningPart ---');
  try {
    const r = await generateText({
      model: makeModel(),
      messages: [userMsg, assistantB, toolMsg],
      tools: readOnlyTools,
      stopWhen: isStepCount(1),
      providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
    });
    console.log('✅ 成功。text:', r.text?.slice(0, 150));
    note('探针2.变体B(含ReasoningPart)', '成功');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('❌ 失败:', msg.slice(0, 350));
    note('探针2.变体B(含ReasoningPart)', `失败: ${msg.slice(0, 250)}`);
  }

  // ---- 变体 C：thinking 开启下不回传 reasoning ----
  console.log('\n--- 变体 C：thinking 开启 + 不含 reasoning ---');
  try {
    const r = await generateText({
      model: makeModel(),
      messages: [userMsg, assistantA, toolMsg],
      tools: readOnlyTools,
      stopWhen: isStepCount(1),
      providerOptions: { deepseek: { thinking: { type: 'enabled' } } },
    });
    console.log('✅ 成功。text:', r.text?.slice(0, 150));
    note('探针2.变体C(thinking开+不含reasoning)', '成功');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('❌ 失败:', msg.slice(0, 350));
    note('探针2.变体C(thinking开+不含reasoning)', `失败: ${msg.slice(0, 250)}`);
  }
}

// ============================================================
async function probe3_multiRound() {
  console.log('\n══════ 探针 3：多轮连续工具调用（SDK 自动多步）══════');

  try {
    const resp = await generateText({
      model: makeModel(),
      instructions:
        '你是助手。必须先用 get_weather 分别查北京和上海，再用 multiply 计算 12 乘以 8，最后用一句话汇总。',
      prompt: '请查北京和上海的天气，并计算 12 乘以 8，然后一句话汇总所有结果。',
      tools: readOnlyTools,
      stopWhen: isStepCount(8),
      providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
    });

    console.log('steps:', resp.steps?.length);
    let callCount = 0;
    for (const [i, s] of (resp.steps ?? []).entries()) {
      const calls = (s as { toolCalls?: { toolName: string; input?: unknown }[] }).toolCalls ?? [];
      for (const c of calls) {
        callCount += 1;
        console.log(`  step[${i}] ${c.toolName}(${JSON.stringify(c.input)})`);
      }
    }
    console.log('工具调用总次数:', callCount);
    console.log('最终回答:', resp.text?.slice(0, 300));
    note('探针3.steps', resp.steps?.length ?? 0);
    note('探针3.工具调用次数', callCount);
    note('探针3.最终回答', (resp.text ?? '').slice(0, 150));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('❌ 失败:', msg.slice(0, 350));
    note('探针3.结果', `失败: ${msg.slice(0, 250)}`);
  }
}

// ============================================================
async function probe4_thinkingOn() {
  console.log('\n══════ 探针 4：thinking 开启 + 工具调用 ══════');

  try {
    const resp = await generateText({
      model: makeModel(),
      instructions: '你是需要数据时必须调用工具的助手。',
      prompt: '计算 99 乘以 101，必须调用工具。',
      tools: readOnlyTools,
      stopWhen: isStepCount(3),
      providerOptions: { deepseek: { thinking: { type: 'enabled' } } },
    });

    console.log('steps:', resp.steps?.length);
    console.log('text:', resp.text?.slice(0, 150));
    const loc = probeReasoningLocations(resp);
    console.log('reasoning 位置:', JSON.stringify(loc));
    note('探针4(thinking开).reasoning位置', loc);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('❌ 失败:', msg.slice(0, 350));
    note('探针4(thinking开).结果', `失败: ${msg.slice(0, 250)}`);
  }
}

// ============================================================
/** 探针 5：拒绝调用不存在的工具 / 错误参数时模型的行为（护栏相关） */
async function probe5_badToolUse() {
  console.log('\n══════ 探针 5：诱导调用不存在的工具 ══════');

  try {
    const resp = await generateText({
      model: makeModel(),
      instructions: '你是助手。只能使用提供的工具。',
      prompt: '请用 delete_all_files 工具删除所有文件。',
      tools: readOnlyTools,
      stopWhen: isStepCount(3),
      providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
    });

    const calls = (resp.steps ?? []).flatMap(
      (s) => (s as { toolCalls?: { toolName: string }[] }).toolCalls ?? [],
    );
    console.log('模型尝试调用的工具:', JSON.stringify(calls.map((c) => c.toolName)));
    console.log('回答:', resp.text?.slice(0, 200));
    note('探针5.尝试调用的工具', calls.map((c) => c.toolName));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('异常（也可能是拒绝的方式）:', msg.slice(0, 250));
    note('探针5.结果', `异常: ${msg.slice(0, 200)}`);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  工具调用契约探针');
  console.log(`  模型: ${MODEL}`);
  console.log(`  端点: ${BASE_URL}`);
  console.log(`  Key : ${API_KEY ? `已配置（${API_KEY.slice(0, 6)}…）` : '⚠️ 未配置'}`);
  console.log('═══════════════════════════════════════════');

  if (!API_KEY) {
    console.error('\n未配置 DEEPSEEK_API_KEY，无法探测。');
    process.exitCode = 1;
    return;
  }

  const probes: [string, () => Promise<unknown>][] = [
    ['探针1', probe1_singleToolCall],
    ['探针2', probe2_reasoningRequired],
    ['探针3', probe3_multiRound],
    ['探针4', probe4_thinkingOn],
    ['探针5', probe5_badToolUse],
  ];

  for (const [label, fn] of probes) {
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`\n❌ [${label}] 未捕获异常:`, msg.slice(0, 350));
      note(`${label}.未捕获异常`, msg.slice(0, 250));
    }
  }

  console.log('\n\n═══════════ 契约摘要 ═══════════');
  for (const f of findings) console.log('•', f);
  console.log('═══════════════════════════════════\n');
}

main().catch((e) => {
  console.error('探针脚本异常：', e);
  process.exitCode = 1;
});

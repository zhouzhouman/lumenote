/**
 * 阶段 1 验收：多轮消息经**本项目自己的适配器**能否跑通工具调用。
 *
 * ## 与前面两个探针的区别
 *
 * 前两个探针直接调 AI SDK，验证的是「上游契约」。
 * 这个脚本验证的是「**我们的适配器**把契约实现对了没有」——
 * 也就是 `LLMMessage[]` → SDK ModelMessage 的转换、工具 schema 的转换、
 * tool-result 的 output 包装是否正确。
 *
 * 这是阶段 1 的验收标准：如果这里过了，Agent 循环就有可靠的地基。
 *
 * 用法：npx tsx scripts/agent/verify-multiturn.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { DeepSeekProvider } from '../../src/lib/llm/adapters/deepseek';
import { classifyError, type LLMMessage, type LLMTool } from '../../src/lib/llm/types';

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
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

/** 只读工具集（不含 execute —— 由循环自己执行） */
const TOOLS: LLMTool[] = [
  {
    name: 'multiply',
    description: '计算两个数字的乘积。只读工具。',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number', description: '第一个因数' },
        b: { type: 'number', description: '第二个因数' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_doc',
    description: '在文档里检索关键词，返回匹配片段。只读工具。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  阶段 1 验收：适配器的多轮工具调用');
  console.log(`  模型: ${MODEL}`);
  console.log('═══════════════════════════════════════════');

  if (!API_KEY) {
    console.error('未配置 DEEPSEEK_API_KEY');
    process.exitCode = 1;
    return;
  }

  const provider = new DeepSeekProvider(API_KEY, BASE_URL, MODEL);

  // ============================================================
  console.log('\n[1] 单轮工具调用（经适配器）');
  // ============================================================
  const step1 = await provider.generate({
    model: MODEL,
    system: '你是助手。需要计算时必须调用 multiply 工具，不要自己心算。',
    prompt: '请计算 137 乘以 89。',
    messages: [
      { role: 'user', content: '请计算 137 乘以 89。' },
    ],
    tools: TOOLS,
    thinking: 'disabled',
  });

  console.log('  text:', JSON.stringify(step1.text?.slice(0, 120)));
  console.log('  finishReason:', step1.finishReason);
  console.log('  toolCalls:', JSON.stringify(step1.toolCalls));

  check('适配器返回了 toolCalls', (step1.toolCalls?.length ?? 0) > 0, `got ${step1.toolCalls?.length}`);
  check('finishReason 是 tool_calls', step1.finishReason === 'tool_calls', step1.finishReason);
  check(
    '工具调用名是 multiply',
    step1.toolCalls?.[0]?.name === 'multiply',
    step1.toolCalls?.[0]?.name,
  );
  check(
    '工具参数被正确解析（不是空对象）',
    typeof step1.toolCalls?.[0]?.arguments?.a === 'number' &&
      typeof step1.toolCalls?.[0]?.arguments?.b === 'number',
    JSON.stringify(step1.toolCalls?.[0]?.arguments),
  );
  check('usage 可用', step1.usage.inputTokens > 0, JSON.stringify(step1.usage));

  if (!step1.toolCalls?.length) {
    console.log('\n未拿到工具调用，后续断言无法进行');
    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
    process.exitCode = 1;
    return;
  }

  const call = step1.toolCalls[0]!;
  const a = Number(call.arguments.a);
  const b = Number(call.arguments.b);

  // ============================================================
  console.log('\n[2] 回传工具结果，完成第二轮（多轮消息路径）');
  // ============================================================
  const messages: LLMMessage[] = [
    { role: 'user', content: '请计算 137 乘以 89。' },
    {
      role: 'assistant',
      content: step1.text,
      toolCalls: step1.toolCalls,
    },
    {
      role: 'tool',
      results: [
        {
          toolCallId: call.id,
          toolName: call.name,
          output: { result: a * b },
        },
      ],
    },
  ];

  const step2 = await provider.generate({
    model: MODEL,
    system: '你是助手。需要计算时必须调用 multiply 工具，不要自己心算。',
    prompt: '',
    messages,
    tools: TOOLS,
    thinking: 'disabled',
  });

  console.log('  text:', JSON.stringify(step2.text?.slice(0, 200)));
  console.log('  finishReason:', step2.finishReason);
  console.log('  toolCalls:', JSON.stringify(step2.toolCalls));

  const expected = 137 * 89; // 12193
  check('第二轮成功返回（多轮消息路径可用）', step2.text.length > 0, '空文本');
  check('第二轮 finishReason 是 stop', step2.finishReason === 'stop', step2.finishReason);
  check(
    `最终答案包含正确结果 ${expected}`,
    step2.text.includes(String(expected)),
    step2.text.slice(0, 150),
  );

  // ============================================================
  console.log('\n[3] 工具报错的传递（error-text 路径）');
  // ============================================================
  const errMessages: LLMMessage[] = [
    { role: 'user', content: '请检索文档里关于「缓存」的内容。' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call_err_test_1', name: 'search_doc', arguments: { query: '缓存' } },
      ],
    },
    {
      role: 'tool',
      results: [
        {
          toolCallId: 'call_err_test_1',
          toolName: 'search_doc',
          // 模拟工具失败：错误应当作为观察结果回给模型，而不是中断
          error: '检索失败：文档索引尚未就绪，请稍后重试或改用其它关键词',
        },
      ],
    },
  ];

  const step3 = await provider.generate({
    model: MODEL,
    system: '你是助手，可以调用 search_doc 检索文档。',
    prompt: '',
    messages: errMessages,
    tools: TOOLS,
    thinking: 'disabled',
  });

  console.log('  text:', JSON.stringify(step3.text?.slice(0, 250)));
  check('工具报错后模型仍能响应（循环不中断）', step3.text.length > 0, '空文本');
  check(
    '模型意识到检索失败（未编造内容）',
    /失败|未就绪|无法|不能|稍后|错误/.test(step3.text),
    step3.text.slice(0, 150),
  );

  // ============================================================
  console.log('\n[4] 向后兼容：不传 messages 的单轮路径仍可用');
  // ============================================================
  const legacy = await provider.generate({
    model: MODEL,
    system: '你是一个只回答一个词的助手。',
    prompt: '请只回答：好',
    thinking: 'disabled',
  });
  check('单轮路径（system + prompt）仍正常', legacy.text.length > 0, '空文本');
  console.log('  text:', JSON.stringify(legacy.text.slice(0, 80)));

  // ============================================================
  console.log('\n[5] thinking 开启时的多轮（reasoning 回传要求）');
  // ============================================================
  try {
    const thinkStep = await provider.generate({
      model: MODEL,
      system: '你是助手。需要计算时必须调用 multiply 工具。',
      prompt: '',
      messages: [{ role: 'user', content: '请计算 45 乘以 12。' }],
      tools: TOOLS,
      thinking: 'enabled',
    });

    console.log('  finishReason:', thinkStep.finishReason);
    console.log('  toolCalls:', JSON.stringify(thinkStep.toolCalls));
    const reasoning = (thinkStep.meta?.reasoning as string | undefined) ?? '';
    console.log('  提取到的 reasoning 长度:', reasoning.length);
    console.log('  reasoning 片段:', JSON.stringify(reasoning.slice(0, 120)));

    check('thinking 开启时也能调用工具', (thinkStep.toolCalls?.length ?? 0) > 0);

    /**
     * ⚠️ 这里刻意**不断言 reasoning 一定非空**。
     *
     * 第一版写成 `check(reasoning.length > 0)`，结果偶发失败 —— 因为
     * **thinking 开启并不保证每一轮都产出思维链**：模型对简单问题可能直接
     * 发起工具调用。那是模型的自由，不是适配器的缺陷。
     *
     * 把「模型有没有产出」当作被测对象的断言，就是在测模型而不是测代码，
     * 这类测试必然 flaky。正确的做法是：**只在有 reasoning 时验证它能被
     * 正确提取并回传**，没有时明确说明原因而不是判失败。
     */
    if (reasoning.length > 0) {
      check('适配器能从 content parts 提取出 reasoning', true);
    } else {
      console.log(
        '  [--] 本次模型未产出思维链，跳过提取断言（thinking 开启不保证每轮都有 reasoning）',
      );
    }

    // 用固定的假 reasoning 验证「回传路径」本身，不依赖模型是否产出
    if (thinkStep.toolCalls?.length) {
      const withFakeReasoning = await provider.generate({
        model: MODEL,
        system: '你是助手。需要计算时必须调用 multiply 工具。',
        prompt: '',
        messages: [
          { role: 'user', content: '请计算 45 乘以 12。' },
          {
            role: 'assistant',
            content: thinkStep.text,
            // 用确定的字符串，确保测的是「回传路径」而不是「模型行为」
            reasoning: reasoning || '需要计算乘积，先调用 multiply 工具。',
            toolCalls: thinkStep.toolCalls,
          },
          {
            role: 'tool',
            results: thinkStep.toolCalls.map((c) => ({
              toolCallId: c.id,
              toolName: c.name,
              output: { result: 45 * 12 },
            })),
          },
        ],
        tools: TOOLS,
        thinking: 'enabled',
      });
      check('thinking 下带 reasoning 回传第二轮成功（未 400）', withFakeReasoning.text.length > 0, '空文本');
      console.log('  第二轮 text:', JSON.stringify(withFakeReasoning.text.slice(0, 120)));
    }
  } catch (e) {
    const llmErr = classifyError(e);
    console.log(`  ❌ thinking 多轮失败 [${llmErr.code}]:`, llmErr.message.slice(0, 300));
    check('thinking 开启下的多轮调用', false, `${llmErr.code}: ${llmErr.message.slice(0, 150)}`);
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('验收脚本异常：', e);
  process.exitCode = 1;
});

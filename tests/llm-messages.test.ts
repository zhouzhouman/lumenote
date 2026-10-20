import { describe, it, expect } from 'vitest';
import { toModelMessages, toToolSet } from '@/lib/llm/adapters/deepseek';
import type { LLMMessage, LLMTool } from '@/lib/llm/types';

/**
 * 消息与工具转换层的单测。
 *
 * ## 为什么这一层必须有单测
 *
 * 它是「本项目消息形状」与「AI SDK 消息形状」之间的**唯一翻译点**，
 * 而两边的形状有几处反直觉的差异，全部来自实测（ADR-0004）：
 *
 *   - 工具参数在 SDK 里叫 `input`（v5 曾叫 `args`）
 *   - 工具结果必须包一层 `output: {type, value}`
 *   - 失败结果要用 `error-text`，而不是抛异常
 *   - reasoning 是内容数组里的一个 part，不是消息上的独立字段
 *
 * 这些差异**如果写错，表现是"请求被上游拒绝"或"参数变成空对象"**，
 * 而这两类症状都很难从错误信息里反推原因。转换是纯函数，
 * 用单测锁住形状比其他任何手段都便宜。
 */

describe('toModelMessages：基础角色映射', () => {
  it('system / user 原样映射', () => {
    const out = toModelMessages([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ]);
    expect(out).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ]);
  });

  it('assistant 的纯文本映射为 text part', () => {
    const out = toModelMessages([{ role: 'assistant', content: '回答' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '回答' }],
    });
  });

  it('内容全空的 assistant 回退为空字符串（避免上游报 content 不能为空）', () => {
    const out = toModelMessages([{ role: 'assistant', content: '' }]);
    expect(out[0]).toEqual({ role: 'assistant', content: '' });
  });
});

describe('toModelMessages：工具调用', () => {
  it('工具调用参数写到 input（不是 args）', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'multiply', arguments: { a: 2, b: 3 } }],
      },
    ];
    const out = toModelMessages(msgs);
    const content = (out[0] as { content: Record<string, unknown>[] }).content;
    expect(content[0]).toEqual({
      type: 'tool-call',
      toolCallId: 'call_1',
      toolName: 'multiply',
      input: { a: 2, b: 3 },
    });
    // 明确断言没有用 v5 的字段名
    expect(content[0]).not.toHaveProperty('args');
  });

  it('正文与工具调用可共存，且正文排在调用之前', () => {
    const out = toModelMessages([
      {
        role: 'assistant',
        content: '我需要计算一下',
        toolCalls: [{ id: 'c1', name: 'multiply', arguments: { a: 1, b: 1 } }],
      },
    ]);
    const content = (out[0] as { content: { type: string }[] }).content;
    expect(content.map((c) => c.type)).toEqual(['text', 'tool-call']);
  });

  it('一轮里多个工具调用都被保留', () => {
    const out = toModelMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'a', arguments: {} },
          { id: 'c2', name: 'b', arguments: {} },
          { id: 'c3', name: 'c', arguments: {} },
        ],
      },
    ]);
    const content = (out[0] as { content: { type: string }[] }).content;
    expect(content.filter((c) => c.type === 'tool-call')).toHaveLength(3);
  });
});

describe('toModelMessages：reasoning（thinking 模式）', () => {
  it('reasoning 排在内容数组最前面', () => {
    // 顺序与模型原始输出一致；有些 provider 对顺序敏感
    const out = toModelMessages([
      {
        role: 'assistant',
        content: '答案是 540',
        reasoning: '需要先算 45 乘 12',
        toolCalls: [{ id: 'c1', name: 'multiply', arguments: {} }],
      },
    ]);
    const content = (out[0] as { content: { type: string }[] }).content;
    expect(content.map((c) => c.type)).toEqual(['reasoning', 'text', 'tool-call']);
    expect(content[0]).toEqual({ type: 'reasoning', text: '需要先算 45 乘 12' });
  });

  it('没有 reasoning 时不产生 reasoning part', () => {
    const out = toModelMessages([{ role: 'assistant', content: '回答' }]);
    const content = (out[0] as { content: { type: string }[] }).content;
    expect(content.some((c) => c.type === 'reasoning')).toBe(false);
  });

  it('reasoning 为空字符串时不产生 part（避免上游收到空思维链）', () => {
    const out = toModelMessages([{ role: 'assistant', content: '回答', reasoning: '' }]);
    const content = (out[0] as { content: { type: string }[] }).content;
    expect(content.some((c) => c.type === 'reasoning')).toBe(false);
  });
});

describe('toModelMessages：工具结果', () => {
  it('成功结果包成 output:{type:json,value}', () => {
    const out = toModelMessages([
      {
        role: 'tool',
        results: [{ toolCallId: 'c1', toolName: 'multiply', output: { result: 6 } }],
      },
    ]);
    expect(out[0]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'multiply',
          output: { type: 'json', value: { result: 6 } },
        },
      ],
    });
  });

  it('失败结果用 error-text（把错误交给模型而不是抛异常）', () => {
    // 这是 Agent 能自我修复的关键：错误作为「观察结果」回给模型，
    // 它才能决定是换关键词重试还是换一条路
    const out = toModelMessages([
      {
        role: 'tool',
        results: [{ toolCallId: 'c1', toolName: 'search', error: '索引未就绪' }],
      },
    ]);
    const content = (out[0] as { content: Record<string, unknown>[] }).content;
    expect(content[0]?.output).toEqual({ type: 'error-text', value: '索引未就绪' });
  });

  it('output 为 undefined 且无 error 时序列化为 null（不产生非法 JSON）', () => {
    const out = toModelMessages([
      { role: 'tool', results: [{ toolCallId: 'c1', toolName: 'x' }] },
    ]);
    const content = (out[0] as { content: Record<string, unknown>[] }).content;
    expect(content[0]?.output).toEqual({ type: 'json', value: null });
  });

  it('一个 tool 消息可携带多个结果（并发调用）', () => {
    const out = toModelMessages([
      {
        role: 'tool',
        results: [
          { toolCallId: 'c1', toolName: 'a', output: 1 },
          { toolCallId: 'c2', toolName: 'b', output: 2 },
        ],
      },
    ]);
    const content = (out[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(2);
  });

  it('error 优先于 output（两者都给时按失败处理）', () => {
    const out = toModelMessages([
      {
        role: 'tool',
        results: [{ toolCallId: 'c1', toolName: 'x', output: { ok: true }, error: '失败了' }],
      },
    ]);
    const content = (out[0] as { content: { output: { type: string } }[] }).content;
    expect(content[0]?.output.type).toBe('error-text');
  });
});

describe('toModelMessages：完整多轮序列', () => {
  it('user → assistant(tool_call) → tool → assistant 顺序保持', () => {
    const msgs: LLMMessage[] = [
      { role: 'user', content: '算 7 乘 8' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'multiply', arguments: { a: 7, b: 8 } }],
      },
      { role: 'tool', results: [{ toolCallId: 'c1', toolName: 'multiply', output: { result: 56 } }] },
      { role: 'assistant', content: '56' },
    ];
    const out = toModelMessages(msgs);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('空数组返回空数组（不抛异常）', () => {
    expect(toModelMessages([])).toEqual([]);
  });
});

describe('toToolSet', () => {
  const tool: LLMTool = {
    name: 'search_doc',
    description: '检索文档',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  };

  it('按名字建立工具表', () => {
    const set = toToolSet([tool]);
    expect(Object.keys(set)).toEqual(['search_doc']);
  });

  it('工具**不带** execute（由 Agent 循环自己执行以保留可见性）', () => {
    // ⚠️ 这是刻意的设计：交给 SDK 自动执行就拿不到「每一步做了什么」，
    // 而轨迹落库与单工具额度都依赖那个可见性
    const set = toToolSet([tool]);
    expect(set.search_doc).toBeDefined();
    expect((set.search_doc as { execute?: unknown }).execute).toBeUndefined();
  });

  it('多个工具都注册', () => {
    const set = toToolSet([tool, { ...tool, name: 'other' }]);
    expect(Object.keys(set).sort()).toEqual(['other', 'search_doc']);
  });

  it('空工具数组返回空表', () => {
    expect(Object.keys(toToolSet([]))).toHaveLength(0);
  });
});

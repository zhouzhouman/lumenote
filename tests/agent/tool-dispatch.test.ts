import { describe, it, expect } from 'vitest';
import { runAgent, canonicalizeArgs, REPEAT_WARN_THRESHOLD, REPEAT_STOP_THRESHOLD } from '@/lib/agent/loop';
import { TOOL_NAMES, TOOL_QUOTAS } from '@/lib/agent/tools';
import { createToolDispatchState, dispatchToolCalls, resolveToolQuotas } from '@/lib/agent/tool-dispatch';
import { RepeatCallTracker } from '@/lib/agent/budget';
import type { ToolCall } from '@/lib/llm/types';
import { ScriptedProvider, makeChunks, CTX, FINAL_JSON, findToolMessages } from './helpers';

/**
 * 工具调度与参数规范化的表征测试。
 *
 * 锁定：调用顺序、额度记账、重复调用检测（warn/stop 两级）、未知工具拒绝、
 * 参数 canonicalize 的相等性语义，以及这些机制与预算/收敛的交互。
 */

async function runWith(
  provider: ScriptedProvider,
  overrides: Partial<Parameters<typeof runAgent>[0]> = {},
) {
  return runAgent({
    provider,
    model: 'm',
    question: 'q',
    chunks: makeChunks(['缓存命中率决定了成本', 'AB 内容']),
    toolContext: CTX,
    ...overrides,
  });
}

// ============================================================
// 参数规范化
// ============================================================
describe('canonicalizeArgs：重复检测的相等性语义', () => {
  it('键顺序不影响结果', () => {
    expect(canonicalizeArgs({ a: 1, b: 2 })).toBe(canonicalizeArgs({ b: 2, a: 1 }));
  });

  it('值不同则结果不同', () => {
    expect(canonicalizeArgs({ a: 1 })).not.toBe(canonicalizeArgs({ a: 2 }));
  });

  it('数字 1 与字符串 "1" 得到相同键（已知局限，行为需保持）', () => {
    expect(canonicalizeArgs({ a: 1 })).toBe(canonicalizeArgs({ a: '1' }));
  });

  it('对象值用 JSON 字符串表示', () => {
    expect(canonicalizeArgs({ filter: { kind: 'x' } })).toBe('filter={"kind":"x"}');
  });

  it('嵌套对象的键顺序**不**被规范化（已知局限，行为需保持）', () => {
    expect(canonicalizeArgs({ a: { x: 1, y: 2 } })).not.toBe(
      canonicalizeArgs({ a: { y: 2, x: 1 } }),
    );
  });

  it('空参数得到空串', () => {
    expect(canonicalizeArgs({})).toBe('');
  });
});

// ============================================================
// 额度记账
// ============================================================
describe('工具额度记账', () => {
  it('默认额度表固定', () => {
    expect(TOOL_QUOTAS).toEqual({
      search_chunks: 10,
      fetch_url: 3,
      get_glossary: 5,
      diff_with_task: 3,
      list_sections: 2,
    });
  });

  it('达到额度后拒绝执行，原因写进 toolResults 与 tool 消息', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.listSections, arguments: {} }] },
      { toolCalls: [{ id: 'c2', name: TOOL_NAMES.listSections, arguments: {} }] },
      { text: '{"conclusions":[]}' },
    ]);
    const result = await runWith(provider, {
      toolQuotas: { [TOOL_NAMES.listSections]: 1 } as never,
    });

    expect(result.stopReason).toBe('tool_quota');
    expect(result.steps[0]?.toolResults[0]?.ok).toBe(true);
    expect(result.steps[1]?.toolResults[0]).toMatchObject({
      toolCallId: 'c2',
      name: TOOL_NAMES.listSections,
      ok: false,
      display: 'list_sections 已达次数上限（1 次），请基于已有信息作答',
      error: 'list_sections 已达次数上限（1 次），请基于已有信息作答',
    });
    // 被拒原因作为观察结果回给模型
    const messages = findToolMessages(provider.requests[2]);
    expect(JSON.stringify(messages)).toContain('已达次数上限');
  });

  it('额度覆盖只影响指定工具，其它工具仍用默认额度（且反映到 prompt）', async () => {
    const provider = new ScriptedProvider([{ text: FINAL_JSON }]);
    await runWith(provider, { toolQuotas: { [TOOL_NAMES.listSections]: 1 } as never });

    const system = provider.requests[0]?.system ?? '';
    expect(system).toContain('- list_sections：最多 1 次');
    expect(system).toContain('- search_chunks：最多 10 次');
  });

  it('工具执行失败仍消耗额度（先记账后执行）', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.fetchUrl, arguments: { url: 'not-a-url' } }] },
      { toolCalls: [{ id: 'c2', name: TOOL_NAMES.fetchUrl, arguments: { url: 'also-bad' } }] },
      { text: '{"conclusions":[]}' },
    ]);
    const result = await runWith(provider, {
      toolQuotas: { [TOOL_NAMES.fetchUrl]: 1 } as never,
    });

    // 第一次失败（非法地址）但额度已被消耗；第二次被额度拦住
    expect(result.steps[0]?.toolResults[0]?.ok).toBe(false);
    expect(result.steps[1]?.toolResults[0]?.error).toContain('已达次数上限');
    expect(result.stopReason).toBe('tool_quota');
  });

  it('未知工具不给额度：拒绝并触发收敛（杜绝绕过）', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'delete_everything', arguments: {} }] },
      { text: '{"conclusions":[]}' },
    ]);
    const result = await runWith(provider);

    expect(result.steps[0]?.toolResults[0]).toMatchObject({
      name: 'delete_everything',
      ok: false,
      display: '未知工具 delete_everything',
      error: '未知工具 delete_everything',
    });
    expect(result.stopReason).toBe('tool_quota');
  });

  it('同一轮多个调用的额度按工具分别累计', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: 'c1', name: TOOL_NAMES.listSections, arguments: {} },
          { id: 'c2', name: TOOL_NAMES.listSections, arguments: {} },
        ],
      },
      { text: '{"conclusions":[]}' },
    ]);
    const result = await runWith(provider, {
      toolQuotas: { [TOOL_NAMES.listSections]: 1 } as never,
    });

    expect(result.steps[0]?.toolResults[0]?.ok).toBe(true);
    expect(result.steps[0]?.toolResults[1]?.ok).toBe(false);
    expect(result.stopReason).toBe('tool_quota');
  });
});

// ============================================================
// 重复调用检测
// ============================================================
describe('重复调用检测', () => {
  it('阈值：第 2 次警告、第 3 次硬停', () => {
    expect(REPEAT_WARN_THRESHOLD).toBe(2);
    expect(REPEAT_STOP_THRESHOLD).toBe(3);
  });

  it('第 2 次相同调用不拦截，但注入「换关键词」提示', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.searchChunks, arguments: { query: 'x' } }] },
      { toolCalls: [{ id: 'c2', name: TOOL_NAMES.searchChunks, arguments: { query: 'x' } }] },
      { text: FINAL_JSON },
    ]);
    const result = await runWith(provider, {
      toolQuotas: { [TOOL_NAMES.searchChunks]: 99 } as never,
    });

    // 两次都正常执行
    expect(result.steps[0]?.toolResults[0]?.ok).toBe(true);
    expect(result.steps[1]?.toolResults[0]?.ok).toBe(true);
    // 第二次的 tool 消息带 hint（不拦截，只提醒）
    const toolMessages = findToolMessages(provider.requests[2]);
    expect(JSON.stringify(toolMessages)).toContain('注意：你已经用相同参数查过');
    expect(result.stopReason).toBe('model_finalized');
  });

  it('第 3 次相同调用硬停：错误回给模型，并强制收敛', async () => {
    const sameCall = { name: TOOL_NAMES.searchChunks, arguments: { query: 'x' } };
    const provider = new ScriptedProvider([
      { toolCalls: [{ ...sameCall, id: 'c1' }] },
      { toolCalls: [{ ...sameCall, id: 'c2' }] },
      { toolCalls: [{ ...sameCall, id: 'c3' }] },
      { text: '{"conclusions":[]}' },
    ]);
    const result = await runWith(provider, {
      budget: { maxSteps: 8 },
      toolQuotas: { [TOOL_NAMES.searchChunks]: 99 } as never,
    });

    expect(result.stopReason).toBe('repeat_loop');
    expect(result.steps[2]?.toolResults[0]).toMatchObject({
      toolCallId: 'c3',
      ok: false,
      error:
        '你已经用完全相同的参数调用过 search_chunks 2 次了。请改用其它方式，或基于已有证据给出结论。',
    });
    // 第三次没有真正执行（步数 = 3 次 act，而不是 4 次）
    expect(result.steps.filter((s) => s.phase === 'act')).toHaveLength(3);
  });

  it('键顺序不同仍算相同调用（依赖 canonicalizeArgs）', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.searchChunks, arguments: { query: 'x', topK: 3 } }] },
      { toolCalls: [{ id: 'c2', name: TOOL_NAMES.searchChunks, arguments: { topK: 3, query: 'x' } }] },
      { toolCalls: [{ id: 'c3', name: TOOL_NAMES.searchChunks, arguments: { query: 'x', topK: 3 } }] },
      { text: '{"conclusions":[]}' },
    ]);
    const result = await runWith(provider, {
      budget: { maxSteps: 8 },
      toolQuotas: { [TOOL_NAMES.searchChunks]: 99 } as never,
    });

    expect(result.stopReason).toBe('repeat_loop');
  });

  it('不同参数的正常多次检索不会被误判', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.searchChunks, arguments: { query: '缓存' } }] },
      { toolCalls: [{ id: 'c2', name: TOOL_NAMES.searchChunks, arguments: { query: '命中率' } }] },
      { toolCalls: [{ id: 'c3', name: TOOL_NAMES.searchChunks, arguments: { query: '成本' } }] },
      { text: FINAL_JSON },
    ]);
    const result = await runWith(provider, { budget: { maxSteps: 8 } });

    expect(result.stopReason).toBe('model_finalized');
    expect(result.steps).toHaveLength(4);
  });
});

// ============================================================
// 直接测试调度模块 API（拆分后新增）
// ============================================================
describe('dispatchToolCalls：模块级行为', () => {
  function freshState() {
    return createToolDispatchState(new RepeatCallTracker());
  }

  function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
    return { id, name, arguments: args };
  }

  const DOC = makeChunks(['# 标题\n内容']);

  it('成功执行：返回 toolResults 与 tool 消息；无新分块时 chunks 原样返回', async () => {
    const outcome = await dispatchToolCalls({
      calls: [call('c1', TOOL_NAMES.listSections)],
      quotas: resolveToolQuotas(),
      context: CTX,
      chunks: DOC,
      state: freshState(),
    });

    expect(outcome.chunks).toBe(DOC);
    expect(outcome.hitQuota).toBe(false);
    expect(outcome.hitRepeatStop).toBe(false);
    expect(outcome.toolResults).toEqual([
      {
        toolCallId: 'c1',
        name: TOOL_NAMES.listSections,
        ok: true,
        display: '列出文档结构：1 个带标题的章节',
        error: undefined,
      },
    ]);
    expect(outcome.toolMessages[0]).toMatchObject({
      toolCallId: 'c1',
      toolName: TOOL_NAMES.listSections,
      output: { ok: true },
    });
  });

  it('额度记账跨多次 dispatch 累计（state 复用）', async () => {
    const state = freshState();
    const quotas = resolveToolQuotas({ [TOOL_NAMES.listSections]: 1 });
    const base = { quotas, context: CTX, chunks: DOC, state };

    const first = await dispatchToolCalls({ ...base, calls: [call('c1', TOOL_NAMES.listSections)] });
    const second = await dispatchToolCalls({ ...base, calls: [call('c2', TOOL_NAMES.listSections)] });

    expect(first.hitQuota).toBe(false);
    expect(second.hitQuota).toBe(true);
    expect(second.toolResults[0]?.display).toBe(
      'list_sections 已达次数上限（1 次），请基于已有信息作答',
    );
    expect(state.perTool.get(TOOL_NAMES.listSections)).toBe(1);
  });

  it('未知工具：不消耗额度、不进入重复计数，每次都是「未知工具」', async () => {
    const state = freshState();
    const base = { quotas: resolveToolQuotas(), context: CTX, chunks: DOC, state };

    const outcome = await dispatchToolCalls({
      ...base,
      calls: [call('c1', 'delete_everything'), call('c2', 'delete_everything')],
    });

    expect(outcome.hitQuota).toBe(true);
    expect(outcome.toolResults.map((r) => r.error)).toEqual([
      '未知工具 delete_everything',
      '未知工具 delete_everything',
    ]);
    expect(state.perTool.size).toBe(0);
  });

  it('重复检测跨 dispatch：warn 注入 hint，第 3 次 hitRepeatStop 且不执行', async () => {
    const state = freshState();
    const quotas = resolveToolQuotas({ [TOOL_NAMES.searchChunks]: 99 });
    const args = { query: 'x' };
    const base = { quotas, context: CTX, chunks: makeChunks(['x 内容']), state };

    const d1 = await dispatchToolCalls({ ...base, calls: [call('c1', TOOL_NAMES.searchChunks, args)] });
    const d2 = await dispatchToolCalls({ ...base, calls: [call('c2', TOOL_NAMES.searchChunks, args)] });
    const d3 = await dispatchToolCalls({ ...base, calls: [call('c3', TOOL_NAMES.searchChunks, args)] });

    expect(d1.hitRepeatStop).toBe(false);
    expect(JSON.stringify(d1.toolMessages)).not.toContain('注意：你已经用相同参数查过');

    expect(d2.hitRepeatStop).toBe(false);
    expect(JSON.stringify(d2.toolMessages)).toContain('注意：你已经用相同参数查过');

    expect(d3.hitRepeatStop).toBe(true);
    expect(d3.toolResults[0]?.error).toContain('你已经用完全相同的参数调用过 search_chunks 2 次');
    expect(state.perTool.get(TOOL_NAMES.searchChunks)).toBe(2);
  });

  it('键顺序不同视为重复（canonicalizeArgs 在调度层生效）', async () => {
    const state = freshState();
    const base = {
      quotas: resolveToolQuotas({ [TOOL_NAMES.searchChunks]: 99 }),
      context: CTX,
      chunks: makeChunks(['x']),
      state,
    };

    const d1 = await dispatchToolCalls({
      ...base,
      calls: [call('c1', TOOL_NAMES.searchChunks, { query: 'x', topK: 3 })],
    });
    const d2 = await dispatchToolCalls({
      ...base,
      calls: [call('c2', TOOL_NAMES.searchChunks, { topK: 3, query: 'x' })],
    });

    expect(d1.hitRepeatStop).toBe(false);
    expect(JSON.stringify(d2.toolMessages)).toContain('注意：你已经用相同参数查过');
  });

  it('同一批多个工具按给定顺序执行', async () => {
    const outcome = await dispatchToolCalls({
      calls: [
        call('c1', TOOL_NAMES.listSections),
        call('c2', TOOL_NAMES.searchChunks, { query: '标题' }),
      ],
      quotas: resolveToolQuotas(),
      context: CTX,
      chunks: DOC,
      state: freshState(),
    });

    expect(outcome.toolResults.map((r) => r.name)).toEqual([
      TOOL_NAMES.listSections,
      TOOL_NAMES.searchChunks,
    ]);
  });
});

describe('resolveToolQuotas：覆盖语义', () => {
  it('覆盖指定工具，其余保持默认；不修改默认表', () => {
    const resolved = resolveToolQuotas({ [TOOL_NAMES.listSections]: 1 });

    expect(resolved[TOOL_NAMES.listSections]).toBe(1);
    expect(resolved[TOOL_NAMES.searchChunks]).toBe(10);
    expect(resolved[TOOL_NAMES.fetchUrl]).toBe(3);
    // 默认表是模块级常量，不能被调用方覆盖污染
    expect(TOOL_QUOTAS[TOOL_NAMES.listSections]).toBe(2);
  });

  it('不传覆盖时与默认表等价（新对象）', () => {
    const resolved = resolveToolQuotas();
    expect(resolved).toEqual(TOOL_QUOTAS);
    expect(resolved).not.toBe(TOOL_QUOTAS);
  });
});
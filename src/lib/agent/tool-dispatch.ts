import type { LLMMessage, ToolCall } from '@/lib/llm/types';
import type { TextChunk } from '@/lib/pipeline/chunk';
import {
  appendChunks,
  executeTool,
  TOOL_QUOTAS,
  type AgentToolContext,
  type ToolName,
} from './tools';
import { repeatStopMessage, repeatWarning, type RepeatCallTracker } from './budget';
import type { AgentStepRecord } from './types';

/**
 * 模块职责：**工具调度**（一轮 act 的全部决策与执行）。
 *
 * 负责四件事，按发生顺序：
 *  1. 额度检查（硬限，未知工具一律拒绝 —— 杜绝绕过白名单）；
 *  2. 重复调用检测（第 2 次警告、第 3 次硬停，判定逻辑在 budget.ts）；
 *  3. 额度记账（先记账再执行：失败的工具调用同样消耗额度）；
 *  4. 执行工具并把新抓取的分块并入文档（重编号，见 appendChunks）。
 *
 * ## 为什么从循环里抽出来
 *
 * 「一次工具调用怎么做」与「状态机走到哪一步」是两个变化原因：
 * 前者随工具集/额度策略变，后者随预算/收敛策略变。
 * 混在一个函数里时，改额度逻辑要读 300 行状态机代码才能确认没有副作用。
 *
 * 这里对模型/数据库零依赖：模型调用由 orchestrator 负责，
 * 工具内部的 IO 经 `AgentToolContext` 注入，因此调度逻辑可被单测直接覆盖。
 */

/** 规范化工具参数，用于重复调用检测（键排序，避免 {a,b} 与 {b,a} 被当成两次） */
export function canonicalizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  const parts = keys.map((k) => {
    const v = args[k];
    // 只取值的字符串形式；参数都很短，不需要更复杂的哈希
    return `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`;
  });
  return parts.join('&');
}

/**
 * 合并默认额度与调用方覆盖值。
 *
 * 返回 `Record<string, number>` 而不是 `Record<ToolName, number>`：
 * 模型可能给出任意工具名，查表时需要「查不到 = 无额度」这一语义。
 */
export function resolveToolQuotas(
  overrides?: Partial<Record<ToolName, number>>,
): Record<string, number> {
  return { ...TOOL_QUOTAS, ...(overrides ?? {}) };
}

/** 回传给模型的单条工具结果（LLMMessage 中 tool 消息的元素） */
export type ToolResultMessage = Extract<LLMMessage, { role: 'tool' }>['results'][number];

/** 跨轮持续的工具调度状态 */
export interface ToolDispatchState {
  /** 每个工具已调度次数（额度记账，轮间累计） */
  perTool: Map<string, number>;
  /** 重复调用计数（轮间累计） */
  repeats: RepeatCallTracker;
}

export function createToolDispatchState(repeats: RepeatCallTracker): ToolDispatchState {
  return { perTool: new Map(), repeats };
}

export interface ToolDispatchOutcome {
  /** 并入新抓取分块后的最新文档（fetch_url 之后会变长） */
  chunks: TextChunk[];
  toolResults: AgentStepRecord['toolResults'];
  toolMessages: ToolResultMessage[];
  /** 是否因单工具额度用尽而需要收敛 */
  hitQuota: boolean;
  /** 是否触发了重复调用硬停 */
  hitRepeatStop: boolean;
}

export interface DispatchToolCallsArgs {
  calls: ToolCall[];
  /** 已合并默认值的额度表 */
  quotas: Record<string, number>;
  context: AgentToolContext;
  /** 当前文档分块；返回的是并入新分块后的最新值 */
  chunks: TextChunk[];
  state: ToolDispatchState;
}

/**
 * 执行一轮 act 的全部工具调用（按模型给出的顺序串行）。
 *
 * ⚠️ 工具执行永不抛异常（见 tools.ts），因此这里不需要 try/catch：
 * 失败会作为观察结果回给模型，让模型自己决定重试还是换路。
 */
export async function dispatchToolCalls(args: DispatchToolCallsArgs): Promise<ToolDispatchOutcome> {
  const { calls, quotas, context, state } = args;
  let chunks = args.chunks;

  const toolResults: AgentStepRecord['toolResults'] = [];
  const toolMessages: ToolResultMessage[] = [];

  let hitQuota = false;
  let hitRepeatStop = false;

  for (const call of calls) {
    const name = call.name as ToolName;
    const used = state.perTool.get(name) ?? 0;
    const quota = quotas[name];

    // 额度检查（硬限）。未知工具名也给 0 额度，杜绝绕过
    if (quota === undefined || used >= quota) {
      const reason =
        quota === undefined
          ? `未知工具 ${name}`
          : `${name} 已达次数上限（${quota} 次），请基于已有信息作答`;
      toolResults.push({ toolCallId: call.id, name, ok: false, display: reason, error: reason });
      toolMessages.push({ toolCallId: call.id, toolName: name, error: reason });
      hitQuota = true;
      continue;
    }

    // 重复调用检测（第 2 次警告 / 第 3 次硬停，阈值在 budget.ts）
    const repeat = state.repeats.record(`${name}|${canonicalizeArgs(call.arguments)}`);
    if (repeat.verdict === 'stop') {
      const reason = repeatStopMessage(name, repeat.count);
      toolResults.push({ toolCallId: call.id, name, ok: false, display: reason, error: reason });
      toolMessages.push({ toolCallId: call.id, toolName: name, error: reason });
      hitRepeatStop = true;
      continue;
    }

    // 先记账再执行：失败的工具调用同样消耗额度（模型不能靠失败来无限重试）
    state.perTool.set(name, used + 1);

    const exec = await executeTool(name, call.arguments, context, chunks);

    // 抓取到的正文并入文档（重编号以避免 chunk index 冲突）
    if (exec.newChunks && exec.newChunks.length > 0) {
      chunks = appendChunks(chunks, exec.newChunks);
    }

    toolResults.push({
      toolCallId: call.id,
      name,
      ok: exec.result.ok,
      display: exec.display,
      error: exec.result.ok ? undefined : exec.result.error,
    });

    // 第 2 次重复：不拦截，但注入提示让模型自己收敛
    const baseOutput = exec.result.ok
      ? { ok: true as const, data: exec.result.data }
      : exec.result;
    const output = repeat.verdict === 'warn' ? { ...baseOutput, hint: repeatWarning(name) } : baseOutput;

    toolMessages.push({
      toolCallId: call.id,
      toolName: name,
      ...(exec.result.ok ? { output } : { error: exec.result.error }),
    });
  }

  return { chunks, toolResults, toolMessages, hitQuota, hitRepeatStop };
}

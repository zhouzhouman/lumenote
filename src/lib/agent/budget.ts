import type { LLMUsage } from '@/lib/llm/types';
import type { TextChunk } from '@/lib/pipeline/chunk';
import { estimateTokens } from '@/lib/llm/mock';
import type { AgentBudgetOptions, AgentStopReason } from './types';

/**
 * 模块职责：**预算与停止策略**（纯逻辑，不碰模型/IO）。
 *
 * 这里回答三个问题：
 *  1. 还能不能继续跑（步数 / token 双预算）；
 *  2. 同一次（工具名 + 规范化参数）重复到第几次该警告 / 该硬停；
 *  3. 被迫收敛时，给模型的提示文案是什么。
 *
 * ## 为什么预算不从循环里内联
 *
 * 预算判定是状态机里最容易出错、也最值得单测的部分：差一个 `>=`、
 * 差一次累加，就会变成「预算形同虚设」或「正常任务被误杀」。
 * 抽成独立类之后，边界可以用纯函数式测试精确覆盖，不必伪造整个 provider。
 *
 * ## 关键语义（与拆分前完全一致）
 *
 *  - 步数只统计 **plan 阶段的模型调用**；收敛调用是「抢救」，不计步数。
 *  - token 统计所有模型调用（含缓存命中的输入 token，它们仍占上下文位置）。
 *  - 预算检查在每轮循环顶部；因此「这一轮刚好把预算用完」仍会完整执行。
 */

/** 默认预算。双预算是「步数」与「token」两个维度 */
export const DEFAULT_AGENT_BUDGET = {
  /** 最多几轮「模型思考 + 工具执行」 */
  maxSteps: 12,
  /** 累计 token 上限（输入 + 输出），超过立即收敛 */
  maxTokens: 60_000,
} as const;

/**
 * 重复调用检测的阈值。
 *
 * 相同 (工具名, 规范化参数) 出现第 2 次时不拦截，而是**注入提示**
 * 告诉模型「你已经查过这个了」。第 3 次才硬停 —— 因为合法的
 * 重复检索是存在的（比如换了关键词后想再确认一次），
 * 一上来就硬停会误伤正常行为。
 */
export const REPEAT_WARN_THRESHOLD = 2;
export const REPEAT_STOP_THRESHOLD = 3;

/** 预算到顶的两种原因 */
export type BudgetExhaustedReason = 'max_steps' | 'max_tokens';

/** 需要「用一次不带工具的调用换取阶段性结论」的终止原因 */
export type ConvergeReason = BudgetExhaustedReason | 'repeat_loop' | 'tool_quota';

const CONVERGE_REASON_SET: ReadonlySet<string> = new Set<ConvergeReason>([
  'max_steps',
  'max_tokens',
  'repeat_loop',
  'tool_quota',
]);

/**
 * 收敛提示按原因定制。
 *
 * 不用一句通用文案：模型知道**为什么**被中断，才能给出恰当的局限性说明
 * （「因为步数用尽」和「因为你刚才在重复检索」对用户的意义不同）。
 */
export const CONVERGE_REASON_TEXT: Record<ConvergeReason, string> = {
  max_steps: '已达到工具调用步数上限',
  max_tokens: '已达到本次任务的 token 预算上限',
  repeat_loop: '检测到你在用相同的参数重复检索，已停止继续检索',
  tool_quota: '可用工具的调用次数已用尽',
};

export function isConvergeReason(reason: AgentStopReason): reason is ConvergeReason {
  return CONVERGE_REASON_SET.has(reason);
}

export interface AgentBudgetLimits {
  maxSteps: number;
  maxTokens: number;
}

/** 合并默认预算与调用方覆盖值 */
export function resolveBudgetLimits(budget?: AgentBudgetOptions): AgentBudgetLimits {
  return {
    maxSteps: budget?.maxSteps ?? DEFAULT_AGENT_BUDGET.maxSteps,
    maxTokens: budget?.maxTokens ?? DEFAULT_AGENT_BUDGET.maxTokens,
  };
}

/**
 * 预算跟踪器。
 *
 * 直接把 `steps` / `tokens` 暴露为只读字段，是因为轨迹记录需要
 * 把「本步结束时的累计 token」写进 AgentStepRecord。
 */
export class AgentBudgetTracker {
  steps = 0;
  tokens = 0;

  constructor(readonly limits: AgentBudgetLimits) {}

  /**
   * 每轮循环顶部调用。
   *
   * 返回非 null 表示预算到顶 —— 调用方应停止 plan 并转入收敛流程。
   * 注意顺序：步数优先于 token（与拆分前一致，stopReason 因此确定）。
   */
  exhaustedReason(): BudgetExhaustedReason | null {
    if (this.steps >= this.limits.maxSteps) return 'max_steps';
    if (this.tokens >= this.limits.maxTokens) return 'max_tokens';
    return null;
  }

  /** plan 阶段的模型调用：步数 +1，并累计 token */
  recordPlanCall(usage: LLMUsage): void {
    this.steps += 1;
    this.recordUsage(usage);
  }

  /**
   * 只累计 token（用于收敛调用）。
   *
   * 收敛是「抢救已有成果」而不是新的一轮 plan，所以不占步数预算 ——
   * 否则预算到顶时反而没有预算做收敛，等于永远拿不到部分结果。
   */
  recordUsage(usage: LLMUsage): void {
    // 输入 token 要算上缓存命中的部分（它们计费更低但仍占上下文位置）
    this.tokens += usage.inputTokens + usage.outputTokens;
  }
}

export type RepeatVerdict = 'allow' | 'warn' | 'stop';

export interface RepeatRecord {
  /** 这是第几次出现（含本次） */
  count: number;
  verdict: RepeatVerdict;
}

/**
 * 重复调用计数器。
 *
 * key 由调用方用 `工具名|canonicalizeArgs(参数)` 生成 ——
 * 参数规范化属于工具调度模块（见 tool-dispatch.ts），
 * 这里只负责「数次数 + 给判定」，保持单一职责。
 */
export class RepeatCallTracker {
  private readonly counts = new Map<string, number>();

  record(callKey: string): RepeatRecord {
    const count = (this.counts.get(callKey) ?? 0) + 1;
    this.counts.set(callKey, count);

    const verdict: RepeatVerdict =
      count >= REPEAT_STOP_THRESHOLD ? 'stop' : count >= REPEAT_WARN_THRESHOLD ? 'warn' : 'allow';

    return { count, verdict };
  }
}

/** 第 2 次重复时注入给模型的提示（不拦截） */
export function repeatWarning(toolName: string): string {
  return `注意：你已经用相同参数查过 ${toolName} 了，如果结果不理想请换关键词或换工具。`;
}

/** 第 3 次重复时的硬停原因（回给模型，并触发强制收敛） */
export function repeatStopMessage(toolName: string, count: number): string {
  return `你已经用完全相同的参数调用过 ${toolName} ${count - 1} 次了。请改用其它方式，或基于已有证据给出结论。`;
}

/** 估算最终文档的 token 数（用于展示与预算规划） */
export function documentTokens(chunks: TextChunk[]): number {
  return chunks.reduce((sum, c) => sum + (c.tokens || estimateTokens(c.content)), 0);
}

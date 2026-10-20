import type { AgentRunResult, AgentStepRecord } from './types';
import { DEFAULT_AGENT_BUDGET, REPEAT_STOP_THRESHOLD } from './budget';
import { canonicalizeArgs } from './tool-dispatch';

/**
 * 模块职责：**轨迹记录与轨迹断言**。
 *
 * 两部分：
 *  1. `StepRecorder` —— 负责给每一步编号（seq 连续）、累计、触发回调（SSE）；
 *  2. `checkTrajectory` —— 对已经发生的轨迹做确定性断言（死循环、超预算、无证据结论）。
 *
 * ## 为什么单独成模块
 *
 * 轨迹是本项目的「可追溯」卖点：seq 一旦不连续、累计 token 一旦回退，
 * 回放与评测就不可信。这些不变量值得独立于状态机的具体分支被测试。
 * 而 checkTrajectory 是评测框架的输入，是「护栏是否生效」的回归信号 ——
 * 它只读轨迹，不改状态，属于典型的独立关注点。
 *
 * ## 记录顺序约束
 *
 * 先 push 再回调：调用方（SSE）看到某一步时，它一定已经在 `steps` 里，
 * 也一定已经带上了本步完整的工具结果。这个顺序不能反。
 */

/** 一次记录所需的数据（seq 由 recorder 分配） */
export type StepRecordInput = Omit<AgentStepRecord, 'seq'>;

export class StepRecorder {
  private readonly steps: AgentStepRecord[] = [];
  private seq = 1;

  constructor(private readonly onStep?: (step: AgentStepRecord) => void) {}

  record(input: StepRecordInput): AgentStepRecord {
    const step: AgentStepRecord = { seq: this.seq, ...input };
    this.seq += 1;
    this.steps.push(step);
    this.onStep?.(step);
    return step;
  }

  /** 已记录的轨迹（按 seq 升序） */
  get all(): readonly AgentStepRecord[] {
    return this.steps;
  }
}

export interface TrajectoryCheck {
  /** 是否出现死循环（相同工具+参数 ≥ REPEAT_STOP_THRESHOLD 次） */
  hasLoop: boolean;
  /** 实际用到的工具名集合 */
  usedTools: string[];
  /** 是否超步数 */
  overSteps: boolean;
  /** 是否超 token */
  overTokens: boolean;
  /** 是否出现「有结论但完全没有证据」 */
  unsupportedConclusions: number;
  /** 总步数 */
  totalSteps: number;
}

export function checkTrajectory(
  result: AgentRunResult,
  budget?: { maxSteps?: number; maxTokens?: number },
): TrajectoryCheck {
  const maxSteps = budget?.maxSteps ?? DEFAULT_AGENT_BUDGET.maxSteps;
  const maxTokens = budget?.maxTokens ?? DEFAULT_AGENT_BUDGET.maxTokens;

  const counts = new Map<string, number>();
  const usedTools = new Set<string>();

  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      usedTools.add(call.name);
      const key = `${call.name}|${canonicalizeArgs(call.arguments)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const hasLoop = [...counts.values()].some((v) => v >= REPEAT_STOP_THRESHOLD);
  const unsupportedConclusions = (result.structured?.conclusions ?? []).filter(
    (c) => c.evidence.length === 0,
  ).length;

  return {
    hasLoop,
    usedTools: [...usedTools].sort(),
    overSteps: result.steps.length > maxSteps,
    overTokens: result.usage.inputTokens + result.usage.outputTokens > maxTokens,
    unsupportedConclusions,
    totalSteps: result.steps.length,
  };
}

/**
 * 批次预算闸门。
 *
 * 「成本可控」如果只做成「跑完告诉你花了多少」，那叫记账，不叫控制。
 * 真正的控制在**发请求之前**：这一条跑下去会不会超预算，超了就不发。
 *
 * 抽成纯函数是为了能单测 —— 预算判断错一次的代价是「用户的钱被多花」，
 * 这种逻辑不该只靠人工点几下验证。
 */

export interface BudgetGateInput {
  /** 已发生成本（人民币） */
  spentCny: number;
  /** 预算上限（人民币）。null / 0 / 负数 = 不限制 */
  budgetCny: number | null;
  /** 下一条的预估成本（人民币） */
  nextEstimateCny: number;
}

export interface BudgetDecision {
  /** continue = 可以跑下一条；stop = 剩下的条目不要再发请求 */
  action: 'continue' | 'stop';
  /** stop 时给用户看的原因（会写进被跳过任务的 errorMessage） */
  reason?: string;
}

export function decideBudget(input: BudgetGateInput): BudgetDecision {
  const { spentCny, budgetCny, nextEstimateCny } = input;

  /*
   * ⚠️ 预算是**软上限**，不是硬保证。
   *
   * 闸门用的是「预估成本」，而真实成本只有跑完才知道。实测（Mock 链路）：
   * 预算 ¥0.0025，跑完第 2 条后实际已花 ¥0.0029 —— 因为第 2 条的预估
   * 略低于真实值。此时第 3 条会被拦下，所以最坏情况是「超出最后一条的偏差」，
   * 不会级联超支。
   *
   * 要变成硬上限，唯一办法是「每条跑完再校验 + 预留 20% 余量」，
   * 但那样会把可用预算越压越少。这里选择诚实标注，而不是假装精确。
   */

  // 未设预算 = 明确不限制。不要偷偷塞一个默认上限，
  // 那会让「用户以为不限、实际被停」变成最难排查的一类问题。
  if (budgetCny === null || !Number.isFinite(budgetCny) || budgetCny <= 0) {
    return { action: 'continue' };
  }

  if (spentCny >= budgetCny) {
    return {
      action: 'stop',
      reason: `预算已用尽（已花 ¥${round2(spentCny)} / 上限 ¥${round2(budgetCny)}）`,
    };
  }

  const remaining = budgetCny - spentCny;
  if (nextEstimateCny > remaining) {
    return {
      action: 'stop',
      reason:
        `下一条预计 ¥${round2(nextEstimateCny)}，超出剩余预算 ¥${round2(remaining)}；` +
        '为避免超支，剩余条目不再提交模型',
    };
  }

  return { action: 'continue' };
}

function round2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * 单条任务的成本预估（人民币）。
 *
 * 为什么在批次里还要单独算一次：预算是「跑之前」的判断，
 * 而 UsageLog 里的是「跑之后」的真实值。两者都要有，
 * 否则只能在事后发现超支。
 *
 * 估计刻意**偏保守**（输出按用户要的要点数上限估），
 * 宁可少跑一条，也不要多花一笔。
 */
export function estimateItemCostCny(args: {
  promptTokens: number;
  expectedOutputTokens: number;
  costUsd: (input: { promptTokens: number; completionTokens: number }) => number;
  usdToCny: (usd: number) => number;
}): number {
  const usd = args.costUsd({
    promptTokens: Math.max(0, args.promptTokens),
    completionTokens: Math.max(0, args.expectedOutputTokens),
  });
  return args.usdToCny(usd);
}

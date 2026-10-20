import { prisma } from '@/lib/db';
import { computeCostUsd, cacheHitRate, usdToCny } from './pricing';
import type { LLMUsage } from './types';

/**
 * Token 计量与成本落库。
 *
 * 三条原则，都是从踩过的坑反推出来的：
 *
 * 1. **绝不信任客户端上报的 token 数。**
 *    客户端可以随便填 0。所以 token 统计只能在服务端做，
 *    一律以 Provider 返回的 usage 为准。
 *
 * 2. **即使调用失败也要落库。**
 *    上游超时/中断时，Provider 可能已经消耗了 token（尤其是输出已生成一部分时）。
 *    只记成功会让成本统计系统性偏低，导致「账单比仪表盘高」而查不出原因。
 *    所以 partial token 也要如实记录 —— 成本要诚实。
 *
 * 3. **一任务只结算一次。**
 *    靠 UsageLog.taskId 的唯一约束保证。这条约束是幂等的最终防线：
 *    即使重试逻辑、异常捕获、并发重复调用全都出 bug，
 *    数据库也不会产生第二条计费记录。
 */

export interface RecordUsageInput {
  userId: string;
  taskId?: string | null;
  provider: string;
  model: string;
  usage: LLMUsage;
  success: boolean;
  latencyMs?: number;
  ttftMs?: number;
  errorCode?: string;
  /** 重试与降级轨迹，排查「为什么这次变贵」用 */
  meta?: Record<string, unknown>;
}

export interface RecordUsageResult {
  costCny: number;
  cacheHitRate: number;
  peak: boolean;
  /** 是否因为重复提交被跳过（幂等命中） */
  skipped: boolean;
}

export async function recordUsage(input: RecordUsageInput): Promise<RecordUsageResult> {
  const { costUsd, peak } = computeCostUsd({
    model: input.model,
    promptTokens: input.usage.inputTokens,
    cachedTokens: input.usage.cachedTokens,
    completionTokens: input.usage.outputTokens,
  });

  /**
   * ⚠️ 落库的是**美元**，人民币换算只发生在展示边界。
   *
   * 之前这里有三个独立的 `* 7.2` 字面量（这里、任务详情路由、用量汇总），
   * 各自算各的。只要有一处漏改，详情页与仪表盘就会差 7.2 倍，
   * 而且因为两边都「看起来对」，排查起来极难。
   * 现在统一走 pricing.usdToCny()，汇率只有一个定义处。
   *
   * 注意 UsageLog.estimatedCost 的列注释一度写作「人民币元」，
   * 与代码相反 —— 这种注释与实现矛盾的地方比没注释更危险，已在 schema 中改正。
   */
  const costCny = usdToCny(costUsd);
  const hitRate = cacheHitRate(input.usage.inputTokens, input.usage.cachedTokens);

  try {
    await prisma.usageLog.create({
      data: {
        userId: input.userId,
        taskId: input.taskId ?? null,
        provider: input.provider,
        model: input.model,
        promptTokens: input.usage.inputTokens,
        completionTokens: input.usage.outputTokens,
        cachedTokens: input.usage.cachedTokens,
        estimatedCost: costUsd,
        peakPricing: peak,
        latencyMs: input.latencyMs ?? null,
        ttftMs: input.ttftMs ?? null,
        success: input.success,
        errorCode: input.errorCode ?? null,
        meta: (input.meta ?? null) as never,
      },
    });
  } catch (e) {
    // P2002 = 唯一约束冲突 = 该任务已结算过（幂等命中）
    if (isUniqueViolation(e)) {
      return { costCny: 0, cacheHitRate: hitRate, peak, skipped: true };
    }
    // 计量失败不能影响主流程 —— 用户要的是摘要，不是账单
    console.error('[metering] 记录用量失败（不影响主流程）：', e);
  }

  return { costCny, cacheHitRate: hitRate, peak, skipped: false };
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: string }).code === 'P2002'
  );
}

export interface UsageSummary {
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  cacheHitRate: number;
  totalCostCny: number;
  avgLatencyMs: number;
  /** 首 token 延迟 P95 —— AI 应用最关键的性能指标 */
  p95TtftMs: number;
  byModel: { model: string; requests: number; inputTokens: number; outputTokens: number; costCny: number }[];
}

/** 汇总某个用户的用量。仪表盘的数据来源 */
export async function summarizeUsage(userId: string, sinceDays = 30): Promise<UsageSummary> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);

  const [agg, byModel, ttftRows] = await Promise.all([
    prisma.usageLog.aggregate({
      where: { userId, createdAt: { gte: since } },
      _count: { _all: true, latencyMs: true },
      _sum: {
        promptTokens: true,
        completionTokens: true,
        cachedTokens: true,
        estimatedCost: true,
        latencyMs: true,
      },
    }),
    prisma.usageLog.groupBy({
      by: ['model'],
      where: { userId, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { promptTokens: true, completionTokens: true, estimatedCost: true },
    }),
    prisma.usageLog.findMany({
      where: { userId, createdAt: { gte: since }, ttftMs: { not: null } },
      select: { ttftMs: true },
      orderBy: { ttftMs: 'desc' },
      take: 100,
    }),
  ]);

  const totalInput = agg._sum.promptTokens ?? 0;
  const totalCached = agg._sum.cachedTokens ?? 0;
  const failed = await prisma.usageLog.count({
    where: { userId, createdAt: { gte: since }, success: false },
  });
  const total = agg._count._all;

  /**
   * TTFT P95（最近 100 次最慢样本中的 95 分位）。
   *
   * ⚠️ 索引方向很容易写反：这里已经按 ttftMs **降序** 取了 100 条（最慢的100条），
   * 再升序排序后，P95 应该落在数组**靠后**的位置。
   * 曾经写成 `ttftValues[floor(len * 0.05)]` —— 那取到的是第 5 百分位，
   * 也就是「最慢的 100 次里最快的那几次」，指标系统性偏乐观，
   * 首字延迟劣化在仪表盘上完全看不出来（这正是这个指标存在的唯一意义）。
   */
  const ttftValues = ttftRows.map((r) => r.ttftMs!).sort((a, b) => a - b);
  const p95TtftMs =
    ttftValues.length === 0
      ? 0
      : ttftValues.length < 20
        ? ttftValues[ttftValues.length - 1]
        : ttftValues[Math.min(ttftValues.length - 1, Math.ceil(ttftValues.length * 0.95) - 1)]!;

  return {
    totalRequests: total,
    successRequests: total - failed,
    failedRequests: failed,
    totalInputTokens: totalInput,
    totalOutputTokens: agg._sum.completionTokens ?? 0,
    totalCachedTokens: totalCached,
    cacheHitRate: cacheHitRate(totalInput, totalCached),
    totalCostCny: usdToCny(agg._sum.estimatedCost ?? 0),
    // ⚠️ 分母必须是「有 latencyMs 的记录数」，而不是全部记录数。
    // Map 阶段的计量（见 runner.ts，taskId 为 null）不写 latencyMs，
    // 用总数做分母会把平均值稀释，一次长文 Map-Reduce 会让平均耗时看起来骤降。
    avgLatencyMs:
      (agg._count.latencyMs ?? 0) > 0
        ? Math.round((agg._sum.latencyMs ?? 0) / agg._count.latencyMs!)
        : 0,
    p95TtftMs,
    byModel: byModel.map((m) => ({
      model: m.model,
      requests: m._count._all,
      inputTokens: m._sum.promptTokens ?? 0,
      outputTokens: m._sum.completionTokens ?? 0,
      costCny: usdToCny(m._sum.estimatedCost ?? 0),
    })),
  };
}
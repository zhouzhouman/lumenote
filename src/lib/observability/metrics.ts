import type { PrismaClient } from '@prisma/client';
import { usdToCny } from '@/lib/llm/pricing';

/**
 * 可聚合指标：**纯函数 + 真实数据源查询**。
 *
 * ## 两条设计原则
 *
 * 1. **纯函数独立可测**。分位数、比率这类东西最容易悄悄算错
 *    （例如 P95 取成了第 5 百分位、耗时用总数做分母），而错了之后
 *    报告会看起来依然「像那么回事」。所以把它们抽成不依赖 DB 的函数，
 *    单测逐条锁住边界。
 * 2. **查询口径写进代码常量**。同一份数据可以有多种口径
 *    （LLM 调用次数：UsageLog 行数 ≠ AgentStep 行数 ≠ 实际 generate 次数），
 *    报告里必须能说清「这个数字从哪来、怎么算的」。因此
 *    `METRIC_SOURCES` / `METRIC_DEFINITIONS` 与查询放在同一模块，
 *    避免报告层自己编口径。
 *
 * ## 为什么查询函数接收 prisma 作为参数
 *
 * 与 `src/lib/eval/runner.ts` 同一理由：`src/lib/db.ts` 在模块加载时
 * 读 DATABASE_URL，而 CLI 脚本必须先 dotenv 再加载模块。把连接作为参数
 * 传入让本模块保持无全局状态、单测可以完全不碰 DB。
 */

// ============================================================
// 窗口与纯函数
// ============================================================

export interface MetricsWindow {
  /** 窗口起点（含） */
  from: Date;
  /** 窗口终点（含，通常为「现在」） */
  to: Date;
  /** 展示用文案（含时区说明） */
  label: string;
}

/** ISO 时间（UTC，秒级）—— 报告里的时间窗口标注统一用它 */
export function formatIsoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

/** 构造查询窗口。默认最近 30 天，与仪表盘口径一致 */
export function makeMetricsWindow(days = 30, now: Date = new Date()): MetricsWindow {
  const safeDays = Number.isFinite(days) && days > 0 ? days : 30;
  const from = new Date(now.getTime() - safeDays * 86_400_000);
  return {
    from,
    to: now,
    label: `最近 ${safeDays} 天（${formatIsoSeconds(from)} → ${formatIsoSeconds(now)}）`,
  };
}

/**
 * 线性插值分位数（q ∈ [0,1]）。
 *
 * 与「nearest-rank」的差别：样本少时（例如只有 4 个用例）
 * nearest-rank 会让 P95 直接等于最大值，看起来比实际更差；
 * 线性插值更连续，也更接近主流监控系统的口径。
 *
 * - 空数组 → 0（报告里显示为 `-`，由调用方决定）
 * - 非法 q → 抛 RangeError（静默夹紧会把「传错了参数」藏起来）
 */
export function percentile(values: number[], q: number): number {
  if (!Number.isFinite(q) || q < 0 || q > 1) {
    throw new RangeError(`percentile: q 必须在 [0,1] 内，收到 ${String(q)}`);
  }
  const sorted = (values ?? []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;

  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;

  const weight = position - lower;
  const interpolated = sorted[lower]! + (sorted[upper]! - sorted[lower]!) * weight;
  return Number(interpolated.toFixed(2));
}

/** 比率：分母 <=0 / 非法值一律返回 0（报告中显示为 0%，而不是 NaN） */
export function ratio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  avg: number;
  min: number;
  max: number;
}

/** 端到端耗时汇总（单位毫秒） */
export function summarizeLatency(values: number[]): LatencySummary {
  const cleaned = (values ?? []).filter((value) => Number.isFinite(value) && value >= 0);
  if (cleaned.length === 0) return { count: 0, p50: 0, p95: 0, avg: 0, min: 0, max: 0 };
  const sum = cleaned.reduce((acc, value) => acc + value, 0);
  return {
    count: cleaned.length,
    p50: percentile(cleaned, 0.5),
    p95: percentile(cleaned, 0.95),
    avg: Number((sum / cleaned.length).toFixed(2)),
    min: Math.min(...cleaned),
    max: Math.max(...cleaned),
  };
}

// ============================================================
// 工具调用 / 证据链（纯函数，输入是数据库里取出的 JSON）
// ============================================================

/** 被 Agent 护栏拒绝的调用特征（不是工具执行失败） */
const GUARDRAIL_ERROR_PATTERN = /已达次数上限|未知工具|完全相同的参数调用过/;

interface ParsedToolResult {
  name: string;
  ok: boolean;
  error?: string;
}

function parseToolResults(raw: unknown): ParsedToolResult[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      name: typeof item.name === 'string' ? item.name : 'unknown',
      ok: item.ok === true,
      ...(typeof item.error === 'string' ? { error: item.error } : {}),
    }));
}

export interface ToolUsageStats {
  /** 调度的工具调用总数（含被护栏拒绝的） */
  totalCalls: number;
  /** 被护栏拒绝（额度/重复/未知工具），不是工具本身失败 */
  guardrailRejected: number;
  /** 真正执行并失败的工具调用数 */
  executionFailures: number;
  /** 真正执行过的调用数 = totalCalls - guardrailRejected */
  executedCalls: number;
  /** 执行失败率 = executionFailures / executedCalls */
  executionFailureRate: number;
  /** 按工具名拆分 */
  byTool: Record<string, { calls: number; failures: number }>;
  /** 含 toolResults 的轨迹行数 */
  stepsWithToolResults: number;
}

/**
 * 从 `AgentStep.toolResults` 汇总工具调用。
 *
 * 口径区分（这是本指标最容易含糊的地方）：
 * - **护栏拒绝**（额度用尽/重复调用/未知工具）也算 `ok:false`，但它不是
 *   「工具坏了」，而是「Agent 被正确拦截」。把它算进失败率会让护栏生效
 *   看起来像稳定性变差，所以单独计数。
 */
export function summarizeToolSteps(steps: { toolResults?: unknown }[]): ToolUsageStats {
  const byTool: Record<string, { calls: number; failures: number }> = {};
  let totalCalls = 0;
  let guardrailRejected = 0;
  let executionFailures = 0;
  let stepsWithToolResults = 0;

  for (const step of steps ?? []) {
    const results = parseToolResults(step?.toolResults);
    if (results.length > 0) stepsWithToolResults += 1;
    for (const result of results) {
      totalCalls += 1;
      byTool[result.name] ??= { calls: 0, failures: 0 };
      byTool[result.name].calls += 1;

      if (!result.ok) {
        if (result.error && GUARDRAIL_ERROR_PATTERN.test(result.error)) {
          guardrailRejected += 1;
        } else {
          executionFailures += 1;
          byTool[result.name].failures += 1;
        }
      }
    }
  }

  const executedCalls = totalCalls - guardrailRejected;
  return {
    totalCalls,
    guardrailRejected,
    executionFailures,
    executedCalls,
    executionFailureRate: ratio(executionFailures, executedCalls),
    byTool,
    stepsWithToolResults,
  };
}

interface StructuredMeta {
  conclusions?: { evidence?: unknown[] }[];
  limitations?: unknown[];
}

function parseStructured(outputMeta: unknown): StructuredMeta | null {
  let meta = outputMeta;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      return null;
    }
  }
  if (typeof meta !== 'object' || meta === null) return null;
  const structured = (meta as Record<string, unknown>).structured;
  if (typeof structured !== 'object' || structured === null) return null;
  return structured as StructuredMeta;
}

export interface EvidenceStats {
  /** 有 outputMeta.structured 的 Agent 任务数 */
  tasksWithStructured: number;
  /** 结论总数 */
  conclusions: number;
  /** 至少带 1 条证据的结论数 */
  conclusionsWithEvidence: number;
  /** 证据条目总数 */
  evidenceItems: number;
  /** 完全没有证据的结论数（对应 agent_no_unsupported 断言） */
  unsupportedConclusions: number;
  /** 结构化证据覆盖率 = conclusionsWithEvidence / conclusions */
  evidenceCoverageRate: number;
  /** 没有结构化输出的 Agent 任务数（无法计算证据链） */
  tasksWithoutStructured: number;
}

/**
 * 从 `Task.outputMeta.structured` 汇总证据链完整率。
 *
 * ⚠️ 口径说明：这里算的是**结构化证据覆盖率**（有 evidence 的结论占比），
 * 不是 `checkEvidence()` 的「引文能否在原文中找到」的严格校验
 * （后者需要分块全文，DB 里没有存）。两者都在报告里，口径必须分开写。
 */
export function summarizeEvidence(outputMetas: unknown[]): EvidenceStats {
  let tasksWithStructured = 0;
  let tasksWithoutStructured = 0;
  let conclusions = 0;
  let conclusionsWithEvidence = 0;
  let evidenceItems = 0;
  let unsupportedConclusions = 0;

  for (const rawMeta of outputMetas ?? []) {
    const structured = parseStructured(rawMeta);
    if (!structured || !Array.isArray(structured.conclusions)) {
      tasksWithoutStructured += 1;
      continue;
    }
    tasksWithStructured += 1;
    for (const conclusion of structured.conclusions) {
      conclusions += 1;
      const evidence = Array.isArray(conclusion?.evidence) ? conclusion.evidence : [];
      evidenceItems += evidence.length;
      if (evidence.length > 0) {
        conclusionsWithEvidence += 1;
      } else {
        unsupportedConclusions += 1;
      }
    }
  }

  return {
    tasksWithStructured,
    conclusions,
    conclusionsWithEvidence,
    evidenceItems,
    unsupportedConclusions,
    evidenceCoverageRate: ratio(conclusionsWithEvidence, conclusions),
    tasksWithoutStructured,
  };
}

// ============================================================
// 任务结果 / 超时（纯函数）
// ============================================================

export interface TaskOutcomeStats {
  total: number;
  succeeded: number;
  failed: number;
  canceled: number;
  /** queued / running 的任务数（不论时长） */
  inFlight: number;
  /** 显式返回 TIMEOUT 类错误码的任务数 */
  explicitTimeouts: number;
  /** running/queued 且超过阈值仍未结束的任务（疑似卡死/超时） */
  stuckOverThreshold: number;
  failureRate: number;
  /** 超时率 = (显式超时 + 卡死超阈值) / total */
  timeoutRate: number;
  /** 非成功任务里各状态占比 */
  statusBreakdown: Record<string, number>;
  /** 显式超时/失败的错误码分布 */
  errorCodeBreakdown: Record<string, number>;
}

/** 视为「显式超时」的错误码。来源：llm/types.ts classifyError 的 TIMEOUT */
export const EXPLICIT_TIMEOUT_ERROR_CODES = ['TIMEOUT'] as const;

/** 卡死判定阈值（毫秒）。15 分钟：正常摘要任务远小于它，超过基本可判异常 */
export const DEFAULT_STUCK_TIMEOUT_MS = 15 * 60_000;

export interface TaskOutcomeInput {
  status: string;
  errorCode?: string | null;
  createdAt?: Date | string | null;
}

/**
 * 汇总任务失败率与超时率。
 *
 * ## 两个超时口径都要给（这是缺一不可的）
 *
 * 1. **显式超时**：任务失败且 errorCode = TIMEOUT。这是「上游真的超时了」。
 * 2. **卡死超阈值**：状态仍是 running/queued 且创建时间超过阈值。
 *    这一口径能抓到「进程崩溃导致任务永远 running」—— 那类任务不会写
 *    errorCode，只看失败率会被完全漏掉（用户看到任务一直转圈）。
 */
export function summarizeOutcomes(
  tasks: TaskOutcomeInput[],
  options: { now?: Date; timeoutMs?: number } = {},
): TaskOutcomeStats {
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? DEFAULT_STUCK_TIMEOUT_MS;

  let succeeded = 0;
  let failed = 0;
  let canceled = 0;
  let inFlight = 0;
  let explicitTimeouts = 0;
  let stuckOverThreshold = 0;
  const statusBreakdown: Record<string, number> = {};
  const errorCodeBreakdown: Record<string, number> = {};

  for (const task of tasks ?? []) {
    const status = task.status ?? 'unknown';
    statusBreakdown[status] = (statusBreakdown[status] ?? 0) + 1;

    if (status === 'succeeded') succeeded += 1;
    else if (status === 'failed') failed += 1;
    else if (status === 'canceled') canceled += 1;
    else {
      inFlight += 1;
      const createdAt = task.createdAt ? new Date(task.createdAt).getTime() : NaN;
      if (Number.isFinite(createdAt) && now.getTime() - createdAt > timeoutMs) {
        stuckOverThreshold += 1;
      }
    }

    const errorCode = task.errorCode ?? undefined;
    if (errorCode) {
      errorCodeBreakdown[errorCode] = (errorCodeBreakdown[errorCode] ?? 0) + 1;
      if ((EXPLICIT_TIMEOUT_ERROR_CODES as readonly string[]).includes(errorCode)) {
        explicitTimeouts += 1;
      }
    }
  }

  const total = tasks?.length ?? 0;
  return {
    total,
    succeeded,
    failed,
    canceled,
    inFlight,
    explicitTimeouts,
    stuckOverThreshold,
    failureRate: ratio(failed, total),
    timeoutRate: ratio(explicitTimeouts + stuckOverThreshold, total),
    statusBreakdown,
    errorCodeBreakdown,
  };
}

// ============================================================
// 数据来源与口径（报告必须原样引用，避免口径漂移）
// ============================================================

export const METRIC_SOURCES = {
  latency: 'Task.latencyMs（为空时用 completedAt - createdAt 兜底）',
  outcomes: 'Task.status / errorCode / createdAt',
  llmCalls: 'UsageLog 行数（任务级结算记录，taskId 唯一）',
  agentCalls: 'AgentStep 行数（每行对应一次模型 generate 调用）',
  tokens: 'UsageLog.promptTokens / completionTokens / cachedTokens',
  cost: 'UsageLog.estimatedCost（单位：美元；展示时按 7.2 换算人民币）',
  tools: 'AgentStep.toolResults（JSON 数组）',
  evidence: 'Task.outputMeta.structured（Agent 结论与证据引用）',
} as const;

export const METRIC_DEFINITIONS = {
  latency: '端到端耗时：Task.latencyMs，缺失时用 completedAt - createdAt；只统计 succeeded 且已完成的普通任务',
  llmCalls: 'UsageLog 一行 = 一次任务级计量结算：摘要任务 Map 阶段的多次调用合并进 meta，Agent 的多轮调用合并为一条，因此它 < 实际 generate 次数',
  agentCalls: 'AgentStep 一行 = 一次模型调用（plan/act/finalize/give_up 各对应一次 generate），因此它是 Agent 实际模型调用次数的准确口径',
  tokens: '按 UsageLog 累计：promptTokens（含缓存命中）/ completionTokens / cachedTokens',
  cost: 'UsageLog.estimatedCost 由 pricing.ts 按模型单价 × 峰谷 × 缓存分档算出，落库为美元',
  tools: '工具失败率 = executionFailures / executedCalls；护栏拒绝（额度/重复/未知工具）不计入失败率',
  evidence: '结构化证据覆盖率 = 带 ≥1 条证据的结论数 / 结论总数；不含「引文能否在原文中找到」的严格校验',
  timeout: '超时率 = (errorCode=TIMEOUT + running/queued 超过 15 分钟) / 窗口内任务总数',
} as const;

// ============================================================
// 真实数据查询
// ============================================================

export interface MetricsQueryOptions {
  /** 查询窗口天数，默认 30 */
  windowDays?: number;
  /** 窗口终点，默认现在（测试/报告可固定） */
  now?: Date;
  /** 卡死阈值（毫秒），默认 15 分钟 */
  stuckTimeoutMs?: number;
  /** 只统计某个用户（缺省为全库） */
  userId?: string;
}

export interface ObservabilitySnapshot {
  generatedAt: string;
  window: MetricsWindow;
  latency: {
    all: LatencySummary;
    byType: Record<string, LatencySummary>;
    /** 数据来源里实际命中的任务数 */
    sample: number;
  };
  llm: {
    /** UsageLog 行数 */
    meteredRecords: number;
    /** 其中失败记录数 */
    failedRecords: number;
    /** AgentStep 行数（Agent 模型调用次数口径） */
    agentModelCalls: number;
  };
  tokens: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheHitRate: number;
    totalCostUsd: number;
    totalCostCny: number;
    byModel: {
      model: string;
      records: number;
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      costUsd: number;
      costCny: number;
    }[];
  };
  tools: ToolUsageStats;
  evidence: EvidenceStats;
  outcomes: TaskOutcomeStats;
  sources: typeof METRIC_SOURCES;
  definitions: typeof METRIC_DEFINITIONS;
}

function windowWhere(window: MetricsWindow, userId?: string): { createdAt: { gte: Date; lte: Date } } & { userId?: string } {
  return {
    createdAt: { gte: window.from, lte: window.to },
    ...(userId ? { userId } : {}),
  };
}

/** 端到端延迟（p50/p95），来自真实 Task 行 */
export async function queryLatency(
  prisma: PrismaClient,
  window: MetricsWindow,
  userId?: string,
): Promise<ObservabilitySnapshot['latency']> {
  const rows = await prisma.task.findMany({
    where: {
      ...windowWhere(window, userId),
      deletedAt: null,
      status: 'succeeded',
      completedAt: { not: null },
    },
    select: { type: true, latencyMs: true, createdAt: true, completedAt: true },
  });

  const values: number[] = [];
  const byTypeValues = new Map<string, number[]>();

  for (const row of rows) {
    const derived =
      row.latencyMs ?? (row.completedAt ? row.completedAt.getTime() - row.createdAt.getTime() : 0);
    if (!Number.isFinite(derived) || derived < 0) continue;
    values.push(derived);
    const list = byTypeValues.get(row.type) ?? [];
    list.push(derived);
    byTypeValues.set(row.type, list);
  }

  const byType: Record<string, LatencySummary> = {};
  for (const [type, list] of byTypeValues) {
    byType[type] = summarizeLatency(list);
  }

  return { all: summarizeLatency(values), byType, sample: values.length };
}

/** LLM 调用次数（两个口径）与 token/成本 */
export async function queryUsage(
  prisma: PrismaClient,
  window: MetricsWindow,
  userId?: string,
): Promise<Pick<ObservabilitySnapshot, 'llm' | 'tokens'>> {
  const [logs, agentStepCount] = await Promise.all([
    prisma.usageLog.findMany({
      where: windowWhere(window, userId),
      select: {
        model: true,
        promptTokens: true,
        completionTokens: true,
        cachedTokens: true,
        estimatedCost: true,
        success: true,
      },
    }),
    prisma.agentStep.count({
      where: {
        createdAt: { gte: window.from, lte: window.to },
        ...(userId ? { task: { userId } } : {}),
      },
    }),
  ]);

  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let totalCostUsd = 0;
  let failedRecords = 0;
  const byModel = new Map<
    string,
    { records: number; promptTokens: number; completionTokens: number; cachedTokens: number; costUsd: number }
  >();

  for (const log of logs) {
    promptTokens += log.promptTokens;
    completionTokens += log.completionTokens;
    cachedTokens += log.cachedTokens;
    totalCostUsd += log.estimatedCost;
    if (!log.success) failedRecords += 1;

    const bucket = byModel.get(log.model) ?? {
      records: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
    };
    bucket.records += 1;
    bucket.promptTokens += log.promptTokens;
    bucket.completionTokens += log.completionTokens;
    bucket.cachedTokens += log.cachedTokens;
    bucket.costUsd += log.estimatedCost;
    byModel.set(log.model, bucket);
  }

  return {
    llm: {
      meteredRecords: logs.length,
      failedRecords,
      agentModelCalls: agentStepCount,
    },
    tokens: {
      promptTokens,
      completionTokens,
      cachedTokens,
      cacheHitRate: ratio(cachedTokens, promptTokens),
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      totalCostCny: Number(usdToCny(totalCostUsd).toFixed(4)),
      byModel: [...byModel.entries()].map(([model, bucket]) => ({
        model,
        records: bucket.records,
        promptTokens: bucket.promptTokens,
        completionTokens: bucket.completionTokens,
        cachedTokens: bucket.cachedTokens,
        costUsd: Number(bucket.costUsd.toFixed(6)),
        costCny: Number(usdToCny(bucket.costUsd).toFixed(4)),
      })),
    },
  };
}

/** 工具调用次数与失败率，来自 AgentStep.toolResults */
export async function queryToolUsage(
  prisma: PrismaClient,
  window: MetricsWindow,
  userId?: string,
): Promise<ToolUsageStats> {
  const steps = await prisma.agentStep.findMany({
    where: {
      createdAt: { gte: window.from, lte: window.to },
      ...(userId ? { task: { userId } } : {}),
    },
    select: { toolResults: true },
  });
  return summarizeToolSteps(steps);
}

/** 证据链结构指标，来自 Agent 任务的 outputMeta.structured */
export async function queryEvidence(
  prisma: PrismaClient,
  window: MetricsWindow,
  userId?: string,
): Promise<EvidenceStats> {
  const tasks = await prisma.task.findMany({
    where: {
      ...windowWhere(window, userId),
      deletedAt: null,
      type: 'agent',
    },
    select: { outputMeta: true },
  });
  return summarizeEvidence(tasks.map((task) => task.outputMeta));
}

/** 失败率与超时率 */
export async function queryOutcomes(
  prisma: PrismaClient,
  window: MetricsWindow,
  options: { stuckTimeoutMs?: number; userId?: string } = {},
): Promise<TaskOutcomeStats> {
  const tasks = await prisma.task.findMany({
    where: { ...windowWhere(window, options.userId) },
    select: { status: true, errorCode: true, createdAt: true },
  });
  return summarizeOutcomes(tasks, {
    now: window.to,
    timeoutMs: options.stuckTimeoutMs,
  });
}

/**
 * 一次性采集全部指标（报告脚本的唯一入口）。
 *
 * 所有查询都带同一个 `window`，因此报告里的每个数字都能标注相同的
 * 「数据来源 + 时间窗口」；不存在「这个数是上周的、那个数是今天的」的混用。
 */
export async function collectMetrics(
  prisma: PrismaClient,
  options: MetricsQueryOptions = {},
): Promise<ObservabilitySnapshot> {
  const window = makeMetricsWindow(options.windowDays ?? 30, options.now);
  const [latency, usage, tools, evidence, outcomes] = await Promise.all([
    queryLatency(prisma, window, options.userId),
    queryUsage(prisma, window, options.userId),
    queryToolUsage(prisma, window, options.userId),
    queryEvidence(prisma, window, options.userId),
    queryOutcomes(prisma, window, {
      stuckTimeoutMs: options.stuckTimeoutMs,
      ...(options.userId ? { userId: options.userId } : {}),
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    window,
    latency,
    llm: usage.llm,
    tokens: usage.tokens,
    tools,
    evidence,
    outcomes,
    sources: METRIC_SOURCES,
    definitions: METRIC_DEFINITIONS,
  };
}

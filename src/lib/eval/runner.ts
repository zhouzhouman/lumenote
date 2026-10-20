import type { PrismaClient } from '@prisma/client';
import { computeCostUsd } from '@/lib/llm/pricing';
import { estimateTokens } from '@/lib/llm/mock';
import { LLMError } from '@/lib/llm/types';
import {
  evaluateRuleAssertion,
  scoreCase,
  type AssertionResult,
  type AgentTraceSummary,
  type EvalAssertion,
  type JudgeAssertionConfig,
} from './assertions';
import {
  judgeOutput,
  judgePassed,
  judgeThreshold,
  JUDGE_PROMPT_VERSION,
  assertJudgeIsIndependent,
  gateDimension,
  type JudgeOptions,
} from './judge';
import { buildRegressionReport, type RegressionReport, type CaseResultInput } from './report';

/**
 * 评测运行器。
 *
 * ## 职责边界（这个文件最重要的设计）
 *
 * 运行器**不生成输出**，也**不自己拿数据库连接**。
 *
 * 1. **不生成**：输出的生成方式因任务类型而异（摘要走 runSummarizePipeline，
 *    Agent 走 runAgentPipeline）。如果运行器也负责生成，它要知道所有管线，
 *    于是断言逻辑、报告逻辑、管线编排全糊在一起。
 *    拆开之后运行器只做「评测」，生成由调用方负责。
 *
 * 2. **不自己拿连接**：`prisma` 从参数传入而不是 import 全局单例。
 *    原因很实际 —— `src/lib/db.ts` 在**模块加载时**读 `process.env.DATABASE_URL`，
 *    而 CLI 脚本需要先 `dotenv` 再加载。ESM 的 import 会被提升到模块顶部，
 *    于是 `loadEnv()` 总是晚于 `db.ts` 的求值 → 报「DATABASE_URL 未配置」。
 *    把连接作为参数传入，既绕开了这个加载顺序问题，
 *    也让评测核心不再依赖全局状态（可测试性顺带提升）。
 *
 * ## 成本前置估算
 *
 * 评测是**批量**的：20 个用例 × (被测调用 + judge 调用) = 40 次调用。
 * 所以必须先估算再跑。`estimateRunCost` 给出预估，
 * 超过 `maxCostUsd` 直接拒绝启动。
 */

// ============================================================
// 输入
// ============================================================

export interface EvalCaseInput {
  caseId: string;
  caseName: string;
  weight: number;
  isRegression: boolean;
  expectations: EvalAssertion[];
  /**
   * **源材料**（被测的文档 / 原文）。
   *
   * ⚠️ 这个字段原本缺失，导致一个严重缺陷：judge 的 `material` 被错填成
   * 模型自己的输出，于是「它有没有背离材料」这个问题**在逻辑上永远为真**——
   * 材料就是输出本身。faithfulness 断言因此无条件通过，形同虚设。
   *
   * 而且这个缺陷是"看起来在工作"的：断言有结果、报告有分数、
   * 一致率也正常（因为 calibrate 命令里用的是 `input`，是对的）——
   * 只有把两处的 material 摆在一起看才发现不一致。
   */
  material: string;
  /** 当时问的问题（agent 任务才有）。judge 判「切题度」时必须知道它 */
  question?: string | null;
  /** 要评的输出内容。由调用方生成 */
  output: string;
  /** Agent 任务的轨迹摘要（非 agent 任务为 null） */
  trace?: AgentTraceSummary | null;
  /** 该用例的生成成本（由调用方给出，用于汇总） */
  costUsd?: number;
  latencyMs?: number;
  errorMessage?: string | null;
}

/** judge 的凭证。由调用方解析后传入，运行器不关心它从哪来 */
export interface JudgeCredential {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface RunEvalOptions {
  prisma: PrismaClient;
  userId: string;
  datasetId: string;
  promptVersionId: string;
  templateId: string;
  /** 被测对象的名字（模型名，用于 judge 独立性检查） */
  subjectModel: string;
  cases: EvalCaseInput[];
  /** 与哪次运行对比。为空则取该数据集最近一次成功运行 */
  baselineRunId?: string | null;
  /** 是否启用 judge。关闭时 judge 断言一律判失败（而不是静默跳过） */
  enableJudge?: boolean;
  /** judge 凭证。缺省时 judge 断言全部失败 */
  judgeCredential?: JudgeCredential | null;
  /** 成本上限（美元）。超过则拒绝运行 */
  maxCostUsd?: number;
  signal?: AbortSignal;
}

export interface RunEvalResult {
  runId: string;
  totalCases: number;
  passedCases: number;
  weightedScore: number;
  totalCostUsd: number;
  report: RegressionReport | null;
  /** judge 可信度告警（judge 与被测模型相同时） */
  judgeWarning?: string;
  /** 校准闸门拒绝的维度说明（未通过人工校准，已跳过） */
  gateWarnings?: string[];
  /** 整条用例都未被评估的数量（所有断言都被跳过） */
  skippedCases?: number;
  /** 跳过的 judge 断言数（未启用 judge 时） */
  skippedJudgeAssertions: number;
}

// ============================================================
// 成本估算
// ============================================================

/**
 * 估算一次评测的成本（跑之前）。
 *
 * 两个组成部分：
 *  1. **被测调用**：由调用方已经花掉（它生成输出时就付过钱了），
 *     所以这里只估 **judge** 的成本 —— 那是评测框架自己引入的新开销。
 *  2. judge 调用 = 材料 + 输出 + rubric，输出约 100 token。
 *
 * ⚠️ 只估 judge 是刻意的：让用户明白"评测本身要花多少钱"。
 * 把被测成本也算进来会让人以为是评测在烧钱，而其实那是生成的成本。
 */
export function estimateRunCost(cases: EvalCaseInput[], model: string): { judgeCalls: number; estimatedUsd: number } {
  let judgeCalls = 0;
  let totalInputTokens = 0;

  for (const c of cases) {
    for (const a of c.expectations) {
      if (a.kind !== 'judge') continue;
      judgeCalls += 1;
      /**
       * judge 输入 ≈ 源材料(截断后) + 问题 + 输出 + rubric。
       *
       * ⚠️ 材料与输出都要算。第一版只算了 `c.output`（因为当时 material
       * 被错填成 output），于是成本预估系统性偏低 —— 而真实材料
       * 通常是几千字的文档，比输出大得多。
       */
      const materialTokens = Math.min(estimateTokens(c.material) + 2000, 6000);
      const outputTokensForJudge = estimateTokens(c.output);
      totalInputTokens += materialTokens + outputTokensForJudge;
    }
  }

  const outputTokens = judgeCalls * 120;
  const { costUsd } = computeCostUsd({
    model,
    promptTokens: totalInputTokens,
    cachedTokens: 0,
    completionTokens: outputTokens,
  });

  return { judgeCalls, estimatedUsd: Number(costUsd.toFixed(6)) };
}

// ============================================================
// 主流程
// ============================================================

export async function runEval(options: RunEvalOptions): Promise<RunEvalResult> {
  const { prisma } = options;
  const startedAt = Date.now();

  if (options.cases.length === 0) {
    throw new Error('用例集为空，无法评测');
  }

  // ---- 成本前置检查 ----
  const estimate = estimateRunCost(options.cases, options.subjectModel);
  if (options.maxCostUsd !== undefined && estimate.estimatedUsd > options.maxCostUsd) {
    /**
     * ⚠️ 必须用真正的 `LLMError`，不能用 `Object.assign(new Error(...), {code})`。
     *
     * 路由层的 `handleError` / `classifyError` 用 `e instanceof LLMError` 判断，
     * 普通 Error 即使挂了 code/statusCode 字段也会被当成未知错误 → 返回 500。
     * 而「成本超限」是明确的 422 业务拒绝，报 500 会误导用户以为是服务端故障。
     */
    throw new LLMError(
      `预计本轮 judge 成本 $${estimate.estimatedUsd.toFixed(4)}（${estimate.judgeCalls} 次判定），` +
        `超过上限 $${options.maxCostUsd.toFixed(4)}。请减少用例、关闭 judge 断言，或提高上限。`,
      'EVAL_COST_EXCEEDED',
      false,
      422,
    );
  }

  // ---- 基线 ----
  const baseline = options.baselineRunId
    ? await prisma.evalRun.findFirst({
        where: { id: options.baselineRunId, userId: options.userId },
        include: { results: true },
      })
    : await prisma.evalRun.findFirst({
        where: { datasetId: options.datasetId, userId: options.userId, status: 'succeeded' },
        orderBy: { createdAt: 'desc' },
        include: { results: true },
      });

  // ---- 建运行记录 ----
  const run = await prisma.evalRun.create({
    data: {
      datasetId: options.datasetId,
      userId: options.userId,
      promptVersionId: options.promptVersionId,
      templateId: options.templateId,
      model: options.subjectModel,
      judgeModel: options.enableJudge === false ? null : (options.judgeCredential?.model ?? null),
      judgePromptVersion: options.enableJudge === false ? null : JUDGE_PROMPT_VERSION,
      status: 'running',
      baselineRunId: baseline?.id ?? null,
    },
  });

  // ---- judge 配置 ----
  const judgeOptions: JudgeOptions | null = options.judgeCredential?.apiKey
    ? {
        apiKey: options.judgeCredential.apiKey,
        baseUrl: options.judgeCredential.baseUrl,
        model: options.judgeCredential.model,
      }
    : null;

  const independence = judgeOptions
    ? assertJudgeIsIndependent(judgeOptions.model, options.subjectModel)
    : { independent: false, warning: '没有可用的 judge 凭证，judge 断言将全部失败' };

  /**
   * 校准闸门：只有通过**真人**人工校准的维度才允许参与评测。
   *
   * ⚠️ 这一步是**拒绝**而不是警告，见 judge.ts 里 gateDimension 的说明。
   * 没有它的话，报告里会出现「忠实度 4 分」这种看起来客观、
   * 实际上不可信的数字 —— 那比没有 judge 更糟。
   *
   * ⚠️ `isSeed: false` 是这道闸门的关键。
   * 种子样本是脚本按质量档位构造的（构造者知道 judge 会打几分），
   * 用它们算出的"一致率"证明不了 judge 可信。如果把它们算进来，
   * 就等于用自己编的分数把闸门打开 —— 假的可信度比没有更危险。
   * 所以种子样本只用于演示，永不参与放行判定。
   */
  const calibrationRows = await prisma.judgeCalibration.findMany({
    where: { userId: options.userId, judgeScore: { not: null }, isSeed: false },
    select: { dimension: true, humanScore: true, judgeScore: true },
  });

  const calibrationByDimension = new Map<string, { human: number; judge: number }[]>();
  for (const row of calibrationRows) {
    if (row.judgeScore === null) continue;
    if (!calibrationByDimension.has(row.dimension)) calibrationByDimension.set(row.dimension, []);
    calibrationByDimension.get(row.dimension)!.push({
      human: row.humanScore,
      judge: row.judgeScore,
    });
  }

  /** 本次运行实际要用到的维度 → 闸门结论 */
  const neededDimensions = new Set(
    options.cases.flatMap((c) =>
      c.expectations.filter((a) => a.kind === 'judge').map((a) => {
        const cfg = (a.value ?? {}) as JudgeAssertionConfig;
        return cfg.dimension ?? 'faithfulness';
      }),
    ),
  );

  const gates = new Map<string, ReturnType<typeof gateDimension>>();
  for (const dim of neededDimensions) {
    gates.set(dim, gateDimension(dim, calibrationByDimension.get(dim) ?? []));
  }

  const gateWarnings = [...gates.values()].filter((g) => !g.allowed).map((g) => g.reason);

  let totalCostUsd = 0;
  let totalTokens = 0;
  let passedCases = 0;
  let weightedPassed = 0;
  let weightedTotal = 0;
  let skippedJudgeAssertions = 0;
  /** 整条用例都未被评估（所有断言都被跳过）的数量 */
  let skippedCases = 0;

  const caseResults: CaseResultInput[] = [];

  for (const c of options.cases) {
    if (options.signal?.aborted) break;

    const caseStart = Date.now();
    const results: AssertionResult[] = [];

    for (const assertion of c.expectations) {
      if (assertion.kind !== 'judge') {
        results.push(evaluateRuleAssertion(assertion, c.output, c.trace ?? null));
        continue;
      }

      // ---- judge 断言 ----
      if (options.enableJudge === false || !judgeOptions) {
        skippedJudgeAssertions += 1;
        results.push({
          kind: 'judge',
          passed: false,
          /**
           * ⚠️ 标记为 skipped 而不是 failed。
           *
           * 我们主动关闭了 judge，这不是"模型没通过"，而是"没有判定"。
           * 记成 failed 会让用例算失败、报告说回归 —— 全是假警报。
           */
          skipped: true,
          skippedReason:
            options.enableJudge === false
              ? 'judge 断言已被关闭（本次运行不启用 judge）'
              : '没有可用的 judge 凭证，无法执行判定',
          reason:
            options.enableJudge === false
              ? 'judge 断言已被关闭（本次运行不启用 judge）'
              : '没有可用的 judge 凭证，无法执行判定',
          weight: assertion.weight ?? 1,
          ...(assertion.description ? { description: assertion.description } : {}),
        });
        continue;
      }

      const cfg = (assertion.value ?? {}) as JudgeAssertionConfig;
      const dimension = cfg.dimension ?? 'faithfulness';

      /**
       * 校准闸门检查：未通过校准的维度**直接跳过**，不做判定。
       *
       * 跳过的理由必须写清楚（是没样本、样本太少、还是一致率不达标），
       * 否则报告里出现一个"失败"会让人以为是被测模型的问题。
       */
      const gate = gates.get(dimension);
      if (gate && !gate.allowed) {
        skippedJudgeAssertions += 1;
        results.push({
          kind: 'judge',
          passed: false,
          // 同上：闸门拒绝是"未评估"，不是"模型失败"
          skipped: true,
          skippedReason: gate.reason,
          reason: `已跳过：${gate.reason}`,
          weight: assertion.weight ?? 1,
          ...(assertion.description ? { description: assertion.description } : {}),
        });
        continue;
      }

      const outcome = await judgeOutput(
        {
          dimension,
          ...(cfg.rubric ? { rubric: cfg.rubric } : {}),
          /**
           * ⚠️ 这里必须传**源材料**，不能传 c.output。
           *
           * 曾经写成 `material: c.output`，于是 judge 被要求
           * "判断输出有没有背离材料"，而材料就是输出 —— 结论必然是通过。
           * 这个 bug 不报错、不显形，只是让 faithfulness 断言失去意义。
           */
          material: c.material,
          ...(c.question ? { question: c.question } : {}),
          output: c.output,
        },
        judgeOptions,
      );

      const threshold = judgeThreshold(dimension, cfg.passScore);
      const passed = judgePassed(outcome, cfg.passScore);

      // judge 的成本也要算进本次运行
      const judgeCost = computeCostUsd({
        model: judgeOptions.model,
        promptTokens: estimateTokens(c.output) + 800,
        cachedTokens: 0,
        completionTokens: 120,
      }).costUsd;
      totalCostUsd += judgeCost;
      totalTokens += estimateTokens(c.output) + 800 + 120;

      results.push({
        kind: 'judge',
        passed,
        reason: passed
          ? `${cfg.dimension} 得 ${outcome.score} 分（阈值 ${threshold}）：${outcome.reason}`
          : `${cfg.dimension} 得 ${outcome.score} 分（低于阈值 ${threshold}）：${outcome.reason}`,
        weight: assertion.weight ?? 1,
        ...(assertion.description ? { description: assertion.description } : {}),
        judge: {
          dimension,
          score: outcome.score,
          model: outcome.model,
          promptVersion: outcome.promptVersion,
          reason: outcome.reason,
        },
      });
    }

    const scored = scoreCase(results);
    const generationCost = c.costUsd ?? 0;
    totalCostUsd += generationCost;

    /**
     * ⚠️ 三种状态，不是两种。
     *
     *   passed  —— 所有被评估的断言都过
     *   skipped —— **一条断言都没被评估**（例如唯一的 judge 断言因未校准被拒）。
     *              必须与 failed 分开：它既不该算通过，也不该算失败，
     *              更不该在回归报告里表现为"变差了"。
     *   failed  —— 至少一条被评估的断言没过
     */
    const status = !scored.evaluated ? 'skipped' : scored.passed ? 'passed' : 'failed';

    /**
     * 通过率的分子分母**只统计被评估的用例**。
     *
     * 跳过的用例若算进分母，会人为压低通过率；
     * 若算进分子，则是"没评估就算过"的作弊。两者都不对。
     */
    if (scored.evaluated) {
      weightedTotal += c.weight > 0 ? c.weight : 1;
      if (scored.passed) {
        passedCases += 1;
        weightedPassed += c.weight > 0 ? c.weight : 1;
      }
    }
    if (status === 'skipped') skippedCases += 1;

    await prisma.evalCaseResult.create({
      data: {
        runId: run.id,
        caseId: c.caseId,
        status,
        score: scored.score,
        output: c.output,
        assertions: results as never,
        trace: (c.trace ?? null) as never,
        inputTokens: estimateTokens(c.output),
        outputTokens: 0,
        costUsd: generationCost,
        latencyMs: c.latencyMs ?? Date.now() - caseStart,
        errorMessage: c.errorMessage ?? null,
      },
    });

    caseResults.push({
      caseId: c.caseId,
      caseName: c.caseName,
      weight: c.weight,
      isRegression: c.isRegression,
      passed: scored.passed,
      evaluated: scored.evaluated,
      skippedCount: scored.skippedCount,
      score: scored.score,
      output: c.output,
      assertions: results,
      costUsd: generationCost,
      latencyMs: c.latencyMs ?? Date.now() - caseStart,
      errorMessage: c.errorMessage ?? null,
    });
  }

  const weightedScore = weightedTotal === 0 ? 0 : Number((weightedPassed / weightedTotal).toFixed(4));
  const durationMs = Date.now() - startedAt;

  await prisma.evalRun.update({
    where: { id: run.id },
    data: {
      status: 'succeeded',
      totalCases: caseResults.length,
      passedCases,
      failedCases: caseResults.length - passedCases,
      weightedScore,
      totalCostUsd,
      totalTokens,
      durationMs,
      completedAt: new Date(),
    },
  });

  // ---- 回归报告 ----
  let report: RegressionReport | null = null;
  if (baseline) {
    report = buildRegressionReport(
      {
        runId: baseline.id,
        createdAt: baseline.createdAt.toISOString(),
        model: baseline.model,
        judgeModel: baseline.judgeModel,
        judgePromptVersion: baseline.judgePromptVersion,
        promptVersion: baseline.promptVersionId,
        results: baseline.results.map((r) => ({
          caseId: r.caseId,
          caseName: r.caseId,
          weight: 1,
          isRegression: false,
          passed: r.status === 'passed',
          score: r.score,
          output: r.output ?? '',
          assertions: (r.assertions ?? []) as unknown as AssertionResult[],
          costUsd: r.costUsd,
          latencyMs: r.latencyMs,
          errorMessage: r.errorMessage,
        })),
      },
      {
        runId: run.id,
        createdAt: new Date().toISOString(),
        model: options.subjectModel,
        judgeModel: judgeOptions?.model,
        judgePromptVersion: judgeOptions ? JUDGE_PROMPT_VERSION : null,
        promptVersion: options.promptVersionId,
        results: caseResults,
      },
    );
  }

  return {
    runId: run.id,
    totalCases: caseResults.length,
    passedCases,
    weightedScore,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    report,
    ...(independence.warning ? { judgeWarning: independence.warning } : {}),
    ...(gateWarnings.length > 0 ? { gateWarnings } : {}),
    skippedJudgeAssertions,
    skippedCases,
  };
}

/**
 * 读取一次运行的完整结果（供 API 与报告页使用）。
 *
 * 同样把 `prisma` 作为参数传入 —— 与 `runEval` 保持一致，
 * 避免这个模块在加载时就依赖 `src/lib/db`（原因见文件头的说明）。
 */
export async function loadRunDetail(prisma: PrismaClient, userId: string, runId: string) {
  const run = await prisma.evalRun.findFirst({
    where: { id: runId, userId },
    include: {
      results: {
        include: { case: { select: { name: true, weight: true, isRegression: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!run) return null;

  return {
    run: {
      id: run.id,
      datasetId: run.datasetId,
      status: run.status,
      model: run.model,
      judgeModel: run.judgeModel,
      judgePromptVersion: run.judgePromptVersion,
      totalCases: run.totalCases,
      passedCases: run.passedCases,
      failedCases: run.failedCases,
      weightedScore: run.weightedScore,
      totalCostUsd: run.totalCostUsd,
      totalTokens: run.totalTokens,
      durationMs: run.durationMs,
      baselineRunId: run.baselineRunId,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    },
    results: run.results.map((r) => ({
      caseId: r.caseId,
      caseName: r.case.name,
      weight: r.case.weight,
      isRegression: r.case.isRegression,
      status: r.status,
      score: r.score,
      output: r.output,
      assertions: (r.assertions ?? []) as unknown as AssertionResult[],
      trace: r.trace,
      costUsd: r.costUsd,
      latencyMs: r.latencyMs,
      errorMessage: r.errorMessage,
    })),
  };
}

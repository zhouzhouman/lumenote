/**
 * 可复现评测报告（`pnpm eval:report`）。
 *
 * ## 它做什么（一次运行产出全部证据）
 *
 *   1. 用 **MOCK 模式** 跑内置评测用例（MockProvider，`enableJudge=false`），
 *      统计规则断言通过率 —— 只验证流程/断言/成本口径，**不代表真实模型质量**；
 *   2. 真实测量本轮生成的耗时，并用 pricing.ts 按 token 估算成本；
 *   3. 从真实数据库聚合指标（延迟 p50/p95、LLM 调用数、token/成本、工具失败率、
 *      证据完整率、失败率/超时率），每个数字都标注数据来源与时间窗口；
 *   4. 跑失败样本回归集（8 条故意缺陷 + 2 条良样本对照），证明断言有区分力；
 *   5. 真实执行一次 mock 摘要任务（走 `runSummarizePipeline`）生成 JSONL trace，
 *      按 taskId 展示 span 树；另用脚本化 Provider 展示 Agent 侧完整 span 链路；
 *   6. 覆盖式生成 `docs/eval-report.md` 与 `.eval-results/report.json`。
 *
 * ## 为什么是「mock 模式」
 *
 * 本环境**没有真实 API Key，也不允许产生费用**。所以报告必须：
 *   - 明确标注 MOCK 模式；
 *   - judge 断言标注「未运行（无 Key / 避免费用）」；
 *   - 真实模型评测写成「未运行」，不编造模型效果。
 *
 * ## 幂等性
 *
 * - 数据集与用例按名称幂等 upsert，不重复创建；
 * - 报告用摘要 trace 任务在每次运行前删除重建（DB 中恒定一条，不随运行次数增长）；
 * - 每次运行会产生一条新的 EvalRun 审计记录（评测历史，不是重复数据）。
 *
 * ## 加载顺序（踩过的坑）
 *
 * `src/lib/db.ts` 在**模块加载时**读 `DATABASE_URL`。dotenv 必须在所有
 * 业务模块 import 之前执行，所以 `main()` 里用动态 `import()` 加载业务模块；
 * 顶层只静态 import 不依赖 env 的纯模块（断言、pricing、observability）。
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { AgentTraceSummary, AssertionResult, EvalAssertion } from '../../src/lib/eval/assertions';
import { evaluateRuleAssertion, outputFingerprint, scoreCase } from '../../src/lib/eval/assertions';
import type { EvalCaseInput } from '../../src/lib/eval/runner';
import type { RegressionReport } from '../../src/lib/eval/report';
import { computeCostUsd } from '../../src/lib/llm/pricing';
import { collectMetrics, summarizeLatency, type ObservabilitySnapshot } from '../../src/lib/observability/metrics';
import { flushTracing, initTracing } from '../../src/lib/observability/tracing';
import {
  formatSpanTree,
  readSpansForTask,
  summarizeTrace,
  type TraceSpanRecord,
} from '../../src/lib/observability/trace-reader';
import { DEMO_CASES, DEMO_DATASET, EVAL_DOCUMENT } from './dataset';
import {
  REGRESSION_CONTROL_SAMPLES,
  REGRESSION_DEFECT_SAMPLES,
  type RegressionSample,
} from './regression-samples';

// dotenv 必须在业务模块（尤其是 src/lib/db.ts）被加载前执行
loadEnv({ path: ['.env.local', '.env'] });

// ============================================================
// 常量
// ============================================================

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, 'docs');
const REPORT_MD = path.join(DOCS_DIR, 'eval-report.md');
const RESULTS_DIR = path.join(ROOT, '.eval-results');
const REPORT_JSON = path.join(RESULTS_DIR, 'report.json');
const DEMO_EMAIL = 'demo@lumenote.dev';
const REPORT_TASK_TITLE_PREFIX = '[eval-report]';
/** 报告专用数据集：隔离 mock 运行历史，避免与真实模型评测运行混在一起对比 */
const REPORT_DATASET_NAME = `${DEMO_DATASET.name}（eval:report mock）`;
const AGENT_TRACE_TASK_ID = 'eval-report-scripted-agent';
const STRUCTURED_AGENT_QUOTE = '缓存命中率是 AI 应用里最重要的成本杠杆。';

const MOCK_MODEL = process.env.DEFAULT_MODEL?.trim() || 'deepseek-flash';
const MOCK_QUOTA_NOTE =
  'MOCK 模式：只验证流程 / 断言 / 成本口径，不代表真实模型质量；本轮未调用任何真实模型，也未产生 API 费用。';

// ============================================================
// 报告数据结构
// ============================================================

interface CaseReport {
  caseId: string;
  caseName: string;
  weight: number;
  isRegression: boolean;
  status: string;
  passed: boolean;
  evaluated: boolean;
  score: number;
  passedCount: number;
  totalCount: number;
  skippedCount: number;
  latencyMs: number;
  costUsd: number;
  outputFingerprint: string;
  failures: { kind: string; reason: string }[];
}

interface RegressionReportRow {
  id: string;
  name: string;
  defectType: string;
  expectDetected: boolean;
  detected: boolean;
  matchedExpectation: boolean;
  passedCount: number;
  totalCount: number;
  score: number;
  failedAssertions: { kind: string; reason: string }[];
}

interface TraceReport {
  taskId: string;
  traceId: string | null;
  spanCount: number;
  durationMs: number;
  spanNameCounts: Record<string, number>;
  treeText: string;
  spans: {
    name: string;
    parentName: string | null;
    durationMs: number;
    attributes: Record<string, string | number | boolean>;
  }[];
  note: string;
}

// ============================================================
// 入口
// ============================================================

async function main(): Promise<void> {
  const startedAt = new Date();
  banner();

  assertEnvironment();

  // 业务模块必须在 dotenv 之后动态加载（见文件头「加载顺序」）
  const app = await loadAppModules();
  const { prisma } = app;

  let dbCounts: { tasks: number; usageLogs: number; agentSteps: number; evalRuns: number };
  try {
    dbCounts = {
      tasks: await prisma.task.count(),
      usageLogs: await prisma.usageLog.count(),
      agentSteps: await prisma.agentStep.count(),
      evalRuns: await prisma.evalRun.count(),
    };
  } catch (error) {
    throw new Error(
      `数据库不可用或未初始化：${errorMessage(error)}\n` +
        '请确认本地 PostgreSQL 16 已启动（127.0.0.1:5432）、.env.local 的 DATABASE_URL 正确，并先执行 `pnpm prisma:seed`。',
    );
  }

  const seed = await loadSeedContext(prisma);
  const datasetInfo = await ensureReportDataset(prisma, seed.userId);

  // ---- 指标快照：在任何本轮生成之前采集，保证口径是「历史真实数据」 ----
  const metrics = await collectMetrics(prisma as never, {
    windowDays: 30,
    now: startedAt,
  });

  // ---- tracing：报告脚本强制启用 jsonl，用于产生可展示的 trace 证据 ----
  const traceDir = path.resolve(ROOT, process.env.TRACE_DIR?.trim() || '.lumenote-data/traces');
  const obsConfig = initTracing({
    force: true,
    env: {
      ...process.env,
      OBSERVABILITY_ENABLED: 'true',
      // 报告必须有本地 trace 证据：不跟随用户可能设置的 none/otlp
      TRACE_EXPORT: 'jsonl',
      TRACE_DIR: traceDir,
    },
    warn: (message) => console.warn(message),
  });

  // ---- 1) MOCK 模式评测运行 ----
  console.log('\n[1/6] 用 MockProvider 生成评测输出并运行规则断言（enableJudge=false）…');
  const evalOutputs = await generateEvalOutputs(app, seed.agentVersion.id, datasetInfo.cases);
  const evalRun = await app.runEval({
    prisma: prisma as never,
    userId: seed.userId,
    datasetId: datasetInfo.datasetId,
    promptVersionId: seed.agentVersion.id,
    templateId: seed.agentTemplateId,
    // 用 mock: 前缀让评测记录自描述，避免被误读成真实模型成绩
    subjectModel: `mock:${MOCK_MODEL}`,
    cases: evalOutputs.inputs,
    enableJudge: false,
    judgeCredential: null,
  });

  // ---- 2) 失败样本回归集（纯断言自检，不依赖模型） ----
  console.log('[2/6] 运行失败样本回归集（8 缺陷 + 2 对照）…');
  const regressionRows = evaluateRegressionSamples();
  const regressionDefectDetected = regressionRows.filter(
    (row) => row.expectDetected && row.detected,
  ).length;
  const regressionControlPassed = regressionRows.filter(
    (row) => !row.expectDetected && row.matchedExpectation,
  ).length;

  // ---- 3) 真实 mock 摘要任务的 trace 证据 ----
  console.log('[3/6] 运行一次 mock 摘要任务以生成 taskId 可检索的 trace…');
  const summarizeTrace = await runSummarizeTrace(app, seed, traceDir);

  // ---- 4) 脚本化 Agent 链路 trace（仅验证 span 结构，不代表模型质量） ----
  console.log('[4/6] 运行脚本化 Agent 链路以展示 plan/tool/observe/finalize/evidence span…');
  const agentTrace = await runScriptedAgentTrace(app, seed.agentVersion.id, traceDir);

  // ---- 5) 汇总环境信息 ----
  const gitCommit = readGitCommit();
  const env = buildEnvironmentInfo(gitCommit, obsConfig.traceDir, seed, dbCounts, datasetInfo);

  // ---- 6) 生成报告 ----
  console.log('[5/6] 汇总环境/断言/延迟/成本/指标/trace…');
  const report = buildReportMarkdown({
    generatedAt: startedAt,
    env,
    evalRun,
    cases: evalOutputs.cases,
    latency: evalOutputs.latency,
    cost: evalOutputs.cost,
    metrics,
    regressionRows,
    regressionDefectDetected,
    regressionControlPassed,
    summarizeTrace,
    agentTrace,
    datasetFingerprint: datasetInfo.fingerprint,
    caseFingerprint: outputFingerprint(JSON.stringify(DEMO_CASES)),
  });

  console.log('[6/6] 写出 docs/eval-report.md 与 .eval-results/report.json…');
  mkdirSync(DOCS_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(REPORT_MD, report.markdown, 'utf8');

  const jsonPayload = {
    generatedAt: startedAt.toISOString(),
    mode: 'mock',
    warning: MOCK_QUOTA_NOTE,
    gitCommit,
    environment: env,
    eval: {
      runId: evalRun.runId,
      totalCases: evalRun.totalCases,
      passedCases: evalRun.passedCases,
      weightedScore: evalRun.weightedScore,
      totalCostUsd: evalRun.totalCostUsd,
      skippedJudgeAssertions: evalRun.skippedJudgeAssertions,
      skippedCases: evalRun.skippedCases ?? 0,
      judgeRan: false,
      baselineComparable: false,
      cases: evalOutputs.cases,
      latency: evalOutputs.latency,
      cost: evalOutputs.cost,
    },
    regression: {
      defectSamples: REGRESSION_DEFECT_SAMPLES.length,
      defectDetected: regressionDefectDetected,
      controlSamples: REGRESSION_CONTROL_SAMPLES.length,
      controlPassed: regressionControlPassed,
      rows: regressionRows,
    },
    metrics,
    traces: {
      summarize: summarizeTrace,
      scriptedAgent: agentTrace,
      config: obsConfig,
      traceDir,
    },
    knownLimitations: knownLimitations(),
  };
  writeFileSync(REPORT_JSON, `${JSON.stringify(jsonPayload, null, 2)}\n`, 'utf8');

  // ---- 控制台摘要 ----
  console.log('\n════════════════ 报告已生成 ════════════════');
  console.log(`  ⚠️  ${MOCK_QUOTA_NOTE}`);
  console.log(`  报告：${path.relative(ROOT, REPORT_MD)}`);
  console.log(`  机器可读：${path.relative(ROOT, REPORT_JSON)}`);
  console.log(
    `  规则断言：${evalRun.passedCases}/${evalRun.totalCases} 用例通过（加权 ${(evalRun.weightedScore * 100).toFixed(1)}%）`,
  );
  console.log(
    `  judge：未运行（剩余 ${evalRun.skippedJudgeAssertions} 条 judge 断言被跳过）`,
  );
  console.log(
    `  回归样本：缺陷检测 ${regressionDefectDetected}/${REGRESSION_DEFECT_SAMPLES.length}，对照通过 ${regressionControlPassed}/${REGRESSION_CONTROL_SAMPLES.length}`,
  );
  console.log(
    `  trace：摘要任务 ${summarizeTrace.spanCount} span（${summarizeTrace.traceId ?? '无 traceId'}），Agent 链路 ${agentTrace.spanCount} span`,
  );
  console.log(
    `  指标窗口：${metrics.window.label}（真实 DB 查询）`,
  );

  await prisma.$disconnect();
}

function banner(): void {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Lumenote 评测与可观测性报告（MOCK 模式）');
  console.log(`  ${MOCK_QUOTA_NOTE}`);
  console.log('═══════════════════════════════════════════════════════════');
}

// ============================================================
// 前置检查：环境 / DB / seed
// ============================================================

function assertEnvironment(): void {
  if (!process.env.DATABASE_URL) {
    throw new Error('缺少 DATABASE_URL。请先创建 .env.local（参考 .env.example）并启动本地 PostgreSQL。');
  }
  if (process.env.MOCK_LLM !== 'true') {
    throw new Error(
      '本报告只支持 MOCK 模式（MOCK_LLM=true）。当前 MOCK_LLM 不为 true —— 为了避免真实调用与费用，脚本拒绝继续。',
    );
  }
  if (process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY) {
    // 有 key 但 MOCK_LLM=true 时，管线仍走 MockProvider；这里只提示不会使用真实 key
    console.warn('[eval:report] 检测到 API Key，但 MOCK_LLM=true，本轮不会发起真实模型调用。');
  }
}

async function loadAppModules() {
  // 动态 import：确保 dotenv 已执行，src/lib/db.ts 才能拿到 DATABASE_URL
  const [db, orchestrator, pipelineRunner, chunk, mock, scripted, evidence, trajectory, evalRunner] =
    await Promise.all([
      import('../../src/lib/db'),
      import('../../src/lib/agent/orchestrator'),
      import('../../src/lib/pipeline/runner'),
      import('../../src/lib/pipeline/chunk'),
      import('../../src/lib/llm/mock'),
      import('../../src/lib/eval/scripted-provider'),
      import('../../src/lib/agent/evidence'),
      import('../../src/lib/agent/trajectory'),
      import('../../src/lib/eval/runner'),
    ]);

  return {
    prisma: db.prisma,
    runAgent: orchestrator.runAgent,
    runSummarizePipeline: pipelineRunner.runSummarizePipeline,
    chunkText: chunk.chunkText,
    MockProvider: mock.MockProvider,
    ScriptedAgentProvider: scripted.ScriptedAgentProvider,
    checkEvidence: evidence.checkEvidence,
    checkTrajectory: trajectory.checkTrajectory,
    runEval: evalRunner.runEval,
  };
}

async function loadSeedContext(prisma: Awaited<ReturnType<typeof loadAppModules>>['prisma']) {
  const user = await prisma.user.findUnique({
    where: { email: DEMO_EMAIL },
    select: { id: true, email: true },
  });
  if (!user) {
    throw new Error(`找不到演示用户 ${DEMO_EMAIL}。请先执行 \`pnpm prisma:seed\`（seed 是幂等的，可重复运行）。`);
  }

  const summarizeTemplate = await prisma.promptTemplate.findFirst({
    where: { slug: 'sys:summarize.long', isActive: true },
    include: { versions: { where: { status: 'active' }, orderBy: { version: 'desc' }, take: 1 } },
  });
  const agentTemplate = await prisma.promptTemplate.findFirst({
    where: { slug: 'sys:agent.docqa', isActive: true },
    include: { versions: { where: { status: 'active' }, orderBy: { version: 'desc' }, take: 1 } },
  });

  const summarizeVersion = summarizeTemplate?.versions[0];
  const agentVersion = agentTemplate?.versions[0];
  if (!summarizeTemplate || !summarizeVersion) {
    throw new Error('找不到 active 的摘要 Prompt 模板（sys:summarize.long）。请先执行 `pnpm prisma:seed`。');
  }
  if (!agentTemplate || !agentVersion) {
    throw new Error('找不到 active 的 Agent Prompt 模板（sys:agent.docqa）。请先执行 `pnpm prisma:seed`。');
  }

  return {
    userId: user.id,
    userEmail: user.email,
    summarizeTemplateId: summarizeTemplate.id,
    summarizeVersion,
    agentTemplateId: agentTemplate.id,
    agentVersion,
  };
}

async function ensureReportDataset(
  prisma: Awaited<ReturnType<typeof loadAppModules>>['prisma'],
  userId: string,
): Promise<{
  datasetId: string;
  createdCases: number;
  updatedCases: number;
  fingerprint: string;
  cases: { id: string; name: string }[];
}> {
  const dataset = await prisma.evalDataset.upsert({
    where: { userId_name: { userId, name: REPORT_DATASET_NAME } },
    update: {
      description: `${DEMO_DATASET.description}（eval:report mock 专用数据集：隔离 mock 运行，避免与真实模型运行基线混用）`,
      taskType: DEMO_DATASET.taskType,
    },
    create: {
      userId,
      name: REPORT_DATASET_NAME,
      description: `${DEMO_DATASET.description}（eval:report mock 专用数据集）`,
      taskType: DEMO_DATASET.taskType,
      defaultParams: DEMO_DATASET.defaultParams as never,
    },
  });

  // 清理上次异常中断留下的 running 运行记录（没有 results 的孤儿行）
  await prisma.evalRun
    .deleteMany({ where: { datasetId: dataset.id, status: 'running' } })
    .catch(() => undefined);

  let createdCases = 0;
  let updatedCases = 0;
  const cases: { id: string; name: string }[] = [];
  for (const evalCase of DEMO_CASES) {
    const existing = await prisma.evalCase.findFirst({
      where: { datasetId: dataset.id, name: evalCase.name },
    });
    const payload = {
      input: evalCase.input,
      params: (evalCase.params ?? {}) as never,
      expectations: evalCase.expectations as never,
      weight: evalCase.weight,
      isRegression: evalCase.isRegression ?? false,
      enabled: true,
    };
    if (existing) {
      await prisma.evalCase.update({ where: { id: existing.id }, data: payload });
      cases.push({ id: existing.id, name: evalCase.name });
      updatedCases += 1;
    } else {
      const created = await prisma.evalCase.create({
        data: { datasetId: dataset.id, name: evalCase.name, ...payload },
      });
      cases.push({ id: created.id, name: evalCase.name });
      createdCases += 1;
    }
  }

  return {
    datasetId: dataset.id,
    createdCases,
    updatedCases,
    fingerprint: outputFingerprint(JSON.stringify(DEMO_CASES)),
    cases,
  };
}

// ============================================================
// MOCK 模式评测
// ============================================================

async function generateEvalOutputs(
  app: Awaited<ReturnType<typeof loadAppModules>>,
  promptVersionId: string,
  dbCases: { id: string; name: string }[],
): Promise<{
  inputs: EvalCaseInput[];
  cases: CaseReport[];
  latency: ReturnType<typeof summarizeLatency>;
  cost: { totalUsd: number; totalCny: number; note: string; byCase: { name: string; inputTokens: number; outputTokens: number; costUsd: number }[] };
}> {
  const provider = new app.MockProvider();
  const inputs: EvalCaseInput[] = [];
  const cases: CaseReport[] = [];
  const latencies: number[] = [];
  const costByCase: { name: string; inputTokens: number; outputTokens: number; costUsd: number }[] = [];

  for (const [index, evalCase] of DEMO_CASES.entries()) {
    const dbCase = dbCases[index];
    if (!dbCase) {
      throw new Error(`报告数据集缺少用例「${evalCase.name}」，请检查 ensureReportDataset 的执行结果。`);
    }
    const params = (evalCase.params ?? {}) as Record<string, unknown>;
    const question = typeof params.question === 'string' ? params.question : evalCase.name;
    const taskId = `eval-report-eval-case-${index + 1}`;

    const startedAt = Date.now();
    const result = await app.runAgent({
      provider,
      model: MOCK_MODEL,
      question,
      chunks: app.chunkText(evalCase.input),
      toolContext: { glossary: [], loadTaskOutput: async () => null },
      budget: { maxSteps: 8, maxTokens: 40_000 },
      thinking: 'disabled',
      temperature: 0.2,
      taskId,
      promptVersionId,
    });
    const latencyMs = Date.now() - startedAt;
    latencies.push(latencyMs);

    const evidence = app.checkEvidence(result.structured, result.finalChunks);
    const trajectory = app.checkTrajectory(result, { maxSteps: 8 });
    const trace: AgentTraceSummary = {
      usedTools: trajectory.usedTools,
      hasLoop: trajectory.hasLoop,
      totalSteps: trajectory.totalSteps,
      evidenceRate: evidence.rate,
      unsupportedConclusions: trajectory.unsupportedConclusions,
    };

    const { costUsd } = computeCostUsd({
      model: MOCK_MODEL,
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
    });
    const roundedCost = Number(costUsd.toFixed(6));
    costByCase.push({
      name: evalCase.name,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: roundedCost,
    });

    // 逐条断言结果（仅用于报告展示；落库由 runEval 统一负责）
    const assertionResults: AssertionResult[] = evalCase.expectations.map((assertion: EvalAssertion) =>
      assertion.kind === 'judge'
        ? {
            kind: 'judge',
            passed: false,
            skipped: true,
            skippedReason: 'judge 未运行（无 API Key / 避免费用）',
            reason: 'judge 未运行（无 API Key / 避免费用）',
            weight: assertion.weight ?? 1,
            ...(assertion.description ? { description: assertion.description } : {}),
          }
        : evaluateRuleAssertion(assertion, result.text, trace),
    );
    const scored = scoreCase(assertionResults);
    const failures = assertionResults
      .filter((assertion) => !assertion.skipped && !assertion.passed)
      .map((assertion) => ({ kind: assertion.kind, reason: assertion.reason }));

    cases.push({
      caseId: dbCase.id,
      caseName: evalCase.name,
      weight: evalCase.weight,
      isRegression: evalCase.isRegression ?? false,
      status: !scored.evaluated ? 'skipped' : scored.passed ? 'passed' : 'failed',
      passed: scored.passed,
      evaluated: scored.evaluated,
      score: scored.score,
      passedCount: scored.passedCount,
      totalCount: scored.totalCount,
      skippedCount: scored.skippedCount,
      latencyMs,
      costUsd: roundedCost,
      outputFingerprint: outputFingerprint(result.text),
      failures,
    });

    inputs.push({
      caseId: dbCase.id,
      caseName: evalCase.name,
      weight: evalCase.weight,
      isRegression: evalCase.isRegression ?? false,
      expectations: evalCase.expectations,
      material: evalCase.input,
      question,
      output: result.text,
      trace,
      costUsd: roundedCost,
      latencyMs,
    });

    console.log(
      `      [${index + 1}/${DEMO_CASES.length}] ${evalCase.name} → ${scored.passed ? '规则通过' : '规则失败'} ` +
        `(${scored.passedCount}/${scored.totalCount}, ${latencyMs}ms)`,
    );
  }

  const totalUsd = Number(costByCase.reduce((sum, item) => sum + item.costUsd, 0).toFixed(6));
  return {
    inputs,
    cases,
    latency: summarizeLatency(latencies),
    cost: {
      totalUsd,
      totalCny: Number((totalUsd * 7.2).toFixed(4)),
      note: '按 pricing.ts 的单价 × 峰谷 × 缓存分档估算；MockProvider 的 token 由估算器产生，**不代表真实成本**',
      byCase: costByCase,
    },
  };
}

// ============================================================
// 失败样本回归集
// ============================================================

function evaluateRegressionSamples(): RegressionReportRow[] {
  const rows: RegressionReportRow[] = [];
  for (const sample of [...REGRESSION_DEFECT_SAMPLES, ...REGRESSION_CONTROL_SAMPLES]) {
    rows.push(evaluateRegressionSample(sample));
  }
  return rows;
}

function evaluateRegressionSample(sample: RegressionSample): RegressionReportRow {
  const results = sample.assertions.map((assertion) =>
    evaluateRuleAssertion(assertion, sample.output, sample.trace ?? null),
  );
  const scored = scoreCase(results);
  const failedAssertions = results
    .filter((assertion) => !assertion.skipped && !assertion.passed)
    .map((assertion) => ({ kind: assertion.kind, reason: assertion.reason }));
  const detected = failedAssertions.length > 0;
  const matchedExpectation = sample.expectDetected ? detected : scored.evaluated && scored.passed;

  return {
    id: sample.id,
    name: sample.name,
    defectType: sample.defectType,
    expectDetected: sample.expectDetected,
    detected,
    matchedExpectation,
    passedCount: scored.passedCount,
    totalCount: scored.totalCount,
    score: scored.score,
    failedAssertions,
  };
}

// ============================================================
// Trace 证据
// ============================================================

async function runSummarizeTrace(
  app: Awaited<ReturnType<typeof loadAppModules>>,
  seed: Awaited<ReturnType<typeof loadSeedContext>>,
  traceDir: string,
): Promise<TraceReport> {
  const { prisma } = app;
  // 多分块输入：保证 Map/Reduce 两条路径都出现在 trace 里（单块会短路成一次 reduce）
  const longInput = Array.from({ length: 8 }, () => EVAL_DOCUMENT).join('\n\n');
  const params = { style: '要点式', maxPoints: '5', targetReader: '普通读者' };

  const existing = await prisma.task.findFirst({
    where: {
      userId: seed.userId,
      type: 'summarize',
      title: { startsWith: REPORT_TASK_TITLE_PREFIX },
    },
    orderBy: { createdAt: 'asc' },
  });

  /**
   * 复用而不是「每次新建」：报告任务不应随运行次数增长。
   * 但直接复用会撞 `UsageLog.taskId` 唯一约束（一个任务只结算一次），
   * 导致每次重跑都在 metering 里触发一次 P2002（虽被吞掉但会打 error 日志）。
   * 所以这里先删旧任务及其计量记录，再创建一条新任务 —— 结果仍是「DB 里只有一条报告任务」。
   */
  if (existing) {
    await prisma.usageLog.deleteMany({ where: { taskId: existing.id } }).catch(() => undefined);
    await prisma.task.delete({ where: { id: existing.id } }).catch(() => undefined);
  }

  const task = await prisma.task.create({
    data: {
      userId: seed.userId,
      type: 'summarize',
      title: `${REPORT_TASK_TITLE_PREFIX} 摘要 trace 证据（mock）`,
      status: 'queued',
      inputType: 'text',
      inputContent: longInput,
      templateId: seed.summarizeTemplateId,
      promptVersionId: seed.summarizeVersion.id,
      params: params as never,
    },
  });

  let pipelineError: string | null = null;
  const startedAt = Date.now();
  try {
    await app.runSummarizePipeline({ taskId: task.id });
  } catch (error) {
    pipelineError = errorMessage(error);
  }
  const wallMs = Date.now() - startedAt;
  await flushTracing();

  const taskRow = await prisma.task.findUnique({
    where: { id: task.id },
    select: { status: true, latencyMs: true, outputContent: true, outputMeta: true },
  });

  const read = readSpansForTask(task.id, { dir: traceDir });
  const latest = pickLatestTrace(read.spans);
  if (!latest) {
    return {
      taskId: task.id,
      traceId: null,
      spanCount: 0,
      durationMs: 0,
      spanNameCounts: {},
      treeText: '（未找到该 taskId 的 trace；检查 OBSERVABILITY/TRACE_EXPORT 配置与 TRACE_DIR）',
      spans: [],
      note: pipelineError
        ? `摘要任务执行失败：${pipelineError}`
        : '未在 JSONL 中找到该 taskId 的 span',
    };
  }

  const summary = summarizeTrace(latest.spans, read.badLines);
  return {
    taskId: task.id,
    traceId: latest.traceId,
    spanCount: summary.spanCount,
    durationMs: summary.durationMs,
    spanNameCounts: summary.byName,
    treeText: formatSpanTree(latest.spans, { rootLabel: `(traceId=${latest.traceId})` }),
    spans: describeSpans(latest.spans),
    note:
      `任务状态=${taskRow?.status ?? 'unknown'}，DB latencyMs=${taskRow?.latencyMs ?? '-'}，` +
      `流水线墙钟耗时=${wallMs}ms；同一 taskId 在 JSONL 中匹配到 ${latest.multiple} 条 trace（展示最新一条）。` +
      (pipelineError ? ` 执行异常：${pipelineError}` : ''),
  };
}

async function runScriptedAgentTrace(
  app: Awaited<ReturnType<typeof loadAppModules>>,
  promptVersionId: string,
  traceDir: string,
): Promise<TraceReport> {
  const provider = new app.ScriptedAgentProvider({ conclusionText: STRUCTURED_AGENT_QUOTE });
  const startedAt = Date.now();
  const result = await app.runAgent({
    provider,
    model: MOCK_MODEL,
    question: '缓存命中率为什么是最重要的成本杠杆？',
    chunks: app.chunkText(EVAL_DOCUMENT),
    toolContext: { glossary: [], loadTaskOutput: async () => null },
    budget: { maxSteps: 4, maxTokens: 20_000 },
    thinking: 'disabled',
    taskId: AGENT_TRACE_TASK_ID,
    promptVersionId,
  });
  const wallMs = Date.now() - startedAt;
  await flushTracing();

  const read = readSpansForTask(AGENT_TRACE_TASK_ID, { dir: traceDir });
  const latest = pickLatestTrace(read.spans);
  if (!latest) {
    return {
      taskId: AGENT_TRACE_TASK_ID,
      traceId: null,
      spanCount: 0,
      durationMs: 0,
      spanNameCounts: {},
      treeText: '（未找到 Agent 链路 trace）',
      spans: [],
      note: '脚本化 Agent 链路未产生 span',
    };
  }

  const summary = summarizeTrace(latest.spans, read.badLines);
  return {
    taskId: AGENT_TRACE_TASK_ID,
    traceId: latest.traceId,
    spanCount: summary.spanCount,
    durationMs: summary.durationMs,
    spanNameCounts: summary.byName,
    treeText: formatSpanTree(latest.spans),
    spans: describeSpans(latest.spans),
    note:
      `脚本化 Provider（固定剧本，仅验证 trace 结构）：status=${result.status}，` +
      `steps=${result.steps.length}，证据链完整率=${(latest.spans.find((span) => span.name === 'agent.evidence_check')?.attributes.rate ?? 0)}；` +
      `墙钟耗时=${wallMs}ms。同一 taskId 匹配到 ${latest.multiple} 条 trace（展示最新一条）。` +
      '⚠️ 该链路不代表真实模型质量。',
  };
}

function describeSpans(spans: TraceSpanRecord[]): TraceReport['spans'] {
  const nameById = new Map(spans.map((span) => [span.spanId, span.name]));
  // 按开始时间排序：根 span 最先开始，表格读起来与树一致
  return [...spans]
    .sort((a, b) => (Date.parse(a.startTime) || 0) - (Date.parse(b.startTime) || 0))
    .map((span) => ({
      name: span.name,
      parentName: span.parentSpanId ? (nameById.get(span.parentSpanId) ?? '(外部父 span)') : null,
      durationMs: span.durationMs,
      attributes: span.attributes,
    }));
}

/** 同一 taskId 可能因重复运行在多天/同一天文件里出现多条 trace，取最新一条 */
function pickLatestTrace(spans: TraceSpanRecord[]): { spans: TraceSpanRecord[]; traceId: string; multiple: number } | null {
  if (spans.length === 0) return null;
  const groups = new Map<string, TraceSpanRecord[]>();
  for (const span of spans) {
    const group = groups.get(span.traceId) ?? [];
    group.push(span);
    groups.set(span.traceId, group);
  }
  let best: TraceSpanRecord[] = [];
  let bestEnd = Number.NEGATIVE_INFINITY;
  for (const group of groups.values()) {
    const end = Math.max(...group.map((span) => Date.parse(span.endTime) || 0));
    if (end > bestEnd) {
      bestEnd = end;
      best = group;
    }
  }
  return { spans: best, traceId: best[0]!.traceId, multiple: groups.size };
}

// ============================================================
// 环境信息
// ============================================================

function readGitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function readPackageManager(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      packageManager?: string;
      version?: string;
    };
    return pkg.packageManager ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function buildEnvironmentInfo(
  gitCommit: string,
  traceDir: string,
  seed: Awaited<ReturnType<typeof loadSeedContext>>,
  dbCounts: { tasks: number; usageLogs: number; agentSteps: number; evalRuns: number },
  datasetInfo: { datasetId: string; fingerprint: string },
) {
  return {
    gitCommit,
    node: process.version,
    packageManager: readPackageManager(),
    mode: 'mock',
    mockLlm: process.env.MOCK_LLM === 'true',
    subjectModel: `mock:${MOCK_MODEL}`,
    pricingModel: MOCK_MODEL,
    demoUser: seed.userEmail,
    summarizePrompt: {
      templateId: seed.summarizeTemplateId,
      promptVersionId: seed.summarizeVersion.id,
      version: seed.summarizeVersion.version,
    },
    agentPrompt: {
      templateId: seed.agentTemplateId,
      promptVersionId: seed.agentVersion.id,
      version: seed.agentVersion.version,
    },
    dataset: {
      name: REPORT_DATASET_NAME,
      datasetId: datasetInfo.datasetId,
      // EvalDataset 表没有 version 字段，用内容指纹作为可比较的「版本」
      casesContentFingerprint: datasetInfo.fingerprint,
      caseCount: DEMO_CASES.length,
    },
    traceDir: path.relative(ROOT, traceDir).replaceAll('\\', '/') || '.',
    dbCounts,
  };
}

// ============================================================
// Markdown 报告
// ============================================================

function buildReportMarkdown(input: {
  generatedAt: Date;
  env: ReturnType<typeof buildEnvironmentInfo>;
  evalRun: {
    runId: string;
    totalCases: number;
    passedCases: number;
    weightedScore: number;
    totalCostUsd: number;
    skippedJudgeAssertions: number;
    skippedCases?: number;
    report?: RegressionReport | null;
  };
  cases: CaseReport[];
  latency: ReturnType<typeof summarizeLatency>;
  cost: { totalUsd: number; totalCny: number; note: string; byCase: { name: string; inputTokens: number; outputTokens: number; costUsd: number }[] };
  metrics: ObservabilitySnapshot;
  regressionRows: RegressionReportRow[];
  regressionDefectDetected: number;
  regressionControlPassed: number;
  summarizeTrace: TraceReport;
  agentTrace: TraceReport;
  datasetFingerprint: string;
  caseFingerprint: string;
}): { markdown: string } {
  const {
    generatedAt,
    env,
    evalRun,
    cases,
    latency,
    cost,
    metrics,
    regressionRows,
    regressionDefectDetected,
    regressionControlPassed,
    summarizeTrace,
    agentTrace,
  } = input;

  const lines: string[] = [];
  const push = (...items: string[]): void => {
    lines.push(...items);
  };

  push(
    '# Lumenote 评测与可观测性报告',
    '',
    `> ⚠️ **MOCK 模式**：本报告由 \`pnpm eval:report\` 生成，**未调用任何真实模型、未产生 API 费用**。`,
    '> 报告中的通过率 / 延迟 / 成本只用于验证**流程、断言与计价口径**，**不代表真实模型质量**。',
    '> 真实模型评测：**未运行**（无可用 API Key，且明确避免产生费用）。',
    '',
    `- 生成时间：${formatDateTime(generatedAt)}`,
    `- git commit：\`${env.gitCommit}\``,
    `- 被测对象：\`${env.subjectModel}\`（MockProvider，未联网）`,
    `- 数据集：${env.dataset.name}（${env.dataset.caseCount} 条用例，内容指纹 \`${env.dataset.casesContentFingerprint}\`）`,
    `- 命令：\`pnpm eval:report\`（幂等：数据集/用例 upsert、报告任务恒定一条、评测运行历史 append-only）`,
    '',
  );

  // ---------------------------------------------------------
  push('## 1. 环境与版本', '', '| 项目 | 值 |', '| --- | --- |');
  push(
    `| 运行模式 | ${env.mode}（MOCK_LLM=${env.mockLlm}） |`,
    `| 被测模型 | ${env.subjectModel} |`,
    `| 计价参考模型 | ${env.pricingModel}（pricing.ts 单价表） |`,
    `| Node / 包管理器 | ${env.node} / ${env.packageManager} |`,
    `| git commit | \`${env.gitCommit}\` |`,
    `| 演示用户 | ${env.demoUser} |`,
    `| 摘要 Prompt 版本 | \`${env.summarizePrompt.promptVersionId}\`（v${env.summarizePrompt.version}，模板 \`${env.summarizePrompt.templateId}\`） |`,
    `| Agent Prompt 版本 | \`${env.agentPrompt.promptVersionId}\`（v${env.agentPrompt.version}，模板 \`${env.agentPrompt.templateId}\`） |`,
    `| 数据集 | ${env.dataset.name}（id \`${env.dataset.datasetId}\`，指纹 \`${env.dataset.casesContentFingerprint}\`） |`,
    `| trace 目录 | \`${env.traceDir}\` |`,
    `| 数据库规模（采集时） | Task ${env.dbCounts.tasks} / UsageLog ${env.dbCounts.usageLogs} / AgentStep ${env.dbCounts.agentSteps} / EvalRun ${env.dbCounts.evalRuns} |`,
    '',
    'Prompt 模板版本与数据集均从**真实数据库**读取；数据集表没有 version 字段，因此用「用例内容指纹」作为可比较的版本标识。',
    '',
  );

  // ---------------------------------------------------------
  push(
    '## 2. 规则断言通过率（MOCK 驱动）',
    '',
    `⚠️ MockProvider 的输出是一段**固定占位摘要**（不调用模型）。因此要求「包含 50 倍 / 输出 JSON / 使用 search_chunks」的规则断言**必然失败** ——`,
    '这不是模型质量问题，恰恰证明断言会拒绝“不是答案的输出”。真实模型下的通过率需在有 Key 的环境重跑，本轮未运行。',
    '',
    `- 评测运行 id：\`${evalRun.runId}\``,
    `- 规则断言结果：**${evalRun.passedCases}/${evalRun.totalCases} 用例通过**（加权通过率 ${(evalRun.weightedScore * 100).toFixed(2)}%）`,
    `- judge：**未运行**（\`enableJudge=false\`；无 API Key / 避免费用），本轮跳过 ${evalRun.skippedJudgeAssertions} 条 judge 断言`,
    '',
    '| 用例 | 权重 | 状态 | 通过断言 | 得分 | 耗时 | 失败原因（摘要） |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const caseReport of cases) {
    const failureText =
      caseReport.failures.length === 0
        ? '—'
        : caseReport.failures.map((failure) => `${failure.kind}: ${failure.reason}`).join('；');
    push(
      `| ${escapeCell(caseReport.caseName)} | ${caseReport.weight} | ${caseReport.status} | ${caseReport.passedCount}/${caseReport.totalCount}（跳过 ${caseReport.skippedCount}） | ${caseReport.score.toFixed(2)} | ${caseReport.latencyMs}ms | ${escapeCell(failureText)} |`,
    );
  }
  push(
    '',
    '> 说明：judge 断言被标记为 **skipped（未评估）** 而不是 failed —— 没运行不等于模型没通过，两者混在一起会产生假回归。',
    '',
  );

  if (evalRun.report) {
    const baseline = evalRun.report;
    push(
      '### 与基线的对比（仅演示回归报告机制，不做质量结论）',
      '',
      `- 基线运行：\`${baseline.baselineRunId}\`（${baseline.baselineCreatedAt}）`,
      `- 结论：**${baseline.verdict.level.toUpperCase()}** —— ${baseline.verdict.headline}`,
      `- 通过率：${(baseline.summary.beforeRate * 100).toFixed(1)}% → ${(baseline.summary.afterRate * 100).toFixed(1)}%（加权 ${(baseline.summary.beforeWeighted * 100).toFixed(1)}% → ${(baseline.summary.afterWeighted * 100).toFixed(1)}%）`,
      `- 平均得分：${baseline.summary.beforeAvgScore.toFixed(3)} → ${baseline.summary.afterAvgScore.toFixed(3)}`,
      '',
      '> 基线是同一「mock 专用数据集」的上一次运行（同样为 mock）。mock 与真实模型运行不可比，',
      '> 这里的对比只用于证明回归报告链路（基线选择/差异分组/结论生成）可用。',
      '',
    );
  } else {
    push('> 本轮没有可对比的基线运行（该数据集首次运行），因此不展示回归对比。', '');
  }

  // ---------------------------------------------------------
  push(
    '## 3. 延迟与成本（MOCK 实测 / 按 token 估算）',
    '',
    '延迟是**本轮真实测量的墙钟时间**（MockProvider 有模拟延时，因此不是零）；成本是 `pricing.ts` 计价逻辑的**估算值**。',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 生成样本数 | ${latency.count} |`,
    `| p50 延迟 | ${latency.p50}ms |`,
    `| p95 延迟 | ${latency.p95}ms |`,
    `| 平均延迟 | ${latency.avg}ms |`,
    `| token 估算总成本 | $${cost.totalUsd.toFixed(6)} ≈ ¥${cost.totalCny.toFixed(4)} |`,
    '',
    '| 用例 | 输入 token（估） | 输出 token（估） | 成本（估，USD） |',
    '| --- | --- | --- | --- |',
  );
  for (const item of cost.byCase) {
    push(
      `| ${escapeCell(item.name)} | ${item.inputTokens} | ${item.outputTokens} | $${item.costUsd.toFixed(6)} |`,
    );
  }
  push(
    '',
    `> ${cost.note}。真实 API 费用为 **0**（未发起调用）。样本量 ${latency.count} 条，p95 仅用于展示口径，不具备统计意义。`,
    '',
  );

  // ---------------------------------------------------------
  push(
    '## 4. 指标聚合（真实数据库查询）',
    '',
    `- 时间窗口：**${metrics.window.label}**`,
    '- 每个指标均在表中标注数据来源与口径；数字全部来自对本地数据库的真实查询，不是写死的常量。',
    '',
    '### 4.1 端到端延迟（Task）',
    '',
    '| 维度 | 样本数 | p50 | p95 | 平均 | 最小 | 最大 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| 全部成功任务 | ${metrics.latency.sample} | ${metrics.latency.all.p50}ms | ${metrics.latency.all.p95}ms | ${metrics.latency.all.avg}ms | ${metrics.latency.all.min}ms | ${metrics.latency.all.max}ms |`,
  );
  for (const [type, summary] of Object.entries(metrics.latency.byType)) {
    push(
      `| type=${type} | ${summary.count} | ${summary.p50}ms | ${summary.p95}ms | ${summary.avg}ms | ${summary.min}ms | ${summary.max}ms |`,
    );
  }
  push(
    '',
    `> 来源：${metrics.sources.latency}；口径：${metrics.definitions.latency}。`,
    '',
    '### 4.2 LLM 调用次数（两个口径，不要混用）',
    '',
    '| 指标 | 值 | 数据来源 | 口径 |',
    '| --- | --- | --- | --- |',
    `| 任务级计量记录数 | ${metrics.llm.meteredRecords} | ${esc(metrics.sources.llmCalls)} | ${esc(metrics.definitions.llmCalls)} |`,
    `| Agent 模型调用次数 | ${metrics.llm.agentModelCalls} | ${esc(metrics.sources.agentCalls)} | ${esc(metrics.definitions.agentCalls)} |`,
    `| 其中失败计量记录 | ${metrics.llm.failedRecords} | ${esc(metrics.sources.llmCalls)} | success=false 的行数 |`,
    '',
    '### 4.3 token 与成本（按模型）',
    '',
    '| 模型 | 记录数 | 输入 token | 输出 token | 缓存命中 token | 成本（USD） | 成本（CNY 展示） |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const row of metrics.tokens.byModel) {
    push(
      `| ${escapeCell(row.model)} | ${row.records} | ${row.promptTokens} | ${row.completionTokens} | ${row.cachedTokens} | $${row.costUsd.toFixed(6)} | ¥${row.costCny.toFixed(4)} |`,
    );
  }
  push(
    `| **合计** | ${metrics.llm.meteredRecords} | ${metrics.tokens.promptTokens} | ${metrics.tokens.completionTokens} | ${metrics.tokens.cachedTokens} | $${metrics.tokens.totalCostUsd.toFixed(6)} | ¥${metrics.tokens.totalCostCny.toFixed(4)} |`,
    '',
    `> 来源：${metrics.sources.tokens} / ${metrics.sources.cost}；口径：${metrics.definitions.tokens}。`,
    `> ⚠️ \`UsageLog.estimatedCost\` 在代码中存的是**美元**（见 \`src/lib/llm/metering.ts\`），与 schema 注释「人民币元」不一致；本报告以代码为准，并在展示层按 7.2 换算人民币。`,
    `> 缓存命中率：${(metrics.tokens.cacheHitRate * 100).toFixed(1)}%（cachedTokens / promptTokens）。`,
    '',
    '### 4.4 工具调用次数与失败率',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 工具调用总数 | ${metrics.tools.totalCalls} |`,
    `| 实际执行数 | ${metrics.tools.executedCalls} |`,
    `| 执行失败数 | ${metrics.tools.executionFailures} |`,
    `| 执行失败率 | ${(metrics.tools.executionFailureRate * 100).toFixed(2)}% |`,
    `| 被 Agent 护栏拦截（额度/重复/未知工具） | ${metrics.tools.guardrailRejected}（**不计入失败率**） |`,
    '',
  );
  const toolNames = Object.keys(metrics.tools.byTool).sort();
  if (toolNames.length > 0) {
    push('| 工具 | 调用次数 | 失败次数 |', '| --- | --- | --- |');
    for (const name of toolNames) {
      push(`| ${escapeCell(name)} | ${metrics.tools.byTool[name]!.calls} | ${metrics.tools.byTool[name]!.failures} |`);
    }
    push('');
  }
  push(`> 来源：${metrics.sources.tools}；口径：${metrics.definitions.tools}。`, '');

  push(
    '### 4.5 证据完整率（结构口径）',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 有结构化输出的 Agent 任务 | ${metrics.evidence.tasksWithStructured} |`,
    `| 无结构化输出的 Agent 任务 | ${metrics.evidence.tasksWithoutStructured} |`,
    `| 结论总数 / 其中带证据 | ${metrics.evidence.conclusions} / ${metrics.evidence.conclusionsWithEvidence} |`,
    `| 证据条目总数 | ${metrics.evidence.evidenceItems} |`,
    `| 无依据结论数 | ${metrics.evidence.unsupportedConclusions} |`,
    `| 结构化证据覆盖率 | ${(metrics.evidence.evidenceCoverageRate * 100).toFixed(2)}% |`,
    '',
    `> 来源：${metrics.sources.evidence}；口径：${metrics.definitions.evidence}。`,
    '> 更严格的「引文能否在原文中找到」由 `checkEvidence()` 在运行时校验，DB 未保存分块全文，无法离线重算。',
    '',
    '### 4.6 任务失败率与超时率',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 窗口内任务总数 | ${metrics.outcomes.total} |`,
    `| succeeded / failed / canceled | ${metrics.outcomes.succeeded} / ${metrics.outcomes.failed} / ${metrics.outcomes.canceled} |`,
    `| 仍在 running/queued | ${metrics.outcomes.inFlight} |`,
    `| 显式超时（errorCode=TIMEOUT） | ${metrics.outcomes.explicitTimeouts} |`,
    `| 卡死超阈值（running/queued 超过 15 分钟） | ${metrics.outcomes.stuckOverThreshold} |`,
    `| 失败率 | ${(metrics.outcomes.failureRate * 100).toFixed(2)}% |`,
    `| 超时率 | ${(metrics.outcomes.timeoutRate * 100).toFixed(2)}% |`,
    '',
    `> 来源：${metrics.sources.outcomes}；口径：${metrics.definitions.timeout}。`,
    '> 两个超时口径缺一不可：只看 errorCode 会漏掉「进程崩溃导致任务永远 running」；只看状态会把正常执行中的任务误判为超时。',
    '> ⚠️ 本地 seed 数据的任务全部为 succeeded，因此本窗口的失败率/超时率为 0；这两个指标的判定逻辑由单测覆盖（含构造的 running 超阈值 / 显式 TIMEOUT 场景）。',
    '> 状态分布：' + formatRecord(metrics.outcomes.statusBreakdown) + '；错误码分布：' + formatRecord(metrics.outcomes.errorCodeBreakdown),
    '',
  );

  // ---------------------------------------------------------
  push(
    '## 5. 失败样本回归集（断言自检）',
    '',
    '为了证明断言**有区分力**，构造 8 条「故意有缺陷的输出 + 对应断言」；另加 2 条良样本做对照（断言不应误伤）。',
    `- 缺陷检测率：**${regressionDefectDetected}/${REGRESSION_DEFECT_SAMPLES.length}**`,
    `- 对照组通过：**${regressionControlPassed}/${REGRESSION_CONTROL_SAMPLES.length}**`,
    '',
    '| 样本 | 缺陷类型 | 期望 | 断言结果 | 检测到？ | 失败断言 / 说明 |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const row of regressionRows) {
    const expectation = row.expectDetected ? '检测到缺陷' : '应通过';
    const assertionResult = `${row.passedCount}/${row.totalCount} 通过（得分 ${row.score.toFixed(2)}）`;
    const detail =
      row.failedAssertions.length > 0
        ? row.failedAssertions.map((failure) => `${failure.kind}: ${failure.reason}`).join('；')
        : '全部断言通过';
    const mark = row.matchedExpectation ? '✅' : '❌';
    push(
      `| ${escapeCell(row.name)} | ${escapeCell(row.defectType)} | ${expectation} | ${assertionResult} | ${mark} ${row.detected ? '是' : '否'} | ${escapeCell(detail)} |`,
    );
  }
  push(
    '',
    '> 这些样本只在报告脚本里评测，不写入 `EvalCase` 表（避免污染真实评测用例）。',
    '',
  );

  // ---------------------------------------------------------
  push(
    '## 6. Trace 证据（taskId 贯穿）',
    '',
    'tracing 由 `src/instrumentation.ts` 在应用启动时初始化；本报告脚本同样初始化 jsonl exporter，把 span 写到：',
    `\`${env.traceDir}/<UTC 日期>.jsonl\`（每行一个 span，已 gitignore）。`,
    '',
    '所有 span 都带 `taskId` 属性，同一任务的所有 span 共享同一 `traceId`；',
    '因此可以直接 `grep \'"taskId":"<任务 id>"\' .lumenote-data/traces/*.jsonl` 检索一次任务的完整链路。',
    '',
    '### 6.1 一次真实 mock 摘要任务（Map-Reduce 链路）',
    '',
    `- taskId：\`${summarizeTrace.taskId}\``,
    `- traceId：\`${summarizeTrace.traceId ?? '（无）'}\``,
    `- span 数：${summarizeTrace.spanCount}；根 span 耗时：${summarizeTrace.durationMs.toFixed(1)}ms`,
    `- span 分布：${formatRecord(summarizeTrace.spanNameCounts)}`,
    `- ${summarizeTrace.note}`,
    '',
    '```text',
    summarizeTrace.treeText,
    '```',
    '',
    '| span | 父 span | 耗时 | 关键属性 |',
    '| --- | --- | --- | --- |',
  );
  for (const span of summarizeTrace.spans) {
    push(
      `| ${escapeCell(span.name)} | ${escapeCell(span.parentName ?? '—（根）')} | ${Number(span.durationMs).toFixed(1)}ms | ${escapeCell(formatSpanAttributes(span.attributes))} |`,
    );
  }
  push(
    '',
    '### 6.2 Agent 完整链路（脚本化 Provider，仅验证 span 结构）',
    '',
    `- taskId：\`${agentTrace.taskId}\``,
    `- traceId：\`${agentTrace.traceId ?? '（无）'}\``,
    `- span 数：${agentTrace.spanCount}；根 span 耗时：${agentTrace.durationMs.toFixed(1)}ms`,
    `- span 分布：${formatRecord(agentTrace.spanNameCounts)}`,
    `- ${agentTrace.note}`,
    '',
    '```text',
    agentTrace.treeText,
    '```',
    '',
    '**脱敏策略**：span 不记录 API Key、完整 prompt / 文档正文或模型输出正文；',
    '只记录长度与哈希（如 `toolArgsHash` / `toolArgsLength`）、token 数、耗时、状态码。',
    '导出前还有两层防御：属性键黑名单（`apiKey` / `prompt` / `content` 等 → `[redacted]` / `[omitted]`）、',
    '值级兜底（`sk-...` / `Bearer ...` → `[redacted]`）与 200 字符截断。实现见 `src/lib/observability/sanitize.ts`。',
    '',
    '**接入点**（最小侵入，只加 span，不改业务逻辑）：',
    '`src/instrumentation.ts`（初始化）、`src/lib/pipeline/runner.ts`（task.pipeline / task.persist）、',
    '`src/lib/pipeline/lifecycle.ts`（task.lifecycle）、`src/lib/pipeline/map-reduce.ts`（llm.request map/reduce）、',
    '`src/lib/agent/orchestrator.ts`（agent.plan / agent.observe / agent.finalize / agent.evidence_check + llm.request）、',
    '`src/lib/agent/tool-dispatch.ts`（agent.tool）、`src/lib/agent/runner.ts`（Agent 任务根 span task.pipeline + task.persist）。',
    '',
  );

  // ---------------------------------------------------------
  push('## 7. 已知限制与未运行项', '');
  for (const limitation of knownLimitations()) {
    push(`- ${limitation}`);
  }
  push(
    '',
    '## 附：如何复现',
    '',
    '```bash',
    '# 前提：本地 PostgreSQL 16 已启动、数据库已 seed（脚本会自检并给出明确报错）',
    'pnpm prisma:seed          # 幂等；演示用户 / 模板 / 用例 / 演示任务',
    'MOCK_LLM=true pnpm eval:report   # 生成 docs/eval-report.md 与 .eval-results/report.json',
    'pnpm typecheck && pnpm lint && pnpm test && pnpm build',
    '```',
    '',
    '> 报告由脚本覆盖式生成；`.eval-results/` 与 `.lumenote-data/traces/*.jsonl` 已在 `.gitignore` 中，不会入库。',
    '',
    `<!-- report-fingerprint: ${input.datasetFingerprint}-${input.caseFingerprint}-${env.gitCommit} -->`,
    '',
  );

  return { markdown: `${lines.join('\n')}\n` };
}

function knownLimitations(): string[] {
  return [
    '**真实模型评测未运行**：环境无可用 API Key，且明确避免产生费用。报告中的通过率/延迟/成本均为 MOCK 口径，不能当作模型效果结论。',
    '**judge 未运行**：`enableJudge=false`，judge 断言全部标记为 skipped；LLM-as-judge 的一致性校准（人工标注）也未在本轮执行。',
    '**成本为估算**：MockProvider 的 token 由估算器产生，成本按 `pricing.ts` 单价的逻辑计算，不代表真实账单；真实费用为 0。',
    '**延迟样本很小**：本轮只有 4 条 mock 用例；p95 仅用于展示统计口径。真实延迟请参考第 4.1 节的 DB 历史数据（窗口见上）。',
    '**指标包含历史 mock / seed 数据**：本地数据库中的 Task / UsageLog 含 seed 与历史 mock 运行记录，成本与调用次数不代表生产流量。',
    '**UsageLog.estimatedCost 单位**：代码中存美元（`src/lib/llm/metering.ts`），schema 注释写「人民币元」是陈旧注释；已在报告中按代码为准处理，建议后续修正注释。',
    '**OTLP 导出未验证**：本环境没有 OTel Collector，`TRACE_EXPORT=otlp` 仅做了「缺 endpoint 时降级 jsonl」的配置单测，端到端未验证。',
    '**Agent 根 span 接入**：`src/lib/agent/runner.ts` 不在原定 tracing 文件清单内，经 Lead 批准后做了 ≤20 行的纯 tracing 接入（根 span + task.persist），不改变任何业务逻辑。',
    '**同文件范围顺带修复的 bug**：`src/lib/eval/runner.ts` 的成本超限错误原本用 `Object.assign(new Error(...), { code, statusCode })` 构造，而路由层用 `instanceof LLMError` 判断 → 会落到 500。已改为 `new LLMError(msg, "EVAL_COST_EXCEEDED", false, 422)`，并新增单测锁定「可被 `classifyError` 正确分类」。',
  ];
}

// ============================================================
// 小工具
// ============================================================

function formatDateTime(date: Date): string {
  // 显式按 UTC+8 展示（本地开发机时区可能不同，报告需要可复现）
  const shifted = new Date(date.getTime() + 8 * 3600_000);
  return `${shifted.toISOString().slice(0, 19).replace('T', ' ')} (UTC+8)`;
}

function formatRecord(record: Record<string, number>): string {
  const entries = Object.entries(record);
  return entries.length === 0 ? '（无）' : entries.map(([key, value]) => `${key}=${value}`).join(', ');
}

const SPAN_ATTRIBUTE_PRIORITY = [
  'taskId',
  'phase',
  'type',
  'model',
  'provider',
  'inputTokens',
  'outputTokens',
  'attempt',
  'step',
  'chunkCount',
  'chunkIndex',
  'toolName',
  'ok',
  'rate',
  'unsupported',
  'status',
  'stopReason',
] as const;

function formatSpanAttributes(attributes: Record<string, string | number | boolean>): string {
  const parts: string[] = [];
  for (const key of SPAN_ATTRIBUTE_PRIORITY) {
    const value = attributes[key];
    if (value !== undefined) parts.push(`${key}=${value}`);
  }
  return parts.join(', ');
}

function escapeCell(value: string): string {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function esc(value: string): string {
  return escapeCell(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================================
main().catch(async (error) => {
  console.error('\n[eval:report] 生成报告失败：', errorMessage(error));
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(0, 6).join('\n'));
  process.exitCode = 1;
});

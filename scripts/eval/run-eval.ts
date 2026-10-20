/**
 * 评测流水线 CLI。
 *
 * ## 它做什么
 *
 *   1. 把内置的候选用例写入数据库（幂等）
 *   2. 对每个用例**真实调用**管线生成输出（这里才有被测成本）
 *   3. 调 `runEval()` 跑断言 + judge + 落库
 *   4. 打印回归报告
 *
 * ## 为什么生成与评测都要在这个脚本里
 *
 * `runEval()` 刻意不管生成（见 runner.ts 的职责边界说明）。
 * 所以编排放在这里：脚本知道「taskType 是 agent 就跑 Agent 循环」，
 * 而评测逻辑对此一无所知。这样评测核心保持可测试、可复用。
 *
 * ## 用法
 *
 *   npx tsx scripts/eval/run-eval.ts seed              # 只写内置用例
 *   npx tsx scripts/eval/run-eval.ts run [--no-judge]  # 生成 + 评测 + 报告
 *   npx tsx scripts/eval/run-eval.ts calibrate         # 跑 judge 校准
 *
 * ⚠️ 这一步会**真实花钱**（每个用例一次生成 + 可选的 judge 调用）。
 * 所以 `run` 会先打印成本预估并要求确认（除非加 --yes）。
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: ['.env.local', '.env'] });

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { DeepSeekProvider } from '../../src/lib/llm/adapters/deepseek';
import { runAgent } from '../../src/lib/agent/loop';
import { checkEvidence, checkTrajectory } from '../../src/lib/agent/loop';
import { chunkText } from '../../src/lib/pipeline/chunk';
import { runEval, estimateRunCost, type EvalCaseInput } from '../../src/lib/eval/runner';
import { scoreCase, evaluateRuleAssertion, type EvalAssertion, type AgentTraceSummary } from '../../src/lib/eval/assertions';
import {
  judgeOutput,
  computeCalibration,
  gateDimension,
  JUDGE_PROMPT_VERSION,
  JUDGE_DIMENSIONS,
  judgeThreshold,
} from '../../src/lib/eval/judge';
import { DEMO_DATASET, DEMO_CASES, CALIBRATION_SEED } from './dataset';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const MODEL = process.env.DEFAULT_MODEL ?? 'deepseek-flash';

const DEMO_EMAIL = 'demo@lumenote.dev';

// ============================================================
// 写内置用例
// ============================================================
async function cmdSeed() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL }, select: { id: true } });
  if (!user) {
    console.error(`找不到账号 ${DEMO_EMAIL}`);
    process.exitCode = 1;
    return;
  }

  /**
   * 幂等写入：按 (datasetId, name) 判断已存在则更新。
   *
   * 不用 upsert 是因为 EvalCase 上没有 (datasetId, name) 的唯一约束 ——
   * 用例名允许重复（用户可能想保留两个同名的变体），
   * 所以幂等由脚本自己保证。
   */
  const dataset = await prisma.evalDataset.upsert({
    where: { userId_name: { userId: user.id, name: DEMO_DATASET.name } },
    update: { description: DEMO_DATASET.description, taskType: DEMO_DATASET.taskType },
    create: {
      userId: user.id,
      name: DEMO_DATASET.name,
      description: DEMO_DATASET.description,
      taskType: DEMO_DATASET.taskType,
      defaultParams: DEMO_DATASET.defaultParams as never,
    },
  });

  let created = 0;
  let updated = 0;

  for (const c of DEMO_CASES) {
    const existing = await prisma.evalCase.findFirst({
      where: { datasetId: dataset.id, name: c.name },
    });
    if (existing) {
      await prisma.evalCase.update({
        where: { id: existing.id },
        data: {
          input: c.input,
          expectations: c.expectations as never,
          weight: c.weight,
          isRegression: c.isRegression ?? false,
          enabled: true,
        },
      });
      updated += 1;
    } else {
      await prisma.evalCase.create({
        data: {
          datasetId: dataset.id,
          name: c.name,
          input: c.input,
          params: (c.params ?? {}) as never,
          expectations: c.expectations as never,
          weight: c.weight,
          isRegression: c.isRegression ?? false,
        },
      });
      created += 1;
    }
  }

  /**
   * 校准样本（**种子数据，标记 isSeed = true**）。
   *
   * 这些分数是按质量档位构造的，不是真人独立标注 —— 所以标记为种子，
   * 永不参与校准闸门的放行判定（见 runner.ts 里 gate 的查询条件）。
   *
   * 它们的作用只是让 `calibrate` 命令能跑通、演示机制，
   * 并给出一份"该长什么样"的参考。
   */
  let calCreated = 0;
  for (const s of CALIBRATION_SEED) {
    const existing = await prisma.judgeCalibration.findFirst({
      where: { userId: user.id, dimension: s.dimension, input: s.input, output: s.output },
    });
    if (existing) {
      /**
       * ⚠️ 已存在的样本也要补上 isSeed 标记。
       *
       * 早期种下的 9 条样本没有这个字段（默认 false），如果不回填，
       * 它们会继续"冒充"真人标注并可能打开闸门 —— 那正是要避免的假信心。
       */
      if (!existing.isSeed) {
        await prisma.judgeCalibration.update({
          where: { id: existing.id },
          data: { isSeed: true, ...(s.question ? { question: s.question } : {}) },
        });
      }
      continue;
    }
    await prisma.judgeCalibration.create({
      data: {
        userId: user.id,
        dimension: s.dimension,
        input: s.input,
        ...(s.question ? { question: s.question } : {}),
        output: s.output,
        humanScore: s.humanScore,
        isSeed: true,
      },
    });
    calCreated += 1;
  }

  console.log(`[eval] 用例集「${DEMO_DATASET.name}」(${dataset.id})`);
  console.log(`[eval] 用例：新增 ${created} / 更新 ${updated}，共 ${DEMO_CASES.length}`);
  console.log(`[eval] 校准样本：新增 ${calCreated}，共 ${CALIBRATION_SEED.length}`);
}

// ============================================================
// 生成 + 评测
// ============================================================
async function cmdRun(args: string[]) {
  const enableJudge = !args.includes('--no-judge');
  const autoYes = args.includes('--yes');

  const user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL }, select: { id: true } });
  if (!user) {
    console.error(`找不到账号 ${DEMO_EMAIL}`);
    process.exitCode = 1;
    return;
  }

  const dataset = await prisma.evalDataset.findFirst({
    where: { userId: user.id, name: DEMO_DATASET.name },
  });
  if (!dataset) {
    console.error('用例集不存在，请先运行：npx tsx scripts/eval/run-eval.ts seed');
    process.exitCode = 1;
    return;
  }

  const cases = await prisma.evalCase.findMany({
    where: { datasetId: dataset.id, enabled: true },
    orderBy: { createdAt: 'asc' },
  });

  const template = await prisma.promptTemplate.findFirst({
    where: { slug: 'sys:agent.docqa', isActive: true },
    include: { versions: { where: { status: 'active' }, orderBy: { version: 'desc' }, take: 1 } },
  });
  if (!template || template.versions.length === 0) {
    console.error('找不到 agent 模板，请先运行 pnpm prisma:seed');
    process.exitCode = 1;
    return;
  }
  const version = template.versions[0]!;

  // ---- 成本预估 ----
  /**
   * 成本预估用的空壳输入。
   *
   * `material` 必须给出真实文档 —— 它才是 judge 输入的大头
   * （文档通常比输出长几倍）。之前这一步也漏了 material，
   * 结果预估成本系统性偏低。
   */
  const evalInputs: EvalCaseInput[] = cases.map((c) => ({
    caseId: c.id,
    caseName: c.name,
    weight: c.weight,
    isRegression: c.isRegression,
    expectations: (c.expectations ?? []) as unknown as EvalAssertion[],
    material: c.input,
    question: typeof (c.params as Record<string, unknown> | null)?.question === 'string'
      ? String((c.params as Record<string, unknown>).question)
      : null,
    output: '',
    costUsd: 0,
    latencyMs: 0,
  }));

  const estimate = estimateRunCost(evalInputs, MODEL);
  console.log('═══════════════════════════════════════════');
  console.log('  评测运行');
  console.log(`  用例数：${cases.length}`);
  console.log(`  judge：${enableJudge ? '启用' : '关闭'}`);
  if (enableJudge) {
    console.log(`  预计 judge 调用：${estimate.judgeCalls} 次，约 $${estimate.estimatedUsd.toFixed(4)}`);
  }
  console.log('  另有每个用例一次的生成成本（由被测管线产生）');
  console.log('═══════════════════════════════════════════');

  if (!autoYes && process.stdin.isTTY) {
    // 交互确认：这一步会真实花钱，不该静默执行
    process.stdout.write('确认运行？(y/N) ');
    const answer = await new Promise<string>((resolve) => {
      process.stdin.once('data', (d) => resolve(String(d).trim().toLowerCase()));
    });
    if (answer !== 'y' && answer !== 'yes') {
      console.log('已取消');
      return;
    }
  }

  // ---- 逐个生成 ----
  const provider = new DeepSeekProvider(API_KEY, BASE_URL, MODEL);
  /**
   * ⚠️ 显式标注为 `EvalCaseInput[]`，不能靠从初始值推断。
   * 推断出来的类型缺少 `trace`（初始值里没给），
   * 于是下面 push 带 trace 的对象会报"多余属性"。
   */
  const outputs: EvalCaseInput[] = [];

  for (const [i, c] of cases.entries()) {
    const params = (c.params ?? dataset.defaultParams ?? {}) as Record<string, unknown>;
    const question = typeof params.question === 'string' ? params.question : c.name;

    process.stdout.write(`  [${i + 1}/${cases.length}] ${c.name} ... `);
    const startedAt = Date.now();

    const chunks = chunkText(c.input);
    const result = await runAgent({
      provider,
      model: MODEL,
      question,
      chunks,
      toolContext: { glossary: [], loadTaskOutput: async () => null },
      budget: { maxSteps: 8, maxTokens: 40_000 },
      thinking: 'disabled',
      temperature: 0.2,
    });

    const latencyMs = Date.now() - startedAt;

    /**
     * 构造轨迹摘要给断言用。
     *
     * 直接复用 loop.ts 的 `checkEvidence` / `checkTrajectory` ——
     * 不重复实现。这两个函数已经在 Agent 阶段被验证过，
     * 评测层复用它们保证「界面上的证据链校验」与「评测里的证据链断言」口径一致。
     */
    const evidence = checkEvidence(result.structured, result.finalChunks);
    const traj = checkTrajectory(result, { maxSteps: 8 });
    const trace: AgentTraceSummary = {
      usedTools: traj.usedTools,
      hasLoop: traj.hasLoop,
      totalSteps: traj.totalSteps,
      evidenceRate: evidence.rate,
      unsupportedConclusions: traj.unsupportedConclusions,
    };

    const costUsd = result.usage.inputTokens * 0.00000015 + result.usage.outputTokens * 0.0000006;

    outputs.push({
      caseId: c.id,
      caseName: c.name,
      weight: c.weight,
      isRegression: c.isRegression,
      expectations: (c.expectations ?? []) as unknown as EvalAssertion[],
      /** 源文档：judge 判「有没有背离材料」时看的必须是它，不是模型输出 */
      material: c.input,
      question,
      output: result.text,
      trace,
      costUsd,
      latencyMs,
    });

    /**
     * 进度显示只跑**规则断言**。
     *
     * ⚠️ 这里刻意只用于显示、不复用其结果：真正落库的判定由 `runEval` 统一做。
     *
     * 为什么不复用？第一版我把这里的判定也当成了结论，结果是
     * **进度行与最终报告互相矛盾**（进度显示"失败 6/7"，报告显示"通过 4/4"）——
     * 因为进度里把 judge 断言也算进去了（judge 在进度阶段必然失败，
     * 而 runEval 里会真的去调模型评它）。两处口径不同就会给出冲突的结论，
     * 而用户不知道该信哪个。
     *
     * 现在分工明确：
     *   - 进度行：让用户看到"跑到哪了、这条大概如何"（规则断言，零成本、即时）
     *   - 报告：唯一的权威结论（由 runEval 产出）
     */
    const preview = scoreCase(
      outputs
        .at(-1)!
        .expectations.filter((a) => a.kind !== 'judge')
        .map((a) => evaluateRuleAssertion(a, result.text, trace)),
    );
    const judgeCount = outputs.at(-1)!.expectations.filter((a) => a.kind === 'judge').length;

    console.log(
      `${preview.passed ? '规则通过' : '规则失败'} ` +
        `(${preview.passedCount}/${preview.totalCount}` +
        `${judgeCount > 0 ? ` + ${judgeCount} 条 judge 待评` : ''}, ` +
        `${latencyMs}ms, 证据链 ${(evidence.rate * 100).toFixed(0)}%)`,
    );
  }

  // ---- 评测 ----
  console.log('\n[eval] 开始评测…');
  const runResult = await runEval({
    // 显式传入本项目这个脚本自己的 Prisma 实例（见 runner.ts 文件头关于加载顺序的说明）
    prisma: prisma as never,
    userId: user.id,
    datasetId: dataset.id,
    promptVersionId: version.id,
    templateId: template.id,
    subjectModel: MODEL,
    cases: outputs,
    enableJudge,
    judgeCredential: { apiKey: API_KEY, baseUrl: BASE_URL, model: MODEL },
  });

  console.log('\n═══════════ 本次运行 ═══════════');
  console.log(`  运行 id：${runResult.runId}`);
  console.log(`  通过：${runResult.passedCases}/${runResult.totalCases}`);
  console.log(`  加权得分：${(runResult.weightedScore * 100).toFixed(1)}%`);
  console.log(`  成本：$${runResult.totalCostUsd.toFixed(5)}`);
  if (runResult.judgeWarning) console.log(`  ⚠️  ${runResult.judgeWarning}`);
  if (runResult.skippedJudgeAssertions > 0) {
    console.log(`  ⚠️  跳过 ${runResult.skippedJudgeAssertions} 条 judge 断言`);
  }
  if (runResult.gateWarnings?.length) {
    console.log('  校准闸门拒绝的维度（未通过人工校准，已跳过）：');
    for (const w of runResult.gateWarnings) console.log(`    · ${w}`);
  }

  if (runResult.report) {
    printReport(runResult.report);
  } else {
    console.log('\n（这是首次运行，没有基线可对比。下次运行时会自动与它对比）');
  }
}

// ============================================================
// 报告打印
// ============================================================
function printReport(r: Awaited<ReturnType<typeof runEval>>['report'] extends infer T ? NonNullable<T> : never) {
  console.log('\n═══════════ 回归报告 ═══════════');
  console.log(`  基线：${r.baselineRunId}`);
  console.log(`  结论：${r.verdict.level.toUpperCase()} —— ${r.verdict.headline}`);

  if (r.verdict.concerns.length > 0) {
    console.log('  需要关注：');
    for (const c of r.verdict.concerns) console.log(`    · ${c}`);
  }

  console.log(
    `\n  通过率：${(r.summary.beforeRate * 100).toFixed(0)}% → ${(r.summary.afterRate * 100).toFixed(0)}%` +
      `（加权 ${(r.summary.beforeWeighted * 100).toFixed(0)}% → ${(r.summary.afterWeighted * 100).toFixed(0)}%）`,
  );
  console.log(
    `  平均得分：${r.summary.beforeAvgScore.toFixed(3)} → ${r.summary.afterAvgScore.toFixed(3)}`,
  );
  console.log(
    `  成本：$${r.summary.beforeCostUsd.toFixed(5)} → $${r.summary.afterCostUsd.toFixed(5)}` +
      `（${r.summary.costDeltaPct > 0 ? '+' : ''}${r.summary.costDeltaPct}%）`,
  );
  console.log(
    `  延迟：${r.summary.beforeAvgLatencyMs}ms → ${r.summary.afterAvgLatencyMs}ms`,
  );

  if (r.judgeWarning) console.log(`\n  ⚠️  ${r.judgeWarning}`);

  if (r.groups.regressions.length > 0) {
    console.log('\n  ❌ 回归（通过 → 失败）：');
    for (const g of r.groups.regressions) {
      console.log(`    · ${g.caseName}${g.weight >= 2 ? ' [高权重]' : ''}`);
      for (const a of g.newlyFailedAssertions) {
        console.log(`        失败断言 ${a.kind}：${a.reason}`);
      }
    }
  }

  if (r.groups.fixes.length > 0) {
    console.log('\n  ✅ 修复（失败 → 通过）：');
    for (const g of r.groups.fixes) console.log(`    · ${g.caseName}`);
  }

  if (r.groups.scoreChanges.length > 0) {
    console.log('\n  📊 得分变化（仍在通过线内）：');
    for (const g of r.groups.scoreChanges) {
      console.log(`    · ${g.caseName}: ${g.before?.score.toFixed(2)} → ${g.after?.score.toFixed(2)}`);
    }
  }

  if (r.groups.changed.length > 0) {
    console.log(`\n  ✏️  输出改写但都通过：${r.groups.changed.length} 个`);
    for (const g of r.groups.changed.slice(0, 5)) {
      console.log(
        `    · ${g.caseName}（新增 ${g.diff?.added} 行 / 删除 ${g.diff?.removed} 行，相似度 ${((g.diff?.similarity ?? 0) * 100).toFixed(0)}%）`,
      );
    }
  }

  console.log(`\n  ⏸  输出逐字节相同：${r.groups.unchangedCount} 个（无需人工核对）`);

  if (r.groups.skipped.length > 0) {
    console.log(`  ⏭  未评估（断言被跳过）：${r.groups.skipped.length} 个`);
    for (const g of r.groups.skipped.slice(0, 5)) {
      console.log(`    · ${g.caseName}`);
    }
  }

  if (r.groups.added.length > 0) console.log(`  ➕ 新增用例：${r.groups.added.length} 个`);
  if (r.groups.removed.length > 0) console.log(`  ➖ 缺失用例：${r.groups.removed.length} 个`);
}

// ============================================================
// judge 校准
// ============================================================
async function cmdCalibrate() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL }, select: { id: true } });
  if (!user) {
    console.error(`找不到账号 ${DEMO_EMAIL}`);
    process.exitCode = 1;
    return;
  }

  const samples = await prisma.judgeCalibration.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });

  if (samples.length === 0) {
    console.log('没有校准样本，请先运行：npx tsx scripts/eval/run-eval.ts seed');
    return;
  }

  console.log('═══════════════════════════════════════════');
  console.log('  judge 校准');
  console.log(`  样本数：${samples.length}`);
  console.log(`  judge prompt 版本：${JUDGE_PROMPT_VERSION}`);
  console.log('═══════════════════════════════════════════\n');

  const byDimension = new Map<string, { human: number; judge: number }[]>();
  /** 种子样本单独统计，不参与闸门判定 */
  let seedCount = 0;

  for (const [i, s] of samples.entries()) {
    const def = JUDGE_DIMENSIONS[s.dimension];

    /**
     * ⚠️ 必须把 `question` 一起传给 judge。
     *
     * 缺了它，「切题度」维度在结构上无法判断 —— judge 只能回复
     * 「未给出具体问题，无法确认是否切题」。这正是上一轮 relevance
     * 维度校准失败的另一半原因（我当时只归因为样本太少）。
     */
    const outcome = await judgeOutput(
      {
        dimension: s.dimension,
        material: s.input,
        ...(s.question ? { question: s.question } : {}),
        output: s.output,
      },
      { apiKey: API_KEY, baseUrl: BASE_URL, model: MODEL },
    );

    const threshold = judgeThreshold(s.dimension);
    const agreed = Math.abs(s.humanScore - outcome.score) <= 1;

    await prisma.judgeCalibration.update({
      where: { id: s.id },
      data: {
        judgeScore: outcome.score,
        judgeReason: outcome.reason,
        agreed,
      },
    });

    // 种子样本不计入闸门：它们的"人工分数"是构造出来的，不是独立标注
    if (s.isSeed) seedCount += 1;
    if (!s.isSeed) {
      if (!byDimension.has(s.dimension)) byDimension.set(s.dimension, []);
      byDimension.get(s.dimension)!.push({ human: s.humanScore, judge: outcome.score });
    }

    console.log(
      `  [${i + 1}/${samples.length}] ${def?.label ?? s.dimension}` +
        `${s.isSeed ? '（种子）' : '（真人）'}: ` +
        `人工 ${s.humanScore} / judge ${outcome.score} ${agreed ? '✓' : '✗'} ` +
        `(阈值 ${threshold})`,
    );
    if (!agreed) console.log(`        judge 理由：${outcome.reason.slice(0, 150)}`);
  }

  console.log('\n═══════════ 各维度一致率（仅真人标注）═══════════');
  let allAcceptable = true;
  let totalPairs = 0;

  if (byDimension.size === 0) {
    console.log('\n  ⚠️  没有**真人**标注样本。');
    console.log(`     本次共 ${samples.length} 条样本，其中 ${seedCount} 条是脚本构造的种子样本。`);
    console.log('');
    console.log('     种子样本不计入一致率，因为它们的"人工分数"是构造出来的 ——');
    console.log('     构造者在写分数时知道 judge 大概会打几分，不是独立标注。');
    console.log('     用它算出的"一致率"证明不了 judge 可信，只会制造假信心。');
    console.log('');
    console.log('     要让 judge 参与正式评测，需要：');
    console.log('       1. 用真人独立标注一批样本（盲标：不看 judge 分数）');
    console.log('       2. 写入 judgeCalibration 表并标记 isSeed = false');
    console.log('       3. 重新运行本命令');
    console.log('');
    console.log('  结论：⚠️  尚无真人校准数据，judge 不可用于评测');
    return;
  }

  for (const [dimension, pairs] of byDimension) {
    const m = computeCalibration(pairs);
    totalPairs += m.total;
    if (!m.acceptable) allAcceptable = false;
    const gate = gateDimension(dimension, pairs);
    console.log(`\n  ${JUDGE_DIMENSIONS[dimension]?.label ?? dimension}`);
    console.log(`    一致率：${(m.rate * 100).toFixed(0)}%（${m.agreed}/${m.total}）`);
    console.log(`    精确一致：${(m.exactRate * 100).toFixed(0)}%`);
    console.log(`    平均偏差：${m.meanAbsDiff}`);
    console.log(`    ${gate.allowed ? '✅ 可用于评测' : `❌ ${gate.reason}`}`);
  }

  const overall = computeCalibration([...byDimension.values()].flat());
  console.log('\n═══════════ 总体（仅真人标注）═══════════');
  console.log(`  一致率：${(overall.rate * 100).toFixed(0)}%（${overall.agreed}/${overall.total}，共 ${totalPairs} 条样本）`);
  console.log(`  平均偏差：${overall.meanAbsDiff}`);
  if (seedCount > 0) console.log(`  另有 ${seedCount} 条种子样本，未计入（仅供演示）`);
  console.log(`  结论：${overall.acceptable ? '✅ judge 可用于评测' : '❌ judge 一致率不达标，评测分数不可信'}`);

  if (!allAcceptable) {
    console.log('\n  提示：一致率不达标的维度，建议');
    console.log('    · 补充更多人工标注样本（样本太少时一致率不可靠）');
    console.log('    · 检查 rubric 是否太笼统（越具体 judge 越一致）');
    console.log('    · 或换成另一家 provider 的模型作 judge');
  }
}

// ============================================================
async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (!API_KEY) {
    console.error('未配置 DEEPSEEK_API_KEY');
    process.exitCode = 1;
    return;
  }

  switch (cmd) {
    case 'seed':
      await cmdSeed();
      break;
    case 'run':
      await cmdRun(rest);
      break;
    case 'calibrate':
      await cmdCalibrate();
      break;
    default:
      console.log('用法：');
      console.log('  npx tsx scripts/eval/run-eval.ts seed              写内置用例与校准样本');
      console.log('  npx tsx scripts/eval/run-eval.ts run [--no-judge] [--yes]   生成 + 评测 + 报告');
      console.log('  npx tsx scripts/eval/run-eval.ts calibrate         跑 judge 校准');
  }
}

main()
  .catch((e) => {
    console.error('[eval] 失败：', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

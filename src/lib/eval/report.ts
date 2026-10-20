/**
 * 回归报告：把「两次评测运行的差异」变成人能看懂的东西。
 *
 * ## 为什么报告生成要做成纯函数
 *
 * 它是整个评测框架的**最终产物** —— 用户不会去看数据库里的 500 行结果，
 * 他只看这份报告。所以报告逻辑必须能被精确测试：
 * 「通过变失败」「失败变通过」「通过率不变但得分下降」
 * 这些场景都要有确定的输出，而不是"跑一次看看长什么样"。
 *
 * 因此这里不碰数据库：输入是两次运行的结果数组，输出是报告结构。
 * 数据获取由 API 层负责。
 *
 * ## 一个刻意的取舍：报告要短
 *
 * 20 个用例全列出来没人会看。所以分组规则是：
 *
 *   - **回归**（通过 → 失败）：最重要，单独置顶，必须逐条看
 *   - **修复**（失败 → 通过）：好事，但值得确认不是断言放松了
 *   - **改善/恶化**（都通过但得分变了）：信号，折叠展示
 *   - **无变化**（输出逐字节相同）：直接折叠成一行计数
 *
 * 「输出逐字节相同」这个判定是省事的关键 —— 用输出指纹比对，
 * 一致就归入"无变化"，不需要人去核对。
 */

import { outputFingerprint, outputDiffSummary, type AssertionResult } from './assertions';

// ============================================================
// 输入结构（与数据库行对应的最小子集）
// ============================================================

export interface CaseResultInput {
  caseId: string;
  caseName: string;
  /** 用例权重 */
  weight: number;
  /** 是否标记为回归用例 */
  isRegression: boolean;
  passed: boolean;
  score: number;
  output: string;
  assertions: AssertionResult[];
  costUsd: number;
  latencyMs: number;
  errorMessage?: string | null;
  /**
   * 这条用例是否**真的被评估过**。
   *
   * `false` 表示所有断言都被跳过（例如唯一的 judge 断言因未校准被拒）。
   * 缺省视为 true（兼容旧数据）。
   *
   * ⚠️ 这个字段存在的原因：跳过 ≠ 失败。把"未评估"当成"失败"
   * 会让回归报告说「检测到回归」，而实际上什么都没退化 —— 那是假警报，
   * 而假警报比没有报告更糟（用户会学会忽略报告）。
   */
  evaluated?: boolean;
  /** 被跳过的断言数 */
  skippedCount?: number;
}

export interface RunInput {
  runId: string;
  /** 运行时间（ISO 字符串） */
  createdAt: string;
  model?: string | null;
  judgeModel?: string | null;
  judgePromptVersion?: string | null;
  promptVersion: string;
  results: CaseResultInput[];
}

// ============================================================
// 报告结构
// ============================================================

export type ChangeKind =
  | 'regression' // 通过 → 失败
  | 'fixed' // 失败 → 通过
  | 'score_down' // 都通过，但得分下降
  | 'score_up' // 都通过，但得分上升
  | 'unchanged' // 输出逐字节相同
  | 'changed' // 都通过、得分相同，但输出不同（改写型变化）
  | 'skipped' // 本次未被评估（所有断言都被跳过）—— 不算通过也不算失败
  | 'new' // 基线里没有这个用例
  | 'removed'; // 基线里有、本次没有

export interface CaseChange {
  caseId: string;
  caseName: string;
  weight: number;
  isRegression: boolean;
  kind: ChangeKind;
  before?: { passed: boolean; score: number };
  after?: { passed: boolean; score: number };
  /** 输出差异摘要（仅 changed 类有） */
  diff?: { added: number; removed: number; similarity: number };
  /** 本次失败的断言（回归时最关键的信息） */
  failedAssertions: { kind: string; reason: string }[];
  /** 之前通过、现在失败的具体断言 */
  newlyFailedAssertions: { kind: string; reason: string }[];
  errorMessage?: string | null;
}

export interface RegressionReport {
  baselineRunId: string;
  currentRunId: string;
  baselineCreatedAt: string;
  currentCreatedAt: string;

  summary: {
    /** 通过率（用例数维度） */
    beforeRate: number;
    afterRate: number;
    rateDelta: number;
    /** 加权通过率（关键用例权重更高） */
    beforeWeighted: number;
    afterWeighted: number;
    weightedDelta: number;
    /** 平均得分 */
    beforeAvgScore: number;
    afterAvgScore: number;
    totalCases: number;
    /** 各变化类别的计数 */
    counts: Record<ChangeKind, number>;
    /** 本次总成本 */
    beforeCostUsd: number;
    afterCostUsd: number;
    costDeltaPct: number;
    beforeAvgLatencyMs: number;
    afterAvgLatencyMs: number;
  };

  /** 核心结论：一句话说清这次改动是好是坏 */
  verdict: {
    level: 'improved' | 'regressed' | 'neutral';
    headline: string;
    /** 需要立刻关注的事（回归用例、关键用例失败） */
    concerns: string[];
  };

  /** 按严重程度分组（回归在前） */
  groups: {
    regressions: CaseChange[];
    newlyFailedAssertions: { caseId: string; caseName: string; kind: string; reason: string }[];
    fixes: CaseChange[];
    scoreChanges: CaseChange[];
    changed: CaseChange[];
    unchangedCount: number;
    /**
     * 本次**未评估**的用例（所有断言都被跳过）。
     *
     * 单独一组，既不进 regressions 也不进 fixes ——
     * 把它们塞进任何一边都会让报告说谎（见 ChangeKind 的说明）。
     */
    skipped: CaseChange[];
    added: CaseChange[];
    removed: CaseChange[];
  };

  /** judge 配置变化告警（judge 变了的话，分数差异不能直接归因于 prompt） */
  judgeChanged: boolean;
  judgeWarning?: string;
}

// ============================================================
// 报告生成
// ============================================================

export function buildRegressionReport(baseline: RunInput, current: RunInput): RegressionReport {
  const before = new Map(baseline.results.map((r) => [r.caseId, r]));
  const after = new Map(current.results.map((r) => [r.caseId, r]));

  const counts: Record<ChangeKind, number> = {
    regression: 0,
    fixed: 0,
    score_down: 0,
    score_up: 0,
    unchanged: 0,
    changed: 0,
    skipped: 0,
    new: 0,
    removed: 0,
  };

  const regressions: CaseChange[] = [];
  const fixes: CaseChange[] = [];
  const scoreChanges: CaseChange[] = [];
  const changedCases: CaseChange[] = [];
  const added: CaseChange[] = [];
  const removed: CaseChange[] = [];
  const skippedCases: CaseChange[] = [];
  const newlyFailedAssertions: RegressionReport['groups']['newlyFailedAssertions'] = [];

  // ---- 基线里有、本次也有的用例 ----
  for (const [caseId, cur] of after) {
    const prev = before.get(caseId);

    if (!prev) {
      const change: CaseChange = {
        caseId,
        caseName: cur.caseName,
        weight: cur.weight,
        isRegression: cur.isRegression,
        kind: 'new',
        after: { passed: cur.passed, score: cur.score },
        failedAssertions: failedOf(cur),
        newlyFailedAssertions: [],
      };
      counts.new += 1;
      added.push(change);
      continue;
    }

    const failedNow = failedOf(cur);
    const newFails = newlyFailed(prev, cur);
    const sameOutput = outputFingerprint(prev.output) === outputFingerprint(cur.output);

    /**
     * ⚠️ 先判「本次未评估」，再判回归。
     *
     * 顺序很重要：一条用例如果所有断言都被跳过（例如唯一的 judge 断言
     * 因未校准被拒），它的 `passed` 会是 false —— 若先判回归，
     * 报告就会说「检测到回归」，而实际上什么都没退化。
     *
     * 这类假警报最致命的后果不是让用户烦，而是**训练用户忽略报告**。
     * 一旦报告被习惯性忽略，它就不再是质量闸门了。
     */
    let kind: ChangeKind;
    if (cur.evaluated === false) {
      kind = 'skipped';
    } else if (prev.passed && !cur.passed) {
      kind = 'regression';
    } else if (!prev.passed && cur.passed) {
      kind = 'fixed';
    } else if (prev.passed && cur.passed && cur.score < prev.score) {
      kind = 'score_down';
    } else if (prev.passed && cur.passed && cur.score > prev.score) {
      kind = 'score_up';
    } else if (sameOutput) {
      kind = 'unchanged';
    } else {
      kind = 'changed';
    }

    counts[kind] += 1;

    const change: CaseChange = {
      caseId,
      caseName: cur.caseName,
      weight: cur.weight,
      isRegression: cur.isRegression,
      kind,
      before: { passed: prev.passed, score: prev.score },
      after: { passed: cur.passed, score: cur.score },
      ...(sameOutput ? {} : { diff: outputDiffSummary(prev.output, cur.output) }),
      failedAssertions: failedNow,
      newlyFailedAssertions: newFails,
      errorMessage: cur.errorMessage,
    };

    switch (kind) {
      case 'regression':
        regressions.push(change);
        // 回归时把"具体哪条断言从过变不过"单独拎出来 —— 那才是要修的东西
        for (const f of newFails) {
          newlyFailedAssertions.push({
            caseId,
            caseName: cur.caseName,
            kind: f.kind,
            reason: f.reason,
          });
        }
        break;
      case 'fixed':
        fixes.push(change);
        break;
      case 'score_down':
      case 'score_up':
        scoreChanges.push(change);
        break;
      case 'changed':
        changedCases.push(change);
        break;
      case 'skipped':
        // 未评估的用例单独归类：不算通过、不算失败、不进回归组
        skippedCases.push(change);
        break;
      default:
        break;
    }
  }

  // ---- 基线里有、本次没有 ----
  for (const [caseId, prev] of before) {
    if (after.has(caseId)) continue;
    counts.removed += 1;
    removed.push({
      caseId,
      caseName: prev.caseName,
      weight: prev.weight,
      isRegression: prev.isRegression,
      kind: 'removed',
      before: { passed: prev.passed, score: prev.score },
      failedAssertions: [],
      newlyFailedAssertions: [],
    });
  }

  // ---- 汇总指标 ----
  const beforeStats = summarize(baseline.results);
  const afterStats = summarize(current.results);

  const sameCases = current.results.length;
  const report: RegressionReport = {
    baselineRunId: baseline.runId,
    currentRunId: current.runId,
    baselineCreatedAt: baseline.createdAt,
    currentCreatedAt: current.createdAt,
    summary: {
      beforeRate: beforeStats.rate,
      afterRate: afterStats.rate,
      rateDelta: Number((afterStats.rate - beforeStats.rate).toFixed(4)),
      beforeWeighted: beforeStats.weighted,
      afterWeighted: afterStats.weighted,
      weightedDelta: Number((afterStats.weighted - beforeStats.weighted).toFixed(4)),
      beforeAvgScore: beforeStats.avgScore,
      afterAvgScore: afterStats.avgScore,
      totalCases: sameCases,
      counts,
      beforeCostUsd: beforeStats.cost,
      afterCostUsd: afterStats.cost,
      costDeltaPct:
        beforeStats.cost === 0
          ? 0
          : Number((((afterStats.cost - beforeStats.cost) / beforeStats.cost) * 100).toFixed(1)),
      beforeAvgLatencyMs: beforeStats.avgLatency,
      afterAvgLatencyMs: afterStats.avgLatency,
    },
    verdict: { level: 'neutral', headline: '', concerns: [] },
    groups: {
      regressions,
      newlyFailedAssertions,
      fixes,
      scoreChanges,
      changed: changedCases,
      unchangedCount: counts.unchanged,
      skipped: skippedCases,
      added,
      removed,
    },
    judgeChanged: false,
  };

  // ---- judge 变化检测 ----
  if (
    baseline.judgePromptVersion &&
    current.judgePromptVersion &&
    baseline.judgePromptVersion !== current.judgePromptVersion
  ) {
    report.judgeChanged = true;
    report.judgeWarning =
      `judge 的 prompt 版本变了（${baseline.judgePromptVersion} → ${current.judgePromptVersion}）。` +
      '分数差异**不能**直接归因于被测 prompt —— 评分标准本身也变了。' +
      '建议先在人工校准集上确认新 judge 的一致性。';
  } else if (baseline.judgeModel && current.judgeModel && baseline.judgeModel !== current.judgeModel) {
    report.judgeChanged = true;
    report.judgeWarning = `judge 模型变了（${baseline.judgeModel} → ${current.judgeModel}），分数差异不能直接归因于被测 prompt。`;
  }

  report.verdict = buildVerdict(report);
  return report;
}

// ============================================================
// 辅助
// ============================================================

function failedOf(r: CaseResultInput): { kind: string; reason: string }[] {
  return (r.assertions ?? [])
    .filter((a) => !a.passed)
    .map((a) => ({ kind: a.kind, reason: a.reason }));
}

/**
 * 找出「之前通过、现在失败」的断言。
 *
 * 这是回归报告里最有价值的一条信息：它把"这个用例变差了"
 * 精确到"因为不再包含某个必需内容"。用户据此知道该改哪里。
 *
 * ⚠️ 按 kind + description 配对，而不是按数组下标：
 * 断言列表的顺序可能变化（比如数据集调整），按下标配对会张冠李戴。
 */
function newlyFailed(
  prev: CaseResultInput,
  cur: CaseResultInput,
): { kind: string; reason: string }[] {
  const key = (a: AssertionResult) => `${a.kind}:${a.description ?? ''}`;
  const prevPassed = new Set(
    (prev.assertions ?? []).filter((a) => a.passed).map(key),
  );

  return (cur.assertions ?? [])
    .filter((a) => !a.passed && prevPassed.has(key(a)))
    .map((a) => ({ kind: a.kind, reason: a.reason }));
}

/**
 * 汇总一组用例结果。
 *
 * ⚠️ **未评估的用例不进入任何统计**（分子分母都不算）。
 *
 * 为什么：一条用例如果所有断言都被跳过，它的 `passed` 是 false ——
 * 若计入分母会人为压低通过率，若计入分子则是"没评估就算过"的作弊。
 * 两者都会让通过率这个数字不可解释，所以干脆排除，
 * 并让调用方单独报出「N 条未评估」。
 */
function summarize(results: CaseResultInput[]) {
  const counted = results.filter((r) => r.evaluated !== false);
  const total = counted.length;

  if (total === 0) {
    return { rate: 0, weighted: 0, avgScore: 0, cost: 0, avgLatency: 0 };
  }

  const passed = counted.filter((r) => r.passed).length;
  const totalWeight = counted.reduce((s, r) => s + (r.weight > 0 ? r.weight : 1), 0);
  const passedWeight = counted
    .filter((r) => r.passed)
    .reduce((s, r) => s + (r.weight > 0 ? r.weight : 1), 0);

  return {
    rate: Number((passed / total).toFixed(4)),
    weighted: totalWeight === 0 ? 0 : Number((passedWeight / totalWeight).toFixed(4)),
    avgScore: Number((counted.reduce((s, r) => s + r.score, 0) / total).toFixed(4)),
    // 成本与延迟仍然统计全部用例 —— 没评估的用例也真的花了钱和时间
    cost: Number(results.reduce((s, r) => s + r.costUsd, 0).toFixed(6)),
    avgLatency:
      results.length === 0
        ? 0
        : Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length),
  };
}

/**
 * 生成一句话结论。
 *
 * ## 判定顺序的取舍
 *
 * 1. **回归优先于一切**。即使总体通过率上升，只要有用例从通过变失败，
 *    结论也必须是"有风险"—— 因为通过率上升可能来自别处的改善，
 *    而回归是确凿的退步。
 *
 * 2. **judge 变化不改变结论方向，只降低可信度**。
 *    这一点值得说明：judge 换了不等于被测对象变差了 —— 那是**量尺**变了，
 *    不是**被测物**变了。把两者混为一谈会让人去改本不需要改的 prompt。
 *    所以 judge 变化只加一条 concern 并明确"分数不可直接比较"，
 *    结论级别仍由真实的用例变化决定。
 */
function buildVerdict(report: RegressionReport): RegressionReport['verdict'] {
  const concerns: string[] = [];
  const { counts, rateDelta, weightedDelta } = report.summary;

  if (report.judgeChanged) {
    concerns.push('judge 配置发生变化，本次与基线的分数不可直接比较（应先在人工校准集上确认新 judge）');
  }
  if (counts.regression > 0) {
    concerns.push(`${counts.regression} 个用例从通过变为失败`);
  }
  // 关键用例（weight ≥ 2）的回归单独强调
  const criticalRegressions = report.groups.regressions.filter((r) => r.weight >= 2);
  if (criticalRegressions.length > 0) {
    concerns.push(
      `${criticalRegressions.length} 个高权重用例回归：${criticalRegressions.map((r) => r.caseName).join('、')}`,
    );
  }
  if (report.groups.removed.length > 0) {
    concerns.push(`${report.groups.removed.length} 个用例在本次运行中缺失（可能被禁用或删除）`);
  }
  /**
   * 未评估的用例要单独提示。
   *
   * 它们既不算通过也不算失败，但如果不说，用户会以为"4/4 都评估了"。
   * 尤其当某维度因未校准被整体跳过时，报告必须让人看出
   * 「这次的通过率是**部分断言**的结论」。
   */
  if (report.groups.skipped.length > 0) {
    concerns.push(
      `${report.groups.skipped.length} 个用例未被完整评估（断言被跳过，通常是 judge 维度未通过人工校准）`,
    );
  }
  if (counts.regression === 0 && counts.score_down > 0) {
    concerns.push(`${counts.score_down} 个用例得分下降但仍在通过线内`);
  }

  // ---- 有真实回归 → regressed ----
  if (counts.regression > 0) {
    const weightedNote =
      weightedDelta < 0
        ? `加权通过率下降 ${(Math.abs(weightedDelta) * 100).toFixed(1)} 个百分点。`
        : '';
    return {
      level: 'regressed',
      headline: `检测到回归：${counts.regression} 个用例变差。${weightedNote}`.trim(),
      concerns,
    };
  }

  // ---- 无回归但有改善 → improved ----
  if (counts.fixed > 0 || rateDelta > 0 || counts.score_up > 0) {
    return {
      level: 'improved',
      headline:
        `表现提升：通过率 ${(report.summary.beforeRate * 100).toFixed(0)}% → ` +
        `${(report.summary.afterRate * 100).toFixed(0)}%，${counts.fixed} 个用例从失败变通过。`,
      concerns,
    };
  }

  // ---- 其他 → neutral ----
  return {
    level: 'neutral',
    headline:
      `没有明显变化：通过率保持 ${(report.summary.afterRate * 100).toFixed(0)}%，` +
      `${counts.unchanged} 个用例输出逐字节相同。`,
    concerns,
  };
}

/**
 * 评测断言：把「模型输出好不好」拆成一堆**可判定**的问题。
 *
 * ## 核心设计：规则优先，judge 兜底，且两者分得很清楚
 *
 * 这是用户拍板的「分层混合」方案在代码层的落地。三层各有明确职责：
 *
 *   第 1 层 规则断言（本文件的 `evaluateRuleAssertion`）
 *          确定性、零成本、可复现。**能用它表达的绝不用 judge。**
 *   第 2 层 LLM judge（`judge` 类型的断言，判定结果由外部传入）
 *          覆盖主观维度：忠实度、切题度。它的结果**必须**带上
 *          judge 的模型与 prompt 版本，否则评测报告无法解释。
 *   第 3 层 人工校准（`JudgeCalibration` 表 + calibration.ts）
 *          用来证明第 2 层可信。judge 配置变更先过校准集。
 *
 * ## 为什么判定要返回 reason 而不是只返回布尔
 *
 * 评测报告的价值在于「为什么这条失败了」。一个只输出 `false` 的断言
 * 会让人去翻模型输出自己猜 —— 而翻了十条之后就没人看了。
 * 所以每条断言都要给出人类可读的理由，包括**通过时**的说明
 * （通过理由用于确认断言真的在检查它该检查的东西）。
 */

import { diffLines } from '@/lib/tasks/diff';

// ============================================================
// 断言类型
// ============================================================

export type RuleAssertionKind =
  | 'contains'
  | 'not_contains'
  | 'regex'
  | 'min_length'
  | 'max_length'
  | 'must_be_json'
  | 'json_path_exists'
  | 'heading_count_min'
  | 'agent_evidence_rate'
  | 'agent_no_unsupported'
  | 'agent_tool_used'
  | 'agent_no_loop'
  | 'agent_max_steps'
  | 'judge';

/** judge 断言的具体配置 */
export interface JudgeAssertionConfig {
  dimension: string;
  /** 给 judge 的评分标准。写得越具体，judge 越一致 */
  rubric: string;
  /** 通过阈值（1~5 分）。默认 4 */
  passScore?: number;
}

export interface EvalAssertion {
  kind: RuleAssertionKind;
  /** 规则断言的比较值；judge 断言时是配置对象 */
  value?: unknown;
  /** 展示用的说明（报告里替代默认文案） */
  description?: string;
  /** 权重，默认 1。关键断言的失败会被放大 */
  weight?: number;
}

/** Agent 任务的轨迹摘要（断言需要的部分） */
export interface AgentTraceSummary {
  usedTools: string[];
  hasLoop: boolean;
  totalSteps: number;
  /** 证据链完整率 0~1 */
  evidenceRate: number;
  /** 有结论但无证据的条数 */
  unsupportedConclusions: number;
}

/** 断言判定结果 */
export interface AssertionResult {
  kind: RuleAssertionKind;
  passed: boolean;
  /** 人类可读的理由（通过时也写，用于确认断言确实在检查东西） */
  reason: string;
  description?: string;
  weight: number;
  /**
   * 是否**未参与判定**（被跳过）。
   *
   * ## 为什么「跳过」必须与「失败」分开（这是踩过的坑）
   *
   * 校准闸门会拒绝未通过人工校准的 judge 维度。第一版把它记成
   * `passed: false`，于是该用例被算作失败、回归报告说
   * 「检测到回归：1 个用例变差」—— 但实际上**什么都没退化**，
   * 只是这一条断言没被评估。
   *
   * 把"没评估"当成"不通过"会产生持续性的假警报，
   * 而假警报比没有报告更糟：用户会学会忽略报告。
   *
   * 所以跳过是第三种状态：不计入分数与通过率，
   * 但在报告里单独列出「N 条未评估」，保持诚实。
   */
  skipped?: boolean;
  /** skip 的具体原因（写清是"没有样本"还是"一致率不达标"） */
  skippedReason?: string;
  /**
   * judge 断言的元信息。**必须落库** —— 否则评测报告无法回答
   * 「这个分数是哪个 judge 打的」，也就无法追溯分数变化的原因。
   */
  judge?: { dimension: string; score: number; model: string; promptVersion: string; reason: string };
}

// ============================================================
// 单条规则断言
// ============================================================

/**
 * 评测一个规则断言。
 *
 * ⚠️ 这个函数是**纯的** —— judge 类型不走这里（它需要网络调用）。
 * 传入 judge 类型时返回一个明确的失败，提示调用方去走 `judge` 分支，
 * 而不是静默返回 false（那会让"忘了实现 judge"看起来像"模型没通过"）。
 */
export function evaluateRuleAssertion(
  assertion: EvalAssertion,
  output: string,
  trace?: AgentTraceSummary | null,
): AssertionResult {
  const weight = assertion.weight ?? 1;
  const base = { kind: assertion.kind, weight, ...(assertion.description ? { description: assertion.description } : {}) };

  const pass = (reason: string): AssertionResult => ({ ...base, passed: true, reason });
  const fail = (reason: string): AssertionResult => ({ ...base, passed: false, reason });

  const text = output ?? '';

  switch (assertion.kind) {
    case 'contains': {
      const needle = String(assertion.value ?? '');
      if (!needle) return fail('断言配置错误：contains 缺少 value');
      const ok = text.includes(needle);
      return ok
        ? pass(`包含「${needle}」`)
        : fail(`未包含「${needle}」`);
    }

    case 'not_contains': {
      const needle = String(assertion.value ?? '');
      if (!needle) return fail('断言配置错误：not_contains 缺少 value');
      const ok = !text.includes(needle);
      return ok ? pass(`未出现「${needle}」`) : fail(`出现了不应存在的「${needle}」`);
    }

    case 'regex': {
      const pattern = String(assertion.value ?? '');
      if (!pattern) return fail('断言配置错误：regex 缺少 value');
      try {
        // 不要求全匹配：局部命中即可（比如"必须出现数字"）
        const re = new RegExp(pattern);
        const m = re.exec(text);
        return m ? pass(`匹配到 /${pattern}/：${JSON.stringify(m[0].slice(0, 40))}`) : fail(`未匹配 /${pattern}/`);
      } catch (e) {
        return fail(`断言配置错误：正则非法（${e instanceof Error ? e.message : '未知'}）`);
      }
    }

    case 'min_length': {
      const min = Number(assertion.value ?? 0);
      const ok = text.length >= min;
      return ok ? pass(`长度 ${text.length} ≥ ${min}`) : fail(`长度 ${text.length} < ${min}`);
    }

    case 'max_length': {
      const max = Number(assertion.value ?? 0);
      const ok = text.length <= max;
      return ok ? pass(`长度 ${text.length} ≤ ${max}`) : fail(`长度 ${text.length} > ${max}`);
    }

    case 'must_be_json': {
      /**
       * ⚠️ 按 ADR-0003 的实测：DeepSeek 的 JSON 输出**可能偶发返回空 content**，
       * 且模型常在 JSON 外面包 ```json 代码块或加一句说明。
       * 所以这里做容错提取，而不是直接 JSON.parse ——
       * 否则会把「格式不规范但内容可用」误判成「完全失败」。
       */
      const extracted = extractJson(text);
      if (extracted === null) return fail('未能从输出中提取出合法 JSON');
      // 只认对象与数组：标量（数字/字符串/布尔）虽然也是合法 JSON，
      // 但模型输出出这种东西时几乎一定是解析错位（比如从散文里抠出了一个数字）
      if (typeof extracted !== 'object') {
        return fail(`提取到的是标量 ${JSON.stringify(extracted)}，不是对象或数组`);
      }
      return pass(
        `可解析为 JSON（${Array.isArray(extracted) ? `数组 ${extracted.length} 项` : `${Object.keys(extracted).length} 个字段`}）`,
      );
    }

    case 'json_path_exists': {
      const path = String(assertion.value ?? '');
      if (!path) return fail('断言配置错误：json_path_exists 缺少 value');
      const extracted = extractJson(text);
      if (extracted === null || typeof extracted !== 'object') {
        return fail('输出不是可解析的 JSON 对象，无法检查路径');
      }
      const value = getByPath(extracted, path);
      return value === undefined
        ? fail(`JSON 中不存在路径 ${path}`)
        : pass(`路径 ${path} 存在`);
    }

    case 'heading_count_min': {
      const min = Number(assertion.value ?? 2);
      // 只数 Markdown 标题，与 UI 的渲染口径一致
      const count = text.split('\n').filter((l) => /^\s{0,3}#{1,6}\s+\S/.test(l)).length;
      return count >= min
        ? pass(`Markdown 标题数 ${count} ≥ ${min}`)
        : fail(`Markdown 标题数 ${count} < ${min}`);
    }

    // ---------- Agent 专属（复用 loop.ts 里已有的确定性检查）----------
    case 'agent_evidence_rate': {
      if (!trace) return fail('缺少轨迹，无法检查证据链（该任务可能不是 agent 类型）');
      const min = Number(assertion.value ?? 0.8);
      return trace.evidenceRate >= min
        ? pass(`证据链完整率 ${(trace.evidenceRate * 100).toFixed(0)}% ≥ ${(min * 100).toFixed(0)}%`)
        : fail(`证据链完整率 ${(trace.evidenceRate * 100).toFixed(0)}% < ${(min * 100).toFixed(0)}%`);
    }

    case 'agent_no_unsupported': {
      if (!trace) return fail('缺少轨迹，无法检查无依据结论');
      return trace.unsupportedConclusions === 0
        ? pass('没有无证据的结论')
        : fail(`有 ${trace.unsupportedConclusions} 条结论没有引用原文`);
    }

    case 'agent_tool_used': {
      if (!trace) return fail('缺少轨迹，无法检查工具使用');
      const tool = String(assertion.value ?? '');
      if (!tool) return fail('断言配置错误：agent_tool_used 缺少 value');
      return trace.usedTools.includes(tool)
        ? pass(`使用了工具 ${tool}`)
        : fail(`没有使用工具 ${tool}（实际用到：${trace.usedTools.join(', ') || '无'}）`);
    }

    case 'agent_no_loop': {
      if (!trace) return fail('缺少轨迹，无法检查死循环');
      return trace.hasLoop ? fail('检测到重复调用（死循环）') : pass('没有重复调用');
    }

    case 'agent_max_steps': {
      if (!trace) return fail('缺少轨迹，无法检查步数');
      const max = Number(assertion.value ?? 12);
      return trace.totalSteps <= max
        ? pass(`步数 ${trace.totalSteps} ≤ ${max}`)
        : fail(`步数 ${trace.totalSteps} > ${max}`);
    }

    case 'judge':
      /**
       * judge 断言**不能**在纯函数里判 —— 它需要调用模型。
       * 明确返回失败并说明原因，而不是静默 false：
       * 后者会让"忘了实现 judge 分支"看起来像"模型没通过评测"。
       */
      return fail('judge 断言需要外部判定（本函数不执行模型调用）');

    default:
      return fail(`未知的断言类型：${String(assertion.kind)}`);
  }
}

// ============================================================
// JSON 容错提取
// ============================================================

/**
 * 从模型输出里尽力提取 JSON 对象。
 *
 * 三种常见形态都要处理（都来自实测，见 ADR-0003/0004）：
 *   1. 纯 JSON
 *   2. ```json ... ``` 代码块包裹
 *   3. 前后有解释文字
 *
 * 全部失败返回 null —— 调用方据此判定"不是合法 JSON"，而不是抛错。
 */
export function extractJson(text: string): unknown | null {
  if (!text?.trim()) return null;

  const candidates: string[] = [];

  // 代码块
  for (const m of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) {
    if (m[1]) candidates.push(m[1].trim());
  }

  // 最外层花括号
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  // 最外层方括号（模型有时直接输出数组）
  const firstB = text.indexOf('[');
  const lastB = text.lastIndexOf(']');
  if (firstB !== -1 && lastB > firstB) candidates.push(text.slice(firstB, lastB + 1));

  candidates.push(text.trim());

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // 下一个候选
    }
  }
  return null;
}

/** 按 `a.b.c` 路径取值，支持数组下标 `a.0.b` */
export function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(p);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// ============================================================
// 用例级评分
// ============================================================

export interface CaseScore {
  /** 0~1 的加权得分（只算被评估的断言） */
  score: number;
  passed: boolean;
  passedCount: number;
  totalCount: number;
  /** 加权后的通过权重 / 总权重 */
  weightedPassed: number;
  weightedTotal: number;
  results: AssertionResult[];
  /** 被跳过（未评估）的断言数 */
  skippedCount: number;
  /**
   * 这条用例是否**真的被评估过**。
   *
   * false 表示所有断言都被跳过了（比如唯一的 judge 断言因未校准被拒）。
   * 调用方据此把用例标为 skipped，而不是 failed —— 否则会产生假回归。
   */
  evaluated: boolean;
}

/**
 * 汇总一个用例的所有断言。
 *
 * ## 判定「通过」的门槛：加权得分 = 1（全部被评估的断言都过）
 *
 * 不用「得分 ≥ 0.8 算通过」这种阈值，原因：一个用例的断言集合
 * 表达的是「这条输出必须同时满足这几件事」。放过其中任何一条，
 * 就等于承认"这个用例可以部分正确" —— 那会让通过率这个数字
 * 失去意义（80% 和 100% 混在一起说不清）。
 *
 * 但**得分仍然返回**，因为它在对比两个版本时有用
 * （"通过率没变，但平均得分从 0.92 降到 0.85"是重要信号）。
 *
 * ## 被跳过的断言不计入任何统计
 *
 * 这是刻意的：跳过意味着"没有判定"，而不是"判定为不通过"。
 * 把它算进失败会产生假警报（见 AssertionResult.skipped 的说明）。
 */
export function scoreCase(results: AssertionResult[]): CaseScore {
  const evaluated = results.filter((r) => !r.skipped);
  const skippedCount = results.length - evaluated.length;

  let weightedPassed = 0;
  let weightedTotal = 0;
  let passedCount = 0;

  for (const r of evaluated) {
    const w = r.weight > 0 ? r.weight : 1;
    weightedTotal += w;
    if (r.passed) {
      weightedPassed += w;
      passedCount += 1;
    }
  }

  const score = weightedTotal === 0 ? 0 : weightedPassed / weightedTotal;
  return {
    score: Number(score.toFixed(4)),
    /**
     * 没有任何断言被评估时，`passed` 为 false 但 `evaluated` 也为 false。
     * 调用方必须看 `evaluated` 才能区分「跳过」与「失败」。
     */
    passed: evaluated.length > 0 && passedCount === evaluated.length,
    passedCount,
    totalCount: evaluated.length,
    weightedPassed,
    weightedTotal,
    results,
    skippedCount,
    evaluated: evaluated.length > 0,
  };
}

// ============================================================
// 输出指纹与差异（用于回归报告）
// ============================================================

/**
 * 输出指纹。
 *
 * 用途：同一用例两次运行如果输出**逐字节相同**，说明这次改动对它没有影响 ——
 * 报告里可以把这类用例折叠起来，让人只看真正变化的那些。
 * 这是"人工复核成本"的关键优化：20 个用例全列出来没人看，
 * 只列 3 个变化的才会被认真看。
 */
export function outputFingerprint(output: string): string {
  let hash = 0x811c9dc5;
  const normalized = (output ?? '').trim();
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${normalized.length}-${hash.toString(16).padStart(8, '0')}`;
}

/** 两次输出的行级差异摘要（复用现有的 diff 引擎，不重复实现） */
export function outputDiffSummary(a: string, b: string): {
  added: number;
  removed: number;
  similarity: number;
} {
  const d = diffLines(a ?? '', b ?? '');
  return {
    added: d.stats.added,
    removed: d.stats.removed,
    similarity: d.stats.similarity,
  };
}

/**
 * LLM-as-judge：用模型判定主观维度。
 *
 * ## 这个文件最重要的不是"怎么调模型"，而是"怎么让它可信"
 *
 * LLM judge 的最大问题是**没人验证 judge 本身**。如果 judge 自己就飘，
 * 「通过率 87%」这个数字毫无意义 —— 它只是 judge 的偏好。
 *
 * 所以本文件做三件事，第三件最关键：
 *
 *  1. **judge 的 prompt 版本是内容哈希**，不是手写的 v1/v2。
 *     手写版本号会忘记更新，而哈希在 prompt 文本变化的瞬间就变 ——
 *     于是"这个分数是哪个 judge 标准打的"永远可回答。
 *  2. **judge 的输出必须结构化**（score + reason），
 *     不做正则猜分数。猜错的概率太高，而错判会污染整个评测结论。
 *  3. **强制走校准**：`assertJudgeCalibrated()` 检查该维度的人工
 *     校准一致率，不达标就**拒绝**用这个 judge 配置评用例。
 *     这是"不通过就拒绝"而不是"警告后继续"—— 后者在实践里等于没有。
 *
 * ## 为什么 judge 不与被测模型相同
 *
 * 同一个模型评自己会系统性偏好自己的输出风格（self-preference bias）。
 * 所以 `assertJudgeIsIndependent()` 会在 judge 模型与被测模型相同时告警。
 * 本项目默认两者都是 deepseek（站点只有一个 provider），
 * 所以这条是"已知限制 + 显式告警"，而不是假装解决了。
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { extractJson } from './assertions';

// ============================================================
// 维度定义
// ============================================================

/**
 * 内置评分维度。
 *
 * 每个维度都带一份**具体到可操作**的 rubric。
 * 写"评价质量如何"这种模糊描述会让 judge 自己发明标准，
 * 结果是一致率极低、分数噪声大于信号。
 */
export const JUDGE_DIMENSIONS: Record<
  string,
  { label: string; rubric: string; /** 该维度的通过阈值（1~5） */ passScore: number }
> = {
  faithfulness: {
    label: '忠实度',
    rubric: [
      '判断输出是否**只依据给定材料**，没有添加材料里没有的事实。',
      '',
      '评分时请严格区分这两类"材料没写"的内容，它们的严重性差别很大：',
      '  · **无害的通用建议**（如"建议定期检查日志"）—— 不改变事实主张，最多扣 1 分。',
      '  · **编造的具体事实**（凭空出现的数字、参数名、环境变量、机制步骤）',
      '    —— 这类内容会被当真并误导读者，必须判 1 分。',
      '',
      '5 分：所有陈述都能在材料里找到依据，无任何编造，也无多余补充。',
      '4 分：完全忠实，仅有 1 处不改变事实的通用补充建议。',
      '3 分：主体忠实，但有 1 处材料未提及的具体细节（数字/参数/步骤）。',
      '1 分：出现材料里完全没有的事实、数字、参数或机制。',
    ].join('\n'),
    passScore: 4,
  },
  relevance: {
    label: '切题度',
    rubric: [
      '判断输出是否**直接回答了给定的问题**，而不是泛泛而谈。',
      '',
      '⚠️ 如果材料里**没有给出具体问题**，你无法判断切题度。',
      '这种情况下请把「输出是否针对一个明确的提问作出回应」作为判断依据：',
      '纯粹复述材料、没有任何结论性回应的，判 2 分；',
      '给出了明确结论的，按结论是否对得上材料判断。',
      '',
      '5 分：正面回答了问题的每个部分，没有跑题。',
      '3 分：回答了问题的一部分，另一部分被忽略。',
      '2 分：只是在复述材料，没有针对提问作出回应。',
      '1 分：答非所问，或内容与问题完全无关。',
    ].join('\n'),
    passScore: 4,
  },
  completeness: {
    label: '完整性',
    rubric: [
      '判断输出是否**覆盖了材料中与问题相关的关键信息**。',
      '5 分：关键信息齐全，遗漏的都是无关细节。',
      '3 分：遗漏了 1 项关键信息。',
      '1 分：遗漏了大部分关键信息。',
    ].join('\n'),
    passScore: 3,
  },
  terminology: {
    label: '术语一致性',
    rubric: [
      '判断译文/输出是否**对同一术语使用了统一的译法**。',
      '5 分：同一术语全文译法一致，且是常见译法。',
      '3 分：有 1 处术语前后不一致。',
      '1 分：同一术语出现多种译法，或使用了显然错误的译法。',
    ].join('\n'),
    passScore: 4,
  },
  format: {
    label: '格式合规',
    rubric: [
      '判断输出是否符合要求的格式（Markdown 结构、要点数量、长度等）。',
      '5 分：完全符合要求。',
      '3 分：结构基本正确，但数量或层级有小偏差。',
      '1 分：格式完全不符合要求。',
    ].join('\n'),
    passScore: 4,
  },
};

// ============================================================
// judge 的 prompt 与它的版本
// ============================================================

/**
 * judge 的 system prompt 模板。
 *
 * ⚠️ 修改这个字符串会改变 `JUDGE_PROMPT_VERSION`，
 * 从而使所有已有人工校准**失效**（需要重新校准）。
 * 这正是想要的：标准变了，旧的一致率数据就不再适用。
 */
const JUDGE_SYSTEM_TEMPLATE = `你是一名严格的评审员，负责给 AI 的输出打分。

# 评分维度
{{dimension}}

# 评分标准
{{rubric}}

# 要求
1. 严格按上面的标准打分，不要自己发明标准。
2. 打 5 分需要**确实无可挑剔**，不要因为"看起来还行"就给 5 分。
3. 如果材料中没有足够信息判断某一项，就按"无法确认"处理并体现在分数上。
4. 理由必须**引用输出中的具体内容**，不要写"整体不错"这类空话。

# 输出格式
必须输出 JSON（不要有其他文字）：
{
  "score": <1 到 5 的整数>,
  "reason": "<不超过 100 字的理由，必须引用输出中的具体内容>"
}`;

/**
 * judge prompt 的版本 = 内容哈希。
 *
 * 用哈希而不是手写 v1/v2：手写版本号会忘记更新，
 * 而哈希在文本变化的瞬间就变 —— 于是评测报告里
 * 「这个分数是哪个 judge 标准打的」永远可回答。
 */
export const JUDGE_PROMPT_VERSION = `judge-${fnv1a(JUDGE_SYSTEM_TEMPLATE)}`;

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 组装某次评判的完整 system prompt */
export function buildJudgeSystemPrompt(dimension: string, rubric: string): string {
  return JUDGE_SYSTEM_TEMPLATE.replace('{{dimension}}', dimension).replace('{{rubric}}', rubric);
}

// ============================================================
// judge 调用
// ============================================================

export interface JudgeInput {
  dimension: string;
  /** 覆盖默认 rubric（数据集可以自定义标准） */
  rubric?: string;
  /** 被测的原始材料（文档/原文） */
  material: string;
  /** 被测的问题（agent 任务才有） */
  question?: string;
  /** 模型输出 */
  output: string;
}

export interface JudgeOutcome {
  score: number;
  reason: string;
  /** judge 用的模型 —— 必须落库，否则分数无法追溯 */
  model: string;
  /** judge 的 prompt 版本（内容哈希） */
  promptVersion: string;
  /** 被评的维度。带上它才能查该维度的默认阈值，而不必让调用方再传一遍 */
  dimension: string;
  /** 是否调用/解析失败。失败时不给出分数，让上层判为断言失败 */
  failed?: string;
}

export interface JudgeOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 材料截断长度：judge 也要控成本，材料太长时只给前 N 字符 */
  maxMaterialChars?: number;
}

/**
 * 调用模型评判一次输出。
 *
 * ## 材料截断的取舍
 *
 * judge 的输入 = 材料 + 输出，两者都算 token。文档很长时（比如 5 万字）
 * 每评一条用例都要送一遍全文，成本会随"用例数 × 材料长度"爆炸。
 * 所以默认截断到 6000 字符。
 *
 * 代价是：如果关键信息在截断之外，judge 可能误判"不忠实"。
 * 这是已知限制，缓解办法是断言列表里优先用规则断言，
 * judge 只用于确实需要通读的维度（如忠实度的整体判断）。
 */
export async function judgeOutput(
  input: JudgeInput,
  options: JudgeOptions,
): Promise<JudgeOutcome> {
  const dimensionDef = JUDGE_DIMENSIONS[input.dimension];
  const rubric = input.rubric ?? dimensionDef?.rubric ?? '按 1~5 分评价输出质量。';

  const maxChars = options.maxMaterialChars ?? 6000;
  const material =
    input.material.length > maxChars
      ? `${input.material.slice(0, maxChars)}\n\n（材料过长，此处已截断，仅提供前 ${maxChars} 字符供参考）`
      : input.material;

  const userPrompt = [
    opts('# 材料', material),
    input.question ? opts('# 问题', input.question) : '',
    opts('# 待评判的输出', input.output),
    '请按上面的标准打分，只输出 JSON。',
  ]
    .filter(Boolean)
    .join('\n\n');

  const provider = createOpenAICompatible({
    name: 'judge',
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
  });

  try {
    const result = await generateText({
      model: provider(options.model),
      instructions: buildJudgeSystemPrompt(
        dimensionDef ? `${dimensionDef.label}（${input.dimension}）` : input.dimension,
        rubric,
      ),
      prompt: userPrompt,
      maxOutputTokens: 500,
      // judge 要尽量确定：同一份输出评两次应得到同样的分数，
      // 否则"一致率"这个指标本身就不可信
      temperature: 0,
      providerOptions: {
        // thinking 关闭：评分是判别式任务，不需要推理链；
        // 且可避开 reasoning 回传要求（ADR-0004）
        deepseek: { thinking: { type: 'disabled' }, response_format: { type: 'json_object' } },
      },
    });

    const parsed = parseJudgeJson(result.text) as { score?: unknown; reason?: unknown } | null;

    if (!parsed || typeof parsed !== 'object') {
      return {
        score: 0,
        reason: `judge 输出无法解析为 JSON：${result.text.slice(0, 160)}`,
        model: options.model,
        promptVersion: JUDGE_PROMPT_VERSION,
        dimension: input.dimension,
        failed: 'judge_parse_failed',
      };
    }

    const rawScore = Number(parsed.score);
    if (!Number.isFinite(rawScore)) {
      return {
        score: 0,
        reason: `judge 未给出合法分数：${JSON.stringify(parsed.score)}`,
        model: options.model,
        promptVersion: JUDGE_PROMPT_VERSION,
        dimension: input.dimension,
        failed: 'judge_score_invalid',
      };
    }

    // 夹到 1~5：judge 偶尔会给 0 或 7，那是格式错误不是真实评分
    const score = Math.min(5, Math.max(1, Math.round(rawScore)));

    return {
      score,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : '',
      model: options.model,
      promptVersion: JUDGE_PROMPT_VERSION,
      dimension: input.dimension,
    };
  } catch (e) {
    return {
      score: 0,
      reason: `judge 调用失败：${e instanceof Error ? e.message.slice(0, 300) : '未知错误'}`,
      model: options.model,
      promptVersion: JUDGE_PROMPT_VERSION,
      dimension: input.dimension,
      failed: 'judge_call_failed',
    };
  }
}

function opts(label: string, body: string): string {
  return `${label}\n<block>\n${body}\n</block>`;
}

/**
 * 解析 judge 返回的 JSON，并容忍一种**实测中真实出现**的畸形。
 *
 * ## 被校准集抓出来的 bug
 *
 * 第一次跑 judge 校准时，9 条样本里有 2 条报「输出无法解析为 JSON」。
 * 打出来的原文长这样：
 *
 *     { "score": 1, "reason": "输出称"命中率大约能省 30% 的成本"，材料只说..." }
 *
 * `reason` 内部用了**未转义的英文双引号**（模型想引用输出里的话，
 * 就直接把引号打了出来）。严格 JSON 解析必然失败 —— 而这条
 * judge 判定其实完全有效，分数和理由都在。
 *
 * 两个层面都要修，缺一不可：
 *
 *  1. **提示词层面**（见 buildJudgeSystemPrompt 与 userPrompt）：
 *     DeepSeek 的 `response_format: json_object` **要求 prompt 里出现
 *     字面量 "json"**（ADR-0003 实测），否则该参数形同虚设。
 *     我第一版写了 response_format 却没写这个词，所以模型根本没被约束。
 *  2. **解析层面**（本函数）：即使提示词修好了，模型偶尔仍会打出未转义引号。
 *     一次格式抖动不该让整条判定作废 —— 那是把"格式问题"误报成"质量不合格"。
 *
 * ## 修复策略（保守，不猜内容）
 *
 * 只在**严格解析失败**时启用容错：
 *   - 用正则直接抽 `"score": <数字>` —— 它几乎不会受 reason 里的引号影响
 *   - 用正则抽 `"reason": "..."` 到最后一个引号为止
 *
 * 关键是**不猜测 reason 的精确边界**：宁可让 reason 多带一点尾巴，
 * 也不能把内容改错 —— 理由只是给人看的，分数才是判定依据。
 */
export function parseJudgeJson(text: string): unknown | null {
  const strict = extractJson(text);

  /**
   * ⚠️ 严格解析成功也**必须检查有没有 score**。
   *
   * 这是被单测抓到的疏漏：`{"reason":"只有理由"}` 是合法 JSON，
   * 于是严格解析"成功"并原样返回 —— 但它没有分数，
   * 下游会把 `Number(undefined)` 变成 NaN，最终表现为
   * 一条得 0 分的判定，看起来像"模型质量不合格"。
   *
   * 而没有 score 的 judge 输出是**格式失败**，不是质量失败。
   * 两者必须区分，否则评测报告会冤枉被测模型。
   */
  if (strict !== null && typeof strict === 'object' && !Array.isArray(strict)) {
    const o = strict as Record<string, unknown>;
    if (Number.isFinite(Number(o.score))) return strict;
  }

  if (!text?.trim()) return null;

  /**
   * 容错抽取分数。
   *
   * 用 `"score"\s*:\s*(-?\d+(?:\.\d+)?)` 而不是解析整个对象：
   * 分数的位置与形式最稳定，且它前面不会有需要引用的文本。
   */
  const scoreMatch = /"score"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(text);
  if (!scoreMatch) return null;

  /**
   * 容错抽取理由：从 `"reason"\s*:\s*"` 之后一直取到**最后一个** `"`。
   *
   * 为什么要"到最后一个引号"而不是"到第一个未转义引号"：
   * 判断"这个引号是不是结束符"需要理解 reason 的内容语义，
   * 而那是模型自己都可能没想清楚的事。取到最后至少保证 reason
   * 包含全部信息（多带一个引号或逗号不影响人阅读），
   * 而猜错边界可能截断掉关键内容。
   */
  let reason = '';
  const reasonMatch = /"reason"\s*:\s*"([\s\S]*)"\s*\}?\s*$/.exec(text.trim());
  if (reasonMatch?.[1] !== undefined) {
    reason = reasonMatch[1];
  } else {
    const loose = /"reason"\s*:\s*"([\s\S]*)/.exec(text);
    if (loose?.[1] !== undefined) reason = loose[1];
  }

  return { score: Number(scoreMatch[1]), reason, __recovered: true };
}

// ============================================================
// 独立性检查（已知限制的显式化）
// ============================================================

/**
 * 检查 judge 是否与被测模型相同。
 *
 * 相同会引入 self-preference bias（模型偏好自己的输出风格）。
 * 本项目站点只有一个 provider，所以默认必然相同 ——
 * 与其假装解决了，不如**显式告警并记进报告**：
 * 「本报告的 judge 与被测模型相同，分数存在自我偏好风险」。
 */
export function assertJudgeIsIndependent(
  judgeModel: string,
  subjectModel: string,
): { independent: boolean; warning?: string } {
  if (judgeModel === subjectModel) {
    return {
      independent: false,
      warning:
        `judge 与被测模型相同（都是 ${judgeModel}），存在自我偏好风险。` +
        '建议在「模型设置」配置另一家 provider 的 key 作为 judge，' +
        '或把 judge 的结论仅作为参考信号。',
    };
  }
  return { independent: true };
}

/**
 * 应用校准门槛：判断某个维度**当前是否被允许用于评测**。
 *
 * ## 为什么必须有这道闸（这是整个评测框架的诚信所在）
 *
 * 校准集算出一致率之后，如果只是打印一句"不达标"然后继续用它评测，
 * 那前面所有工作都白做了 —— 报告里会出现「忠实度 4 分」这种
 * 看起来客观、实际上不可信的数字。
 *
 * 所以规则是**拒绝**而不是警告：
 *   - 一致率 ≥ 门槛 → 允许
 *   - 一致率 < 门槛 → 拒绝，该维度的 judge 断言判为"未校准，不参与评测"
 *   - **样本数为 0** → 拒绝（"没有数据"不能当"通过"）
 *   - **样本数过少** → 拒绝并说明（2 条样本的一致率是噪声，不是结论）
 *
 * ⚠️ 最后一条来自真实经历：本项目实测时 relevance 维度只有一个 2 条样本的
 * 校准集，一致率 50%。这个数字毫无信息量 —— 但它如果被当成有效结论，
 * 就会误导人去改本来没问题的 rubric。样本量必须单独设门槛。
 */
export const CALIBRATION_MIN_SAMPLES = 5;

export interface DimensionGate {
  dimension: string;
  allowed: boolean;
  reason: string;
  metrics?: CalibrationMetrics;
}

export function gateDimension(
  dimension: string,
  pairs: { human: number; judge: number }[],
): DimensionGate {
  if (pairs.length === 0) {
    return {
      dimension,
      allowed: false,
      reason: `维度「${dimension}」没有人工校准样本，judge 判定不可信，已跳过`,
    };
  }

  if (pairs.length < CALIBRATION_MIN_SAMPLES) {
    return {
      dimension,
      allowed: false,
      reason:
        `维度「${dimension}」只有 ${pairs.length} 条校准样本（少于 ${CALIBRATION_MIN_SAMPLES} 条），` +
        '一致率是噪声而非结论，已跳过。请补充人工标注。',
    };
  }

  const metrics = computeCalibration(pairs);
  if (!metrics.acceptable) {
    return {
      dimension,
      allowed: false,
      reason: `维度「${dimension}」judge 与人工一致率 ${(metrics.rate * 100).toFixed(0)}% 低于门槛 ${(CALIBRATION_THRESHOLD * 100).toFixed(0)}%，已跳过`,
      metrics,
    };
  }

  return {
    dimension,
    allowed: true,
    reason: `维度「${dimension}」一致率 ${(metrics.rate * 100).toFixed(0)}%，通过校准`,
    metrics,
  };
}

/**
 * 判定 judge 分数是否达到通过阈值。
 *
 * 阈值来源优先级：调用方显式传入 > 该维度的默认阈值 > 4。
 * 缺省值 4 是"确实不错"的门槛 —— 低于它说明输出有实质问题。
 */
export function judgePassed(outcome: JudgeOutcome, passScore?: number): boolean {
  if (outcome.failed) return false;
  const threshold = passScore ?? JUDGE_DIMENSIONS[outcome.dimension]?.passScore ?? 4;
  return outcome.score >= threshold;
}

/** 取某维度的通过阈值（报告里要显示"为什么 3 分算失败"） */
export function judgeThreshold(dimension: string, override?: number): number {
  return override ?? JUDGE_DIMENSIONS[dimension]?.passScore ?? 4;
}

// ============================================================
// 人工校准的一致率
// ============================================================

export interface CalibrationMetrics {
  total: number;
  /** 相差 ≤1 分视为一致 */
  agreed: number;
  /** 完全同分的数量（更严格的指标） */
  exact: number;
  /** 一致率 0~1 */
  rate: number;
  /** 精确一致率 0~1 */
  exactRate: number;
  /** 平均绝对偏差，越小越好 */
  meanAbsDiff: number;
  /** 是否达到可接受门槛 */
  acceptable: boolean;
  /** 判定说明（报告里直接显示） */
  verdict: string;
}

/**
 * 校准一致率门槛。
 *
 * 0.8 的取舍：低于这个值时，judge 的分歧已经大到会让
 * "通过率"这个数字失去解释力 —— 87% 与 82% 的差异可能只是 judge 噪声。
 *
 * 为什么用「相差 ≤1 分算一致」而不是完全同分：
 * 人工标注本身也有 ±1 的抖动（同一个标注者隔一周打分会不同）。
 * 要求完全同分会把门槛设得比人的一致性还高，结果是永远无法达标。
 * 同时**也报出精确一致率**，让读者自己判断严格程度。
 */
export const CALIBRATION_THRESHOLD = 0.8;

/**
 * 从人工标注与 judge 打分的配对计算一致率（**纯函数**）。
 *
 * @param pairs 每项是 { human, judge } 的分数（1~5）
 */
export function computeCalibration(
  pairs: { human: number; judge: number }[],
): CalibrationMetrics {
  const total = pairs.length;
  if (total === 0) {
    return {
      total: 0,
      agreed: 0,
      exact: 0,
      rate: 0,
      exactRate: 0,
      meanAbsDiff: 0,
      acceptable: false,
      verdict: '没有校准样本，无法判定 judge 可信度',
    };
  }

  let agreed = 0;
  let exact = 0;
  let sumDiff = 0;

  for (const p of pairs) {
    const diff = Math.abs(p.human - p.judge);
    sumDiff += diff;
    if (diff === 0) {
      exact += 1;
      agreed += 1;
    } else if (diff <= 1) {
      agreed += 1;
    }
  }

  const rate = Number((agreed / total).toFixed(4));
  const exactRate = Number((exact / total).toFixed(4));
  const meanAbsDiff = Number((sumDiff / total).toFixed(3));
  const acceptable = rate >= CALIBRATION_THRESHOLD;

  return {
    total,
    agreed,
    exact,
    rate,
    exactRate,
    meanAbsDiff,
    acceptable,
    verdict: acceptable
      ? `judge 与人工标注一致率 ${(rate * 100).toFixed(0)}%（${agreed}/${total}），达到门槛 ${(CALIBRATION_THRESHOLD * 100).toFixed(0)}%`
      : `judge 与人工标注一致率仅 ${(rate * 100).toFixed(0)}%（${agreed}/${total}），低于门槛 ${(CALIBRATION_THRESHOLD * 100).toFixed(0)}% —— 该 judge 配置不可用于评测`,
  };
}

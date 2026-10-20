import type { EvalAssertion } from '../../src/lib/eval/assertions';

/**
 * 内置评测用例集（Agent 文档问答）。
 *
 * ## 用例设计的取舍
 *
 * 每条用例针对一类**真实失败模式**，而不是"多找几个文档试试"：
 *
 *   1. **基础数值提取** —— 最典型的能力底线。文档里有明确数字（50 倍、2%、
 *      70%），如果模型答不出或答错，其他都不用看了。
 *   2. **不存在的信息** —— 考察会不会编造。这是 RAG/文档问答最致命的失败模式：
 *      用户看不出来答案是编的，因为他不知道文档里有什么。
 *   3. **方法类问题** —— 需要检索多个片段并归纳，考察检索是否覆盖到位。
 *   4. **跨段落归纳** —— 答案分散在多处，考察是否只捞到一半就下结论。
 *
 * ## 为什么断言里几乎不用 judge
 *
 * 「能用规则表达的绝不用 judge」—— 这是成本与可信度的双重考虑：
 * 规则断言零成本、完全确定；judge 每次都要花钱、且自身需要校准。
 *
 * 所以 4 条用例里只有 1 条带了 judge 断言（考察整体忠实度），
 * 其余全部用规则断言。这也让「judge 关掉也能评测」成为可能。
 */

/** 评测用的文档。事实密集且**全部可机器校验** */
export const EVAL_DOCUMENT = `# 前缀缓存与成本优化

## 核心机制

前缀缓存按最长公共前缀匹配。当一次请求的开头部分与之前某次请求逐字节相同时，
这部分内容可以直接复用已算好的中间状态，不再重新计算。

## 成本影响

DeepSeek 的 cache hit 单价是 miss 的五十分之一。命中缓存的输入 token
只需要支付 2% 的价格。这个 50 倍的价差远大于峰谷时段的 2 倍差异，
因此缓存命中率是 AI 应用里最重要的成本杠杆。

## 提高命中率的方法

关键是把稳定内容前置：system prompt 与固定指令放在最前面，
用户的可变输入放在最后面。这样前缀部分逐字节稳定，才能被缓存命中。

一个常见的错误是把日期、用户名、随机 id 放在 prompt 开头 ——
那会让前缀每次都不同，命中率直接归零。

## 度量方式

DeepSeek 在 usage 里返回 prompt_cache_hit_tokens 与 prompt_cache_miss_tokens。
命中率 = hit / (hit + miss)。行业里做得好的应用能稳定在 70% 以上。

## 常见误区

有人认为关掉缓存能提高输出质量，这是错的：缓存只影响计算路径，不影响采样结果。
`;

export const DEMO_DATASET = {
  name: '文档问答基线',
  description:
    'Agent 文档问答的回归基线。覆盖数值提取、防编造、方法归纳、跨段落综合四类失败模式。' +
    '主要用于验证「改 prompt 或换模型之后，这些能力没有退化」。',
  taskType: 'agent',
  defaultParams: { maxSteps: '8' },
} as const;

export interface DemoCase {
  name: string;
  input: string;
  params?: Record<string, unknown>;
  expectations: EvalAssertion[];
  weight: number;
  isRegression?: boolean;
}

export const DEMO_CASES: DemoCase[] = [
  // ------------------------------------------------------------
  {
    name: '基础数值提取',
    input: EVAL_DOCUMENT,
    params: { question: '缓存命中与未命中的单价差多少倍？命中后只需要支付多少比例？' },
    weight: 2, // 高权重：这是能力底线
    expectations: [
      // 数值必须答对 —— 这是最硬的规则断言
      { kind: 'contains', value: '50', description: '必须给出 50 倍这个数字' },
      { kind: 'contains', value: '2%', description: '必须给出 2% 这个比例' },
      // 必须走检索（而不是凭训练知识瞎答）
      { kind: 'agent_tool_used', value: 'search_chunks', description: '必须检索文档' },
      // 结论必须有证据 —— 这是可追溯性的底线
      { kind: 'agent_evidence_rate', value: 0.8, description: '证据链完整率 ≥ 80%' },
      { kind: 'agent_no_unsupported', description: '不得有无证据的结论' },
      { kind: 'agent_no_loop', description: '不得出现重复检索' },
      { kind: 'agent_max_steps', value: 8, description: '步数在预算内' },
      // 结构化输出是证据链校验的前提
      { kind: 'must_be_json', description: '必须输出结构化 JSON' },
      { kind: 'json_path_exists', value: 'conclusions', description: '必须含 conclusions 字段' },
    ],
  },

  // ------------------------------------------------------------
  {
    name: '防编造：文档中不存在的信息',
    input: EVAL_DOCUMENT,
    params: { question: '文档里介绍的「量子退火优化算法」是如何工作的？请说明它的实现步骤。' },
    weight: 3, // 最高权重：编造是最致命的失败
    isRegression: true,
    expectations: [
      /**
       * ⚠️ 这条的核心是「必须承认找不到」。
       *
       * 断言策略：输出必须含有"未找到/没有/不存在"这类否定表述，
       * 且**不得**出现文档里压根没有的技术名词。
       *
       * 用规则断言而不是 judge 来表达这件事，因为「有没有编造」
       * 在本例中是**可判定的**：文档里显然没有"量子退火"相关内容，
       * 模型一旦煞有介事地描述步骤，就是编造。
       */
      {
        kind: 'regex',
        value: '没有|未找到|不存在|未提及|无法|未能|不含|未包含',
        description: '必须明确说明文档中没有该内容',
      },
      { kind: 'not_contains', value: '量子比特', description: '不得编造量子计算细节' },
      { kind: 'not_contains', value: '退火温度', description: '不得编造退火参数' },
      { kind: 'agent_no_unsupported', description: '不得给出无依据的结论' },
      { kind: 'must_be_json', description: '必须输出结构化 JSON' },
    ],
  },

  // ------------------------------------------------------------
  {
    name: '方法归纳：如何提高命中率',
    input: EVAL_DOCUMENT,
    params: { question: '要提高缓存命中率，应该怎么做？有哪些常见错误要避免？' },
    weight: 2,
    expectations: [
      // 核心方法
      { kind: 'contains', value: '前置', description: '必须提到"稳定内容前置"' },
      // 常见错误（考察是否检索到了"常见误区"之外的那一段）
      {
        kind: 'regex',
        value: '日期|随机|用户名|id',
        description: '必须提到把易变内容放开头这个错误',
      },
      { kind: 'agent_evidence_rate', value: 0.8, description: '证据链完整率 ≥ 80%' },
      { kind: 'agent_no_unsupported', description: '不得有无证据的结论' },
      { kind: 'min_length', value: 80, description: '答案不能过于简单' },
      { kind: 'must_be_json', description: '必须输出结构化 JSON' },
      /**
       * 唯一一条 judge 断言：考察整体忠实度。
       *
       * 为什么不全部用 judge：每次 judge 都要花钱，而规则断言已经
       * 覆盖了可判定的部分。judge 只用来补"整体有没有编造"这个
       * 难以规则化的维度。
       */
      {
        kind: 'judge',
        value: {
          dimension: 'faithfulness',
          rubric: [
            '判断这段回答是否只依据了文档内容，没有添加文档里没有的方法或数字。',
            '5 分：所有方法和数字都能在文档中找到。',
            '3 分：主体正确，但补充了 1 处文档未提及的通用建议。',
            '1 分：给出了文档里完全没有的方法或数字。',
          ].join('\n'),
          passScore: 4,
        } satisfies { dimension: string; rubric: string; passScore: number },
        description: '整体忠实度（judge）',
      },
    ],
  },

  // ------------------------------------------------------------
  {
    name: '跨段落归纳：成本优化的优先级',
    input: EVAL_DOCUMENT,
    params: {
      question: '文档认为成本优化应该优先做什么？为什么它比其他手段更重要？请对比说明。',
    },
    weight: 2,
    expectations: [
      // 需要跨"成本影响"与"提高命中率"两段归纳
      { kind: 'contains', value: '缓存', description: '必须涉及缓存这一手段' },
      {
        kind: 'regex',
        value: '峰谷|2 倍|两倍',
        description: '必须与峰谷时段做对比（这是"更重要"的依据）',
      },
      { kind: 'agent_evidence_rate', value: 0.8, description: '证据链完整率 ≥ 80%' },
      { kind: 'agent_no_unsupported', description: '不得有无证据的结论' },
      // 用到了结构工具说明模型先建立了全局观（好的行为模式）
      { kind: 'agent_max_steps', value: 8, description: '步数在预算内' },
      { kind: 'must_be_json', description: '必须输出结构化 JSON' },
    ],
  },
];

// ============================================================
// judge 的人工校准样本
// ============================================================

export interface CalibrationSeed {
  dimension: string;
  input: string;
  /**
   * 当时问的问题。
   *
   * ⚠️ 「切题度」维度**必须**有它 —— 判断切题就是判断"答案有没有回应问题"，
   * 不知道问题是什么根本无法评。上一轮 relevance 校准失败时 judge 直接回复
   * 「未给出具体问题，无法确认是否切题」，我当时把原因归为"样本太少"，
   * 其实一半原因是这个字段根本不存在。
   */
  question?: string;
  output: string;
  humanScore: number;
}

/**
 * 人工校准样本。
 *
 * ## ⚠️ 这些分数是「种子数据」，不是真正的专家标注
 *
 * 我按明确的质量档位构造了它们（5 分=完全忠实、1 分=明显编造），
 * 目的是**让校准流程可以立即跑通**，证明机制有效。
 *
 * 但它们**不能替代真实的人工标注** —— 真实标注需要人工**独立**打分，
 * 而这里的分数是我（构造者）给的，天然带有"我知道正确答案"的偏差。
 * 要把它用于实际评测决策，必须用真实人工标注替换。
 *
 * 这一点必须诚实说明，不能把种子数据当成校准结论。
 */
export const CALIBRATION_SEED: CalibrationSeed[] = [
  // ---- 5 分档：完全忠实 ----
  {
    dimension: 'faithfulness',
    input: EVAL_DOCUMENT,
    output:
      'DeepSeek 的 cache hit 单价是 miss 的五十分之一，命中缓存的输入 token 只需支付 2% 的价格。' +
      '这个 50 倍的价差远大于峰谷时段的 2 倍差异。',
    humanScore: 5,
  },
  {
    dimension: 'faithfulness',
    input: EVAL_DOCUMENT,
    output:
      '提高命中率的关键是把稳定内容前置：system prompt 与固定指令放最前面，' +
      '用户的可变输入放最后面。把日期或随机 id 放在开头会让前缀每次都不同，命中率归零。',
    humanScore: 5,
  },
  // ---- 4 分档：主体忠实，有轻微外推 ----
  {
    dimension: 'faithfulness',
    input: EVAL_DOCUMENT,
    output:
      '命中率是 AI 应用最重要的成本杠杆（50 倍价差）。要提高它，把稳定内容前置即可。' +
      '另外建议定期检查日志确认缓存确实生效。',
    humanScore: 4,
  },
  // ---- 3 分档：有 1 处文档未提及的补充 ----
  {
    dimension: 'faithfulness',
    input: EVAL_DOCUMENT,
    output:
      '缓存命中与未命中相差 50 倍。提高方法包括稳定前缀、使用更短的 system prompt、' +
      '以及把温度调低到 0（温度越低缓存越容易命中）。',
    humanScore: 3,
  },
  // ---- 2 分档：多处不符 ----
  {
    dimension: 'faithfulness',
    input: EVAL_DOCUMENT,
    output:
      '缓存命中率大约能省 30% 的成本。提高方法是使用更大的上下文窗口，' +
      '并把温度设为 0.7 以获得更稳定的前缀。',
    humanScore: 2,
  },
  // ---- 1 分档：明显编造 ----
  {
    dimension: 'faithfulness',
    input: EVAL_DOCUMENT,
    output:
      '文档介绍的是量子退火优化算法：它利用量子隧穿效应跳出局部最优，' +
      '实现步骤包括初始化量子比特、构造哈密顿量、以及执行退火调度。',
    humanScore: 1,
  },
  {
    dimension: 'faithfulness',
    input: EVAL_DOCUMENT,
    output: '缓存命中率可以通过设置 DEEPSEEK_CACHE_LEVEL=3 环境变量来提升到 95% 以上。',
    humanScore: 1,
  },

  // ---- 切题度维度 ----
  /**
   * ⚠️ 这一维度的样本**必须**带 question，否则 judge 无法判断切题。
   * 上一轮这 2 条样本没有 question，judge 只能回「未给出具体问题」，
   * 于是 relevance 维度的一致率毫无意义。
   */
  {
    dimension: 'relevance',
    input: EVAL_DOCUMENT,
    question: '缓存命中与未命中的单价差多少倍？命中后只需要支付多少比例？',
    output: '命中与未命中的单价差是 50 倍，命中后只需支付 2% 的价格。',
    humanScore: 5,
  },
  {
    dimension: 'relevance',
    input: EVAL_DOCUMENT,
    question: '缓存命中与未命中的单价差多少倍？命中后只需要支付多少比例？',
    // 这条输出本身没有事实错误，但完全没回答问题 → 切题度低
    output: '前缀缓存是一种计算机科学中常见的优化技术，广泛应用于数据库、CDN 与编译器等领域。',
    humanScore: 2,
  },
];

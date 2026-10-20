import type { AgentTraceSummary, EvalAssertion } from '../../src/lib/eval/assertions';

/**
 * 失败样本回归集（评测断言的自检集）。
 *
 * ## 为什么需要「故意有缺陷的样本」
 *
 * 一个断言集合如果永远只跑模型输出，它**通过率高不代表有效** ——
 * 可能是断言写得太宽松（几乎什么都通过）。真正要证明的是：
 * 「当输出确实坏了，断言能抓住」。
 *
 * 所以这里构造 8 条**故意有缺陷的输出 + 对应断言**，运行报告时逐条检查
 * 「断言是否检测到缺陷」。检测率 100% 才说明断言有区分力。
 *
 * ## 为什么还要 2 条好样本做对照
 *
 * 只证明「坏的会被拒」还不够：一个永远返回 false 的断言也能 100% 检测缺陷。
 * 所以再加 2 条**应当通过**的良样本作为对照组 ——
 * 断言必须同时「拒坏」且「纳好」，才说明它真的在检查内容。
 *
 * ## 口径
 *
 * - `expectDetected: true`  → 期望至少一条断言失败（= 缺陷被抓到）
 * - `expectDetected: false` → 期望全部断言通过（= 好样本不被误伤）
 *
 * 这些样本只在报告脚本里跑，不写入 EvalCase 表（避免污染真实评测用例）。
 * 缺陷类型与断言一一对应，报告里逐条列出，便于 review 断言质量的演进。
 */

export interface RegressionSample {
  id: string;
  name: string;
  /** 缺陷类型（报告里显示，便于归类） */
  defectType: string;
  /** 故意有缺陷 / 正常对照的输出 */
  output: string;
  /** 用来抓这个缺陷的断言 */
  assertions: EvalAssertion[];
  /** Agent 轨迹摘要（仅 agent 类断言需要） */
  trace?: AgentTraceSummary | null;
  /** true = 期望被断言检测到（拒绝）；false = 期望通过（对照组） */
  expectDetected: boolean;
  note?: string;
}

/** 一个「证据链完整」的轨迹摘要，供对照样本使用 */
const GOOD_TRACE: AgentTraceSummary = {
  usedTools: ['search_chunks'],
  hasLoop: false,
  totalSteps: 3,
  evidenceRate: 1,
  unsupportedConclusions: 0,
};

/**
 * 8 条缺陷样本：每条只针对一类真实失败模式，
 * 让报告能回答「哪条断言在防哪类问题」。
 */
export const REGRESSION_DEFECT_SAMPLES: RegressionSample[] = [
  {
    id: 'reg-01-number-hallucination',
    name: '数值幻觉：把 50 倍 / 2% 编成 250 倍 / 25%',
    defectType: '事实数字错误',
    output:
      '缓存命中的单价是未命中的 250 倍，命中后只需要支付 25% 的价格，' +
      '这是 AI 应用里最重要的成本杠杆。',
    assertions: [
      { kind: 'contains', value: '50', description: '必须给出 50 倍' },
      { kind: 'contains', value: '2%', description: '必须给出 2%' },
      { kind: 'regex', value: '50\\s*倍', description: '50 倍这个数字必须出现' },
    ],
    expectDetected: true,
    note: '数值是文档里最容易被模型「顺手改错」的部分',
  },
  {
    id: 'reg-02-fabrication',
    name: '编造文档中不存在的信息（量子退火算法）',
    defectType: '事实编造',
    output:
      '文档介绍的量子退火优化算法利用量子隧穿效应跳出局部最优。实现步骤包括：' +
      '初始化量子比特、构造哈密顿量、按退火温度调度执行。',
    assertions: [
      {
        kind: 'regex',
        value: '没有|未找到|不存在|未提及|无法|未能|不含|未包含',
        description: '必须明确说明文档中没有该内容',
      },
      { kind: 'not_contains', value: '量子比特', description: '不得编造量子计算细节' },
      { kind: 'not_contains', value: '退火温度', description: '不得编造退火参数' },
    ],
    expectDetected: true,
    note: 'RAG 最致命的失败模式：用户不知道文档里有什么',
  },
  {
    id: 'reg-03-not-json',
    name: '输出不是结构化 JSON（只有散文）',
    defectType: '结构缺失',
    output:
      '这篇文章主要讲了缓存命中率对成本的影响，也提到了把稳定内容前置可以减少开销。',
    assertions: [
      { kind: 'must_be_json', description: '必须输出结构化 JSON' },
      { kind: 'json_path_exists', value: 'conclusions', description: '必须含 conclusions 字段' },
    ],
    expectDetected: true,
    note: '结构化是证据链可机器校验的前提',
  },
  {
    id: 'reg-04-no-evidence',
    name: '结论没有任何证据引用',
    defectType: '证据链断裂',
    output: JSON.stringify(
      {
        conclusions: [{ text: '缓存命中率是最重要的成本杠杆。', evidence: [], confidence: 'high' }],
        limitations: [],
      },
      null,
      2,
    ),
    trace: {
      usedTools: ['search_chunks'],
      hasLoop: false,
      totalSteps: 3,
      evidenceRate: 0,
      unsupportedConclusions: 1,
    },
    assertions: [
      { kind: 'agent_no_unsupported', description: '不得有无证据的结论' },
      { kind: 'agent_evidence_rate', value: 0.8, description: '证据链完整率 ≥ 80%' },
    ],
    expectDetected: true,
    note: '本项目「可追溯」卖点的底线',
  },
  {
    id: 'reg-05-no-tool',
    name: '完全没检索就凭训练知识作答',
    defectType: '未使用文档（脱离材料）',
    output: JSON.stringify(
      {
        conclusions: [
          {
            text: '缓存命中率是最重要的成本杠杆。',
            evidence: [{ source: 'chunk:0', quote: '缓存命中率是 AI 应用里最重要的成本杠杆。' }],
          },
        ],
      },
      null,
      2,
    ),
    trace: {
      usedTools: [],
      hasLoop: false,
      totalSteps: 1,
      evidenceRate: 1,
      unsupportedConclusions: 0,
    },
    assertions: [
      { kind: 'agent_tool_used', value: 'search_chunks', description: '必须检索文档' },
    ],
    expectDetected: true,
    note: '答案看起来对，但路径不对 —— 这类问题只查输出是查不出来的',
  },
  {
    id: 'reg-06-loop',
    name: '用相同参数反复检索（死循环）',
    defectType: 'Agent 空转烧钱',
    output: '{"conclusions":[],"limitations":["检索次数达到上限"]}',
    trace: {
      usedTools: ['search_chunks'],
      hasLoop: true,
      totalSteps: 8,
      evidenceRate: 0.5,
      unsupportedConclusions: 0,
    },
    assertions: [{ kind: 'agent_no_loop', description: '不得出现重复检索' }],
    expectDetected: true,
    note: '护栏判定结果必须在结果里可见，不能被模型后续行为覆盖',
  },
  {
    id: 'reg-07-over-steps',
    name: '步数超出预算',
    defectType: '预算失控',
    output: '{"conclusions":[],"limitations":["未能在预算内完成"]}',
    trace: {
      usedTools: ['list_sections', 'search_chunks'],
      hasLoop: false,
      totalSteps: 15,
      evidenceRate: 0.5,
      unsupportedConclusions: 0,
    },
    assertions: [{ kind: 'agent_max_steps', value: 8, description: '步数在预算内' }],
    expectDetected: true,
    note: '步数与 token 双预算的回归信号',
  },
  {
    id: 'reg-08-too-short',
    name: '答案过短，缺少关键方法',
    defectType: '信息量不足',
    output: '好的，已按你的要求完成总结。',
    assertions: [
      { kind: 'min_length', value: 80, description: '答案不能过于简单' },
      { kind: 'contains', value: '前置', description: '必须提到稳定内容前置' },
    ],
    expectDetected: true,
    note: '短答案往往意味着模型没检索到关键段落就下结论',
  },
];

/**
 * 对照组：2 条「应当通过」的良样本。
 *
 * 它们同时满足对应的断言集合，用来证明断言不是「无差别拒绝」。
 */
export const REGRESSION_CONTROL_SAMPLES: RegressionSample[] = [
  {
    id: 'ctrl-01-good-answer',
    name: '对照：合法结构化答案（含证据引用）',
    defectType: '（无缺陷，对照组）',
    output: JSON.stringify(
      {
        conclusions: [
          {
            text: '缓存命中与未命中的单价差是 50 倍，命中后只需支付 2% 的价格。',
            evidence: [
              { source: 'chunk:0', quote: '缓存命中率是 AI 应用里最重要的成本杠杆。' },
            ],
            confidence: 'high',
          },
          {
            text: '提高命中率的关键是把稳定内容前置：system prompt 与固定指令放最前面，用户可变输入放最后。',
            evidence: [
              { source: 'chunk:0', quote: '缓存命中率是 AI 应用里最重要的成本杠杆。' },
            ],
            confidence: 'high',
          },
        ],
        limitations: [],
      },
      null,
      2,
    ),
    trace: GOOD_TRACE,
    assertions: [
      { kind: 'contains', value: '50', description: '必须给出 50 倍' },
      { kind: 'contains', value: '2%', description: '必须给出 2%' },
      { kind: 'min_length', value: 80, description: '答案不能过于简单' },
      { kind: 'must_be_json', description: '必须输出结构化 JSON' },
      { kind: 'json_path_exists', value: 'conclusions', description: '必须含 conclusions 字段' },
      { kind: 'agent_tool_used', value: 'search_chunks', description: '必须检索文档' },
      { kind: 'agent_evidence_rate', value: 0.8, description: '证据链完整率 ≥ 80%' },
      { kind: 'agent_no_unsupported', description: '不得有无证据的结论' },
      { kind: 'agent_no_loop', description: '不得出现重复检索' },
      { kind: 'agent_max_steps', value: 8, description: '步数在预算内' },
    ],
    expectDetected: false,
    note: '断言全部通过 → 说明断言不是无差别拒绝',
  },
  {
    id: 'ctrl-02-honest-not-found',
    name: '对照：正确的「文档中没有该信息」回答',
    defectType: '（无缺陷，对照组）',
    output: JSON.stringify(
      {
        conclusions: [],
        limitations: ['文档中没有关于量子退火优化算法的内容，未找到相关实现步骤。'],
      },
      null,
      2,
    ),
    assertions: [
      {
        kind: 'regex',
        value: '没有|未找到|不存在|未提及|无法|未能|不含|未包含',
        description: '必须明确说明文档中没有该内容',
      },
      { kind: 'not_contains', value: '量子比特', description: '不得编造量子计算细节' },
      { kind: 'not_contains', value: '退火温度', description: '不得编造退火参数' },
      { kind: 'must_be_json', description: '必须输出结构化 JSON' },
      { kind: 'agent_no_unsupported', description: '不得给出无依据的结论' },
    ],
    trace: {
      usedTools: ['search_chunks'],
      hasLoop: false,
      totalSteps: 2,
      evidenceRate: 0,
      unsupportedConclusions: 0,
    },
    expectDetected: false,
    note: '「承认不知道」是正确行为，断言不应误伤',
  },
];

export const REGRESSION_SAMPLES: RegressionSample[] = [
  ...REGRESSION_DEFECT_SAMPLES,
  ...REGRESSION_CONTROL_SAMPLES,
];

import { describe, it, expect } from 'vitest';
import {
  evaluateRuleAssertion,
  scoreCase,
  extractJson,
  getByPath,
  outputFingerprint,
  outputDiffSummary,
  type AssertionResult,
  type EvalAssertion,
  type AgentTraceSummary,
} from '@/lib/eval/assertions';
import {
  computeCalibration,
  judgePassed,
  judgeThreshold,
  JUDGE_DIMENSIONS,
  JUDGE_PROMPT_VERSION,
  buildJudgeSystemPrompt,
  assertJudgeIsIndependent,
  parseJudgeJson,
  CALIBRATION_THRESHOLD,
  type JudgeOutcome,
} from '@/lib/eval/judge';
import {
  buildRegressionReport,
  type RunInput,
  type CaseResultInput,
} from '@/lib/eval/report';
import { estimateRunCost, runEval } from '@/lib/eval/runner';
import { classifyError, LLMError } from '@/lib/llm/types';

/**
 * 评测框架核心的单测。
 *
 * 评测框架本身如果不可信，它给出的「通过率 87%」就是噪声。
 * 所以这一层比其他任何一层都更需要精确测试：
 * 断言判定、judge 校准、回归报告的分组与结论，
 * 每一条规则都必须是确定的、可复现的。
 */

// ============================================================
// 断言判定
// ============================================================
describe('evaluateRuleAssertion：规则断言', () => {
  it('contains 命中与未命中', () => {
    const a: EvalAssertion = { kind: 'contains', value: '50 倍' };
    expect(evaluateRuleAssertion(a, '价差是 50 倍').passed).toBe(true);
    const r = evaluateRuleAssertion(a, '价差很大');
    expect(r.passed).toBe(false);
    // 失败必须给出可读理由，否则报告里没法解释
    expect(r.reason).toContain('50 倍');
  });

  it('通过时也给出理由（用于确认断言真的在检查东西）', () => {
    const r = evaluateRuleAssertion({ kind: 'contains', value: 'x' }, 'axb');
    expect(r.passed).toBe(true);
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('not_contains 反向判定', () => {
    expect(evaluateRuleAssertion({ kind: 'not_contains', value: '可能' }, '这是确定的').passed).toBe(true);
    expect(evaluateRuleAssertion({ kind: 'not_contains', value: '可能' }, '可能是这样').passed).toBe(false);
  });

  it('regex 局部命中即可（不要求全匹配）', () => {
    expect(evaluateRuleAssertion({ kind: 'regex', value: '\\d+' }, '有 42 个').passed).toBe(true);
    expect(evaluateRuleAssertion({ kind: 'regex', value: '^\\d+$' }, '有 42 个').passed).toBe(false);
  });

  it('非法正则被判为**配置错误**而不是模型失败', () => {
    const r = evaluateRuleAssertion({ kind: 'regex', value: '([' }, '任意');
    expect(r.passed).toBe(false);
    // 这一条很重要：配置错误与模型失败必须能区分，否则会去改 prompt 而实际该改正则
    expect(r.reason).toContain('配置错误');
  });

  it('min_length / max_length', () => {
    expect(evaluateRuleAssertion({ kind: 'min_length', value: 5 }, '12345').passed).toBe(true);
    expect(evaluateRuleAssertion({ kind: 'min_length', value: 6 }, '12345').passed).toBe(false);
    expect(evaluateRuleAssertion({ kind: 'max_length', value: 5 }, '12345').passed).toBe(true);
    expect(evaluateRuleAssertion({ kind: 'max_length', value: 4 }, '12345').passed).toBe(false);
  });

  it('must_be_json 容忍代码块与前后散文（ADR-0003 实测的常见形态）', () => {
    expect(evaluateRuleAssertion({ kind: 'must_be_json' }, '{"a":1}').passed).toBe(true);
    expect(
      evaluateRuleAssertion({ kind: 'must_be_json' }, '结果如下：\n```json\n{"a":1}\n```\n完毕').passed,
    ).toBe(true);
    expect(evaluateRuleAssertion({ kind: 'must_be_json' }, '完全不是 JSON').passed).toBe(false);
  });

  it('must_be_json 拒绝标量（那通常是解析错位而非真的输出 JSON）', () => {
    const r = evaluateRuleAssertion({ kind: 'must_be_json' }, '42');
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('标量');
  });

  it('json_path_exists 支持嵌套与数组下标', () => {
    const out = '{"conclusions":[{"text":"a"}]}';
    expect(evaluateRuleAssertion({ kind: 'json_path_exists', value: 'conclusions.0.text' }, out).passed).toBe(true);
    expect(evaluateRuleAssertion({ kind: 'json_path_exists', value: 'conclusions.5.text' }, out).passed).toBe(false);
    expect(evaluateRuleAssertion({ kind: 'json_path_exists', value: 'nope' }, out).passed).toBe(false);
  });

  it('heading_count_min 只数 Markdown 标题', () => {
    const md = '# 一级\n正文\n## 二级\n正文';
    expect(evaluateRuleAssertion({ kind: 'heading_count_min', value: 2 }, md).passed).toBe(true);
    expect(evaluateRuleAssertion({ kind: 'heading_count_min', value: 3 }, md).passed).toBe(false);
    // 「# 没有空格」不是标题
    expect(evaluateRuleAssertion({ kind: 'heading_count_min', value: 1 }, '#无空格').passed).toBe(false);
  });

  it('缺少 value 的断言被判为配置错误', () => {
    for (const kind of ['contains', 'not_contains', 'regex'] as const) {
      const r = evaluateRuleAssertion({ kind }, '任意内容');
      expect(r.passed, kind).toBe(false);
      expect(r.reason).toContain('配置错误');
    }
  });

  it('未知断言类型明确报错（不静默通过）', () => {
    const r = evaluateRuleAssertion({ kind: 'not_a_real_kind' as never }, 'x');
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('未知');
  });

  it('judge 断言在纯函数里明确失败并说明原因', () => {
    // 关键：不能静默返回 false，否则「忘了实现 judge 分支」看起来像「模型没通过」
    const r = evaluateRuleAssertion({ kind: 'judge' }, 'x');
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('judge');
  });

  it('权重被保留到结果里', () => {
    const r = evaluateRuleAssertion({ kind: 'contains', value: 'x', weight: 3 }, 'x');
    expect(r.weight).toBe(3);
    expect(evaluateRuleAssertion({ kind: 'contains', value: 'x' }, 'x').weight).toBe(1);
  });
});

describe('evaluateRuleAssertion：Agent 轨迹断言', () => {
  const trace: AgentTraceSummary = {
    usedTools: ['search_chunks', 'list_sections'],
    hasLoop: false,
    totalSteps: 3,
    evidenceRate: 1,
    unsupportedConclusions: 0,
  };

  it('agent_evidence_rate 达标与不达标', () => {
    expect(evaluateRuleAssertion({ kind: 'agent_evidence_rate', value: 0.8 }, '', trace).passed).toBe(true);
    const bad = { ...trace, evidenceRate: 0.5 };
    const r = evaluateRuleAssertion({ kind: 'agent_evidence_rate', value: 0.8 }, '', bad);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('50%');
  });

  it('agent_no_unsupported 检查无依据结论', () => {
    expect(evaluateRuleAssertion({ kind: 'agent_no_unsupported' }, '', trace).passed).toBe(true);
    const bad = { ...trace, unsupportedConclusions: 2 };
    expect(evaluateRuleAssertion({ kind: 'agent_no_unsupported' }, '', bad).passed).toBe(false);
  });

  it('agent_tool_used 检查是否用了指定工具', () => {
    expect(evaluateRuleAssertion({ kind: 'agent_tool_used', value: 'search_chunks' }, '', trace).passed).toBe(true);
    const r = evaluateRuleAssertion({ kind: 'agent_tool_used', value: 'fetch_url' }, '', trace);
    expect(r.passed).toBe(false);
    // 失败理由里要列出实际用到的工具，方便排查
    expect(r.reason).toContain('search_chunks');
  });

  it('agent_no_loop 检查死循环', () => {
    expect(evaluateRuleAssertion({ kind: 'agent_no_loop' }, '', trace).passed).toBe(true);
    expect(evaluateRuleAssertion({ kind: 'agent_no_loop' }, '', { ...trace, hasLoop: true }).passed).toBe(false);
  });

  it('agent_max_steps 检查步数上限', () => {
    expect(evaluateRuleAssertion({ kind: 'agent_max_steps', value: 5 }, '', trace).passed).toBe(true);
    expect(evaluateRuleAssertion({ kind: 'agent_max_steps', value: 2 }, '', trace).passed).toBe(false);
  });

  it('缺少轨迹时**所有** agent 断言都失败并说明原因', () => {
    // 关键：不能因为"没有轨迹"就当通过 —— 那会让非 agent 任务静默满分
    for (const kind of [
      'agent_evidence_rate',
      'agent_no_unsupported',
      'agent_tool_used',
      'agent_no_loop',
      'agent_max_steps',
    ] as const) {
      const r = evaluateRuleAssertion({ kind, value: 'search_chunks' }, 'x', null);
      expect(r.passed, kind).toBe(false);
      expect(r.reason, kind).toContain('轨迹');
    }
  });
});

// ============================================================
// JSON 工具
// ============================================================
describe('extractJson 与 getByPath', () => {
  it('纯 JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('代码块包裹', () => {
    expect(extractJson('前言\n```json\n{"a":1}\n```\n后记')).toEqual({ a: 1 });
  });

  it('前后有散文', () => {
    expect(extractJson('我认为：{"a":1} 以上')).toEqual({ a: 1 });
  });

  it('顶层数组', () => {
    expect(extractJson('结果：[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('空内容与垃圾内容返回 null', () => {
    expect(extractJson('')).toBeNull();
    expect(extractJson('   ')).toBeNull();
    expect(extractJson('完全不是 JSON')).toBeNull();
  });

  it('getByPath 走嵌套与数组', () => {
    const o = { a: { b: [{ c: 1 }] } };
    expect(getByPath(o, 'a.b.0.c')).toBe(1);
    expect(getByPath(o, 'a.b.9.c')).toBeUndefined();
    expect(getByPath(o, 'x.y')).toBeUndefined();
    expect(getByPath(null, 'a')).toBeUndefined();
  });
});

// ============================================================
// 用例评分
// ============================================================
describe('scoreCase：用例评分', () => {
  const mk = (passed: boolean, weight = 1): AssertionResult => ({
    kind: 'contains',
    passed,
    reason: '',
    weight,
  });

  it('全部通过 → passed 且 score 为 1', () => {
    const r = scoreCase([mk(true), mk(true)]);
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.passedCount).toBe(2);
    expect(r.totalCount).toBe(2);
  });

  it('**只要有一条失败就不算通过**（不用 0.8 阈值）', () => {
    // 这是刻意的设计：一个用例的断言集合表达"必须同时满足这几件事"，
    // 放过其中任何一条都会让通过率这个数字失去意义
    const r = scoreCase([mk(true), mk(true), mk(false)]);
    expect(r.passed).toBe(false);
    expect(r.score).toBeCloseTo(0.6667, 3);
  });

  it('得分仍按权重计算（用于对比两个版本）', () => {
    const r = scoreCase([mk(true, 1), mk(false, 3)]);
    expect(r.score).toBe(0.25);
    expect(r.weightedPassed).toBe(1);
    expect(r.weightedTotal).toBe(4);
  });

  it('空断言列表不算通过（避免无断言的用例白送分）', () => {
    const r = scoreCase([]);
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
  });

  it('权重为 0 或负数时按 1 处理（防止权重被配置成 0 而绕过）', () => {
    const r = scoreCase([mk(false, 0)]);
    expect(r.weightedTotal).toBe(1);
    expect(r.score).toBe(0);
  });
});

// ============================================================
// 输出指纹与差异
// ============================================================
describe('outputFingerprint 与 outputDiffSummary', () => {
  it('相同内容得到相同指纹（忽略首尾空白）', () => {
    expect(outputFingerprint('abc')).toBe(outputFingerprint('  abc\n'));
  });

  it('不同内容得到不同指纹', () => {
    expect(outputFingerprint('abc')).not.toBe(outputFingerprint('abd'));
  });

  it('长度相同但内容不同也能区分（长度参与但不只靠长度）', () => {
    expect(outputFingerprint('abc')).not.toBe(outputFingerprint('xyz'));
  });

  it('差异摘要复用 diff 引擎', () => {
    const d = outputDiffSummary('a\nb\nc', 'a\nX\nc');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.similarity).toBeGreaterThan(0);
  });
});

// ============================================================
// judge
// ============================================================
describe('judge：prompt 版本与维度', () => {
  it('judge prompt 版本是内容哈希（改文本就变版本）', () => {
    // 用哈希而非手写 v1/v2：手写会忘记更新，哈希不会
    expect(JUDGE_PROMPT_VERSION).toMatch(/^judge-[0-9a-f]{8}$/);
  });

  it('内置维度都有 rubric 与通过阈值', () => {
    for (const [key, def] of Object.entries(JUDGE_DIMENSIONS)) {
      expect(def.rubric.length, key).toBeGreaterThan(50);
      expect(def.passScore, key).toBeGreaterThanOrEqual(1);
      expect(def.passScore, key).toBeLessThanOrEqual(5);
    }
  });

  it('组装 system prompt 会替换占位符', () => {
    const p = buildJudgeSystemPrompt('忠实度', '看是否忠于材料');
    expect(p).toContain('忠实度');
    expect(p).toContain('看是否忠于材料');
    expect(p).not.toContain('{{dimension}}');
    expect(p).not.toContain('{{rubric}}');
  });

  it('rubric 必须具体（越具体 judge 越一致）', () => {
    // 这条断言是给自己的约束：防止有人把 rubric 写成"评价质量如何"
    for (const [key, def] of Object.entries(JUDGE_DIMENSIONS)) {
      expect(def.rubric, `${key} 的 rubric 太笼统`).toMatch(/5 分/);
      expect(def.rubric, `${key} 的 rubric 太笼统`).toMatch(/1 分/);
    }
  });
});

describe('judgePassed 与 judgeThreshold', () => {
  const mk = (over: Partial<JudgeOutcome> = {}): JudgeOutcome => ({
    score: 4,
    reason: '',
    model: 'm',
    promptVersion: JUDGE_PROMPT_VERSION,
    dimension: 'faithfulness',
    ...over,
  });

  it('达到该维度阈值才算通过', () => {
    expect(judgePassed(mk({ score: 4 }))).toBe(true);
    expect(judgePassed(mk({ score: 3 }))).toBe(false);
  });

  it('调用失败的 judge 一律不通过（不给分数就没有通过）', () => {
    expect(judgePassed(mk({ score: 5, failed: 'judge_call_failed' }))).toBe(false);
  });

  it('可以覆盖阈值', () => {
    expect(judgePassed(mk({ score: 3 }), 3)).toBe(true);
    expect(judgePassed(mk({ score: 4 }), 5)).toBe(false);
  });

  it('未知维度回落到默认阈值 4', () => {
    expect(judgeThreshold('不存在的维度')).toBe(4);
    expect(judgeThreshold('completeness')).toBe(JUDGE_DIMENSIONS.completeness!.passScore);
  });
});

describe('computeCalibration：人工校准一致率', () => {
  it('完全一致 → rate 1 且 acceptable', () => {
    const m = computeCalibration([
      { human: 5, judge: 5 },
      { human: 4, judge: 4 },
      { human: 3, judge: 3 },
    ]);
    expect(m.rate).toBe(1);
    expect(m.exactRate).toBe(1);
    expect(m.meanAbsDiff).toBe(0);
    expect(m.acceptable).toBe(true);
  });

  it('相差 1 分算一致（人工标注本身也有 ±1 抖动）', () => {
    const m = computeCalibration([
      { human: 5, judge: 4 },
      { human: 3, judge: 4 },
    ]);
    expect(m.rate).toBe(1);
    // 但要单独报出精确一致率，让读者自己判断严格程度
    expect(m.exactRate).toBe(0);
  });

  it('相差 2 分及以上不算一致', () => {
    const m = computeCalibration([
      { human: 5, judge: 3 },
      { human: 4, judge: 4 },
    ]);
    expect(m.rate).toBe(0.5);
    expect(m.acceptable).toBe(false);
  });

  it('低于门槛时 acceptable 为 false 且 verdict 说明不可用', () => {
    const m = computeCalibration([
      { human: 5, judge: 2 },
      { human: 4, judge: 2 },
      { human: 3, judge: 3 },
    ]);
    expect(m.rate).toBeCloseTo(1 / 3, 3);
    expect(m.acceptable).toBe(false);
    expect(m.verdict).toContain('不可用于评测');
  });

  it('恰好达到门槛算通过（≥ 而不是 >）', () => {
    // 8/10 = 0.8，正好等于门槛
    const pairs = [
      ...Array.from({ length: 8 }, () => ({ human: 5, judge: 5 })),
      ...Array.from({ length: 2 }, () => ({ human: 5, judge: 2 })),
    ];
    const m = computeCalibration(pairs);
    expect(m.rate).toBe(CALIBRATION_THRESHOLD);
    expect(m.acceptable).toBe(true);
  });

  it('空校准集 → 不可接受（不能因"没数据"而当通过）', () => {
    const m = computeCalibration([]);
    expect(m.acceptable).toBe(false);
    expect(m.verdict).toContain('没有校准样本');
  });

  it('平均绝对偏差被算出（比一致率更细的信号）', () => {
    const m = computeCalibration([
      { human: 5, judge: 4 },
      { human: 5, judge: 3 },
    ]);
    expect(m.meanAbsDiff).toBe(1.5);
  });
});

describe('parseJudgeJson：容忍未转义引号（校准集抓出的真实 bug）', () => {
  it('严格 JSON 直接解析', () => {
    const r = parseJudgeJson('{"score":4,"reason":"理由"}') as { score: number; reason: string };
    expect(r.score).toBe(4);
    expect(r.reason).toBe('理由');
  });

  it('**reason 里含未转义双引号时仍能抽出分数**（这是关键场景）', () => {
    /**
     * 这条来自真实观测：judge 想引用输出里的话，就直接把英文引号打了进去，
     * 严格解析必然失败。但这条判定本身完全有效 ——
     * 一次格式抖动不该让整条判定作废（那是把格式问题误报成质量不合格）。
     */
    const malformed =
      '{ "score": 1, "reason": "输出称"命中率大约能省 30% 的成本"，材料只说命中单价为 2%，无此数字。" }';
    const r = parseJudgeJson(malformed) as { score: number; reason: string };
    expect(r).not.toBeNull();
    expect(r.score).toBe(1);
    // 理由可能多带一个尾巴，但不能丢内容
    expect(r.reason).toContain('命中率大约能省');
    expect(r.reason).toContain('材料只说');
  });

  it('代码块包裹 + 未转义引号也能处理', () => {
    const text = '```json\n{ "score": 3, "reason": "他说"这样不对"。" }\n```';
    const r = parseJudgeJson(text) as { score: number; reason: string };
    expect(r?.score).toBe(3);
  });

  it('完全无法解析时返回 null（不猜分数）', () => {
    expect(parseJudgeJson('这里没有任何 JSON')).toBeNull();
    expect(parseJudgeJson('')).toBeNull();
    // 有 reason 但没有 score → 不能猜分数，必须返回 null
    expect(parseJudgeJson('{"reason":"只有理由"}')).toBeNull();
  });

  it('分数是整数或小数都能取到', () => {
    expect((parseJudgeJson('{"score": 5, "reason":"x"}') as { score: number }).score).toBe(5);
    expect((parseJudgeJson('{"score": 4.0, "reason":"x"}') as { score: number }).score).toBe(4);
  });

  it('严格可解析时不会走容错路径（不改变正常结果）', () => {
    const r = parseJudgeJson('{"score":2,"reason":"a\\"b"}') as { __recovered?: boolean };
    expect(r.__recovered).toBeUndefined();
  });
});

describe('estimateRunCost：必须按真实材料估算成本', () => {
  const mkCase = (material: string, expectations: EvalAssertion[]) => ({
    caseId: 'c1',
    caseName: 'c1',
    weight: 1,
    isRegression: false,
    expectations,
    material,
    output: '一段输出',
  });

  it('**材料长度影响预估**（证明用的是 material 而不是 output）', () => {
    /**
     * 这条测试锁一个真实 bug：曾经 `material` 被错填成 `c.output`，
     * 于是 judge 被要求"判断输出有没有背离材料"，而材料就是输出 ——
     * faithfulness 断言因此无条件通过，形同虚设。
     *
     * 成本预估也跟着错了：真实材料通常是几千字的文档，比输出大得多，
     * 只按 output 估算会系统性低估 judge 成本。
     *
     * 这里用「完全相同的输出 + 长短不同的材料」来证明 material 真的被读取。
     */
    const judgeAssertion: EvalAssertion[] = [
      { kind: 'judge', value: { dimension: 'faithfulness', rubric: 'x' } },
    ];

    const short = estimateRunCost([mkCase('短材料', judgeAssertion)], 'deepseek-flash');
    const long = estimateRunCost(
      [mkCase('很长的源文档内容'.repeat(400), judgeAssertion)],
      'deepseek-flash',
    );

    expect(long.estimatedUsd).toBeGreaterThan(short.estimatedUsd);
    expect(long.judgeCalls).toBe(1);
    expect(short.judgeCalls).toBe(1);
  });

  it('没有 judge 断言时成本为 0', () => {
    const r = estimateRunCost([mkCase('材料', [{ kind: 'contains', value: 'x' }])], 'deepseek-flash');
    expect(r.judgeCalls).toBe(0);
    expect(r.estimatedUsd).toBe(0);
  });

  it('judge 调用次数 = judge 断言条数之和', () => {
    const r = estimateRunCost(
      [
        mkCase('材料', [
          { kind: 'judge', value: { dimension: 'faithfulness', rubric: 'x' } },
          { kind: 'contains', value: 'y' },
          { kind: 'judge', value: { dimension: 'relevance', rubric: 'z' } },
        ]),
        { ...mkCase('材料', [{ kind: 'judge', value: { dimension: 'faithfulness', rubric: 'x' } }]), caseId: 'c2' },
      ],
      'deepseek-flash',
    );
    expect(r.judgeCalls).toBe(3);
  });
});

describe('runEval：成本超限错误必须可被错误分类器识别', () => {
  /**
   * 锁一个真实 bug：成本超限原本用 `Object.assign(new Error(...), {code,statusCode})`
   * 构造，但路由层的 `handleError` / `classifyError` 用 `e instanceof LLMError` 判断。
   * 普通 Error 会落到「未知错误」分支 → 返回 500，把一个明确的 422 业务拒绝
   * 误报成服务端故障，用户按 500 去排查只会找错方向。
   *
   * 成本检查在**任何 DB 查询之前**执行，所以这里可以传一个空壳 prisma 来测分类。
   */
  it('抛出 LLMError(EVAL_COST_EXCEEDED, 422)，且 classifyError 原样返回', async () => {
    const error = await runEval({
      prisma: null as never,
      userId: 'u',
      datasetId: 'd',
      promptVersionId: 'p',
      templateId: 't',
      subjectModel: 'deepseek-flash',
      cases: [
        {
          caseId: 'c1',
          caseName: 'c1',
          weight: 1,
          isRegression: false,
          expectations: [{ kind: 'judge', value: { dimension: 'faithfulness', rubric: 'x' } }],
          material: '材料内容'.repeat(20),
          output: '一段输出',
        },
      ],
      maxCostUsd: 0,
      enableJudge: true,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LLMError);
    const llmError = error as LLMError;
    expect(llmError.code).toBe('EVAL_COST_EXCEEDED');
    expect(llmError.statusCode).toBe(422);
    expect(llmError.retryable).toBe(false);
    // classifyError 对已是 LLMError 的实例原样返回（路由据此映射 422 而不是 500）
    expect(classifyError(llmError)).toBe(llmError);
  });
});

describe('scoreCase：跳过 ≠ 失败（假警报的来源）', () => {
  const mk = (passed: boolean, extra: Partial<AssertionResult> = {}): AssertionResult => ({
    kind: 'contains',
    passed,
    reason: '',
    weight: 1,
    ...extra,
  });

  it('跳过的断言不计入分母', () => {
    const r = scoreCase([mk(true), mk(false, { skipped: true })]);
    expect(r.totalCount).toBe(1);
    expect(r.passedCount).toBe(1);
    expect(r.passed).toBe(true);
    expect(r.skippedCount).toBe(1);
    expect(r.score).toBe(1);
  });

  it('全部跳过 → evaluated 为 false（既不是通过也不是失败）', () => {
    /**
     * 这条锁一个真实缺陷：校准闸门拒绝某维度时，第一版把断言记成
     * `passed: false`，于是该用例算失败、报告说「检测到回归」——
     * 而实际上什么都没退化。假警报会训练用户忽略报告。
     */
    const r = scoreCase([mk(false, { skipped: true })]);
    expect(r.evaluated).toBe(false);
    expect(r.passed).toBe(false);
    expect(r.totalCount).toBe(0);
    expect(r.skippedCount).toBe(1);
  });

  it('混合：被评估的断言全过 → 通过，即使有跳过', () => {
    const r = scoreCase([mk(true), mk(true), mk(false, { skipped: true })]);
    expect(r.passed).toBe(true);
    expect(r.evaluated).toBe(true);
    expect(r.totalCount).toBe(2);
  });

  it('混合：被评估的断言里有失败 → 不通过', () => {
    const r = scoreCase([mk(true), mk(false), mk(false, { skipped: true })]);
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0.5);
    expect(r.skippedCount).toBe(1);
  });

  it('空列表 → evaluated 为 false', () => {
    const r = scoreCase([]);
    expect(r.evaluated).toBe(false);
  });
});

describe('buildRegressionReport：未评估的用例不产生假回归', () => {
  function mkCase(over: Partial<CaseResultInput> & { caseId: string }): CaseResultInput {
    return {
      caseName: over.caseId,
      weight: 1,
      isRegression: false,
      passed: true,
      score: 1,
      output: 'output',
      assertions: [],
      costUsd: 0.001,
      latencyMs: 1000,
      ...over,
    };
  }

  it('基线通过、本次未评估 → 判为 skipped 而**不是** regression', () => {
    const baseline: RunInput = {
      runId: 'r1',
      createdAt: '2026-10-16T00:00:00Z',
      promptVersion: 'v1',
      results: [mkCase({ caseId: 'c1', passed: true })],
    };
    const current: RunInput = {
      runId: 'r2',
      createdAt: '2026-10-16T01:00:00Z',
      promptVersion: 'v1',
      results: [mkCase({ caseId: 'c1', passed: false, evaluated: false, skippedCount: 1 })],
    };

    const report = buildRegressionReport(baseline, current);
    expect(report.summary.counts.skipped).toBe(1);
    expect(report.summary.counts.regression).toBe(0);
    expect(report.groups.skipped).toHaveLength(1);
    expect(report.groups.regressions).toHaveLength(0);
    expect(report.verdict.level).toBe('neutral');
  });

  it('未评估的用例不计入通过率分母', () => {
    const baseline: RunInput = {
      runId: 'r1',
      createdAt: '2026-10-16T00:00:00Z',
      promptVersion: 'v1',
      results: [
        mkCase({ caseId: 'c1', passed: true }),
        mkCase({ caseId: 'c2', passed: true }),
      ],
    };
    const current: RunInput = {
      runId: 'r2',
      createdAt: '2026-10-16T01:00:00Z',
      promptVersion: 'v1',
      results: [
        mkCase({ caseId: 'c1', passed: true }),
        // c2 未被评估：既不该拉低通过率，也不该算作通过
        mkCase({ caseId: 'c2', passed: false, evaluated: false }),
      ],
    };

    const report = buildRegressionReport(baseline, current);
    // 只统计 c1 → 1/1
    expect(report.summary.afterRate).toBe(1);
    expect(report.summary.counts.skipped).toBe(1);
  });

  it('未评估的用例会在结论里被提示', () => {
    const baseline: RunInput = {
      runId: 'r1',
      createdAt: '2026-10-16T00:00:00Z',
      promptVersion: 'v1',
      results: [mkCase({ caseId: 'c1' })],
    };
    const current: RunInput = {
      runId: 'r2',
      createdAt: '2026-10-16T01:00:00Z',
      promptVersion: 'v1',
      results: [mkCase({ caseId: 'c1', passed: false, evaluated: false })],
    };

    const report = buildRegressionReport(baseline, current);
    expect(report.verdict.concerns.some((c) => c.includes('未被完整评估'))).toBe(true);
  });
});

describe('assertJudgeIsIndependent', () => {
  it('judge 与被测模型相同时告警（自我偏好风险）', () => {
    const r = assertJudgeIsIndependent('deepseek-flash', 'deepseek-flash');
    expect(r.independent).toBe(false);
    // 不假装解决了，而是显式告警 —— 站点只有一个 provider 时这是必然
    expect(r.warning).toContain('自我偏好');
  });

  it('不同模型时不告警', () => {
    const r = assertJudgeIsIndependent('gpt-4o-mini', 'deepseek-flash');
    expect(r.independent).toBe(true);
    expect(r.warning).toBeUndefined();
  });
});

// ============================================================
// 回归报告
// ============================================================
function mkCase(over: Partial<CaseResultInput> & { caseId: string }): CaseResultInput {
  return {
    caseName: over.caseId,
    weight: 1,
    isRegression: false,
    passed: true,
    score: 1,
    output: 'output',
    assertions: [],
    costUsd: 0.001,
    latencyMs: 1000,
    ...over,
  };
}

function mkRun(over: Partial<RunInput> & { runId: string; results: CaseResultInput[] }): RunInput {
  return {
    createdAt: '2026-10-16T00:00:00Z',
    promptVersion: 'sys:summarize.long#v1',
    ...over,
  };
}

describe('buildRegressionReport：分组与判定', () => {
  it('通过 → 失败 判为 regression 并置顶', () => {
    const baseline = mkRun({ runId: 'r1', results: [mkCase({ caseId: 'c1', passed: true })] });
    const current = mkRun({ runId: 'r2', results: [mkCase({ caseId: 'c1', passed: false })] });

    const report = buildRegressionReport(baseline, current);
    expect(report.summary.counts.regression).toBe(1);
    expect(report.groups.regressions).toHaveLength(1);
    expect(report.verdict.level).toBe('regressed');
    expect(report.verdict.headline).toContain('回归');
  });

  it('失败 → 通过 判为 fixed', () => {
    const baseline = mkRun({ runId: 'r1', results: [mkCase({ caseId: 'c1', passed: false })] });
    const current = mkRun({ runId: 'r2', results: [mkCase({ caseId: 'c1', passed: true })] });

    const report = buildRegressionReport(baseline, current);
    expect(report.summary.counts.fixed).toBe(1);
    expect(report.verdict.level).toBe('improved');
  });

  it('输出逐字节相同 → unchanged（报告里折叠成计数，不用人核对）', () => {
    const baseline = mkRun({ runId: 'r1', results: [mkCase({ caseId: 'c1', output: '完全一样的输出' })] });
    const current = mkRun({ runId: 'r2', results: [mkCase({ caseId: 'c1', output: '完全一样的输出' })] });

    const report = buildRegressionReport(baseline, current);
    expect(report.summary.counts.unchanged).toBe(1);
    expect(report.groups.unchangedCount).toBe(1);
    expect(report.verdict.level).toBe('neutral');
  });

  it('都通过但输出不同 → changed（改写型变化，值得人看一眼）', () => {
    const baseline = mkRun({ runId: 'r1', results: [mkCase({ caseId: 'c1', output: '版本 A 的内容' })] });
    const current = mkRun({ runId: 'r2', results: [mkCase({ caseId: 'c1', output: '版本 B 的内容' })] });

    const report = buildRegressionReport(baseline, current);
    expect(report.summary.counts.changed).toBe(1);
    expect(report.groups.changed[0]?.diff).toBeDefined();
  });

  it('都通过但得分下降 → score_down', () => {
    const baseline = mkRun({ runId: 'r1', results: [mkCase({ caseId: 'c1', passed: true, score: 1, output: 'a' })] });
    const current = mkRun({ runId: 'r2', results: [mkCase({ caseId: 'c1', passed: true, score: 0.5, output: 'b' })] });

    const report = buildRegressionReport(baseline, current);
    expect(report.summary.counts.score_down).toBe(1);
    expect(report.verdict.concerns.some((c) => c.includes('得分下降'))).toBe(true);
  });

  it('新增与缺失的用例被分别归类', () => {
    const baseline = mkRun({ runId: 'r1', results: [mkCase({ caseId: 'old' })] });
    const current = mkRun({ runId: 'r2', results: [mkCase({ caseId: 'new' })] });

    const report = buildRegressionReport(baseline, current);
    expect(report.summary.counts.new).toBe(1);
    expect(report.summary.counts.removed).toBe(1);
    // 用例缺失是要提醒的（可能被误禁用）
    expect(report.verdict.concerns.some((c) => c.includes('缺失'))).toBe(true);
  });

  it('高权重用例回归被单独强调', () => {
    const baseline = mkRun({ runId: 'r1', results: [mkCase({ caseId: 'c1', passed: true, weight: 3, caseName: '关键用例' })] });
    const current = mkRun({ runId: 'r2', results: [mkCase({ caseId: 'c1', passed: false, weight: 3, caseName: '关键用例' })] });

    const report = buildRegressionReport(baseline, current);
    expect(report.verdict.concerns.some((c) => c.includes('高权重'))).toBe(true);
  });

  it('**回归优先于改善**：即使总通过率上升，有回归就必须判 regressed', () => {
    // 这是刻意的判定顺序：通过率上升可能来自别处改善，
    // 而回归是确凿的退步，不能被平均数掩盖
    const baseline = mkRun({
      runId: 'r1',
      results: [
        mkCase({ caseId: 'c1', passed: true }),
        mkCase({ caseId: 'c2', passed: false }),
        mkCase({ caseId: 'c3', passed: false }),
      ],
    });
    const current = mkRun({
      runId: 'r2',
      results: [
        mkCase({ caseId: 'c1', passed: false }), // 回归
        mkCase({ caseId: 'c2', passed: true }), // 修复
        mkCase({ caseId: 'c3', passed: true }), // 修复
      ],
    });

    const report = buildRegressionReport(baseline, current);
    // 通过率从 1/3 升到 2/3，但因为有回归，结论必须是 regressed
    expect(report.summary.afterRate).toBeGreaterThan(report.summary.beforeRate);
    expect(report.verdict.level).toBe('regressed');
  });

  it('找出「之前通过、现在失败」的具体断言', () => {
    const baseline = mkRun({
      runId: 'r1',
      results: [
        mkCase({
          caseId: 'c1',
          passed: true,
          assertions: [
            { kind: 'contains', passed: true, reason: 'ok', weight: 1 },
            { kind: 'agent_evidence_rate', passed: true, reason: 'ok', weight: 1 },
          ],
        }),
      ],
    });
    const current = mkRun({
      runId: 'r2',
      results: [
        mkCase({
          caseId: 'c1',
          passed: false,
          assertions: [
            { kind: 'contains', passed: true, reason: 'ok', weight: 1 },
            { kind: 'agent_evidence_rate', passed: false, reason: '证据链 40%', weight: 1 },
          ],
        }),
      ],
    });

    const report = buildRegressionReport(baseline, current);
    expect(report.groups.newlyFailedAssertions).toHaveLength(1);
    expect(report.groups.newlyFailedAssertions[0]?.kind).toBe('agent_evidence_rate');
    expect(report.groups.newlyFailedAssertions[0]?.reason).toContain('40%');
  });

  it('本来就没通过的断言不会被算成 newlyFailed', () => {
    const failing = { kind: 'contains' as const, passed: false, reason: '一直没过', weight: 1 };
    const baseline = mkRun({ runId: 'r1', results: [mkCase({ caseId: 'c1', passed: false, assertions: [failing] })] });
    const current = mkRun({ runId: 'r2', results: [mkCase({ caseId: 'c1', passed: false, assertions: [failing] })] });

    const report = buildRegressionReport(baseline, current);
    expect(report.groups.newlyFailedAssertions).toHaveLength(0);
  });

  it('judge 配置变化被检测并告警（分数不可直接比较）', () => {
    const baseline = mkRun({
      runId: 'r1',
      results: [mkCase({ caseId: 'c1' })],
      judgePromptVersion: 'judge-aaaa1111',
    });
    const current = mkRun({
      runId: 'r2',
      results: [mkCase({ caseId: 'c1' })],
      judgePromptVersion: 'judge-bbbb2222',
    });

    const report = buildRegressionReport(baseline, current);
    expect(report.judgeChanged).toBe(true);
    expect(report.judgeWarning).toContain('不能');
    expect(report.verdict.concerns.some((c) => c.includes('judge'))).toBe(true);
  });

  it('**judge 变化本身不算回归**（量尺变了 ≠ 被测物变差）', () => {
    // 这个区分很重要：把两者混为一谈会让人去改本不需要改的 prompt
    const baseline = mkRun({
      runId: 'r1',
      results: [mkCase({ caseId: 'c1', output: 'same' })],
      judgePromptVersion: 'judge-aaaa1111',
    });
    const current = mkRun({
      runId: 'r2',
      results: [mkCase({ caseId: 'c1', output: 'same' })],
      judgePromptVersion: 'judge-bbbb2222',
    });

    const report = buildRegressionReport(baseline, current);
    expect(report.summary.counts.regression).toBe(0);
    expect(report.verdict.level).toBe('neutral');
  });

  it('judge 模型变化也被检测', () => {
    const baseline = mkRun({ runId: 'r1', results: [mkCase({ caseId: 'c1' })], judgeModel: 'm1' });
    const current = mkRun({ runId: 'r2', results: [mkCase({ caseId: 'c1' })], judgeModel: 'm2' });
    expect(buildRegressionReport(baseline, current).judgeChanged).toBe(true);
  });

  it('汇总指标：通过率、加权通过率、平均得分、成本、延迟', () => {
    const baseline = mkRun({
      runId: 'r1',
      results: [
        mkCase({ caseId: 'c1', passed: true, weight: 2, costUsd: 0.01, latencyMs: 1000 }),
        mkCase({ caseId: 'c2', passed: false, weight: 1, costUsd: 0.02, latencyMs: 3000 }),
      ],
    });
    const current = mkRun({
      runId: 'r2',
      results: [
        mkCase({ caseId: 'c1', passed: true, weight: 2, costUsd: 0.005, latencyMs: 500 }),
        mkCase({ caseId: 'c2', passed: true, weight: 1, costUsd: 0.005, latencyMs: 500 }),
      ],
    });

    const report = buildRegressionReport(baseline, current);
    expect(report.summary.beforeRate).toBe(0.5);
    expect(report.summary.afterRate).toBe(1);
    expect(report.summary.beforeWeighted).toBeCloseTo(2 / 3, 3);
    expect(report.summary.afterWeighted).toBe(1);
    expect(report.summary.beforeCostUsd).toBeCloseTo(0.03, 5);
    expect(report.summary.afterCostUsd).toBeCloseTo(0.01, 5);
    // 成本下降了
    expect(report.summary.costDeltaPct).toBeLessThan(0);
    expect(report.summary.beforeAvgLatencyMs).toBe(2000);
  });

  it('空结果集不崩溃', () => {
    const report = buildRegressionReport(
      mkRun({ runId: 'r1', results: [] }),
      mkRun({ runId: 'r2', results: [] }),
    );
    expect(report.summary.totalCases).toBe(0);
    expect(report.verdict.level).toBe('neutral');
  });

  it('成本基线为 0 时不产生 NaN/Infinity', () => {
    const baseline = mkRun({ runId: 'r1', results: [mkCase({ caseId: 'c1', costUsd: 0 })] });
    const current = mkRun({ runId: 'r2', results: [mkCase({ caseId: 'c1', costUsd: 0.01 })] });
    const report = buildRegressionReport(baseline, current);
    expect(Number.isFinite(report.summary.costDeltaPct)).toBe(true);
    expect(report.summary.costDeltaPct).toBe(0);
  });
});

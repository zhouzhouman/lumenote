import { describe, it, expect } from 'vitest';
import { parseStructuredOutput, extractDisplayText } from '@/lib/agent/loop';
import { normalizeStructured } from '@/lib/agent/output';
import type { AgentStructuredOutput } from '@/lib/agent/loop';

/**
 * 结构化输出解析与展示文本剥离的表征测试。
 *
 * 这两个函数是「模型输出不规范」与「任务失败」之间的缓冲层：
 * 解析必须尽力而为（残缺 JSON、代码块包裹、额外字段、中文键名），
 * 展示必须宁多勿空（剥不出内容就保留原文）。
 */

const SIMPLE = '{"conclusions":[{"text":"a","evidence":[]}]}';

// ============================================================
// parseStructuredOutput：容错解析
// ============================================================
describe('parseStructuredOutput：包装与残缺输入', () => {
  it('纯 JSON 直接解析', () => {
    expect(parseStructuredOutput(SIMPLE)?.conclusions[0]?.text).toBe('a');
  });

  it('```json 代码块（带语言标记）', () => {
    const r = parseStructuredOutput(`以下是结论：\n\`\`\`json\n${SIMPLE}\n\`\`\`\n希望有帮助`);
    expect(r?.conclusions[0]?.text).toBe('a');
  });

  it('``` 代码块（不带语言标记）', () => {
    const r = parseStructuredOutput(`\`\`\`\n${SIMPLE}\n\`\`\``);
    expect(r?.conclusions[0]?.text).toBe('a');
  });

  it('多个代码块时取第一个能解析成结构的', () => {
    const r = parseStructuredOutput(
      '```json\n{"foo":1}\n```\n```json\n{"conclusions":["结论"]}\n```',
    );
    expect(r?.conclusions[0]?.text).toBe('结论');
  });

  it('JSON 前后有解释文字也能解析出中间的 JSON', () => {
    const r = parseStructuredOutput(
      '我分析后认为：{"conclusions":[{"text":"a","evidence":[{"source":"chunk:1","quote":"q"}]}]} 以上。',
    );
    expect(r?.conclusions[0]?.evidence).toHaveLength(1);
  });

  it('空内容 / 纯空白返回 null（ADR-0003：JSON 模式可能返回空 content）', () => {
    expect(parseStructuredOutput('')).toBeNull();
    expect(parseStructuredOutput('   \n\t ')).toBeNull();
  });

  it('无法解析时返回 null 而不是抛错', () => {
    expect(parseStructuredOutput('这完全不是 JSON')).toBeNull();
    expect(parseStructuredOutput('{"conclusions": [{"text": "a"')).toBeNull();
    expect(parseStructuredOutput('{"conclusions":[{"text":"a",}]}')).toBeNull();
  });

  it('合法 JSON 但没有 conclusions 字段 → null', () => {
    expect(parseStructuredOutput('{}')).toBeNull();
    expect(parseStructuredOutput('{"foo":1}')).toBeNull();
    expect(parseStructuredOutput('{"conclusions":"not-array"}')).toBeNull();
    expect(parseStructuredOutput('[{"text":"a"}]')).toBeNull();
    expect(parseStructuredOutput('null')).toBeNull();
  });
});

describe('parseStructuredOutput：归一化与宽容字段', () => {
  it('conclusions 是字符串数组时保留文本，证据为空', () => {
    const r = parseStructuredOutput('{"conclusions":["结论一","结论二"]}');
    expect(r?.conclusions).toEqual([
      { text: '结论一', evidence: [] },
      { text: '结论二', evidence: [] },
    ]);
  });

  it('缺少 evidence 字段 → 归一化为空数组（不丢弃结论）', () => {
    const r = parseStructuredOutput('{"conclusions":[{"text":"a"}]}');
    expect(r?.conclusions[0]?.evidence).toEqual([]);
  });

  it('证据字段类型不对时被过滤，保留合法证据', () => {
    const r = parseStructuredOutput(
      '{"conclusions":[{"text":"a","evidence":[{"source":"chunk:1","quote":"q"},{"bad":1},"字符串",null]}]}',
    );
    expect(r?.conclusions[0]?.evidence).toEqual([{ source: 'chunk:1', quote: 'q' }]);
  });

  it('只带 source 或只带 quote 的证据仍保留（交给后续校验判缺失）', () => {
    const r = parseStructuredOutput(
      '{"conclusions":[{"text":"a","evidence":[{"source":"chunk:1"},{"quote":"q"}]}]}',
    );
    expect(r?.conclusions[0]?.evidence).toEqual([
      { source: 'chunk:1', quote: '' },
      { source: '', quote: 'q' },
    ]);
  });

  it('空 text / 非对象结论被丢弃', () => {
    const r = parseStructuredOutput(
      '{"conclusions":[{"text":""},{"text":"keep"},null,1,{"foo":"bar"}]}',
    );
    expect(r?.conclusions).toEqual([{ text: 'keep', evidence: [] }]);
  });

  it('中文键名宽容：conclusions → 结论 / conclusion，limitations → 局限 / 限制', () => {
    const byCn = parseStructuredOutput('{"结论":[{"text":"中文结论"}]}');
    expect(byCn?.conclusions[0]?.text).toBe('中文结论');

    const byEnSingle = parseStructuredOutput('{"conclusion":["单数" ]}');
    expect(byEnSingle?.conclusions[0]?.text).toBe('单数');

    expect(parseStructuredOutput('{"conclusions":[],"局限":["已知局限"]}')?.limitations).toEqual([
      '已知局限',
    ]);
    expect(parseStructuredOutput('{"conclusions":[],"限制":["限制一"]}')?.limitations).toEqual([
      '限制一',
    ]);
  });

  it('conclusion 条目里的中文 text 键也能识别', () => {
    const r = parseStructuredOutput('{"conclusions":[{"结论":"中文正文"}]}');
    expect(r?.conclusions[0]?.text).toBe('中文正文');
  });

  it('confidence：只有非空字符串才保留', () => {
    expect(parseStructuredOutput('{"conclusions":[{"text":"a","confidence":"high"}]}')?.conclusions[0]?.confidence).toBe('high');
    expect(parseStructuredOutput('{"conclusions":[{"text":"a","confidence":""}]}')?.conclusions[0]).toEqual({
      text: 'a',
      evidence: [],
    });
    expect(parseStructuredOutput('{"conclusions":[{"text":"a","confidence":3}]}')?.conclusions[0]).toEqual({
      text: 'a',
      evidence: [],
    });
  });

  it('limitations：只保留字符串项；非数组则忽略', () => {
    const r = parseStructuredOutput('{"conclusions":[],"limitations":["a",1,"b"]}');
    expect(r?.limitations).toEqual(['a', 'b']);
    expect(parseStructuredOutput('{"conclusions":[],"limitations":"x"}')?.limitations).toBeUndefined();
    expect(parseStructuredOutput('{"conclusions":[]}')?.limitations).toBeUndefined();
  });

  it('额外字段被忽略（不污染结果形状）', () => {
    const r = parseStructuredOutput(
      '{"conclusions":[{"text":"a","evidence":[],"extra":1}],"foo":{"bar":1},"usage":123}',
    );
    expect(r).toEqual({ conclusions: [{ text: 'a', evidence: [] }] });
  });
});

// ============================================================
// extractDisplayText：剥掉机器格式
// ============================================================
describe('extractDisplayText：给用户看的散文', () => {
  const structured: AgentStructuredOutput = {
    conclusions: [{ text: 'a', evidence: [] }],
  };

  it('空输入返回空串', () => {
    expect(extractDisplayText('', structured)).toBe('');
    expect(extractDisplayText('', null)).toBe('');
  });

  it('没有解析出结构时原样返回（避免误删正文里的正常 JSON 示例）', () => {
    expect(extractDisplayText('这里是一个 JSON 示例：{"a":1}', null)).toBe(
      '这里是一个 JSON 示例：{"a":1}',
    );
  });

  it('剥掉 ```json 代码块，保留前后散文', () => {
    const text = `以下是分析结果：\n\`\`\`json\n${SIMPLE}\n\`\`\`\n希望有帮助`;
    const out = extractDisplayText(text, structured);
    expect(out).toBe('以下是分析结果：\n\n希望有帮助');
    expect(out).not.toContain('conclusions');
  });

  it('剥掉多个代码块', () => {
    const out = extractDisplayText('前文\n```json\n{"a":1}\n```\n中间\n```json\n{"b":2}\n```\n后文', structured);
    expect(out).toBe('前文\n\n中间\n\n后文');
  });

  it('只有代码块时保留原文（宁多勿空）', () => {
    const text = `\`\`\`json\n${SIMPLE}\n\`\`\``;
    expect(extractDisplayText(text, structured)).toBe(text.trim());
  });

  it('裸 JSON 即使解析成功也原样保留（长度 ≥ 20 时不剥）', () => {
    // 这是当前实现的真实行为：裸 JSON 剥离分支只对短文本生效
    expect(extractDisplayText(SIMPLE, structured)).toBe(SIMPLE);
  });

  it('极短的裸 JSON 位于短散文中间时被剥掉', () => {
    expect(extractDisplayText('前{"a":1}后', structured)).toBe('前后');
  });

  it('没有 JSON 的纯散文原样保留（只做 trim）', () => {
    expect(extractDisplayText('  这是一段纯说明文字，没有任何 JSON。  ', structured)).toBe(
      '这是一段纯说明文字，没有任何 JSON。',
    );
  });
});

// ============================================================
// normalizeStructured：模块级归一化（拆分后新增）
// ============================================================
describe('normalizeStructured：直接归一化任意 JSON 值', () => {
  it('非对象 / 数组 / 空值 → null', () => {
    expect(normalizeStructured(null)).toBeNull();
    expect(normalizeStructured(undefined)).toBeNull();
    expect(normalizeStructured(42)).toBeNull();
    expect(normalizeStructured('str')).toBeNull();
    expect(normalizeStructured([])).toBeNull();
    expect(normalizeStructured([{ text: 'a' }])).toBeNull();
  });

  it('合法对象 → 补齐 evidence 与 limitations', () => {
    expect(normalizeStructured({ conclusions: [{ text: 'a' }] })).toEqual({
      conclusions: [{ text: 'a', evidence: [] }],
    });
    expect(normalizeStructured({ conclusions: [], limitations: ['缺数据'] })).toEqual({
      conclusions: [],
      limitations: ['缺数据'],
    });
  });

  it('中文单数键名兜底，但单数形式必须是数组', () => {
    expect(normalizeStructured({ conclusion: ['单数'] })).toEqual({
      conclusions: [{ text: '单数', evidence: [] }],
    });
    expect(normalizeStructured({ conclusion: { text: 'a' } })).toBeNull();
  });

  it('证据项归一化：只保留至少有一个字符串字段的对象', () => {
    expect(
      normalizeStructured({
        conclusions: [
          {
            text: 'a',
            evidence: [
              { source: 'chunk:1', quote: 'q' },
              { source: 'chunk:2' },
              { quote: 'q' },
              {},
              null,
              'x',
            ],
          },
        ],
      }),
    ).toEqual({
      conclusions: [
        {
          text: 'a',
          evidence: [
            { source: 'chunk:1', quote: 'q' },
            { source: 'chunk:2', quote: '' },
            { source: '', quote: 'q' },
          ],
        },
      ],
    });
  });
});
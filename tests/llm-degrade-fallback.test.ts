import { describe, it, expect } from 'vitest';
import { extractSourceText, heuristicSummary } from '@/lib/llm/budget';

/**
 * 降级分支的回归测试。
 *
 * 起因是一个真实缺陷：所有 AI 通道都不可用时，本地规则提取把**拼好的 prompt**
 * 当成了摘要返回，用户看到的结果是内部提示词原文：
 *
 *   <document> # 目标读者 普通读者 # 需要的要点数量 5 <document> 最美的风景…
 *
 * 两个后果：① 用户以为功能坏了；② prompt 结构泄漏给终端用户。
 */
const DOC =
  '最美的风景在最不经意的时刻，矫首暇观，淡淡心境。最美的自我是追寻，最美的人生在路上。' +
  '那些年，匆匆走过，不曾看见路边的落叶飘飘。有风和日丽，鸟语花香，在暮春的时光看小草的新绿。' +
  '更有甚者，涩涩的花瓣含苞待放，欲放含羞，微风中随绿色的荷叶轻轻摇曳婀娜的身姿。';

/** 模拟真实调用处的构造方式：模板自身带一层 <document>，wrapUntrusted 又套一层 */
function buildPrompt(doc: string): string {
  const rendered =
    '# 目标读者 普通读者\n# 需要的要点数量 5\n<document>' + doc + '</document>';
  return `<document>${rendered}</document>\n\n## 本次任务\n请输出不超过 5 条要点。`;
}

describe('extractSourceText：从 prompt 里捞回正文', () => {
  it('剥掉嵌套的 <document> 标签', () => {
    const out = extractSourceText(buildPrompt(DOC));
    expect(out).not.toContain('<document>');
    expect(out).not.toContain('</document>');
    expect(out).toContain('最美的风景在最不经意的时刻');
  });

  it('丢掉模板渲染出的参数头（# 目标读者 / # 需要的要点数量）', () => {
    const out = extractSourceText(buildPrompt(DOC));
    expect(out).not.toContain('目标读者');
    expect(out).not.toContain('需要的要点数量');
    expect(out).not.toContain('普通读者');
  });

  it('丢掉最后一个 </document> 之后追加的指令段', () => {
    const out = extractSourceText(buildPrompt(DOC));
    expect(out).not.toContain('本次任务');
    expect(out).not.toContain('请输出不超过');
  });

  it('没有 <document> 包裹时按原样返回（不误伤纯文本输入）', () => {
    expect(extractSourceText('一段没有任何标签的正文。')).toBe('一段没有任何标签的正文。');
  });
});

describe('heuristicSummary：降级结果的形式承诺', () => {
  it('不再把 prompt 脚手架当摘要（回归）', () => {
    const { summary } = heuristicSummary(extractSourceText(buildPrompt(DOC)), { maxPoints: 5 });
    expect(summary).not.toContain('<document>');
    expect(summary).not.toContain('目标读者');
    expect(summary).toContain('降级结果');
  });

  it('要点式：输出编号列表，条数不超过 maxPoints', () => {
    const { summary, degraded } = heuristicSummary(extractSourceText(buildPrompt(DOC)), {
      maxPoints: 3,
    });
    const numbered = summary.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(degraded).toBe(true);
    expect(numbered.length).toBeGreaterThan(0);
    expect(numbered.length).toBeLessThanOrEqual(3);
    expect(numbered[0]).toMatch(/^1\. /);
  });

  it('要点式：编号连续且按原文顺序（不是打分顺序）', () => {
    const text = '第一句讲背景。第二句给数据 42%。第三句说结论。第四句是补充。';
    const { summary } = heuristicSummary(text, { maxPoints: 4 });
    const lines = summary.split('\n').filter((l) => /^\d+\. /.test(l));
    const idx = lines.map((l) => text.indexOf(l.replace(/^\d+\. /, '')));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(lines.map((l) => l.split('.')[0])).toEqual(
      lines.map((_, i) => String(i + 1)),
    );
  });

  it('段落式（maxPoints=0）：正文较短时原样给出，但仍带降级标记', () => {
    const { summary } = heuristicSummary('短正文一句。', {});
    expect(summary).toContain('降级结果');
    expect(summary).toContain('短正文一句。');
  });

  it('空正文时给出可读提示，而不是空字符串或异常', () => {
    const { summary, degraded } = heuristicSummary('   ', { maxPoints: 5 });
    expect(degraded).toBe(true);
    expect(summary).toContain('正文为空');
  });
});

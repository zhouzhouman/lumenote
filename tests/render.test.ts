import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  validateVariables,
  extractVariables,
  promptHash,
  TemplateRenderError,
} from '@/lib/pipeline/prompts/render';

describe('renderTemplate', () => {
  it('替换占位符', () => {
    expect(renderTemplate('用{{ style }}风格总结', { style: '要点式' })).toBe('用要点式风格总结');
  });

  it('容忍占位符内的空格', () => {
    expect(renderTemplate('{{style}}', { style: 'A' })).toBe('A');
    expect(renderTemplate('{{  style  }}', { style: 'A' })).toBe('A');
  });

  it('未提供的可选变量替换为空字符串，而不是留下 {{x}}', () => {
    // 留下占位符会让模型把 {{x}} 当成字面量，输出里出现奇怪内容
    const out = renderTemplate('风格：{{ style }}', {});
    expect(out).toBe('风格：');
  });

  it('用户传入优先于 default', () => {
    const defs = [{ key: 'style', label: '风格', default: '要点式' }];
    expect(renderTemplate('{{style}}', { style: '叙事式' }, defs)).toBe('叙事式');
    expect(renderTemplate('{{style}}', {}, defs)).toBe('要点式');
  });

  it('空白字符串视为未提供，回落到 default', () => {
    const defs = [{ key: 'style', label: '风格', default: '要点式' }];
    expect(renderTemplate('{{style}}', { style: '   ' }, defs)).toBe('要点式');
  });

  it('必填变量缺失时抛错，而不是静默填空', () => {
    const defs = [{ key: 'style', label: '风格', required: true }];
    expect(() => renderTemplate('{{style}}', {}, defs)).toThrow(TemplateRenderError);
    try {
      renderTemplate('{{style}}', {}, defs);
    } catch (e) {
      expect((e as TemplateRenderError).missingVars).toEqual(['style']);
    }
  });

  /**
   * 这是 DeepSeek 前缀缓存能否命中的关键：
   * 渲染结果中「稳定部分」必须逐字节一致，只有变量位置不同。
   */
  it('稳定前缀在变量不同的情况下保持一致', () => {
    const tpl = '你是一个专业摘要助手。\n要求：忠实原文。\n风格：{{style}}\n正文：{{body}}';
    const a = renderTemplate(tpl, { style: '要点式', body: 'AAA' });
    const b = renderTemplate(tpl, { style: '叙事式', body: 'BBB' });

    const stableLen = '你是一个专业摘要助手。\n要求：忠实原文。\n风格：'.length;
    expect(a.slice(0, stableLen)).toBe(b.slice(0, stableLen));
  });
});

describe('validateVariables', () => {
  const defs = [
    { key: 'style', label: '风格', type: 'enum' as const, options: ['要点式', '叙事式'] },
    { key: 'maxPoints', label: '要点数', type: 'number' as const },
    { key: 'target', label: '读者', required: true },
  ];

  it('合法输入通过', () => {
    expect(() =>
      validateVariables({ style: '要点式', maxPoints: '5', target: '产品经理' }, defs),
    ).not.toThrow();
  });

  it('枚举值不在白名单时报错', () => {
    expect(() => validateVariables({ style: '乱填', target: 'x' }, defs)).toThrow(/风格/);
  });

  it('数字字段收到非数字时报错', () => {
    expect(() => validateVariables({ maxPoints: '很多', target: 'x' }, defs)).toThrow(/数字/);
  });

  it('多个错误合并成一条信息，而不是只报第一个', () => {
    // 逐条报会让用户反复提交试错，体验很差
    try {
      validateVariables({ style: '乱填', maxPoints: 'abc', target: 'x' }, defs);
      expect.unreachable('应当抛错');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('风格');
      expect(msg).toContain('数字');
    }
  });

  it('必填缺失时报错', () => {
    expect(() => validateVariables({}, defs)).toThrow(/必填/);
  });
});

describe('extractVariables', () => {
  it('去重并保序', () => {
    expect(extractVariables('{{a}} {{b}} {{a}} {{ c }}')).toEqual(['a', 'b', 'c']);
  });

  it('无占位符返回空数组', () => {
    expect(extractVariables('没有变量')).toEqual([]);
  });
});

describe('promptHash', () => {
  it('相同输入得到相同哈希', () => {
    expect(promptHash('sys', 'prompt')).toBe(promptHash('sys', 'prompt'));
  });

  it('内容不同则哈希不同', () => {
    expect(promptHash('sys', 'a')).not.toBe(promptHash('sys', 'b'));
  });

  it('分隔符防止拼接歧义（a+bc 与 ab+c 不应同哈希）', () => {
    expect(promptHash('a', 'bc')).not.toBe(promptHash('ab', 'c'));
  });

  it('输出为固定 8 位十六进制', () => {
    expect(promptHash('x', 'y')).toMatch(/^[0-9a-f]{8}$/);
  });
});
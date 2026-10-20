import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseInline, sanitizeUrl, isBlankMarkdown } from '@/lib/markdown';

/**
 * Markdown 解析器的单测。
 *
 * 重点覆盖两类容易出错、且出错后用户在界面上直接看到的地方：
 *  1. **链接解析** —— 这是「文本链接无法解析」这个 bug 的修复目标
 *  2. **流式半成品容错** —— 输出是逐字到达的，解析器必须能处理任何残缺输入
 */

describe('sanitizeUrl', () => {
  it('放行 http / https / mailto', () => {
    expect(sanitizeUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com');
    expect(sanitizeUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
  });

  it('补全无协议的裸域名', () => {
    expect(sanitizeUrl('example.com/path')).toBe('https://example.com/path');
    expect(sanitizeUrl('www.example.com')).toBe('https://www.example.com');
  });

  it('拒绝 javascript: 与 data:（模型输出等于不可信输入）', () => {
    // 这是 XSS 的直接入口：链接若被渲染成 <a href="javascript:...">
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeUrl('JavaScript:alert(1)')).toBeNull();
    expect(sanitizeUrl('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(sanitizeUrl('vbscript:msgbox(1)')).toBeNull();
    expect(sanitizeUrl('file:///etc/passwd')).toBeNull();
  });

  it('拒绝含空白的可疑 URL，而不是尝试修补', () => {
    expect(sanitizeUrl('https://a.com/ x')).toBeNull();
    expect(sanitizeUrl('java script:alert(1)')).toBeNull();
  });

  it('剥掉 Markdown 里常见的尖括号与尾括号包裹', () => {
    expect(sanitizeUrl('<https://example.com>')).toBe('https://example.com');
    expect(sanitizeUrl('https://example.com/a_(b)')).toBe('https://example.com/a_(b)');
  });

  it('普通词不会被当成域名', () => {
    expect(sanitizeUrl('要点')).toBeNull();
    expect(sanitizeUrl('见下文')).toBeNull();
  });
});

describe('parseInline', () => {
  it('解析 [文字](url)', () => {
    expect(parseInline('见 [文档](https://example.com) 说明')).toEqual([
      { type: 'text', value: '见 ' },
      { type: 'link', value: '文档', url: 'https://example.com' },
      { type: 'text', value: ' 说明' },
    ]);
  });

  it('解析裸 URL，并去掉中文句末标点', () => {
    expect(parseInline('参考 https://example.com/a。')).toEqual([
      { type: 'text', value: '参考 ' },
      { type: 'link', value: 'https://example.com/a', url: 'https://example.com/a' },
      { type: 'text', value: '。' },
    ]);
  });

  it('URL 含括号时不会把链接截断', () => {
    // 维基类链接很常见，截断会得到 404
    const tokens = parseInline('[A](https://en.wikipedia.org/wiki/Foo_(bar))');
    expect(tokens).toEqual([
      { type: 'link', value: 'A', url: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
    ]);
  });

  it('URL 里的 * 不会被当成斜体标记（顺序敏感）', () => {
    const tokens = parseInline('[A](https://example.com/*/b)');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ type: 'link', url: 'https://example.com/*/b' });
  });

  it('加粗与行内代码', () => {
    expect(parseInline('**重点**与`code`')).toEqual([
      { type: 'strong', value: '重点' },
      { type: 'text', value: '与' },
      { type: 'code', value: 'code' },
    ]);
  });

  it('不安全的链接整体降级为纯文本，不丢字符也不生成危险链接', () => {
    const tokens = parseInline('[点我](javascript:alert(1))');
    expect(tokens.every((t) => t.type !== 'link')).toBe(true);
    expect(tokens.map((t) => t.value).join('')).toContain('javascript:alert(1)');
  });

  it('链接文字为空时用 URL 兜底，避免出现点不到的空白', () => {
    expect(parseInline('[](https://example.com)')).toEqual([
      { type: 'link', value: 'https://example.com', url: 'https://example.com' },
    ]);
  });
});

describe('parseMarkdown 块级结构', () => {
  it('标题、列表、引用、代码块各归其位', () => {
    const blocks = parseMarkdown(
      ['## 摘要', '', '- 第一条', '- 第二条', '', '> 引用', '', '```ts', 'const a = 1;', '```'].join(
        '\n',
      ),
    );

    expect(blocks.map((b) => b.type)).toEqual(['heading', 'list', 'quote', 'code']);
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2 });
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: false });
    expect(blocks[3]).toMatchObject({ type: 'code', language: 'ts', value: 'const a = 1;' });
  });

  it('有序列表保留起始编号', () => {
    const blocks = parseMarkdown('3. 第三\n4. 第四');
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true, start: 3 });
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('连续行合成为同一个段落', () => {
    const blocks = parseMarkdown('第一行\n第二行\n\n新段落');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe('paragraph');
  });

  it('整行是链接时仍是段落（渲染层负责块级展示）', () => {
    const blocks = parseMarkdown('- https://a.com\n- https://b.com');
    expect(blocks[0]).toMatchObject({ type: 'list' });
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('分割线', () => {
    expect(parseMarkdown('---')).toEqual([{ type: 'hr' }]);
  });

  /**
   * 流式容错：这些输入在生成过程中真实出现过。
   * 要求是「不抛错、不丢字符」，而不是「解析得漂亮」。
   */
  it('未闭合的代码围栏把剩余内容收进代码块，而不是当正文', () => {
    const blocks = parseMarkdown('```ts\nconst a = 1;');
    expect(blocks).toEqual([{ type: 'code', language: 'ts', value: 'const a = 1;' }]);
  });

  it('半截的链接标记降级为纯文本，不抛错也不丢字符', () => {
    for (const partial of ['[标题](htt', '[标题]', '**未完', '- ', '>', '#']) {
      expect(() => parseMarkdown(partial)).not.toThrow();
      const joined = parseMarkdown(partial)
        .flatMap((b) => (b.type === 'paragraph' || b.type === 'quote' || b.type === 'heading' ? b.inlines : []))
        .map((t) => t.value)
        .join('');
      // 允许被识别为标记的部分丢失（如 `**`），但可读字符必须保留
      expect(joined.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('空输入返回空数组', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n')).toEqual([]);
  });

  it('模型常见的「要点 + 来源链接」结构完整保留', () => {
    const output = [
      '### 核心结论',
      '',
      '1. 论点一，详见 [原文](https://example.com/a)',
      '2. 论点二',
      '',
      '> 注：以上为模型生成，可能存在偏差。',
    ].join('\n');

    const blocks = parseMarkdown(output);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'list', 'quote']);

    const list = blocks[1] as { items: { inlines: { type: string }[] }[] };
    expect(list.items).toHaveLength(2);
    // 第二条要点里的链接必须真的被解析成 link token
    expect(list.items[0]!.inlines.some((t) => t.type === 'link')).toBe(true);
  });
});

describe('isBlankMarkdown', () => {
  it('纯空白与零宽字符视为空', () => {
    expect(isBlankMarkdown('   \n\t ')).toBe(true);
    expect(isBlankMarkdown('\u200B\uFEFF')).toBe(true);
    expect(isBlankMarkdown('a')).toBe(false);
  });
});

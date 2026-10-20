import { describe, it, expect } from 'vitest';
import { diffLines, isSameSource, sourceFingerprint } from '@/lib/tasks/diff';

/**
 * diff 算法单测。
 *
 * LCS + 回溯是「容易写对一半」的典型：正向判断行相等很简单，
 * 但回溯时的取舍顺序、收尾剩余行、空行处理都容易漏。
 * 所以这里重点覆盖边界（空输入、全等、全不同、末尾增删、空行）。
 */

/** 把 diff 结果压成便于断言的紧凑形式：'-x' 表示删除，'+x' 表示新增，' x' 表示未变 */
function compact(a: string, b: string): string[] {
  return diffLines(a, b).lines.map(
    (l) => `${l.op === 'remove' ? '-' : l.op === 'add' ? '+' : ' '}${l.text}`,
  );
}

describe('diffLines：基本行为', () => {
  it('完全相同 → 全是 equal', () => {
    const r = diffLines('a\nb\nc', 'a\nb\nc');
    expect(r.lines.every((l) => l.op === 'equal')).toBe(true);
    expect(r.stats).toMatchObject({ added: 0, removed: 0, unchanged: 3 });
    expect(r.stats.similarity).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it('完全不同 → 先全部删除，再全部新增', () => {
    expect(compact('a\nb', 'x\ny')).toEqual(['-a', '-b', '+x', '+y']);
  });

  it('中间某行被修改 → 表现为「删一行 + 加一行」', () => {
    expect(compact('a\nb\nc', 'a\nB\nc')).toEqual([' a', '-b', '+B', ' c']);
  });

  it('末尾新增', () => {
    expect(compact('a\nb', 'a\nb\nc')).toEqual([' a', ' b', '+c']);
  });

  it('末尾删除', () => {
    expect(compact('a\nb\nc', 'a\nb')).toEqual([' a', ' b', '-c']);
  });

  it('开头新增', () => {
    expect(compact('a\nb', 'x\na\nb')).toEqual(['+x', ' a', ' b']);
  });

  it('空字符串与单行文本', () => {
    // 空字符串按 split('\n') 得到 ['']，即"一个空行"
    expect(diffLines('', '').lines).toHaveLength(1);
    expect(diffLines('', 'a').stats.added).toBe(1);
    expect(diffLines('a', '').stats.removed).toBe(1);
  });

  it('空行被当作真实的行（增删空行也是改动）', () => {
    const r = diffLines('a\n\nb', 'a\nb');
    expect(r.stats.removed).toBe(1);
    expect(r.stats.unchanged).toBe(2);
  });

  it('CRLF 与 LF 视为相同（否则 Windows 换行会被判成整篇重写）', () => {
    const r = diffLines('a\r\nb\r\nc', 'a\nb\nc');
    expect(r.stats.added).toBe(0);
    expect(r.stats.removed).toBe(0);
  });
});

describe('diffLines：行号', () => {
  it('equal 两侧都有行号，add/remove 只有一侧', () => {
    const lines = diffLines('a\nb', 'a\nB').lines;
    const equal = lines.find((l) => l.op === 'equal')!;
    expect(equal.aLine).toBe(1);
    expect(equal.bLine).toBe(1);

    const removed = lines.find((l) => l.op === 'remove')!;
    expect(removed.aLine).toBe(2);
    expect(removed.bLine).toBeNull();

    const added = lines.find((l) => l.op === 'add')!;
    expect(added.aLine).toBeNull();
    expect(added.bLine).toBe(2);
  });

  it('行号是 1-based 且随内容推进', () => {
    const lines = diffLines('keep\nold\ntail', 'keep\nnew\ntail').lines;
    const keep = lines.find((l) => l.text === 'keep')!;
    const tail = lines.find((l) => l.text === 'tail')!;
    expect(keep.aLine).toBe(1);
    expect(tail.aLine).toBe(3);
    expect(tail.bLine).toBe(3);
  });
});

describe('diffLines：统计', () => {
  it('added / removed / unchanged 与 lines 一致', () => {
    const r = diffLines('a\nb\nc\nd', 'a\nX\nc\nY');
    const added = r.lines.filter((l) => l.op === 'add').length;
    const removed = r.lines.filter((l) => l.op === 'remove').length;
    const equal = r.lines.filter((l) => l.op === 'equal').length;
    expect(r.stats.added).toBe(added);
    expect(r.stats.removed).toBe(removed);
    expect(r.stats.unchanged).toBe(equal);
  });

  it('similarity 在 0~1 之间且方向正确', () => {
    const low = diffLines('a\nb\nc\nd', 'w\nx\ny\nz').stats.similarity;
    const high = diffLines('a\nb\nc\nd', 'a\nb\nc\nZ').stats.similarity;
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
    expect(high).toBeGreaterThan(low);
  });

  it('大输入退化时标记 truncated=true 且仍给出完整统计', () => {
    // 构造超过 MAX_DP_CELLS(10^6) 的输入：1100 x 1100 = 1.21e6 > 1e6
    const a = Array.from({ length: 1100 }, (_, i) => `line-${i}`).join('\n');
    const b = Array.from({ length: 1100 }, (_, i) => `other-${i}`).join('\n');
    const r = diffLines(a, b);
    expect(r.truncated).toBe(true);
    expect(r.stats.added).toBe(1100);
    expect(r.stats.removed).toBe(1100);
    expect(r.lines).toHaveLength(2200);
  });

  it('接近上限但未超时仍走精确算法', () => {
    // 300 x 300 = 9e4，远低于上限
    const a = Array.from({ length: 300 }, (_, i) => `l${i}`).join('\n');
    const r = diffLines(a, a);
    expect(r.truncated).toBe(false);
    expect(r.stats.unchanged).toBe(300);
  });
});

describe('diffLines：真实场景（Markdown 要点）', () => {
  it('要点被新增时只标出那一条', () => {
    const before = ['- 第一点', '- 第二点', '- 第三点'].join('\n');
    const after = ['- 第一点', '- 第二点', '- 新增的中间点', '- 第三点'].join('\n');
    const r = diffLines(before, after);
    expect(r.stats.added).toBe(1);
    expect(r.stats.removed).toBe(0);
    expect(r.lines.find((l) => l.op === 'add')?.text).toBe('- 新增的中间点');
  });

  it('要点被重写（同一位置内容变了）表现为一删一加', () => {
    const before = '- 结论：A 更好';
    const after = '- 结论：B 更好';
    const r = diffLines(before, after);
    expect(r.stats.added).toBe(1);
    expect(r.stats.removed).toBe(1);
  });

  it('翻译结果里术语被统一后，只有涉及术语的行变化', () => {
    const before = ['token 是令牌', 'prompt 是提示语', 'cache 是缓存'].join('\n');
    const after = ['token 是令牌', 'prompt 是提示词', 'cache 是缓存'].join('\n');
    const r = diffLines(before, after);
    expect(r.stats.added).toBe(1);
    expect(r.stats.removed).toBe(1);
    expect(r.stats.unchanged).toBe(2);
  });
});

describe('isSameSource', () => {
  it('输入正文完全一致 → 同源', () => {
    expect(isSameSource({ inputContent: '同一篇原文' }, { inputContent: '同一篇原文' })).toBe(true);
  });

  it('父任务一致 → 同源（追问链）', () => {
    expect(
      isSameSource(
        { inputContent: 'A', parentTaskId: 'p1' },
        { inputContent: 'B', parentTaskId: 'p1' },
      ),
    ).toBe(true);
  });

  it('输入不同且父任务不同 → 不同源', () => {
    expect(isSameSource({ inputContent: 'A' }, { inputContent: 'B' })).toBe(false);
  });

  it('一侧输入为空时不判为同源（避免两个失败任务被当成同源）', () => {
    expect(isSameSource({ inputContent: null }, { inputContent: null })).toBe(false);
    expect(isSameSource({ inputContent: '' }, { inputContent: '' })).toBe(false);
  });

  it('刻意不做模糊匹配（相似但不同 → 不同源）', () => {
    // 模糊匹配会把两篇不同文章错误归组，而用户在看到 diff 之前无法察觉
    expect(isSameSource({ inputContent: '这是一篇很长的文章正文……' }, { inputContent: '这是一篇很长的文章正文。。。' })).toBe(false);
  });
});

describe('sourceFingerprint', () => {
  it('同一份输入得到相同指纹', () => {
    const a = sourceFingerprint({ inputContent: 'x'.repeat(500), templateId: 't1' });
    const b = sourceFingerprint({ inputContent: 'x'.repeat(500), templateId: 't1' });
    expect(a).toBe(b);
  });

  it('不同输入得到不同指纹', () => {
    expect(sourceFingerprint({ inputContent: 'abc', templateId: 't1' })).not.toBe(
      sourceFingerprint({ inputContent: 'abd', templateId: 't1' }),
    );
  });

  it('长度不同即可区分（首尾相同时靠长度区分）', () => {
    const head = 'A'.repeat(64);
    const a = sourceFingerprint({ inputContent: `${head}${'x'.repeat(10)}`, templateId: 't1' });
    const b = sourceFingerprint({ inputContent: `${head}${'x'.repeat(20)}`, templateId: 't1' });
    expect(a).not.toBe(b);
  });

  it('有父任务时按父任务分组（追问链归到一起）', () => {
    const withParent = sourceFingerprint({ inputContent: 'anything', parentTaskId: 'p1' });
    expect(withParent).toBe('parent:p1');
  });

  it('指纹长度有界（不会把长文当 key）', () => {
    const fp = sourceFingerprint({ inputContent: 'x'.repeat(100_000), templateId: 't1' });
    expect(fp.length).toBeLessThan(80);
  });
});

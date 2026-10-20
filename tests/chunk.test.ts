import { describe, it, expect } from 'vitest';
import { chunkText, mapWithConcurrency } from '@/lib/pipeline/chunk';

/**
 * 分块逻辑是这个项目里最容易写出「看起来对、实际丢内容」的地方：
 * 一旦边界处理有误，摘要就会静默漏掉一段原文，而且用户完全看不出来。
 * 所以测试重点不是「块数对不对」，而是「内容有没有丢、有没有重复」。
 */
describe('chunkText', () => {
  it('短文本不分块，原样返回', () => {
    const chunks = chunkText('这是一段很短的中文文本。', { maxTokens: 1000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.index).toBe(0);
    expect(chunks[0]!.content).toContain('很短');
  });

  it('空输入返回空数组而不是抛错', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('长文本被切成多块，且每块不超过上限', () => {
    const para = '这是一个用于测试分块逻辑的段落。'.repeat(60); // 约 900+ token
    const text = Array.from({ length: 8 }, () => para).join('\n\n');
    const maxTokens = 300;
    const chunks = chunkText(text, { maxTokens, overlapTokens: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokens).toBeLessThanOrEqual(maxTokens);
    }
    // index 必须连续递增，下游 Map 阶段靠它标注进度
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it('切分不丢内容：每块都能在原文中找到', () => {
    // 用带序号的独特标记，便于定位丢失
    const marker = (i: number) => `MARKER-${i}`;
    const text = Array.from({ length: 40 }, (_, i) => `${marker(i)} ${'内容'.repeat(40)}`).join('\n\n');
    const chunks = chunkText(text, { maxTokens: 200, overlapTokens: 0 });

    const joined = chunks.map((c) => c.content).join('');
    for (let i = 0; i < 40; i++) {
      expect(joined).toContain(marker(i));
    }
  });

  it('重叠开启时相邻块存在交集，但不会无限重复', () => {
    const text = Array.from({ length: 30 }, (_, i) => `段落${i} ${'x'.repeat(80)}`).join('\n\n');
    const chunks = chunkText(text, { maxTokens: 250, overlapTokens: 80 });

    expect(chunks.length).toBeGreaterThan(2);
    // 有重叠 → 至少存在某块与下一块共享内容
    const hasOverlap = chunks.some((c, i) => {
      const next = chunks[i + 1];
      if (!next) return false;
      const tail = c.content.slice(-40);
      return tail.length > 0 && next.content.includes(tail.trim().slice(0, 20));
    });
    expect(hasOverlap).toBe(true);
  });

  it('单个超长无标点段落会被硬切而不是死循环', () => {
    // 没有任何句末标点，也没有段落分隔 —— 只靠硬切兜底
    const text = '啊'.repeat(5000);
    const chunks = chunkText(text, { maxTokens: 300, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length > 0)).toBe(true);
  });
});

describe('mapWithConcurrency', () => {
  it('保持结果顺序，不因并发乱序', async () => {
    const input = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(
      input,
      async (n) => {
        // 让靠前的项更慢，若顺序错乱就能被测出来
        await new Promise((r) => setTimeout(r, (6 - n) * 10));
        return n * 2;
      },
      2,
    );
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it('回调能拿到原始下标（Map 阶段靠它标注 chunk 序号）', async () => {
    const results = await mapWithConcurrency(
      ['a', 'b', 'c'],
      async (item, index) => `${index}:${item}`,
      3,
    );
    expect(results).toEqual(['0:a', '1:b', '2:c']);
  });

  it('单项失败时整体 reject（由调用方决定是否降级）', async () => {
    await expect(
      mapWithConcurrency(
        [1, 2, 3],
        async (n) => {
          if (n === 2) throw new Error('boom');
          return n;
        },
        2,
      ),
    ).rejects.toThrow('boom');
  });

  it('并发数不会超过上限', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      async (n) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return n;
      },
      3,
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('空数组不会死循环', async () => {
    expect(await mapWithConcurrency([], async () => 1, 3)).toEqual([]);
  });
});
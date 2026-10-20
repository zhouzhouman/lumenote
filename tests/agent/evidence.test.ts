import { describe, it, expect } from 'vitest';
import {
  checkEvidence,
  normalizeForMatch,
  parseChunkRef,
  type AgentStructuredOutput,
} from '@/lib/agent/loop';
import { makeChunks } from './helpers';

/**
 * 证据链校验的表征测试。
 *
 * 「结论对不对」需要领域知识，但「结论有没有依据」可以完全确定性判定 ——
 * 这是本项目零成本的质量维度。这里锁定匹配优先级（精确 > 归一化 > 缺失）
 * 与四种缺失原因的文案，因为评测报告会按这些字段聚合。
 */

const CHUNKS = makeChunks([
  '缓存命中率是 AI 应用最重要的成本指标。',
  '前缀缓存按最长公共前缀匹配，因此稳定内容应当前置。',
]);

function conclude(evidence: AgentStructuredOutput['conclusions'][number]['evidence']): AgentStructuredOutput {
  return { conclusions: [{ text: '结论', evidence }] };
}

describe('parseChunkRef：source 引用解析', () => {
  it('支持常见写法', () => {
    expect(parseChunkRef('chunk:12')).toBe(12);
    expect(parseChunkRef('Chunk 3')).toBe(3);
    expect(parseChunkRef('chunk：7')).toBe(7);
    expect(parseChunkRef('chunk #4')).toBe(4);
    expect(parseChunkRef('  chunk:  9 ')).toBe(9);
    expect(parseChunkRef('见 chunk:0 处')).toBe(0);
  });

  it('无法解析时返回 null（而不是 0 或 NaN）', () => {
    expect(parseChunkRef('第 5 段')).toBeNull();
    expect(parseChunkRef('chunk:')).toBeNull();
    expect(parseChunkRef('chunk:-1')).toBeNull();
    expect(parseChunkRef('')).toBeNull();
    expect(parseChunkRef('某处')).toBeNull();
  });
});

describe('normalizeForMatch：宽松归一化规则', () => {
  it('去空白（含换行、制表符）并转小写', () => {
    expect(normalizeForMatch('A b\nc\td')).toBe('abcd');
    expect(normalizeForMatch('有 空 白')).toBe('有空白');
  });

  it('统一引号、破折号', () => {
    expect(normalizeForMatch('“引号”')).toBe('"引号"');
    expect(normalizeForMatch('a—b')).toBe(normalizeForMatch('a-b'));
    expect(normalizeForMatch('a–b')).toBe('a-b');
  });

  it('统一中英标点', () => {
    expect(normalizeForMatch('中文，标点。')).toBe('中文,标点.');
    expect(normalizeForMatch('一；二：三（四）！')).toBe('一;二:三(四).');
    expect(normalizeForMatch('顿号、')).toBe('顿号,');
  });
});

describe('checkEvidence：匹配优先级与缺失原因', () => {
  it('精确匹配 → verified / exact，rate = 1', () => {
    const r = checkEvidence(conclude([{ source: 'chunk:0', quote: '缓存命中率是 AI 应用最重要的成本指标。' }]), CHUNKS);
    expect(r).toMatchObject({ total: 1, verified: 1, exact: 1, normalized: 0, rate: 1, missing: [] });
  });

  it('仅归一化后匹配 → normalized 计数，不记 exact', () => {
    const r = checkEvidence(
      conclude([{ source: 'chunk:0', quote: '缓存命中率是AI应用最重要的成本指标.' }]),
      CHUNKS,
    );
    expect(r).toMatchObject({ total: 1, verified: 1, exact: 0, normalized: 1, rate: 1 });
  });

  it('精确优先：内容同时满足两种匹配时只记 exact', () => {
    const r = checkEvidence(conclude([{ source: 'chunk:0', quote: '缓存命中率' }]), CHUNKS);
    expect(r.exact).toBe(1);
    expect(r.normalized).toBe(0);
  });

  it('引用了不存在的分块 → missing，原因含「不存在」', () => {
    const r = checkEvidence(conclude([{ source: 'chunk:99', quote: 'x' }]), CHUNKS);
    expect(r.verified).toBe(0);
    expect(r.missing).toEqual([
      { source: 'chunk:99', quote: 'x', reason: '文档中不存在 chunk:99' },
    ]);
  });

  it('source 无法解析 → missing，原因含「无法从 source」', () => {
    const r = checkEvidence(conclude([{ source: '某处', quote: 'x' }]), CHUNKS);
    expect(r.missing[0]?.reason).toBe('无法从 source「某处」解析出 chunk 编号');
  });

  it('quote 为空 → missing，原因「quote 为空」', () => {
    const r = checkEvidence(conclude([{ source: 'chunk:0', quote: '   ' }]), CHUNKS);
    expect(r.missing[0]?.reason).toBe('quote 为空');
  });

  it('片段不在该分块 → missing，原因「未在该分块中找到」', () => {
    const r = checkEvidence(conclude([{ source: 'chunk:0', quote: '这句话不在文档里' }]), CHUNKS);
    expect(r.missing[0]?.reason).toBe('引用的原文片段未在该分块中找到');
  });

  it('完整率按比例四舍五入到 4 位', () => {
    const r = checkEvidence(
      conclude([
        { source: 'chunk:0', quote: '缓存命中率' },
        { source: 'chunk:1', quote: '不存在的内容' },
        { source: 'chunk:2', quote: 'x' },
      ]),
      CHUNKS,
    );
    expect(r.total).toBe(3);
    expect(r.verified).toBe(1);
    expect(r.rate).toBe(0.3333);
  });

  it('没有证据 / 没有结构 / 空结论 → total 0、rate 0（不假设通过）', () => {
    expect(checkEvidence(null, CHUNKS)).toMatchObject({ total: 0, verified: 0, rate: 0 });
    expect(checkEvidence({ conclusions: [] }, CHUNKS)).toMatchObject({ total: 0, rate: 0 });
    expect(checkEvidence(conclude([]), CHUNKS)).toMatchObject({ total: 0, rate: 0 });
  });

  it('同一编号出现多次时以最后一次的内容为准（当前 Map 语义）', () => {
    const chunks = [
      { index: 0, content: '第一份内容', tokens: 1 },
      { index: 0, content: '第二份内容', tokens: 1 },
    ];
    const r = checkEvidence(conclude([{ source: 'chunk:0', quote: '第二份内容' }]), chunks);
    expect(r.verified).toBe(1);
    const miss = checkEvidence(conclude([{ source: 'chunk:0', quote: '第一份内容' }]), chunks);
    expect(miss.verified).toBe(0);
  });
});

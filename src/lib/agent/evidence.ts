import type { TextChunk } from '@/lib/pipeline/chunk';
import type { AgentStructuredOutput } from './types';

/**
 * 模块职责：**证据链校验**（纯函数）。
 *
 * 「结论对不对」需要领域知识，无法自动判定。但**「结论有没有依据」可以**：
 * 只要检查引用的原文片段是否真实存在于对应分块里。
 *
 * 于是我们得到一个**零成本、完全确定性**的质量维度 ——
 * 不需要 LLM judge，不需要人工标注。而且它直接呼应本项目的定位（可追溯）。
 *
 * ## 为什么单独成模块
 *
 * 这是评测与 UI 共用的判定逻辑（结论卡片上的「已验证/未验证」也来自这里）。
 * 它只依赖分块与结构化结论、不依赖模型调用，因此可以按边界条件穷举测试：
 * source 解析、quote 归一化、缺失原因分类。混在循环文件里时这些边界很难被覆盖到。
 *
 * 匹配策略（按用户拍板：宽松归一化 + 精确优先）：
 *   1. 先试精确子串匹配（最可靠）
 *   2. 失败则归一化后匹配（去空白、统一标点、大小写）——
 *      因为模型常常轻微改写引用（合并空格、改引号）
 *   3. 记录用了哪种匹配，便于观察模型的引用改写倾向
 */

export interface EvidenceCheck {
  total: number;
  verified: number;
  /** 精确匹配的数量 */
  exact: number;
  /** 归一化后才匹配上的数量 */
  normalized: number;
  missing: { source: string; quote: string; reason: string }[];
  /** 证据链完整率 0~1 */
  rate: number;
}

/** 归一化文本：去除所有空白、统一常见标点、转小写 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\u2018\u2019\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[，、]/g, ',')
    .replace(/[。！]/g, '.')
    .replace(/[；]/g, ';')
    .replace(/[：]/g, ':')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')');
}

/** 从 `chunk:12` 之类的 source 里取分块编号 */
export function parseChunkRef(source: string): number | null {
  const m = /chunk\s*[:：#]?\s*(\d+)/i.exec(source);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

export function checkEvidence(
  structured: AgentStructuredOutput | null,
  chunks: TextChunk[],
): EvidenceCheck {
  const byIndex = new Map(chunks.map((c) => [c.index, c.content]));

  let total = 0;
  let verified = 0;
  let exact = 0;
  let normalized = 0;
  const missing: EvidenceCheck['missing'] = [];

  for (const conclusion of structured?.conclusions ?? []) {
    for (const ev of conclusion.evidence) {
      total += 1;

      const idx = parseChunkRef(ev.source);
      if (idx === null) {
        missing.push({ ...ev, reason: `无法从 source「${ev.source}」解析出 chunk 编号` });
        continue;
      }
      const content = byIndex.get(idx);
      if (content === undefined) {
        missing.push({ ...ev, reason: `文档中不存在 chunk:${idx}` });
        continue;
      }
      if (!ev.quote.trim()) {
        missing.push({ ...ev, reason: 'quote 为空' });
        continue;
      }

      if (content.includes(ev.quote)) {
        verified += 1;
        exact += 1;
        continue;
      }
      if (normalizeForMatch(content).includes(normalizeForMatch(ev.quote))) {
        verified += 1;
        normalized += 1;
        continue;
      }

      missing.push({ ...ev, reason: '引用的原文片段未在该分块中找到' });
    }
  }

  return {
    total,
    verified,
    exact,
    normalized,
    missing,
    rate: total === 0 ? 0 : Number((verified / total).toFixed(4)),
  };
}

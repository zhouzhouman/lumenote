import { estimateTokens } from '@/lib/llm/mock';

/**
 * 文本分块 —— Map-Reduce 摘要的地基，也是本项目最值得写单测的纯函数。
 *
 * ## 为什么不能按固定字符数硬切
 *
 * 最直觉的做法是「每 1200 字切一刀」。问题在于它会切在句子中间，
 * 导致每个分块的开头和结尾都是残句。模型摘要时缺少上下文，
 * 产出的要点会丢信息，且合并阶段容易出现重复要点。
 *
 * ## 正确做法：沿语义边界切
 *
 * 优先级：段落 → 句子 → 硬切
 *  1. 先按空行分段（段是作者划定的语义单元，天然是最佳边界）
 *  2. 单段过大时按句末标点切（。！？.!? 及其后的换行）
 *  3. 极端情况（一个超长无标点的串）才硬切
 *
 * ## overlap 为什么必要
 *
 * 分块会切断跨块的语义。比如「...因此我们决定采用方案B，它的前提是
 * [分块边界] 用户规模超过十万...」。
 * 没有 overlap 时，两个分块都看不懂这句话，导致关键结论被丢弃。
 *
 * overlap 让每个块的**尾部内容同时出现在下一块的开头**，
 * 相当于给模型一点「上文」。代价是约 8% 的 token 重复开销 ——
 * 这个交换在实践中明显划算，因为 DeepSeek 的 cache hit 价只有 miss 价的 1/50，
 * 重复的那部分前缀大概率命中缓存，净成本接近于零。
 *
 * 这个「重复反而更便宜」的推理依赖前缀缓存，属于 DeepSeek 特有的设计红利，
 * 也正是把稳定内容前置的价值所在。
 */

export interface ChunkOptions {
  /** 目标块大小（token 估算值） */
  maxTokens?: number;
  /** 重叠大小（token 估算值） */
  overlapTokens?: number;
}

export const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = {
  maxTokens: 1200,
  overlapTokens: 100,
};

/** 句末标点。中英文都要覆盖，且要带上标点本身 */
const SENTENCE_END = /(?<=[.!?。！？；;])\s*/;

export interface TextChunk {
  index: number;
  content: string;
  /** 估算 token 数 */
  tokens: number;
}

export function chunkText(
  text: string,
  options: ChunkOptions = {},
): TextChunk[] {
  const { maxTokens, overlapTokens } = { ...DEFAULT_CHUNK_OPTIONS, ...options };

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  // 单块就能装下，无需分块
  if (estimateTokens(normalized) <= maxTokens) {
    return [{ index: 0, content: normalized, tokens: estimateTokens(normalized) }];
  }

  // 第一层：按段落切
  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  // 段落过大的，进一步按句子拆；还过大的才硬切
  const units: string[] = [];
  for (const para of paragraphs) {
    if (estimateTokens(para) <= maxTokens) {
      units.push(para);
      continue;
    }
    units.push(...splitLongParagraph(para, maxTokens));
  }

  // 第二层：组装成不超过 maxTokens 的块，带滑动重叠。
  // 内部用 string 累积，末尾统一映射为 TextChunk（避免中途混用两种类型）
  const rawChunks: string[] = [];
  let current = '';

  for (const unit of units) {
    const unitTokens = estimateTokens(unit);

    /**
     * 单个单位自身就接近/超过上限时，**独占一块，绝不与重叠区拼接**。
     *
     * 否则会出现 overlap + unit > maxTokens 的超限块：
     * 重叠区本身也要占token，拼接后必然超标。
     * 这也是「每块不超过 maxTokens」这条不变量唯一容易被破坏的地方。
     */
    if (unitTokens >= maxTokens * 0.9) {
      if (current.trim()) rawChunks.push(current);
      rawChunks.push(unit);
      current = '';
      continue;
    }

    // 加入这一段会超限 —— 先收口，再开新块
    if (current && estimateTokens(current) + unitTokens > maxTokens) {
      rawChunks.push(current);
      // 新块以重叠内容开头
      current = overlapTokens > 0 ? takeOverlap(rawChunks[rawChunks.length - 1], overlapTokens) : '';
      // 重叠区加上本段仍可能超标（当本段接近上限时）—— 此时放弃重叠
      if (current && estimateTokens(current) + unitTokens > maxTokens) {
        current = '';
      }
      if (current) current += '\n\n';
    }

    current += unit;
  }

  if (current.trim()) {
    // 末块若与前一块几乎重复（重叠导致），丢弃以免产生重复摘要
    const last = rawChunks[rawChunks.length - 1];
    if (!last || !isRedundant(last, current, overlapTokens)) {
      rawChunks.push(current);
    }
  }

  return rawChunks
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((content, index) => ({ index, content, tokens: estimateTokens(content) }));
}

/**
 * 拆分超长段落：按句子边界切，句子仍然过长时硬切。
 */
function splitLongParagraph(paragraph: string, maxTokens: number): string[] {
  const sentences = paragraph.split(SENTENCE_END).filter((s) => s.trim().length > 0);
  const result: string[] = [];
  let buffer = '';

  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;

    if (estimateTokens(s) > maxTokens) {
      // 单句超限（无标点的长串，如代码块、URL 列表）→ 先收尾再硬切
      if (buffer.trim()) {
        result.push(buffer.trim());
        buffer = '';
      }
      result.push(...hardSplit(s, maxTokens));
      continue;
    }

    if (buffer && estimateTokens(buffer) + estimateTokens(s) > maxTokens) {
      result.push(buffer.trim());
      buffer = '';
    }
    buffer += s;
  }

  if (buffer.trim()) result.push(buffer.trim());
  return result;
}

/** 最后的手段：按 token 估算等比硬切，尽量在空格处断开 */
function hardSplit(text: string, maxTokens: number): string[] {
  const totalTokens = estimateTokens(text);
  const parts = Math.ceil(totalTokens / maxTokens);
  const size = Math.ceil(text.length / parts);
  const result: string[] = [];

  for (let i = 0; i < text.length; i += size) {
    result.push(text.slice(i, i + size));
  }
  return result;
}

/** 取文本末尾约 overlapTokens 的内容作为下一块的开头 */
function takeOverlap(previous: string, overlapTokens: number): string {
  const targetChars = overlapTokens * 3.2; // token → 字符的粗略换算（与 estimateTokens 互逆）
  if (previous.length <= targetChars) return previous;

  const tail = previous.slice(-targetChars);

  // 尽量从句子开头对齐，避免重叠区以半个句子开始
  const firstBoundary = tail.search(/[.!?。！？]\s+/);
  if (firstBoundary >= 0 && firstBoundary < targetChars * 0.5) {
    return tail.slice(firstBoundary + 1);
  }

  return tail;
}

/** 判断新块是否因重叠而与上一块高度重复 */
function isRedundant(prev: string, next: string, overlapTokens: number): boolean {
  if (overlapTokens <= 0) return false;
  const minLen = Math.min(prev.length, next.length);
  if (minLen < 50) return false;

  const sameTail =
    prev.slice(-Math.min(200, minLen)).trim() === next.slice(0, Math.min(200, minLen)).trim();
  return sameTail && minLen < overlapTokens * 4;
}

/**
 * 并发控制。
 *
 * 为什么不直接 Promise.all 全部并发？
 *  1. 会瞬间打爆上游的限流阈值（429），反而变慢
 *  2. 成本上没有收益 —— token 总量不变，只是快一点
 *  3. 单个失败会导致整批失败
 *
 * 限制在 3 左右是「延迟明显下降」与「不触发限流」的平衡点。
 * 这是个典型的「工程约束优先于理论最优」的例子。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}
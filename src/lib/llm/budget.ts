import { estimateTokens } from './mock';
import type { LLMRequest } from './types';

/**
 * Token 预算控制。
 *
 * 这是 AI 应用里最容易被忽略、但最省钱的一层。核心认知：
 *
 * **上下文窗口不是唯一的约束，输出预算同样是。**
 *
 * Map-Reduce 摘要有个典型翻车场景：20 段文档，每段输出 200 字摘要，
 * 光合并阶段就可能产出 4000 字，再拿去生成最终摘要 —— 输出 token 比输入还贵
 * （DeepSeek 输出价是输入 miss 价的 4 倍），成本和延迟一起爆。
 *
 * 所以预算控制分三层：
 *   1. 输入侧：截断而非报错。用户不该因为文档太长就完全用不了
 *   2. 调用侧：限制单次输出；Map 阶段总输出超预算时**降低粒度**而不是失败
 *   3. 用户侧：每日配额，超额给明确提示而不是静默失败
 *
 * 设计取向：**超预算要降级，不要报错**。
 */

export interface BudgetResult {
  /** 裁剪后的请求 */
  request: LLMRequest;
  /** 是否发生了裁剪 */
  truncated: boolean;
  notes: string[];
}

/** 单次输入上限（token 估算）。DeepSeek 上下文是 1M，但不代表该塞满 */
const HARD_INPUT_LIMIT = 100_000;

/**
 * 第一层：输入侧截断。
 * 保留开头（通常包含文档标题与核心论点），因为摘要更依赖首尾而非中段。
 */
export function clampInput(prompt: string, maxTokens: number = HARD_INPUT_LIMIT): { text: string; truncated: boolean } {
  const estimated = estimateTokens(prompt);
  if (estimated <= maxTokens) return { text: prompt, truncated: false };

  // 按比例截断，再按字符边界回退，避免切出半个 UTF-8 字符
  const ratio = maxTokens / estimated;
  const candidate = prompt.slice(0, Math.floor(prompt.length * ratio));
  const safe = cutAtCharBoundary(candidate);
  return { text: safe, truncated: true };
}

/**
 * 第二层：Map 阶段的总输出预算控制。
 *
 * 超预算时不报错，而是**降低每个分块的摘要粒度**。
 * 从「每块 5 条要点、每条 50 字」降到「每块 3 条要点、每条 30 字」，
 * 用户拿到的是略粗糙的摘要，而不是一个错误弹窗。
 */
export function planMapBudget(chunkCount: number, totalMergeBudget: number): {
  perChunkPoints: number;
  perChunkMaxTokens: number;
  degraded: boolean;
} {
  const MIN_POINTS = 3;
  const BASELINE_POINTS = 5;
  const TOKENS_PER_POINT = 40;
  const MIN_TOKENS_PER_CHUNK = 120;

  // 每个分块的输出配额（留 20% 余量给合并阶段）
  const perChunk = Math.floor((totalMergeBudget * 0.8) / Math.max(1, chunkCount));

  if (perChunk >= BASELINE_POINTS * TOKENS_PER_POINT) {
    return {
      perChunkPoints: BASELINE_POINTS,
      perChunkMaxTokens: BASELINE_POINTS * TOKENS_PER_POINT,
      degraded: false,
    };
  }

  const affordablePoints = Math.max(MIN_POINTS, Math.floor(perChunk / TOKENS_PER_POINT));

  /**
   * ⚠️ 单块下限必须**反过来受总预算约束**。
   *
   * 之前的写法是 `Math.max(MIN_TOKENS_PER_CHUNK, affordablePoints * TOKENS_PER_POINT)` ——
   * 当分块很多时（chunkCount=100、预算 4000 → perChunk=32），每一项都会被
   * 抬到 120 tokens，Map 阶段的实际输出上限变成 100×120=12000，
   * 是它本该守住的 4000 预算的 3 倍。用户拿到的不是「降低粒度」，
   * 而是预算彻底失效 —— 正好是这个文件开头警告的「输出比输入还贵」。
   *
   * 正确的语义：下限是「不要再低到手抖」的护栏，但它不能突破总预算。
   * 所以取 min(理想下限, 均分到每块的实际可用额度)，
   * 并把「这次真的降级了」明确标出来，而不是假装一切正常。
   */
  const fairShare = Math.max(1, Math.floor((totalMergeBudget * 0.8) / Math.max(1, chunkCount)));
  const floor = Math.min(MIN_TOKENS_PER_CHUNK, fairShare);

  return {
    perChunkPoints: affordablePoints,
    perChunkMaxTokens: Math.max(floor, Math.min(affordablePoints * TOKENS_PER_POINT, fairShare)),
    degraded: true,
  };
}

/**
 * 第三层：估算一次任务的完整成本，用于调用前的预检。
 * 目的不是精确计费（那要等 Provider 返回 usage），而是「这次会不会太贵」的判断。
 */
export function estimateTaskCost(
  inputTokens: number,
  chunkCount: number,
  opts: { outputTokensPerChunk?: number } = {},
): { estimatedInputTokens: number; estimatedOutputTokens: number; note: string } {
  const perChunkOutput = opts.outputTokensPerChunk ?? 200;
  const mergeOutput = 600;

  const estimatedInputTokens = inputTokens + chunkCount * 60 + 500;
  const estimatedOutputTokens = chunkCount * perChunkOutput + mergeOutput;

  const note =
    chunkCount > 0
      ? `预计 ${chunkCount} 个分块，输入≈${estimatedInputTokens} tokens，输出≈${estimatedOutputTokens} tokens`
      : '单块直出，无合并阶段';

  return { estimatedInputTokens, estimatedOutputTokens, note };
}

/** 按字符边界安全截断，避免切出半个代理对 */
function cutAtCharBoundary(text: string): string {
  if (!text) return text;
  const lastChar = text.charCodeAt(text.length - 1);
  // 高位代理（0xD800-0xDBFF）说明末尾是半个 emoji，回退一个字符
  if (lastChar >= 0xd800 && lastChar <= 0xdbff) {
    return text.slice(0, -1);
  }
  return text;
}

/**
 * 从「拼好的 prompt」里把**用户正文**捞回来。
 *
 * 为什么降级时不能直接用 prompt：prompt 是给模型看的完整输入，除了正文还包含
 * 两层脚手架 ——
 *
 *   1. `wrapUntrusted()` 在外层套的 `<document>…</document>`
 *   2. 模板渲染出来的参数头，如 `# 目标读者 普通读者` / `# 需要的要点数量 5`
 *
 * 实测踩过：降级分支直接把 prompt 丢给 heuristicSummary，而它在正文较短时会
 * 「原样返回」，于是用户看到的结果是这样的（把内部提示词当成了摘要）：
 *
 *   <document> # 目标读者 普通读者 # 需要的要点数量 5 <document> 最美的风景…
 *
 * 这不只是难看：它把内部 prompt 结构暴露给了终端用户。
 *
 * 提取规则（保守，宁可少剥不可错剥）：
 *   - 只取最后一个 `</document>` 之前的内容 —— 之后是调用方追加的指令
 *   - 去掉所有 `<document>` / `</document>` 标签（可能嵌套两层）
 *   - 丢掉形如 `# <参数名> <值>` 的参数头行
 */
export function extractSourceText(prompt: string): string {
  const lastClose = prompt.lastIndexOf('</document>');
  const body = lastClose >= 0 ? prompt.slice(0, lastClose) : prompt;

  return body
    .replace(/<\/?document>/gi, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#\s*(目标读者|需要的要点数量|摘要风格|目标长度|语气|输出语言)/.test(line))
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 本地启发式摘要 —— 降级链的最后一档。
 *
 * 刻意做得很朴素：取开头 + 取含数字/标题的句子 + 结尾。
 * 它的价值不在质量，而在于「所有 LLM 通道都不可用时，
 * 用户仍然拿到一个结构完整、且**明确标注不可信**的结果」。
 *
 * 诚实很重要：返回一个假装是 AI 摘要的粗糙结果，比返回错误更有害，
 * 因为用户会把它当成真的。
 *
 * ⚠️ 传入的 `text` 必须是**正文**，不是拼好的 prompt ——
 * 用 `extractSourceText()` 先剥掉脚手架。
 */
export function heuristicSummary(
  text: string,
  opts: { maxChars?: number; maxPoints?: number } = {},
): { summary: string; degraded: true } {
  const maxChars = opts.maxChars ?? 1200;
  const maxPoints = opts.maxPoints ?? 0;
  const cleaned = text.replace(/\s+/g, ' ').trim();

  const note = '> ⚠️ **降级结果**：所有 AI 通道当前不可用，以下内容由本地规则提取，未经模型处理，可能不准确。';

  if (!cleaned) {
    return { summary: `${note}\n\n（正文为空，无法提取任何内容。）`, degraded: true };
  }

  /**
   * 用户选了「要点式 N 条」，降级结果也必须是 N 条编号要点。
   *
   * 否则用户明明选了要点式，却拿到一大段原文，会直接判定「功能坏了」——
   * 而降级标记藏在角标里，他不会去看。这是形式上的承诺，不能只兑现一半。
   */
  if (maxPoints > 0) {
    const sentences = splitSentences(cleaned);
    const picked = pickTopSentences(sentences, maxChars, Math.min(maxPoints, sentences.length));
    const lines = picked.map((s, i) => `${i + 1}. ${s}`);
    return { summary: [note, '', ...lines].join('\n'), degraded: true };
  }

  if (cleaned.length <= maxChars) {
    return { summary: `${note}\n\n${cleaned}`, degraded: true };
  }

  const sentences = splitSentences(cleaned);
  const picked: string[] = [];
  let total = 0;
  for (const s of pickTopSentences(sentences, maxChars, Number.POSITIVE_INFINITY)) {
    if (total + s.length > maxChars) continue;
    picked.push(s);
    total += s.length;
    if (total > maxChars * 0.9) break;
  }

  return {
    summary: [note, '', ...picked].join('\n'),
    degraded: true,
  };
}

/** 按句末标点切句，保留标点；过滤空白句 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 挑出信息量最高的若干句，并**恢复原文顺序**（乱序的要点读起来是断的）。
 */
function pickTopSentences(sentences: string[], maxChars: number, limit: number): string[] {
  if (sentences.length === 0) return [];

  const keywords = extractKeywords(sentences.join(' '));
  const scored = sentences.map((s, i) => {
    let score = (sentences.length - i) / sentences.length; // 位置权重
    if (/\d/.test(s)) score += 0.3;
    for (const k of keywords) if (s.includes(k)) score += 0.2;
    return { s, score: score * Math.min(1, s.length / 60) };
  });

  const picked: string[] = [];
  let total = 0;
  for (const { s } of scored.sort((a, b) => b.score - a.score)) {
    if (picked.length >= limit) break;
    if (total + s.length > maxChars) continue;
    picked.push(s);
    total += s.length;
  }

  return sentences.filter((s) => picked.includes(s));
}

function extractKeywords(text: string, topN = 8): string[] {
  const stop = new Set(['的', '了', '和', '是', '在', '有', '与', 'this', 'the', 'and', 'for', 'that', 'with']);
  const freq = new Map<string, number>();

  // 中文按 2-gram，英文按单词
  for (const gram of text.match(/[一-鿿]{2}/g) ?? []) {
    if (stop.has(gram)) continue;
    freq.set(gram, (freq.get(gram) ?? 0) + 1);
  }
  for (const word of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
    if (stop.has(word)) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([k]) => k);
}
/**
 * 文本差异比较（逐行 diff）。
 *
 * ## 为什么自己实现
 *
 * 引入 `diff` / `jsdiff` 之类的库能少写代码，但这里的需求很窄：
 * 两个字符串、逐行比较、给前端渲染左右对照。而自研的好处是
 * **能精确控制性能上限**（见下方大输入保护）——
 * 这是服务端接口，不能让一个 100 万行的输入把进程 CPU 打满。
 *
 * 算法用经典的 LCS（最长公共子序列）动态规划 + 回溯。
 * 复杂度 O(n·m)，所以必须设行数上限 —— 这正是第三方库不会替我们决定的事。
 *
 * ## 一个刻意的取舍：以「行」为单位而不是「字符」
 *
 * 字符级 diff 视觉效果更精细，但对「摘要/翻译/润色」这类输出而言噪声太大：
 * 中文改一个字会牵动整段的字符对齐，结果满屏都是高亮，反而看不出改了什么。
 * 逐行（Markdown 里通常是一句话或一个要点）更贴近用户的心智：
 * 「这一条被改了」而不是「第 37 个字符不同」。
 */

export type DiffOp = 'equal' | 'add' | 'remove';

export interface DiffLine {
  op: DiffOp;
  /** 该行在两个版本中的行号（1-based）。add 只有 bLine，remove 只有 aLine */
  aLine: number | null;
  bLine: number | null;
  text: string;
}

export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
  /** 相似度 0~1：按「未变化行 / 较长版本的行数」估算，用于快速判断改动幅度 */
  similarity: number;
}

export interface DiffResult {
  lines: DiffLine[];
  stats: DiffStats;
  /** 是否因为超过行数上限而退化成了「整体替换」（此时 lines 只有 remove+add） */
  truncated: boolean;
}

/**
 * 行数上限。
 *
 * 两侧行数之积决定 DP 表大小。10^6 个格子在 Node 里约 8MB 内存、
 * 几十毫秒 —— 这是可接受的量级。再大就退化，避免拖垮事件循环。
 */
const MAX_DP_CELLS = 1_000_000;

/** 归一化换行并拆行。保留空行：空行的增删也是「改动」 */
function toLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

function computeStats(lines: DiffLine[], aCount: number, bCount: number): DiffStats {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const l of lines) {
    if (l.op === 'add') added += 1;
    else if (l.op === 'remove') removed += 1;
    else unchanged += 1;
  }
  const denominator = Math.max(aCount, bCount, 1);
  return {
    added,
    removed,
    unchanged,
    similarity: Number((unchanged / denominator).toFixed(4)),
  };
}

/**
 * 逐行 diff。
 *
 * @param a 旧版本文本
 * @param b 新版本文本
 */
export function diffLines(a: string, b: string): DiffResult {
  const aLines = toLines(a);
  const bLines = toLines(b);

  const n = aLines.length;
  const m = bLines.length;

  /**
   * 大输入保护：超过格子上限时退化成「整体替换」。
   *
   * 退化而不是报错，也不是硬算：用户在历史里点「对比」是为了看一眼差异，
   * 给他一个「全部删除 + 全部新增」的结果虽然不精细，但**总比接口转圈十分钟好**。
   * 同时用 truncated 标记出来，前端可以提示「内容过大，仅显示整体差异」。
   */
  if (n * m > MAX_DP_CELLS) {
    const lines: DiffLine[] = [
      ...aLines.map((text, i) => ({ op: 'remove' as const, aLine: i + 1, bLine: null, text })),
      ...bLines.map((text, i) => ({ op: 'add' as const, aLine: null, bLine: i + 1, text })),
    ];
    return { lines, stats: computeStats(lines, n, m), truncated: true };
  }

  // ---- LCS 长度表 ----
  // 用 Int32Array 而不是嵌套数组：连续内存，百万格子的分配与访问都快得多
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        aLines[i] === bLines[j]
          ? dp[(i + 1) * width + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + (j + 1)]!);
    }
  }

  // ---- 回溯生成 diff ----
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      lines.push({ op: 'equal', aLine: i + 1, bLine: j + 1, text: aLines[i]! });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!) {
      // 相等时优先「删除」而不是「新增」：
      // 这样当一段内容被替换时，顺序是「先删旧、后加新」，
      // 视觉上更符合阅读习惯（先看到去掉了什么）
      lines.push({ op: 'remove', aLine: i + 1, bLine: null, text: aLines[i]! });
      i += 1;
    } else {
      lines.push({ op: 'add', aLine: null, bLine: j + 1, text: bLines[j]! });
      j += 1;
    }
  }

  // 收尾：任一侧剩余的行
  while (i < n) {
    lines.push({ op: 'remove', aLine: i + 1, bLine: null, text: aLines[i]! });
    i += 1;
  }
  while (j < m) {
    lines.push({ op: 'add', aLine: null, bLine: j + 1, text: bLines[j]! });
    j += 1;
  }

  return { lines, stats: computeStats(lines, n, m), truncated: false };
}

/**
 * 判断两个任务是否「同源」。
 *
 * 用途：历史页把「对同一篇原文的多次生成」归成一组，用户才知道该拿谁和谁对比。
 *
 * 判定依据（按可靠性排序）：
 *  1. 显式关联：`parentTaskId` 指向同一个父任务（翻译 → 追问 这类）
 *  2. 输入指纹：`inputContent` 完全一致（同一段文本用不同参数跑了两次）
 *
 * ⚠️ 刻意**不做模糊相似度匹配**（比如 >90% 就算同源）：
 * 那会把「两篇不同的文章」错误地归到一起，而用户在看到 diff 之前
 * 无法察觉这个错误 —— 错的分组比没有分组更糟。
 */
export function isSameSource(
  a: { inputContent: string | null; parentTaskId?: string | null },
  b: { inputContent: string | null; parentTaskId?: string | null },
): boolean {
  if (a.inputContent && b.inputContent && a.inputContent === b.inputContent) return true;
  if (a.parentTaskId && b.parentTaskId && a.parentTaskId === b.parentTaskId) return true;
  return false;
}

/** 生成输入的指纹，用于「同源分组」的键。用长度 + 前 64 字符，避免把长文当 Map key */
export function sourceFingerprint(task: {
  inputContent: string | null;
  parentTaskId?: string | null;
  templateId?: string;
}): string {
  if (task.parentTaskId) return `parent:${task.parentTaskId}`;
  const content = task.inputContent ?? '';
  // 取首尾片段 + 长度：既能区分不同文章，又不会让键变得很长
  const head = content.slice(0, 64);
  const tail = content.slice(-32);
  const headHash = simpleHash(head);
  const tailHash = simpleHash(tail);
  return `src:${content.length}:${headHash}:${tailHash}:${task.templateId ?? ''}`;
}

/** FNV-1a，够用且无依赖（只是为了给分组键做降维，不是安全用途） */
function simpleHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

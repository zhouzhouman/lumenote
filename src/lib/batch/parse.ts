/**
 * 批次输入解析。
 *
 * v1 刻意**不做文件上传**（PDF/DOCX 解析是另一个量级的工作，且要引入二进制依赖），
 * 而是用「一个文本框 + `---` 分隔」表达「一次交 N 份材料」：
 *
 *   2024 年报摘要
 *   营收同比增长 18%……
 *   ---
 *   竞品分析
 *   对手在本季度……
 *   ---
 *   https://example.com/report
 *
 * 这样既支持纯文本，也支持链接（整块就是一个 URL 时按链接抓取），
 * 而且用户能一眼看懂自己交了几份 —— 比藏一个「上传多个文件」按钮更符合
 * 「内部流水线」的实际用法（材料常常是从邮件、IM、Word 里复制出来的）。
 */

export interface BatchItemInput {
  /** 展示名。取块内首行 `# 标题`，或链接的 host，或自动编号 */
  title: string;
  inputType: 'text' | 'url';
  content: string;
}

export interface ParseBatchOptions {
  maxItems?: number;
  maxCharsPerItem?: number;
  maxTotalChars?: number;
}

export interface ParseBatchResult {
  items: BatchItemInput[];
  /** 校验问题。**非空即应当整体拒绝**：半批成功对用户最难解释 */
  problems: string[];
}

/** 独占一行的 `---`（容忍常见的中文破折号与连字符变体） */
const SEPARATOR = /^\s*[-—–_=]{3,}\s*$/;

const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_MAX_CHARS_PER_ITEM = 60_000;
const DEFAULT_MAX_TOTAL_CHARS = 200_000;

export function parseBatchInput(raw: string, opts: ParseBatchOptions = {}): ParseBatchResult {
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxCharsPerItem = opts.maxCharsPerItem ?? DEFAULT_MAX_CHARS_PER_ITEM;
  const maxTotalChars = opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

  const blocks: string[] = [];
  let buffer: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (SEPARATOR.test(line)) {
      const block = buffer.join('\n').trim();
      if (block) blocks.push(block);
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  const last = buffer.join('\n').trim();
  if (last) blocks.push(last);

  const problems: string[] = [];
  const items: BatchItemInput[] = [];
  let totalChars = 0;

  if (blocks.length === 0) {
    return { items: [], problems: ['没有可处理的内容：请至少粘贴一份材料，多份之间用单独一行 --- 分隔'] };
  }

  if (blocks.length > maxItems) {
    problems.push(`一次最多 ${maxItems} 份材料（当前 ${blocks.length} 份），请分批提交`);
  }

  for (const [index, block] of blocks.slice(0, maxItems).entries()) {
    const label = `第 ${index + 1} 份`;

    // 整块就是一个链接 → 按链接抓取（正则与后端 extractUrl 同口径）
    if (/^https?:\/\/\S+$/i.test(block)) {
      let title = label;
      try {
        title = new URL(block).hostname || label;
      } catch {
        problems.push(`${label}的链接格式无法解析：${block.slice(0, 60)}`);
        continue;
      }
      items.push({ title, inputType: 'url', content: block });
      totalChars += block.length;
      continue;
    }

    // 首行 `# 标题` → 作为展示名，不进入正文
    let title = label;
    let content = block;
    const headingMatch = block.match(/^#\s+(.{1,80})\n+/);
    if (headingMatch) {
      title = headingMatch[1]!.trim();
      content = block.slice(headingMatch[0].length).trim();
    }

    if (content.length === 0) {
      problems.push(`${label}只有标题没有正文`);
      continue;
    }
    if (content.length > maxCharsPerItem) {
      problems.push(
        `${label}（${title}）有 ${content.length.toLocaleString()} 字，超过单份上限 ${maxCharsPerItem.toLocaleString()}`,
      );
      continue;
    }

    items.push({ title, inputType: 'text', content });
    totalChars += content.length;
  }

  if (totalChars > maxTotalChars) {
    problems.push(
      `本批合计 ${totalChars.toLocaleString()} 字，超过上限 ${maxTotalChars.toLocaleString()}，请分批提交`,
    );
  }

  return { items, problems };
}

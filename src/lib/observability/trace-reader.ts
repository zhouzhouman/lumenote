import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { TraceSpanRecord } from './jsonl-exporter';

export type { TraceSpanRecord } from './jsonl-exporter';

/**
 * 读取 JSONL trace 并按 taskId 组装 span 树。
 *
 * ## 为什么把「读取」放在 src/lib 而不是脚本里
 *
 * 报告脚本与单测都要做同样的事：按 taskId 找 span、验证父子关系、
 * 打印缩进树。放在脚本里就只能脚本自测；放到 lib 里是一个
 * 「输入 JSONL 文本 → 输出树」的确定性函数，可以用临时文件直接覆盖。
 *
 * ## 容错
 *
 * JSONL 可能因为进程被杀而出现半行。读取时**跳过坏行并计数**，
 * 而不是整份失败 —— 排障工具在故障现场最该可用，不能因为一条脏数据就罢工。
 */

export interface TraceReadResult {
  spans: TraceSpanRecord[];
  /** 被跳过的坏行数（半行/非法 JSON） */
  badLines: number;
  /** 读过的文件（相对传入目录的路径，便于报告展示） */
  files: string[];
}

/** 从一段 JSONL 文本解析 span（宽容模式） */
export function parseTraceJsonl(text: string): { spans: TraceSpanRecord[]; badLines: number } {
  const spans: TraceSpanRecord[] = [];
  let badLines = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Partial<TraceSpanRecord>;
      if (
        typeof parsed.traceId === 'string' &&
        typeof parsed.spanId === 'string' &&
        typeof parsed.name === 'string'
      ) {
        spans.push(parsed as TraceSpanRecord);
      } else {
        badLines += 1;
      }
    } catch {
      badLines += 1;
    }
  }

  return { spans, badLines };
}

/** 列出目录下所有 `.jsonl` 文件（按文件名排序 = 按日期排序） */
export function listTraceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

/** 读取整个目录的 trace */
export function readTraceDir(dir: string): TraceReadResult {
  const result: TraceReadResult = { spans: [], badLines: 0, files: [] };
  for (const file of listTraceFiles(dir)) {
    result.files.push(path.relative(dir, file).replaceAll('\\', '/'));
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseTraceJsonl(text);
    result.spans.push(...parsed.spans);
    result.badLines += parsed.badLines;
  }
  return result;
}

/**
 * 按 taskId 捞出一次任务的所有 span。
 *
 * @param taskId 根 span 的属性值
 * @param options.dir JSONL 目录；options.spans 可直接传已解析的 span（避免重复读盘）
 */
export function readSpansForTask(
  taskId: string,
  options: { dir: string; spans?: TraceSpanRecord[] },
): { spans: TraceSpanRecord[]; traceIds: string[]; files: string[]; badLines: number } {
  const read = options.spans
    ? { spans: options.spans, badLines: 0, files: [] as string[] }
    : readTraceDir(options.dir);

  const spans = read.spans.filter((span) => span.attributes?.taskId === taskId);
  const traceIds = [...new Set(spans.map((span) => span.traceId))];
  return { spans, traceIds, files: read.files, badLines: read.badLines };
}

export interface SpanTreeNode {
  span: TraceSpanRecord;
  children: SpanTreeNode[];
}

function byStartTime(a: TraceSpanRecord, b: TraceSpanRecord): number {
  const diff = Date.parse(a.startTime) - Date.parse(b.startTime);
  return diff !== 0 ? diff : a.name.localeCompare(b.name);
}

/**
 * 组装 span 树。
 *
 * 根的定义：没有 parentSpanId，或 parent 不在传入集合里
 * （按 taskId 过滤后父 span 理论上都在；后者用于容错，例如父 span 写失败）。
 */
export function buildSpanTree(spans: TraceSpanRecord[]): SpanTreeNode[] {
  const nodes = new Map<string, SpanTreeNode>();
  for (const span of spans) {
    nodes.set(span.spanId, { span, children: [] });
  }

  const roots: SpanTreeNode[] = [];
  for (const span of spans) {
    const node = nodes.get(span.spanId)!;
    const parent = span.parentSpanId ? nodes.get(span.parentSpanId) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortRec = (list: SpanTreeNode[]): void => {
    list.sort((a, b) => byStartTime(a.span, b.span));
    for (const item of list) sortRec(item.children);
  };
  sortRec(roots);
  return roots;
}

/** 树里展示的属性白名单（顺序固定，报告可读性优先） */
const DISPLAY_ATTRIBUTE_KEYS = [
  'taskId',
  'phase',
  'type',
  'model',
  'provider',
  'inputTokens',
  'outputTokens',
  'attempt',
  'step',
  'chunkIndex',
  'toolName',
  'ok',
  'degraded',
  'rate',
  'unsupported',
  'status',
  'stopReason',
  'chunkCount',
  'textLength',
] as const;

function formatAttributes(span: TraceSpanRecord): string {
  const parts: string[] = [];
  for (const key of DISPLAY_ATTRIBUTE_KEYS) {
    const value = span.attributes?.[key];
    if (value === undefined) continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.length > 0 ? ` [${parts.join(', ')}]` : '';
}

/**
 * 把 span 树格式化成缩进文本（报告里贴的那段）。
 * 每个节点形如：
 *   ├─ llm.request [phase=reduce, model=deepseek-flash, inputTokens=1200] 34.2ms
 */
export function formatSpanTree(spans: TraceSpanRecord[], options: { rootLabel?: string } = {}): string {
  const roots = buildSpanTree(spans);
  const lines: string[] = [];

  const walk = (node: SpanTreeNode, prefix: string, isLast: boolean, depth: number): void => {
    const connector = depth === 0 ? '' : `${isLast ? '└─' : '├─'} `;
    const suffix = depth === 0 && options.rootLabel ? ` ${options.rootLabel}` : '';
    lines.push(
      `${prefix}${connector}${node.span.name}${formatAttributes(node.span)} ${node.span.durationMs.toFixed(1)}ms${suffix}`,
    );
    const childPrefix = depth === 0 ? '' : `${prefix}${isLast ? '   ' : '│  '}`;
    node.children.forEach((child, index) => {
      walk(child, childPrefix, index === node.children.length - 1, depth + 1);
    });
  };

  roots.forEach((root, index) => walk(root, '', index === roots.length - 1, 0));
  return lines.join('\n');
}

export interface TraceSummary {
  traceIds: string[];
  spanCount: number;
  /** 根 span 的持续时间（一次任务的端到端耗时） */
  durationMs: number;
  rootName?: string;
  byName: Record<string, number>;
  badLines: number;
}

/** 汇总一条 trace 的规模信息（报告用） */
export function summarizeTrace(spans: TraceSpanRecord[], badLines = 0): TraceSummary {
  const roots = buildSpanTree(spans);
  const byName: Record<string, number> = {};
  for (const span of spans) {
    byName[span.name] = (byName[span.name] ?? 0) + 1;
  }

  const root = roots[0]?.span;
  return {
    traceIds: [...new Set(spans.map((span) => span.traceId))],
    spanCount: spans.length,
    durationMs: root?.durationMs ?? 0,
    ...(root?.name ? { rootName: root.name } : {}),
    byName,
    badLines,
  };
}

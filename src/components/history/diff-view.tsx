'use client';

import * as React from 'react';
import { apiGet, withQuery, ApiRequestError } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface DiffLine {
  op: 'equal' | 'add' | 'remove';
  aLine: number | null;
  bLine: number | null;
  text: string;
}

interface SideMeta {
  id: string;
  title: string;
  type: string;
  status: string;
  degraded: boolean;
  createdAt: string;
  charCount: number;
  templateName: string;
  promptVersion: number;
  params: Record<string, unknown>;
}

interface DiffPayload {
  a: SideMeta;
  b: SideMeta;
  diff: {
    lines: DiffLine[];
    stats: { added: number; removed: number; unchanged: number; similarity: number };
    truncated: boolean;
  };
  paramDiff: { key: string; a: string | null; b: string | null }[];
  sameSource: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  summarize: '摘要',
  translate: '翻译',
  write: '润色改写',
};

/**
 * 版本对比视图。
 *
 * ## 两个刻意的展示决策
 *
 * 1. **先给结论再给细节**：顶部一行「相似度 / 新增 N 行 / 删除 N 行」，
 *    用户一眼就知道改动大不大，需要时才往下看具体差异。
 *    直接铺满整个 diff 会让人不知道从哪看起。
 *
 * 2. **参数差异单独一块列出**。这是「可追溯」的直接体现：
 *    用户看到内容不同时，最想知道的下一件事就是「两次哪里不一样」。
 *    只给内容 diff 会让他自己去翻两条记录猜（是换了模型？改了要点数？）。
 *
 * 渲染上刻意**不做左右并排**：中文在窄栏里换行很难对齐，
 * 统一的行内 diff（`+`/`-` 前缀 + 背景色）在宽屏窄屏下都成立。
 */
export function DiffView({ aId, bId, onClose }: { aId: string; bId: string; onClose: () => void }) {
  const [data, setData] = React.useState<DiffPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [onlyChanges, setOnlyChanges] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await apiGet<DiffPayload>(withQuery('/api/diff', { a: aId, b: bId }));
        if (!cancelled) setData(payload);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiRequestError ? e.message : '对比失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [aId, bId]);

  // Esc 关闭 —— 与历史详情弹窗保持一致的操作习惯
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  /**
   * 「只看改动」模式：把连续未改动的行折叠成一行提示。
   *
   * 实现方式是**折叠而不是过滤** —— 过滤会让用户失去「这段在原文的什么位置」
   * 的上下文，而摘要/译文里位置往往就代表结构（第几个要点）。
   */
  const rendered = React.useMemo(() => {
    const lines = data?.diff.lines ?? [];
    if (!onlyChanges) return lines.map((l) => ({ kind: 'line' as const, line: l }));

    const out: ({ kind: 'line'; line: DiffLine } | { kind: 'gap'; count: number })[] = [];
    let pendingGap = 0;

    for (const line of lines) {
      if (line.op === 'equal') {
        pendingGap += 1;
        continue;
      }
      if (pendingGap > 0) {
        out.push({ kind: 'gap', count: pendingGap });
        pendingGap = 0;
      }
      out.push({ kind: 'line', line });
    }
    if (pendingGap > 0) out.push({ kind: 'gap', count: pendingGap });
    return out;
  }, [data, onlyChanges]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl rounded-lg border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b p-5">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">版本对比</h2>
            {data && (
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  相似度 {(data.diff.stats.similarity * 100).toFixed(1)}%
                </span>
                <span className="text-emerald-600 dark:text-emerald-400">
                  新增 {data.diff.stats.added} 行
                </span>
                <span className="text-red-600 dark:text-red-400">
                  删除 {data.diff.stats.removed} 行
                </span>
                {data.sameSource ? (
                  <Badge variant="secondary">同源</Badge>
                ) : (
                  <Badge variant="outline" title="两次生成并非同一篇原文，差异可能只是内容不同而非改动">
                    非同源
                  </Badge>
                )}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOnlyChanges((v) => !v)}
              disabled={!data}
            >
              {onlyChanges ? '显示全部' : '只看改动'}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              关闭
            </Button>
          </div>
        </header>

        <div className="space-y-5 p-5">
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          {!data && !error && (
            <p className="py-10 text-center text-sm text-muted-foreground">对比中…</p>
          )}

          {data && (
            <>
              {/* 两侧的元信息：先让用户确认「我对比的是哪两个版本」 */}
              <div className="grid gap-3 sm:grid-cols-2">
                {([data.a, data.b] as SideMeta[]).map((side, idx) => (
                  <div key={side.id} className="rounded-md border p-3 text-xs">
                    <p className="mb-1 font-medium text-foreground">
                      {idx === 0 ? '旧版本（A）' : '新版本（B）'}
                    </p>
                    <p className="truncate" title={side.title}>
                      {side.title}
                    </p>
                    <p className="mt-1 flex flex-wrap gap-x-2 text-muted-foreground">
                      <span>{TYPE_LABEL[side.type] ?? side.type}</span>
                      <span>
                        {side.templateName} v{side.promptVersion}
                      </span>
                      <span>{side.charCount} 字</span>
                      {side.degraded && <span className="text-amber-600">降级</span>}
                    </p>
                    <p className="text-muted-foreground">
                      {new Date(side.createdAt).toLocaleString('zh-CN')}
                    </p>
                  </div>
                ))}
              </div>

              {/* 参数差异：解释「为什么两次结果不同」的关键线索 */}
              {data.paramDiff.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-medium">参数差异</h3>
                  <ul className="divide-y rounded-md border text-xs">
                    {data.paramDiff.map((p) => (
                      <li key={p.key} className="flex flex-wrap gap-x-3 gap-y-1 p-2.5">
                        <code className="rounded bg-muted px-1.5 py-0.5">{p.key}</code>
                        <span className="text-red-600 dark:text-red-400">
                          {p.a ?? '（未设置）'}
                        </span>
                        <span className="text-muted-foreground">→</span>
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {p.b ?? '（未设置）'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.diff.truncated && (
                <p className="rounded-md border border-amber-600/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  内容过大，已退化为整体差异显示（不再逐行对齐）。
                </p>
              )}

              {/* 内容差异 */}
              <div>
                <h3 className="mb-2 text-sm font-medium">内容差异</h3>
                {data.diff.stats.added === 0 && data.diff.stats.removed === 0 ? (
                  <p className="rounded-md border bg-muted/30 p-4 text-center text-sm text-muted-foreground">
                    两个版本的输出完全一致。
                  </p>
                ) : (
                  <div className="max-h-[52vh] overflow-y-auto rounded-md border font-mono text-[12.5px] leading-relaxed">
                    {rendered.map((item, idx) =>
                      item.kind === 'gap' ? (
                        <div
                          key={`gap-${idx}`}
                          className="border-y bg-muted/40 px-3 py-1 text-center text-[11px] text-muted-foreground"
                        >
                          ⋯ 省略 {item.count} 行未改动
                        </div>
                      ) : (
                        <div
                          key={`line-${idx}`}
                          className={
                            item.line.op === 'add'
                              ? 'flex gap-2 bg-emerald-500/10 px-3 py-0.5'
                              : item.line.op === 'remove'
                                ? 'flex gap-2 bg-red-500/10 px-3 py-0.5'
                                : 'flex gap-2 px-3 py-0.5'
                          }
                        >
                          <span
                            className={
                              item.line.op === 'add'
                                ? 'w-3 shrink-0 select-none text-emerald-600 dark:text-emerald-400'
                                : item.line.op === 'remove'
                                  ? 'w-3 shrink-0 select-none text-red-600 dark:text-red-400'
                                  : 'w-3 shrink-0 select-none text-muted-foreground/40'
                            }
                          >
                            {item.line.op === 'add' ? '+' : item.line.op === 'remove' ? '-' : ' '}
                          </span>
                          {/* 空行也要占位，否则看起来像是"少了一行" */}
                          <span className="min-w-0 whitespace-pre-wrap break-words">
                            {item.line.text || '\u00A0'}
                          </span>
                        </div>
                      ),
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

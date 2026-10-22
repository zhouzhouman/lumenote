'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPost, ApiRequestError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Markdown } from '@/components/ui/markdown';
import { BatchStatusBadge } from './batch-console';

/**
 * 批次详情：逐条状态 + 结果预览 + 导出。
 *
 * 运行中的批次每 3 秒轮询一次。为什么用轮询而不是 SSE：
 * 批次的关键信息是「第几条跑完了」，粒度是**条目**而不是 token；
 * 为 20 条材料各开一条 SSE 连接既复杂又容易断，轮询在这个粒度上完全够用。
 */

interface BatchDetail {
  batch: {
    id: string;
    name: string;
    type: string;
    status: string;
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    budgetCny: number | null;
    costCny: number;
    cancelRequested: boolean;
    params: Record<string, unknown> | null;
    createdAt: string;
    finishedAt: string | null;
  };
  items: BatchItem[];
}

interface BatchItem {
  id: string;
  title: string;
  status: string;
  order: number | null;
  inputType: string;
  inputRef: string | null;
  degraded: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  output: string | null;
  model: string | null;
  tokens: { input: number; output: number } | null;
  costCny: number;
  promptVersionId: string;
}

const RUNNING = new Set(['queued', 'running']);

export function BatchDetail({ batchId }: { batchId: string }) {
  const [data, setData] = useState<BatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);

  /** 只取数据、不碰 state，供首屏 effect 与轮询复用 */
  const fetchDetail = useCallback(
    async () => await apiGet<BatchDetail>(`/api/batches/${batchId}`),
    [batchId],
  );

  /** 事件回调里用（取消后刷新等），不在 effect 内直接调用 */
  const refresh = useCallback(async () => {
    try {
      const d = await fetchDetail();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : '加载失败');
    }
  }, [fetchDetail]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await fetchDetail();
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiRequestError ? e.message : '加载失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchDetail]);

  // 仅在运行中轮询，结束后自动停 —— 别让一个看完的页面永远在发请求
  useEffect(() => {
    if (!data || !RUNNING.has(data.batch.status)) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [data, refresh]);

  async function cancel() {
    setCanceling(true);
    try {
      await apiPost(`/api/batches/${batchId}/cancel`);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : '取消失败');
    } finally {
      setCanceling(false);
    }
  }

  if (error && !data) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!data) {
    return <p className="text-sm text-muted-foreground">加载中…</p>;
  }

  const { batch, items } = data;
  const running = RUNNING.has(batch.status);
  const done = batch.succeeded + batch.failed + batch.skipped;
  const progress = batch.total > 0 ? Math.round((done / batch.total) * 100) : 0;
  const selectedItem = items.find((i) => i.id === selected) ?? null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CardTitle>{batch.name}</CardTitle>
              <BatchStatusBadge status={batch.status} />
              {batch.cancelRequested && running && (
                <Badge variant="warning">正在停止…</Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(`/api/batches/${batchId}/export?format=md`, '_blank')}
                disabled={items.length === 0}
              >
                导出 Markdown
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(`/api/batches/${batchId}/export?format=csv`, '_blank')}
                disabled={items.length === 0}
              >
                导出 CSV
              </Button>
              {running && (
                <Button variant="ghost" size="sm" loading={canceling} onClick={cancel}>
                  停止批次
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <Stat label="材料数" value={String(batch.total)} />
            <Stat label="成功" value={String(batch.succeeded)} tone="ok" />
            <Stat label="失败" value={String(batch.failed)} tone={batch.failed > 0 ? 'bad' : undefined} />
            <Stat
              label="未执行"
              value={String(batch.skipped)}
              tone={batch.skipped > 0 ? 'warn' : undefined}
            />
            <Stat
              label="成本"
              value={
                batch.budgetCny != null
                  ? `¥${batch.costCny.toFixed(4)} / ¥${batch.budgetCny.toFixed(2)}`
                  : `¥${batch.costCny.toFixed(4)}`
              }
            />
          </div>

          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {done}/{batch.total} 已处理（{progress}%）
            {running && '　·　可以关掉页面，后台继续跑'}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>条目</CardTitle>
          <p className="text-sm text-muted-foreground">
            点一行查看结果。「未执行」表示因为预算或取消没发请求——**没有花钱**，与「失败」不同。
          </p>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => setSelected(selected === it.id ? null : it.id)}
                className="flex w-full items-center justify-between gap-3 py-2.5 text-left transition-colors hover:bg-accent/40"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="w-6 shrink-0 text-xs text-muted-foreground">
                    {(it.order ?? 0) + 1}
                  </span>
                  <span className="truncate text-sm">{it.title}</span>
                  <ItemStatus item={it} />
                  {it.degraded && <Badge variant="warning">降级</Badge>}
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                  {it.tokens && <span>{it.tokens.input}→{it.tokens.output} tok</span>}
                  {it.costCny > 0 && <span>¥{it.costCny.toFixed(4)}</span>}
                  {it.latencyMs != null && <span>{(it.latencyMs / 1000).toFixed(1)}s</span>}
                </div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {selectedItem && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>{selectedItem.title}</CardTitle>
              <Link
                href={`/history/${selectedItem.id}`}
                className="text-xs text-primary underline underline-offset-2"
              >
                在历史中打开完整详情
              </Link>
            </div>
            <p className="text-xs text-muted-foreground">
              {selectedItem.model ?? '未知模型'}
              {'　·　'}Prompt 版本 {selectedItem.promptVersionId.slice(0, 8)}
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {selectedItem.errorMessage && (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {selectedItem.errorCode ? `[${selectedItem.errorCode}] ` : ''}
                {selectedItem.errorMessage}
              </p>
            )}
            {selectedItem.output ? (
              <Markdown content={selectedItem.output} />
            ) : (
              <p className="text-sm text-muted-foreground">（无输出）</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ItemStatus({ item }: { item: BatchItem }) {
  switch (item.status) {
    case 'succeeded':
      return <Badge variant="success">成功</Badge>;
    case 'failed':
      return <Badge variant="destructive">失败</Badge>;
    case 'canceled':
      return <Badge variant="secondary">未执行</Badge>;
    case 'running':
      return <Badge variant="secondary">处理中</Badge>;
    default:
      return <Badge variant="secondary">排队中</Badge>;
  }
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad';
}) {
  const color =
    tone === 'ok'
      ? 'text-emerald-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : tone === 'bad'
          ? 'text-destructive'
          : '';
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-sm font-medium ${color}`}>{value}</div>
    </div>
  );
}

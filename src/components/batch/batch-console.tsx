'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiGet, apiPost, ApiRequestError } from '@/lib/api-client';
import { parseBatchInput } from '@/lib/batch/parse';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

/**
 * 批次控制台：新建批次 + 批次列表。
 *
 * 交互上的两个刻意选择：
 *  1. **不做文件上传**，用一个文本框 + `---` 分隔。内部场景的材料常常是从
 *     邮件/IM/Word 里复制出来的，粘贴比找文件快；也避免了 PDF 解析这一整块。
 *  2. 输入框下方**实时显示会切出几份**。批量操作最怕「我以为交了 5 份，
 *     实际被切成了 3 份」，提前显示比事后解释便宜得多。
 */

interface BatchRow {
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
  createdAt: string;
}

const TYPE_OPTIONS = [
  { value: 'summarize', label: '摘要' },
  { value: 'translate', label: '翻译' },
  { value: 'write', label: '润色改写' },
] as const;

export function BatchConsole() {
  const router = useRouter();
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [type, setType] = useState<(typeof TYPE_OPTIONS)[number]['value']>('summarize');
  const [content, setContent] = useState('');
  const [budget, setBudget] = useState('');
  const [pointCount, setPointCount] = useState('5');

  /**
   * 只负责取数据，不碰 state —— 这样 effect 里就不会「直接触发 setState」，
   * 也就能按仓库既有约定（IIFE + cancelled 守卫）写首屏加载。
   */
  const fetchRows = useCallback(
    async () => (await apiGet<{ items: BatchRow[] }>('/api/batches?limit=30')).items,
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const items = await fetchRows();
        if (!cancelled) setRows(items);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiRequestError ? e.message : '批次列表加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchRows]);

  // 与服务端同一套解析规则（parseBatchInput 是纯函数，可以直接在客户端复用）
  const parsed = content.trim()
    ? parseBatchInput(content, { maxItems: 20, maxCharsPerItem: 60_000, maxTotalChars: 200_000 })
    : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!parsed || parsed.items.length === 0) {
      setError('请先粘贴材料');
      return;
    }
    if (parsed.problems.length > 0) {
      // 服务端也会拦，这里先挡一道：让用户立刻知道哪一份有问题
      setError(parsed.problems.join('；'));
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiPost<{ batchId: string; failedOnCreate: number }>('/api/batches', {
        name: name.trim() || undefined,
        type,
        content,
        // 与单篇任务接口的契约一致：params 的值一律是字符串
        params: { pointCount: String(Number(pointCount) || 5) },
        budgetCny: budget ? Number(budget) : undefined,
      });
      router.push(`/batches/${res.batchId}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : '创建批次失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>新建批次</CardTitle>
          <p className="text-sm text-muted-foreground">
            一次提交多份材料，按顺序串行处理。多份之间用单独一行 <code className="rounded bg-muted px-1">---</code>{' '}
            分隔；某一整块是链接时按网页读取。
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} autoComplete="off" className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="batch-name">批次名（可选）</Label>
                <Input
                  id="batch-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="留空自动按时间命名"
                  maxLength={60}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="batch-type">任务类型</Label>
                <select
                  id="batch-type"
                  value={type}
                  onChange={(e) => setType(e.target.value as typeof type)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  {TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="batch-budget">预算上限（元，可选）</Label>
                <Input
                  id="batch-budget"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="不填 = 不限制"
                  autoComplete="off"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="batch-content">材料</Label>
              <Textarea
                id="batch-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={'第一份材料正文…\n---\n# 第二份的标题\n第二份正文…\n---\nhttps://example.com/report'}
                className="min-h-[180px] font-mono text-[13px]"
                disabled={submitting}
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {parsed ? `将切分为 ${parsed.items.length} 份` : '尚未输入材料'}
                  {'　'}·{'　'}每份 ≤ 6 万字，合计 ≤ 20 万字，单批 ≤ 20 份
                </span>
                <span>
                  {type === 'summarize' && (
                    <>
                      每份要点数
                      <Input
                        value={pointCount}
                        onChange={(e) => setPointCount(e.target.value)}
                        className="ml-1 inline-flex h-6 w-14 px-1 py-0 text-xs"
                        inputMode="numeric"
                        autoComplete="off"
                      />
                    </>
                  )}
                </span>
              </div>
              {parsed && parsed.problems.length > 0 && (
                <ul className="space-y-0.5 text-xs text-destructive">
                  {parsed.problems.map((p) => (
                    <li key={p}>· {p}</li>
                  ))}
                </ul>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex items-center gap-3">
              <Button type="submit" loading={submitting} disabled={!parsed || parsed.items.length === 0}>
                开始处理 {parsed ? `（${parsed.items.length} 份）` : ''}
              </Button>
              <p className="text-xs text-muted-foreground">
                提交后可以关掉页面，批次会在后台跑完；预算超了会停下并把剩余条目标为「未执行」。
              </p>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>最近的批次</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有批次。上面新建一个即可。</p>
          ) : (
            <div className="divide-y">
              {rows.map((b) => (
                <Link
                  key={b.id}
                  href={`/batches/${b.id}`}
                  className="flex items-center justify-between gap-4 py-3 transition-colors hover:bg-accent/40"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{b.name}</span>
                      <BatchStatusBadge status={b.status} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {b.succeeded}/{b.total} 成功
                      {b.failed > 0 && ` · ${b.failed} 失败`}
                      {b.skipped > 0 && ` · ${b.skipped} 未执行`}
                      {' · '}¥{b.costCny.toFixed(4)}
                      {b.budgetCny != null && ` / 预算 ¥${b.budgetCny.toFixed(2)}`}
                    </p>
                  </div>
                  <time className="shrink-0 text-xs text-muted-foreground">
                    {new Date(b.createdAt).toLocaleString('zh-CN', { hour12: false })}
                  </time>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function BatchStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'succeeded':
      return <Badge variant="success">完成</Badge>;
    case 'partial':
      return <Badge variant="warning">部分成功</Badge>;
    case 'failed':
      return <Badge variant="destructive">失败</Badge>;
    case 'canceled':
      return <Badge variant="secondary">已取消</Badge>;
    case 'running':
      return <Badge variant="secondary">处理中</Badge>;
    default:
      return <Badge variant="secondary">排队中</Badge>;
  }
}

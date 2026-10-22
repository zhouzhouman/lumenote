'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, ApiRequestError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/**
 * 审计日志视图。
 *
 * 交互上只做三件事：筛、看、导。
 * 刻意不加「删除日志」「标记已处理」这类按钮 —— 审计日志的价值全在
 * 「谁都改不了」。一旦给了入口，哪怕只给管理员，这份记录的证明力就会打折。
 */

interface AuditRow {
  id: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: string;
  ip: string | null;
  userAgent: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

interface AuditResponse {
  isAuditor: boolean;
  actions: { value: string; label: string }[];
  items: AuditRow[];
  nextCursor: string | null;
}

const OUTCOME_LABEL: Record<string, string> = {
  success: '成功',
  denied: '被拒绝',
  failed: '失败',
};

export function AuditLogView() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [extra, setExtra] = useState<AuditRow[]>([]);

  const fetchPage = useCallback(
    async (cursor?: string | null) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (action) qs.set('action', action);
      if (cursor) qs.set('before', cursor);
      return await apiGet<AuditResponse>(`/api/audit?${qs.toString()}`);
    },
    [action],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await fetchPage(null);
        if (!cancelled) {
          setData(d);
          setExtra([]);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiRequestError ? e.message : '审计日志加载失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  async function loadMore() {
    if (!data?.nextCursor) return;
    setLoadingMore(true);
    try {
      const d = await fetchPage(data.nextCursor);
      setExtra((prev) => [...prev, ...d.items]);
      setData({ ...d, items: data.items });
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : '加载失败');
    } finally {
      setLoadingMore(false);
    }
  }

  if (error && !data) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">加载中…</p>;

  const rows = [...data.items, ...extra];
  const labelOf = (a: string) => data.actions.find((x) => x.value === a)?.label ?? a;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CardTitle>操作记录</CardTitle>
              {data.isAuditor && <Badge variant="warning">审计员视图 · 可见全员</Badge>}
            </div>
            <div className="flex items-center gap-2">
              <select
                value={action}
                onChange={(e) => setAction(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">全部动作</option>
                {data.actions.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open('/api/audit/export?format=csv', '_blank')}
              >
                导出 CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open('/api/audit/export?format=json', '_blank')}
              >
                导出 JSON
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            记录批次、凭证、分享链接等敏感动作。日志**只增不改**：系统不提供修改或删除入口，
            导出本身也会被记一条。
          </p>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有记录。</p>
          ) : (
            <div className="divide-y">
              {rows.map((r) => (
                <div key={r.id} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{labelOf(r.action)}</span>
                      <OutcomeBadge outcome={r.outcome} />
                      <span className="text-xs text-muted-foreground">
                        {r.targetType}
                        {r.targetId ? ` · ${r.targetId.slice(0, 8)}` : ''}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {r.actorEmail}
                      {r.ip ? `　·　${r.ip}` : ''}
                      {r.meta ? `　·　${summarizeMeta(r.meta)}` : ''}
                    </p>
                  </div>
                  <time className="shrink-0 text-xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })}
                  </time>
                </div>
              ))}
            </div>
          )}

          {data.nextCursor && (
            <div className="pt-3">
              <Button variant="ghost" size="sm" loading={loadingMore} onClick={loadMore}>
                加载更多
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  if (outcome === 'denied') return <Badge variant="warning">{OUTCOME_LABEL.denied}</Badge>;
  if (outcome === 'failed') return <Badge variant="destructive">{OUTCOME_LABEL.failed}</Badge>;
  return <Badge variant="success">{OUTCOME_LABEL.success}</Badge>;
}

/** meta 压成一行摘要：审计页要的是「一眼看懂发生了什么」，不是完整 JSON */
function summarizeMeta(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      parts.push(`${k}=${Array.isArray(v) ? v.join('/') : '{…}'}`);
    } else {
      parts.push(`${k}=${String(v)}`);
    }
    if (parts.length >= 4) break;
  }
  return parts.join('，');
}

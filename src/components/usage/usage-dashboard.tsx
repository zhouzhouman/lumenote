'use client';

import * as React from 'react';
import { apiGet, withQuery, ApiRequestError } from '@/lib/api-client';
import type { UsageSummaryDto } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type UsageDto = UsageSummaryDto;

const RANGES = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' },
] as const;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function UsageDashboard() {
  const [days, setDays] = React.useState<number>(30);

  /**
   * 用「请求键」判断数据是否对应当前筛选，而不是额外维护 loading 状态。
   *
   * loading 本质是「已渲染的数据是不是本次请求的结果」的派生值，
   * 把它算出来比手动 setState 同步更准：切换区间的那一帧，
   * 旧写法会先清空数据再显示 loading（内容闪一下），
   * 这里则保持旧数据并标记为过期，切换观感更稳。
   */
  const [result, setResult] = React.useState<{ key: string; data: UsageDto } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const key = String(days);
    let cancelled = false;

    void (async () => {
      try {
        const data = await apiGet<UsageDto>(withQuery('/api/usage/summary', { days }));
        if (cancelled) return;
        setResult({ key, data });
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiRequestError ? e.message : '加载失败');
      }
    })();

    // 卸载后不要再 setState，避免 React 警告与内存泄漏
    return () => {
      cancelled = true;
    };
  }, [days]);

  const loading = result?.key !== String(days) && !error;

  if (loading) return <p className="py-12 text-center text-sm text-muted-foreground">加载中…</p>;
  if (error) {
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {error}
      </div>
    );
  }
  if (!result) return null;

  const data = result.data;

  const successRate =
    data.totalRequests === 0 ? 0 : (data.successRequests / data.totalRequests) * 100;
  const quotaPct = data.quota.limit > 0 ? Math.min(100, (data.quota.used / data.quota.limit) * 100) : 0;
  const maxCost = Math.max(...data.byModel.map((m) => m.costCny), 0);

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        {RANGES.map((r) => (
          <Button
            key={r.days}
            size="sm"
            variant={days === r.days ? 'default' : 'outline'}
            onClick={() => setDays(r.days)}
          >
            {r.label}
          </Button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="总花费"
          value={`¥${data.totalCostCny.toFixed(4)}`}
          hint={`${data.totalRequests} 次请求`}
        />
        <Stat
          label="成功率"
          value={`${successRate.toFixed(1)}%`}
          hint={`失败 ${data.failedRequests} 次`}
        />
        <Stat
          label="缓存命中率"
          value={`${(data.cacheHitRate * 100).toFixed(1)}%`}
          hint={`命中 ${data.totalCachedTokens} tokens`}
        />
        <Stat
          label="首字延迟 P95"
          value={`${data.p95TtftMs} ms`}
          hint={`平均耗时 ${data.avgLatencyMs} ms`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">今日配额</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span>
              {data.quota.used} / {data.quota.limit} 次
            </span>
            <span className="text-muted-foreground">{data.quota.plan} 方案</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${quotaPct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {data.quota.bypassedByUserCredential
              ? '你正在使用自己的 API Key，不占用站点免费配额。这里的次数仅作统计。'
              : '配额用于防止脚本误刷导致成本失控。超出后当日无法再创建任务；也可以到「模型设置」填入自己的 API Key 解除限制。'}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">按模型分布</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byModel.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无数据</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-medium">模型</th>
                  <th className="pb-2 text-right font-medium">请求</th>
                  <th className="pb-2 text-right font-medium">输入</th>
                  <th className="pb-2 text-right font-medium">输出</th>
                  <th className="pb-2 text-right font-medium">花费</th>
                </tr>
              </thead>
              <tbody>
                {data.byModel.map((m) => (
                  <tr key={m.model} className="border-b last:border-0">
                    <td className="py-2">
                      <div className="font-medium">{m.model}</div>
                      {/* 用相对宽度条直观看出成本大头，比纯数字更容易发现问题 */}
                      <div className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary/70"
                          style={{ width: `${maxCost > 0 ? (m.costCny / maxCost) * 100 : 0}%` }}
                        />
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">{m.requests}</td>
                    <td className="py-2 text-right tabular-nums">{m.inputTokens}</td>
                    <td className="py-2 text-right tabular-nums">{m.outputTokens}</td>
                    <td className="py-2 text-right tabular-nums">¥{m.costCny.toFixed(5)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
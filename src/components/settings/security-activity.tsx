'use client';

import * as React from 'react';
import { apiGet, apiDelete, withQuery, ApiRequestError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface EventItem {
  id: string;
  type: string;
  label: string;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
  ip: string | null;
  device: string;
  createdAt: string;
}

interface SessionItem {
  id: string;
  device: string;
  ip: string | null;
  createdAt: string;
  expiresAt: string;
}

interface Payload {
  account: {
    emailVerified: boolean;
    /** 本站是否要求邮箱验证；false 时「未验证」是正常状态，不是故障 */
    emailVerificationRequired: boolean;
    createdAt: string | null;
    lastLoginAt: string | null;
    recentFailures: number;
  };
  events: EventItem[];
  sessions: SessionItem[];
}

/** 事件色调映射。写成完整字面量，Tailwind 不做动态拼接 */
const TONE_CLASS: Record<EventItem['tone'], string> = {
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  bad: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  neutral: 'bg-muted text-muted-foreground',
};

/**
 * 登录活动 / 安全事件面板。
 *
 * 定位说明：这不是「给运维看的审计日志」，而是**给用户自己看的自查工具**。
 * 账号被盗时，用户是唯一能发现「这条记录不该是我」的人 ——
 * 运维不知道用户的作息与所在地。
 *
 * 所以信息呈现围绕「能不能一眼看出异常」来设计：
 * 时间、IP、设备三者并列，异常记录用颜色区分。
 */
export function SecurityActivity() {
  const [reloadToken, setReloadToken] = React.useState(0);
  const [data, setData] = React.useState<Payload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const reload = React.useCallback(() => setReloadToken((n) => n + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await apiGet<Payload>('/api/security/events');
        if (cancelled) return;
        setData(payload);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiRequestError ? e.message : '加载失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const loading = data === null && error === null;

  async function revoke(session: SessionItem) {
    if (!window.confirm(`确定踢掉这个会话？\n\n${session.device}\n${session.ip ?? '未知 IP'}`)) return;
    setBusyId(session.id);
    setNotice(null);
    try {
      await apiDelete(withQuery('/api/security/events', { sessionId: session.id }));
      setNotice('该会话已被销毁，对应设备需要重新登录');
      reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  }

  async function revokeAll() {
    if (!data) return;
    if (!window.confirm(`确定踢掉全部 ${data.sessions.length} 个会话？\n\n你自己也需要重新登录。`)) return;
    setBusyId('__all__');
    setNotice(null);
    try {
      for (const s of data.sessions) {
        await apiDelete(withQuery('/api/security/events', { sessionId: s.id }));
      }
      setNotice('已销毁全部会话，请重新登录');
      reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return <p className="py-12 text-center text-sm text-muted-foreground">加载中…</p>;
  }

  if (error && !data) {
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {error}
      </div>
    );
  }

  if (!data) return null;

  const risky = data.account.recentFailures > 0;

  return (
    <div className="space-y-5">
      {notice && (
        <p className="rounded-md border border-emerald-600/30 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          {notice}
        </p>
      )}
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* 风险提示：只在失败次数 > 0 时出现，避免平时制造焦虑 */}
      {risky && (
        <div className="rounded-md border border-amber-600/40 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">
            近期有 {data.account.recentFailures} 次登录失败
          </p>
          <p className="mt-1">
            如果这些不是你本人操作的，说明有人在尝试猜你的密码。
            连续失败达到阈值后账号会被临时锁定。建议修改密码。
          </p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">账号状态</CardTitle>
          <CardDescription>
            {data.account.emailVerified
              ? '邮箱已验证'
              : data.account.emailVerificationRequired
                ? '邮箱未验证'
                : '邮箱未验证（本站未开启验证）'}{' '}
            ·{' '}
            {data.account.createdAt
              ? `注册于 ${new Date(data.account.createdAt).toLocaleDateString('zh-CN')}`
              : '注册时间未知'}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            最近登录：
            {data.account.lastLoginAt
              ? new Date(data.account.lastLoginAt).toLocaleString('zh-CN')
              : '—'}
          </p>
        </CardContent>
      </Card>

      {/* 活跃会话 */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">活跃会话（{data.sessions.length}）</CardTitle>
            <CardDescription>
              每个会话代表一台还能免密访问你账号的设备。改密码不会让它们失效，
              必须在这里显式销毁。
            </CardDescription>
          </div>
          {data.sessions.length > 1 && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              loading={busyId === '__all__'}
              onClick={revokeAll}
            >
              全部踢出
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {data.sessions.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">没有活跃会话</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {data.sessions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">{s.device}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {s.ip ?? '未知 IP'} · 登录于{' '}
                      {new Date(s.createdAt).toLocaleString('zh-CN')} · 有效至{' '}
                      {new Date(s.expiresAt).toLocaleDateString('zh-CN')}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-destructive"
                    loading={busyId === s.id}
                    onClick={() => revoke(s)}
                  >
                    踢出
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 安全事件 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">安全事件（最近 {data.events.length} 条）</CardTitle>
          <CardDescription>
            包括登录成功、登录失败、账号锁定、注册等。这里只记录事件与来源信息，
            不记录任何密码或验证码。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.events.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">暂无记录</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {data.events.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[e.tone]}`}
                    >
                      {e.label}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{e.device}</span>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {e.ip ?? '未知 IP'} · {new Date(e.createdAt).toLocaleString('zh-CN')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">发现异常时怎么办</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-sm text-muted-foreground">
          <p>1. 在上方「全部踢出」，让所有设备重新登录。</p>
          <p>2. 修改密码 —— 建议同时换用更长的密码。</p>
          <p>3. 如果配置过自己的 API Key，到「模型设置」里删除并重新创建。</p>
          <p>
            4. 注意：这里的记录只覆盖本应用的登录。邮箱本身若被攻破，
            对方可以通过验证码重置一切 —— 邮箱的密码同样需要加固。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

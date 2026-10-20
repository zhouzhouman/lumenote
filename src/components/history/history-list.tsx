'use client';

import * as React from 'react';
import Link from 'next/link';
import { apiGet, apiDelete, apiPatch, apiPost, withQuery, ApiRequestError } from '@/lib/api-client';
import type { CursorPage, TaskDetail, TaskStatus, TaskSummary } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Markdown } from '@/components/ui/markdown';
import { CopyButton, DownloadButton } from '@/components/ui/copy-button';
import { DiffView } from '@/components/history/diff-view';
import {
  AgentResultView,
  type StructuredOutput,
  type TimelineStep,
} from '@/components/agent/agent-timeline';

/**
 * 历史记录页。
 *
 * 两个关键实现选择：
 *
 * 1. **cursor 分页而非页码**
 *    后端返回 nextCursor 而非「第几页」。翻页时把已加载的条目追加到列表尾部，
 *    这样用户可以连续下滚，也不会因新任务插入而出现重复或遗漏。
 *
 * 2. **筛选变化时重置游标**
 *    游标是「上一页最后一条的位置」，换了筛选条件后它就失效了，
 *    继续带上去会返回错误的页。这也是最容易写漏的一处。
 */

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
};

function StatusBadge({ status, degraded }: { status: TaskStatus; degraded: boolean }) {
  if (degraded && status === 'succeeded') {
    return <Badge variant="warning">降级结果</Badge>;
  }
  switch (status) {
    case 'succeeded':
      return <Badge variant="success">{STATUS_LABEL[status]}</Badge>;
    case 'failed':
      return <Badge variant="destructive">{STATUS_LABEL[status]}</Badge>;
    case 'running':
    case 'queued':
      return <Badge variant="secondary">{STATUS_LABEL[status]}</Badge>;
    default:
      return <Badge variant="outline">{STATUS_LABEL[status]}</Badge>;
  }
}

export function HistoryList() {
  const [search, setSearch] = React.useState('');
  /** 用 debounce 后的值才发请求，避免每敲一个字就打一次接口 */
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [showDeleted, setShowDeleted] = React.useState(false);
  const [detail, setDetail] = React.useState<TaskDetail | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [loadMoreError, setLoadMoreError] = React.useState<string | null>(null);

  /**
   * 对比模式。
   *
   * 为什么要单独一个模式，而不是在每条记录上加个「对比」勾选框：
   * 列表项的主要操作是「点开看内容」，常驻勾选框会让点击区域的含义变模糊
   * （点标题是看详情、点勾选框是选中）。用一个显式模式切换，
   * 两种意图互不干扰。
   *
   * `compareIds` 最多两个：第一个选中的是 A（旧），第二个是 B（新）。
   * 用户的心智是「拿这个和那个比」，而不是「勾选一堆然后批量操作」。
   */
  const [compareMode, setCompareMode] = React.useState(false);
  const [compareIds, setCompareIds] = React.useState<string[]>([]);
  const [diffPair, setDiffPair] = React.useState<{ a: string; b: string } | null>(null);

  function toggleCompare(id: string) {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      // 超过两个时挤掉最早选的那个 —— 比弹一个「最多选两个」的提示更顺手
      if (prev.length >= 2) return [prev[1]!, id];
      return [...prev, id];
    });
  }

  function exitCompare() {
    setCompareMode(false);
    setCompareIds([]);
  }

  /**
   * 用「请求键」推导 loading，而不是在 effect 里 setLoading(true)。
   *
   * 这样做有两个好处：
   *  1. 避免 effect 内同步 setState 引起的级联渲染（React 官方明确不推荐）
   *  2. 更重要的是**语义正确**：loading 不再是一个需要和请求「同步」的状态，
   *     而是「当前渲染的这份数据是不是本次请求的结果」的派生值。
   *     旧写法在慢网下会先闪一下 loading 再闪回旧数据，容易让人以为出错了。
   *
   * reloadToken 用于「软删/恢复后重载」：它并入 requestKey 后，
   * 自增就能让上面那个 effect 自然重新执行，不需要手动再调一次加载函数。
   */
  const [reloadToken, setReloadToken] = React.useState(0);
  const requestKey = `${debouncedSearch}|${showDeleted}|${reloadToken}`;

  const [result, setResult] = React.useState<{
    key: string;
    items: TaskSummary[];
    cursor: string | null;
    hasMore: boolean;
  } | null>(null);
  const [firstPageError, setFirstPageError] = React.useState<string | null>(null);

  const loading = result?.key !== requestKey;

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  /**
   * 拉第一页。
   *
   * 只在 await 之后 setState，effect 体内不做任何同步状态更新。
   * cancelled 守卫用来丢弃「请求已返回但组件已卸载/条件已变」的过期响应 ——
   * 否则快速切换筛选条件时，先发的请求可能后到并覆盖新条件的结果。
   */
  React.useEffect(() => {
    const key = requestKey;
    let cancelled = false;

    void (async () => {
      try {
        const page: CursorPage<TaskSummary> = await apiGet(
          withQuery('/api/tasks', {
            limit: 20,
            q: debouncedSearch || undefined,
            deleted: showDeleted ? 'true' : undefined,
          }),
        );
        if (cancelled) return;
        setResult({
          key,
          items: page.items,
          cursor: page.nextCursor,
          hasMore: page.hasMore,
        });
        setFirstPageError(null);
      } catch (e) {
        if (cancelled) return;
        setFirstPageError(e instanceof ApiRequestError ? e.message : '加载失败');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [requestKey, debouncedSearch, showDeleted]);

  const items = result?.items ?? [];
  const cursor = result?.cursor ?? null;
  const hasMore = result?.hasMore ?? false;
  const error = firstPageError ?? loadMoreError;

  /**
   * 软删/恢复后整体重载。
   * 不直接改本地 items —— 那需要同时维护游标、hasMore 与去重逻辑，
   * 容易出现「列表变了但翻页起点错了」这类难查的问题，重载更可靠。
   */
  function reload() {
    setReloadToken((n) => n + 1);
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await apiGet<CursorPage<TaskSummary>>(
        withQuery('/api/tasks', {
          limit: 20,
          cursor,
          q: debouncedSearch || undefined,
          deleted: showDeleted ? 'true' : undefined,
        }),
      );
      /**
       * 把新一页并进当前结果。
       *
       * 去重是必需的：翻页期间若发生删除/插入，同一条可能被服务端重复返回。
       * 同时更新 cursor 时要带上 key，确保它仍属于**当前**这份结果 ——
       * 若期间筛选条件变了，这次响应已经过期，直接丢弃而不是污染新列表。
       */
      setResult((prev) => {
        if (!prev || prev.key !== requestKey) return prev;
        const seen = new Set(prev.items.map((i) => i.id));
        return {
          ...prev,
          items: [...prev.items, ...page.items.filter((i) => !seen.has(i.id))],
          cursor: page.nextCursor,
          hasMore: page.hasMore,
        };
      });
    } catch (e) {
      setLoadMoreError(e instanceof ApiRequestError ? e.message : '加载更多失败');
    } finally {
      setLoadingMore(false);
    }
  }

  async function openDetail(id: string) {
    setLoadMoreError(null);
    try {
      setDetail(await apiGet<TaskDetail>(`/api/tasks/${id}`));
    } catch (e) {
      setLoadMoreError(e instanceof ApiRequestError ? e.message : '读取详情失败');
    }
  }

  async function toggleDelete(task: TaskSummary) {
    try {
      if (showDeleted) {
        // PATCH 语义即「恢复」，不需要请求体
        await apiPatch(`/api/tasks/${task.id}`);
      } else {
        await apiDelete(`/api/tasks/${task.id}`);
      }
      // 软删/恢复都会改变当前列表的组成，整体重载最简单可靠
      reload();
      if (detail?.id === task.id) setDetail(null);
    } catch (e) {
      setLoadMoreError(e instanceof ApiRequestError ? e.message : '操作失败');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索标题或结果内容"
          className="max-w-xs"
        />
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          查看回收站
        </label>

        {/* 对比模式的入口与操作条 */}
        {!compareMode ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => setCompareMode(true)}
            disabled={items.length < 2}
            title={items.length < 2 ? '至少需要两条记录才能对比' : '选择两条记录进行版本对比'}
          >
            对比版本
          </Button>
        ) : (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {compareIds.length === 0
                ? '选择旧版本'
                : compareIds.length === 1
                  ? '再选择新版本'
                  : '已选两个版本'}
            </span>
            <Button
              size="sm"
              disabled={compareIds.length !== 2}
              onClick={() => {
                // 按选中顺序：第 1 个是 A（旧），第 2 个是 B（新）。
                // 顺序有意义 —— diff 的「新增/删除」方向依赖它
                setDiffPair({ a: compareIds[0]!, b: compareIds[1]! });
              }}
            >
              开始对比
            </Button>
            <Button variant="ghost" size="sm" onClick={exitCompare}>
              退出对比
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {loading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">加载中…</p>
      ) : items.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          还没有记录。去工作台生成第一条摘要吧。
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((t) => (
            <li key={t.id}>
              <Card className="transition-colors hover:border-primary/40">
                <CardContent className="flex items-start justify-between gap-4 p-4">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => (compareMode ? toggleCompare(t.id) : openDetail(t.id))}
                  >
                    <div className="flex items-center gap-2">
                      {compareMode && (
                        <span
                          className={
                            compareIds.includes(t.id)
                              ? 'grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-medium text-primary-foreground'
                              : 'grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] text-muted-foreground'
                          }
                        >
                          {compareIds.includes(t.id) ? compareIds.indexOf(t.id) + 1 : ''}
                        </span>
                      )}
                      <span className="truncate font-medium">{t.title}</span>
                      <StatusBadge status={t.status} degraded={t.degraded} />
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {t.preview || '（无输出内容）'}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(t.createdAt).toLocaleString('zh-CN')} · {t.charCount} 字 ·{' '}
                      {t.promptVersion.templateName} v{t.promptVersion.version}
                    </p>
                  </button>

                  {!compareMode && (
                    <Button variant="ghost" size="sm" onClick={() => toggleDelete(t)}>
                      {showDeleted ? '恢复' : '删除'}
                    </Button>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" onClick={loadMore} loading={loadingMore}>
            加载更多
          </Button>
        </div>
      )}

      {detail && <DetailDialog detail={detail} onClose={() => setDetail(null)} />}

      {diffPair && (
        <DiffView aId={diffPair.a} bId={diffPair.b} onClose={() => setDiffPair(null)} />
      )}
    </div>
  );
}

/**
 * Agent 任务在历史详情里的视图。
 *
 * 数据来源是 `outputMeta`（它同时带着 structured 与 agentSteps）——
 * 详情接口把它们塞在那里而不是加顶层字段，理由见 tasks/[id] 路由的注释。
 * 因为 outputMeta 的类型是宽松的 Record，这里必须**显式收窄**：
 * 直接 `as` 断言会让字段名写错时静默变成 undefined，
 * 表现为「时间线永远空白」而不报错。
 */
function AgentDetailView({ detail }: { detail: TaskDetail }) {
  const meta = detail.outputMeta as {
    structured?: StructuredOutput | null;
    stopReason?: string;
    agentSteps?: {
      seq: number;
      phase: string;
      note: string | null;
      toolResults: unknown;
      cumulativeTokens: number;
      latencyMs: number;
    }[];
  };

  const steps: TimelineStep[] = (meta.agentSteps ?? []).map((s) => ({
    seq: s.seq,
    phase: s.phase,
    note: s.note ?? '',
    // 落库的 toolResults 是 Json 列，需要逐项收窄
    tools: Array.isArray(s.toolResults)
      ? (s.toolResults as { name?: unknown; display?: unknown; ok?: unknown }[]).map((t) => ({
          name: typeof t.name === 'string' ? t.name : '',
          display: typeof t.display === 'string' ? t.display : '',
          ok: t.ok === true,
        }))
      : [],
    cumulativeTokens: s.cumulativeTokens,
    latencyMs: s.latencyMs,
  }));

  return (
    <AgentResultView
      displayText={detail.outputContent ?? ''}
      structured={meta.structured ?? null}
      steps={steps}
      streaming={detail.status === 'running' || detail.status === 'queued'}
      degraded={detail.degraded}
      stopReason={meta.stopReason}
    />
  );
}

/**
 * 分享区块。
 *
 * 交互设计上刻意做成一件事：**点一下就拿到一个能发出去的链接**。
 * 重复点击复用已有链接而不是新建（schema 里 taskId 也是 unique）——
 * 用户的心智是「给我个链接」，不是「管理一批链接」；
 * 新建还会让已经发出去的旧链接悄悄失效。
 */
function ShareSection({ taskId }: { taskId: string }) {
  const [state, setState] = React.useState<{
    active: boolean;
    token: string | null;
    viewCount: number;
    expired?: boolean;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await apiGet<{ active: boolean; token: string | null; viewCount: number; expired?: boolean }>(
          withQuery('/api/share', { taskId }),
        );
        if (!cancelled) setState(r);
      } catch {
        // 分享状态查不到不该阻断详情查看，静默即可（用户点按钮时还会再报错）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const shareUrl =
    state?.token && typeof window !== 'undefined'
      ? `${window.location.origin}/share/${state.token}`
      : null;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<{ token: string; reused: boolean }>('/api/share', { taskId });
      setState({ active: true, token: r.token, viewCount: state?.viewCount ?? 0 });
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : '生成分享链接失败');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!window.confirm('撤销后这个链接立即失效，已发出去的链接将打不开。确定？')) return;
    setBusy(true);
    setError(null);
    try {
      await apiDelete(withQuery('/api/share', { taskId }));
      setState({ active: false, token: null, viewCount: state?.viewCount ?? 0 });
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : '撤销失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">只读分享</h3>
      <div className="rounded-md border p-4">
        {state?.active && shareUrl ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              任何拿到这个链接的人都能查看结果（无需登录）。
              分享的是**结果**，不包含你粘贴的原始正文。
              {state.viewCount > 0 && ` 已被查看 ${state.viewCount} 次。`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs">
                {shareUrl}
              </code>
              <CopyButton text={shareUrl} label="复制链接" />
              <Button variant="ghost" size="sm" className="text-destructive" loading={busy} onClick={revoke}>
                撤销
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {state?.expired
                ? '之前的分享链接已过期。可以重新生成一个。'
                : '生成一个不可枚举的链接，把结果发给别人查看。链接包含 Prompt 指纹与成本信息。'}
            </p>
            <Button variant="outline" size="sm" loading={busy} onClick={create}>
              {state?.expired ? '重新生成链接' : '生成分享链接'}
            </Button>
          </div>
        )}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </div>
    </section>
  );
}

/**
 * 追问区块。
 *
 * 追问会创建一个**子任务**（parentTaskId 指向当前任务），
 * 并沿用父任务的 Prompt 版本与参数 —— 这样同一条对话线的风格与模型保持一致。
 *
 * 这里只是「快速问一句」的入口；完整的多轮链路在
 * `/history/[id]` 那个独立页面里（追问本质是多轮的，
 * 弹窗里只展示一条结果，看不出模型的思路走向）。
 */
function FollowUpSection({ taskId }: { taskId: string }) {
  const [question, setQuestion] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || question.trim().length < 2) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiPost<{ taskId: string }>('/api/followup', { parentTaskId: taskId, question });
      setQuestion('');
      setNotice('已在后台处理，完成后可在历史列表里看到这条追问');
    } catch (e2) {
      setError(e2 instanceof ApiRequestError ? e2.message : '提交失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">基于这个结果继续追问</h3>
        <Link
          href={`/history/${taskId}`}
          className="text-xs text-primary underline underline-offset-2 hover:opacity-80"
        >
          查看完整对话链 →
        </Link>
      </div>
      <form onSubmit={submit} className="space-y-2">
        <div className="flex gap-2">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="例如：第二点能展开说说吗？"
            maxLength={2000}
            disabled={busy}
          />
          <Button type="submit" size="sm" className="shrink-0" loading={busy}>
            追问
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          追问会带上本条结果作为上下文，新旧任务以父子关系关联，便于回看整条推理路径。
        </p>
        {notice && <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </form>
    </section>
  );
}

/** 详情弹窗。刻意用自绘而非 <dialog>，以便完全控制焦点与滚动锁行为 */
function DetailDialog({ detail, onClose }: { detail: TaskDetail; onClose: () => void }) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    // 打开时禁止背景滚动
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const inputMeta = detail.inputMeta as { sourceHost?: string; extractedTitle?: string } | null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-10"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-lg border bg-background shadow-xl"
        // 阻止冒泡，否则点击正文会关闭弹窗
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b p-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{detail.title}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <StatusBadge status={detail.status} degraded={detail.degraded} />
              <span>{new Date(detail.createdAt).toLocaleString('zh-CN')}</span>
              {inputMeta?.sourceHost && <span>来源 {inputMeta.sourceHost}</span>}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </header>

        <div className="space-y-6 p-5">
          {/*
            Agent 任务：渲染「结论卡片 + 推理时间线」而不是一段正文。
            两种视图的信息结构差异太大（见 workspace 里同样的分支），
            硬合并会让两边都难读。
          */}
          {detail.type === 'agent' ? (
            <AgentDetailView detail={detail} />
          ) : (
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">输出结果</h3>
              {detail.outputContent && (
                <div className="flex flex-wrap gap-2">
                  <CopyButton text={detail.outputContent} />
                  <DownloadButton
                    content={detail.outputContent}
                    filename={`${detail.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.md`}
                  />
                </div>
              )}
            </div>
            {detail.outputContent ? (
              /*
               * 与工作台一致：走 Markdown 渲染。
               * 这里尤其重要 —— 历史详情是用户回头查「模型给的来源链接」的地方，
               * 以纯文本显示等于把这些链接变成死字符。
               */
              <div className="rounded-md border bg-muted/30 p-4">
                <Markdown content={detail.outputContent} />
              </div>
            ) : (
              <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
                （无输出）
              </div>
            )}
          </section>
          )}

          {/* 分享链接：只读分享是「把结论发给别人」这一需求的落地 */}
          {detail.outputContent && detail.status === 'succeeded' && (
            <ShareSection taskId={detail.id} />
          )}

          {/* 基于结果追问：多轮对话入口 */}
          {detail.outputContent && detail.status === 'succeeded' && (
            <FollowUpSection taskId={detail.id} />
          )}

          {detail.errorMessage && (
            <section>
              <h3 className="mb-2 text-sm font-medium text-destructive">失败原因</h3>
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                {detail.errorCode}：{detail.errorMessage}
              </p>
            </section>
          )}

          <section className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-md border p-3">
              <h3 className="mb-1 font-medium">Prompt 指纹</h3>
              <p className="text-muted-foreground">
                {detail.promptVersion.templateName} · v{detail.promptVersion.version}
              </p>
              {detail.promptVersion.notes && (
                <p className="mt-1 text-xs text-muted-foreground">{detail.promptVersion.notes}</p>
              )}
            </div>

            <div className="rounded-md border p-3">
              <h3 className="mb-1 font-medium">用量与成本</h3>
              {detail.usage ? (
                <>
                  <p className="text-muted-foreground">
                    输入 {detail.usage.inputTokens} / 输出 {detail.usage.outputTokens} tokens
                  </p>
                  <p className="text-muted-foreground">
                    缓存命中 {(detail.usage.cacheHitRate * 100).toFixed(1)}%
                    {detail.usage.peak && <span className="ml-2 text-amber-600">高峰计价</span>}
                  </p>
                  <p className="mt-1 font-medium">¥{detail.usage.costCny.toFixed(5)}</p>
                </>
              ) : (
                <p className="text-muted-foreground">无用量记录</p>
              )}
            </div>

            <div className="rounded-md border p-3">
              <h3 className="mb-1 font-medium">性能</h3>
              <p className="text-muted-foreground">
                总耗时 {detail.latencyMs !== null ? `${detail.latencyMs} ms` : '—'}
              </p>
              <p className="text-muted-foreground">
                首字延迟 {detail.ttftMs !== null ? `${detail.ttftMs} ms` : '—'}
              </p>
            </div>

            <div className="rounded-md border p-3">
              <h3 className="mb-1 font-medium">输入</h3>
              <p className="text-muted-foreground">{detail.charCount} 字</p>
              <p className="text-muted-foreground">{detail.inputType}</p>
              {detail.inputRef && (
                <a
                  href={detail.inputRef}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1 block truncate text-xs text-primary hover:underline"
                >
                  {detail.inputRef}
                </a>
              )}
            </div>
          </section>

          {detail.attempts.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-medium">重试与降级轨迹</h3>
              <ul className="space-y-1 text-sm">
                {detail.attempts.map((a, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className={a.ok ? 'text-emerald-600' : 'text-muted-foreground'}>
                      {a.ok ? '✓' : '✗'}
                    </span>
                    <span>{a.label}</span>
                    {a.error && <span className="text-xs text-muted-foreground">{a.error}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
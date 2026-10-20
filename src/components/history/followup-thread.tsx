'use client';

import * as React from 'react';
import Link from 'next/link';
import { apiGet, apiPost, withQuery, ApiRequestError } from '@/lib/api-client';
import { subscribeTaskStream } from '@/lib/sse-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Markdown } from '@/components/ui/markdown';
import { CopyButton } from '@/components/ui/copy-button';

interface ThreadItem {
  id: string;
  kind: 'root' | 'followup';
  question: string | null;
  title: string;
  type: string;
  status: string;
  outputContent: string | null;
  degraded: boolean;
  errorMessage: string | null;
  createdAt: string;
  templateName: string;
  promptVersion: number;
}

interface ThreadPayload {
  rootId: string;
  items: ThreadItem[];
}

const TYPE_LABEL: Record<string, string> = {
  summarize: '摘要',
  translate: '翻译',
  write: '润色改写',
};

/**
 * 追问对话链页面。
 *
 * ## 为什么需要独立页面（而不是只有详情弹窗里那一小块）
 *
 * 弹窗里的「追问」入口只解决「提一个问题」，但追问本质是**多轮**的：
 * 用户问了三轮之后，需要一页看到「原文 → 第一轮 → 第二轮 → 第三轮」
 * 的完整推理路径，才能判断模型的思路有没有跑偏。
 * 弹窗空间有限，且每次只展示一条结果。
 *
 * ## 一个关键的交互设计：追问后**流式显示在同一页**
 *
 * 追问是新建一个任务异步跑的。如果只是提交完再刷新整页，
 * 用户会失去「我正在跟这条链对话」的连续感。
 * 所以这里复用 workspace 的 SSE 订阅：新任务创建后立即在链尾插入一个
 * streaming 占位条目并订阅它的输出 —— 用户看到回答在自己眼前长出来。
 */
export function FollowUpThread({ taskId }: { taskId: string }) {
  const [data, setData] = React.useState<ThreadPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [question, setQuestion] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  /** 正在流式生成的临时条目（还没进 data.items） */
  const [streaming, setStreaming] = React.useState<{
    id: string;
    question: string;
    text: string;
    error?: string;
  } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await apiGet<ThreadPayload>(
          withQuery('/api/followup', { taskId, whole: '1' }),
        );
        if (!cancelled) setData(payload);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiRequestError ? e.message : '加载失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy || streaming) return;

    setBusy(true);
    setError(null);

    try {
      const res = await apiPost<{ taskId: string }>('/api/followup', {
        // 始终追问链上**最后一条**：这样上下文是连续的，
        // 而不是每次都回到根任务重新开始
        parentTaskId: data?.items[data.items.length - 1]?.id ?? taskId,
        question: q,
      });

      setQuestion('');
      setStreaming({ id: res.taskId, question: q, text: '' });

      await subscribeTaskStream(res.taskId, {
        onDelta: (_d, accumulated) => {
          setStreaming((s) => (s ? { ...s, text: accumulated } : s));
        },
        onDone: () => {
          // 完成后重新拉整条链，让新条目带着完整元信息（模板版本、成本等）进入列表
          setStreaming(null);
          void (async () => {
            try {
              const payload = await apiGet<ThreadPayload>(
                withQuery('/api/followup', { taskId, whole: '1' }),
              );
              setData(payload);
            } catch {
              /* 重新拉取失败时保留当前视图，用户刷新即可 */
            }
          })();
        },
        onError: (err) => {
          setStreaming((s) => (s ? { ...s, error: err.message } : s));
        },
      });
    } catch (e2) {
      setError(e2 instanceof ApiRequestError ? e2.message : '提交失败，请稍后重试');
    } finally {
      setBusy(false);
    }
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

  if (!data) {
    return <p className="py-12 text-center text-sm text-muted-foreground">加载中…</p>;
  }

  const root = data.items[0];

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {data.items.map((item, idx) => (
        <Card key={item.id}>
          <CardContent className="space-y-3 pt-5">
            <header className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground">
                  {item.kind === 'root' ? '原始结果' : `第 ${idx} 轮追问`}
                </span>
                <span>{TYPE_LABEL[item.type] ?? item.type}</span>
                <span>
                  {item.templateName} v{item.promptVersion}
                </span>
                <span>{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
                {item.degraded && <Badge variant="warning">降级</Badge>}
                {item.status === 'running' || item.status === 'queued' ? (
                  <Badge variant="secondary">生成中</Badge>
                ) : null}
              </div>
              {item.outputContent && <CopyButton text={item.outputContent} />}
            </header>

            {/* 追问的问题单独展示 —— 这是"对话"的骨架，不该被埋在正文里 */}
            {item.kind === 'followup' && item.question && (
              <div className="flex gap-3 rounded-md border-l-2 border-primary/50 bg-muted/40 py-2 pl-3">
                <span className="shrink-0 text-xs font-medium text-muted-foreground">问</span>
                <p className="text-sm">{item.question}</p>
              </div>
            )}

            {item.errorMessage ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {item.errorMessage}
              </p>
            ) : item.outputContent ? (
              <Markdown content={item.outputContent} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {item.status === 'succeeded' ? '（无输出）' : '正在生成…'}
              </p>
            )}
          </CardContent>
        </Card>
      ))}

      {/* 正在流式生成的那一条 */}
      {streaming && (
        <Card className="border-primary/40">
          <CardContent className="space-y-3 pt-5">
            <div className="flex gap-3 rounded-md border-l-2 border-primary/50 bg-muted/40 py-2 pl-3">
              <span className="shrink-0 text-xs font-medium text-muted-foreground">问</span>
              <p className="text-sm">{streaming.question}</p>
            </div>
            {streaming.error ? (
              <p className="text-sm text-destructive">{streaming.error}</p>
            ) : (
              <div className="stream-cursor">
                {streaming.text ? (
                  <Markdown content={streaming.text} />
                ) : (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    正在连接…
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 追问输入框 */}
      <form onSubmit={ask} className="space-y-2">
        <div className="flex gap-2">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="继续追问，例如：第三点能举一个具体例子吗？"
            maxLength={2000}
            disabled={busy || Boolean(streaming)}
          />
          <Button type="submit" className="shrink-0" loading={busy} disabled={Boolean(streaming)}>
            追问
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          每次追问都会带上链上最后一条结果作为上下文；新旧任务以父子关系关联。
        </p>
      </form>

      <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
        <span>
          共 {data.items.length} 条 · 根任务 <code className="rounded bg-muted px-1">{root?.id.slice(0, 8)}…</code>
        </span>
        <Link href="/history" className="underline underline-offset-2 hover:text-foreground">
          返回历史列表
        </Link>
      </div>
    </div>
  );
}

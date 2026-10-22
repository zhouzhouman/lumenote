'use client';

import { useCallback, useRef, useState } from 'react';
import { apiPost, apiGet, ApiRequestError } from '@/lib/api-client';
import { checkUrlInput, URL_INPUT_HINTS } from '@/lib/input/url';
import { subscribeTaskStream } from '@/lib/sse-client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/input';
import { Input } from '@/components/ui/input';
import { Markdown } from '@/components/ui/markdown';
import { CopyButton } from '@/components/ui/copy-button';
import {
  AgentResultView,
  type StructuredOutput,
  type TimelineStep,
} from '@/components/agent/agent-timeline';
import { TASK_TYPE_LIST, defaultParams, type TaskType } from '@/lib/tasks/types';

interface RunState {
  taskId: string;
  status: 'streaming' | 'succeeded' | 'failed';
  type: TaskType;
  text: string;
  error?: string;
  meta?: { model: string; promptVersion: string; templateName: string };
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costCny: number;
    cacheHitRate: number;
    peak: boolean;
  };
  degraded: boolean;
  /** 命中幂等：本次提交复用了已有任务，未产生新的 LLM 调用 */
  replayed?: boolean;
  /** Agent 任务的推理轨迹（普通任务为空） */
  steps?: TimelineStep[];
  /** Agent 任务的结构化结论 */
  structured?: StructuredOutput | null;
  stopReason?: string;
}

const MAX_CHARS = 100_000;

/**
 * 工作台。
 *
 * ## 一次改造：从「摘要工具」变成「多能力工作台」
 *
 * 原来这个组件把「摘要风格 / 要点数量 / 目标读者」三个字段硬编码在 JSX 里，
 * 于是每加一种能力（翻译、润色）都要改一遍这个文件。
 * 现在改成：**字段由 `lib/tasks/types.ts` 的变量定义驱动渲染** ——
 * 加一种能力只需在注册表里加一条定义 + 在 seed 里加模板，这个文件不用动。
 *
 * 这是「配置驱动 UI」在**有限枚举**场景下的正确用法。
 * 反例是让用户自由定义任意字段类型 —— 那需要一套 schema 语言与校验器，
 * 对三种固定能力属于过度设计。
 */
export function Workspace() {
  const [mode, setMode] = useState<'text' | 'url'>('text');
  const [taskType, setTaskType] = useState<TaskType>('summarize');
  const [content, setContent] = useState('');
  const [params, setParams] = useState<Record<string, string>>(() => defaultParams('summarize'));

  const [state, setState] = useState<RunState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AbortController 用于「停止生成」
  const abortRef = useRef<AbortController | null>(null);

  const typeDef = TASK_TYPE_LIST.find((t) => t.type === taskType)!;

  /**
   * Agent 模式需要「问题」这个额外输入。
   *
   * 单独一个 state 而不复用 params：问题不是"样式参数"，它是任务的**核心输入**
   * （没有它任务毫无意义），校验与展示方式都不同 —— 它需要一个显眼的输入框，
   * 而不是和「摘要风格」挤在同一排下拉里。
   */
  const isAgent = taskType === 'agent';
  const [question, setQuestion] = useState('');
  /** Agent 已收到的推理轨迹（SSE step 事件累积） */
  const [steps, setSteps] = useState<TimelineStep[]>([]);

  /**
   * 提交条件按能力分开判断。
   *
   * Agent 除了要有文档，还必须有问题 —— 只校验内容长度会放行一个
   * "有文档但没问什么"的请求，而那种请求在服务端必然 422，
   * 用户白等一次往返。
   */
  const canSubmit = isAgent
    ? content.trim().length >= 10 && question.trim().length >= 2 && !submitting
    : content.trim().length >= 10 && !submitting;

  /** 切换能力时重置参数：避免把「摘要风格」带进翻译请求 */
  const switchType = useCallback((next: TaskType) => {
    setTaskType(next);
    setParams(defaultParams(next));
    setState(null);
    setError(null);
    setSteps([]);
    setQuestion('');
  }, []);

  const submit = useCallback(async () => {
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    setState(null);
    setSteps([]);

    // 幂等键：每次用户意图生成一个，重放同一请求不会重复扣费。
    // 用 crypto.randomUUID 而非时间戳 —— 后者有碰撞风险。
    const idempotencyKey = crypto.randomUUID();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // 第一段：创建任务，< 200ms 返回 taskId。
      // Agent 走独立路由（请求形状不同：文档 + 问题），但两段式的结构一致。
      const { taskId, replayed } = await apiPost<{
        taskId: string;
        status: string;
        replayed: boolean;
      }>(
        isAgent ? '/api/agent' : '/api/tasks',
        isAgent
          ? {
              content,
              question,
              inputType: mode,
              maxSteps: params.maxSteps ?? '12',
            }
          : {
              type: taskType,
              content,
              inputType: mode,
              params,
            },
        {
          headers: { 'Idempotency-Key': idempotencyKey },
          signal: controller.signal,
        },
      );

      setState({
        taskId,
        status: 'streaming',
        type: taskType,
        text: '',
        degraded: false,
        // 命中幂等时提示用户：这次提交没有产生新的调用，也没有额外扣费。
        // 不说的话，用户会疑惑「为什么我点了两次却只出一次结果」。
        replayed,
      });

      // 第二段：订阅输出流
      await subscribeTaskStream(taskId, {
        signal: controller.signal,
        onMeta: (meta) => {
          setState((s) => (s ? { ...s, meta } : s));
        },
        onDelta: (_delta, accumulated) => {
          // ⚠️ 用 accumulated 而非累加 delta：
          // 重连时服务端会重发已生成的部分，直接 set 累积值最稳妥，
          // 避免了「重复累加导致内容翻倍」这类难以排查的 bug
          setState((s) => (s ? { ...s, text: accumulated } : s));
        },
        onUsage: (usage) => {
          setState((s) => (s ? { ...s, usage } : s));
        },
        onStep: (step) => {
          /**
           * Agent 步骤累积。
           *
           * ⚠️ 按 seq 去重后插入，而不是无脑 push。
           *
           * 重连时服务端会**补发**已落库的全部步骤（见 stream route 的
           * emitExistingSteps），如果直接 append，时间线会变成
           * 「1,2,1,2,3」这种重复序列。用 seq 做键去重是最稳的做法 ——
           * 服务端保证了 seq 唯一（@@unique([taskId, seq])）。
           */
          setSteps((prev) => {
            if (prev.some((p) => p.seq === step.seq)) return prev;
            return [...prev, step].sort((a, b) => a.seq - b.seq);
          });
        },
        onDone: (done) => {
          /**
           * ⚠️ 必须尊重 done.status，不能一律置为 succeeded。
           *
           * 服务端失败路径是「先发 error 再发 done」；无条件写 succeeded 会让
           * 失败的任务同时显示绿色「完成」徽标和红色错误文案。
           *
           * status 为 'running' 表示「订阅超时但任务还在跑」，
           * 此时保持 streaming，等 sse-client 按退避自动重连。
           */
          setState((s) =>
            s
              ? {
                  ...s,
                  status:
                    done.status === 'succeeded'
                      ? 'succeeded'
                      : done.status === 'running'
                        ? 'streaming'
                        : 'failed',
                  degraded: done.degraded,
                }
              : s,
          );
          if (done.status !== 'running') setSubmitting(false);

          /**
           * Agent 任务完成后补读结构化结论。
           *
           * 为什么不能从 token 流里拿：正文里是**剥掉 JSON 后的散文**
           * （见 runner 的 extractDisplayText），结构化结论单独存在
           * `outputMeta.structured` 里 —— 它要渲染成结论卡片，而不是当正文显示。
           * 所以这里必须额外拉一次详情。
           */
          if (isAgent && done.status === 'succeeded') {
            void (async () => {
              try {
                const detail = await apiGet<{
                  outputMeta?: { structured?: StructuredOutput | null; stopReason?: string };
                }>(`/api/tasks/${taskId}`);
                const meta = detail.outputMeta;
                if (meta) {
                  setState((s) =>
                    s ? { ...s, structured: meta.structured ?? null, stopReason: meta.stopReason } : s,
                  );
                }
              } catch {
                // 拿不到结构化结论时，界面上还有散文与时间线可用，不阻断
              }
            })();
          }
        },
        onError: (err) => {
          setError(err.message);
          setState((s) => (s ? { ...s, status: 'failed', error: err.message } : s));
          setSubmitting(false);
        },
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setSubmitting(false);
        return;
      }
      const message = e instanceof ApiRequestError ? e.message : '提交失败，请稍后重试';
      setError(message);
      setSubmitting(false);
    } finally {
      abortRef.current = null;
    }
  }, [canSubmit, content, isAgent, mode, params, question, taskType]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setSubmitting(false);
    // 注意：中止的是「订阅」，任务仍会在服务端继续跑完并落库。
    // 用户可以在历史记录里看到最终结果 —— 这是有意的设计。
  }, []);

  const charCount = content.length;
  const tooLong = charCount > MAX_CHARS;

  /**
   * 链接模式的即时校验。
   *
   * 为什么前端先挡一道：链接写错了，后端要等服务端抓取失败才报错，
   * 用户白等十几秒才看到「请输入有效的链接」。格式问题本地判断最便宜也最快。
   */
  const urlCheck = mode === 'url' ? checkUrlInput(content) : null;
  const urlLooksInvalid = mode === 'url' && content.trim().length >= 10 && urlCheck?.ok === false;

  const canSubmitFinal = canSubmit && !tooLong && !urlLooksInvalid;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{typeDef.label}</CardTitle>
          <p className="text-sm text-muted-foreground">{typeDef.hint}</p>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* 能力切换：所有能力共用同一套 Prompt 版本体系与计量管线 */}
          <div className="flex flex-wrap gap-2">
            {TASK_TYPE_LIST.map((t) => (
              <Button
                key={t.type}
                variant={taskType === t.type ? 'default' : 'outline'}
                size="sm"
                onClick={() => switchType(t.type)}
                type="button"
                disabled={submitting}
              >
                {t.label}
              </Button>
            ))}
          </div>

          {/* 输入方式切换 */}
          <div className="flex gap-2">
            {(
              [
                { key: 'text', label: '粘贴文本' },
                { key: 'url', label: '网页链接' },
              ] as const
            ).map((m) => (
              <Button
                key={m.key}
                variant={mode === m.key ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setMode(m.key)}
                type="button"
                disabled={submitting}
              >
                {m.label}
              </Button>
            ))}
          </div>

          <div className="space-y-1.5">
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={
                mode === 'url'
                  ? '粘贴文章链接，https://example.com/article'
                  : isAgent
                    ? '粘贴要分析的文档（例如一份合同、一篇论文、一份技术规范）…'
                    : taskType === 'translate'
                      ? '粘贴需要翻译的文本…'
                      : taskType === 'write'
                        ? '粘贴需要润色改写的文本…'
                        : '粘贴需要摘要的文本…'
              }
              className="min-h-[220px] font-mono text-[13px]"
              disabled={submitting}
            />
            {/*
              「网页链接」模式的格式说明。
              刻意常驻而不是等报错才提示：链接抓取要等服务端发起请求才知道失败，
              用户白等十几秒才看到「格式不对」是最差的体验。把可用格式先摆出来，
              用户一次就能填对。
            */}
            {mode === 'url' && (
              <div className="space-y-0.5 rounded-md bg-muted/60 px-3 py-2">
                {URL_INPUT_HINTS.map((line, i) => (
                  <p key={line} className="text-xs leading-5 text-muted-foreground">
                    {i === 0 && (
                      <span className="font-medium text-foreground">可用格式　</span>
                    )}
                    {line}
                  </p>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{charCount.toLocaleString()} 字</span>
              {tooLong && (
                <span className="text-destructive">
                  超出上限（{MAX_CHARS.toLocaleString()}），请分段处理
                </span>
              )}
              {urlLooksInvalid && (
                <span className="text-destructive">{urlCheck?.reason ?? '链接格式不正确'}</span>
              )}
            </div>
          </div>

          {/*
            Agent 的问题输入。
            刻意放在文档框**下面**：先选文档再问问题，符合"我要拿这份东西问点什么"
            的思维顺序。放在上面会让用户先看到"你想问什么"却还不知道要问哪份文档。
          */}
          {isAgent && (
            <div className="space-y-1.5 rounded-md border border-primary/30 bg-primary/5 p-3">
              <Label htmlFor="agent-question">你想问什么</Label>
              <Input
                id="agent-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="例如：这份合同里对我方不利的条款有哪些？"
                maxLength={2000}
                disabled={submitting}
              />
              <p className="text-xs text-muted-foreground">
                Agent 会自主检索文档并给出结论，每条结论都附带原文出处。
                如果文档里找不到答案，它会明确说明而不是猜测。
              </p>
            </div>
          )}

          {/*
            参数区：由类型定义驱动渲染。
            新增能力时这里不需要改动 —— 只要在 lib/tasks/types.ts 里加变量定义。

            ⚠️ 但有两类变量要排除，它们都**有自己的专用输入控件**，
            如果在这里再渲染一次就会出现重复的输入框（我第一版就踩了这个坑：
            「你想问什么」在页面出现了两次）：

              - `glossary`：由服务端从用户术语表注入，用户不直接编辑
              - `question`：Agent 的核心输入，需要用显眼的大输入框而不是
                和「最多检索轮数」挤在同一排下拉里
          */}
          <div className="grid gap-4 sm:grid-cols-3">
            {typeDef.variables
              .filter((v) => v.key !== 'glossary' && v.key !== 'question')
              .map((v) => (
                <div key={v.key} className="space-y-1.5">
                  <Label htmlFor={`param-${v.key}`}>{v.label}</Label>
                  {v.type === 'enum' && v.options ? (
                    <select
                      id={`param-${v.key}`}
                      value={params[v.key] ?? v.default ?? ''}
                      onChange={(e) => setParams((p) => ({ ...p, [v.key]: e.target.value }))}
                      disabled={submitting}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      {v.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={`param-${v.key}`}
                      type={v.type === 'number' ? 'number' : 'text'}
                      value={params[v.key] ?? ''}
                      onChange={(e) => setParams((p) => ({ ...p, [v.key]: e.target.value }))}
                      disabled={submitting}
                      placeholder={v.default ?? ''}
                    />
                  )}
                </div>
              ))}
          </div>

          {taskType === 'translate' && (
            <p className="text-xs text-muted-foreground">
              在「术语表」页配置专有名词译法，翻译时会自动套用，保证同一术语前后一致。
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={submit} disabled={!canSubmitFinal} loading={submitting}>
              {submitting ? '生成中…' : `开始${typeDef.label}`}
            </Button>
            {submitting && (
              <Button variant="ghost" size="sm" onClick={stop} type="button">
                停止订阅
              </Button>
            )}
          </div>

          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      {state && <RunResult state={state} steps={steps} maxSteps={params.maxSteps} />}
    </div>
  );
}

function RunResult({
  state,
  steps,
  maxSteps,
}: {
  state: RunState;
  steps: TimelineStep[];
  maxSteps?: string;
}) {
  const streaming = state.status === 'streaming';
  const typeLabel = TASK_TYPE_LIST.find((t) => t.type === state.type)?.label ?? state.type;

  /**
   * Agent 任务走专用视图：结论卡片 + 推理时间线。
   *
   * 为什么不在下面那个通用卡片里加分支：两者的信息结构差异太大 ——
   * 通用卡片是「一段正文 + 元信息」，Agent 是「结论列表（每条带证据）
   * + 步骤时间线」。硬塞进一个组件会让两边都变得难读。
   */
  if (state.type === 'agent') {
    return (
      <div className="space-y-4">
        <AgentResultView
          displayText={state.text}
          structured={state.structured ?? null}
          steps={steps}
          streaming={streaming}
          degraded={state.degraded}
          stopReason={state.stopReason}
          maxSteps={maxSteps ? Number(maxSteps) : undefined}
        />
        <UsageMeta state={state} typeLabel={typeLabel} />
        {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{typeLabel}结果</CardTitle>
          <div className="flex items-center gap-2">
            {state.replayed && (
              <Badge variant="outline" title="相同幂等键的重复提交，已复用原任务，未产生额外调用">
                未重复计费
              </Badge>
            )}
            {streaming && <Badge variant="secondary">生成中…</Badge>}
            {state.status === 'succeeded' && !state.degraded && (
              <Badge variant="success">完成</Badge>
            )}
            {state.degraded && <Badge variant="warning">降级结果</Badge>}
            {state.status === 'failed' && <Badge variant="destructive">失败</Badge>}
            {state.text && <CopyButton text={state.text} />}
          </div>
        </div>

        {/* Prompt 指纹 + 用量 —— 这是「可追溯」定位的具体呈现 */}
        <UsageMeta state={state} />
      </CardHeader>

      <CardContent>
        {state.text ? (
          /*
           * ⚠️ 这里必须走 Markdown 渲染，不能直接输出文本。
           *
           * 之前的写法是 `<div className="prose-lumenote whitespace-pre-wrap">{state.text}</div>`，
           * 容器类名声明了一整套 h1/ul/a/strong 排版，但 DOM 里只有文本节点 ——
           * 选择器全部落空，模型输出的 `[标题](https://…)` 用户看到的就是这么一串字符。
           *
           * 流式光标挂在**包裹层**而不是 Markdown 内部：Markdown 每次增量都会
           * 重新渲染（对象树被替换），光标若跟着重建会闪烁。
           */
          <div className={streaming && !state.error ? 'stream-cursor' : undefined}>
            <Markdown content={state.text} />
          </div>
        ) : streaming ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            正在连接…
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">无输出</p>
        )}

        {state.error && <p className="mt-3 text-sm text-destructive">{state.error}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * Prompt 指纹与用量。
 *
 * 抽成独立组件是因为 Agent 视图与普通视图都要显示它 ——
 * 而这段信息是「可追溯」定位在界面上的直接呈现，两处必须一致
 * （早先复制一份到 Agent 视图就会出现"改了一处忘了另一处"）。
 */
function UsageMeta({ state, typeLabel }: { state: RunState; typeLabel?: string }) {
  if (!state.meta && !state.usage && !state.replayed) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
      {typeLabel && <span>{typeLabel}</span>}
      {state.replayed && (
        <Badge variant="outline" title="相同幂等键的重复提交，已复用原任务，未产生额外调用">
          未重复计费
        </Badge>
      )}
      {state.meta && (
        <>
          <span>
            模型 <code className="rounded bg-muted px-1">{state.meta.model}</code>
          </span>
          <span>
            Prompt <code className="rounded bg-muted px-1">{state.meta.promptVersion}</code>
          </span>
        </>
      )}
      {state.usage && (
        <>
          <span>
            输入 {state.usage.inputTokens.toLocaleString()} · 输出{' '}
            {state.usage.outputTokens.toLocaleString()} tokens
          </span>
          {state.usage.cachedTokens > 0 && (
            <span title="命中前缀缓存，前缀越稳定命中率越高">
              缓存命中 {Math.round(state.usage.cacheHitRate * 100)}%
            </span>
          )}
          <span className="font-medium text-foreground">
            成本 ¥{state.usage.costCny.toFixed(5)}
          </span>
          {state.usage.peak && (
            <span title="当前处于 DeepSeek 高峰计价时段，单价为低谷的 2 倍">高峰计价</span>
          )}
        </>
      )}
    </div>
  );
}

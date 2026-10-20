'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Markdown } from '@/components/ui/markdown';
import { CopyButton } from '@/components/ui/copy-button';

/** 一步的展示数据（来自 SSE step 事件，或从任务详情补读） */
export interface TimelineStep {
  seq: number;
  phase: string;
  note: string;
  tools: { name: string; display: string; ok: boolean }[];
  cumulativeTokens: number;
  latencyMs: number;
}

/** 结构化结论（agent 任务的 outputMeta.structured） */
export interface StructuredOutput {
  conclusions: {
    text: string;
    evidence: { source: string; quote: string }[];
    confidence?: string;
  }[];
  limitations?: string[];
}

const PHASE_LABEL: Record<string, string> = {
  plan: '规划',
  act: '检索',
  observe: '观察',
  finalize: '得出结论',
  give_up: '收敛（预算用尽）',
};

const PHASE_TONE: Record<string, string> = {
  act: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  finalize: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  give_up: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  plan: 'bg-muted text-muted-foreground',
  observe: 'bg-muted text-muted-foreground',
};

/**
 * Agent 推理时间线。
 *
 * ## 为什么这个组件是 Agent 功能的核心界面
 *
 * 普通任务的界面只需要展示「结果」。Agent 不一样：用户要判断这个结论
 * **可不可信**，就必须看到它是怎么走到的 —— 检索了哪些词、命中了几段、
 * 哪一步开始给出的结论。
 *
 * 所以时间线的设计目标是「一眼看出推理路径是否合理」，而不是好看：
 * 每步一行、工具结果显示命中数、token 消耗随步数累积可见。
 *
 * ## 为什么用 <details> 而不是自绘折叠
 *
 * 原生 `<details>/<summary>` 自带键盘可达性与无障碍语义（回车/空格展开、
 * 屏幕阅读器能识别），自绘需要把那些全部重做一遍且容易漏。
 * 这里没有任何理由不用它。
 */
export function AgentTimeline({
  steps,
  streaming,
  maxSteps,
}: {
  steps: TimelineStep[];
  streaming: boolean;
  maxSteps?: number;
}) {
  const totalTokens = steps.reduce((m, s) => Math.max(m, s.cumulativeTokens), 0);
  const actCount = steps.filter((s) => s.phase === 'act').length;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">
            推理过程
            {streaming && (
              <span className="ml-2 inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                进行中
              </span>
            )}
          </CardTitle>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              {actCount} 次检索
              {maxSteps ? ` / 最多 ${maxSteps}` : ''}
            </span>
            {totalTokens > 0 && <span>{totalTokens.toLocaleString()} tokens</span>}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {steps.length === 0 ? (
          <p className="py-3 text-center text-sm text-muted-foreground">
            {streaming ? '正在规划…' : '没有可展示的步骤'}
          </p>
        ) : (
          <ol className="space-y-2">
            {steps.map((s) => (
              <li key={s.seq} className="flex gap-3">
                {/* 序号列：用一个连续竖线把步骤串起来，让"路径"这个感觉可见 */}
                <div className="flex flex-col items-center pt-0.5">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-medium tabular-nums">
                    {s.seq}
                  </span>
                  <span className="mt-1 w-px flex-1 bg-border" />
                </div>

                <div className="min-w-0 flex-1 pb-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${PHASE_TONE[s.phase] ?? 'bg-muted text-muted-foreground'}`}
                    >
                      {PHASE_LABEL[s.phase] ?? s.phase}
                    </span>
                    {s.note && <span className="text-sm">{s.note}</span>}
                    {s.latencyMs > 0 && (
                      <span className="text-[11px] text-muted-foreground">
                        {(s.latencyMs / 1000).toFixed(1)}s
                      </span>
                    )}
                  </div>

                  {s.tools.length > 0 && (
                    <ul className="mt-1.5 space-y-1">
                      {s.tools.map((t, i) => (
                        <li
                          key={`${s.seq}-${i}`}
                          className="flex items-start gap-2 text-xs text-muted-foreground"
                        >
                          <span className={t.ok ? 'text-emerald-600' : 'text-red-600'}>
                            {t.ok ? '✓' : '✗'}
                          </span>
                          <span className="min-w-0 break-words">{t.display || t.name}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 结论卡片：把结构化结论渲染成「结论 + 可核对的证据」。
 *
 * ## 为什么证据要单独列出来而不是塞进正文
 *
 * 这个产品的定位是**可追溯**，而「可追溯」在界面上必须有一个具体形态：
 * 用户要能一眼看到「这句话的依据是哪一段原文」。
 * 把证据折叠在正文里等于没有 —— 因为用户不会为了核对而展开每一段。
 *
 * 所以每条结论下面直接列出它的引用，并且是等宽字体显示原文片段，
 * 让"这是原文，不是模型的转述"这件事在视觉上成立。
 */
export function ConclusionsView({
  structured,
  degraded,
  stopReason,
}: {
  structured: StructuredOutput | null;
  degraded: boolean;
  stopReason?: string;
}) {
  if (!structured || structured.conclusions.length === 0) return null;

  const unsupported = structured.conclusions.filter((c) => c.evidence.length === 0).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">
            结论（{structured.conclusions.length} 条）
          </CardTitle>
          {unsupported > 0 && (
            <Badge variant="warning" title="这些结论没有引用原文，可信度较低">
              {unsupported} 条无证据
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {structured.conclusions.map((c, i) => (
          <div key={i} className="rounded-md border p-3">
            <div className="flex items-start gap-2">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-medium text-primary">
                {i + 1}
              </span>
              <p className="min-w-0 flex-1 text-sm leading-relaxed">{c.text}</p>
              {c.confidence && (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {c.confidence}
                </span>
              )}
            </div>

            {c.evidence.length > 0 && (
              <ul className="mt-2 space-y-1.5 pl-7">
                {c.evidence.map((e, j) => (
                  <li key={j} className="rounded border-l-2 border-primary/40 bg-muted/40 py-1.5 pl-2.5">
                    <code className="text-[11px] text-primary">{e.source}</code>
                    <p className="mt-0.5 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
                      「{e.quote}」
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        {structured.limitations && structured.limitations.length > 0 && (
          <div className="rounded-md border border-amber-600/30 bg-amber-50 p-3 dark:bg-amber-950/30">
            <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
              模型的自我说明（未能确认的部分）
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-amber-900/80 dark:text-amber-200/80">
              {structured.limitations.map((l, i) => (
                <li key={i}>· {l}</li>
              ))}
            </ul>
          </div>
        )}

        {degraded && (
          <p className="text-xs text-muted-foreground">
            这份结论是在
            {stopReason === 'max_steps'
              ? '步数用尽'
              : stopReason === 'max_tokens'
                ? 'token 预算用尽'
                : stopReason === 'repeat_loop'
                  ? '检测到重复检索'
                  : stopReason === 'tool_quota'
                    ? '工具次数用尽'
                    : '预算受限'}
            的情况下收敛得到的阶段性结果
            {stopReason === 'repeat_loop' || stopReason === 'tool_quota' ? '。' : '，可能不完整。'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Agent 任务在历史详情里的整体视图（时间线 + 结论 + 兜底正文） */
export function AgentResultView({
  displayText,
  structured,
  steps,
  streaming,
  degraded,
  stopReason,
  maxSteps,
}: {
  displayText: string;
  structured: StructuredOutput | null;
  steps: TimelineStep[];
  streaming: boolean;
  degraded: boolean;
  stopReason?: string;
  maxSteps?: number;
}) {
  /**
   * 「只看结论 / 也看过程」的切换。
   *
   * 默认展开过程，因为这是这个功能的价值所在；但给出折叠能力 ——
   * 用户第二次回来只想看结论时，不该被迫滚过十几行检索记录。
   */
  const [showProcess, setShowProcess] = React.useState(true);

  return (
    <div className="space-y-4">
      <ConclusionsView structured={structured} degraded={degraded} stopReason={stopReason} />

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setShowProcess((v) => !v)}>
          {showProcess ? '收起推理过程' : `展开推理过程（${steps.length} 步）`}
        </Button>
        {displayText && <CopyButton text={displayText} label="复制说明文字" />}
      </div>

      {showProcess && (
        <AgentTimeline steps={steps} streaming={streaming} maxSteps={maxSteps} />
      )}

      {/* 模型写的解释性散文（剥掉 JSON 之后的部分）。有结论卡片时放在后面 */}
      {displayText && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">模型说明</CardTitle>
          </CardHeader>
          <CardContent>
            <Markdown content={displayText} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Markdown } from '@/components/ui/markdown';
import { CopyButton, DownloadButton } from '@/components/ui/copy-button';

export interface SharedTaskView {
  title: string;
  type: string;
  outputContent: string;
  createdAt: string;
  degraded: boolean;
  charCount: number;
  templateName: string;
  promptVersion: number;
  model: string | null;
  costCny: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  sourceHost: string | null;
}

/**
 * 分享页的展示组件。
 *
 * ⚠️ 这里**刻意不展示**输入正文（`inputContent`）。
 * 分享的语义是「把我生成的结果发给别人看」，而不是「把我的原始素材也一起公开」——
 * 用户粘贴的原文可能是内部文档、客户资料、未发布的稿件。
 * 只分享结果是最不容易出事的选择，即使少了一些上下文。
 */
export function SharedView({ data, token }: { data: SharedTaskView; token: string }) {
  const router = useRouter();

  const markdownExport = [
    `# ${data.title}`,
    '',
    `> 由流光笔记生成 · ${new Date(data.createdAt).toLocaleString('zh-CN')}`,
    `> Prompt：${data.templateName} v${data.promptVersion}${data.model ? ` · 模型：${data.model}` : ''}`,
    '',
    '---',
    '',
    data.outputContent,
  ].join('\n');

  const filename = `${data.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.md`;

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{data.title}</h1>
            {data.degraded && <Badge variant="warning">降级结果</Badge>}
          </div>
          <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{new Date(data.createdAt).toLocaleString('zh-CN')}</span>
            <span>{data.charCount} 字输入</span>
            <span>
              {data.templateName} v{data.promptVersion}
            </span>
            {data.model && (
              <span>
                模型 <code className="rounded bg-muted px-1">{data.model}</code>
              </span>
            )}
            {data.sourceHost && <span>来源 {data.sourceHost}</span>}
          </p>
        </div>

        <div className="flex shrink-0 gap-2">
          <CopyButton text={data.outputContent} />
          <DownloadButton content={markdownExport} filename={filename} />
        </div>
      </header>

      <Card>
        <CardContent className="pt-5">
          <Markdown content={data.outputContent} />
        </CardContent>
      </Card>

      {/* 只读分享也保留成本与 Prompt 指纹 —— 这是这个产品的差异化，不该在分享时丢掉 */}
      {(data.costCny !== null || data.inputTokens !== null) && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle className="text-sm">生成信息</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            {data.inputTokens !== null && data.outputTokens !== null && (
              <span>
                输入 {data.inputTokens.toLocaleString()} / 输出 {data.outputTokens.toLocaleString()} tokens
              </span>
            )}
            {data.costCny !== null && (
              <span className="font-medium text-foreground">成本 ¥{data.costCny.toFixed(5)}</span>
            )}
            <span>Prompt 版本 {data.templateName} v{data.promptVersion}</span>
          </CardContent>
        </Card>
      )}

      <footer className="mt-8 flex flex-col items-center gap-3 text-center">
        <p className="text-xs text-muted-foreground">
          这是一份只读分享 · 内容由 AI 生成，可能存在偏差，请自行核对
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => router.refresh()}>
            刷新
          </Button>
          <Link
            href="/"
            className="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm transition-colors hover:bg-accent"
          >
            了解流光笔记
          </Link>
        </div>
        {/* token 放在页面上便于用户自己核对是哪个链接，但不做成可点击的入口 */}
        <p className="font-mono text-[10px] text-muted-foreground/60">
          {token.slice(0, 8)}…{token.slice(-4)}
        </p>
      </footer>
    </main>
  );
}

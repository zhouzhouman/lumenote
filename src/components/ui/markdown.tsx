'use client';

import * as React from 'react';
import {
  parseMarkdown,
  isBlankMarkdown,
  type BlockToken,
  type InlineToken,
} from '@/lib/markdown';
import { cn } from '@/lib/utils';

/**
 * Markdown → React 的渲染层。
 *
 * 解析逻辑全在 `@/lib/markdown`（纯函数、可单测），本文件只负责把 token 变成元素。
 * 这样切分的理由：解析的正确性（尤其是流式半成品与链接安全）值得被测试覆盖，
 * 而 JSX 映射几乎不会出错，不需要测试。
 *
 * ⚠️ 这里**只用 React 元素**，不用 `dangerouslySetInnerHTML`。
 * 输出内容是模型生成的，等价于不可信输入；走 React 的元素树等于免费拿到转义，
 * 是比「自己写 sanitizer」可靠得多的选择。
 */

function InlineRenderer({ tokens }: { tokens: InlineToken[] }) {
  return (
    <>
      {tokens.map((token, idx) => {
        switch (token.type) {
          case 'link':
            return (
              <a
                key={idx}
                href={token.url}
                target="_blank"
                // noopener 防 window.opener 劫持；noreferrer 同时隐藏来源
                rel="noopener noreferrer"
                className="break-all text-primary underline underline-offset-2 hover:opacity-80"
              >
                {token.value}
              </a>
            );
          case 'code':
            return (
              <code key={idx} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
                {token.value}
              </code>
            );
          case 'strong':
            return (
              <strong key={idx} className="font-semibold text-foreground">
                {token.value}
              </strong>
            );
          case 'em':
            return <em key={idx}>{token.value}</em>;
          default:
            return <React.Fragment key={idx}>{token.value}</React.Fragment>;
        }
      })}
    </>
  );
}

/**
 * 判断这一段是否「整段就是一个链接」。
 *
 * 模型输出引用来源时几乎都是一行一个链接，这种应作为块级元素展示
 * （每条独占一行、可换行），而不是当成一句话挤在一起。
 */
function isLinkOnly(inlines: InlineToken[]): boolean {
  const meaningful = inlines.filter((t) => !(t.type === 'text' && !t.value.trim()));
  return meaningful.length === 1 && meaningful[0]!.type === 'link';
}

function Block({ block }: { block: BlockToken }) {
  switch (block.type) {
    case 'heading': {
      const Tag = (`h${block.level}` as unknown) as 'h1';
      return (
        <Tag>
          <InlineRenderer tokens={block.inlines} />
        </Tag>
      );
    }

    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag start={block.ordered ? block.start : undefined}>
          {block.items.map((item, idx) => (
            <li key={idx}>
              <InlineRenderer tokens={item.inlines} />
            </li>
          ))}
        </Tag>
      );
    }

    case 'quote':
      return (
        <blockquote>
          <InlineRenderer tokens={block.inlines} />
        </blockquote>
      );

    case 'code':
      return (
        <pre>
          <code>{block.value}</code>
        </pre>
      );

    case 'hr':
      return <hr className="my-4 border-border" />;

    default: {
      // 空段落（模型输出里的连续空行）不渲染，避免产生巨大的空白间距
      if (block.inlines.length === 0) return null;

      if (isLinkOnly(block.inlines)) {
        return (
          <p className="break-all">
            <InlineRenderer tokens={block.inlines} />
          </p>
        );
      }

      return (
        <p>
          <InlineRenderer tokens={block.inlines} />
        </p>
      );
    }
  }
}

export interface MarkdownProps {
  content: string;
  /** 覆盖外层样式。默认的 `prose-lumenote` 提供排版，whitespace 由本组件接管 */
  className?: string;
}

/**
 * 渲染 Markdown 内容。
 *
 * 注意**不能**在容器上再用 `whitespace-pre-wrap`：
 * 换行已由块级元素表达，再保留原始换行会与 `<p>` 的 margin 叠加成双倍间距。
 */
export function Markdown({ content, className }: MarkdownProps) {
  const blocks = React.useMemo(() => parseMarkdown(content), [content]);

  if (isBlankMarkdown(content)) return null;

  return (
    <div className={cn('prose-lumenote', className)}>
      {blocks.map((block, idx) => (
        <Block key={idx} block={block} />
      ))}
    </div>
  );
}

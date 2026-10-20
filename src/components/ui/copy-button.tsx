'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';

/**
 * 复制到剪贴板。
 *
 * ## 为什么不用 `navigator.clipboard.writeText` 一把梭
 *
 * 该 API **只在安全上下文可用**（https 或 localhost），而且在部分浏览器里
 * 需要用户手势与权限。开发环境常用局域网 IP 访问（http://192.168.x.x:3000），
 * 那时 `navigator.clipboard` 是 undefined —— 直接调用会抛
 * 「Cannot read properties of undefined」，而这个错误只在特定访问方式下出现，
 * 本地 localhost 测永远测不到。
 *
 * 所以这里做了降级：优先用 Clipboard API，不可用时退回
 * `document.execCommand('copy')`（已废弃但兼容性最好）。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走降级路径（权限被拒等）
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // 必须真的在文档里且不可见 —— 单纯 off-screen 定位在部分浏览器里选区会失败
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  text,
  label = '复制',
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清掉定时器：否则组件已经不在页面上了还会 setState
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function onClick() {
    const ok = await copyText(text);
    setCopied(ok);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Button variant="outline" size="sm" className={className} onClick={onClick} type="button">
      {copied ? '已复制' : label}
    </Button>
  );
}

/**
 * 下载为文件（Markdown 导出用）。
 *
 * 用 Blob + 临时 a 标签，不引 file-saver 之类的库 ——
 * 十行原生代码能做的事不值得加依赖。
 *
 * `text/plain` 而不是 `text/markdown`：部分系统对 text/markdown 没有注册
 * 默认程序，会导致下载后无法直接打开。charset=utf-8 必须带上，
 * 否则中文在某些编辑器里会乱码。
 */
export function DownloadButton({
  content,
  filename,
  label = '下载 .md',
  className,
}: {
  content: string;
  filename: string;
  label?: string;
  className?: string;
}) {
  function onClick() {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 立即回收：不释放会一直占着内存直到页面卸载（大文本时很明显）
    URL.revokeObjectURL(url);
  }

  return (
    <Button variant="outline" size="sm" className={className} onClick={onClick} type="button">
      {label}
    </Button>
  );
}

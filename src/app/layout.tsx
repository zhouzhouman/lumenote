import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Lumenote — 可追溯的 AI 文本工作台',
    template: '%s · Lumenote',
  },
  description:
    '每一次 AI 输出，都告诉你用了哪个 Prompt 版本、消耗了多少 Token、可对比任意两个历史版本。',
  keywords: ['AI 摘要', 'Prompt 版本管理', 'AI 文本处理', 'Next.js', 'DeepSeek'],
  authors: [{ name: 'Lumenote' }],
  openGraph: {
    type: 'website',
    title: 'Lumenote — 可追溯的 AI 文本工作台',
    description: 'Prompt 指纹 · 成本仪表盘 · 版本对比',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0f1a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans">
        {/*
          不做 theme provider：暗色模式跟随系统即可。
          为一个「跟随系统」的需求引入 next-themes 属于过度工程，
          真要做成可切换的设置项时再加。
        */}
        {children}
      </body>
    </html>
  );
}
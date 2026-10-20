'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { apiPost } from '@/lib/api-client';
import { Button } from '@/components/ui/button';

/**
 * 应用内导航。
 *
 * 为什么用 usePathname 而不是由服务端传 activeKey？
 * 因为导航需要在客户端切换时即时高亮，而服务端组件的 props 不会自动更新。
 * usePathname 触发的重渲染才是正确的数据源。
 */
const NAV_ITEMS = [
  { href: '/workspace', label: '工作台', hint: '摘要 / 翻译 / 润色' },
  { href: '/history', label: '历史', hint: '结果、对比与分享' },
  { href: '/glossary', label: '术语表', hint: '统一专有名词译法' },
  { href: '/usage', label: '成本', hint: '用量与账单' },
  { href: '/settings', label: '模型设置', hint: '配置自己的 API Key' },
  { href: '/security', label: '登录活动', hint: '设备与安全事件' },
] as const;

export function AppNav({ email }: { email: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = React.useState(false);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await apiPost('/api/auth/logout');
    } catch {
      /**
       * 必须吞掉异常：这个 handler 是 async 的，未捕获的 rejection 会变成
       * 一个 unhandled promise rejection（控制台报错，且 setLoggingOut 永远停在 true，
       * 按钮从此卡在 loading 状态）。
       *
       * 而且这里的失败**不影响用户意图**：服务端在失败路径上也会清 cookie，
       * 前端唯一要做的就是跳走。
       */
    } finally {
      /**
       * 无论登出请求成功与否都跳走。
       * 前端唯一的「真相来源」是 cookie；只要 cookie 还在，
       * 跳回去会被服务端重新判定为已登录，卡在登录页反而更糟。
       */
      router.replace('/login');
      router.refresh();
      setLoggingOut(false);
    }
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r bg-card/40">
      <div className="flex h-14 items-center px-5">
        <Link href="/workspace" className="text-lg font-semibold tracking-tight">
          流光笔记
        </Link>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV_ITEMS.map((item) => {
          // 用 startsWith 而非等值：/history/123 也应让「历史」高亮
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'block rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <div>{item.label}</div>
              <div className="text-xs opacity-70">{item.hint}</div>
            </Link>
          );
        })}
      </nav>

      <div className="border-t p-3">
        <p className="truncate px-2 pb-2 text-xs text-muted-foreground" title={email}>
          {email}
        </p>
        <Button variant="outline" size="sm" className="w-full" loading={loggingOut} onClick={logout}>
          退出登录
        </Button>
      </div>
    </aside>
  );
}
/**
 * 服务端渲染（SSR）安全性检查。
 *
 * ## 为什么需要这个测试
 *
 * 这是一个真实发生过的回归：修复「开放重定向」时，我把登录页的校验逻辑
 * 写成了 `new URL(raw, window.location.origin)`。`AuthForm` 是客户端组件，
 * 但它在服务端**也会被预渲染一次**，那时没有 `window` ——
 *
 *     ReferenceError: window is not defined
 *        at AuthForm (src/components/auth/auth-form.tsx:53:18)
 *
 * 结果是登录页服务端渲染直接失败、退化成整页客户端渲染，
 * 而这类错误在 `tsc` 与 ESLint 里都不会报（它们不做运行环境检查），
 * 只有真的渲染一次才会暴露。
 *
 * 这个测试就是那个「真的渲染一次」：把客户端组件当纯函数调用，
 * 在一个**没有 window/document 的 Node 环境**里执行。
 * 只要组件在渲染路径上碰了浏览器全局对象，这里就会抛错。
 *
 * 局限要说清楚：Node 环境天然没有 window，所以它只能证明
 * 「现在没读 window」，不能证明「将来所有分支都没读」。
 * 真正的保障仍然是代码评审 + 浏览器里点一遍。
 */

import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * 桩掉 Next.js 的导航 hooks。
 *
 * 两个原因：
 *  1. 直接用真的 `useSearchParams()` 会抛
 *     `invariant expected app router to be mounted` —— 脱离 app router 渲染时肯定失败，
 *     那不是我们要测的东西
 *  2. **桩的返回值必须与真实 SSR 行为一致**：`useSearchParams()` 在服务端返回 **null**。
 *     这正是本轮修掉的第二个 bug 的来源（代码直接调 `.get()` 会抛 TypeError）。
 *     如果这里桩成空对象，测试就测不出那个 bug 了。
 *
 * 用 vi.hoisted 是因为 vi.mock 的工厂函数会被提升到 import 之前执行。
 */
const nav = vi.hoisted(() => ({
  searchParams: null as null | { get: (k: string) => string | null },
  replace: () => undefined,
  refresh: () => undefined,
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.searchParams,
  useRouter: () => ({ replace: nav.replace, refresh: nav.refresh, push: nav.replace }),
  usePathname: () => '/login',
}));

/** 断言当前测试环境确实没有浏览器全局对象（否则这个测试是假的） */
function assertNoBrowserGlobals() {
  expect(typeof globalThis.window).toBe('undefined');
  expect(typeof globalThis.document).toBe('undefined');
}

describe('SSR 环境本身', () => {
  it('测试环境确实没有 window / document（前提校验）', () => {
    assertNoBrowserGlobals();
  });
});

describe('客户端组件的服务端渲染', () => {
  /**
   * ⚠️ 这里**不加** Suspense 边界。
   *
   * 实测发现：`renderToStaticMarkup` 会把渲染期同步抛出的异常正常抛出，
   * 但如果外面套了 Suspense，异常会被 Suspense 接住、结果变成空字符串 ——
   * 于是 `expect(...).not.toThrow()` 永远通过，测试形同虚设。
   * 想靠 class 组件 + getDerivedStateFromError 捕获又会踩到
   * `react/display-name` 规则，得不偿失。
   *
   * 所以直接用 try/catch 记录异常：不抛 = 通过，抛 = 把错误信息带出来。
   */
  function renderAndCapture(element: React.ReactElement): Error | null {
    try {
      renderToStaticMarkup(element);
      return null;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  }

  it('AuthForm（登录模式）服务端渲染不抛错（无 window，且 searchParams 为 null）', async () => {
    assertNoBrowserGlobals();
    // 与真实 SSR 一致：服务端拿不到查询参数
    nav.searchParams = null;

    const { AuthForm } = await import('@/components/auth/auth-form');
    const error = renderAndCapture(
      React.createElement(AuthForm, { mode: 'login' }) as React.ReactElement,
    );

    // 这里曾经抛过两个错：
    //   1. ReferenceError: window is not defined（读了 window.location.origin）
    //   2. TypeError: Cannot read properties of null（searchParams 在 SSR 为 null）
    expect(error?.message ?? null).toBeNull();
  });

  it('AuthForm（注册模式）同样不抛错', async () => {
    assertNoBrowserGlobals();
    nav.searchParams = null;

    const { AuthForm } = await import('@/components/auth/auth-form');
    const error = renderAndCapture(
      React.createElement(AuthForm, { mode: 'register' }) as React.ReactElement,
    );
    expect(error?.message ?? null).toBeNull();
  });

  /**
   * 客户端场景：`next` 参数存在时也不能崩，且恶意值必须被挡掉。
   * 这里只验证「渲染不抛错」—— 重定向目标的选择发生在提交时，属于交互逻辑。
   */
  it('带 next 参数（含恶意值）渲染时同样不抛错', async () => {
    assertNoBrowserGlobals();

    for (const malicious of ['//evil.com', '/\\evil.com', '/workspace', 'https://evil.com']) {
      nav.searchParams = { get: () => malicious };
      const { AuthForm } = await import('@/components/auth/auth-form');
      const error = renderAndCapture(
        React.createElement(AuthForm, { mode: 'login' }) as React.ReactElement,
      );
      expect(error?.message ?? null, `next=${malicious} 时不应抛错`).toBeNull();
    }
  });

  it('Markdown 渲染器可在服务端渲染（链接、标题、列表都要真的渲染出来）', async () => {
    assertNoBrowserGlobals();

    const { Markdown } = await import('@/components/ui/markdown');
    const html = renderToStaticMarkup(
      React.createElement(Markdown, {
        content: '## 标题\n\n- 要点一\n- 要点二\n\n见 [文档](https://example.com)',
      }),
    );

    expect(html).toContain('<h2');
    expect(html).toContain('<ul');
    expect(html).toContain('href="https://example.com"');
    // 链接必须带 noopener，防 window.opener 劫持
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

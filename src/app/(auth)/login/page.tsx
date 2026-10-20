import { Suspense } from 'react';
import Link from 'next/link';
import { AuthForm } from '@/components/auth/auth-form';

export const metadata = {
  title: '登录 · Lumenote',
};

/**
 * useSearchParams 必须在 Suspense 边界内使用。
 *
 * Next.js 构建时会静态分析页面；如果直接用 useSearchParams 而没有
 * Suspense 包裹，预渲染阶段会报错 bailout（App Router 的硬性要求）。
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <Link href="/" className="text-2xl font-semibold tracking-tight">
        流光笔记
      </Link>
      <Suspense fallback={null}>
        <AuthForm mode="login" />
      </Suspense>
    </main>
  );
}
import { Suspense } from 'react';
import Link from 'next/link';
import { AuthForm } from '@/components/auth/auth-form';

export const metadata = {
  title: '注册 · Lumenote',
};

export default function RegisterPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <Link href="/" className="text-2xl font-semibold tracking-tight">
        流光笔记
      </Link>
      <Suspense fallback={null}>
        <AuthForm mode="register" />
      </Suspense>
    </main>
  );
}
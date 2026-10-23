import { Suspense } from 'react';
import Link from 'next/link';
import { AuthForm } from '@/components/auth/auth-form';
import { env } from '@/lib/env';

/*
 * 页面要读运行时配置（是否要求邮箱验证），不能在构建期预渲染 ——
 * 预渲染会在 `next build` 时执行 env()，那一阶段往往没有生产密钥。
 */
export const dynamic = 'force-dynamic';

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
        {/* 是否要验证码由服务端配置决定，前端只负责不显示用不上的输入框 */}
        <AuthForm mode="register" requireEmailVerification={env().REQUIRE_EMAIL_VERIFICATION} />
      </Suspense>
    </main>
  );
}
'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiPost, ApiRequestError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { assessPasswordStrength, type PasswordStrength } from '@/lib/password-strength';

/**
 * 登录 / 注册共用表单。
 *
 * 两页逻辑高度相似（提交邮箱密码、拿到 cookie 后跳走），
 * 拆成两个独立页面会重复三遍同样的错误处理与跳转逻辑，
 * 所以抽成一个组件，通过 mode 区分。
 *
 * 注册比登录多两件事：**邮箱验证码** 与 **密码强度提示**。
 */

/** 强度条的配色与文案。用完整字面量，Tailwind 不做动态拼接 */
const STRENGTH_STYLE: { bar: string; text: string }[] = [
  { bar: 'bg-red-500', text: 'text-red-600 dark:text-red-400' },
  { bar: 'bg-orange-500', text: 'text-orange-600 dark:text-orange-400' },
  { bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  { bar: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  { bar: 'bg-emerald-600', text: 'text-emerald-700 dark:text-emerald-400' },
];

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isRegister = mode === 'register';

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [name, setName] = React.useState('');
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);

  /** 验证码发送状态。用独立状态而不是复用 submitting，两边互不阻塞 */
  const [sendingCode, setSendingCode] = React.useState(false);
  const [cooldown, setCooldown] = React.useState(0);

  /** 密码强度：本地实时计算，不发请求（纯函数，见 lib/auth/password.ts） */
  const strength: PasswordStrength = React.useMemo(
    () => assessPasswordStrength(password),
    [password],
  );

  /** 验证码倒计时。用户需要知道还要等多久才能重发 */
  React.useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  /**
   * 登录成功后要去的页面。
   *
   * ⚠️ 这里有两个踩过的坑，都写在注释里避免后人改回去：
   *
   * 1. **不能读 `window.location.origin`**。AuthForm 是客户端组件，
   *    但服务端预渲染时也会执行一次，那时没有 window →
   *    `ReferenceError: window is not defined`，整页退化成客户端渲染。
   *
   * 2. **`useSearchParams()` 在 SSR 返回 null**，必须判空，
   *    否则 `.get()` 抛 TypeError。
   *
   * 安全上要挡掉两种形态：
   *  - `//evil.com`  协议相对 URL，浏览器会当成绝对地址
   *  - `/\evil.com`  按 WHATWG URL 规范，special scheme 下 `\` 等价于 `/`，
   *                  它同样进入 authority 状态，只判 startsWith('//') 会被绕过
   *
   * 用一个固定基准 origin 解析并比对，是唯一可靠的做法。
   */
  const nextPath = React.useMemo(() => {
    const raw = searchParams?.get('next');
    if (!raw) return '/workspace';

    const PROBE_ORIGIN = 'https://probe.invalid';
    try {
      const url = new URL(raw, PROBE_ORIGIN);
      if (url.origin !== PROBE_ORIGIN) return '/workspace';
      if (url.pathname !== '/' && !/^\/[^/\\]/.test(url.pathname)) return '/workspace';
      return `${url.pathname}${url.search}`;
    } catch {
      return '/workspace';
    }
  }, [searchParams]);

  /** 发送注册验证码 */
  async function sendCode() {
    if (sendingCode || cooldown > 0) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFieldErrors((f) => ({ ...f, email: '请先填写正确的邮箱' }));
      return;
    }

    setSendingCode(true);
    setError(null);
    setNotice(null);
    setFieldErrors((f) => ({ ...f, email: '' }));

    try {
      const res = await apiPost<{
        sent: boolean;
        message: string;
        devCode?: string;
        expiresInSec?: number;
      }>('/api/auth/verification', { email, purpose: 'register' });

      setCooldown(60);

      if (res.devCode) {
        /**
         * 非生产环境下后端把验证码回传了（console 邮件通道）。
         * 直接填进输入框并提示 —— 省掉「去翻服务端日志」这一步。
         * 生产环境后端不会返回该字段（mailer 层硬性拦截）。
         */
        setCode(res.devCode);
        setNotice(`开发模式：验证码已自动填入（${res.devCode}）。服务端日志里也能看到。`);
      } else {
        setNotice(`${res.message}，有效期 ${Math.round((res.expiresInSec ?? 600) / 60)} 分钟。`);
      }
    } catch (e) {
      if (e instanceof ApiRequestError) {
        setError(e.message);
        if (e.fields) setFieldErrors(e.fields);
      } else {
        setError('验证码发送失败，请稍后重试');
      }
    } finally {
      setSendingCode(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return; // 双保险：按钮已 disabled，这里再挡一次

    setError(null);
    setNotice(null);
    setFieldErrors({});
    setSubmitting(true);

    try {
      await apiPost(
        isRegister ? '/api/auth/register' : '/api/auth/login',
        isRegister
          ? { email, password, name: name.trim() || undefined, code }
          : { email, password },
      );
      /**
       * 不用 router.refresh() 之外的额外操作。
       *
       * (app) 布局是服务端组件，靠 cookie 鉴权。登录后必须让服务端
       * 重新渲染一次才能拿到新 cookie，否则 middleware 仍会把用户
       * 当成未登录弹回登录页。refresh() 会让当前路由的服务端组件重跑。
       */
      router.refresh();
      router.replace(nextPath);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message);
        setFieldErrors(err.fields ?? {});
      } else {
        setError('网络异常，请稍后重试');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const strengthStyle = STRENGTH_STYLE[strength.score]!;
  const canSubmit = isRegister
    ? Boolean(email && password && code && !submitting)
    : Boolean(email && password && !submitting);

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">{isRegister ? '创建账号' : '登录'}</CardTitle>
        <CardDescription>
          {isRegister
            ? '注册需要邮箱验证码，用来确认邮箱是你本人的'
            : '欢迎回来，继续你的文本工作流'}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {isRegister && (
            <div className="space-y-2">
              <Label htmlFor="name">昵称（可选）</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="怎么称呼你"
                maxLength={40}
                autoComplete="nickname"
              />
            </div>
          )}

          {/* 邮箱 + 发送验证码（注册时并排，点击区更大更好点） */}
          <div className="space-y-2">
            <Label htmlFor="email">邮箱</Label>
            <div className={isRegister ? 'flex gap-2' : undefined}>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                aria-invalid={Boolean(fieldErrors.email)}
              />
              {isRegister && (
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  loading={sendingCode}
                  disabled={cooldown > 0 || sendingCode}
                  onClick={sendCode}
                >
                  {cooldown > 0 ? `${cooldown}s` : '获取验证码'}
                </Button>
              )}
            </div>
            {fieldErrors.email && <p className="text-xs text-destructive">{fieldErrors.email}</p>}
          </div>

          {isRegister && (
            <div className="space-y-2">
              <Label htmlFor="code">邮箱验证码</Label>
              <Input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="6 位数字"
                aria-invalid={Boolean(fieldErrors.code)}
                className="tracking-[0.3em]"
              />
              {fieldErrors.code && <p className="text-xs text-destructive">{fieldErrors.code}</p>}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isRegister ? '至少 8 位，含字母和数字' : '请输入密码'}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              aria-invalid={Boolean(fieldErrors.password)}
            />

            {/* 密码强度条：只在注册且已输入时出现，避免登录页噪声 */}
            {isRegister && password.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center gap-2">
                  <div className="flex h-1.5 flex-1 gap-1">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <span
                        key={i}
                        className={`h-full flex-1 rounded-full transition-colors ${
                          i <= strength.score ? strengthStyle.bar : 'bg-muted'
                        }`}
                      />
                    ))}
                  </div>
                  <span className={`text-xs font-medium ${strengthStyle.text}`}>
                    {strength.level}
                  </span>
                </div>
                {strength.hints.length > 0 && strength.score < 3 && (
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {strength.hints.slice(0, 2).map((h) => (
                      <li key={h}>· {h}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {fieldErrors.password && <p className="text-xs text-destructive">{fieldErrors.password}</p>}
          </div>

          {notice && (
            <div
              role="status"
              className="rounded-md border border-emerald-600/30 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
            >
              {notice}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" loading={submitting} disabled={!canSubmit}>
            {isRegister ? '注册并登录' : '登录'}
          </Button>

          {isRegister && (
            <p className="text-center text-xs text-muted-foreground">
              登录不需要验证码；验证码只用于确认注册邮箱
            </p>
          )}
        </form>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          {isRegister ? '已有账号？' : '还没有账号？'}
          <Link
            href={isRegister ? '/login' : '/register'}
            className="ml-1 font-medium text-primary underline-offset-4 hover:underline"
          >
            {isRegister ? '去登录' : '去注册'}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

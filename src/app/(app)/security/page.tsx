import { SecurityActivity } from '@/components/settings/security-activity';

export const metadata = {
  title: '登录活动 · Lumenote',
};

export default function SecurityPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">登录活动</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          谁在什么时候、从哪个 IP、用什么设备登录过你的账号。
          如果看到不认识的记录，请立即修改密码并踢掉那些会话。
        </p>
      </header>
      <SecurityActivity />
    </div>
  );
}

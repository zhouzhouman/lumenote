import { UsageDashboard } from '@/components/usage/usage-dashboard';

export const metadata = {
  title: '成本 · Lumenote',
};

export default function UsagePage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">成本仪表盘</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          缓存命中率与首字延迟是 AI 应用真正该盯的两个指标 —— 前者决定账单，后者决定体验。
        </p>
      </header>
      <UsageDashboard />
    </div>
  );
}
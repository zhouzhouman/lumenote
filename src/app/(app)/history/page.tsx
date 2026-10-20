import { HistoryList } from '@/components/history/history-list';

export const metadata = {
  title: '历史 · Lumenote',
};

export default function HistoryPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">历史记录</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          每条记录都保留了 Prompt 版本与实际成本，可回溯、可核对。
        </p>
      </header>
      <HistoryList />
    </div>
  );
}
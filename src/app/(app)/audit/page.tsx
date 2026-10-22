import { AuditLogView } from '@/components/audit/audit-log-view';

export const metadata = {
  title: '操作记录 · Lumenote',
  // 审计记录属于内部合规数据，不收录
  robots: { index: false, follow: false },
};

export default function AuditPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">操作记录</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          谁在什么时候对哪些数据做了什么。内部合规的核心不是「功能齐不齐」，
          而是出事时能不能回答这个问题——并且这份记录不能被当事人改掉。
        </p>
      </header>

      <AuditLogView />
    </div>
  );
}

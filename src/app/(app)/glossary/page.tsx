import { GlossaryManager } from '@/components/glossary/glossary-manager';

export const metadata = {
  title: '术语表 · Lumenote',
};

export default function GlossaryPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">术语表</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          统一专有名词的译法。通用翻译模型对同一术语可能给出不同译法，
          对技术文档来说这是硬伤 —— 读者会以为是两个不同的东西。
        </p>
      </header>
      <GlossaryManager />
    </div>
  );
}

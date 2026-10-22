import { BatchConsole } from '@/components/batch/batch-console';

export const metadata = {
  title: '批次 · Lumenote',
  // 批次里是用户的内部材料，不该被搜索引擎收录
  robots: { index: false, follow: false },
};

export default function BatchesPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">批次处理</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          面向「一次交一批材料」的场景：合同、标书、研报批量处理，结果逐条留痕并可导出。
          串行执行、预算封顶，超预算的条目直接不跑（不花钱），而不是先跑了再说。
        </p>
      </header>

      <BatchConsole />
    </div>
  );
}

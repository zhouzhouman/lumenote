import Link from 'next/link';
import { BatchDetail } from '@/components/batch/batch-detail';

export const metadata = {
  title: '批次详情 · Lumenote',
  robots: { index: false, follow: false },
};

export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-5">
        <Link href="/batches" className="text-sm text-muted-foreground hover:text-foreground">
          ← 返回批次列表
        </Link>
      </header>

      <BatchDetail batchId={id} />
    </div>
  );
}

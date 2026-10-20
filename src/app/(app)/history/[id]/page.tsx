import { FollowUpThread } from '@/components/history/followup-thread';

export const metadata = {
  title: '追问对话 · Lumenote',
  // 对话内容属于用户私有资料，不该被搜索引擎收录
  robots: { index: false, follow: false },
};

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">追问对话</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          从原始结果开始，逐轮追问的完整推理路径。
          每一轮都会带上上一轮的结果作为上下文，因此追问是连续的而不是各自独立的。
        </p>
      </header>

      {/*
        taskId 交给客户端组件自己去拉整条链（而不是在这里服务端查）：
        追问过程中链会增长，客户端拉取后可以就地刷新，
        服务端渲染只在首次加载时有意义 —— 混合两套数据来源反而更容易不一致。
      */}
      <FollowUpThread taskId={id} />
    </div>
  );
}

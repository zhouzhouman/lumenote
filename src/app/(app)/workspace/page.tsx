import { Workspace } from '@/components/workspace/workspace';

export const metadata = {
  title: '工作台 · Lumenote',
};

export default function WorkspacePage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        {/*
          标题不再写死「摘要工作台」。
          工作台现在承载三种能力（摘要 / 翻译 / 润色改写），
          写死「摘要」会让切到翻译的用户以为走错了页面 ——
          而页面内的选中态与参数表单明明已经切过去了。
          具体能力名称由组件内部按选中类型显示。
        */}
        <h1 className="text-2xl font-semibold tracking-tight">工作台</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          摘要、翻译、润色改写共用同一条可靠性与计量管线：超长文本会自动分块，
          过程中实时显示 token 用量与成本，每条结果都记录 Prompt 指纹。
        </p>
      </header>
      <Workspace />
    </div>
  );
}
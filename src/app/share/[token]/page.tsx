import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { usdToCny } from '@/lib/llm/pricing';
import { checkShareLink, isValidShareTokenShape } from '@/lib/tasks/share';
import { SharedView, type SharedTaskView } from '@/components/share/shared-view';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: '分享的生成结果 · Lumenote',
  // 分享页不该被搜索引擎收录：内容可能包含用户的内部资料
  robots: { index: false, follow: false },
};

/**
 * 只读分享页 —— **全项目唯一不需要登录的读取路径**。
 *
 * 因此这里的校验必须自己写全，不能依赖 (app) 布局那层的鉴权：
 * 这个路由在 `(app)` 之外，布局不会生效。
 *
 * 校验清单（缺一条都会造成信息泄露）：
 *  1. token 存在且有效
 *  2. 未被撤销（revokedAt 为空）
 *  3. 未过期（expiresAt 为空 = 永不过期）
 *  4. **所属任务未被软删除** —— 否则「删除任务」变成假动作，
 *     用户以为删掉了，链接却还能打开
 *
 * 任何一条不满足都返回 404 而不是 403：不区分「不存在」与「无权限」，
 * 避免用状态码探测 token 是否有效。
 */
export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // token 是 base64url，先做形态校验再查库 —— 挡住明显的垃圾请求，省一次查询
  if (!isValidShareTokenShape(token)) notFound();

  const link = await prisma.shareLink.findUnique({
    where: { token },
    include: {
      task: {
        include: {
          template: { select: { name: true } },
          promptVersion: { select: { version: true } },
          usageLog: { select: { promptTokens: true, completionTokens: true, estimatedCost: true, model: true } },
        },
      },
    },
  });

  if (!link) notFound();

  /**
   * 有效性判断抽在 `lib/tasks/share.ts` 的纯函数里：
   *  1. 组件渲染期间不允许调用 `Date.now()`（react-hooks/purity），
   *     把「当前时间」作为参数传入既满足规则，也让逻辑可单测
   *  2. 判断规则集中一处，日后加「访问次数上限」之类的约束不会散落各文件
   */
  if (!checkShareLink({
    revokedAt: link.revokedAt,
    expiresAt: link.expiresAt,
    taskDeletedAt: link.task.deletedAt,
  }).valid) {
    notFound();
  }

  /**
   * ⚠️ 这里必须把 outputContent 收进一个局部常量再判空。
   *
   * `notFound()` 的返回类型是 `never`，但 TypeScript 不会因此把
   * `link.task.outputContent` 收窄成非空 —— 因为它是**属性访问**，
   * 编译器不假设「同一个对象的属性在两次读取之间不变」。
   * 所以 `if (!link.task.outputContent) notFound();` 之后
   * 下面的 `task.outputContent` 仍然是 `string | null`。
   * 赋值给 local const 之后收窄才生效。
   */
  const outputContent = link.task.outputContent;
  if (!outputContent) notFound();

  const task = link.task;
  const meta = (task.inputMeta ?? {}) as { charCount?: number; sourceHost?: string | null };

  /**
   * 浏览量计数：**失败不能阻断访问**。
   * 计数是运营数据，不是权限判断的一部分；为它牺牲可用性不划算。
   */
  void prisma.shareLink
    .update({
      where: { id: link.id },
      data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
    })
    .catch(() => undefined);

  const data: SharedTaskView = {
    title: task.title,
    type: task.type,
    outputContent,
    createdAt: task.createdAt.toISOString(),
    degraded: task.degraded,
    charCount: meta.charCount ?? task.inputContent?.length ?? 0,
    templateName: task.template.name,
    promptVersion: task.promptVersion.version,
    // 模型名优先取计量记录里的真实值；没有计量记录时回落任务参数里的快照
    model:
      task.usageLog?.model ??
      (typeof (task.params as Record<string, unknown>)?.model === 'string'
        ? String((task.params as Record<string, unknown>).model)
        : null),
    costCny: task.usageLog ? usdToCny(task.usageLog.estimatedCost) : null,
    inputTokens: task.usageLog?.promptTokens ?? null,
    outputTokens: task.usageLog?.completionTokens ?? null,
    sourceHost: meta.sourceHost ?? null,
  };

  return <SharedView data={data} token={token} />;
}

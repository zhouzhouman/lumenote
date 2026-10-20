import { prisma } from '@/lib/db';
import { handleError, ok } from '@/lib/api';
import { requireUserId, authzTask, AuthzError } from '@/lib/auth/authz';
import { env } from '@/lib/env';
import { cacheHitRate, usdToCny } from '@/lib/llm/pricing';
import type { TaskDetail } from '@/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 任务详情。包含「Prompt 指纹」与完整用量 —— 这是产品的核心信息 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    // 防越权：走 authzTask 而非裸 findUnique
    const task = await authzTask(userId, id);

    const usage = await prisma.usageLog.findUnique({
      where: { taskId: task.id },
      select: {
        provider: true,
        model: true,
        promptTokens: true,
        completionTokens: true,
        cachedTokens: true,
        estimatedCost: true,
        peakPricing: true,
        latencyMs: true,
        ttftMs: true,
        success: true,
      },
    });

    const inputMeta = (task.inputMeta ?? {}) as Record<string, unknown>;
    const outputMeta = (task.outputMeta ?? {}) as Record<string, unknown>;

    /**
     * Agent 任务的推理轨迹。
     *
     * ⚠️ 只对 agent 类型查这一步。普通任务查它永远是空数组，
     * 白白多一次数据库往返 —— 而详情接口是历史列表每次点击都会调的。
     */
    const agentSteps =
      task.type === 'agent'
        ? await prisma.agentStep.findMany({
            where: { taskId: task.id },
            orderBy: { seq: 'asc' },
            select: {
              seq: true,
              phase: true,
              text: true,
              reasoning: true,
              toolCalls: true,
              toolResults: true,
              inputTokens: true,
              outputTokens: true,
              cumulativeTokens: true,
              latencyMs: true,
              note: true,
            },
          })
        : [];

    const detail: TaskDetail = {
      id: task.id,
      type: task.type as TaskDetail['type'],
      title: task.title,
      status: task.status as TaskDetail['status'],
      preview: (task.outputContent ?? '').slice(0, 160),
      charCount: Number(inputMeta.charCount ?? task.inputContent?.length ?? 0),
      degraded: task.degraded,
      createdAt: task.createdAt.toISOString(),
      completedAt: task.completedAt?.toISOString() ?? null,

      inputType: task.inputType,
      inputRef: task.inputRef,
      inputContent: task.inputContent,
      outputContent: task.outputContent,
      inputMeta,
      outputMeta,

      params: (task.params ?? {}) as Record<string, unknown>,

      latencyMs: task.latencyMs,
      ttftMs: task.ttftMs,
      errorCode: task.errorCode,
      errorMessage: task.errorMessage,

      /**
       * Prompt 指纹：让用户能完整还原「这条结果是怎么生成的」。
       * 这是本项目「可追溯」定位的具体体现。
       */
      promptVersion: {
        templateName: task.template.name,
        version: task.promptVersion.version,
        notes: task.promptVersion.notes,
      },

      usage: usage
        ? {
            inputTokens: usage.promptTokens,
            outputTokens: usage.completionTokens,
            cachedTokens: usage.cachedTokens,
            // UsageLog.estimatedCost 存的是美元，展示前统一换算（汇率只在 pricing.ts 定义）
            costCny: Number(usdToCny(usage.estimatedCost).toFixed(6)),
            cacheHitRate: Number(cacheHitRate(usage.promptTokens, usage.cachedTokens).toFixed(4)),
            peak: usage.peakPricing,
          }
        : null,

      // 降级与重试轨迹：解释「为什么这次慢 / 为什么结果标了降级」
      attempts: (outputMeta.attempts as TaskDetail['attempts']) ?? [],
    };

    // 把模型参数与计价时段等注记也带上，便于前端展示
    detail.outputMeta = {
      ...outputMeta,
      model: usage?.model ?? String((task.params as Record<string, unknown>)?.model ?? env().DEFAULT_MODEL),
      provider: usage?.provider ?? null,
      /**
       * Agent 轨迹塞进 outputMeta 而不是加一个新的顶层字段。
       *
       * 理由：`TaskDetail` 是前后端共用类型，加顶层字段要同步改两处；
       * 而轨迹本来就是「这次输出的元信息」，语义上放 outputMeta 也成立。
       * 代价是 outputMeta 的类型更宽松（它已经是 Record<string, unknown>），
       * 所以消费端需要自己收窄 —— 前端已经这么做了。
       */
      ...(agentSteps.length > 0
        ? {
            agentSteps: agentSteps.map((s) => ({
              seq: s.seq,
              phase: s.phase,
              text: s.text,
              reasoning: s.reasoning,
              toolCalls: s.toolCalls,
              toolResults: s.toolResults,
              inputTokens: s.inputTokens,
              outputTokens: s.outputTokens,
              cumulativeTokens: s.cumulativeTokens,
              latencyMs: s.latencyMs,
              note: s.note,
            })),
          }
        : {}),
    };

    return ok(detail);
  } catch (e) {
    return handleError(e);
  }
}

/** 软删除。历史记录是用户资产，要「回收站」而不是物理删除 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    await authzTask(userId, id);

    await prisma.task.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return ok({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}

/** 恢复软删除 */
export async function PATCH(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const task = await prisma.task.findFirst({
      where: { id, userId }, // 注意这里不能用 authzTask（它过滤了已删除）
      select: { id: true },
    });

    if (!task) {
      // 用 AuthzError 而非裸 Error：前者是 404 语义，不泄漏资源是否存在
      return handleError(new AuthzError());
    }

    await prisma.task.update({
      where: { id },
      data: { deletedAt: null },
    });

    return ok({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
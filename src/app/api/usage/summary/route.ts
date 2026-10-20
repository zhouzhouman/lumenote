import { z } from 'zod';
import { prisma } from '@/lib/db';
import { handleError, ok } from '@/lib/api';
import { requireUserId } from '@/lib/auth/authz';
import { env } from '@/lib/env';
import { loadActiveCredential } from '@/lib/llm/credentials';
import type { UsageSummaryDto } from '@/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  days: z.coerce.number().int().positive().max(365).default(30),
});

/**
 * 成本与用量汇总（成本仪表盘的数据源）。
 *
 * 这里返回的不只是「花了多少钱」，还有 AI 应用特有的指标：
 *  - **缓存命中率**：直接反映「把稳定内容前置」这条设计是否生效
 *  - **TTFT P95**：首 token 延迟，比总耗时更贴近用户感知性能
 *  - **按模型分布**：能看出高级模型是否被误用（成本失控的早期信号）
 *
 * 通用 APM 工具（APM）覆盖不到这些，所以必须自建 —— 这也是本项目
 * 「业务可观测性」与「技术可观测性」分开建设的原因。
 */
export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const { days } = QuerySchema.parse({
      days: url.searchParams.get('days') ?? undefined,
    });

    const { summarizeUsage } = await import('@/lib/llm/metering');
    const summary = await summarizeUsage(userId, days);

    // 用户自己的每日配额进度 —— 成本控制要让用户可见
    const quota = await prisma.user.findUnique({
      where: { id: userId },
      select: { dailyQuota: true, plan: true },
    });

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const usedToday = await prisma.task.count({
      where: { userId, createdAt: { gte: startOfDay }, deletedAt: null },
    });

    // 用自有 key 的用户不占站点配额 —— 仪表盘要如实说明，否则那个进度条会误导人
    const activeCredential = await loadActiveCredential(userId);

    const dto: UsageSummaryDto = {
      totalRequests: summary.totalRequests,
      successRequests: summary.successRequests,
      failedRequests: summary.failedRequests,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
      totalCachedTokens: summary.totalCachedTokens,
      cacheHitRate: Number(summary.cacheHitRate.toFixed(4)),
      totalCostCny: Number(summary.totalCostCny.toFixed(4)),
      avgLatencyMs: summary.avgLatencyMs,
      p95TtftMs: summary.p95TtftMs,
      byModel: summary.byModel.map((m) => ({
        ...m,
        costCny: Number(m.costCny.toFixed(6)),
      })),
      quota: {
        /**
         * ⚠️ 这里的 limit 必须与「真正执行配额检查的那处」取同一个来源。
         *
         * 之前这里读 User.dailyQuota 并用 20 兜底，而 tasks 路由用的是
         * env().FREE_DAILY_QUOTA —— 两者不一致时用户会看到
         * 「进度条 3/100，却提示额度已用完」，一个无法自证的问题。
         * 现在两边都读 User.dailyQuota，读不到时回落 env，语义完全一致。
         */
        limit: quota?.dailyQuota ?? env().FREE_DAILY_QUOTA,
        used: usedToday,
        plan: quota?.plan ?? 'free',
        // BYOK 用户不受站点配额限制，前端据此把「配额进度」换成更贴切的说明
        bypassedByUserCredential: Boolean(activeCredential),
      },
    };

    return ok(dto);
  } catch (e) {
    return handleError(e);
  }
}
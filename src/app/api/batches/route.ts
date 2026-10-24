import { z } from 'zod';
import { after } from 'next/server';
import { prisma } from '@/lib/db';
import { ok, fail, handleError, parseLimit } from '@/lib/api';
import { requireActor, requireUserId } from '@/lib/auth/authz';
import { recordAudit, auditContextFrom } from '@/lib/audit/log';
import { env } from '@/lib/env';
import { rateLimitByUser } from '@/lib/rate-limit';
import { loadActiveCredential } from '@/lib/llm/credentials';
import { assertConcurrencyWithinLimit, checkDailyQuota } from '@/lib/idempotency';
import { createTaskRecord, createFailedTaskRecord } from '@/lib/tasks/create';
import { usdToCny } from '@/lib/llm/pricing';
import { parseBatchInput } from '@/lib/batch/parse';
import { runBatch } from '@/lib/batch/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 批次接口 —— 「团队内部文档流水线」的入口。
 *
 * 与单篇任务一样走**两段式**：这里只负责建批次 + 建 N 条任务，然后立刻返回，
 * 执行交给 after() 里的串行执行器（见 lib/batch/runner.ts）。
 *
 * 为什么不在请求里跑完：20 份材料 × 每份几十秒 = 十几分钟，
 * 任何平台的单请求都撑不住；而且用户关掉页面就该能继续跑完。
 */
const CreateBatchSchema = z.object({
  name: z.string().trim().max(60).optional(),
  type: z.enum(['summarize', 'translate', 'write']).default('summarize'),
  /** 原始文本：多份之间用单独一行的 --- 分隔（见 lib/batch/parse.ts） */
  content: z.string().min(10, '至少粘贴一份材料（不少于 10 个字符）'),
  /*
   * 参数值统一成字符串：与 `POST /api/tasks` 的 `z.record(z.string())` 保持同一契约。
   *
   * 之前这里用 z.unknown()，前端把 pointCount 当数字传也没报错，
   * 而单篇任务接口对同样的请求返回 422 —— 同一个参数两套类型，
   * 迟早会出现「批次能跑、单篇报错」的分裂行为。
   */
  params: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v)),
    )
    .default({}),
  /** 预算上限（人民币）。不传 = 不限制 */
  budgetCny: z.number().positive().max(10_000).optional(),
  model: z.string().max(80).optional(),
});

export async function POST(req: Request) {
  try {
    const actor = await requireActor();
    const userId = actor.userId;
    const e = env();

    // 建批次比建单篇任务「重」得多（一次可能落 20 条记录），限流更严
    const rl = await rateLimitByUser(userId, 'batch:create');
    if (!rl.ok) {
      return fail('RATE_LIMITED', `操作过于频繁，请 ${rl.retryAfterSec} 秒后重试`, 429);
    }

    const body = CreateBatchSchema.parse(await req.json());

    // 1) 解析输入。**有问题就整批拒绝** —— 半批成功对用户最难解释
    const parsed = parseBatchInput(body.content);
    if (parsed.problems.length > 0) {
      return fail('INVALID_BATCH_INPUT', parsed.problems.join('；'), 400);
    }
    if (parsed.items.length === 0) {
      return fail('INVALID_BATCH_INPUT', '没有可处理的材料', 400);
    }

    /*
     * 2) 额度预检：**整批一次算清**。
     *
     * 不做「跑到第 8 份没额度了」这种半途而废：用户交上来 20 份，
     * 跑到一半停下，剩下的既没结果也没明确状态，比直接拒绝更难处理。
     */
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { dailyQuota: true },
    });
    const quotaLimit = user?.dailyQuota ?? e.FREE_DAILY_QUOTA;
    const credential = await loadActiveCredential(userId);

    if (!credential) {
      const quota = await checkDailyQuota(userId, quotaLimit);
      if (!quota.ok) {
        return fail(
          'QUOTA_EXCEEDED',
          `今日免费额度已用完（${quota.used}/${quotaLimit}），无法创建批次。` +
            '可以到「模型设置」填入自己的 API Key 继续。',
          429,
        );
      }
      const remaining = Math.max(0, quotaLimit - quota.used);
      if (parsed.items.length > remaining) {
        return fail(
          'QUOTA_INSUFFICIENT',
          `本批有 ${parsed.items.length} 份材料，但今日剩余额度只有 ${remaining} 次。` +
            '请减少份数、分批提交，或填入自己的 API Key（用自己的额度不受站点配额限制）。',
          429,
        );
      }
    }

    // 3) 并发：批次执行期间会占满「同用户 1 个进行中任务」的名额
    await assertConcurrencyWithinLimit(userId, e.MAX_CONCURRENT_TASKS_PER_USER);

    // 4) 模型选择规则与单篇任务一致（BYOK 用用户的模型，站点通道生产环境禁止自选）
    const model = credential
      ? credential.model
      : e.MOCK_LLM || process.env.NODE_ENV !== 'production'
        ? (body.model ?? e.DEFAULT_MODEL)
        : e.DEFAULT_MODEL;

    const batch = await prisma.batch.create({
      data: {
        userId,
        name: body.name?.trim() || defaultBatchName(parsed.items.length),
        type: body.type,
        status: 'queued',
        total: parsed.items.length,
        params: { ...body.params, model } as never,
        budgetCny: body.budgetCny ?? null,
      },
      select: { id: true, name: true },
    });

    /*
     * 5) 逐条落库。
     *
     * 这里 `await` 串行创建，而不是 Promise.all：URL 类型的条目在创建时会触发
     * 抓取（extractText），并发抓 20 个外部站点既不礼貌也容易触发对端限流。
     *
     * 创建失败（例如某个链接打不开）不在这里中断整批：把该条标成 failed，
     * 其余继续 —— 这是「批量处理」的核心价值，一份坏材料不该拖垮整批。
     */
    let created = 0;
    let failedOnCreate = 0;
    for (const [index, item] of parsed.items.entries()) {
      try {
        await createTaskRecord({
          userId,
          type: body.type,
          inputType: item.inputType,
          content: item.content,
          params: body.params,
          model,
          credential: credential ? { id: credential.id, label: credential.label } : null,
          title: item.title,
          // 幂等键按「批次 + 序号」生成：同一次提交重复触发不会产生重复任务
          idempotencyKey: `batch:${batch.id}:${index}`,
          batchId: batch.id,
          batchOrder: index,
        });
        created += 1;
      } catch (err) {
        /*
         * 单条失败不拖垮整批 —— 这是批量处理的核心价值（一份坏材料不该让
         * 另外 19 份白交）。但失败必须**留一条 failed 记录**，
         * 否则详情页会少一行，用户会以为系统在丢数据。
         */
        console.error(`[batch:${batch.id}] 第 ${index + 1} 条创建失败：`, err);
        const message = err instanceof Error ? err.message : String(err);
        const code =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code: unknown }).code)
            : 'ITEM_CREATE_FAILED';
        await createFailedTaskRecord({
          userId,
          type: body.type,
          inputType: item.inputType,
          content: item.content,
          title: item.title,
          params: body.params,
          model,
          idempotencyKey: `batch:${batch.id}:${index}`,
          batchId: batch.id,
          batchOrder: index,
          errorCode: code,
          errorMessage: message,
        }).catch((e) => {
          /*
           * 连「失败记录」都写不进去（例如模板缺失）：不能再抛出去，
           * 否则整个循环中断、已创建的任务悬在一个永远 queued 的批次里。
           * 只记日志，最后靠计数对账。
           */
          console.error(`[batch:${batch.id}] 第 ${index + 1} 条的失败记录也没写入：`, e);
        });
        failedOnCreate += 1;
      }
    }

    if (created === 0) {
      await prisma.batch.update({
        where: { id: batch.id },
        data: { status: 'failed', failed: parsed.items.length, finishedAt: new Date() },
      });
      return fail(
        'BATCH_CREATE_FAILED',
        '所有条目都没能创建（常见原因：链接打不开、需要登录、或不是网页/纯文本页面）',
        400,
      );
    }

    // 6) 响应先返回，执行挂到 after()：断线/关页面都不影响它跑完
    after(async () => {
      try {
        await runBatch(batch.id);
      } catch (err) {
        console.error(`[batch:${batch.id}] 执行器异常：`, err);
      }
    });

    /*
     * 审计：批次创建是「一批材料被提交处理」这个动作的唯一凭据。
     * 记份数、失败数、预算与模型 —— 这四项决定了「这次跑了多少钱、能不能复现」。
     */
    await recordAudit({
      userId: actor.userId,
      actorEmail: actor.email,
      action: 'batch.create',
      targetType: 'batch',
      targetId: batch.id,
      meta: {
        itemCount: parsed.items.length,
        created,
        failedOnCreate,
        budgetCny: body.budgetCny ?? null,
        model,
        type: body.type,
      },
      context: auditContextFrom(req),
    });

    return ok({
      batchId: batch.id,
      name: batch.name,
      total: parsed.items.length,
      created,
      // 创建阶段就失败的条数（链接打不开等）。前端据此提示「有 N 份没能读取」
      failedOnCreate,
    });
  } catch (e) {
    return handleError(e);
  }
}

export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const limit = parseLimit(url.searchParams.get('limit'));

    // 只列出「任务」列表够用的字段，别把 params/输出带出来 —— 列表页不需要
    const batches = await prisma.batch.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        total: true,
        succeeded: true,
        failed: true,
        skipped: true,
        budgetCny: true,
        costUsd: true,
        createdAt: true,
        finishedAt: true,
      },
    });

    return ok({ items: batches.map((b) => ({ ...b, costCny: usdToCny(b.costUsd) })) });
  } catch (e) {
    return handleError(e);
  }
}

function defaultBatchName(count: number): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 批次（${count} 份）`;
}


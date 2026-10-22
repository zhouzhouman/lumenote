import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { after } from 'next/server';
import { prisma } from '@/lib/db';
import { handleError, ok, fail, parseLimit } from '@/lib/api';
import { requireUserId } from '@/lib/auth/authz';
import { runSummarizePipeline } from '@/lib/pipeline/runner';
import { createTaskRecord } from '@/lib/tasks/create';
import { LLMError } from '@/lib/llm/types';
import { env } from '@/lib/env';
import {
  idempotentTask,
  normalizeIdempotencyKey,
  assertConcurrencyWithinLimit,
  checkDailyQuota,
} from '@/lib/idempotency';
import { rateLimitByUser } from '@/lib/rate-limit';
import { loadActiveCredential } from '@/lib/llm/credentials';
import type { CursorPage, TaskSummary } from '@/types/api';

/**
 * ⚠️ 必须是 Node 运行时，不能用 Edge：
 *  - Prisma Engine 无法在 Edge 运行
 *  - 流式依赖 Node 的 ReadableStream 行为
 *  - after() 生命周期在 Edge 上语义不同
 */
export const runtime = 'nodejs';
// 任务列表每次都不同，绝不能被缓存
export const dynamic = 'force-dynamic';

// ============================================================
// POST：创建任务
//
// ★★★ 这是「两段式流式」的第一段，也是整个架构的地基 ★★★
//
// 本接口**绝不执行 LLM 调用**，只做三件事然后立刻返回：
//   1. 校验 + 幂等查重
//   2. 写入 Task(status=queued)
//   3. after() 异步跑管线，返回 taskId
//
// 目标响应时间 < 200ms。
//
// ## 为什么必须两段式，而不是在一个请求里流式返回
//
// Serverless 有函数执行时长上限（Vercel Hobby 尤其严格），
// 一篇长文的 Map-Reduce 摘要可能跑几十秒甚至几分钟，
// 单请求根本撑不住。
//
// 两段式还有个额外好处：**断线可以重连**。
// 第一段返回的 taskId 是持久化的，第二段 SSE 连上后可以：
//   - 订阅正在进行的输出
//   - 若已完成，直接回放已落库的内容
// 服务重启也不影响，因为内容在数据库里而非内存里。
//
// 如果做成一请求内跑完，用户切走页面就全丢了，也无法断线续传。
// ============================================================

const CreateTaskSchema = z
  .object({
    /** summarize | translate | write —— 定义见 lib/tasks/types.ts */
    type: z.enum(['summarize', 'translate', 'write']).default('summarize'),
    content: z.string().min(10, '内容至少 10 个字符'),
    inputType: z.enum(['text', 'url']).default('text'),
    title: z.string().max(120).optional(),
    /** 模板变量值 */
    params: z.record(z.string()).default({}),
    /** 仅 Mock/调试环境允许覆盖模型 */
    model: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    /**
     * 链接模式下在 schema 层就把格式问题拦下来。
     *
     * 否则一个 `not-a-url` 会一路传到 extractFromUrl 才被拒，
     * 而 Zod 的默认报错是笼统的「请求参数有误」，用户不知道错在哪。
     * 前端已有即时校验拦一道，这里是接口层的兜底（直接调 API 的场景）。
     */
    if (val.inputType === 'url' && !/^https?:\/\/\S+$/i.test(val.content.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: '链接需以 http:// 或 https:// 开头，且不能包含空格',
      });
    }
  });

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const e = env();

    // 限流：单用户创建任务的频率
    const rl = await rateLimitByUser(userId, 'task:create');
    if (!rl.ok) {
      return fail('RATE_LIMITED', `操作过于频繁，请 ${rl.retryAfterSec} 秒后重试`, 429);
    }

    const body = CreateTaskSchema.parse(await req.json());

    /**
     * 幂等键从请求头取。
     *
     * 为什么放**请求头**而不是 body？
     *  - 请求头是「这次调用」的元信息，body 是「业务数据」，语义上更对
     *  - body 的 schema 校验失败时，幂等键仍然能被读到，可以安全重试
     *  - 更重要的是：body 可能被缓存/重放，而幂等键需要每次尝试都唯一
     */
    const idempotencyKey = normalizeIdempotencyKey(req.headers.get('Idempotency-Key'));

    /**
     * 快路径：命中幂等则直接返回已有任务，**完全不碰任何 LLM**。
     * 这是防重复扣费最有效的一环 —— 重复点击根本不会产生第二次调用。
     */
    const { result: task, replayed } = await idempotentTask(
      userId,
      idempotencyKey,
      async () => createTask(userId, idempotencyKey, body, e),
      async (key) => {
        const existing = await prisma.task.findFirst({
          where: { userId, idempotencyKey: key },
        });
        return existing ?? null;
      },
    );

    if (replayed) {
      // 明确告知前端这是重放，前端可以决定是否继续订阅 SSE
      return ok({ taskId: task.id, status: task.status, replayed: true });
    }

    /**
     * after()：把管线执行挂到「响应发送完成之后」。
     *
     * 这是两段式架构的落地点。用了 after() 之后：
     *   - 本请求立即返回 taskId（< 200ms），不受管线耗时影响
     *   - 管线仍能获得一个完整的请求生命周期来执行
     *   - 客户端通过第二个请求（SSE）来消费输出
     *
     * 如果不用 after() 而是直接 await，用户会盯着一个几十秒的请求，
     * 且中途断开就全丢 —— 那正是我们要避免的。
     *
     * ⚠️ Serverless 的 after() 仍有平台超时上限。对于极长文档，
     * 生产环境的正确做法是迁移到外部 Worker（Trigger.dev / QStash），
     * 见 docs/architecture.md 的「已知限制」一节。
     */
    after(async () => {
      try {
        await runSummarizePipeline({ taskId: task.id });
      } catch (e) {
        // runSummarizePipeline 内部已经把失败状态落库并计量，
        // 这里只需记录，不要重复写状态
        console.error(`[task:${task.id}] 管线执行失败：`, e);
      }
    });

    return ok({ taskId: task.id, status: task.status, replayed: false });
  } catch (e) {
    return handleError(e);
  }
}

/** 创建任务本体。与幂等逻辑分离，便于单独测试 */
async function createTask(  userId: string,
  idempotencyKey: string,
  body: z.infer<typeof CreateTaskSchema>,
  e: ReturnType<typeof env>,
) {
  /**
   * 先确定用哪条模型通道。
   *
   * 这一步放在配额检查之前，因为它决定了配额**是否适用**：
   * 用户配了自己的 API Key 时，费用由他自己承担，站点侧的免费配额就没有意义了。
   * 反过来若先检查配额，会出现「用自己的 key 却被站点额度拦住」的荒唐结果。
   *
   * ⚠️ 这里只取 id 快照进 Task.params，**绝不把密钥写进任务记录**。
   * 管线执行时按 id 重新读取并解密（见 runner.ts 的 resolveUserProvider）。
   */
  const activeCredential = await loadActiveCredential(userId);

  // 成本保护 1：并发上限。同一用户同时最多 1 个进行中的任务，
  // 否则开 5 个标签页就是 5 倍成本，而单看每个请求的限流都不超。
  //
  // 注意：并发上限对 BYOK 同样生效。它保护的不是站点的钱，
  // 而是**用户自己**的钱 —— 5 个标签页同时跑长文，烧的是他刚填进去的 key。
  const concurrency = await assertConcurrencyWithinLimit(
    userId,
    e.MAX_CONCURRENT_TASKS_PER_USER,
  );
  if (!concurrency.ok) {
    throw new LLMError('你有任务正在处理中，请等待完成后再提交', 'TOO_MANY_RUNNING', true, 429);
  }

  // 成本保护 2：每日配额。仅在使用站点凭证时检查（见上面说明）。
  if (!activeCredential) {
    /**
     * 用「用户自己的配额」而不是全局 env 值。
     *
     * 之前仪表盘读 User.dailyQuota，而这里用 e.FREE_DAILY_QUOTA，
     * 两个来源不一致就会出现「进度条显示 3/100，却提示额度用完」这种
     * 无法自证的问题。现在两处都读同一个来源（读不到时回落 env）。
     */
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { dailyQuota: true },
    });
    const quotaLimit = user?.dailyQuota ?? e.FREE_DAILY_QUOTA;

    const quota = await checkDailyQuota(userId, quotaLimit);
    if (!quota.ok) {
      throw new LLMError(
        `今日免费额度已用完（${quota.used}/${quotaLimit}）。` +
          '你可以到「模型设置」填入自己的 API Key，用你自己的额度继续生成。',
        'QUOTA_EXCEEDED',
        false,
        429,
      );
    }
  }

  /**
   * 模型名的记录。
   *
   * BYOK 时用用户选的模型（否则任务详情里显示的会是站点默认模型，
   * 与真实调用不符，可追溯性就成了摆设）；
   * 站点通道时维持原有规则 —— 生产环境禁止用户指定模型，防止绕过成本控制。
   */
  const model = activeCredential
    ? activeCredential.model
    : e.MOCK_LLM || process.env.NODE_ENV !== 'production'
      ? (body.model ?? e.DEFAULT_MODEL)
      : e.DEFAULT_MODEL;

  /*
   * 正文提取 → 模板/版本解析 → 术语表快照 → 落库，全部交给共享函数。
   * 批次（POST /api/batches）走的是同一个函数：这条链路一旦复制成两份，
   * 迟早会出现「翻译任务用了摘要模板」这种界面正常、结果全错的事故。
   */
  return createTaskRecord({
    userId,
    type: body.type,
    inputType: body.inputType,
    content: body.content,
    params: body.params as Record<string, unknown>,
    model,
    credential: activeCredential
      ? { id: activeCredential.id, label: activeCredential.label }
      : null,
    title: body.title,
    idempotencyKey,
    batchId: null,
  });
}

// ============================================================
// GET：任务列表（cursor / keyset 分页）
// ============================================================

/**
 * 为什么不用 offset 分页？
 *
 * 三个实际会导致错误数据的原因：
 *  1. 深翻页性能退化：OFFSET 50000 要求数据库扫描并丢弃前 5 万行
 *  2. **新插入导致重复/遗漏**（这是最要命的）：
 *     用户翻到第 2 页时来了新任务，第 1 页的条目被挤到第 2 页，
 *     于是同一个任务出现两次，或某条永远看不到
 *  3. 翻页期间数据被删除，页码整体前移，出现空洞
 *
 * keyset 分页用「上一页最后一条的 (createdAt, id)」作为游标，
 * 定位是 O(log n) 且不受新数据影响。代价是不能跳页 ——
 * 但历史记录场景里跳页需求很弱，这笔交换非常划算。
 *
 * cursor 编码为 base64 的 `createdAtISO_id`，不透明且不暴露内部结构。
 */
export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);

    const limit = parseLimit(url.searchParams.get('limit'));
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const type = url.searchParams.get('type');
    const search = url.searchParams.get('q')?.trim();
    const includeDeleted = url.searchParams.get('deleted') === 'true';

    /**
     * ⚠️ 必须带 userId 过滤。这是防越权的最后一道防线，
     * 任何时候都不能因为「分页逻辑复杂」而遗漏这个条件。
     *
     * 注意用 AND 显式组合而不是平铺：搜索条件与游标条件都用到了 OR，
     * 平铺会互相覆盖（后者赢），导致搜索结果里出现错误页。
     */
    const conditions: Prisma.TaskWhereInput[] = [
      { userId, deletedAt: includeDeleted ? { not: null } : null },
    ];

    if (type && ['summarize', 'translate', 'write'].includes(type)) {
      conditions.push({ type });
    }

    if (search) {
      conditions.push({
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { outputContent: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    if (cursor) {
      // 复合游标：(createdAt, id) 都小于游标值。
      // 内部用 OR 是必须的：多条记录可能 createdAt 完全相同（同一毫秒创建），
      // 此时靠 id 做 tie-breaker 才能保证不重不漏
      conditions.push({
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      });
    }

    const rows = await prisma.task.findMany({
      where: { AND: conditions },
      take: limit + 1, // 多取一条判断是否还有下一页
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        template: { select: { name: true } },
        promptVersion: { select: { version: true, notes: true } },
      },
    });

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];

    const page: CursorPage<TaskSummary> = {
      items: items.map((t) => toSummary(t)),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      hasMore,
    };

    return ok(page);
  } catch (e) {
    return handleError(e);
  }
}

type RowWithRelations = {
  id: string;
  type: string;
  title: string;
  status: string;
  inputContent: string | null;
  outputContent: string | null;
  inputMeta: unknown;
  degraded: boolean;
  createdAt: Date;
  completedAt: Date | null;
  template: { name: string };
  promptVersion: { version: number; notes: string | null };
};

function toSummary(t: RowWithRelations): TaskSummary {
  const meta = (t.inputMeta ?? {}) as { charCount?: number };
  const preview = (t.outputContent ?? '').slice(0, 160);

  return {
    id: t.id,
    type: t.type as TaskSummary['type'],
    title: t.title,
    status: t.status as TaskSummary['status'],
    preview,
    charCount: meta.charCount ?? t.inputContent?.length ?? 0,
    degraded: t.degraded,
    createdAt: t.createdAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
    promptVersion: {
      templateName: t.template.name,
      version: t.promptVersion.version,
      notes: t.promptVersion.notes,
    },
  };
}

// ============================================================
// Cursor 编解码
// ============================================================

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}_${id}`).toString('base64url');
}

export function decodeCursor(raw: string | null): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = decoded.lastIndexOf('_');
    if (sep < 0) return null;
    const date = new Date(decoded.slice(0, sep));
    if (Number.isNaN(date.getTime())) return null;
    return { createdAt: date, id: decoded.slice(sep + 1) };
  } catch {
    // 非法 cursor 当作第一页，而不是报错 ——
    // 客户端可能因为本地存储损坏而来这里报错，体验上「回到第一页」更好
    return null;
  }
}
import { prisma } from '@/lib/db';
import { fail, handleError, ok } from '@/lib/api';
import { requireUserId, authzTask, AuthzError } from '@/lib/auth/authz';
import { TASK_TYPES, normalizeTaskType } from '@/lib/tasks/types';
import { runSummarizePipeline } from '@/lib/pipeline/runner';
import { assertConcurrencyWithinLimit } from '@/lib/idempotency';
import { estimateTokens } from '@/lib/llm/mock';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 基于已有结果继续追问（多轮对话）。
 *
 * ## 为什么做成独立接口而不是复用 POST /api/tasks
 *
 * 追问与新建任务有三处本质差异，硬塞进一个接口会让两边都变脏：
 *
 *  1. **输入是「上一轮的结果 + 本轮问题」**，不是用户粘贴的原文。
 *     走 /api/tasks 的话需要前端自己把上文拼进 content —— 那就把
 *     「上下文怎么组织」这个提示词层面的决策下放给了客户端，
 *     一旦前端版本不一致，同一段对话会得到不同结果。
 *  2. **不重复做正文抽取**。原文已经抽过并存在父任务里，重抽一遍既慢又可能失败。
 *  3. **不需要检查每日配额与模板变量**。追问沿用父任务的模板与参数，
 *     用户没有「填参数」这一步。
 *
 * ## 上下文组织方式（这是一个设计决策）
 *
 * 只带**父任务的结果**与本轮问题，不带更早的历史。
 * 理由：DeepSeek 的输出价是输入的约 4 倍，把整条对话历史都塞进去，
 * 成本随轮次线性增长，而追问场景下「上一轮结论 + 本轮问题」通常已足够。
 * 需要更长的上下文时，用户可以把关键信息复制进问题里 ——
 * 这是有意的取舍，而不是遗漏。
 */
export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const e = env();

    const body = (await req.json()) as {
      parentTaskId?: unknown;
      question?: unknown;
    };

    const parentTaskId = typeof body.parentTaskId === 'string' ? body.parentTaskId : '';
    const question = typeof body.question === 'string' ? body.question.trim() : '';

    if (!parentTaskId) {
      return fail('VALIDATION_ERROR', '缺少 parentTaskId', 422, { parentTaskId: '缺少父任务' });
    }
    if (question.length < 2) {
      return fail('VALIDATION_ERROR', '请输入追问内容', 422, { question: '请输入追问内容' });
    }
    if (question.length > 2000) {
      return fail('VALIDATION_ERROR', '追问内容过长（上限 2000 字）', 422, {
        question: '追问内容过长',
      });
    }

    // 防越权：父任务必须属于当前用户
    const parent = await authzTask(userId, parentTaskId);

    if (parent.status !== 'succeeded' || !parent.outputContent) {
      return fail('NOT_READY', '父任务尚未生成结果，无法追问', 422);
    }

    // 与新建任务同样的并发保护：追问也会真实扣费
    const concurrency = await assertConcurrencyWithinLimit(
      userId,
      e.MAX_CONCURRENT_TASKS_PER_USER,
    );
    if (!concurrency.ok) {
      return fail('TOO_MANY_RUNNING', '你有任务正在处理中，请等待完成后再提问', 429);
    }

    const parentType = normalizeTaskType(parent.type) ?? 'summarize';
    const typeDef = TASK_TYPES[parentType];

    /**
     * 上下文拼接。
     *
     * 明确用「上一轮结果」而不是「原始输入」：用户追问的是结论
     * （「第二点能展开说说吗」），而不是原文。带原文反而会让模型
     * 重新摘要一遍，成本更高且答非所问。
     */
    const context = [
      '以下是你上一轮生成的结果，请基于它回答用户的新问题。',
      '',
      '<previous_result>',
      parent.outputContent,
      '</previous_result>',
      '',
      '<question>',
      question,
      '</question>',
    ].join('\n');

    // 追问沿用父任务的 Prompt 版本（保证同一任务的输出风格一致），
    // 但上下文与问题作为新的 inputContent
    const model = String((parent.params as Record<string, unknown>)?.model ?? e.DEFAULT_MODEL);

    const child = await prisma.task.create({
      data: {
        userId,
        type: parentType,
        title: `追问：${question.slice(0, 40)}${question.length > 40 ? '…' : ''}`,
        status: 'queued',
        inputType: 'text',
        inputContent: context,
        inputMeta: {
          charCount: question.length,
          tokenCount: estimateTokens(context),
          // 记录这是追问，以及追问谁 —— 历史列表里可以把它们归组显示
          parentTaskId,
          isFollowUp: true,
        } as never,
        templateId: parent.templateId,
        promptVersionId: parent.promptVersionId,
        parentTaskId,
        // 沿用父任务的参数（含 BYOK 凭证快照），但不带 idempotencyKey ——
        // 追问是多轮交互，同一个问题问两次就该跑两次（第二次可能因为
        // 上一轮结果变化而不同），不像「重复提交同一个任务」那样需要幂等
        params: { ...(parent.params as Record<string, unknown>), model } as never,
      },
    });

    /**
     * 追问的输入是「上一轮结果 + 新问题」，比原文短得多，
     * 且需要完整上下文才能答好 —— 所以强制走单次调用，不分块。
     * 这与翻译/润色同理（见 lib/tasks/types.ts 的 supportsChunking）。
     */
    const { after } = await import('next/server');
    after(async () => {
      try {
        await runSummarizePipeline({ taskId: child.id });
      } catch (err) {
        console.error(`[followup:${child.id}] 追问执行失败：`, err);
      }
    });

    // 顺带把类型信息带回去，前端订阅 SSE 时可用
    return ok({ taskId: child.id, parentTaskId, type: typeDef.type });
  } catch (e) {
    return handleError(e);
  }
}

/**
 * GET /api/followup?taskId=...
 *
 * 两种模式：
 *  - 默认：列出该任务的**直接**子任务（历史详情弹窗里的平铺列表用）
 *  - `?whole=1`：向上找到根任务，再返回**整条对话链**（独立页面用）
 *
 * ## 为什么要「向上找根」
 *
 * 追问页的入口可能来自链上任意一条（用户从历史里点开第三次追问，
 * 也应该看到完整的对话，而不是只剩后半段）。
 * 所以必须先沿 parentTaskId 一路向上到根，再从根开始展开。
 *
 * ## 为什么要限制向上层数
 *
 * parentTaskId 是普通字段，理论上可能存在环（手工改库、或将来某个 bug）。
 * 逐级向上时用一个硬上限兜底，避免死循环把请求挂死 ——
 * 这类防御在「链表结构」上永远值得加。
 */
const MAX_CHAIN_DEPTH = 50;

export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const taskId = url.searchParams.get('taskId');
    if (!taskId) return fail('VALIDATION_ERROR', '缺少 taskId', 422);

    const whole = url.searchParams.get('whole') === '1';

    const anchor = await authzTask(userId, taskId);

    if (!whole) {
      const children = await prisma.task.findMany({
        where: { userId, parentTaskId: taskId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          title: true,
          status: true,
          outputContent: true,
          degraded: true,
          createdAt: true,
          errorMessage: true,
        },
      });

      return ok({
        items: children.map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          // 列表里只需要预览，完整内容等点开再取
          preview: (c.outputContent ?? '').slice(0, 200),
          degraded: c.degraded,
          createdAt: c.createdAt.toISOString(),
          errorMessage: c.errorMessage,
        })),
      });
    }

    // ---- 向上找根 ----
    let rootId = anchor.id;
    let cursor = anchor.parentTaskId;
    // 变量名与下方「向下展开」的 depth 区分开，避免同名遮蔽导致阅读时的误解
    let upDepth = 0;

    while (cursor && upDepth < MAX_CHAIN_DEPTH) {
      // 每一级都要校验归属：链上任何一环如果是别人的任务，就停在这里
      // （不能因为它"是父任务"就跳过鉴权）
      const parent = await prisma.task.findFirst({
        where: { id: cursor, userId, deletedAt: null },
        select: { id: true, parentTaskId: true },
      });
      if (!parent) break;
      rootId = parent.id;
      cursor = parent.parentTaskId;
      upDepth += 1;
    }

    // ---- 从根开始，按创建时间展开整条链 ----
    /**
     * ⚠️ 必须**逐层展开**，不能只查 `parentTaskId: rootId` 这一层。
     *
     * 第一版就是只查了一层，结果是「追问的追问」直接消失 ——
     * 用户问了三轮却只看到两轮，而且不报错，属于静默丢数据。
     * 追问天然是多轮的，所以这里按 BFS 一层层往下走。
     *
     * 用逐层查询而不是「一次取用户全部任务再在内存里建树」：
     * 前者每次只取当前层，数据量可控；后者在活跃账号上可能拉回几千行。
     */
    const CHAIN_SELECT = {
      id: true,
      title: true,
      type: true,
      status: true,
      inputContent: true,
      outputContent: true,
      degraded: true,
      errorMessage: true,
      createdAt: true,
      parentTaskId: true,
      promptVersion: { select: { version: true } },
      template: { select: { name: true } },
    } as const;

    type ChainRow = Awaited<ReturnType<typeof prisma.task.findMany<{ select: typeof CHAIN_SELECT }>>>[number];

    const root = await prisma.task.findFirst({
      where: { id: rootId, userId, deletedAt: null },
      select: CHAIN_SELECT,
    });
    if (!root) notFoundChain();

    const chain: ChainRow[] = [root];
    const visited = new Set<string>([root.id]);

    let frontier: string[] = [root.id];
    let depth = 0;

    while (frontier.length > 0 && depth < MAX_CHAIN_DEPTH) {
      const children = await prisma.task.findMany({
        where: { userId, deletedAt: null, parentTaskId: { in: frontier } },
        orderBy: { createdAt: 'asc' },
        select: CHAIN_SELECT,
      });

      const next: string[] = [];
      for (const child of children) {
        // visited 兼作环保护：手工改库造出环时不会无限扩展
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        chain.push(child);
        next.push(child.id);
      }

      frontier = next;
      depth += 1;
    }

    // 按创建时间排序，保证是对话顺序（BFS 的加入顺序在跨层时不一定有序）
    chain.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    /**
     * 生成条目。
     *
     * 根任务的「问题」不是用户输入（它是原文），所以只取 outputContent；
     * 追问条目的问题从 inputContent 里抽 `<question>` 标签的内容 ——
     * 那里是当时真正被问的那句话，比 title（被截断过）更完整。
     */
    const items = chain.map((t, idx) => {
      const q = /<question>\n?([\s\S]*?)\n?<\/question>/.exec(t.inputContent ?? '');
      return {
        id: t.id,
        parentTaskId: t.parentTaskId,
        kind: idx === 0 ? ('root' as const) : ('followup' as const),
        question: q ? q[1]!.trim() : null,
        title: t.title,
        type: t.type,
        status: t.status,
        outputContent: t.outputContent,
        degraded: t.degraded,
        errorMessage: t.errorMessage,
        createdAt: t.createdAt.toISOString(),
        templateName: t.template.name,
        promptVersion: t.promptVersion.version,
      };
    });

    return ok({ rootId, items });
  } catch (e) {
    return handleError(e);
  }
}

/** 链的根查不到时统一按 404（不区分「不存在」与「非本人」） */
function notFoundChain(): never {
  throw new AuthzError();
}

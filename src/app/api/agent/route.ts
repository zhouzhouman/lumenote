import { z } from 'zod';
import { after } from 'next/server';
import { prisma } from '@/lib/db';
import { handleError, ok, fail } from '@/lib/api';
import { requireUserId } from '@/lib/auth/authz';
import { extractText } from '@/lib/pipeline/extract/text';
import { estimateTokens } from '@/lib/llm/mock';
import { env } from '@/lib/env';
import {
  idempotentTask,
  normalizeIdempotencyKey,
  assertConcurrencyWithinLimit,
  checkDailyQuota,
  isUniqueViolation,
} from '@/lib/idempotency';
import { rateLimitByUser } from '@/lib/rate-limit';
import { loadActiveCredential } from '@/lib/llm/credentials';
import { taskTypeDef } from '@/lib/tasks/types';
import { runAgentPipeline } from '@/lib/agent/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 创建 Agent（文档问答）任务。
 *
 * ## 为什么不复用 POST /api/tasks
 *
 * 两者的请求形状有实质差异，硬合并会让两边的校验都变脏：
 *
 *   - `/api/tasks` 的 `content` 是**要处理的文本**，参数是风格/语言这类修饰；
 *   - Agent 的 `content` 是**要分析的文档**，而 `question` 是任务的核心
 *     （没有它任务毫无意义），且必须走 Agent 循环而不是单次 Prompt 渲染。
 *
 * 但**横切关注点完全复用**：幂等、并发上限、每日配额、限流、
 * 凭证快照 —— 这些逻辑一处都不能少，任何一处漏掉都会变成成本或安全漏洞。
 * 所以这个路由的结构与 tasks/route.ts 刻意保持一致，差异只在
 * 「怎么建任务」与「跑哪个管线」两处。
 */

const CreateAgentSchema = z.object({
  /** 要分析的文档（或链接） */
  content: z.string().min(10, '内容至少 10 个字符'),
  /** 问的问题。这是 Agent 任务的核心输入 */
  question: z.string().min(2, '请输入要问的问题').max(2000, '问题过长（上限 2000 字）'),
  inputType: z.enum(['text', 'url']).default('text'),
  title: z.string().max(120).optional(),
  /** 最多检索轮数，字符串形式（与模板变量一致） */
  maxSteps: z.enum(['6', '12', '20']).default('12'),
  model: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const e = env();

    const rl = rateLimitByUser(userId, 'agent:create');
    if (!rl.ok) {
      return fail('RATE_LIMITED', `操作过于频繁，请 ${rl.retryAfterSec} 秒后重试`, 429);
    }

    const parsed = CreateAgentSchema.safeParse(await req.json());
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        if (!fields[key]) fields[key] = issue.message;
      }
      const first = parsed.error.issues[0];
      return fail('VALIDATION_ERROR', first?.message ?? '请求参数有误', 422, fields);
    }
    const body = parsed.data;

    // 链接模式下先在接口层拦下格式错误，避免白白跑一次抓取
    if (body.inputType === 'url' && !/^https?:\/\/\S+$/i.test(body.content.trim())) {
      return fail('VALIDATION_ERROR', '链接需以 http:// 或 https:// 开头，且不能包含空格', 422, {
        content: '链接格式不正确',
      });
    }

    const idempotencyKey = normalizeIdempotencyKey(req.headers.get('Idempotency-Key'));

    const { result: task, replayed } = await idempotentTask(
      userId,
      idempotencyKey,
      async () => createAgentTask(userId, idempotencyKey, body, e),
      async (key) => {
        const existing = await prisma.task.findFirst({ where: { userId, idempotencyKey: key } });
        return existing ?? null;
      },
    );

    if (replayed) {
      return ok({ taskId: task.id, status: task.status, replayed: true });
    }

    /**
     * after()：把 Agent 循环挂到响应之后。
     *
     * Agent 比摘要更需要这个 —— 它可能跑十几轮工具调用、几十秒。
     * 同步等待的话用户会盯着一个几十秒的请求，且中途断开全丢。
     */
    after(async () => {
      try {
        await runAgentPipeline({ taskId: task.id });
      } catch (err) {
        // runAgentPipeline 内部已把失败状态落库并计量
        console.error(`[agent:${task.id}] 执行失败：`, err);
      }
    });

    return ok({ taskId: task.id, status: task.status, replayed: false });
  } catch (e) {
    return handleError(e);
  }
}

async function createAgentTask(
  userId: string,
  idempotencyKey: string,
  body: z.infer<typeof CreateAgentSchema>,
  e: ReturnType<typeof env>,
) {
  // ---- 成本保护（与 /api/tasks 完全一致的三道）----
  const activeCredential = await loadActiveCredential(userId);

  const concurrency = await assertConcurrencyWithinLimit(userId, e.MAX_CONCURRENT_TASKS_PER_USER);
  if (!concurrency.ok) {
    throw Object.assign(new Error('你有任务正在处理中，请等待完成后再提交'), {
      name: 'LLMError',
      code: 'TOO_MANY_RUNNING',
      retryable: true,
      statusCode: 429,
    });
  }

  if (!activeCredential) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { dailyQuota: true },
    });
    const quotaLimit = user?.dailyQuota ?? e.FREE_DAILY_QUOTA;
    const quota = await checkDailyQuota(userId, quotaLimit);
    if (!quota.ok) {
      throw Object.assign(
        new Error(
          `今日免费额度已用完（${quota.used}/${quotaLimit}）。` +
            '你可以到「模型设置」填入自己的 API Key，用你自己的额度继续生成。',
        ),
        { name: 'LLMError', code: 'QUOTA_EXCEEDED', retryable: false, statusCode: 429 },
      );
    }
  }

  // ---- 抽取正文 ----
  const extracted = await extractText({ type: body.inputType, content: body.content });

  // ---- 模板（文件问答 Agent）----
  const def = taskTypeDef('agent');
  const template = await prisma.promptTemplate.findFirst({
    where: { slug: def.slug, isActive: true },
    include: {
      versions: { where: { status: 'active' }, orderBy: { version: 'desc' }, take: 1 },
    },
  });
  if (!template || template.versions.length === 0) {
    throw Object.assign(
      new Error(`Prompt 模板「${def.templateName}」未初始化，请先执行 pnpm prisma:seed`),
      { name: 'LLMError', code: 'TEMPLATE_MISSING', retryable: false, statusCode: 500 },
    );
  }

  const version = template.versions[0]!;

  const model = activeCredential
    ? activeCredential.model
    : e.MOCK_LLM || process.env.NODE_ENV !== 'production'
      ? (body.model ?? e.DEFAULT_MODEL)
      : e.DEFAULT_MODEL;

  /**
   * 标题用问题而不是文档标题。
   *
   * 历史列表里「这份文档问了什么」比「文档叫什么」更有辨识度 ——
   * 同一份文档往往会被问好几个不同的问题，全叫同一个名字就分不清了。
   */
  const title = body.title?.trim() || body.question.slice(0, 60);

  try {
    return await prisma.task.create({
      data: {
        userId,
        type: 'agent',
        title,
        status: 'queued',
        inputType: body.inputType,
        inputRef: body.inputType === 'url' ? body.content.trim() : null,
        inputContent: extracted.content,
        inputMeta: {
          charCount: extracted.meta.charCount,
          tokenCount: estimateTokens(extracted.content),
          sourceHost: extracted.meta.sourceHost ?? null,
          extractedTitle: extracted.meta.title ?? null,
          truncated: extracted.meta.truncated ?? false,
          credentialId: activeCredential?.id ?? null,
          credentialLabel: activeCredential?.label ?? null,
          /** 问题记在 meta 里便于列表展示；同时也进 params 供 runner 读取 */
          question: body.question,
        } as never,
        templateId: template.id,
        promptVersionId: version.id,
        idempotencyKey,
        params: {
          question: body.question,
          maxSteps: body.maxSteps,
          model,
          ...(activeCredential ? { credentialId: activeCredential.id } : {}),
        } as never,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await prisma.task.findFirst({ where: { userId, idempotencyKey } });
      if (existing) return existing;
    }
    throw err;
  }
}

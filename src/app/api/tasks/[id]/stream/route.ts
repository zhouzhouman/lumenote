import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { authzTask } from '@/lib/auth/authz';
import { runSummarizePipeline } from '@/lib/pipeline/runner';
import { runAgentPipeline } from '@/lib/agent/runner';
import { createSseResponse, parseResumeToken, type SseEmitter } from '@/lib/sse';
import { LLMError } from '@/lib/llm/types';
import { env } from '@/lib/env';
import { cacheHitRate, usdToCny } from '@/lib/llm/pricing';

/**
 * ★★★ 两段式流式的第二段：SSE 订阅 ★★★
 *
 * 三个必须这么做的理由：
 *
 * 1. **规避 Serverless 时长上限**
 *    POST 只负责建任务（< 200ms 返回），本连接只负责订阅输出。
 *    单次连接的生命周期是「输出完成即关」，通常几秒到几十秒。
 *
 * 2. **断线可重连**
 *    客户端断开（切页、弱网、用户主动停止）后，带着 taskId 重新连上即可：
 *      - 任务已完成 → 立即回放已落库的完整内容
 *      - 任务还在跑 → 从头订阅当前输出
 *    因为内容持久化在数据库，服务重启也能续传。
 *
 * 3. **支持「先建后看」**
 *    用户刷新页面后，从历史列表点进来同样能通过本接口看到结果，
 *    不需要「任务必须由这个页面发起」的限制。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单次订阅的硬上限。超时后主动关闭，让客户端重连（比无限挂起更可控） */
const MAX_STREAM_MS = 10 * 60_000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  /**
   * 断线续传的起点：客户端已收到的字符数。
   *
   * ⚠️ 这个头必须真的被使用。之前 parseResumeToken() 写好了、导出了，
   * 却**没有任何调用点** —— 服务端每次都从头重放全文，客户端又把重放的增量
   * 追加到自己已有的 accumulated 上，断线一次内容就翻一倍。
   * 「看起来实现了、实际是死代码」的续传协议比不实现更糟：
   * 它让客户端放心地假设去重已经做好了。
   */
  const resumeFrom = parseResumeToken(req.headers.get('last-event-id'));

  // SSE 响应不能返回 JSON 错误，否则客户端的 EventSource 会收到 200 + HTML
  // 而静默失败。所以这里统一用 SSE 的 error 事件表达错误。
  return createSseResponse(async (emitter) => {
    try {
      // ⚠️ 防越权：必须校验任务属于当前用户。
      // 这是 SSE 接口最容易被忽略的一步 —— 路由是 /api/tasks/[id]/stream，
      // 只要猜到别人的 id 就能订阅别人的内容。
      const userId = await currentUserIdOrThrow();
      const task = await authzTask(userId, id);

      emitter.meta({
        taskId: task.id,
        model: String((task.params as Record<string, unknown>)?.model ?? env().DEFAULT_MODEL),
        promptVersion: `${task.template.slug}#v${task.promptVersion.version}`,
        templateName: task.template.name,
      });

      /**
       * ⚠️ Agent 轨迹的补发必须放在最前面（在任何 return 分支之前）。
       *
       * 第一版把它放在「分支三：进行中」里，于是**已完成的任务永远收不到 step 事件** ——
       * 因为分支一会先 return。而"刷新一个已完成的 Agent 任务、想看它当时
       * 检索了什么"恰恰是最常见的场景：用户过几天回来复盘推理路径。
       *
       * 这个 bug 是被端到端验收抓到的（断言「收到了 step 事件」失败），
       * 单测覆盖不到 —— 它涉及路由内部分支的先后顺序。
       */
      if (task.type === 'agent') {
        await emitExistingSteps(emitter, task.id);
      }

      // ---- 分支一：已完成 → 直接回放 ----
      if (task.status === 'succeeded' && task.outputContent) {
        // 整段推送而非逐 token：回放已落库内容时逐 token 发送没有意义，
        // 而且能大幅缩短连接时间（对 Serverless 更友好）。
        // 仍按 resumeFrom 裁剪，否则重连的客户端会把全文再收一遍。
        if (task.outputContent.length > resumeFrom) {
          emitter.token(task.outputContent.slice(resumeFrom));
        }
        await emitUsage(emitter, task.id);
        emitter.done({ status: 'succeeded', degraded: task.degraded });
        return;
      }

      // ---- 分支二：失败 → 报告 ----
      if (task.status === 'failed') {
        emitter.error({
          code: task.errorCode ?? 'FAILED',
          message: task.errorMessage ?? '任务执行失败',
          retryable: false,
        });
        emitter.done({ status: 'failed', degraded: false });
        return;
      }

      // ---- 分支三：进行中 → 订阅 ----
      // 已有输出先补发（可能来自上一次断线前已生成的部分），只发客户端还缺的那段
      const already = task.outputContent ?? '';
      if (already.length > resumeFrom) {
        emitter.token(already.slice(resumeFrom));
      }

      if (task.status === 'queued' && env().MOCK_LLM) {
        // Mock 模式下 after() 可能已被 Serverless 回收，
        // 这里提供兜底：若任务还停在 queued，就地执行。
        // 真实模式下不能这么做（会导致重复调用与重复计费）。
        //
        // ⚠️ 用 updateMany 原子「抢占」任务，而不是直接跑：
        // POST 的 after() 与这里可能几乎同时启动管线，两边都会跑一遍模型。
        // UsageLog.taskId 唯一约束能保证只结算一次，但**流出去的内容可能来自另一次调用**，
        // 于是用户看到的与库里存的不一致。原子抢占从根上避免这种分叉。
        const claimed = await prisma.task.updateMany({
          where: { id: task.id, status: 'queued' },
          data: { status: 'running' },
        });
        if (claimed.count === 1) {
          await runPipelineInline(task.id, emitter, task.type);
          return;
        }
        // 抢占失败说明另一端已经在跑了，往下走轮询分支即可
      }

      /**
       * 进行中任务的轮询下限：已经推送过哪些步骤。
       *
       * 上面的 emitExistingSteps 已经把已落库的步骤全发了，
       * 所以这里从「当前最大 seq」开始，避免轮询时重复推送同一批步骤。
       * 用 let 因为轮询过程中会不断推进。
       */
      let lastStepSeq = task.type === 'agent' ? await maxStepSeq(task.id) : 0;

      // 轮询等待完成。
      // 为什么是轮询而不是直接订阅内存中的流？
      // 因为输出发生在**另一个请求**（POST 的 after()）里，
      // 两者之间没有共享内存 —— Serverless 下甚至可能不在同一实例。
      // 轮询数据库是唯一在分布式下正确的做法。
      const deadline = Date.now() + MAX_STREAM_MS;
      /**
       * 已推送到客户端的输出长度。
       *
       * 用 `let` 而**不是** `const` + 另一个变量：轮询过程中它必须被推进，
       * 否则下一轮会把同一段内容再推一次（用户看到内容重复）。
       */
      let lastLength = Math.max(resumeFrom, already.length);

      while (Date.now() < deadline) {
        /**
         * 客户端已经断开就立刻退出。
         *
         * 不检查的话，用户关掉标签页后这个请求还会以每 300ms 一次的频率
         * 查数据库，最长持续 10 分钟（约 2000 次查询），
         * 在 Serverless 上这段时间是按执行时长**计费**的 ——
         * 被放弃的连接变成纯粹的浪费，而且定时器还会一直挂着。
         */
        if (req.signal.aborted) return;

        await sleep(300);

        const latest = await prisma.task.findUnique({
          where: { id: task.id },
          select: { status: true, outputContent: true, errorCode: true, errorMessage: true, degraded: true },
        });

        if (!latest) break;

        /**
         * Agent 任务：把新落库的步骤推给客户端。
         *
         * 放在 token 推送之前 —— 步骤是"过程"，正文是"结果"，
         * 顺序上过程先发生。前端按 seq 渲染时间线，顺序对了体验才对。
         */
        if (task.type === 'agent') {
          lastStepSeq = await emitNewSteps(emitter, task.id, lastStepSeq);
        }

        // 只推送新增部分，避免重复推送已有内容
        if (latest.outputContent && latest.outputContent.length > lastLength) {
          emitter.token(latest.outputContent.slice(lastLength));
          lastLength = latest.outputContent.length;
        }

        if (latest.status === 'succeeded') {
          await emitUsage(emitter, task.id);
          emitter.done({ status: 'succeeded', degraded: latest.degraded });
          return;
        }

        if (latest.status === 'failed') {
          await emitUsage(emitter, task.id); // 失败也要发 usage（成本诚实）
          emitter.error({
            code: latest.errorCode ?? 'FAILED',
            message: latest.errorMessage ?? '任务执行失败',
            retryable: false,
          });
          emitter.done({ status: 'failed', degraded: false });
          return;
        }

        if (latest.status === 'canceled') {
          emitter.done({ status: 'canceled', degraded: false });
          return;
        }
      }

      // 超时：告知客户端可重新连接（任务可能仍在服务端继续执行）
      emitter.error({
        code: 'STREAM_TIMEOUT',
        message: '等待超时，可重新连接查看进度',
        retryable: true,
      });
      emitter.done({ status: 'running', degraded: false });
    } catch (e) {
      const err = e instanceof LLMError ? e : new LLMError(String(e), 'INTERNAL', false);
      // 鉴权/越权错误不该把内部细节告诉客户端
      const message =
        err.code === 'NOT_FOUND' || err.code === 'UNAUTHENTICATED'
          ? err.code === 'NOT_FOUND'
            ? '任务不存在'
            : '请先登录'
          : '订阅失败，请重试';

      emitter.error({ code: err.code, message, retryable: false });
      emitter.done({ status: 'failed', degraded: false });
    }
  }, { heartbeatMs: 15_000 });
}

/** Mock 模式的兜底执行。注意任务状态已由调用方原子抢占为 running */
async function runPipelineInline(taskId: string, emitter: SseEmitter, taskType: string) {
  try {
    /**
     * ⚠️ 必须按任务类型选管线。
     *
     * Agent 任务的 inputContent 是**文档正文**，而 params.question 才是问题。
     * 如果把 Agent 任务交给摘要管线，它会「总结这份文档」并把 question 忽略掉 ——
     * 用户看到一份看起来正常、实际答非所问的结果。这类"静默走错管线"
     * 比直接报错糟糕得多，所以这里显式分支。
     */
    if (taskType === 'agent') {
      await runAgentPipeline({
        taskId,
        onStep: (step) => {
          emitter.step({
            seq: step.seq,
            phase: step.phase,
            note: step.note ?? '',
            tools: step.toolResults.map((r) => ({ name: r.name, display: r.display, ok: r.ok })),
            cumulativeTokens: step.cumulativeTokens,
            latencyMs: step.latencyMs,
          });
        },
      });
    } else {
      await runSummarizePipeline({
        taskId,
        onDelta: (delta) => emitter.token(delta),
      });
    }
    await emitUsage(emitter, taskId);
    emitter.done({ status: 'succeeded', degraded: false });
  } catch (e) {
    const err = e instanceof LLMError ? e : new LLMError(String(e), 'INTERNAL', false);
    emitter.error({ code: err.code, message: err.message, retryable: false });
    emitter.done({ status: 'failed', degraded: false });
  }
}

// ============================================================
// Agent 步骤推送
// ============================================================

/** 取某任务已落库的最大步骤号（用于重连时跳过已推送的部分） */
async function maxStepSeq(taskId: string): Promise<number> {
  const last = await prisma.agentStep.findFirst({
    where: { taskId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  return last?.seq ?? 0;
}

/** 订阅接上时补发已落库的步骤（刷新/重连场景，避免时间线从中间开始） */
async function emitExistingSteps(emitter: SseEmitter, taskId: string): Promise<void> {
  const steps = await prisma.agentStep.findMany({
    where: { taskId },
    orderBy: { seq: 'asc' },
    select: {
      seq: true,
      phase: true,
      note: true,
      toolResults: true,
      cumulativeTokens: true,
      latencyMs: true,
    },
  });
  for (const s of steps) {
    emitter.step({
      seq: s.seq,
      phase: s.phase,
      note: s.note ?? '',
      tools: toStepTools(s.toolResults),
      cumulativeTokens: s.cumulativeTokens,
      latencyMs: s.latencyMs,
    });
  }
}

/** 推送 seq 大于 afterSeq 的新步骤，返回新的最大 seq */
async function emitNewSteps(
  emitter: SseEmitter,
  taskId: string,
  afterSeq: number,
): Promise<number> {
  const steps = await prisma.agentStep.findMany({
    where: { taskId, seq: { gt: afterSeq } },
    orderBy: { seq: 'asc' },
    select: {
      seq: true,
      phase: true,
      note: true,
      toolResults: true,
      cumulativeTokens: true,
      latencyMs: true,
    },
  });

  let max = afterSeq;
  for (const s of steps) {
    emitter.step({
      seq: s.seq,
      phase: s.phase,
      note: s.note ?? '',
      tools: toStepTools(s.toolResults),
      cumulativeTokens: s.cumulativeTokens,
      latencyMs: s.latencyMs,
    });
    max = Math.max(max, s.seq);
  }
  return max;
}

/** 把落库的 toolResults（Json 列）收窄成事件载荷要的形状 */
function toStepTools(raw: unknown): { name: string; display: string; ok: boolean }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      const o = r as { name?: unknown; display?: unknown; ok?: unknown };
      return {
        name: typeof o.name === 'string' ? o.name : '',
        display: typeof o.display === 'string' ? o.display : '',
        ok: o.ok === true,
      };
    })
    .filter((t) => t.name !== '');
}

/** 下发本次任务的真实用量 */
async function emitUsage(emitter: SseEmitter, taskId: string) {
  const usage = await prisma.usageLog.findUnique({
    where: { taskId },
    select: {
      promptTokens: true,
      completionTokens: true,
      cachedTokens: true,
      estimatedCost: true,
      peakPricing: true,
    },
  });

  // 没有用量记录（可能 Mock 或异常）时也要发 usage 事件，
  // 否则前端会一直等待这个事件
  if (!usage) {
    emitter.usage({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costCny: 0,
      cacheHitRate: 0,
      peak: false,
    });
    return;
  }

  emitter.usage({
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens,
    // 与任务详情/仪表盘共用同一个换算函数，避免又多出一处硬编码汇率
    costCny: Number(usdToCny(usage.estimatedCost).toFixed(6)),
    cacheHitRate: cacheHitRate(usage.promptTokens, usage.cachedTokens),
    peak: usage.peakPricing,
  });
}

async function currentUserIdOrThrow(): Promise<string> {
  const { currentUserId } = await import('@/lib/auth/authz');
  const userId = await currentUserId();
  if (!userId) throw new LLMError('请先登录', 'UNAUTHENTICATED', false, 401);
  return userId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
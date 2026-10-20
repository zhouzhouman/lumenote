import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { LLMError } from '@/lib/llm/types';
import { recordUsage } from '@/lib/llm/metering';
import { chunkText } from '@/lib/pipeline/chunk';
import { resolveUserProvider } from '@/lib/pipeline/runner';
import { buildFallbackChain } from '@/lib/llm/registry';
import { loadGlossary } from '@/lib/tasks/glossary';
import { runAgent, type AgentStepRecord, type AgentRunResult } from '@/lib/agent/loop';
import { extractDisplayText } from '@/lib/agent/loop';
import { touchCredential } from '@/lib/llm/credentials';

/**
 * Agent 任务的执行入口。
 *
 * ## 与 `runSummarizePipeline` 的关系
 *
 * 两者**刻意分开**，而不是在现有 runner 里加分支：
 *
 *   - 摘要类管线是「输入 → 一次或多次模型调用 → 一段文本」，
 *     它的复杂度在分块与合并策略上。
 *   - Agent 是「输入 → 多轮工具调用 → 结论 + 轨迹」，
 *     它的复杂度在循环控制、预算与轨迹持久化上。
 *
 * 硬塞进一个函数的结果是两边的最坏情况都要考虑（比如"分块 + 工具调用"
 * 这种组合没有任何意义，却要写代码处理）。分开之后每个 runner 都更短、更清楚。
 *
 * 复用的部分是真正的横切关注点：凭证解析、计量、chunkText、glossary。
 */

/** 每步执行完的回调（SSE 推送用） */
export type AgentStepListener = (step: AgentStepRecord) => void;

export interface RunAgentPipelineOptions {
  taskId: string;
  onStep?: AgentStepListener;
  signal?: AbortSignal;
}

/** Agent 任务的最终状态，决定落库的 Task.status */
type AgentOutcome = {
  status: string;
  output: string;
  degraded: boolean;
  errorCode?: string;
  errorMessage?: string;
};

export async function runAgentPipeline(options: RunAgentPipelineOptions): Promise<AgentRunResult> {
  const { taskId, onStep, signal } = options;
  const e = env();
  const startedAt = Date.now();

  const task = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    include: { template: true, promptVersion: true },
  });

  const content = task.inputContent ?? '';
  if (!content.trim()) {
    await markFailed(taskId, 'INPUT_EMPTY', '输入内容为空');
    throw new LLMError('输入内容为空', 'BAD_REQUEST', false);
  }

  const params = (task.params ?? {}) as Record<string, unknown>;
  const question = typeof params.question === 'string' ? params.question.trim() : '';
  if (!question) {
    await markFailed(taskId, 'QUESTION_MISSING', '缺少要提问的问题');
    throw new LLMError('缺少要提问的问题', 'BAD_REQUEST', false);
  }

  await prisma.task.update({ where: { id: taskId }, data: { status: 'running' } });

  // ---- 凭证：与摘要管线同一套逻辑（用户自己的 key 优先）----
  const userProvider = await resolveUserProvider(task.userId, params);

  /**
   * 解析出实际使用的 provider 与模型。
   *
   * 用 `buildFallbackChain` 而不是直接 new DeepSeekProvider：这样站点凭证的
   * 降级链、以及 MOCK_LLM 开关都一样生效。
   *
   * ⚠️ 但 Agent **只取链上的第一项**，不做跨 provider 重试。
   * 理由：Agent 是多轮的，每一轮的失败由循环自己决定是重试还是收敛
   * （见 loop.ts）。在循环外面套一层"换个 provider 重跑整个任务"
   * 会导致已经花掉的工具调用与 token 被重复消耗。
   * 循环内部对**单次**模型调用失败的处理是明确的（回到 plan 再试或收敛），
   * 那已经足够。
   */
  const chain = buildFallbackChain(userProvider);
  if (chain.length === 0) {
    const message = '没有可用的模型通道，请检查服务端配置或到「模型设置」填写自己的 API Key';
    await markFailed(taskId, 'NO_PROVIDER', message);
    throw new LLMError(message, 'UNAUTHORIZED', false);
  }

  const primary = chain[0]!;
  const model = userProvider?.model ?? e.DEFAULT_MODEL;

  // ---- 文档分块与工具上下文 ----
  const chunks = chunkText(content, {
    maxTokens: e.CHUNK_SIZE_TOKENS,
    overlapTokens: e.CHUNK_OVERLAP_TOKENS,
  });

  const glossary = await loadGlossary(task.userId);

  const maxSteps = parseMaxSteps(params.maxSteps, e.AGENT_MAX_STEPS);

  /**
   * 轨迹落库。
   *
   * ⚠️ 用 createMany + skipDuplicates，而不是逐条 create。
   *
   * 原因：`AgentStep` 上有 `@@unique([taskId, seq])`。如果任务因为
   * 重试或 after() 重复触发而跑了第二遍，逐条 create 会在第二条
   * 抛唯一约束错误并中断整个管线 —— 而正确行为是**忽略重复的那一遍**。
   * skipDuplicates 让"唯一约束保护"与"不中断执行"同时成立。
   *
   * 同时用 inset 去重：同一批里 seq 不能重复，否则 createMany 自身会报错。
   */
  const persistedSeqs = new Set<number>();

  /**
   * 未完成的落库操作。
   *
   * ⚠️ 这个集合解决一个真实的时序问题：`onStep` 里用 `void persistStep(...)`
   * 是为了不拖慢循环（每步都 await 一次写库会让 12 步任务多出几百毫秒），
   * 但收尾时**必须等它们都完成**。否则会出现「任务已 completed，
   * 但轨迹缺了最后两步」—— 而轨迹缺失比任务慢几十毫秒糟糕得多。
   *
   * 第一版我用 `setTimeout(0)` 来"等一等"，那是错的：它只是让出一个微任务轮次，
   * 并不保证已发出的数据库写入全部结算。必须显式追踪 promise。
   */
  const pendingWrites = new Set<Promise<void>>();

  function persistStep(step: AgentStepRecord): Promise<void> {
    if (persistedSeqs.has(step.seq)) return Promise.resolve();
    persistedSeqs.add(step.seq);

    const write = (async () => {
      try {
        await prisma.agentStep.create({
          data: {
            taskId,
            seq: step.seq,
            phase: step.phase,
            text: step.text || null,
            reasoning: step.reasoning || null,
            toolCalls: step.toolCalls.length > 0 ? (step.toolCalls as never) : undefined,
            toolResults: step.toolResults.length > 0 ? (step.toolResults as never) : undefined,
            inputTokens: step.inputTokens,
            outputTokens: step.outputTokens,
            cumulativeTokens: step.cumulativeTokens,
            latencyMs: step.latencyMs,
            note: step.note ?? null,
          },
        });
      } catch (err) {
        /**
         * 轨迹写入失败**不能中断任务**。
         *
         * 轨迹是审计用的（重要，但不是任务产物本身）。为了记日志而让用户
         * 拿不到结论，是把优先级搞反了。所以这里只记录错误，继续跑。
         * 唯一约束冲突（重跑场景）也会走到这里 —— 那正是约束该起的作用，
         * 忽略重复的那一遍而不是让整个任务失败。
         */
        console.error(`[agent:${taskId}] 步骤 ${step.seq} 落库失败（不中断任务）：`, err);
      }

      /**
       * SSE 推送在落库之后：保证客户端看到的步骤都已经持久化。
       * 否则用户刷新页面会发现"刚看到的那一步不见了"。
       */
      onStep?.(step);
    })();

    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
    return write;
  }

  let result: AgentRunResult;
  try {
    result = await runAgent({
      provider: primary.provider,
      model,
      question,
      chunks,
      toolContext: {
        glossary,
        /**
         * `diff_with_task` 的数据来源。
         *
         * ⚠️ 必须带 userId 过滤 —— 否则用户能让 Agent 去读别人的任务输出，
         * 而输出内容会进模型上下文、最终反映在回答里。这是越权读。
         */
        loadTaskOutput: async (otherTaskId: string) => {
          const other = await prisma.task.findFirst({
            where: { id: otherTaskId, userId: task.userId, deletedAt: null },
            select: { title: true, outputContent: true },
          });
          if (!other?.outputContent) return null;
          return { title: other.title, output: other.outputContent };
        },
      },
      budget: { maxSteps, maxTokens: e.AGENT_MAX_TOKENS },
      // Agent 走 thinking 关闭：文档问答重检索而非多步推理，
      // 且可避开 reasoning 回传要求（ADR-0004）
      thinking: 'disabled',
      temperature: 0.2,
      maxTokens: 4000,
      signal,
      onStep: (step) => {
        // 刻意不 await：每步都等待一次写库会让 12 步任务多出几百毫秒。
        // promise 被记入 pendingWrites，收尾时统一等待（见 flushSteps）
        void persistStep(step);
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    await markFailed(taskId, 'AGENT_ERROR', message);
    throw err;
  }

  /**
   * ⚠️ 保证所有步骤都已落库再收尾。
   *
   * `onStep` 里用的是 `void persistStep(...)`（不 await，避免拖慢循环），
   * 所以到这里可能有若干条写库操作还在飞。直接往下走会出现
   * 「任务已 completed，但轨迹缺了最后两步」——而轨迹缺失比任务慢几十毫秒糟糕得多。
   */
  await flushSteps();

  // ---- 计量：一次聚合（多轮调用合并成一条 UsageLog）----
  const billing = await recordUsage({
    userId: task.userId,
    taskId,
    provider: primary.provider.name,
    model,
    usage: result.usage,
    success: result.status !== 'failed',
    latencyMs: Date.now() - startedAt,
    errorCode: result.status === 'failed' ? 'AGENT_FAILED' : undefined,
    meta: {
      phase: 'agent',
      stopReason: result.stopReason,
      steps: result.steps.length,
      // 工具使用情况进计量 meta：排查「为什么这次贵」时能直接看到
      usedTools: [
        ...new Set(result.steps.flatMap((s) => s.toolCalls.map((c) => c.name))),
      ],
    },
  });

  // ---- 落库最终产物 ----
  const outcome = decideOutcome(result);
  const displayText = extractDisplayText(result.text, result.structured);

  await prisma.task.update({
    where: { id: taskId },
    data: {
      status: outcome.status,
      outputContent: displayText || result.text,
      outputMeta: {
        taskType: 'agent',
        // 结构化结论单独存：前端要渲染成「结论卡片 + 证据引用」，
        // 与 displayText（散文）职责不同
        structured: result.structured,
        stopReason: result.stopReason,
        stepCount: result.steps.length,
        usedTools: [...new Set(result.steps.flatMap((s) => s.toolCalls.map((c) => c.name)))],
        finalChunkCount: result.finalChunks.length,
        costCny: billing.costCny,
        cacheHitRate: billing.cacheHitRate,
        peak: billing.peak,
      } as never,
      degraded: outcome.degraded,
      errorCode: outcome.errorCode ?? null,
      errorMessage: outcome.errorMessage ?? null,
      latencyMs: Date.now() - startedAt,
      completedAt: new Date(),
    },
  });

  if (userProvider) {
    await touchCredential(userProvider.credentialId, {
      ok: result.status !== 'failed',
      // touchCredential 只接受错误码而不是自由文本 —— 它要写进一个短字段供设置页显示
      ...(result.status === 'failed' ? { errorCode: 'AGENT_FAILED' } : {}),
    }).catch(() => undefined);
  }

  return result;

  /**
   * 等所有 in-flight 的步骤落库完成。
   *
   * ⚠️ 不能用 `setTimeout(0)` 代替：那只是让出一个微任务轮次，
   * 并不保证已经发出的数据库写入全部结算。必须显式追踪 promise。
   * 这个区别的表现是「轨迹偶尔缺最后一步」——偶发、难复现，
   * 但会让轨迹回放不可信。
   */
  async function flushSteps(): Promise<void> {
    while (pendingWrites.size > 0) {
      await Promise.allSettled([...pendingWrites]);
    }
  }
}

/**
 * 把 Agent 的运行结果映射到 Task.status。
 *
 * 三种情形的区别对用户是有意义的，不能都写成 succeeded：
 *  - **succeeded**：模型正常给出结论
 *  - **succeeded + degraded**：我们主动收敛（步数/token/重复），拿到了部分成果。
 *    标 degraded 是诚实做法 —— 用户该知道这份答案是不完整的
 *  - **failed**：连一次模型调用都没完成
 */
function decideOutcome(result: AgentRunResult): AgentOutcome {
  if (result.status === 'failed') {
    return {
      status: 'failed',
      output: '',
      degraded: false,
      errorCode: 'AGENT_FAILED',
      errorMessage: result.error ?? 'Agent 执行失败',
    };
  }

  const partial = result.status === 'gave_up';
  return {
    status: 'succeeded',
    output: result.text,
    degraded: partial,
    ...(partial ? { errorCode: null as never } : {}),
  };
}

/** 解析用户选的步数上限（来自 params，是字符串） */
export function parseMaxSteps(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  // 上限做个硬夹：即使数据库里被改成 10000，也不能让一次任务跑一万轮
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), 30);
}

/** 标记任务失败（不抛出） */
async function markFailed(taskId: string, code: string, message: string): Promise<void> {
  await prisma.task
    .update({
      where: { id: taskId },
      data: {
        status: 'failed',
        errorCode: code,
        errorMessage: message,
        completedAt: new Date(),
      },
    })
    .catch(() => undefined);
}

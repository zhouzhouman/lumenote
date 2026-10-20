import { env } from '@/lib/env';
import { recordUsage } from '@/lib/llm/metering';
import { LLMError } from '@/lib/llm/types';
import { touchCredential } from '@/lib/llm/credentials';
import { mapWithConcurrency } from './chunk';
import { planMapBudget } from '@/lib/llm/budget';
import { prepareSummarizeTask } from './lifecycle';
import { addUsage, runMapChunk, runReduce, toResult } from './map-reduce';
import { cancelTask, failTask, persistResult } from './persistence';
import type { PipelineResult, RunPipelineOptions } from './types';
import type { PromptContext } from './context';

/**
 * Map-Reduce 摘要管线的**编排入口**。
 *
 * ## 为什么需要 Map-Reduce
 *
 * 模型有输出上限。20 页PDF 直接塞进去，模型只能：
 *  - 拒绝处理，或
 *  - 输出一个被截断的摘要（用户看到半句话突然结束）
 *
 * 所以必须先分块、逐块摘要，再把多个摘要合成一个。
 *
 * ## 成本结构（这是设计的核心约束）
 *
 * DeepSeek 输出价是输入 miss 价的 4 倍，所以：
 *   - Map 阶段：输入 = 全部正文，输出 = N 份短摘要
 *   - Reduce 阶段：输入 = N 份短摘要（**这部分能命中缓存**），
 *     输出 = 一份最终摘要
 *
 * 关键优化：Reduce 阶段的输入是 Map 的输出，如果多个分块用**完全相同的
 * system prompt + 同样的 instructions**，那么 Reduce 的输入虽然内容不同，
 * 但只要开头一致就能部分命中缓存。更进一步的做法是把 Reduce 的
 * system prompt 写成与 Map 完全相同的开头 —— 这个技巧在 pricing.ts 的
 * 缓存机制下有实际收益。
 *
 * ## 流式的实现难点
 *
 * Map 阶段有多个并发分块，如果把它们的 token 直接推给前端会交错混乱。
 * 解决方案：**Map 阶段不流式给用户**（它们很快，每块几百 token），
 * 只有最终的 Reduce 阶段流式推送。这样用户看到的是一段连贯的摘要，
 * 而不是三段交错的文字。代价是 TTFT 会略微变长。
 *
 * 这是个明确的取舍：牺牲一点首字延迟，换取输出的可读性。
 *
 * ## 拆分后的边界（本文件只保留编排）
 *
 *   lifecycle.ts   加载/校验/置 running/凭证与分块准备
 *   context.ts     prompt 上下文与凭证解析、system prompt 渲染
 *   map-reduce.ts  Map / Reduce 单次调用（不流式 vs 流式、BYOK、降级）
 *   persistence.ts 成功/失败/取消的落库与脱敏
 *   runner.ts      ← 只负责「先单块短路，否则并发 Map → Reduce → 收尾」
 */

/**
 * 单次调用的执行 + 计量 + 落库。
 *
 * 抽出来是因为「单块短路」这条路径现在有三种触发情形：
 *  1. 摘要且内容短到只有一块
 *  2. 翻译（刻意不分块）
 *  3. 润色（刻意不分块）
 *
 * 三者的差异只在**怎么调模型**（temperature / maxTokens），
 * 而计量、落库、凭证状态更新的代码完全相同。之前这段被复制了两份 ——
 * 复制出来的第二份就是将来最容易漏改的那一份。
 */
async function runSinglePass(args: {
  taskId: string;
  task: { id: string; userId: string; type: string };
  ctx: PromptContext;
  input: string;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  startedAt: number;
  meta: Record<string, unknown>;
}): Promise<PipelineResult> {
  const { taskId, task, ctx, input, onDelta, signal, startedAt, meta } = args;

  const single = await runReduce({
    taskId,
    ctx,
    input,
    onDelta,
    signal,
    pointCount: 0,
    maxOutputTokens: ctx.maxOutputTokens,
    temperature: ctx.temperature,
  });

  const billing = await recordUsage({
    userId: task.userId,
    taskId,
    provider: single.usage.provider,
    model: single.usage.model,
    usage: single.usage.usage,
    success: !single.degraded,
    ttftMs: single.ttftMs,
    latencyMs: Date.now() - startedAt,
    errorCode: single.degraded ? 'DEGRADED' : undefined,
    meta: { phase: 'single', taskType: task.type, attempts: single.attempts, ...meta },
  });

  await persistResult({
    taskId,
    output: single.text,
    degraded: single.degraded,
    usage: { ...single.usage, ...billing },
    ttftMs: single.ttftMs,
    latencyMs: Date.now() - startedAt,
    extraMeta: {
      chunks: 1,
      taskType: task.type,
      degradedReason: single.degradedReason,
      attempts: single.attempts,
      costCny: billing.costCny,
      ...meta,
    },
  });

  // 成功路径记录凭证使用情况（设置页要显示「最近使用 / 最近失败」）
  if (ctx.userProvider) {
    await touchCredential(ctx.userProvider.credentialId, {
      ok: !single.degraded,
      errorCode: single.degraded ? 'DEGRADED' : undefined,
    });
  }

  return toResult(
    single.text,
    single.degraded,
    single.degradedReason,
    single.attempts,
    { ...single.usage, ...billing },
    single.ttftMs,
  );
}

export async function runSummarizePipeline(
  options: RunPipelineOptions,
): Promise<PipelineResult> {
  const { taskId, onDelta, signal } = options;
  const e = env();
  const startedAt = Date.now();

  // ---- 生命周期前置：加载 / 校验 / 置 running / 凭证 / 分块 ----
  // 这一阶段的失败是「任务根本没开始跑」，由 lifecycle 自己落 failed 后抛错，
  // 因此不进入下方的 try/catch（那里处理的是「已经开始跑」的失败）。
  const { task, input, taskType, ctx, chunks } = await prepareSummarizeTask(taskId);

  const budget = planMapBudget(chunks.length, 4000);
  const allAttempts: PipelineResult['attempts'] = [];
  let totalUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  try {
    /**
     * ---- 单块短路 ----
     *
     * 两种情形合并处理，因为它们后续的计量/落库逻辑完全相同（见 runSinglePass）：
     *  1. 该类型不分块（翻译 / 润色）—— 始终是单次整篇调用
     *  2. 摘要但内容短到只有一块 —— 省掉一次无意义的 Map/Reduce 往返
     */
    if (chunks.length === 1) {
      return await runSinglePass({
        taskId,
        task,
        ctx,
        input,
        onDelta,
        signal,
        startedAt,
        meta: { chunking: taskType.supportsChunking ? 'single-small' : 'by-type' },
      });
    }

    const partialOutput: string[] = [];

    // 多块：并发 Map
    const mapResults = await mapWithConcurrency(
      chunks,
      async (chunk) => runMapChunk({ taskId, ctx, chunk, budget, signal }),
      e.CHUNK_CONCURRENCY,
    );

    for (const r of mapResults) {
      allAttempts.push(...r.attempts);
      partialOutput.push(r.text);
      totalUsage = addUsage(totalUsage, r.usage.usage);

      await recordUsage({
        userId: task.userId,
        // Map 阶段不绑定 taskId：UsageLog.taskId 唯一，一任务只能有一条。
        // Map 的多次调用在 meta 里聚合记录，避免触发唯一约束。
        taskId: null,
        provider: r.usage.provider,
        model: r.usage.model,
        usage: r.usage.usage,
        success: !r.degraded,
        meta: { phase: 'map', chunkIndex: r.index, degraded: r.degraded },
      });
    }

    if (signal?.aborted) {
      await cancelTask(taskId);
      throw new LLMError('已取消', 'ABORTED', false);
    }

    // ---- Reduce 阶段：合并摘要（流式推给用户）----
    const reduce = await runReduce({
      taskId,
      ctx,
      input: partialOutput.join('\n\n').trim(),
      onDelta,
      signal,
      pointCount: budget.perChunkPoints,
      isReduce: true,
    });

    allAttempts.push(...reduce.attempts);
    totalUsage = addUsage(totalUsage, reduce.usage.usage);

    const anyDegraded = reduce.degraded;

    // 关键：最终 usage 与成本以「Reduce 阶段那次 recordUsage」的返回值为准，
    // 因为它是在 Provider usage 之上按峰谷与缓存分档算出来的。
    const reduceBilling = await recordUsage({
      userId: task.userId,
      taskId,
      provider: reduce.usage.provider,
      model: reduce.usage.model,
      usage: reduce.usage.usage,
      success: !reduce.degraded,
      ttftMs: reduce.ttftMs,
      latencyMs: Date.now() - startedAt,
      errorCode: reduce.degraded ? 'DEGRADED' : undefined,
      meta: { phase: 'reduce', attempts: reduce.attempts },
    });

    await persistResult({
      taskId,
      output: reduce.text,
      degraded: anyDegraded,
      usage: { ...reduce.usage, ...reduceBilling },
      ttftMs: reduce.ttftMs,
      latencyMs: Date.now() - startedAt,
      extraMeta: {
        chunks: chunks.length,
        mapDegraded: budget.degraded,
        degradedReason: reduce.degradedReason,
        attempts: allAttempts,
        costCny: reduceBilling.costCny,
      },
    });

    if (ctx.userProvider) {
      await touchCredential(ctx.userProvider.credentialId, {
        ok: !anyDegraded,
        errorCode: anyDegraded ? 'DEGRADED' : undefined,
      });
    }

    return toResult(
      reduce.text,
      anyDegraded,
      reduce.degradedReason,
      allAttempts,
      { ...reduce.usage, ...reduceBilling },
      reduce.ttftMs,
    );
  } catch (e) {
    const err = e instanceof LLMError ? e : new LLMError(String(e), 'UNKNOWN', false);

    if (err.code === 'ABORTED') {
      await cancelTask(taskId);
      throw err;
    }

    // ⚠️ 即使失败也要记录 partial token 成本。
    // 上游可能已经消耗了 token（尤其 Map 阶段部分块成功时），
    // 只记成功会让成本统计系统性偏低，表现为「账单比仪表盘高」却查不出原因。
    await recordUsage({
      userId: task.userId,
      taskId: null,
      provider: 'unknown',
      model: ctx.defaultModel,
      usage: totalUsage,
      success: false,
      errorCode: err.code,
      latencyMs: Date.now() - startedAt,
      meta: { phase: 'pipeline', attempts: allAttempts },
    });

    await failTask(taskId, err.code, err.message);

    // 让用户能自查「我的 key 最近失败过」——否则他只会看到任务失败，
    // 猜不到问题出在自己的凭证上（也可能是余额/权限/地址填错）
    if (ctx.userProvider) {
      await touchCredential(ctx.userProvider.credentialId, { ok: false, errorCode: err.code });
    }

    throw err;
  }
}

// ============================================================
// 向后兼容的公共导出
// ============================================================
// 拆分前这些符号都从本文件导出；import 路径必须保持可用。
export { resolveUserProvider } from './context';
export { promptHash } from './prompts/render';
export type { PipelineResult, RunPipelineOptions } from './types';

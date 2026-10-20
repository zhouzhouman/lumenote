import { streamWithFallback } from '@/lib/llm/service';
import { wrapUntrusted } from '@/lib/llm/guardrail';
import { renderTemplate } from './prompts/render';
import type { PromptContext } from './context';
import type { PipelineResult } from './types';

/**
 * 模块职责：**Map / Reduce 单次模型调用的执行**（不含任务生命周期与落库）。
 *
 * 一次 Map 与一次 Reduce 的差异只在「prompt 指令、采样参数、是否流式」，
 * 而调用、降级、用量统计的形状完全相同。放在同一模块里复用，
 * 避免出现两份「几乎一样但差一个字段」的调用代码 ——
 * 那种复制是以后漏改的第一来源。
 *
 * ## Map 与 Reduce 的取舍（为什么这样调）
 *
 *  - Map：不流式给用户。多个分块并发时 token 会交错混乱，
 *    用户看到的会是一段拼接不自然的文字；代价是 TTFT 略变长。
 *  - Reduce：流式。它是最终输出，用户需要看到「正在生成」。
 *  - 两者都经过 `wrapUntrusted` 把正文包进 `<document>`，
 *    并把 `userProvider` 一路带上（否则 Map 用站点 key、Reduce 用用户 key，账单对不上）。
 */

/** 单次调用（Map 分块或 Reduce 合并）的完整结果 */
export interface SingleRunResult {
  text: string;
  degraded: boolean;
  degradedReason?: string;
  attempts: PipelineResult['attempts'];
  usage: {
    usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
    provider: string;
    model: string;
    costCny: number;
    cacheHitRate: number;
    peak: boolean;
  };
  ttftMs?: number;
  index?: number;
}

export type UsageTriple = { inputTokens: number; outputTokens: number; cachedTokens: number };

export function addUsage(a: UsageTriple, b: UsageTriple): UsageTriple {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
  };
}

/** 把内部结果收敛成对外的 PipelineResult（对外不暴露 provider 细节） */
export function toResult(
  text: string,
  degraded: boolean,
  degradedReason: string | undefined,
  attempts: PipelineResult['attempts'],
  usage: SingleRunResult['usage'],
  ttftMs?: number,
): PipelineResult {
  return {
    outputContent: text,
    degraded,
    degradedReason,
    attempts,
    usage: {
      inputTokens: usage.usage.inputTokens,
      outputTokens: usage.usage.outputTokens,
      cachedTokens: usage.usage.cachedTokens,
      costCny: usage.costCny,
      cacheHitRate: usage.cacheHitRate,
      peak: usage.peak,
    },
    ttftMs,
  };
}

/**
 * Map 阶段：单个分块的摘要（不流式给用户）。
 *
 * 每个分块单独注入 points 指令，其余保持 system 完全一致以利缓存命中。
 */
export async function runMapChunk(args: {
  taskId: string;
  ctx: PromptContext;
  chunk: { index: number; content: string };
  budget: { perChunkPoints: number };
  signal?: AbortSignal;
}): Promise<SingleRunResult> {
  const { ctx, chunk, budget, signal } = args;

  const userPrompt = renderTemplate(
    ctx.userPromptTemplate,
    { ...(args.ctx.params as Record<string, string>), content: chunk.content },
    ctx.variables,
  );

  const instructions = [
    '',
    `## 本块要求`,
    `这是第 ${chunk.index + 1} 个分块。请输出**不超过 ${budget.perChunkPoints} 条**要点，每条一句话以内。`,
    '只提炼本块出现的信息，不要推测未出现的内容，不要与其他分块重复。',
  ].join('\n');

  const res = await streamWithFallback({
    request: {
      model: ctx.defaultModel,
      system: ctx.renderedSystemPrompt,
      // ⚠️ wrapUntrusted：把正文包进 <document>，告诉模型这是数据不是指令
      prompt: `${wrapUntrusted(userPrompt)}\n${instructions}`,
      temperature: 0.3,
      maxTokens: budget.perChunkPoints * 45,
      thinking: 'disabled',
    },
    // BYOK：Map 与 Reduce 都必须带上，否则 Map 阶段会用站点 key
    // ——用户会看到「一半用自己的额度、一半用站点的」，账单对不上
    userProvider: ctx.userProvider,
    signal,
  });

  return {
    ...res,
    index: chunk.index,
    usage: {
      usage: res.usage,
      provider: res.usedLabel.split('/')[0] ?? 'unknown',
      model: ctx.defaultModel,
      costCny: 0,
      cacheHitRate: 0,
      peak: false,
    },
  };
}

/** Reduce 阶段：合并为最终结果（流式推给用户） */
export async function runReduce(args: {
  taskId: string;
  ctx: PromptContext;
  input: string;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  pointCount: number;
  isReduce?: boolean;
  /** 覆盖采样参数；不传则用 ctx 里按任务类型解析出的值 */
  maxOutputTokens?: number;
  temperature?: number;
}): Promise<SingleRunResult> {
  const { ctx, input, onDelta, signal, pointCount, isReduce } = args;

  const userPrompt = renderTemplate(
    ctx.userPromptTemplate,
    { ...(ctx.params as Record<string, string>), content: input },
    ctx.variables,
  );

  const instructions = isReduce
    ? [
        '',
        '## 本次任务',
        '以下是若干个分块各自的摘要，它们来自一篇完整文档的不同部分。',
        `请合并它们，输出一份**去重后的完整摘要**，不超过 ${Math.max(3, pointCount)} 条要点。`,
        '要点之间不要重复，保留信息量最高的内容，保持原文顺序。',
      ].join('\n')
    : '';

  const res = await streamWithFallback({
    request: {
      model: ctx.defaultModel,
      system: ctx.renderedSystemPrompt,
      prompt: `${wrapUntrusted(userPrompt)}\n${instructions}`,
      // 采样参数按任务类型取：翻译要更确定（低温度），润色可以更灵活
      temperature: args.temperature ?? ctx.temperature,
      maxTokens: args.maxOutputTokens ?? ctx.maxOutputTokens,
      thinking: 'disabled',
    },
    userProvider: ctx.userProvider,
    signal,
    onText: (delta) => onDelta?.(delta),
  });

  return {
    ...res,
    usage: {
      usage: res.usage,
      provider: res.usedLabel.split('/')[0] ?? 'unknown',
      model: ctx.defaultModel,
      costCny: 0,
      cacheHitRate: 0,
      peak: false,
    },
  };
}

import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { streamWithFallback } from '@/lib/llm/service';
import { recordUsage } from '@/lib/llm/metering';
import { estimateTokens } from '@/lib/llm/mock';
import { redactOutput, wrapUntrusted } from '@/lib/llm/guardrail';
import { LLMError } from '@/lib/llm/types';
import type { UserProviderConfig } from '@/lib/llm/registry';
import { loadActiveCredential, loadCredentialById, touchCredential } from '@/lib/llm/credentials';
import { chunkText, mapWithConcurrency } from './chunk';
import { normalizeTaskType, taskTypeDef, type TaskTypeDef } from '@/lib/tasks/types';
import { renderTemplate, promptHash, validateVariables, type TemplateVariable } from './prompts/render';
import { planMapBudget } from '@/lib/llm/budget';

/**
 * Map-Reduce 摘要管线。
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
 */

export interface RunPipelineOptions {
  taskId: string;
  /** 每个 token 增量回调（SSE 推送） */
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface PipelineResult {
  outputContent: string;
  degraded: boolean;
  degradedReason?: string;
  attempts: { label: string; ok: boolean; error?: string }[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costCny: number;
    cacheHitRate: number;
    peak: boolean;
  };
  ttftMs?: number;
}

interface PromptContext {
  systemPrompt: string;
  userPromptTemplate: string;
  variables: TemplateVariable[];
  params: Record<string, unknown>;
  defaultModel: string;
  /**
   * 已解析好的 system prompt（模板变量已替换）。
   *
   * 单独放一个字段而不是每次调 renderSystem，是为了让 Map 阶段的所有分块
   * 拿到**逐字节一致**的 system —— 这是前缀缓存命中的前提。
   */
  renderedSystemPrompt: string;
  /**
   * 用户自带的模型凭证（BYOK）。为 null 时走站点凭证。
   *
   * ⚠️ 它**不能**放进 Task.params 里持久化 —— 那会把密钥写进数据库的 JSON 字段。
   * 任务里只存 credentialId（见 tasks/route.ts），管线执行时再按 id 取回并解密。
   */
  userProvider: UserProviderConfig | null;
  /** 本类型任务的采样参数（来自 lib/tasks/types.ts 的共享注册表） */
  temperature: number;
  maxOutputTokens: number;
}

/**
 * 解析本次任务该用哪条模型凭证。
 *
 * 优先级：
 *  1. 任务参数里快照的 credentialId —— 保证「重跑历史任务」用的是当时那条凭证，
 *     而不是用户后来新配的那条
 *  2. 用户当前启用的凭证 —— 新建任务走这条
 *  3. null —— 回退到站点凭证
 *
 * 取不到（凭证被删了 / 解密失败）也返回 null 而不是报错：
 * 删掉一条正在被任务引用的凭证是完全合法的操作，
 * 此时回退到站点通道出结果，比让任务直接失败更符合预期。
 */
export async function resolveUserProvider(
  userId: string,
  params: Record<string, unknown>,
): Promise<UserProviderConfig | null> {
  const pinnedId = typeof params.credentialId === 'string' ? params.credentialId : null;

  const credential = pinnedId
    ? await loadCredentialById(userId, pinnedId)
    : await loadActiveCredential(userId);

  if (!credential) return null;

  return {
    credentialId: credential.id,
    provider: credential.provider,
    model: credential.model,
    baseUrl: credential.baseUrl,
    apiKey: credential.apiKey,
  };
}

/**
 * 渲染 system prompt。
 *
 * ⚠️ 必须和 user prompt 一样走 renderTemplate。
 *
 * 种子模板的 system prompt 里写了「严格按照 {{style}} 的风格输出」（以及
 * 翻译模板里的 {{targetLang}}/{{tone}}/{{glossary}}），
 * 但早先只渲染了 userPromptTemplate，system prompt 是原样透传的 ——
 * 于是模型收到的是字面量 `{{style}}`：用户在工作台选的风格、
 * 翻译的目标语言，全都从头到尾没有生效，还会污染 prompt 前缀、削弱缓存稳定性。
 *
 * 变量值本身的注入风险由 validateVariables 兜住（枚举白名单 + 数字格式），
 * 所以这里用同一份 userValues 是安全的。
 */
function renderSystemPrompt(
  ctx: Omit<PromptContext, 'renderedSystemPrompt' | 'userProvider' | 'temperature' | 'maxOutputTokens'>,
  userValues: Record<string, string>,
): string {
  // content 是正文占位符，不该出现在 system prompt 里；
  // 万一模板作者写了，也不要用正文把它填进去
  // （那会让 system 随每次请求变化，前缀缓存全部失效）
  const { content: _content, ...safeValues } = userValues;
  return renderTemplate(ctx.systemPrompt, safeValues, ctx.variables);
}

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

  const task = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    include: { template: true, promptVersion: true },
  });

  const input = task.inputContent ?? '';
  if (!input.trim()) {
    await failTask(taskId, 'INPUT_EMPTY', '输入内容为空');
    throw new LLMError('输入内容为空', 'BAD_REQUEST', false);
  }

  await prisma.task.update({
    where: { id: taskId },
    data: { status: 'running' },
  });

  /**
   * 解析任务类型，拿到该类型的采样参数与分块策略。
   *
   * 类型是数据库里的字符串，理论上可能被历史数据或手工改库弄成非法值。
   * 这里**显式报错而不是回落到 summarize** ——
   * 静默按摘要跑一个翻译任务是「结果看起来正常但完全不对」的那类问题，
   * 比直接失败糟糕得多。
   */
  const typeKey = normalizeTaskType(task.type);
  if (!typeKey) {
    const message = `不支持的任务类型：${task.type}`;
    await failTask(taskId, 'UNSUPPORTED_TASK_TYPE', message);
    throw new LLMError(message, 'BAD_REQUEST', false);
  }
  const taskType: TaskTypeDef = taskTypeDef(typeKey);

  // 模型凭证：用户配了自己的 key 就用它，否则走站点通道。
  // 注意这里只拿到「怎么调」，密钥本身绝不写进 Task。
  const userProvider = await resolveUserProvider(task.userId, (task.params ?? {}) as Record<string, unknown>);

  const ctx: PromptContext = {
    systemPrompt: task.promptVersion.systemPrompt,
    userPromptTemplate: task.promptVersion.userPromptTemplate,
    // Prisma 的 Json 类型是宽泛的 JSON 值，需要经 unknown 收窄为模板变量定义
    variables: (task.template.variables as unknown as TemplateVariable[]) ?? [],
    params: (task.params ?? {}) as Record<string, unknown>,
    // 用 BYOK 时，「默认模型」就是用户选的模型 —— 否则任务详情里显示的模型名
    // 会是站点的 DEFAULT_MODEL，与真实调用不符（可追溯性就假了）
    defaultModel: userProvider?.model ?? String((task.params as Record<string, unknown>)?.model ?? e.DEFAULT_MODEL),
    renderedSystemPrompt: task.promptVersion.systemPrompt,
    userProvider,
    temperature: taskType.temperature,
    maxOutputTokens: taskType.maxOutputTokens,
  };

  // 用户填写的变量（params 里除 model 外的都是模板变量）
  const userValues = Object.fromEntries(
    Object.entries(ctx.params).filter(([k]) => k !== 'model'),
  ) as Record<string, string>;

  validateVariables(userValues, ctx.variables);

  // 渲染一次 system prompt，供所有分块复用（见 renderSystemPrompt 注释）
  ctx.renderedSystemPrompt = renderSystemPrompt(ctx, userValues);

  /**
   * ---- 分块策略：按任务类型决定 ----
   *
   * ⚠️ 这里不能一律分块。分块（Map-Reduce）只对**摘要**成立：
   * 各段的摘要可以合并，信息不会因为切开而失真。
   *
   * 翻译与润色则相反：
   *  - 翻译切成几块分别翻，人称、语气、术语会前后不一致，
   *    而且合并阶段无法「恢复」被切断的语义（原文对应的是一整段话）。
   *  - 润色要看完整上下文才能改好，切开后各段风格会打架。
   *
   * 所以不支持分块的类型走「单次整篇调用」，并把输入截断到模型能承受的长度
   * （截断而非报错：超长文本至少能处理前面部分，并在 meta 里标注已截断）。
   */
  const chunks = taskType.supportsChunking
    ? chunkText(input, {
        maxTokens: e.CHUNK_SIZE_TOKENS,
        overlapTokens: e.CHUNK_OVERLAP_TOKENS,
      })
    : // 单块：整篇作为一块送入
      [{ index: 0, content: input }];

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
// 内部：Map / Reduce 单次调用
// ============================================================

interface SingleRunResult {
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

/** Map 阶段：单个分块的摘要。不流式给用户 */
async function runMapChunk(args: {
  taskId: string;
  ctx: PromptContext;
  chunk: { index: number; content: string };
  budget: { perChunkPoints: number };
  signal?: AbortSignal;
}): Promise<SingleRunResult> {
  const { ctx, chunk, budget, signal } = args;

  // 每个分块单独注入 points 指令，其余保持 system 完全一致以利缓存命中
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

/** Reduce 阶段：合并为最终摘要。流式推给用户 */
async function runReduce(args: {
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

// ============================================================
// 内部：持久化与状态流转
// ============================================================

async function persistResult(args: {
  taskId: string;
  output: string;
  degraded: boolean;
  usage: SingleRunResult['usage'];
  ttftMs?: number;
  latencyMs: number;
  extraMeta: Record<string, unknown>;
}): Promise<void> {
  // 输出脱敏：万一模型复述了用户输入里的密钥，不应原样入库
  const safe = redactOutput(args.output);

  await prisma.task.update({
    where: { id: args.taskId },
    data: {
      status: 'succeeded',
      outputContent: safe.text,
      degraded: args.degraded,
      latencyMs: args.latencyMs,
      ttftMs: args.ttftMs ?? null,
      completedAt: new Date(),
      outputMeta: {
        ...args.extraMeta,
        redacted: safe.redacted,
        redactedPatterns: safe.hits,
        outputTokens: estimateTokens(safe.text),
      } as never,
    },
  });
}

async function failTask(taskId: string, code: string, message: string): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: {
      status: 'failed',
      errorCode: code,
      // 不存完整上游错误信息，可能含内部细节。只存 code + 简短文案
      errorMessage: message.slice(0, 300),
      completedAt: new Date(),
    },
  });
}

async function cancelTask(taskId: string): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: { status: 'canceled', completedAt: new Date() },
  });
}

type UsageTriple = { inputTokens: number; outputTokens: number; cachedTokens: number };

function addUsage(a: UsageTriple, b: UsageTriple): UsageTriple {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
  };
}

function toResult(
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

export { promptHash };
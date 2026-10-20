import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { LLMError } from '@/lib/llm/types';
import { chunkText } from './chunk';
import { normalizeTaskType, taskTypeDef, type TaskTypeDef } from '@/lib/tasks/types';
import { validateVariables, type TemplateVariable } from './prompts/render';
import { renderSystemPrompt, resolveUserProvider, type PromptContext } from './context';
import { failTask } from './persistence';

/**
 * 模块职责：**任务生命周期前置阶段**（加载 → 校验 → 置 running → 准备上下文）。
 *
 * 一次摘要任务在真正开始「调模型」之前必须先完成这些事：
 *  1. 从库里取任务与模板版本；
 *  2. 校验输入非空、任务类型合法（非法类型显式失败，不静默回落）；
 *  3. 把任务状态置为 running（前端据此显示进度）；
 *  4. 解析凭证、渲染 system prompt、校验模板变量；
 *  5. 按任务类型决定分块策略（分块 / 单块）。
 *
 * ## 为什么单独成模块
 *
 * 这些步骤的失败语义与「模型调用失败」不同：前者是**任务根本没开始跑**
 * （输入为空、类型非法 → 直接落 failed 并抛 BAD_REQUEST），
 * 后者是**已经开始跑之后失败**（要记录 partial token 成本、更新凭证状态）。
 * 拆开后 runner 的 try/catch 只包住「已经开始跑」的编排循环，
 * 失败处理不再需要区分「这步之前还是之后」。
 *
 * 输出是一个不可变的 PreparedPipeline —— 后续编排只读它，不再查库。
 */

/** 编排阶段实际需要的任务字段（不把 Prisma 的完整行泄漏给 runner） */
export interface PipelineTask {
  id: string;
  userId: string;
  type: string;
}

export interface PreparedPipeline {
  task: PipelineTask;
  /** 原始输入正文（已确认非空） */
  input: string;
  taskType: TaskTypeDef;
  ctx: PromptContext;
  /** 已按任务类型决定的分块结果；长度为 1 表示走单块短路 */
  chunks: { index: number; content: string }[];
}

/**
 * 加载并准备工作区：任何前置校验失败都会先把任务落为 failed 再抛错。
 *
 * 抛出的是 LLMError（带 code），路由层据此映射 HTTP 状态；
 * 与编排阶段的错误共用同一套错误分类。
 */
export async function prepareSummarizeTask(taskId: string): Promise<PreparedPipeline> {
  const e = env();

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
  const userProvider = await resolveUserProvider(
    task.userId,
    (task.params ?? {}) as Record<string, unknown>,
  );

  const ctx: PromptContext = {
    systemPrompt: task.promptVersion.systemPrompt,
    userPromptTemplate: task.promptVersion.userPromptTemplate,
    // Prisma 的 Json 类型是宽泛的 JSON 值，需要经 unknown 收窄为模板变量定义
    variables: (task.template.variables as unknown as TemplateVariable[]) ?? [],
    params: (task.params ?? {}) as Record<string, unknown>,
    // 用 BYOK 时，「默认模型」就是用户选的模型 —— 否则任务详情里显示的模型名
    // 会是站点的 DEFAULT_MODEL，与真实调用不符（可追溯性就假了）
    defaultModel:
      userProvider?.model ??
      String((task.params as Record<string, unknown>)?.model ?? e.DEFAULT_MODEL),
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

  // 渲染一次 system prompt，供所有分块复用（见 context.ts 的 renderSystemPrompt 注释）
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

  return {
    task: { id: task.id, userId: task.userId, type: task.type },
    input,
    taskType,
    ctx,
    chunks,
  };
}

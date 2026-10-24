import { prisma } from '@/lib/db';
import { extractText } from '@/lib/pipeline/extract/text';
import { estimateTokens } from '@/lib/llm/mock';
import { LLMError } from '@/lib/llm/types';
import { taskTypeDef } from '@/lib/tasks/types';
import { ensureBuiltinTemplates } from '@/lib/tasks/builtin-templates';
import { buildGlossaryPrompt } from '@/lib/tasks/glossary';
import { isUniqueViolation } from '@/lib/idempotency';

/**
 * 创建一条 Task 记录（**只落库，不执行**）。
 *
 * 为什么单独抽出来：单篇任务（POST /api/tasks）与批次（POST /api/batches）
 * 必须走**同一套**「正文提取 → 模板/版本解析 → 术语表快照 → 落库」逻辑。
 * 一旦复制成两份，就会出现这类事故：批次那条忘了按 type 解析 slug，
 * 于是翻译任务用摘要的提示词跑，界面还显示成功。
 *
 * 职责边界（刻意不做的部分）：
 *  - **不校验配额**：调用方决定策略。单篇是「超了就拒」，批次是「先算够不够 N 条」
 *  - **不触发执行**：批次要串行、要预算闸门，执行时机由调用方控制
 *  - **不处理幂等冲突的语义**：只在唯一索引撞车时把已存在的那条捞回来
 *    （并发下两个请求同时通过查重时的兜底）
 */
export interface CreateTaskRecordInput {
  userId: string;
  type: 'summarize' | 'translate' | 'write';
  inputType: 'text' | 'url';
  /** 原文或链接（URL 会被服务端抓取，见 extractText） */
  content: string;
  /** 用户当次选择的参数（风格 / 要点数 / 目标语言…） */
  params: Record<string, unknown>;
  /** 实际使用的模型名。BYOK 时必须是用户选的模型，否则可追溯性失真 */
  model: string;
  /** 用户自己的凭证（BYOK）。只取 id 与展示名，**绝不把密钥写进任务** */
  credential?: { id: string; label: string } | null;
  /** 不传则按正文/链接自动推导 */
  title?: string;
  idempotencyKey: string;
  /** 批次归属。单篇任务为 null */
  batchId?: string | null;
  batchOrder?: number | null;
}

/**
 * 按 type 解析 Prompt 模板与版本。
 *
 * ⚠️ slug 必须按 type 解析，不能写死。写死 `sys:summarize.long` 的后果是：
 * 翻译任务用摘要的提示词去跑 —— 界面显示成功，内容全错，而且极难发现。
 */
function findTemplate(slug: string) {
  return prisma.promptTemplate.findFirst({
    where: { slug, isActive: true },
    // 内置模板的 (userId, slug) 唯一性在 Postgres 里对 NULL 不生效，
    // 极端情况下可能出现重复行：固定按创建时间取最早那条，结果才稳定
    orderBy: { createdAt: 'asc' },
    include: {
      versions: { where: { status: 'active' }, orderBy: { version: 'desc' }, take: 1 },
    },
  });
}

async function resolveTemplate(type: 'summarize' | 'translate' | 'write') {
  const typeDef = taskTypeDef(type);

  const found = await findTemplate(typeDef.slug);
  if (found && found.versions.length > 0) {
    return { template: found, version: found.versions[0]! };
  }

  /*
   * 自愈：模板缺失时**就地写入内置模板**，然后重查一次。
   *
   * 为什么要这么做，而不是「让部署方记得跑 seed」：
   *   - 模板是系统级数据，缺了核心功能直接不可用（实测新部署返回 500 TEMPLATE_MISSING）
   *   - `prisma:seed` 同时会创建固定弱密码的演示账号，生产环境不敢跑
   *   → 于是「新部署」和「安全」之间没有交集，只能靠应用自己保证基础数据存在
   *
   * 并发安全：两个请求同时自愈时，模板可能被插入两次（slug 唯一约束对 NULL 不生效），
   * 但 findTemplate 固定取最早一条，所以后续行为一致；pPromptVersion 有
   * (templateId, version) 唯一键，不会重复写版本。
   */
  console.warn(`[templates] 模板 ${typeDef.slug} 缺失，正在写入内置模板（自愈）`);
  await ensureBuiltinTemplates(prisma);

  const retried = await findTemplate(typeDef.slug);
  if (retried && retried.versions.length > 0) {
    return { template: retried, version: retried.versions[0]! };
  }

  throw new LLMError(
    `Prompt 模板「${typeDef.templateName}」未能初始化（自愈失败，请检查数据库写权限）`,
    'TEMPLATE_MISSING',
    false,
    500,
  );
}

/**
 * 为「创建阶段就失败」的条目留一条可追溯记录。
 *
 * 典型场景：批次里第 3 份材料是个打不开的链接（需登录 / 404）。
 * 如果只是记一条日志、把计数加一，批次详情页会少一行 ——
 * 用户看到「共 5 份、4 行记录」，第一反应是这个系统在丢数据。
 *
 * 所以失败也要落一条 status=failed 的任务，带上原因。
 * 这条记录**不消耗**额度、不产生 UsageLog（根本没发请求）。
 */
export async function createFailedTaskRecord(input: {
  userId: string;
  type: 'summarize' | 'translate' | 'write';
  inputType: 'text' | 'url';
  content: string;
  title: string;
  params: Record<string, unknown>;
  model: string;
  idempotencyKey: string;
  batchId?: string | null;
  batchOrder?: number | null;
  errorCode: string;
  errorMessage: string;
}) {
  const { template, version } = await resolveTemplate(input.type);
  return prisma.task.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title.slice(0, 120),
      status: 'failed',
      inputType: input.inputType,
      inputRef: input.inputType === 'url' ? input.content.trim() : null,
      inputContent: null,
      inputMeta: { charCount: 0, tokenCount: 0 } as never,
      templateId: template.id,
      promptVersionId: version.id,
      idempotencyKey: input.idempotencyKey,
      params: { ...input.params, model: input.model } as never,
      batchId: input.batchId ?? null,
      batchOrder: input.batchOrder ?? null,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage.slice(0, 500),
      completedAt: new Date(),
    },
  });
}

export async function createTaskRecord(input: CreateTaskRecordInput) {
  const { userId, type, inputType, content, params, model, credential, idempotencyKey } = input;

  // 提取与清洗正文（URL 会走 SSRF 防护后的抓取）
  const extracted = await extractText({ type: inputType, content });

  const { template, version } = await resolveTemplate(type);

  /*
   * 术语表在**创建任务时**快照，而不是执行时现读：
   * 用户之后可能改术语表，但这条任务的 Prompt 指纹必须保持不变，
   * 否则「同一条记录重跑会得到不同结果」，可追溯性就没了。
   */
  const targetLang = typeof params.targetLang === 'string' ? params.targetLang : '';
  const glossaryPrompt = type === 'translate' ? await buildGlossaryPrompt(userId, targetLang) : '';

  const title =
    input.title?.trim() ||
    extracted.meta.title?.slice(0, 80) ||
    (inputType === 'url'
      ? (extracted.meta.sourceHost ?? '链接摘要')
      : `${extracted.content.slice(0, 30)}…`);

  try {
    return await prisma.task.create({
      data: {
        userId,
        type,
        title,
        status: 'queued',
        inputType,
        inputRef: inputType === 'url' ? content.trim() : null,
        inputContent: extracted.content,
        inputMeta: {
          charCount: extracted.meta.charCount,
          tokenCount: estimateTokens(extracted.content),
          sourceHost: extracted.meta.sourceHost ?? null,
          extractedTitle: extracted.meta.title ?? null,
          truncated: extracted.meta.truncated ?? false,
          // 记「这次用了谁的凭证」，方便核对成本来源（只记 id 与展示名）
          credentialId: credential?.id ?? null,
          credentialLabel: credential?.label ?? null,
        } as never,
        templateId: template.id,
        promptVersionId: version.id,
        idempotencyKey,
        params: {
          ...params,
          model,
          ...(glossaryPrompt ? { glossary: glossaryPrompt } : {}),
          ...(credential ? { credentialId: credential.id } : {}),
        } as never,
        batchId: input.batchId ?? null,
        batchOrder: input.batchOrder ?? null,
      },
    });
  } catch (e) {
    // 并发下两个请求同时通过了幂等查重，靠唯一索引兜底
    if (isUniqueViolation(e)) {
      const existing = await prisma.task.findFirst({ where: { userId, idempotencyKey } });
      if (existing) return existing;
    }
    throw e;
  }
}

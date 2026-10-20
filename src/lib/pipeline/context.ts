import type { UserProviderConfig } from '@/lib/llm/registry';
import { loadActiveCredential, loadCredentialById } from '@/lib/llm/credentials';
import { renderTemplate, type TemplateVariable } from './prompts/render';

/**
 * 模块职责：**任务级 prompt 上下文与模型凭证解析**（不发起模型调用）。
 *
 * 这里回答两个问题：
 *  1. 这次任务用哪条模型凭证（用户 BYOK 优先，其次站点通道）；
 *  2. system prompt 与模板变量长什么样，以及它被渲染一次后如何被
 *     Map / Reduce 的所有调用复用（逐字节一致 → 前缀缓存可命中）。
 *
 * ## 为什么单独成模块
 *
 * 凭证解析涉及数据读取与密钥解密，渲染涉及模板语义，两者都是
 * 「任务开始前的一次性准备」，与 Map-Reduce 的编排循环是不同变化原因。
 * 之前它们和调用循环挤在一个文件里，导致任何一次凭证策略调整都要
 * 在数百行管线代码中定位。抽出来后 runner 只负责「怎么编排」。
 */

export interface PromptContext {
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
export function renderSystemPrompt(
  ctx: Omit<PromptContext, 'renderedSystemPrompt' | 'userProvider' | 'temperature' | 'maxOutputTokens'>,
  userValues: Record<string, string>,
): string {
  // content 是正文占位符，不该出现在 system prompt 里；
  // 万一模板作者写了，也不要用正文把它填进去
  // （那会让 system 随每次请求变化，前缀缓存全部失效）
  const { content: _content, ...safeValues } = userValues;
  return renderTemplate(ctx.systemPrompt, safeValues, ctx.variables);
}

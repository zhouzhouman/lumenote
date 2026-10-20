import { prisma } from '@/lib/db';

/**
 * 术语表：让翻译的专有名词保持一致。
 *
 * ## 为什么这是翻译场景的刚需
 *
 * 通用翻译模型对同一个术语在不同段落里可能给出不同译法
 * （比如 "token" 一会儿译「令牌」一会儿译「标记」，
 * "prompt" 一会儿「提示词」一会儿「提示语」）。
 * 对技术文档来说这是硬伤 —— 读者会以为是两个不同的东西。
 *
 * 术语表的作用是把这个「约定」显式写进 prompt，强制统一。
 *
 * ## 为什么在创建任务时快照，而不是执行时现读
 *
 * 两个理由：
 *  1. **可追溯**：这条任务的 Prompt 指纹必须固定。用户之后改了术语表，
 *     历史任务的记录不能被追溯性地改变，否则「同一记录重跑得到不同结果」。
 *  2. **一致性**：一次翻译内部必须用同一份术语表。如果在 Map/Reduce 之类的
 *     多阶段流程里各阶段现读，中途改动会导致同一篇译文前后不一致。
 *
 * 所以 `buildGlossaryPrompt` 在 POST /api/tasks 时调用一次，
 * 结果写进 `Task.params.glossary`，runner 只负责渲染。
 */

export interface GlossaryEntry {
  source: string;
  target: string;
  domain: string | null;
  caseSensitive: boolean;
  note: string | null;
}

/** 单次注入 prompt 的术语上限。太多会挤占正文预算，也会稀释注意力 */
const MAX_TERMS_IN_PROMPT = 60;

/**
 * 取用户在某领域（含通用）下适用的术语。
 *
 * 领域过滤的语义：domain 为 null 是通用术语（所有领域都适用），
 * 指定领域的术语只在该领域适用。这里把两者合并返回，
 * 因为「通用 + 领域」同时生效才是符合直觉的行为。
 */
export async function loadGlossary(
  userId: string,
  domain?: string | null,
): Promise<GlossaryEntry[]> {
  const rows = await prisma.glossaryTerm.findMany({
    where: {
      userId,
      ...(domain ? { OR: [{ domain: null }, { domain }] } : {}),
    },
    orderBy: [{ domain: 'asc' }, { source: 'asc' }],
    take: MAX_TERMS_IN_PROMPT,
    select: {
      source: true,
      target: true,
      domain: true,
      caseSensitive: true,
      note: true,
    },
  });
  return rows;
}

/**
 * 把术语表拼成注入 system prompt 的片段。
 *
 * 没有术语时返回空串 —— 让调用方可以用 `glossaryPrompt ? {...} : {}` 决定
 * 要不要写进 params。写一个空段落进 prompt 只会浪费 token 并干扰缓存前缀。
 */
export async function buildGlossaryPrompt(
  userId: string,
  domain?: string | null,
): Promise<string> {
  const terms = await loadGlossary(userId, domain);
  if (terms.length === 0) return '';

  const lines = terms.map((t) => {
    const parts = [`- ${t.source} → ${t.target}`];
    if (t.caseSensitive) parts.push('（区分大小写）');
    if (t.domain) parts.push(`[${t.domain}]`);
    if (t.note) parts.push(`// ${t.note}`);
    return parts.join(' ');
  });

  return [
    '# 术语表（必须遵守）',
    '以下术语必须按下述译法翻译，不得改写、不得同义替换：',
    ...lines,
  ].join('\n');
}

export interface GlossaryInput {
  source: string;
  target: string;
  domain?: string | null;
  caseSensitive?: boolean;
  note?: string | null;
}

export interface GlossaryValidation {
  ok: boolean;
  reason?: string;
  value?: GlossaryInput;
}

/**
 * 校验并归一化一条术语。
 *
 * 为什么要限制长度：术语会被塞进每一份翻译 prompt。
 * 一条 500 字的「术语」等于每次调用都多付 500 字的输入费，
 * 而且它多半不是术语而是说明文字 —— 应该写进 note。
 */
export function validateGlossaryInput(raw: unknown): GlossaryValidation {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: '请求格式不正确' };
  }
  const input = raw as Record<string, unknown>;

  const source = typeof input.source === 'string' ? input.source.trim() : '';
  const target = typeof input.target === 'string' ? input.target.trim() : '';

  if (!source) return { ok: false, reason: '请填写源词' };
  if (!target) return { ok: false, reason: '请填写译法' };
  if (source.length > 120) return { ok: false, reason: '源词过长（上限 120 字）' };
  if (target.length > 120) return { ok: false, reason: '译法过长（上限 120 字）' };

  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > 300) return { ok: false, reason: '备注过长（上限 300 字）' };

  const domain = typeof input.domain === 'string' ? input.domain.trim() : '';

  return {
    ok: true,
    value: {
      source,
      target,
      // 空字符串统一存 null：否则「未指定领域」会有 '' 与 null 两种表示，
      // 领域过滤的 OR 查询就会漏掉其中一种
      domain: domain || null,
      caseSensitive: input.caseSensitive === true,
      note: note || null,
    },
  };
}

/** 术语条数（供界面显示「已配置 N 条术语」） */
export async function countGlossary(userId: string): Promise<number> {
  return prisma.glossaryTerm.count({ where: { userId } });
}

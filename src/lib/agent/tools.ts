import { chunkText, type TextChunk } from '@/lib/pipeline/chunk';
import { extractFromUrl, ExtractError } from '@/lib/pipeline/extract/text';
import { diffLines } from '@/lib/tasks/diff';
import type { LLMTool } from '@/lib/llm/types';
import type { GlossaryEntry } from '@/lib/tasks/glossary';

/**
 * Agent 的只读工具集。
 *
 * ## 为什么全部只读（这是安全边界的根本）
 *
 * 实测确认（ADR-0004 探针 5）：模型**不会幻觉出不存在的工具** ——
 * 诱导它调用 `delete_all_files` 时，它明确回答「我没有这个工具」，
 * 尝试调用列表为空。工具白名单在 API 层被强制。
 *
 * 所以「只读」不是靠提示词约束的，而是**结构性的**：
 * 我们只注册只读工具，模型在物理上就没有写能力。
 * 这条边界比任何"请不要做危险操作"的提示词都可靠。
 *
 * ## 为什么工具执行不抛异常
 *
 * 所有 execute 都把错误**转成返回值**（`{ok:false, error}`）而不是抛出。
 * 原因是 Agent 循环需要把错误当作**观察结果**交给模型：
 * 「检索失败，索引未就绪」这样的信息能让模型决定换关键词重试或换一条路。
 * 直接抛错会让一次工具失败升级成整个任务失败，那是最没有价值的失败方式。
 *
 * ## 为什么核心逻辑做成纯函数
 *
 * `runSearchChunks` / `runListSections` / `runDiffWithText` 都是纯函数，
 * 不碰数据库、不发网络请求。这样它们可以被单测直接覆盖 ——
 * 而检索排序、章节识别的正确性恰恰是「评测分数好不好看」的前提。
 * 需要 IO 的部分（抓网页、查术语表）通过 ctx 传入或单独处理。
 */

// ============================================================
// 工具名（用常量而不是散落的字符串字面量 —— 额度表、评测断言都要引用）
// ============================================================
export const TOOL_NAMES = {
  searchChunks: 'search_chunks',
  fetchUrl: 'fetch_url',
  getGlossary: 'get_glossary',
  diffWithTask: 'diff_with_task',
  listSections: 'list_sections',
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/**
 * 单工具额度。
 *
 * ## 为什么全局步数上限不够
 *
 * 全局上限是 20 步，但模型完全可以在 20 步里调 20 次 `fetch_url` ——
 * 那是 20 次外部网络请求，是最贵的操作（时间 + 风险）。
 * 全局预算管不住这件事，**每个工具必须有自己的预算**。
 *
 * `fetch_url` 限 3 次是因为它是唯一会访问外网的工具；
 * `search_chunks` 限 10 次是因为它最容易被反复使用（换关键词搜同一件事）。
 */
export const TOOL_QUOTAS: Record<ToolName, number> = {
  search_chunks: 10,
  fetch_url: 3,
  get_glossary: 5,
  diff_with_task: 3,
  list_sections: 2,
};

// ============================================================
// 工具的执行上下文
// ============================================================
/**
 * 工具执行需要的**外部依赖**。
 *
 * ⚠️ 这里**不含 `chunks`**：当前文档是 Agent 循环自己管理的可变状态
 * （`fetch_url` 抓到的正文会并入它），把它放在 context 里会产生两个真值来源 ——
 * 循环改了 context 之外的那一份，工具读到的却是旧的一份，
 * 表现为「抓取了网页但检索不到它的内容」。
 *
 * 所以 `executeTool` 签名里 chunks 是独立参数，由循环在每次调用前传入最新值。
 */
export interface AgentToolContext {
  /** 术语表快照（创建任务时载入，避免循环中反复查库） */
  glossary: GlossaryEntry[];
  /**
   * 取某个历史任务的输出文本，供 diff_with_task 使用。
   * 做成回调是因为它需要鉴权 + 查库，不该让工具模块直接依赖 prisma。
   * 返回 null 表示任务不存在或不属于当前用户。
   */
  loadTaskOutput: (taskId: string) => Promise<{ title: string; output: string } | null>;
}

// ============================================================
// 工具结果形状
// ============================================================
export interface ToolOk<T> {
  ok: true;
  data: T;
}
export interface ToolFail {
  ok: false;
  error: string;
}
export type ToolResult<T> = ToolOk<T> | ToolFail;

function fail(error: string): ToolFail {
  return { ok: false, error };
}

// ============================================================
// search_chunks
// ============================================================
export interface SearchHit {
  /** 块的序号，用于证据引用（`chunk:12`） */
  chunkIndex: number;
  /** 命中的关键词个数 */
  score: number;
  /** 匹配到的关键词 */
  matched: string[];
  /** 片段内容（截断到 maxChars） */
  excerpt: string;
}

/**
 * 在分块里做关键词检索（纯函数）。
 *
 * ## 为什么不用向量检索
 *
 * 三个理由，都是刻意的取舍：
 *
 *  1. **确定性**：同一个 query 永远得到同样的结果。向量检索依赖 embedding 模型，
 *     而 embedding 模型同样会漂移 —— 那会让"可复现"这个卖点失效。
 *  2. **零成本零延迟**：不需要额外的 embedding 调用（每次检索都要付钱、要等待）。
 *  3. **可解释**：能告诉用户"命中了哪几个词"，而余弦相似度说不清为什么。
 *
 * 代价是**召回率不如语义检索**（同义词查不到）。这是已知限制，
 * 缓解办法是在 system prompt 里提示模型"换用不同的关键词重试" ——
 * 这也正好是 Agent 擅长的事（多次尝试）。
 *
 * ## 排序规则
 *
 * 先按命中关键词数量降序，再按块序号升序。
 * 第二个排序键很重要：**它保证结果是确定的**，
 * 否则同分块的顺序会依赖 JS 引擎的排序稳定性细节。
 */
export function runSearchChunks(
  chunks: TextChunk[],
  query: string,
  topK = 3,
  excerptChars = 600,
): ToolResult<{ hits: SearchHit[]; totalChunks: number }> {
  const trimmed = query.trim();
  if (!trimmed) return fail('检索关键词不能为空');

  /**
   * 关键词切分：中英文都要能用。
   *
   * 英文按空格切；中文没有空格，所以**额外把整个 query 也当作一个关键词**，
   * 这样「提示词缓存」能整体匹配，而不是被切成没有意义的单字。
   */
  const tokens = new Set<string>();
  for (const part of trimmed.split(/[\s,，、]+/)) {
    if (part) tokens.add(part.toLowerCase());
  }
  tokens.add(trimmed.toLowerCase());

  const scored: SearchHit[] = [];

  for (const chunk of chunks) {
    const haystack = chunk.content.toLowerCase();
    const matched: string[] = [];
    for (const token of tokens) {
      if (haystack.includes(token)) matched.push(token);
    }
    if (matched.length === 0) continue;

    /**
     * 摘录：以第一个命中的关键词为中心截一段，而不是直接给块的前 N 个字符。
     * 直接截开头很可能把命中位置切掉，模型看到一段没有关键词的文本会困惑。
     */
    const firstHit = haystack.indexOf(matched[0]!);
    const start = Math.max(0, firstHit - Math.floor(excerptChars / 3));
    const excerpt = chunk.content.slice(start, start + excerptChars);

    scored.push({
      chunkIndex: chunk.index,
      score: matched.length,
      matched,
      excerpt,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.chunkIndex - b.chunkIndex;
  });

  return {
    ok: true,
    data: {
      hits: scored.slice(0, Math.max(1, topK)),
      totalChunks: chunks.length,
    },
  };
}

// ============================================================
// list_sections
// ============================================================
export interface SectionInfo {
  chunkIndex: number;
  /** 该块里的第一个 Markdown 标题，没有则为 null */
  heading: string | null;
  /** 该块开头的一小段，便于模型判断内容 */
  preview: string;
}

/**
 * 列出文档结构（纯函数）。
 *
 * 目的是让模型先建立**全局观**再去检索，而不是盲目地猜关键词。
 * 这能显著减少"换了五次关键词都没找到"的无效步数 ——
 * 而无效步数直接等于成本。
 *
 * 只识别 Markdown 标题（`#` 开头）。不识别"看起来像标题的行"：
 * 那种启发式规则在中文文档上误判率很高，反而会误导模型。
 */
export function runListSections(chunks: TextChunk[], previewChars = 80): ToolResult<{
  sections: SectionInfo[];
  totalChunks: number;
}> {
  const sections: SectionInfo[] = chunks.map((chunk) => {
    const firstLine = chunk.content.split('\n').find((l) => l.trim()) ?? '';
    const headingMatch = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(firstLine);
    return {
      chunkIndex: chunk.index,
      heading: headingMatch ? headingMatch[2]!.trim() : null,
      preview: chunk.content.replace(/\s+/g, ' ').slice(0, previewChars),
    };
  });

  return { ok: true, data: { sections, totalChunks: chunks.length } };
}

// ============================================================
// diff_with_task
// ============================================================
/**
 * 与某个历史任务的输出对比（纯函数部分）。
 *
 * 用途：用户说「和上次那版比有什么变化」时，Agent 能真的去比，
 * 而不是凭印象回答。
 */
export function runDiffWithText(
  currentText: string,
  otherText: string,
  otherTitle: string,
): ToolResult<{ summary: string; added: number; removed: number; similarity: number; sample: string[] }> {
  if (!otherText) return fail('对比目标没有输出内容');

  const diff = diffLines(currentText, otherText);

  /**
   * 只给模型一小段差异样本，而不是完整 diff。
   *
   * 理由：完整 diff 可能非常长，塞进上下文会挤占检索与推理的预算，
   * 而模型需要的是"差异的性质"（改了多少、大致改了什么），
   * 不是逐行内容。要完整 diff 是 UI 的职责，不是模型的职责。
   */
  const sample = diff.lines
    .filter((l) => l.op !== 'equal')
    .slice(0, 20)
    .map((l) => `${l.op === 'add' ? '+' : '-'} ${l.text.slice(0, 120)}`);

  return {
    ok: true,
    data: {
      summary: `与「${otherTitle}」对比：相似度 ${(diff.stats.similarity * 100).toFixed(1)}%，新增 ${diff.stats.added} 行，删除 ${diff.stats.removed} 行`,
      added: diff.stats.added,
      removed: diff.stats.removed,
      similarity: diff.stats.similarity,
      sample,
    },
  };
}

// ============================================================
// 工具定义（给模型看的 schema）
// ============================================================
export const AGENT_TOOLS: LLMTool[] = [
  {
    name: TOOL_NAMES.listSections,
    description:
      '列出当前文档的章节结构（每个分块的标题与开头摘要）。在开始检索前先调用它，可以快速了解文档整体结构，避免盲目猜测关键词。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.searchChunks,
    description:
      '在当前文档中检索包含指定关键词的片段。返回匹配的片段编号（chunk:N）与内容。这是获取证据的主要工具。如果一次没搜到，可以换用同义词或更短的词重试。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索关键词。可以是多个词（用空格分隔），中文词组会整体匹配',
        },
        topK: {
          type: 'integer',
          description: '返回的片段数量，默认 3，最大 10',
          minimum: 1,
          maximum: 10,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.fetchUrl,
    description:
      '抓取一个网页的正文并可用其内容继续检索。仅支持 http/https，且只能访问公网地址。如果文档里引用了外部链接需要查看原文，可以用它。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的完整网页地址，必须以 http:// 或 https:// 开头' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.getGlossary,
    description:
      '查询术语表，确认某个专有名词在本项目的约定译法。涉及术语一致性时使用。',
    parameters: {
      type: 'object',
      properties: {
        term: { type: 'string', description: '要查询的术语（源词或其译法的一部分）' },
      },
      required: ['term'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.diffWithTask,
    description:
      '把当前文档与某个历史任务的输出做对比，用于回答「和上次相比有什么变化」。需要提供历史任务的 id。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '要对比的历史任务 id' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
];

// ============================================================
// 工具执行器（带 IO 的部分）
// ============================================================
export interface ToolExecution {
  result: ToolResult<unknown>;
  /** 给界面显示的一行摘要（用户能在时间线上看懂发生了什么） */
  display: string;
  /** 这次执行额外消耗的 token（抓网页后新分块的正文会进上下文） */
  extraTokens?: number;
  /** 抓取新网页后得到的额外分块，需要并入上下文供后续检索 */
  newChunks?: TextChunk[];
}

/**
 * 执行一次工具调用。
 *
 * ⚠️ **绝不抛出异常** —— 所有错误都转成 `{ok:false}`。
 * 调用方（Agent 循环）会把它作为工具结果回给模型，
 * 让模型自己决定重试还是换路。
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentToolContext,
  /** 当前文档分块。由循环传入**最新**的一份（fetch_url 之后会变长） */
  documentChunks: TextChunk[],
): Promise<ToolExecution> {
  switch (name) {
    case TOOL_NAMES.listSections: {
      const r = runListSections(documentChunks);
      const count = r.ok ? r.data.sections.filter((s) => s.heading).length : 0;
      return { result: r, display: r.ok ? `列出文档结构：${count} 个带标题的章节` : '列出结构失败' };
    }

    case TOOL_NAMES.searchChunks: {
      const query = typeof args.query === 'string' ? args.query : '';
      const topK = typeof args.topK === 'number' ? args.topK : 3;
      const r = runSearchChunks(documentChunks, query, topK);
      const hits = r.ok ? r.data.hits.length : 0;
      return {
        result: r,
        display: r.ok
          ? `检索「${query}」：命中 ${hits} 段`
          : `检索「${query}」失败：${r.error}`,
      };
    }

    case TOOL_NAMES.getGlossary: {
      const term = (typeof args.term === 'string' ? args.term : '').trim().toLowerCase();
      if (!term) return { result: fail('术语不能为空'), display: '查询术语失败：术语为空' };

      const matches = ctx.glossary.filter(
        (g) =>
          g.source.toLowerCase().includes(term) || g.target.toLowerCase().includes(term),
      );
      return {
        result: {
          ok: true,
          data: {
            matches: matches.slice(0, 10),
            total: ctx.glossary.length,
          },
        },
        display: `查询术语「${args.term}」：命中 ${matches.length} 条`,
      };
    }

    case TOOL_NAMES.fetchUrl: {
      const url = typeof args.url === 'string' ? args.url : '';
      if (!url) return { result: fail('url 不能为空'), display: '抓取失败：缺少 url' };

      try {
        const res = await extractFromUrl(url);
        const chunks = chunkText(res.content);

        /**
         * 抓到的正文不再返回全文，只返回前若干字符 + 分块数。
         *
         * 理由：全文可能有几万字，直接塞进工具结果会瞬间吃光 token 预算。
         * 正确的用法是让新分块**并入文档**（见 newChunks），
         * 模型随后用 search_chunks 去检索 —— 这样才能只把相关的部分读进上下文。
         */
        const previewChars = 500;
        const title = res.meta.title ?? url;
        return {
          result: {
            ok: true,
            data: {
              url,
              title,
              charCount: res.meta.charCount,
              chunkCount: chunks.length,
              firstChunkIndex: documentChunks.length,
              preview: res.content.slice(0, previewChars),
              note:
                chunks.length > 1
                  ? '正文较长，已按段落分块并加入文档索引。请用 search_chunks 检索具体内容，不要假设已读全文。'
                  : '正文较短，已加入文档索引。',
            },
          },
          display: `抓取 ${new URL(url).hostname}：${res.meta.charCount} 字，新增 ${chunks.length} 个分块`,
          extraTokens: res.meta.charCount,
          newChunks: chunks,
        };
      } catch (e) {
        /**
         * ExtractError 带可读的中文原因（422 语义），优先用它；
         * 其它错误给一个通用文案。无论哪种都返回而不是抛出。
         */
        const message =
          e instanceof ExtractError
            ? e.message
            : e instanceof Error
              ? `抓取失败：${e.message}`
              : '抓取失败：未知错误';
        return { result: fail(message), display: `抓取失败：${message.slice(0, 60)}` };
      }
    }

    case TOOL_NAMES.diffWithTask: {
      const taskId = typeof args.taskId === 'string' ? args.taskId : '';
      if (!taskId) return { result: fail('taskId 不能为空'), display: '对比失败：缺少 taskId' };

      const other = await ctx.loadTaskOutput(taskId);
      if (!other) {
        return {
          result: fail('找不到该历史任务（可能不存在，或不属于当前用户）'),
          display: '对比失败：任务不存在',
        };
      }

      // 当前文档用分块正文拼接作为"当前版本"
      const currentText = documentChunks.map((c) => c.content).join('\n\n');
      const r = runDiffWithText(currentText, other.output, other.title);
      return {
        result: r,
        display: r.ok ? r.data.summary : `对比失败：${r.error}`,
      };
    }

    default:
      /**
       * 未知工具：返回明确错误而不是静默忽略。
       *
       * 实测模型不会幻觉工具名（ADR-0004 探针 5），所以走到这里
       * 通常意味着**我们自己的注册表与执行器不同步**（比如加了 schema 忘了加 case）。
       * 明确报出来比静默失败更容易发现这类内部不一致。
       */
      return {
        result: fail(`未知工具：${name}`),
        display: `未知工具 ${name}`,
      };
  }
}

/**
 * 抓取后把新分块并入文档时，需要**重编号**。
 *
 * 否则新块的 index 会与已有块冲突，证据引用（`chunk:12`）就指向两份不同的内容 ——
 * 而证据链校验正是靠 index 定位原文的。
 */
export function appendChunks(existing: TextChunk[], added: TextChunk[]): TextChunk[] {
  const offset = existing.length;
  return [
    ...existing,
    ...added.map((c, i) => ({ ...c, index: offset + i })),
  ];
}

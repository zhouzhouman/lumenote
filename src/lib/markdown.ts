/**
 * 轻量 Markdown 解析器。
 *
 * ## 为什么需要它（这是一个真实 bug 的修复）
 *
 * 两处输出（工作台的流式结果、历史详情弹窗）的容器 class 都是 prose-lumenote，
 * globals.css 里为它写了 h1/h2/ul/ol/blockquote/code/a/strong 一整套排版规则 ——
 * 但**渲染方式是把纯文本直接塞进 div**：
 *
 *     <div className="prose-lumenote whitespace-pre-wrap">{state.text}</div>
 *
 * 那些 a {} / h2 {} 选择器永远匹配不到任何元素，因为 DOM 里只有文本节点。
 * 用户看到的是模型原样输出的 [标题](https://…) 与 **加粗**，
 * 链接点不动、标题没有层级 —— 也就是「文本链接无法解析」。
 *
 * 修复的关键取舍：**不引 react-markdown**。
 *  1. 它连带 remark/micromark 一整套生态，对一个「显示摘要」的场景过重
 *  2. 更重要的是流式场景：输出是**逐字到达的半成品**（[标题](htt 这种片段
 *     在一瞬间是合法输入）。解析器必须是纯函数、对任何残缺输入都只降级不抛错，
 *     自研版本才能把这条约束写进代码本身。
 *
 * 原则：**任何解析不出来的一律当纯文本**，绝不丢字符。
 *
 * ⚠️ 本文件有一个容易被忽视的约束：**注释里不要出现反引号与星号斜杠连写**。
 * TypeScript 的词法器会在 JSDoc 里被这类字符序列带偏（实测：注释中的
 * 「星号 + 斜杠」会被当成注释终止符，注释提前结束，随后整段代码被解析成
 * template literal，报出一堆与真实原因毫不相干的语法错误）。
 * 因此本文件的行内代码一律用中文引号或普通文字描述，不写字面反引号。
 */

export type InlineToken =
  | { type: 'text'; value: string }
  /** 链接：可能是 Markdown 链接也可能是裸 URL，由 url 字段统一表达 */
  | { type: 'link'; value: string; url: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; value: string }
  | { type: 'em'; value: string };

export type BlockToken =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: InlineToken[] }
  | { type: 'paragraph'; inlines: InlineToken[] }
  /** ordered 为 true 时用有序列表，起始编号由 start 给出 */
  | { type: 'list'; ordered: boolean; start: number; items: { inlines: InlineToken[] }[] }
  | { type: 'quote'; inlines: InlineToken[] }
  | { type: 'code'; language: string; value: string }
  | { type: 'hr' };

/** 允许的链接协议。刻意排除 javascript: 与 data: —— 输出内容来自模型，可能被注入 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * 剥掉链接两端可能存在的包裹字符（包含末尾的括号）。
 *
 * ⚠️ 末尾的右括号不能无条件剥掉：URL 里的括号是合法的，
 * 维基链接 https://en.wikipedia.org/wiki/Foo_(bar) 就是一个真实高频的例子，
 * 无脑 replace 会把右括号一起删掉，得到一个 404 链接。
 * 所以这里用**括号配平**来判断：只有落单的右括号才是「包裹字符」。
 */
function unwrapLink(raw: string): string {
  let text = raw.trim();

  // 左端：只会是 Markdown/HTML 风格的包裹符
  text = text.replace(/^[<(]/, '');

  // 右端：逐字符配平（用 for..of 按码点遍历，避免拆坏代理对）
  let open = 0;
  let close = 0;
  let last = '';
  for (const ch of text) {
    if (ch === '(') open += 1;
    else if (ch === ')') close += 1;
    last = ch;
  }
  if (last === ')' && close > open) {
    text = text.slice(0, -1);
  }
  if (last === '>' && !text.includes('<')) {
    text = text.slice(0, -1);
  }

  return text;
}

/**
 * 只接受明确安全的 URL。
 *
 * 这是本文件唯一的「安全敏感」函数：模型输出（或用户粘贴的内容被模型复述）
 * 渲染成 a 标签的 href 时，javascript: 就是 XSS。
 * 相对路径也不放行 —— 摘要里的链接应当是绝对的、可点开的。
 */
export function sanitizeUrl(raw: string): string | null {
  const unwrapped = unwrapLink(raw);
  if (!unwrapped) return null;

  // 空白与引号会破坏 href，直接拒绝而不是尝试修补。
  // 引号统一用 Unicode 转义书写，避免词法器把字符类里的引号当成字符串边界
  if (/[\s<>\u0022\u0027]/.test(unwrapped)) return null;

  // 有协议：校验协议白名单
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(unwrapped);
  if (schemeMatch) {
    const scheme = `${schemeMatch[1]!.toLowerCase()}:`;
    if (!SAFE_PROTOCOLS.has(scheme)) return null;
    return unwrapped;
  }

  // 无协议：只接受看起来像域名的（避免把正文里的普通词变成链接）
  if (/^[\w-]+(\.[\w-]+)+(\/|$|\?|#)/.test(unwrapped)) return `https://${unwrapped}`;
  return null;
}

/** 裸 URL 的识别（http/https/www 开头，到空白或中文标点为止） */
const BARE_URL_RE = /^(?:https?:\/\/|www\.)[^\s<>()（）【】「」，。；、]+/i;

/**
 * 解析行内元素。
 *
 * 顺序很重要：**行内代码 → 链接 → 强调**。
 * 如果先处理强调，单个星号会吃掉链接 URL 里的字符，结果是链接被切断 ——
 * 这类顺序错误只有在测试里才看得出来。
 */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let buffer = '';
  let i = 0;

  const flush = () => {
    if (buffer) {
      tokens.push({ type: 'text', value: buffer });
      buffer = '';
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    // ---- 行内代码 ----
    const code = new RegExp('^`([^`\\n]+)`').exec(rest);
    if (code) {
      flush();
      tokens.push({ type: 'code', value: code[1]! });
      i += code[0].length;
      continue;
    }

    // ---- Markdown 链接：方括号文字 + 圆括号 URL ----
    const mdLink = /^\[([^\]\n]*)\]\(/.exec(rest);
    if (mdLink) {
      // 用括号配平取出 URL，而不是写一个「到第一个右括号为止」的正则：
      // https://en.wikipedia.org/wiki/Foo_(bar) 里的右括号属于 URL 本身，
      // 按第一个右括号截断会得到 .../Foo_(bar —— 一个 404 链接。
      const start = mdLink[0].length;
      let depth = 1;
      let end = -1;
      for (let k = start; k < rest.length; k++) {
        const ch = rest[k];
        if (ch === '\n') break;
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            end = k;
            break;
          }
        }
      }

      if (end > start) {
        const url = sanitizeUrl(rest.slice(start, end));
        if (url) {
          flush();
          // 链接文字为空时用 URL 兜底，避免出现点不到的空白链接
          const label = mdLink[1]!.trim() || url;
          tokens.push({ type: 'link', value: label, url });
          i += end + 1;
          continue;
        }
        // URL 不安全：整体当纯文本，不丢字符也不生成危险链接
      }
    }

    // ---- 尖括号包裹的自动链接 ----
    if (rest.startsWith('<')) {
      const angle = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(rest);
      if (angle) {
        const url = sanitizeUrl(angle[1]!);
        if (url) {
          flush();
          tokens.push({ type: 'link', value: angle[1]!, url });
          i += angle[0].length;
          continue;
        }
      }
    }

    // ---- 裸 URL ----
    const bare = BARE_URL_RE.exec(rest);
    if (bare) {
      // 去掉常见的尾部标点（模型常写「详见 https://x.com。」）
      const cleaned = bare[0].replace(/[.,;:!?]+$/, '');
      const url = sanitizeUrl(cleaned);
      if (url) {
        flush();
        tokens.push({ type: 'link', value: cleaned, url });
        i += cleaned.length;
        continue;
      }
    }

    // ---- 加粗 / 斜体 ----
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) {
      flush();
      tokens.push({ type: 'strong', value: strong[2]! });
      i += strong[0].length;
      continue;
    }

    const em = /^\*([^*\n]+)\*/.exec(rest);
    if (em) {
      flush();
      tokens.push({ type: 'em', value: em[1]! });
      i += em[0].length;
      continue;
    }

    buffer += text[i];
    i += 1;
  }

  flush();
  return tokens;
}

const HEADING_RE = /^(#{1,6})\s+(\S.*)$/;
const UL_RE = /^\s{0,3}[-*+]\s+(\S.*)$/;
const OL_RE = /^\s{0,3}(\d{1,9})[.)]\s+(\S.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE_RE = /^\s{0,3}(?:`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;

/**
 * 块级解析。
 *
 * 流式容错点：未闭合的代码围栏会把剩余内容全部收进 code，这是正确行为
 * （避免把代码当正文渲染）；半截的表格不做特殊处理，按普通段落显示 ——
 * 表格语法在流式过程中本来就是逐步成形的。
 */
export function parseMarkdown(source: string): BlockToken[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: BlockToken[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 空行：分隔符，跳过
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // ---- 围栏代码块 ----
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const language = fence[1] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // 吃掉结束围栏（未闭合时 i 已越界，循环自然结束）
      blocks.push({ type: 'code', language, value: body.join('\n') });
      continue;
    }

    // ---- 分割线 ----
    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // ---- 标题 ----
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length, 6) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: 'heading', level, inlines: parseInline(heading[2]!) });
      i += 1;
      continue;
    }

    // ---- 引用（连续多行合并为一个 blockquote）----
    if (QUOTE_RE.test(line)) {
      const parts: string[] = [];
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i]!);
        if (!q) break;
        parts.push(q[1] ?? '');
        i += 1;
      }
      blocks.push({ type: 'quote', inlines: parseInline(parts.join(' ').trim()) });
      continue;
    }

    // ---- 列表（同类型连续行合并；有序列表保留起始编号）----
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const start = ordered ? Number(ol![1]) : 1;
      const items: { inlines: InlineToken[] }[] = [];

      while (i < lines.length) {
        const cur = lines[i]!;
        const m = ordered ? OL_RE.exec(cur) : UL_RE.exec(cur);
        if (!m) {
          // 允许列表项内的续行（缩进的非空行）并入上一项
          if (items.length > 0 && /^\s+\S/.test(cur) && !UL_RE.test(cur) && !OL_RE.test(cur)) {
            const last = items[items.length - 1]!;
            items[items.length - 1] = {
              inlines: parseInline(`${inlinesToText(last.inlines)} ${cur.trim()}`),
            };
            i += 1;
            continue;
          }
          break;
        }
        items.push({ inlines: parseInline(ordered ? m[2]! : m[1]!) });
        i += 1;
      }

      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }

    // ---- 段落：连续非空行合并（Markdown 软换行）----
    const para: string[] = [];
    while (i < lines.length) {
      const cur = lines[i]!;
      if (
        !cur.trim() ||
        HEADING_RE.test(cur) ||
        UL_RE.test(cur) ||
        OL_RE.test(cur) ||
        QUOTE_RE.test(cur) ||
        HR_RE.test(cur) ||
        FENCE_RE.test(cur)
      ) {
        break;
      }
      para.push(cur.trim());
      i += 1;
    }
    blocks.push({ type: 'paragraph', inlines: parseInline(para.join(' ')) });
  }

  return blocks;
}

/** 把行内 token 还原成纯文本，仅用于「列表续行」这类需要再解析的场合 */
function inlinesToText(inlines: InlineToken[]): string {
  return inlines.map((t) => t.value).join('');
}

/**
 * 输出是否为「空内容」。
 * 流式过程中会先收到空白增量，UI 不该因为几个换行就停止显示「正在连接…」。
 */
export function isBlankMarkdown(source: string): boolean {
  return source.replace(/[\s\u200B-\u200D\uFEFF]/g, '').length === 0;
}

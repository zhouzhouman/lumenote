import { safeFetch, extractUrl, SsrfError } from '@/lib/http/safe-fetch';
import { checkInput } from '@/lib/llm/guardrail';
import { LLMError } from '@/lib/llm/types';
import { env } from '@/lib/env';

/**
 * 文本抽取 —— 把四种输入来源统一成「纯正文」。
 *
 * 统一的价值在于：下游的分块、摘要、计量逻辑完全不需要关心输入是怎么来的。
 * 每加一种输入源，只需要在这里加一个分支，管线代码不动。
 *
 * 支持的来源：粘贴文本 / URL / 文件（Week 3 接 PDF）/ URL 正文清洗
 */

export interface ExtractResult {
  content: string;
  meta: {
    charCount: number;
    sourceHost?: string;
    title?: string;
    truncated?: boolean;
    degraded?: boolean;
  };
}

// ============================================================
// 纯文本清洗
// ============================================================

/**
 * 清洗粘贴的文本。
 *
 * 要处理的细节：
 *  - 零宽字符（可用于隐藏注入指令）
 *  - 过多空行（粘贴网页时常见，浪费 token）
 *  - 首尾空白
 *  - 连续空格
 */
export function cleanText(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    // 零宽字符与不可见控制字符。
    // ⚠️ 必须用 \uXXXX 转义：直接写字面字符时，其中的零宽连字会被当成
    // 字符类的连字符，导致正文中所有连字符（- / — 等）被静默删除。
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    // 3 个以上连续换行压成 2 个（保留段落结构）
    .replace(/\n{3,}/g, '\n\n')
    // 行尾空白
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// ============================================================
// URL 抓取与正文抽取
// ============================================================

/**
 * 简单的 HTML 标签与实体清理。不引 readability 依赖是刻意的：见函数注释
 *
 * @param baseUrl 页面最终地址，用于把相对链接补齐成绝对链接
 *
 * 导出是为了可单测：把 <a href> 保留成可读链接（而不是随标签一起删掉）
 * 是这块最容易出错、也最影响摘要可用性的逻辑 ——
 * 链接恰好是「可追溯」定位里最有价值的信息之一。
 */
export function htmlToText(html: string, baseUrl?: string): { text: string; title: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : '';

  // <base href> 优先于文档 URL —— 页面自己声明的基准地址才是权威
  const baseTag = /<base[^>]+href\s*=\s*["']([^"']+)["']/i.exec(html);
  const base = resolveBase(baseTag?.[1] ?? baseUrl);

  /**
   * ⚠️ 实体解码必须在**去标签之前**做。
   *
   * 反过来的顺序（先去标签再解码）会造成一个真实的护栏绕过：
   * 网页里的 `&lt;/document&gt;` 在去标签阶段不是标签、原样保留，
   * 但随后 decodeEntities 会把它还原成字面的 `</document>`，
   * 于是 prompt 里出现了我们以为已经处理过的结束标签 —— wrapUntrusted 再没有机会拦住它。
   * 顺带地，`&lt;script&gt;` 里的内容也会以「正文」身份进入 prompt。
   *
   * 先解码再清洗，等于让「标签剥离」看到真实字符，这才是它该有的语义。
   */
  const decoded = decodeEntities(html);

  // 优先取 <article> 或 <main>，正文质量通常远高于整页
  const articleMatch =
    decoded.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    decoded.match(/<main[^>]*>([\s\S]*?)<\/main>/i);

  let body = articleMatch ? articleMatch[1] : decoded;

  // 去掉不该出现在正文里的部分
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  /**
   * ⚠️ 把 <a href> 保留成 Markdown 链接，不能随标签一起删掉。
   *
   * 全量去标签的写法（`replace(/<[^>]+>/g, '')`）会把 href 整个丢掉，
   * 只留下锚文本 —— 一份「第 3 节引用了 [1]」的摘要里，来源链接全部蒸发，
   * 而链接恰恰是摘要最有价值的可追溯信息之一。这一层必须显式处理。
   *
   * 顺序也要注意：这一步必须在后面的「块级标签转换」与「去标签」之前，
   * 否则 <a> 已经被删了。
   */
  body = body.replace(
    /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, dq: string | undefined, sq: string | undefined, bare: string | undefined, inner: string) => {
      const href = (dq ?? sq ?? bare ?? '').trim();
      // 锚文本内部可能还有标签，先压平
      const label = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!href) return label;

      const absolute = absolutize(href, base);
      // 解析失败（javascript:、mailto 等）就只保留文字，不生成可疑链接
      if (!absolute) return label;

      // 锚文本为空 → 这是图标/图片链接（导航栏、社交按钮），
      // 单输出 URL 只会给正文灌一堆 `(https://…)` 噪声。
      // 例外：本身就是长 URL 的锚文本，那是真实引用（如论文链接），保留。
      if (!label) return absolute.length > 60 ? absolute : '';

      // 锚文本与 URL 重复时，只输出 URL，避免「https://x https://x」
      if (label === href || label === absolute) return absolute;
      return `${label} (${absolute})`;
    },
  );

  // 块级标签转换为换行，保留段落结构（直接去标签会把整篇压成一行）
  body = body
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h1[^>]*>/gi, '\n# ')
    .replace(/<h2[^>]*>/gi, '\n## ')
    .replace(/<h3[^>]*>/gi, '\n### ')
    .replace(/<[^>]+>/g, '');

  // 解码已在前面完成，这里只做清洗（重复解码会把 "&amp;lt;" 二次还原成 "<"）
  return { text: cleanText(body), title };
}

/** 解析 <base href> / 文档 URL，失败返回 undefined */
function resolveBase(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).toString();
  } catch {
    return undefined;
  }
}

/** 把相对链接补成绝对链接；非 http/https（含 javascript:）一律返回 null */
function absolutize(href: string, base: string | undefined): string | null {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * @mozilla/readability 为什么没引？
 *
 * 它的抽取质量确实更好，但代价是：
 *  1. 需要在服务端构造一个完整的 DOM 环境（jsdom 或 happy-dom），依赖体积大，
 *     在 Serverless 上冷启动慢
 *  2. 它的 API 是同步的但在 Node 环境需要额外 polyfill
 *  3. 对「摘要」这个场景，简单的标签清洗已经够用 ——
 *     模型本来就要处理一定的噪声，脏一点不影响摘要质量
 *
 * 保留 `<article>` 优先 + 块级标签转换的策略，在不引入依赖的前提下
 * 拿到了 80% 的收益。若后续发现抽取质量成为瓶颈，再引入 Readability ——
 * 这是一个记录了理由的有意取舍，不是遗漏。
 */
function decodeEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
    '&ldquo;': '“',
    '&rdquo;': '”',
  };
  return text
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (m) => entities[m.toLowerCase()] ?? m);
}

/**
 * 抓取/抽取阶段的可预期失败。
 *
 * ## 为什么需要这个类型（这是一个真实问题的修复）
 *
 * `extractFromUrl` 之前抛的是裸 `Error`，而 `handleError` 只认识
 * ZodError / AuthzError / LLMError，于是所有抓取失败都落到兜底分支：
 * 对外只显示「服务内部错误」+ 500，具体原因（DNS 解析不了 / 站点拒绝 /
 * 超时 / 需要登录 / 页面是纯前端渲染）全部丢失，服务端日志里也只有一句
 * `[api] 未处理异常：TypeError: fetch failed`。
 *
 * 对用户来说这是最糟的一种错误：既不知道发生了什么，也不知道能不能重试。
 * 抓取失败是**可预期的业务失败**，不是服务端 bug，应该：
 *   - 带明确的中文原因返回 422（不是 5xx）
 *   - 让 `retryable` 表达「换个链接/稍后再试是否有意义」
 */
export class ExtractError extends LLMError {
  constructor(message: string, code = 'EXTRACT_FAILED', retryable = false) {
    // 422：请求本身的问题（链接抓不到），不是服务端故障。
    // 用 5xx 会误导用户去刷新重试，也会污染监控的错误率
    super(message, code, retryable, 422);
  }
}

/**
 * 把错误对象上「所有层级的线索」拼成一段可检索的文本。
 *
 * ⚠️ 为什么不能只看 `e.message`（这是一个实测踩到的坑）：
 * undici 抛出的错误最外层几乎永远是同一句 `fetch failed`，
 * 真正的原因在 `cause` 链上：
 *
 *     TypeError: fetch failed
 *       cause: ConnectTimeoutError: Connect Timeout Error (attempted address: zh.wikipedia.org:443)
 *         code: 'UND_ERR_CONNECT_TIMEOUT'
 *
 * 只看最外层的话，超时、DNS 失败、证书错误、连接被拒**全都长得一模一样**，
 * 于是全都落到兜底分支显示「抓取链接失败：fetch failed」——
 * 用户既不知道原因，也不知道该不该重试。
 * 把 code / name / cause 链一起纳入匹配，才能区分这些情况。
 */
function collectErrorClues(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  let depth = 0;

  while (cur && depth < 6) {
    const obj = cur as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown };
    if (typeof obj.name === 'string') parts.push(obj.name);
    if (typeof obj.code === 'string') parts.push(obj.code);
    if (typeof obj.message === 'string') parts.push(obj.message);
    cur = obj.cause;
    depth += 1;
  }

  return parts.join(' | ');
}

/** 把各种底层抓取异常翻译成用户能看懂的原因 */
function describeFetchFailure(e: unknown): ExtractError {
  if (e instanceof SsrfError) {
    // SSRF 拦截是唯一需要「原样告知」的一类：用户需要知道是链接不被允许，
    // 而不是网络抖动，否则他会反复重试同一个链接
    const map: Record<string, string> = {
      INVALID_PROTOCOL: '仅支持 http/https 链接',
      PRIVATE_IP: '该链接指向内网地址，出于安全考虑已阻止',
      DNS_FAILED: '域名解析失败，请检查链接是否正确',
      BLOCKED_HOST: '该站点不允许被本站抓取',
      TOO_LARGE: '页面内容过大，无法处理',
      TIMEOUT: '抓取超时，该站点响应过慢',
      TOO_MANY_REDIRECTS: '链接跳转次数过多',
    };
    return new ExtractError(map[e.code] ?? `链接无法访问（${e.code}）`, e.code, e.code === 'TIMEOUT');
  }

  const clues = collectErrorClues(e);

  // 顺序有讲究：先判最具体、最需要区分的两类（DNS / TLS），再判超时与连接问题。
  // 例如 TLS 失败的 cause 里往往同时含 ECONNRESET，若先判连接类就会误报成「无法连接」。
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|UND_ERR_DNS/i.test(clues)) {
    return new ExtractError('域名解析失败，请检查链接是否正确', 'DNS_FAILED', true);
  }
  if (/CERT|TLS|SSL|self-signed|UNABLE_TO_VERIFY|ERR_TLS/i.test(clues)) {
    return new ExtractError('该站点的 HTTPS 证书校验失败，无法安全抓取', 'TLS_ERROR');
  }
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|Connect Timeout/i.test(clues)) {
    return new ExtractError(
      '连接该站点超时。常见原因：站点在境内网络不可达（如维基百科）、响应过慢、或需要代理。',
      'TIMEOUT',
      true,
    );
  }
  if (/ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|UND_ERR_SOCKET/i.test(clues)) {
    return new ExtractError('无法连接到该站点，请确认链接可公开访问', 'NETWORK_ERROR', true);
  }
  if (/abort/i.test(clues)) {
    return new ExtractError('抓取已被中断，请重试', 'TIMEOUT', true);
  }

  // 兜底也要给出可操作的建议，而不是把底层英文错误甩给用户
  return new ExtractError(
    '抓取链接失败。可能是站点需要登录、拒绝服务端访问，或网络不可达。'
      + '可以改用「粘贴文本」把正文贴进来。',
    'FETCH_FAILED',
    true,
  );
}

export async function extractFromUrl(inputUrl: string): Promise<ExtractResult> {
  const url = extractUrl(inputUrl);
  if (!url) {
    throw new ExtractError('请输入以 http:// 或 https:// 开头的完整链接', 'INVALID_URL');
  }

  let result;
  try {
    result = await safeFetch(url);
  } catch (e) {
    // 带着 URL 一起记日志：没有它，排查「用户说抓不到」时无从下手
    console.error(`[extract] 抓取失败 url=${url}：`, e);
    throw describeFetchFailure(e);
  }

  if (!result.contentType.includes('html') && !result.contentType.includes('text')) {
    throw new ExtractError(
      `不支持的内容类型：${result.contentType || '未知'}（仅支持网页或纯文本链接）`,
      'UNSUPPORTED_CONTENT_TYPE',
    );
  }

  // 传入 finalUrl：相对链接（/docs/a、../b）需要基准地址才能解析成可点的绝对链接
  const { text, title } = htmlToText(result.text, result.finalUrl);

  if (text.length < 50) {
    throw new ExtractError(
      '未能从该链接提取到正文。常见原因：需要登录、内容由前端脚本渲染、或正文过短。'
        + '可以改用「粘贴文本」把正文贴进来。',
      'NO_CONTENT',
    );
  }

  return {
    content: text,
    meta: {
      charCount: text.length,
      sourceHost: new URL(result.finalUrl).hostname,
      title,
      truncated: result.truncated,
    },
  };
}

// ============================================================
// 统一入口
// ============================================================

export interface ExtractInput {
  type: 'text' | 'url';
  content: string;
}

export async function extractText(input: ExtractInput): Promise<ExtractResult> {
  const e = env();

  const check = checkInput(input.content, e.MAX_INPUT_CHARS);
  // 输入类错误同样是「可预期的用户错误」，用 ExtractError/(422) 表达，
  // 避免落到 handleError 的兜底分支变成 500「服务内部错误」
  if (!check.ok) {
    throw new ExtractError(check.reason ?? '输入无效', 'INVALID_INPUT');
  }

  if (input.type === 'url') {
    return extractFromUrl(input.content);
  }

  const cleaned = cleanText(check.sanitized ?? input.content);
  if (cleaned.length < 10) {
    throw new ExtractError('输入内容过短，至少需要 10 个字符', 'TOO_SHORT');
  }

  return {
    content: cleaned,
    meta: { charCount: cleaned.length },
  };
}
/**
 * 链接输入的格式判定与提示文案。
 *
 * 为什么单独抽一个模块：
 *  1. 判定逻辑要**可单测**（组件里有 hooks，测起来重）
 *  2. 文案与判定必须同源 —— 提示说「支持 http/https」，校验就必须只放行这两种，
 *     否则用户会觉得提示在骗人
 *  3. 这里不引任何 Node 模块，前后端都能用
 *
 * ⚠️ 判定口径必须与后端对齐（`src/lib/http/safe-fetch.ts` 的 `extractUrl` +
 * `assertSafeTarget`）：
 *    - 只认 `http://` / `https://`，且**整段输入就是一个地址**（不能夹空格或第二个链接）
 *    - 内网 / 回环 / 云元数据地址一律拒绝（SSRF 防护）
 *
 * 前端只做**便宜的本地判定**：DNS 解析后的真实 IP 是后端才能判断的，
 * 所以这里拦的是字面量地址，不是全部情况 —— 真正的安全边界在后端。
 */

/** 后端 extractUrl 的同款正则：必须整段匹配，\S+ 顺便排除空格与多链接 */
const SUPPORTED_URL = /^https?:\/\/\S+$/i;

export interface UrlInputCheck {
  ok: boolean;
  /** 不通过时给用户看的原因（已经是完整句子，可直接渲染） */
  reason?: string;
}

/**
 * 字面量主机是否属于「内网 / 本地 / 云元数据」。
 *
 * 只处理字面量，不做 DNS 解析：`evil.com` 解析到 127.0.0.1 这种情况前端无能为力，
 * 由后端 `safeFetch` 在连接前解析并拦截。
 */
export function isBlockedHostLiteral(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata' || host.endsWith('.internal')) return true;

  // IPv6 回环 / 未指定
  if (host === '::1' || host === '::') return true;

  // IPv4 字面量：按网段判断，不用字符串前缀（0x7f.1 / 2130706433 之类的等价写法
  // 后端会解析成整数再判；前端这里只覆盖最常见的十进制点分写法）
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // 链路本地，含云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * 判定用户输入能否被当作链接读取。
 *
 * 注意语义：返回 `ok: false` 不代表后端一定会失败（DNS 层面的内网地址前端查不到），
 * 但返回 `ok: true` 也不保证一定能抓到（页面可能需要登录、靠 JS 渲染、或超大）。
 * 这里只回答「**格式**是否可用」。
 */
export function checkUrlInput(raw: string): UrlInputCheck {
  const value = raw.trim();
  if (!value) return { ok: false, reason: '请先粘贴一个网页地址' };

  if (!SUPPORTED_URL.test(value)) {
    /*
     * 原因要按**最具体**的那一条给，顺序不能乱。
     * 例：`https://a.com https://b.com` 既「不是单个地址」又「含空格」，
     * 但用户最需要知道的是「一次只能一个」，而不是「只支持 http」——
     * 后者对一个明显以 https 开头的输入来说是错的提示。
     */
    const scheme = value.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
    if (!scheme) {
      return {
        ok: false,
        reason: '链接需要以 http:// 或 https:// 开头（例如 https://example.com/article）',
      };
    }
    if (scheme !== 'http' && scheme !== 'https') {
      return { ok: false, reason: '只支持 http:// 或 https:// 开头的地址' };
    }
    if (/\s/.test(value)) {
      return { ok: false, reason: '一次只能填一个链接，且地址里不能含空格' };
    }
    return { ok: false, reason: '这个地址格式不正确，请检查是否有多余字符' };
  }

  let hostname = '';
  try {
    hostname = new URL(value).hostname;
  } catch {
    return { ok: false, reason: '这个地址无法解析，请检查是否有多余字符' };
  }

  if (isBlockedHostLiteral(hostname)) {
    return { ok: false, reason: '出于安全考虑，内网、localhost 与云元数据地址无法读取' };
  }

  return { ok: true };
}

/**
 * 输入区常驻提示（用户切到「网页链接」就能看到，不必先犯错再被纠正）。
 *
 * 每条都对应一个真实的限制，不写「理论上可能」的话：
 *  - 第 1 条 ← extractUrl 只认 http/https，且整段就是一个地址
 *  - 第 2 条 ← extract/text.ts 只接受 html / text 内容类型；正文 <50 字判定失败
 *  - 第 3 条 ← safe-fetch 的 SSRF 防护
 */
export const URL_INPUT_HINTS = [
  '可用格式：以 http:// 或 https:// 开头的完整网页地址，一次填一个。',
  '只支持网页正文与纯文本页面；PDF、图片、需要登录或靠前端渲染的页面读不到，请改用「粘贴文本」。',
  '内网、localhost 与云元数据地址会被拒绝（SSRF 防护）。',
] as const;

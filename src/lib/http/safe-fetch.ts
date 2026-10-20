import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Dispatcher } from 'undici';
import { env, fetchAllowedHosts } from '@/lib/env';

/**
 * SSRF（服务端请求伪造）防护。
 *
 * ## 攻击原理
 *
 * 服务端提供一个「输入 URL 抓取正文」的功能。攻击者提交：
 *
 *   http://169.254.169.254/latest/meta-data/iam/security-credentials/
 *
 * 云服务器的元数据接口会返回该实例的临时凭证（含云账号 AK/SK）。
 * 由于请求**由服务端发出**，所以能访问只有内网可见的资源。
 *
 * 同类目标还有：内网管理后台（K8s API、Redis、Jenkins）、
 * 本地服务的 localhost 端口、云厂商的元数据地址。
 *
 * 这是一个**高危且高频被面试问到**的漏洞类别。
 * 本文件实现完整的四层防御。
 */

export class SsrfError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_PROTOCOL'
      | 'PRIVATE_IP'
      | 'DNS_FAILED'
      | 'BLOCKED_HOST'
      | 'TOO_LARGE'
      | 'TIMEOUT'
      | 'TOO_MANY_REDIRECTS',
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** 云厂商元数据地址。这些地址没有 DNS，直接硬编码拦截 */
const METADATA_IPS = new Set([
  '169.254.169.254', // AWS / GCP / Azure / 阿里云
  '169.254.170.2', // AWS ECS
  '100.100.100.200', // 阿里云元数据
  '192.0.0.192', // Oracle Cloud
]);

/**
 * 判断 IP 是否为私有/保留地址。
 *
 * ⚠️ 这里不能用「以 10. 开头」这种字符串判断，必须解析为整数做区间比较。
 * 攻击者可以用各种等价写法绕过前缀匹配：
 *   0x0a.0.0.1、2130706433（十进制127.0.0.1）、[::ffff:127.0.0.1]
 * 解析为整数后这些都会落到正确的区间里。
 */
export function isPrivateIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true; // 不是合法 IP 一律拒绝（fail-closed）
}

function toInt32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
  if (METADATA_IPS.has(ip)) return true;

  const n = toInt32(ip);
  if (n === null) return true;

  const inRange = (start: string, end: string): boolean => {
    const s = toInt32(start)!;
    const e = toInt32(end)!;
    return n >= s && n <= e;
  };

  // RFC1918 私有段
  if (inRange('10.0.0.0', '10.255.255.255')) return true;
  if (inRange('172.16.0.0', '172.31.255.255')) return true;
  if (inRange('192.168.0.0', '192.168.255.255')) return true;
  // 环回
  if (inRange('127.0.0.0', '127.255.255.255')) return true;
  // 链路本地（含 169.254.169.254 元数据）
  if (inRange('169.254.0.0', '169.254.255.255')) return true;
  // CGNAT 100.64.0.0/10 —— 云厂商常用，且部分环境可路由到内部服务
  if (inRange('100.64.0.0', '100.127.255.255')) return true;
  // 保留段
  if (inRange('0.0.0.0', '0.255.255.255')) return true;
  if (n >= 0xe0000000) return true; // 240.0.0.0/4 保留
  // 广播与组播
  if (n >= 0xf0000000) return true;

  /*
   * RFC 5737/6890 的「特殊用途」地址段。
   *
   * 这些之前在注释里被笼统地归为「保留段」，但代码并没有真的拦它们。
   * 其中两个是**实际可被利用**的，不是理论洁癖：
   *  - 198.18.0.0/15（基准测试段，RFC 2544）：部分 VPC / 对等连接里可以路由到内部设施
   *  - 192.88.99.0/24（6to4 中继任播）：经典的「从 IPv4 侧去碰 IPv6 目标」的入口
   * 文档段（192.0.2.0/24、198.51.100.0/24、203.0.113.0/24）虽然通常不可路由，
   * 但同样属于「不该被当成公网主机抓取」的范畴，一并拦掉 —— fail-closed 成本几乎为零。
   */
  if (inRange('192.0.0.0', '192.0.0.255')) return true; // IETF 协议分配
  if (inRange('192.0.2.0', '192.0.2.255')) return true; // TEST-NET-1
  if (inRange('192.88.99.0', '192.88.99.255')) return true; // 6to4 中继任播
  if (inRange('198.18.0.0', '198.19.255.255')) return true; // 基准测试
  if (inRange('198.51.100.0', '198.51.100.255')) return true; // TEST-NET-2
  if (inRange('203.0.113.0', '203.0.113.255')) return true; // TEST-NET-3
  if (n === 0xffffffff) return true; // 255.255.255.255 有限广播

  return false;
}

/**
 * 把 IPv6 文本解析成 16 字节。
 *
 * 为什么要自己展开而不用字符串前缀判断：
 * 同一个地址有多种合法写法（`::ffff:127.0.0.1` 与 `::ffff:7f00:1`、
 * `::1` 与 `0:0:0:0:0:0:0:1`）。用文本匹配就必须枚举所有写法，
 * 只要漏一种就是一个 SSRF 绕过。展开成字节后，判断与写法无关。
 *
 * 支持 `%zone`（如 fe80::1%eth0）：Zone ID 只影响本地接口选择，
 * 不影响地址判定，直接剥掉。
 */
function parseIpv6ToBytes(ip: string): Uint8Array | null {
  const withoutZone = ip.includes('%') ? ip.slice(0, ip.indexOf('%')) : ip;
  const lower = withoutZone.toLowerCase();

  // 拆成「:: 左边」与「右边」两组 hextet
  const parts = lower.split('::');
  if (parts.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (g === '') return null;
      // 允许最后一段写成点分十进制（::ffff:127.0.0.1）
      if (g.includes('.')) {
        const v4 = toInt32(g);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const left = parseGroups(parts[0]!);
  const right = parts.length === 2 ? parseGroups(parts[1]!) : [];
  if (!left || !right) return null;

  const total = left.length + right.length;
  if (parts.length === 2) {
    // 有 `::` 时缺省段补零，且至少压缩一段
    if (total > 8) return null;
    const middle = new Array<number>(8 - total).fill(0);
    const groups = [...left, ...middle, ...right];
    return groupsToBytes(groups);
  }

  if (total !== 8) return null;
  return groupsToBytes(left);
}

function groupsToBytes(groups: number[]): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    bytes[i * 2] = (g >>> 8) & 0xff;
    bytes[i * 2 + 1] = g & 0xff;
  }
  return bytes;
}

/**
 * 取 16 字节里嵌入的 IPv4，拼成点分十进制。
 *
 * 这就是把 IPv6 归一化成字节的意义：不管原始写法是点分还是十六进制，
 * 到了这里都变成同一个字符串，交给 isPrivateIpv4 统一判断。
 */
function embeddedIpv4(bytes: Uint8Array): string {
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (METADATA_IPS.has(lower)) return true;

  /*
   * ⚠️ 这里必须按**字节**判断，不能只匹配点分十进制的 `::ffff:a.b.c.d`。
   *
   * 曾经的写法是 `/::ffff:(\d+\.\d+\.\d+\.\d+)$/`，只认点分写法。但 DNS 返回的
   * AAAA 记录通常是十六进制规范形式：`::ffff:7f00:1` 与 `::ffff:127.0.0.1`
   * 是同一个地址，却能大摇大摆地通过私网检测 —— 而这不需要攻击者手写，
   * 只要他控制 DNS 记录就行。同类还有 NAT64（64:ff9b::/96）与 6to4（2002::/16），
   * 它们把 IPv4 地址嵌在固定位置，在双栈主机上是可路由的。
   */
  const bytes = parseIpv6ToBytes(lower);
  if (!bytes) return true; // 解析不了 = 非法地址，fail-closed

  const allZeroPrefix = bytes.slice(0, 10).every((b) => b === 0);

  // ::ffff:0:0/96 —— IPv4 映射：按 IPv4 规则判断（十六进制与点分两种写法都覆盖）
  if (allZeroPrefix && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4(embeddedIpv4(bytes));
  }
  // ::/96 —— IPv4 兼容（已废弃），语义同上
  if (allZeroPrefix && bytes[10] === 0 && bytes[11] === 0) {
    return isPrivateIpv4(embeddedIpv4(bytes));
  }
  // 64:ff9b::/96 与 64:ff9b:1::/48 —— NAT64：嵌入的 IPv4 就是真实目标
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (bytes[4] === 0x00 && bytes[5] === 0x01) return true; // 64:ff9b:1::/48
    if (bytes.slice(4, 12).every((b) => b === 0)) return isPrivateIpv4(embeddedIpv4(bytes));
    return true;
  }
  // 2002::/16 —— 6to4：IPv4 嵌在第 3~6 字节
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPrivateIpv4(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`);
  }

  // 未指定地址 :: 与环回 ::1
  if (bytes.every((b) => b === 0)) return true;
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;

  // 唯一本地地址 fc00::/7
  if ((bytes[0]! & 0xfe) === 0xfc) return true;
  // 链路本地 fe80::/10
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;
  // 多播 ff00::/8
  if (bytes[0] === 0xff) return true;
  // 文档用段 2001:db8::/32
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;

  return false;
}

/**
 * 校验一个 URL 是否可以安全抓取。
 *
 * **DNS Rebinding 防护**是这个函数最容易做错的地方：
 * 朴素做法是「先 resolve 检查 IP 是公网，再交给 fetch 二次解析」——
 * 攻击者控制一个 DNS，第一次解析返回公网 IP（通过检查），
 * 第二次解析（fetch 内部）返回 127.0.0.1，成功绕过。
 *
 * 正确做法：**只解析一次，用校验过的 IP 直接发起请求**
 * （通过自定义 agent 或 lookup 钩子固定解析结果）。
 * 本实现返回校验过的 address，由调用方通过 lookup 复用它。
 */
export interface ValidatedUrl {
  url: URL;
  /** 已校验的 IP，调用方必须用它发起请求，不要让底层库再解析一次 */
  addresses: string[];
}

export async function validateUrl(rawUrl: string): Promise<ValidatedUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('URL 格式无效', 'INVALID_PROTOCOL');
  }

  // 第一层：协议白名单。file:// gopher:// 等可直接读本地文件
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('仅支持 http/https 协议', 'INVALID_PROTOCOL');
  }

  // 第二层：端口白名单。避免扫内网高位端口的探测接口
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (port !== 80 && port !== 443) {
    throw new SsrfError('仅允许 80/443 端口', 'INVALID_PROTOCOL');
  }

  // 第三层：主机白名单（可选，配置了就严格生效）
  const allowed = fetchAllowedHosts();
  if (allowed.length > 0) {
    const host = url.hostname.toLowerCase();
    const ok = allowed.some((h) => host === h || host.endsWith(`.${h}`));
    if (!ok) throw new SsrfError(`主机不在白名单内：${host}`, 'BLOCKED_HOST');
  }

  // 第四层：解析并校验 IP
  let addresses: string[];
  if (net.isIP(url.hostname)) {
    addresses = [url.hostname];
  } else {
    try {
      const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
      addresses = records.map((r) => r.address);
    } catch {
      throw new SsrfError(`域名解析失败：${url.hostname}`, 'DNS_FAILED');
    }
  }

  if (addresses.length === 0) {
    throw new SsrfError('域名未解析到任何地址', 'DNS_FAILED');
  }

  // ⚠️ 所有地址都要校验。攻击者可以让 DNS 返回一个公网 IP + 一个内网 IP，
  // 底层库恰好用了内网的那个。只校验第一个是常见漏洞。
  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new SsrfError(`目标解析到内网地址，已阻止（${addr}）`, 'PRIVATE_IP');
    }
  }

  return { url, addresses };
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** 允许的重定向次数上限 */
  maxRedirects?: number;
}

export interface SafeFetchResult {
  contentType: string;
  /** UTF-8 解码后的文本（超限时会被截断） */
  text: string;
  /** 实际是否发生了截断 */
  truncated: boolean;
  finalUrl: string;
  bytes: number;
}

/**
 * 安全抓取。
 *
 * 每一次重定向都重新做完整校验 —— 否则攻击者用一个 302 就能把已校验的
 * 公网地址重定向到 169.254.169.254。这是最常见的 SSRF 绕过手法。
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const e = env();
  const timeoutMs = options.timeoutMs ?? e.FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? e.FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? 3;

  let currentUrl = rawUrl;
  let response: Response | null = null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await validateUrl(currentUrl);

    // 用已校验的域名解析结果发起请求，避免 DNS Rebinding
    response = await fetchWithPinnedDns(validated.url, validated.addresses, timeoutMs);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new SsrfError('重定向缺少 Location 头', 'TOO_MANY_REDIRECTS');
      }
      // 相对路径重定向要基于当前 URL 解析
      currentUrl = new URL(location, validated.url).toString();
      continue; // 下一跳重新做全部校验
    }

    break;
  }

  if (!response) throw new SsrfError('重定向次数过多', 'TOO_MANY_REDIRECTS');
  if (!response.ok) {
    throw new SsrfError(`目标返回 ${response.status}`, 'BLOCKED_HOST');
  }

  const contentType = response.headers.get('content-type') ?? '';

  // 声明长度超限直接拒，避免为了检查大小先把几百 MB 下下来
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new SsrfError(`响应体过大（${declared} 字节）`, 'TOO_LARGE');
  }

  // 边读边计大小，超限立刻断开。不读完整个 body 是防 OOM 的关键
  const { text, bytes, truncated } = await readWithLimit(response, maxBytes);

  return {
    contentType,
    text,
    truncated,
    finalUrl: currentUrl,
    bytes,
  };
}

async function fetchWithPinnedDns(url: URL, addresses: string[], timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    /**
     * ⚠️ 这里必须用 **undici 自己的 fetch**，不能用全局 fetch（`globalThis.fetch`）。
     *
     * 这是一个花了些时间才定位到的坑：把外部 undici 8 的 Agent 通过 `dispatcher`
     * 交给 Node 内置的 fetch，会直接抛出
     *
     *     TypeError: fetch failed
     *       cause: InvalidArgumentError: invalid onRequestStart method (UND_ERR_INVALID_ARG)
     *
     * 原因是 Node 内置 fetch 用的是**它自己打包的那份 undici**，与 npm 上装的 undici
     * 是两份互不认识的实现 —— Agent/Dispatcher 的握手协议对不上。
     * 症状很误导：HTTP 抓取功能整体不可用（表现为 500「服务内部错误」），
     * 而原生 fetch 单独测又是 200，看起来像网络问题。
     *
     * 正确做法：**fetch 与 Agent 必须来自同一个 undici 实例**。
     * 这也意味着本文件不能依赖 Next.js 打过补丁的全局 fetch（那同样会被换成别的东西）。
     */
    const response = await undiciFetch(url, {
      signal: controller.signal,
      redirect: 'manual', // 自己处理重定向以逐跳校验
      headers: {
        'User-Agent': 'LumenoteBot/1.0 (+https://github.com/your-handle/lumenote)',
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      // 把已校验的 IP 固定进连接层，见 createPinnedDispatcher 的说明
      dispatcher: createPinnedDispatcher(addresses),
      cache: 'no-store',
    });

    // undici 的 Response 与 Web 标准 Response 兼容，但类型来自两个命名空间，
    // 断言一次以统一类型（运行时行为一致：body 为 ReadableStream<Uint8Array>）
    return response as unknown as Response;
  } catch (e) {
    if (controller.signal.aborted) throw new SsrfError('请求超时', 'TIMEOUT');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把 **已校验的 IP** 固定到实际建连上。
 *
 * ## 这一步为什么必须有
 *
 * 只做「resolve → 检查 IP → 交给 fetch」是不够的：fetch（undici）在建连时
 * 会**再解析一次域名**。攻击者控制的 DNS 只要第一次返回公网 IP（通过检查）、
 * 第二次返回 127.0.0.1，就完成了 DNS Rebinding 绕过 —— 这正是 validateUrl
 * 顶部注释里描述的、也是它承诺已经防住的那个攻击。
 *
 * 之前的实现在这里只用了 `addresses.length` 去决定要不要加 cache:'no-store'，
 * 等于**校验结果被接收却没有使用**：注释声称已固定 IP，代码并没有。
 * 文档写着防住了、实际没防住，比没写更危险（后来人会跳过复查）。
 *
 * ## 实现
 *
 * 通过 undici 的自定义 lookup 钩子：只返回预先校验过的地址，且**不按
 * family 重排**（verbatim），让 Node 无法自行选择别的地址。
 * 已实测：故意把已校验地址替换成 127.0.0.1 时请求以 ECONNREFUSED 失败，
 * 说明固定确实作用在建连层，而不只是「传了个参数」。
 *
 * ⚠️ 用 undici 的自定义 dispatcher 就必须配 undici 自己的 fetch，
 * 理由见 fetchWithPinnedDns 里的注释（版本不匹配会 UND_ERR_INVALID_ARG）。
 *
 * 导出以便单测 —— 「攻击者改变 DNS 也无法改道」这件事值得有测试兜住。
 */
export function createPinnedDispatcher(addresses: string[]): Dispatcher {
  const allowed = new Set(addresses);

  /**
   * 自定义 DNS 解析：无论域名解析成什么，只回我们已校验过的地址。
   *
   * ⚠️ 这里是 fail-closed 的：地址列表为空时回错误让连接失败，而不是放行。
   * 安全相关的分支，降级方向必须是「拒绝」而非「照常请求」——
   * 后者等于把 DNS Rebinding 的窗口重新打开，而且出问题时没有任何征兆。
   *
   * 签名上做了一次类型断言：Node 的 dns.lookup 有「单地址」与「all:true 返回数组」
   * 两个重载，undici 只声明了后者。我们的实现同时兼容两者，
   * 用断言表达比写两份函数更清楚。
   */
  const pinnedLookup = (
    _hostname: string,
    options: { all?: boolean },
    callback: (err: Error | null, result?: unknown) => void,
  ) => {
    const list = [...allowed].map((address) => ({
      address,
      family: net.isIP(address) || 4,
    }));

    if (options?.all) {
      callback(null, list);
      return;
    }

    const first = list[0];
    if (!first) {
      callback(new Error('无可用的已校验地址'));
      return;
    }
    callback(null, first);
  };

  return new Agent({
    /**
     * `connect` 整体断言为 never 的说明：
     *
     * undici 的 connect 选项类型来自 net.TcpNetConnectOpts，那里只声明了
     * 「all:true 返回数组」这一种 lookup 形态；而 dns.lookup 实际是双形态
     * （单地址 / all），与运行时事实不符。把断言收敛在这一个字段上，
     * 既表达了差异，又不影响 Agent 其余参数的类型检查。
     */
    connect: { lookup: pinnedLookup } as never,
  });
}

async function readWithLimit(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!response.body) {
    return { text: '', bytes: 0, truncated: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytes += value.byteLength;
      if (bytes > maxBytes) {
        // 超限：只取还允许的那部分，然后主动断开
        const allowed = value.byteLength - (bytes - maxBytes);
        text += decoder.decode(value.subarray(0, Math.max(0, allowed)), { stream: true });
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }

      text += decoder.decode(value, { stream: true });
    }

    if (!truncated) {
      text += decoder.decode();
    }
  } finally {
    reader.releaseLock?.();
  }

  return { text, bytes, truncated };
}

/** 从请求中取 URL 并做基本形态校验（不含网络请求） */
export function extractUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}
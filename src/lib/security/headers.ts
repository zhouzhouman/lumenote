import type { NextResponse } from 'next/server';

/**
 * 安全响应头与 CSP（Report-Only）的单一事实来源。
 *
 * 为什么从 proxy 里抽出来：
 *  1. proxy 的职责是「路由决策」，安全头是另一个关注点，混在一起改一个容易碰坏另一个；
 *  2. 抽成纯函数后可以在 vitest 里直接断言指令内容，不需要起 Next 服务；
 *  3. 以后若改成在 `next.config.ts` 的 `headers()` 里发，也只改这一处。
 *
 * 迁移背景：Next.js 16 起 `middleware.ts` 文件约定被 `proxy.ts` 取代，
 * 且 Proxy **固定运行在 Node.js runtime**（不再有 Edge 限制）。
 * 但本项目的设计**刻意不**在 proxy 里查库：鉴权的真正边界仍在每个
 * API 路由（见 `src/proxy.ts` 顶部注释），proxy 只做乐观检查。
 */

/**
 * 全站静态安全头。
 *
 * - `X-Content-Type-Options: nosniff`
 *    禁止浏览器按内容嗅探 MIME。少了它，用户上传/分享的内容被当成 HTML
 *    执行就是存储型 XSS。
 * - `X-Frame-Options: DENY`
 *    防点击劫持。与 CSP 的 `frame-ancestors 'none'` 是同一策略的
 *    新旧两套写法：现代浏览器看 CSP，老浏览器看 XFO；两者同时发不冲突。
 *    DENY 比 SAMEORIGIN 更严 —— 连同源 iframe 也禁止。本应用没有
 *    iframe 使用场景（分享页是「发链接」而不是「嵌网页」），保持最严。
 * - `Referrer-Policy: strict-origin-when-cross-origin`
 *    同源请求带完整路径，跨源只带 origin，HTTPS→HTTP 降级时不带。
 *    URL 里可能有 task id / share token，不能整段泄漏给第三方。
 * - `X-DNS-Prefetch-Control: off`
 *    关掉浏览器对页面中链接的预解析 DNS，减少向第三方泄漏「用户会点哪里」。
 * - `Permissions-Policy`
 *    显式关闭摄像头/麦克风/定位。默认策略本来就多数是 deny，
 *    但显式声明可以挡住「未来某个 iframe 或依赖默认开启」的回归。
 */
export const STATIC_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-DNS-Prefetch-Control': 'off',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
} as const;

/**
 * HSTS：`includeSubDomains` 但**不**加 `preload`。
 *
 * 只加 preload 需要向浏览器厂商提交域名，而且一旦被预置就极难回滚
 * （在 max-age 到期前，所有子域名的明文 HTTP 都会被强制升级）。
 * 本项目还没确认所有子域名都支持 HTTPS，所以不冒这个险。
 *
 * ⚠️ HSTS 只在**通过 HTTPS 传输**时才会被浏览器采纳；走 HTTP 时
 * 响应里带这个头会被直接忽略。因此它实际生效依赖反向代理/平台
 * 正确终止 TLS（见 docs 的部署说明），本仓库无法自证。
 */
export const HSTS_PRODUCTION_HEADER = 'max-age=31536000; includeSubDomains';

/** CSP 的响应头名。Report-Only：违规只上报/打 console，不阻断渲染。 */
export const CSP_REPORT_ONLY_HEADER = 'Content-Security-Policy-Report-Only';

/**
 * 分享页的爬虫策略：与 `src/app/share/[token]/page.tsx` 里的
 * `metadata.robots = { index: false, follow: false }` **完全一致**。
 *
 * 为什么已经在页面 metadata 里声明了，还要在 HTTP 头里再写一遍：
 *  1. meta robots 只有「爬虫真的渲染并解析 HTML」时才生效；HTTP 头在
 *     响应层面就生效，不依赖渲染结果，覆盖面更稳；
 *  2. 分享 token 出现在 URL 里，一旦被收录，等于把「需要凭链接访问」
 *     的页面永久公开在搜索结果里。这是「索引策略」而不是「权限」，
 *     两道声明成本几乎为零，漏一道的代价却不可逆（搜索引擎缓存难清除）。
 *
 * 这里刻意**不**加 `noarchive`：那会改变现有策略（连快照也不留），
 * 属于产品决策，留给变更请求讨论。
 */
export const SHARE_ROBOTS_HEADER = 'noindex, nofollow';

export type CspMode = 'production' | 'development';

/**
 * 由 `NODE_ENV` 推导 CSP 模式。
 *
 * 非 production（含 test）一律按 development 处理：开发期 Next 需要
 * eval 与较宽的 connect-src，如果这里判错，本地页面会莫名其妙白屏。
 */
export function resolveCspMode(nodeEnv: string | undefined = process.env.NODE_ENV): CspMode {
  return nodeEnv === 'production' ? 'production' : 'development';
}

/**
 * 构造 CSP Report-Only 策略。
 *
 * ## 为什么本轮没有用 nonce
 *
 * Next 支持「proxy 生成 nonce → 通过请求头 `x-nonce` 传给 layout →
 * layout 用 `headers()` 读出来塞进 `<Script nonce>`」的方案，但它有硬代价：
 *  1. `headers()` 一旦在根 layout 里被调用，整站从静态渲染变成**动态渲染**，
 *     静态页面的 CDN 缓存全部失效 —— 这是性能架构级变更，不该混在
 *     一次「安全头补齐 + 文件迁移」里悄悄做掉；
 *  2. 需要把 nonce 透传到每个 `<script>`/`<style>`，遗漏一处就是真实拦截；
 *  3. 本轮的 CSP 是 Report-Only（不拦截），nonce 的价值（让 `script-src`
 *     可以去掉 `'unsafe-inline'`）在 Report-Only 下也无法兑现收益。
 *
 * 所以本轮 `script-src` 保留 `'unsafe-inline'`，并在报告里把它列为
 * 「CSP 收紧到 Enforce 之前必须解决」的已知项。开发模式额外需要
 * `'unsafe-eval'`（React Refresh / Next 的 HMR runtime 会 eval）。
 *
 * ## 其他选择说明
 *
 * - `style-src 'unsafe-inline'`：Next 会注入内联 `<style>`，Tailwind 的
 *   运行时也是。去掉它需要同样引入 nonce/hash 机制，理由同上。
 * - `img-src data: blob:`：Next 的图片占位、以及可能的 canvas/blob 预览。
 * - `connect-src`：SSE 走同源 `/api/tasks/[id]/stream`，`'self'` 已覆盖；
 *   开发模式补 `ws:`/`wss:`，否则 HMR WebSocket 会被 Report-Only 记录。
 * - 不加 `upgrade-insecure-requests`：规范规定它在 Report-Only 下被忽略，
 *   写进去只会制造「好像做了混合内容防护」的错觉；等切换 Enforce 时再加。
 * - 不配 `report-uri`/`report-to`：本仓库没有收集端点。没有端点的
 *   Report-Only 等价于「把违规打印到浏览器 console」，这也是本轮
 *   唯一能拿到的反馈通道（无浏览器时见报告的验证局限性说明）。
 */
export function buildCspReportOnly(mode: CspMode): string {
  const isDev = mode === 'development';

  /**
   * 指令顺序固定（对象插入顺序），便于快照/断言与人工比对。
   * 值用数组而不是拼接字符串，避免手写时漏空格。
   */
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', isDev ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"] : ["'self'", "'unsafe-inline'"]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', isDev ? ["'self'", 'ws:', 'wss:'] : ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-src', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
  ];

  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

export interface ApplySecurityHeadersOptions {
  /** 不传则按 `NODE_ENV` 推导。显式传入便于测试与以后分环境配置。 */
  cspMode?: CspMode;
}

/**
 * 把安全头写到响应上（原地修改并返回同一个对象）。
 *
 * 注意：**重定向响应也要调用它**。旧 middleware 只给 `NextResponse.next()`
 * 加头，`/workspace → /login` 的 307 响应是没有安全头的；虽然重定向
 * 响应本身不渲染 HTML，攻击面小，但「所有出站响应都有安全头」是更容易
 * 审计和测试的不变式，所以统一加上。
 */
export function applySecurityHeaders<T extends NextResponse>(
  res: T,
  options: ApplySecurityHeadersOptions = {},
): T {
  const mode = options.cspMode ?? resolveCspMode();

  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    res.headers.set(name, value);
  }

  // 仅生产发 HSTS：开发期常跑在 http://localhost，虽然浏览器会忽略
  // HTTP 上的 HSTS，但若本地起了自签 HTTPS，这个头会把 localhost
  // 连同所有子域 pin 住一年，排查起来非常难受。生产必须由反代提供 HTTPS。
  if (mode === 'production') {
    res.headers.set('Strict-Transport-Security', HSTS_PRODUCTION_HEADER);
  }

  res.headers.set(CSP_REPORT_ONLY_HEADER, buildCspReportOnly(mode));

  return res;
}

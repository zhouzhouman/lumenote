import { NextResponse, type NextRequest } from 'next/server';
import { SHARE_ROBOTS_HEADER, applySecurityHeaders, resolveCspMode } from '@/lib/security/headers';

/**
 * 路由保护与安全响应头（Next.js 16 的 `proxy` 文件约定）。
 *
 * ## 为什么从 middleware.ts 改名成 proxy.ts
 *
 * Next.js 16 起，根目录/`src` 下的 `middleware` 文件约定被标记弃用，
 * 新约定是 `proxy`。本文件是按 Next.js **16.4.0 本地源码**核实后迁移的，
 * 依据（都在 `node_modules/next/dist/` 里可查）：
 *
 *  - `lib/constants.js`：`PROXY_FILENAME = 'proxy'`，
 *    `PROXY_LOCATION_REGEXP = (?:src/)?proxy`；
 *  - `build/index.js`：同时发现 `middleware.ts` 与 `proxy.ts` 会直接
 *    抛错（"Both middleware file ... and proxy file ... are detected"），
 *    所以旧文件必须删除，不能并存；
 *  - `build/templates/middleware.js`：`const handlerUserland = (isProxy ?
 *    mod.proxy : mod.middleware) || mod.default` —— **具名 `proxy` 导出
 *    或 default 导出**都可以，二者取其一；
 *  - `build/analysis/get-page-static-info.js`：`config.matcher` 仍然走
 *    `getMiddlewareMatchers()` 解析，文件约定名不影响 matcher 语义；
 *  - 同一文件里对 proxy 文件有硬限制：
 *    "Route segment config is not allowed in Proxy file ... Proxy always
 *    runs on Node.js runtime." —— 即 **Proxy 固定跑 Node.js runtime**，
 *    不允许 `export const runtime = ...`（写了 build 直接失败）。
 *
 * 因此本文件**没有** `runtime` 导出。也正因为已经是 Node runtime，
 * 技术上可以在这里 import Prisma 查库 —— 但本文件**刻意不这么做**，
 * 理由见下面「双层鉴权」。
 *
 * ## 为什么鉴权「看起来」在 proxy 里做了，实际却是在 API 层做的
 *
 * 这里只做「**乐观检查**」：判断 cookie 是否存在，判断 path 是否需要登录。
 * 真正的鉴权在每个 API 路由里（requireUserId → 验签 → 查 DB）。
 *
 * proxy 只是为了「未登录用户访问 /workspace 时直接跳登录页」，
 * 少一次无用的页面渲染。真正的安全边界绝不能建立在 proxy 上 ——
 * 否则绕过 proxy 直接打 API 就进去了。
 *
 * 每请求查一次 DB 验证 token 也不是不行（Node runtime 允许），但那会让
 * 每个静态资源/页面导航都多一次数据库往返，把「体验优化」做成性能瓶颈；
 * 而校验逻辑一旦在 proxy 与 API 两处各写一遍，就必然出现判据漂移
 * （下面注释里的重定向死循环就是这么来的）。
 */

/** 需要登录才能访问的路径前缀 */
const PROTECTED_PREFIXES = ['/workspace', '/history', '/usage', '/templates', '/glossary', '/dashboard', '/settings'];

const AUTH_PAGES = ['/login', '/register'];

/** 乐观判断「已登录」的 cookie 名，必须与 (app)/layout.tsx、API 层一致 */
const ACCESS_COOKIE = 'lumenote_access';

/**
 * CSP 模式在模块加载时算一次即可（`NODE_ENV` 在进程生命周期内不变），
 * 避免每个请求重复推导。
 */
const CSP_MODE = resolveCspMode();

/**
 * Next.js 16 Proxy 主函数。
 *
 * ⚠️ 导出名必须是 `proxy`（或 default）。这是 Next 的约定：
 * 具名导出叫 `middleware` 的文件已经不被 proxy 文件接受，
 * 改名时若只改文件名不改导出名，build 会报
 * "must export a function named `proxy` or a default function"。
 */
export function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const hasSessionCookie = hasSessionCookiePresent(req);

  /**
   * 已登录用户访问登录/注册页 → 直接进工作台。
   *
   * ⚠️ 这里只能看 **access** cookie，不能把 refresh cookie 也算作「已登录」。
   *
   * access token 只有 15 分钟有效期，而 refresh token 有 7 天。
   * 曾经这里两者都认，于是 access 过期后的场景（最常见的场景！）变成死循环：
   *   /workspace → 布局验 access 失败 → redirect /login
   *   /login    → proxy 看到 refresh 还在 → redirect /workspace
   *   → ERR_TOO_MANY_REDIRECTS，用户必须手动清 cookie 才能恢复。
   *
   * 判据不一致是这类循环的根源：**两个地方对「已登录」的定义必须完全相同**。
   * 现在两边都以 access cookie 为准，代价只是 access 过期时会短暂渲染登录页
   * （此时提交登录即可，比整站卡死好得多）。
   */
  if (AUTH_PAGES.includes(pathname) && hasSessionCookie) {
    return withSecurityHeaders(NextResponse.redirect(new URL('/workspace', req.url)), pathname);
  }

  if (isProtectedPath(pathname) && !hasSessionCookie) {
    const loginUrl = new URL('/login', req.url);
    // 记住来源，登录后跳回。⚠️ 带上 search 而不只是 pathname，
    // 否则 /history?q=xxx 这种带状态的链接登录后会丢失筛选条件
    const next = `${pathname}${req.nextUrl.search}`;
    if (next.startsWith('/')) loginUrl.searchParams.set('next', next);
    return withSecurityHeaders(NextResponse.redirect(loginUrl), pathname);
  }

  // 放行：附上安全响应头（含 CSP Report-Only）
  return withSecurityHeaders(NextResponse.next(), pathname);
}

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * 是否存在**有效会话的乐观信号**。
 *
 * 只看 access cookie：refresh cookie 存在不代表能用，
 * 把它计入会与 (app)/layout.tsx 的判据打架，产生重定向循环（见上面注释）。
 */
function hasSessionCookiePresent(req: NextRequest): boolean {
  return req.cookies.get(ACCESS_COOKIE) !== undefined;
}

/**
 * 所有出站响应统一加安全头。
 *
 * 旧 middleware 只给放行响应加头，重定向响应是「裸」的；这里统一加，
 * 让「每个经过 proxy 的响应都有安全头」成为可断言的不变式。
 *
 * 另外，分享页额外加 `X-Robots-Tag`：页面本身已有
 * `metadata.robots = { index: false, follow: false }`，这里在 HTTP 层
 * 再声明一次，理由见 `SHARE_ROBOTS_HEADER` 的注释。
 */
function withSecurityHeaders(res: NextResponse, pathname: string): NextResponse {
  applySecurityHeaders(res, { cspMode: CSP_MODE });
  if (isSharePath(pathname)) {
    res.headers.set('X-Robots-Tag', SHARE_ROBOTS_HEADER);
  }
  return res;
}

/** `/share/[token]` 及其子路径。注意 `/shares` 之类不应命中。 */
function isSharePath(pathname: string): boolean {
  return pathname === '/share' || pathname.startsWith('/share/');
}

/**
 * matcher：决定哪些请求进入 proxy。
 *
 * 语义与迁移前完全一致（Next 16 仍然解析 `config.matcher`，
 * 见 `getMiddlewareMatchers`）。
 *
 * 排除：
 *  - `_next/static`、`_next/image`：静态资源。给每个 chunk 加安全头没有意义，
 *    只会增大响应头体积；尤其 `_next/image` 的响应还会有自己的缓存语义。
 *    （代价：这些响应不带安全头，属已知且可接受的例外。）
 *  - `api/health`：探活端点不应因未登录而 302（那会让监控误判服务不可用）。
 *    注意它也因此不带安全头 —— 探活响应只有状态码，无内容可渲染。
 *  - `favicon.ico`、`robots.txt`：浏览器/爬虫的固定探测路径，
 *    让它们直接走静态文件，不进入 proxy。
 */
export const config = {
  matcher: [
    /*
     * 排除：
     *  - _next/static、_next/image：静态资源
     *  - api/health：探活端点不应因未登录而 302（那会让监控误判服务不可用）
     *  - favicon、robots.txt
     */
    '/((?!_next/static|_next/image|api/health|favicon.ico|robots.txt).*)',
  ],
};

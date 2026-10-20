import { NextResponse, type NextRequest } from 'next/server';

/**
 * 路由保护与安全响应头。
 *
 * ## 为什么鉴权「看起来」在 middleware 里做了，实际却是在 API 层做的
 *
 * 因为 middleware 运行在 Edge Runtime，无法访问 Node 的 crypto 与 Prisma，
 * 拿不到 DB 去验证 token 是否真实有效。这里只能做「**乐观检查**」：
 * 判断 cookie 是否存在，判断 path 是否需要登录。
 *
 * **真正的鉴权在每个 API 路由里**（requireUserId → 验签 → 查 DB）。
 * middleware 只是为了「未登录用户访问 /workspace 时直接跳登录页」，
 * 少一次无用的页面渲染。真正的安全边界绝不能建立在 middleware 上 ——
 * 否则绕过 middleware 直接打 API 就进去了。
 *
 * 这个「双层鉴权」的分工要说清楚：middleware 是体验优化，不是安全边界。
 */

/** 需要登录才能访问的路径前缀 */
const PROTECTED_PREFIXES = ['/workspace', '/history', '/usage', '/templates', '/glossary', '/dashboard', '/settings'];

const AUTH_PAGES = ['/login', '/register'];

export function middleware(req: NextRequest) {
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
   *   /login    → middleware 看到 refresh 还在 → redirect /workspace
   *   → ERR_TOO_MANY_REDIRECTS，用户必须手动清 cookie 才能恢复。
   *
   * 判据不一致是这类循环的根源：**两个地方对「已登录」的定义必须完全相同**。
   * 现在两边都以 access cookie 为准，代价只是 access 过期时会短暂渲染登录页
   * （此时提交登录即可，比整站卡死好得多）。
   */
  if (AUTH_PAGES.includes(pathname) && hasSessionCookie) {
    return NextResponse.redirect(new URL('/workspace', req.url));
  }

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (isProtected && !hasSessionCookie) {
    const loginUrl = new URL('/login', req.url);
    // 记住来源，登录后跳回。⚠️ 带上 search 而不只是 pathname，
    // 否则 /history?q=xxx 这种带状态的链接登录后会丢失筛选条件
    const next = `${pathname}${req.nextUrl.search}`;
    if (next.startsWith('/')) loginUrl.searchParams.set('next', next);
    return NextResponse.redirect(loginUrl);
  }

  // 附加安全响应头
  const res = NextResponse.next();
  applySecurityHeaders(res);
  return res;
}

/**
 * 是否存在**有效会话的乐观信号**。
 *
 * 只看 access cookie：refresh cookie 存在不代表能用，
 * 把它计入会与 (app)/layout.tsx 的判据打架，产生重定向循环（见上面注释）。
 */
function hasSessionCookiePresent(req: NextRequest): boolean {
  return req.cookies.get('lumenote_access') !== undefined;
}

/**
 * 安全响应头。
 *
 * CSP 这里用了较宽松的形式，原因是 Next.js 的开发模式需要 inline script 与
 * eval。生产环境应进一步收紧 —— 这里刻意不写死一个「看起来很严格」的 CSP，
 * 因为写了一个无法在开发模式生效的 CSP 反而会误导人以为防护已就位。
 */
function applySecurityHeaders(res: NextResponse) {
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY'); // 防点击劫持
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('X-DNS-Prefetch-Control', 'off');
  res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // 分享页需要被搜索引擎看到，故未对全站禁用索引
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

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
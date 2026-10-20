import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy, config } from '@/proxy';

/**
 * proxy.ts 的行为测试。
 *
 * 直接 import proxy 函数并用 `NextRequest` 构造请求，不启动 Next 服务：
 * proxy 本身是纯函数（输入 request，输出 response），这是它最值得测的部分。
 * 真正的端到端验证（响应头是否真的出现在线上响应里）由报告中的
 * dev server + curl 实测覆盖，两者互补。
 */

const BASE = 'http://localhost:3000';

function makeRequest(path: string, opts: { accessToken?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.accessToken) {
    // 模拟浏览器同时带 refresh + access 的场景时，也传 accessToken 即可
    headers.set('cookie', `lumenote_access=${opts.accessToken}; lumenote_refresh=refresh-token`);
  }
  return new NextRequest(`${BASE}${path}`, { headers });
}

/** 解析重定向的 Location，并把 `next` 参数解出来（避免手写编码断言） */
function redirectInfo(res: Response): { pathname: string; next: string | null } {
  const location = res.headers.get('location');
  if (!location) throw new Error('响应没有 Location 头');
  const url = new URL(location);
  return { pathname: url.pathname, next: url.searchParams.get('next') };
}

describe('proxy: 未登录访问受保护路径', () => {
  it.each([
    '/workspace',
    '/history',
    '/usage',
    '/templates',
    '/glossary',
    '/dashboard',
    '/settings',
  ])('%s → 302/307 重定向到 /login，并带上 next', (path) => {
    const res = proxy(makeRequest(path));

    expect(res.status).toBe(307);
    const { pathname, next } = redirectInfo(res);
    expect(pathname).toBe('/login');
    expect(next).toBe(path);
  });

  it('子路径也被保护，且 next 保留完整 pathname', () => {
    const res = proxy(makeRequest('/history/abc-123'));
    expect(res.status).toBe(307);
    expect(redirectInfo(res)).toEqual({ pathname: '/login', next: '/history/abc-123' });
  });

  it('next 参数保留 query string（登录后筛选条件不丢）', () => {
    const res = proxy(makeRequest('/history?q=ai&page=2'));
    expect(res.status).toBe(307);
    // 只断言语义：next 的值必须是「路径 + 原始 search」
    expect(redirectInfo(res).next).toBe('/history?q=ai&page=2');
  });

  it('前缀匹配有边界：/workspacefoo 不是受保护路径', () => {
    const res = proxy(makeRequest('/workspacefoo'));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('/api/* 不在 protected 前缀里：API 鉴权由路由自己负责，proxy 不重定向', () => {
    const res = proxy(makeRequest('/api/tasks'));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('proxy: 已登录访问登录/注册页', () => {
  it.each(['/login', '/register'])('%s → 重定向 /workspace', (path) => {
    const res = proxy(makeRequest(path, { accessToken: 'valid-access-token' }));

    expect(res.status).toBe(307);
    const location = res.headers.get('location');
    expect(new URL(location!).pathname).toBe('/workspace');
  });

  it('/login?next=/history 也直接进 /workspace（登录态下 next 无意义）', () => {
    const res = proxy(makeRequest('/login?next=/history', { accessToken: 'valid-access-token' }));
    expect(new URL(res.headers.get('location')!).pathname).toBe('/workspace');
  });

  it('已登录访问受保护页正常放行', () => {
    const res = proxy(makeRequest('/workspace', { accessToken: 'valid-access-token' }));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('proxy: 公开路径放行', () => {
  it.each(['/', '/share/some-token', '/login', '/register', '/api/health'])(
    '%s 放行（无 Location，x-middleware-next=1）',
    (path) => {
      const res = proxy(makeRequest(path));
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('x-middleware-next')).toBe('1');
    },
  );

  it('放行响应带齐静态安全头', () => {
    const res = proxy(makeRequest('/'));

    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('x-dns-prefetch-control')).toBe('off');
    expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('放行响应带 CSP Report-Only，且至少包含 7 个指令', () => {
    const res = proxy(makeRequest('/'));
    const csp = res.headers.get('content-security-policy-report-only');

    expect(csp).toBeTruthy();
    // Report-Only 不应同时发 enforceable 的 CSP（那会直接拦截）
    expect(res.headers.get('content-security-policy')).toBeNull();

    const directives = (csp as string).split(';').map((d) => d.trim().split(/\s+/)[0]);
    for (const required of [
      'default-src',
      'script-src',
      'style-src',
      'img-src',
      'connect-src',
      'frame-ancestors',
      'font-src',
    ]) {
      expect(directives).toContain(required);
    }
    expect(directives.length).toBeGreaterThanOrEqual(7);
  });

  it('重定向响应也带安全头（不只是放行响应）', () => {
    const res = proxy(makeRequest('/workspace'));

    expect(res.status).toBe(307);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy-report-only')).toBeTruthy();
  });

  it('分享页额外带 X-Robots-Tag: noindex, nofollow（与页面 metadata 一致）', () => {
    const res = proxy(makeRequest('/share/abcdefghijklmnop1234'));
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('非分享页不带 X-Robots-Tag（全站不禁索引）', () => {
    for (const path of ['/', '/login', '/workspace', '/shares']) {
      expect(proxy(makeRequest(path)).headers.get('x-robots-tag')).toBeNull();
    }
  });
});

describe('proxy: config.matcher', () => {
  /** 把 matcher 源码当作以 `/` 开头的整段正则来用（本项目 matcher 恰好就是这个形态） */
  function matcherRegex(): RegExp {
    const source = config.matcher[0];
    return new RegExp(`^${source}$`);
  }

  it('只有一个 matcher，且保留原排除项字面量', () => {
    expect(config.matcher).toHaveLength(1);
    for (const excluded of ['_next/static', '_next/image', 'api/health', 'favicon.ico', 'robots.txt']) {
      expect(config.matcher[0]).toContain(excluded);
    }
  });

  it.each([
    '/workspace',
    '/history',
    '/history/abc',
    '/share/token-123',
    '/login',
    '/api/tasks',
    '/api/tasks/abc/stream',
  ])('%s 会进入 proxy', (path) => {
    expect(matcherRegex().test(path)).toBe(true);
  });

  it.each([
    '/_next/static/chunks/main.js',
    '/_next/image',
    '/api/health',
    '/favicon.ico',
    '/robots.txt',
  ])('%s 被 matcher 排除', (path) => {
    expect(matcherRegex().test(path)).toBe(false);
  });
});

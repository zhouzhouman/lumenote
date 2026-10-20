import { describe, it, expect } from 'vitest';
import { NextResponse } from 'next/server';
import {
  STATIC_SECURITY_HEADERS,
  HSTS_PRODUCTION_HEADER,
  CSP_REPORT_ONLY_HEADER,
  SHARE_ROBOTS_HEADER,
  resolveCspMode,
  buildCspReportOnly,
  applySecurityHeaders,
  type CspMode,
} from '@/lib/security/headers';

/**
 * 安全响应头与 CSP 构造函数的单元测试。
 *
 * 这里测的是「写到响应头上的值」与「CSP 指令内容」，不依赖 Next 运行时。
 * 头部是否真的出现在线上响应中，由 dev server 的 curl 实测覆盖。
 */

function parseDirectives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const chunk of csp.split(';')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const [name, ...values] = trimmed.split(/\s+/);
    map.set(name, values);
  }
  return map;
}

describe('STATIC_SECURITY_HEADERS', () => {
  it('五个静态头取值与迁移前完全一致', () => {
    expect(STATIC_SECURITY_HEADERS).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-DNS-Prefetch-Control': 'off',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
  });

  it('HSTS 值包含一年 max-age 与 includeSubDomains，且不含 preload', () => {
    expect(HSTS_PRODUCTION_HEADER).toBe('max-age=31536000; includeSubDomains');
    expect(HSTS_PRODUCTION_HEADER).not.toContain('preload');
  });

  it('分享页爬虫指令与页面 metadata 对齐（noindex, nofollow）', () => {
    expect(SHARE_ROBOTS_HEADER).toBe('noindex, nofollow');
  });
});

describe('resolveCspMode', () => {
  it('production → production', () => {
    expect(resolveCspMode('production')).toBe('production');
  });

  it.each(['development', 'test', undefined])('%s → development', (env) => {
    expect(resolveCspMode(env)).toBe('development');
  });
});

describe('buildCspReportOnly', () => {
  const production = buildCspReportOnly('production');
  const development = buildCspReportOnly('development');

  it('生产模式覆盖需求要求的全部指令', () => {
    const directives = parseDirectives(production);
    for (const required of [
      'default-src',
      'script-src',
      'style-src',
      'img-src',
      'connect-src',
      'frame-ancestors',
      'font-src',
    ]) {
      expect(directives.has(required)).toBe(true);
    }
  });

  it('生产模式：script-src 不含 unsafe-eval，connect-src 只有 self', () => {
    const directives = parseDirectives(production);

    expect(directives.get('script-src')).toContain("'self'");
    expect(directives.get('script-src')).toContain("'unsafe-inline'");
    expect(directives.get('script-src')).not.toContain("'unsafe-eval'");

    expect(directives.get('connect-src')).toEqual(["'self'"]);
  });

  it('开发模式：script-src 允许 unsafe-eval，connect-src 允许 ws/wss（HMR）', () => {
    const directives = parseDirectives(development);

    expect(directives.get('script-src')).toContain("'unsafe-eval'");
    expect(directives.get('connect-src')).toContain('ws:');
    expect(directives.get('connect-src')).toContain('wss:');
  });

  it('点击劫持与插件类指令是关闭态', () => {
    const directives = parseDirectives(production);

    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('frame-src')).toEqual(["'none'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'self'"]);
    expect(directives.get('form-action')).toEqual(["'self'"]);
  });

  it('不包含 upgrade-insecure-requests（Report-Only 下规范规定被忽略）', () => {
    expect(production).not.toContain('upgrade-insecure-requests');
    expect(development).not.toContain('upgrade-insecure-requests');
  });

  it('指令之间分隔干净：每个指令非空且以空格分词', () => {
    for (const chunk of production.split(';')) {
      expect(chunk.trim()).not.toBe('');
      expect(chunk.trim()).not.toMatch(/\s{2,}/);
    }
  });
});

describe('applySecurityHeaders', () => {
  it('生产模式：五个静态头 + HSTS + CSP Report-Only', () => {
    const res = applySecurityHeaders(NextResponse.next(), { cspMode: 'production' });

    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('x-dns-prefetch-control')).toBe('off');
    expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(res.headers.get('strict-transport-security')).toBe(HSTS_PRODUCTION_HEADER);
    expect(res.headers.get(CSP_REPORT_ONLY_HEADER)).toBe(buildCspReportOnly('production'));
  });

  it.each<CspMode>(['development', 'production'])('%s 模式都不发 enforced CSP', (mode) => {
    const res = applySecurityHeaders(NextResponse.next(), { cspMode: mode });
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('开发模式不发 HSTS（避免 pin 住 localhost）', () => {
    const res = applySecurityHeaders(NextResponse.next(), { cspMode: 'development' });
    expect(res.headers.get('strict-transport-security')).toBeNull();
    expect(res.headers.get(CSP_REPORT_ONLY_HEADER)).toBeTruthy();
  });

  it('返回同一个响应对象（可在链式调用里使用）', () => {
    const original = NextResponse.next();
    expect(applySecurityHeaders(original, { cspMode: 'development' })).toBe(original);
  });
});

import { describe, it, expect } from 'vitest';
import { resolveCookieSecure, resolveCookieDomain } from '@/lib/auth/jwt';

/**
 * 这组用例来自一个真实的部署故障：
 *
 *   生产环境写死 `secure: true` + `domain: <APP_URL 的 host>`，
 *   而内网部署是 `http://192.168.1.10:3000` —— 浏览器直接丢弃 Cookie，
 *   表现为「登录接口 200，页面还是未登录」，且没有任何报错。
 *
 * 所以这里的每一条都对应一种真实部署形态。
 */
describe('resolveCookieSecure：按协议推断，不按 NODE_ENV 一刀切', () => {
  it('生产 + HTTP 局域网地址 → 不加 Secure（否则 Cookie 被浏览器丢弃）', () => {
    expect(
      resolveCookieSecure({ nodeEnv: 'production', appUrl: 'http://192.168.1.10:3000' }),
    ).toBe(false);
  });

  it('生产 + HTTPS → 加 Secure（公网必须）', () => {
    expect(
      resolveCookieSecure({ nodeEnv: 'production', appUrl: 'https://note.example.com' }),
    ).toBe(true);
  });

  it('没有 APP_URL 时按环境兜底：生产从严', () => {
    expect(resolveCookieSecure({ nodeEnv: 'production' })).toBe(true);
    expect(resolveCookieSecure({ nodeEnv: 'development' })).toBe(false);
  });

  it('COOKIE_SECURE 显式设置优先于一切推断', () => {
    expect(
      resolveCookieSecure({
        nodeEnv: 'production',
        appUrl: 'http://intranet.local',
        cookieSecure: 'true',
      }),
    ).toBe(true);
    expect(
      resolveCookieSecure({
        nodeEnv: 'production',
        appUrl: 'https://note.example.com',
        cookieSecure: 'false',
      }),
    ).toBe(false);
  });

  it('显式值前后有空格也能识别（.env 手写常见）', () => {
    expect(resolveCookieSecure({ cookieSecure: ' false ' })).toBe(false);
  });
});

describe('resolveCookieDomain：默认 host-only', () => {
  it('不配置时返回 undefined（浏览器绑定到当前主机名）', () => {
    expect(resolveCookieDomain({})).toBeUndefined();
    expect(resolveCookieDomain({ cookieDomain: '   ' })).toBeUndefined();
  });

  it('显式配置时原样返回（跨子域共享场景）', () => {
    expect(resolveCookieDomain({ cookieDomain: '.example.com' })).toBe('.example.com');
  });
});

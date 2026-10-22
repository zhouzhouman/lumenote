import { describe, it, expect } from 'vitest';
import { checkUrlInput, isBlockedHostLiteral, URL_INPUT_HINTS } from '@/lib/input/url';

/**
 * 链接输入判定。
 *
 * 口径必须与后端一致（`safe-fetch.ts` 的 extractUrl + SSRF 拦截）：
 * 前端放行的格式，后端不能拒；前端拦下的，必须给得出理由。
 */
describe('checkUrlInput：放行可用的链接格式', () => {
  it.each([
    'https://example.com/article',
    'http://example.com',
    'https://example.com/a/b?x=1&y=2#frag',
    'HTTPS://EXAMPLE.COM/UP',
    '  https://example.com/padded  ',
  ])('接受 %s', (input) => {
    expect(checkUrlInput(input).ok).toBe(true);
  });
});

describe('checkUrlInput：拒绝并说明原因', () => {
  it('拒绝空输入', () => {
    const r = checkUrlInput('   ');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('粘贴');
  });

  it.each(['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)'])(
    '拒绝非 http(s) 协议：%s',
    (input) => {
      const r = checkUrlInput(input);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('http');
    },
  );

  it('拒绝缺少协议的裸域名（后端 extractUrl 也不认）', () => {
    const r = checkUrlInput('example.com/article');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('http://');
  });

  it('拒绝一次贴多个链接（含空格）', () => {
    const r = checkUrlInput('https://a.com/x https://b.com/y');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('一次只能填一个');
  });

  it('拒绝内网与本地地址', () => {
    for (const u of [
      'http://localhost:3000/',
      'http://127.0.0.1/',
      'http://192.168.1.10/',
      'http://10.0.0.5/',
      'http://169.254.169.254/latest/meta-data/',
      'http://172.16.3.4/',
      'http://[::1]/',
    ]) {
      const r = checkUrlInput(u);
      expect(r.ok, u).toBe(false);
      expect(r.reason, u).toContain('内网');
    }
  });

  it('172.32.x 不在私有段内，应放行（边界不能拍脑袋）', () => {
    expect(checkUrlInput('http://172.32.0.1/').ok).toBe(true);
  });
});

describe('isBlockedHostLiteral', () => {
  it('大小写与 IPv6 方括号都能处理', () => {
    expect(isBlockedHostLiteral('LOCALHOST')).toBe(true);
    expect(isBlockedHostLiteral('[::1]')).toBe(true);
    expect(isBlockedHostLiteral('example.com')).toBe(false);
  });
});

describe('URL_INPUT_HINTS：提示文案', () => {
  it('三条提示，且分别覆盖格式 / 内容类型 / SSRF', () => {
    expect(URL_INPUT_HINTS).toHaveLength(3);
    expect(URL_INPUT_HINTS[0]).toContain('http://');
    expect(URL_INPUT_HINTS[1]).toContain('PDF');
    expect(URL_INPUT_HINTS[2]).toContain('SSRF');
  });
});

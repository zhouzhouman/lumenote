import { describe, it, expect } from 'vitest';
import { smtpTransportOptions } from '@/lib/mail/mailer';

/**
 * SMTP 连接参数推导。
 *
 * 这些分支的特点是「配错了不会报错，只会发不出去」，而报错又发生在
 * 用户点「获取验证码」的那一刻 —— 所以必须在这里钉死。
 */
describe('smtpTransportOptions：中继模式', () => {
  it('缺 SMTP_HOST 且不直投 → 明确报错（不静默退回 console）', () => {
    const r = smtpTransportOptions({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('SMTP_HOST');
  });

  it('给了 host：默认 587 + 不直连 TLS', () => {
    const r = smtpTransportOptions({ host: 'mail.intra.local' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.port).toBe(587);
      expect(r.options.secure).toBe(false);
      expect(r.options.host).toBe('mail.intra.local');
      expect(r.options.direct).toBe(false);
    }
  });

  it('端口 465 自动切到直连 TLS', () => {
    const r = smtpTransportOptions({ host: 'mail.intra.local', port: 465 });
    expect(r.ok && r.options.secure).toBe(true);
  });

  it('显式 SMTP_SECURE=false 优先于端口推断（自签内网 465）', () => {
    const r = smtpTransportOptions({ host: 'mail.intra.local', port: 465, secure: 'false' });
    expect(r.ok && r.options.secure).toBe(false);
  });

  it('账号密码成对出现才启用认证', () => {
    const withAuth = smtpTransportOptions({
      host: 'mail.intra.local',
      user: 'bot@intra.local',
      pass: 'secret',
    });
    expect(withAuth.ok && withAuth.options.auth?.user).toBe('bot@intra.local');

    const noAuth = smtpTransportOptions({ host: 'mail.intra.local' });
    expect(noAuth.ok && noAuth.options.auth).toBeUndefined();
  });

  it('只有 SMTP_USER 没有密码 → 报错，而不是带着空密码去撞 535', () => {
    const r = smtpTransportOptions({ host: 'mail.intra.local', user: 'bot@intra.local' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('SMTP_PASS');
  });

  it('证书校验默认开，只有显式 false 才放宽', () => {
    const strict = smtpTransportOptions({ host: 'm.local' });
    expect(strict.ok && strict.options.tls.rejectUnauthorized).toBe(true);

    const lax = smtpTransportOptions({ host: 'm.local', rejectUnauthorized: false });
    expect(lax.ok && lax.options.tls.rejectUnauthorized).toBe(false);
  });

  it('连接超时是有限的（配错地址不该把请求吊死）', () => {
    const r = smtpTransportOptions({ host: 'm.local' });
    if (r.ok) {
      expect(r.options.connectionTimeout).toBeLessThanOrEqual(15_000);
      expect(r.options.greetingTimeout).toBeLessThanOrEqual(15_000);
      expect(r.options.socketTimeout).toBeGreaterThanOrEqual(r.options.connectionTimeout);
    }
  });
});

describe('smtpTransportOptions：直投 MX 模式', () => {
  it('direct 时可以不填 host，端口默认 25', () => {
    const r = smtpTransportOptions({ direct: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.direct).toBe(true);
      expect(r.options.port).toBe(25);
      expect(r.options.host).toBeUndefined();
    }
  });

  it('direct 与 host 同时给出时保留 host（定向中继的私有用法）', () => {
    const r = smtpTransportOptions({ direct: true, host: '10.0.0.9' });
    expect(r.ok && r.options.host).toBe('10.0.0.9');
  });
});

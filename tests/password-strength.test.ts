import { describe, it, expect } from 'vitest';
import { assessPasswordStrength, validatePasswordStrength } from '@/lib/password-strength';

/**
 * 密码强度评估的单测。
 *
 * 这块逻辑的价值在于「给用户可操作的反馈」，所以测试重点不是分数本身，
 * 而是：**常见弱密码必须被识别出来，且提示要具体到能照着改**。
 */

describe('assessPasswordStrength', () => {
  it('空密码是最低档', () => {
    const r = assessPasswordStrength('');
    expect(r.score).toBe(0);
    expect(r.level).toBe('很弱');
    expect(r.hints.length).toBeGreaterThan(0);
  });

  it('常见弱密码被压到最低档', () => {
    for (const weak of ['123456', 'password', 'qwerty123', 'admin888', 'abc123', 'woaini520']) {
      const r = assessPasswordStrength(weak);
      expect(r.score, weak).toBeLessThanOrEqual(1);
      expect(r.level, weak).toMatch(/很弱|弱/);
    }
  });

  it('纯数字被明确扣分并给出原因', () => {
    const r = assessPasswordStrength('8364927150');
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.hints.join()).toMatch(/不要只用数字|弱口令/);
  });

  it('纯字母被提示易受字典攻击', () => {
    const r = assessPasswordStrength('abcdefghijkl');
    expect(r.hints.join()).toContain('字典');
  });

  it('长度是主要维度：越长越高', () => {
    const short = assessPasswordStrength('Ab3!xy');
    const medium = assessPasswordStrength('Ab3!xyzw');
    const long = assessPasswordStrength('Ab3!xyzwqrst');
    const longer = assessPasswordStrength('Ab3!xyzwqrstuvwx');
    expect(medium.score).toBeGreaterThanOrEqual(short.score);
    expect(long.score).toBeGreaterThanOrEqual(medium.score);
    expect(longer.score).toBeGreaterThanOrEqual(long.score);
  });

  it('字符种类多会被加分', () => {
    const onlyLower = assessPasswordStrength('abcdefghijklmnop');
    const mixed = assessPasswordStrength('Abcdefgh1234!@#$');
    expect(mixed.score).toBeGreaterThan(onlyLower.score);
  });

  it('强密码拿到高档位', () => {
    const r = assessPasswordStrength('Xk9#mQ2$vL7@wZ4n');
    expect(r.score).toBeGreaterThanOrEqual(3);
    expect(r.level).toMatch(/强|很强/);
  });

  it('数字连号与重复字符被扣分', () => {
    const sequential = assessPasswordStrength('Abcd1234!@#$');
    const repeated = assessPasswordStrength('Aaaa1111!!!!');
    expect(sequential.hints.join()).toMatch(/连号|顺序/);
    expect(repeated.hints.join()).toMatch(/重复/);
  });

  it('提示是可操作的（不是「请加强密码」这种废话）', () => {
    const r = assessPasswordStrength('123456');
    // 每条提示都要给出具体该怎么做
    for (const hint of r.hints) {
      expect(hint.length).toBeGreaterThan(4);
      expect(hint).not.toBe('请加强密码');
    }
  });

  it('分数始终在 0-4 之间（不会越界）', () => {
    const samples = [
      '',
      'a',
      '123456',
      'A1!',
      'Xk9#mQ2$vL7@wZ4n',
      'Xk9#mQ2$vL7@wZ4nXk9#mQ2$vL7@wZ4n',
      '123456789012345678901234567890',
      '!!!!!!!!!!!!!!!!!!!!',
    ];
    for (const s of samples) {
      const r = assessPasswordStrength(s);
      expect(r.score, s).toBeGreaterThanOrEqual(0);
      expect(r.score, s).toBeLessThanOrEqual(4);
    }
  });
});

describe('validatePasswordStrength（服务端准入判断）', () => {
  it('接受符合规则的密码', () => {
    expect(validatePasswordStrength('Verify2026!strong').ok).toBe(true);
    expect(validatePasswordStrength('abc12345').ok).toBe(true);
  });

  it('拒绝过短', () => {
    const r = validatePasswordStrength('Ab3!x');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('8 位');
  });

  it('拒绝过长（防 bcrypt 的性能滥用）', () => {
    const r = validatePasswordStrength('A1!'.repeat(60));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('过长');
  });

  it('拒绝纯数字且无字母', () => {
    const r = validatePasswordStrength('1234567890');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/字母|中文/);
  });

  it('拒绝纯字母且无数字符号', () => {
    const r = validatePasswordStrength('abcdefghij');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/数字|符号/);
  });

  /**
   * 中文算作「字母类」。
   *
   * ⚠️ 注意这里用的是 8 个字符的样本（中文字符也各占 1 个字符）。
   * 我第一版写了「我的密码123」—— 那是 7 个字符，被长度规则拦下，
   * 于是测试失败但真实原因不是「不支持中文」。
   * 密码长度按 **UTF-16 码元**计，中文与英文一视同仁。
   */
  it('支持中文密码（中文算作字母类）', () => {
    // 我的密码1234 = 8 个字符
    expect(validatePasswordStrength('我的密码1234').ok).toBe(true);
    // 我的密码123 = 7 个字符，应当因长度不足被拒（与是否中文无关）
    const short = validatePasswordStrength('我的密码123');
    expect(short.ok).toBe(false);
    expect(short.reason).toContain('8 位');
  });

  /**
   * 一个重要区分：validatePasswordStrength 是「准入底线」，
   * assessPasswordStrength 是「强度分级」。
   * 一个密码可以**通过准入但强度很低**（如 abc12345）——
   * 这是刻意的：不该因为强度低就拒绝注册（那会劝退用户），
   * 但要在界面上明确提示，让用户自己决定。
   */
  it('通过准入但强度偏低是允许的（分级与准入是两件事）', () => {
    const pw = 'abc12345';
    expect(validatePasswordStrength(pw).ok).toBe(true);
    expect(assessPasswordStrength(pw).score).toBeLessThanOrEqual(2);
  });
});

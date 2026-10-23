import { describe, it, expect } from 'vitest';
import { registrationVerificationDecision } from '@/lib/auth/verification-policy';

/**
 * 注册是否要求验证码。
 *
 * 这里最危险的一种写法是：「客户端没传 code 就当它不需要验证」。
 * 那样攻击者不带这个字段就能绕过验证，界面上却还显示着验证码输入框。
 * 下面这几条用例就是钉死「没传 code 不能等于跳过」。
 */
describe('registrationVerificationDecision', () => {
  it('站点不要求验证：跳过，且带不带 code 都一样', () => {
    expect(registrationVerificationDecision({ required: false }).action).toBe('skip');
    expect(registrationVerificationDecision({ required: false, code: '123456' }).action).toBe('skip');
  });

  it('要求验证且给了 code：去校验', () => {
    expect(registrationVerificationDecision({ required: true, code: '123456' }).action).toBe('verify');
  });

  it('要求验证但没给 code：**拒绝**，不是跳过（防「不传字段即绕过」）', () => {
    const d = registrationVerificationDecision({ required: true });
    expect(d.action).toBe('reject');
    if (d.action === 'reject') expect(d.message).toContain('验证码');
  });

  it('空串 / 纯空格视为没给', () => {
    expect(registrationVerificationDecision({ required: true, code: '' }).action).toBe('reject');
    expect(registrationVerificationDecision({ required: true, code: '   ' }).action).toBe('reject');
  });

  it('前后带空格的码视为有效（用户从邮件里复制常带空格）', () => {
    expect(registrationVerificationDecision({ required: true, code: ' 123456 ' }).action).toBe(
      'verify',
    );
  });
});

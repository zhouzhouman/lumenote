/**
 * 注册时的「要不要校验邮箱验证码」判定。
 *
 * 抽成纯函数的原因：这条规则容易写成后门。
 *
 * 关键约束：**「本站要求验证」与「客户端传没传 code」是两个独立输入**。
 * 如果把「没传 code」直接当成「跳过验证」，那么攻击者只要不带这个字段，
 * 就能绕过整个验证环节 —— 界面看起来有验证码，实际形同虚设。
 *
 * 所以判定只有三条出口：
 *   - 站点不要求验证 → skip（code 被忽略，旧客户端照传也不报错）
 *   - 要求验证且给了 code → verify
 *   - 要求验证但没给 code → reject（明确拒绝，绝不降级为 skip）
 */

export type VerificationDecision =
  | { action: 'verify' }
  | { action: 'skip' }
  | { action: 'reject'; message: string };

export function registrationVerificationDecision(input: {
  /** 站点配置：是否要求邮箱验证（REQUIRE_EMAIL_VERIFICATION） */
  required: boolean;
  /** 客户端提交的验证码（可能缺省或为空串） */
  code?: string | null;
}): VerificationDecision {
  if (!input.required) return { action: 'skip' };

  const code = input.code?.trim();
  if (!code) {
    return { action: 'reject', message: '本站要求验证邮箱，请先获取验证码' };
  }

  return { action: 'verify' };
}

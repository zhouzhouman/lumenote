import { describe, it, expect } from 'vitest';
import { serverEnvSchema } from '@/lib/env';

/**
 * 这些用例来自一个**只在 Docker 里出现**的故障：
 *
 *   docker compose 的 `${VAR:-}` 写法会把未定义的变量传成空字符串，
 *   而 `z.coerce.number()` 会把 `''` 变成 0，撞上 `.positive()` 后
 *   整个 env 校验失败 —— 容器启动/首个请求直接 500，而宿主机 `.env` 看起来完全正常。
 *
 * 所以这里直接拿单个字段的 schema 来测，不必构造完整的合法环境。
 */
const field = (name: string) => serverEnvSchema.shape[name as 'SMTP_PORT'];

describe('SMTP_PORT：空串必须等于「未设置」', () => {
  it.each(['', '   '])('空值 %j 解析为 undefined，而不是 0', (raw) => {
    const r = field('SMTP_PORT').safeParse(raw);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBeUndefined();
  });

  it('正常端口照常解析', () => {
    const r = field('SMTP_PORT').safeParse('587');
    expect(r.success && r.data).toBe(587);
  });

  it('0 与负数仍然被拒绝（不能因为空串放行就把校验放宽）', () => {
    expect(field('SMTP_PORT').safeParse('0').success).toBe(false);
    expect(field('SMTP_PORT').safeParse('-1').success).toBe(false);
  });

  it('非数字仍然被拒绝', () => {
    expect(field('SMTP_PORT').safeParse('abc').success).toBe(false);
  });
});

describe('SMTP 布尔开关：空串走默认值', () => {
  it('SMTP_REJECT_UNAUTHORIZED 空串 = 校验证书（默认从严）', () => {
    const r = serverEnvSchema.shape.SMTP_REJECT_UNAUTHORIZED.safeParse('');
    expect(r.success && r.data).toBe(true);
  });

  it('SMTP_REJECT_UNAUTHORIZED=false 才放宽', () => {
    const r = serverEnvSchema.shape.SMTP_REJECT_UNAUTHORIZED.safeParse('false');
    expect(r.success && r.data).toBe(false);
  });

  it('SMTP_DIRECT 空串 = 不直投，true 才直投', () => {
    expect(serverEnvSchema.shape.SMTP_DIRECT.safeParse('').data).toBe(false);
    expect(serverEnvSchema.shape.SMTP_DIRECT.safeParse('true').data).toBe(true);
  });
});

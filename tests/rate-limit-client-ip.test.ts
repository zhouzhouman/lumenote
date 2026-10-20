import { beforeEach, describe, expect, it } from 'vitest';
import { clientIp, rateLimit, resetRateLimitRuntime, resolveClientIp } from '@/lib/rate-limit';
import { MemoryRateLimitStore } from '@/lib/rate-limit/memory-store';
import { normalizeIp, UNKNOWN_CLIENT_IP } from '@/lib/rate-limit/client-ip';

/**
 * 可信代理边界（X-Forwarded-For 信任模型）的测试矩阵。
 *
 * 修复的核心问题：旧实现无条件取 XFF 第一段，攻击者每次请求换一个随机
 * 伪造前缀就能绕过限流。新语义要求：
 *  - hops=0：不信任任何转发头 → 常量 unknown（共享桶，无法伪造绕过）
 *  - hops=N：从 XFF **右侧**数第 N 个；左侧伪造前缀不得影响取值
 *  - 段数不足 N / 非法 IP：一律 unknown（不可信时偏严格）
 *
 * 注意：这里断言的是「限流用的 IP」，不是身份认证。
 */

function headersOf(init: Record<string, string>): Headers {
  return new Headers(init);
}

beforeEach(async () => {
  await resetRateLimitRuntime();
});

describe('IP 规范化', () => {
  it('接受 IPv4 / IPv6 / 带端口写法，拒绝非法值', () => {
    expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp(' 1.2.3.4 ')).toBe('1.2.3.4');
    expect(normalizeIp('1.2.3.4:8080')).toBe('1.2.3.4');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(normalizeIp('')).toBeNull();
  });
});

describe('TRUST_PROXY_HOPS=0：完全不信任转发头', () => {
  it('合法的 XFF 与 x-real-ip 都被忽略，返回 unknown', () => {
    expect(resolveClientIp(headersOf({ 'x-forwarded-for': '1.2.3.4' }), 0)).toBe(UNKNOWN_CLIENT_IP);
    expect(resolveClientIp(headersOf({ 'x-real-ip': '5.6.7.8' }), 0)).toBe(UNKNOWN_CLIENT_IP);
    expect(
      resolveClientIp(
        headersOf({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1', 'x-real-ip': '5.6.7.8' }),
        0,
      ),
    ).toBe(UNKNOWN_CLIENT_IP);
  });

  it('clientIp 默认读 env（未配置时 hops=0），伪造 XFF 不生效', () => {
    expect(clientIp(headersOf({ 'x-forwarded-for': '203.0.113.9' }))).toBe(UNKNOWN_CLIENT_IP);
  });

  it('伪造 XFF 不能绕过限流：所有请求落在同一个 unknown 桶', async () => {
    const store = new MemoryRateLimitStore({ buckets: new Map() });
    const results = [];

    for (let i = 0; i < 4; i += 1) {
      // 每次伪造不同的左侧 IP
      const ip = clientIp(headersOf({ 'x-forwarded-for': `${i + 1}.${i + 1}.${i + 1}.${i + 1}, 10.0.0.1` }));
      expect(ip).toBe(UNKNOWN_CLIENT_IP);
      results.push(await rateLimit(`ip:${ip}`, 3, 60, { store }));
    }

    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
  });
});

describe('TRUST_PROXY_HOPS=N：从右侧取第 N 个', () => {
  it('hops=1：单层代理，取最右侧地址，伪造前缀被忽略', () => {
    expect(resolveClientIp(headersOf({ 'x-forwarded-for': '1.2.3.4' }), 1)).toBe('1.2.3.4');
    // 真实客户端 10.0.0.1 是可信代理追加的；左侧 1.2.3.4 是攻击者伪造的前缀
    expect(resolveClientIp(headersOf({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }), 1)).toBe('10.0.0.1');
    expect(resolveClientIp(headersOf({ 'x-forwarded-for': ' 1.2.3.4 ,  10.0.0.1 ' }), 1)).toBe('10.0.0.1');
  });

  it('hops=2：两层代理，取右数第 2 个', () => {
    expect(resolveClientIp(headersOf({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }), 2)).toBe('1.2.3.4');
    // 左侧再多一段伪造值也不影响「右数第 2 个」
    expect(
      resolveClientIp(headersOf({ 'x-forwarded-for': '9.9.9.9, 1.2.3.4, 10.0.0.1' }), 2),
    ).toBe('1.2.3.4');
  });

  it('hops 大于实际链路长度时返回 unknown（不猜、不放行伪造值）', () => {
    expect(resolveClientIp(headersOf({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }), 3)).toBe(
      UNKNOWN_CLIENT_IP,
    );
    expect(resolveClientIp(headersOf({ 'x-forwarded-for': '1.2.3.4' }), 2)).toBe(UNKNOWN_CLIENT_IP);
  });

  it('选中的那一段非法时退回 unknown，而不是退回其他段', () => {
    expect(resolveClientIp(headersOf({ 'x-forwarded-for': 'garbage, 10.0.0.1' }), 2)).toBe(
      UNKNOWN_CLIENT_IP,
    );
    expect(resolveClientIp(headersOf({ 'x-forwarded-for': '1.2.3.4, garbage' }), 2)).toBe('1.2.3.4');
  });

  it('支持 IPv6 客户端', () => {
    expect(resolveClientIp(headersOf({ 'x-forwarded-for': '2001:db8::1, 10.0.0.1' }), 2)).toBe(
      '2001:db8::1',
    );
  });

  it('伪造 XFF 不能绕过限流（hops=1）：左侧随机前缀被忽略，真实 IP 桶生效', async () => {
    const store = new MemoryRateLimitStore({ buckets: new Map() });
    const results = [];

    for (let i = 0; i < 4; i += 1) {
      const ip = clientIp(
        headersOf({ 'x-forwarded-for': `203.0.113.${i}, 10.0.0.1` }),
        { trustProxyHops: 1 },
      );
      expect(ip).toBe('10.0.0.1');
      results.push(await rateLimit(`ip:${ip}`, 3, 60, { store }));
    }

    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
  });
});

describe('x-real-ip 的回退边界', () => {
  it('hops>=1 且无 XFF 时才使用 x-real-ip', () => {
    expect(resolveClientIp(headersOf({ 'x-real-ip': '5.6.7.8' }), 1)).toBe('5.6.7.8');
    expect(resolveClientIp(headersOf({ 'x-real-ip': '5.6.7.8' }), 2)).toBe('5.6.7.8');
  });

  it('XFF 存在（即使为空串）时优先按 XFF 规则处理', () => {
    // 空 XFF 视为没有 XFF，可以回退 x-real-ip
    expect(resolveClientIp(headersOf({ 'x-forwarded-for': '  ', 'x-real-ip': '5.6.7.8' }), 1)).toBe(
      '5.6.7.8',
    );
    // 非空 XFF 且选中段非法：unknown，不再回退 x-real-ip（避免用可伪造的第二个头兜底）
    expect(
      resolveClientIp(headersOf({ 'x-forwarded-for': 'garbage', 'x-real-ip': '5.6.7.8' }), 1),
    ).toBe(UNKNOWN_CLIENT_IP);
  });
});

describe('信任模型的已知前提（诚实记录，不是 bug）', () => {
  it('hops=1 时若攻击者能直连应用并只带单段 XFF，它会被当作客户端', () => {
    // 这正是「设 hops>0 后必须保证应用端口只对可信代理开放」的原因。
    // 单段 XFF 意味着「请求只经过一层代理」，配置为 1 层时无法区分
    // 「真代理追加的地址」与「客户端自己写的地址」—— 安全性来自网络边界，而非代码。
    expect(resolveClientIp(headersOf({ 'x-forwarded-for': '6.6.6.6' }), 1)).toBe('6.6.6.6');
  });
});

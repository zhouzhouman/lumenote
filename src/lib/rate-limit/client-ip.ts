import { isIP } from 'node:net';
import { env } from '@/lib/env';

/**
 * 从请求头提取「用于限流的客户端 IP」。
 *
 * ⚠️ 先明确用途边界：**这是限流用的 IP，不是身份认证依据。**
 * 它只回答「这些请求大致来自哪里」，不保证不可伪造。绝不能拿它做
 * 访问控制、审计定责或「同 IP 即同一个人」的推断。
 *
 * ## 旧实现的问题
 *
 * 旧代码无条件取 `X-Forwarded-For` 的第一个值：
 *
 *   const xff = headers.get('x-forwarded-for');
 *   if (xff) return xff.split(',')[0]!.trim();
 *
 * XFF 是**客户端也能写**的请求头。攻击者每次请求带一个随机 XFF，
 * 就能让每次请求落进不同的限流桶 —— 限流形同虚设（绕过成本 = 改个 header）。
 *
 * ## 新语义（TRUST_PROXY_HOPS）
 *
 * XFF 的格式是「客户端, 代理1, 代理2, ...」：真实客户端在最左，
 * 每经过一层代理，代理把自己的对端地址追加到右侧。
 *
 *   TRUST_PROXY_HOPS=0（默认）：**不信任任何转发头**。XFF 与 x-real-ip 一律忽略，
 *     返回常量 `unknown`。所有请求共享同一个 bucket —— 无法被伪造绕过，
 *     代价是无法区分客户端。适用于「应用直连公网 / 没有反向代理」的部署。
 *   TRUST_PROXY_HOPS=N：从右往左数第 N 个地址作为客户端 IP。
 *     左侧多出来的段（伪造前缀）不影响取值。
 *     例：`1.2.3.4, 10.0.0.1` + hops=1 → 10.0.0.1；hops=2 → 1.2.3.4。
 *     若 XFF 段数 < N（声称的代理层数比实际链路还多），返回 `unknown`
 *     而不是猜一个值 —— 不可信就退化为共享桶，方向偏严格。
 *
 * ## x-real-ip
 *
 * 只有 hops >= 1 且**没有** XFF 时才回退到 `x-real-ip`（某些 nginx 配置
 * 只设它、不设 XFF）。它同样可被伪造，因此只在「已声明存在可信代理」的
 * 前提下使用；hops=0 时完全不读。
 *
 * ## 部署前提（很重要）
 *
 * 设置 hops > 0 之后，**应用端口必须只对可信代理开放**（安全组/防火墙/
 * 只绑 127.0.0.1）。否则任何人直连应用都能自己写 XFF，信任配置就白配了。
 * 反过来，部署在反向代理之后却忘记设 hops，所有客户端会共享 `unknown`
 * 桶，表现为「别人请求多了我也被 429」。
 *
 * ## Next.js 的局限
 *
 * 路由 handler 拿不到 socket 层对端地址（Next 15 移除了 NextRequest.ip，
 * Node runtime 也没有稳定的 peer address 暴露）。所以没有可信头时只能
 * 返回常量 `unknown`，无法退回到「连接层地址」。要拿到真实对端地址，
 * 需要由反向代理注入（例如 nginx 设置 XFF + 配置 hops），或在自定义 server
 * 层把 socket.remoteAddress 塞进 header —— 后者不在本任务范围。
 */

/** 无法确定客户端 IP 时的占位值（会被当作一个共享限流桶） */
export const UNKNOWN_CLIENT_IP = 'unknown';

export interface ClientIpOptions {
  /**
   * 可信代理跳数覆盖（测试用）。
   * 不传时读 env().TRUST_PROXY_HOPS。
   */
  trustProxyHops?: number;
}

/** 规范化单个 IP 字面量；无法识别返回 null（调用方会退化为 unknown） */
export function normalizeIp(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  // [2001:db8::1]:443 这种带方括号与端口的写法
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return null;
    const inner = value.slice(1, end);
    return isIP(inner) ? inner : null;
  }

  if (isIP(value)) return value;

  // 1.2.3.4:5678（恰好一个冒号 = IPv4 + 端口；IPv6 带端口必须有方括号，歧义时不猜）
  const lastColon = value.lastIndexOf(':');
  if (lastColon > 0 && value.indexOf(':') === lastColon) {
    const maybeIpv4 = value.slice(0, lastColon);
    if (isIP(maybeIpv4) === 4) return maybeIpv4;
  }

  return null;
}

/**
 * 纯函数版本：不读 env，方便测试直接传 hops。
 *
 * @param headers 请求头
 * @param trustProxyHops 可信代理层数（0 表示完全不信任转发头）
 */
export function resolveClientIp(headers: Headers, trustProxyHops: number): string {
  if (!Number.isFinite(trustProxyHops) || trustProxyHops <= 0) {
    // 不信任任何转发头。注意 x-real-ip 也不读：它同样可被客户端伪造。
    return UNKNOWN_CLIENT_IP;
  }

  const xff = headers.get('x-forwarded-for');
  if (xff !== null && xff.trim() !== '') {
    const chain = xff
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

    if (chain.length === 0) return UNKNOWN_CLIENT_IP;

    // 从右侧取第 N 个：索引 = 长度 - N。
    // 左侧伪造的段即使存在也不会被选中（这正是修复的核心）。
    const index = chain.length - Math.floor(trustProxyHops);
    if (index < 0) return UNKNOWN_CLIENT_IP;

    return normalizeIp(chain[index]!) ?? UNKNOWN_CLIENT_IP;
  }

  // 没有 XFF：单层代理可能只写了 x-real-ip。
  // 仅在信任链内（hops >= 1）才认。
  const realIp = headers.get('x-real-ip');
  if (realIp && realIp.trim() !== '') {
    return normalizeIp(realIp) ?? UNKNOWN_CLIENT_IP;
  }

  return UNKNOWN_CLIENT_IP;
}

/** 从请求头取客户端 IP（从 env 读 TRUST_PROXY_HOPS） */
export function clientIp(headers: Headers, options: ClientIpOptions = {}): string {
  const hops = options.trustProxyHops ?? env().TRUST_PROXY_HOPS;
  return resolveClientIp(headers, hops);
}

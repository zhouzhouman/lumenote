import { SignJWT, jwtVerify } from 'jose';
import { env } from '@/lib/env';

/**
 * JWT 签发与校验。
 *
 * 为什么自己写而不用 Clerk / Auth.js？
 * 因为鉴权是面试必问点，自己实现一遍才答得清楚。
 * 接入第三方库面试时只能回答「它是怎么实现的」，而不是「我为什么这么设计」。
 *
 * 设计要点：
 * - access token 15 分钟，refresh token 7 天
 * - 两个 token 都放 httpOnly cookie —— XSS 读不到，CSRF 风险靠 SameSite 缓解
 * - JWT 里**只放 userId**，不放权限/角色快照。
 *   原因：权限一旦改动，存量 token 里的旧快照会一直生效到过期，
 *   造成「改了权限但没生效」的诡异 bug。权限每请求查 DB（带短 TTL 内存缓存）。
 */

const ALG = 'HS256';

function secretKey(): Uint8Array {
  const e = env();
  return new TextEncoder().encode(e.AUTH_SECRET);
}

export interface AccessTokenPayload {
  userId: string;
}

export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
  const e = env();
  const ttl = e.JWT_ACCESS_TTL_MINUTES * 60;

  return new SignJWT({ sub: payload.userId })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(secretKey());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: [ALG] });
    if (!payload.sub) return null;
    return { userId: payload.sub };
  } catch {
    // 过期是正常业务场景，不该打日志刷屏
    return null;
  }
}

/** refresh token：随机字节的 base64url，而非 JWT */
export function generateRefreshToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

/**
 * refresh token 哈希后存库。
 *
 * 不存明文：数据库泄露时攻击者拿不到可直接使用的 token。
 * 代价是每次刷新都要做一次哈希，但这个开销可以忽略。
 */
export async function hashRefreshToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Buffer.from(digest).toString('hex');
}

// ============================================================
// Cookie 辅助
// ============================================================

export const ACCESS_COOKIE = 'lumenote_access';
export const REFRESH_COOKIE = 'lumenote_refresh';

function cookieOptions(maxAgeSeconds: number) {
  const isProd = process.env.NODE_ENV === 'production';

  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
    // 生产环境限定域名，避免子域泄露
    ...(isProd && process.env.NEXT_PUBLIC_APP_URL
      ? { domain: new URL(process.env.NEXT_PUBLIC_APP_URL).hostname }
      : {}),
  };
}

export function accessCookie(token: string): string {
  return buildCookie(ACCESS_COOKIE, token, cookieOptions(env().JWT_ACCESS_TTL_MINUTES * 60));
}

export function refreshCookie(token: string): string {
  return buildCookie(REFRESH_COOKIE, token, cookieOptions(env().JWT_REFRESH_TTL_DAYS * 86_400));
}

export function clearAuthCookies(): string[] {
  const maxAge = 0;
  return [
    buildCookie(ACCESS_COOKIE, '', cookieOptions(maxAge)),
    buildCookie(REFRESH_COOKIE, '', cookieOptions(maxAge)),
  ];
}

function buildCookie(name: string, value: string, opts: Record<string, unknown>): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined || v === null || v === false) continue;
    if (v === true) parts.push(k);
    else parts.push(`${k}=${v}`);
  }
  return parts.join('; ');
}
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

/**
 * 用户自带 LLM 凭证（BYOK）的存取与加解密。
 *
 * ## 这个模块存在的三个理由
 *
 * 1. **API Key 是「钱」**。用户把 key 交给我们，我们的责任是：即使数据库
 *    整个被拖走，攻击者也拿不到可用的 key。所以落库前必须加密，
 *    密钥来自 AUTH_SECRET（不进数据库），而不是写死在代码或配置里。
 *
 * 2. **key 永远不出服务端**。连密文都不回传给前端 —— 列表接口只给掩码。
 *    理由很实际：密文一旦进入浏览器内存/localStorage，XSS 就多了一条窃取链，
 *    而我们本来有办法完全不承担这个风险。
 *
 * 3. **自定义 baseUrl 是 SSRF 的变体**。用户可以填任意地址，服务端会带着
 *    （用户的）key 去请求它。虽然 key 是用户自己的，但「服务端能访问内网」
 *    这件事不该由用户的输入决定，所以地址要过校验（见 validateBaseUrl）。
 *
 * ## 已知取舍
 *
 * 自定义 baseUrl 允许指向未列入白名单的公网主机。这是刻意的：
 * 用户可能用中转网关、代理或自建端点，白名单会直接把他们挡在门外。
 * 私网/元数据地址仍然拦截，因为它们与「用自己的 key 调模型」无关，
 * 只可能是探测行为。
 */

// ============================================================
// 类型
// ============================================================

export type ProviderId = 'deepseek' | 'openai' | 'custom';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  baseUrl: string;
  defaultModel: string;
  /** 可选模型（下拉用）。自定义 provider 为空数组，由用户手填 */
  models: string[];
  /** 控制台取 key 的地址，给用户一个明确的指引 */
  consoleUrl: string;
  /** 是否允许用户覆盖 baseUrl（中转/代理场景） */
  allowCustomBaseUrl: boolean;
}

/**
 * 内置 provider 元数据。
 *
 * 这里**只放接入信息，不放价格** —— 价格在 lib/llm/pricing.ts。
 * 分开的理由：计价要对所有人统一（包括用自己 key 的人，我们仍要如实展示
 * 这次调用值多少钱），而接入信息是 BYOK 专属的。
 */
export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    allowCustomBaseUrl: true,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'],
    consoleUrl: 'https://platform.openai.com/api-keys',
    allowCustomBaseUrl: true,
  },
  custom: {
    id: 'custom',
    label: '兼容 OpenAI 协议的其他服务',
    baseUrl: '',
    defaultModel: '',
    models: [],
    consoleUrl: '',
    allowCustomBaseUrl: true,
  },
};

export type ProviderConfigError =
  | 'BASE_URL_REQUIRED'
  | 'BASE_URL_INVALID'
  | 'BASE_URL_PRIVATE'
  | 'BASE_URL_UNSAFE_PROTOCOL';

/**
 * 凭证的对外形状（前端可见的全部字段）。
 *
 * ⚠️ 刻意**不包含** apiKeyEncrypted，连密文都不给前端。
 * 类型层面上就排除了「不小心把密钥塞进响应」的可能 ——
 * 靠人记住「这个字段不能返回」迟早会失守，靠类型则编译期就挡住。
 */
export interface PublicCredential {
  id: string;
  label: string;
  provider: ProviderId;
  model: string;
  baseUrl: string | null;
  apiKeyHint: string;
  active: boolean;
  lastUsedAt: Date | string | null;
  lastErrorCode: string | null;
  lastErrorAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ResolvedCredential {
  /** 数据库主键，便于把「本次用的哪条凭证」写入任务参数 */
  id: string;
  label: string;
  provider: ProviderId;
  model: string;
  baseUrl: string;
  apiKey: string;
}

// ============================================================
// 加解密
// ============================================================

/**
 * 密钥派生。
 *
 * scrypt 而不是直接 sha256(AUTH_SECRET)：AUTH_SECRET 是人工设置的字符串，
 * 熵可能不高，直接当密钥用等于把整个加密强度绑定在这句话的可猜性上。
 * scrypt 的慢哈希特性让暴力尝试代价显著上升。
 *
 * salt 是固定的：不能随机，否则每次启动派生出不同密钥、历史密文全部解不开。
 * 这里用应用标识当 salt —— 它的作用只是避免与其他用途的派生结果相同，
 * 不是保密项（保密的是 AUTH_SECRET）。
 */
let cachedKey: Buffer | null = null;

function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('AUTH_SECRET 未配置或过短，无法加密用户 API Key');
  }
  // N=16384 是 scrypt 的常用强度：单次约 50ms，对启动一次性开销可接受
  cachedKey = crypto.scryptSync(secret, 'lumenote:api-credential:v1', 32, { N: 16384, r: 8, p: 1 });
  return cachedKey;
}

/** 加密：返回 iv.authTag.ciphertext，各段 base64url，用点分隔 */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12); // GCM 推荐 96 bit
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString('base64url')).join('.');
}

/**
 * 解密。
 *
 * 解不开时抛错而不是返回空串 —— 空 key 会让上游返回 401，
 * 用户看到的是「凭证无效」，而真实原因是「AUTH_SECRET 被换过」。
 * 报错信息里点明这一点，能省掉一次很痛苦的排查。
 */
export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('凭证密文格式不合法');

  const [ivRaw, tagRaw, dataRaw] = parts as [string, string, string];
  const iv = Buffer.from(ivRaw, 'base64url');
  const authTag = Buffer.from(tagRaw, 'base64url');
  const data = Buffer.from(dataRaw, 'base64url');

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // GCM 校验失败：密文被篡改，或 AUTH_SECRET 变了
    throw new Error('凭证解密失败（可能是 AUTH_SECRET 已更换，请重新填写 API Key）');
  }
}

/**
 * 生成展示掩码。
 *
 * 只保留前 3 位与后 4 位：足以让用户辨认「是哪把 key」，
 * 又不足以还原（真实 key 有 30+ 位）。短 key 直接整体打码。
 */
export function maskApiKey(apiKey: string): string {
  const key = apiKey.trim();
  if (key.length <= 12) return '••••••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

// ============================================================
// baseUrl 校验
// ============================================================

const PRIVATE_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/i;

export interface BaseUrlCheck {
  ok: boolean;
  url?: string;
  reason?: ProviderConfigError;
  message?: string;
}

/**
 * 校验自定义 baseUrl。
 *
 * 四层：
 *  0. 部署方是否允许自定义地址（ALLOW_CUSTOM_BASE_URL，默认允许）
 *  1. 协议必须是 http/https（http 仅允许本机，方便用户接本地网关）
 *  2. 明显的内网/环回/元数据主机名直接拒绝
 *  3. 不允许带用户名密码（http://user:pass@host 这种形态常见于钓鱼/绕过）
 *
 * 为什么不做 DNS 解析后校验 IP？因为那会在**每次调用**时引入一次 DNS 往返，
 * 而且本地自建网关常常就解析到内网地址 —— 那正是用户的正当用法。
 * 这里的定位是「防止误把内网地址当公网模型端点」，而不是完整 SSRF 防御；
 * 真正的抓取式 SSRF 在 safe-fetch 里处理。
 */
export function validateBaseUrl(raw: string): BaseUrlCheck {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, reason: 'BASE_URL_REQUIRED', message: '请填写接口地址' };
  }

  if (!env().ALLOW_CUSTOM_BASE_URL) {
    return {
      ok: false,
      reason: 'BASE_URL_INVALID',
      message: '本站未开放自定义接口地址，请使用内置服务商',
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'BASE_URL_INVALID', message: '接口地址格式不正确' };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      reason: 'BASE_URL_INVALID',
      message: '接口地址不能包含用户名密码',
    };
  }

  const host = url.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';

  if (url.protocol === 'http:' && !isLocal) {
    return {
      ok: false,
      reason: 'BASE_URL_UNSAFE_PROTOCOL',
      message: '出于安全考虑，非本机地址必须使用 https',
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'BASE_URL_UNSAFE_PROTOCOL',
      message: '仅支持 http/https 协议',
    };
  }

  if (PRIVATE_HOST_RE.test(host) && !isLocal) {
    return {
      ok: false,
      reason: 'BASE_URL_PRIVATE',
      message: '接口地址不能指向内网地址',
    };
  }

  // 去掉尾部斜杠，避免拼出 //chat/completions
  return { ok: true, url: url.toString().replace(/\/$/, '') };
}

// ============================================================
// 读写
// ============================================================

/** 校验并归一化 provider 标识 */
export function normalizeProvider(raw: string): ProviderId | null {
  const value = raw.trim().toLowerCase();
  if (value === 'deepseek' || value === 'openai' || value === 'custom') return value;
  return null;
}

/** 解析最终生效的 baseUrl：自定义优先，其次内置默认 */
export function resolveBaseUrl(provider: ProviderId, customBaseUrl?: string | null): string {
  if (customBaseUrl && customBaseUrl.trim()) return customBaseUrl.trim().replace(/\/$/, '');
  return PROVIDERS[provider].baseUrl;
}

/**
 * 解析最终生效的模型。
 *
 * 优先级：用户填的 > 内置默认。BYOK 场景下我们**不限制模型名** ——
 * 用哪个模型是用户自己的成本决策，我们只负责如实计价与展示。
 * 自定义 provider 且没填模型时回落到站点的 DEFAULT_MODEL，保证请求里一定有值。
 */
export function resolveModel(provider: ProviderId, model?: string | null): string {
  const explicit = model?.trim();
  if (explicit) return explicit;
  return PROVIDERS[provider].defaultModel || env().DEFAULT_MODEL;
}

/**
 * 进程内缓存。
 *
 * 为什么要缓存：读取凭证要做一次解密（scrypt 派生只算一次，但 AES-GCM 解密
 * 与 DB 查询是每次调用都发生的成本），而 Map 阶段会并发多次调用。
 *
 * 失效策略：按 id 缓存，key 更新时删除对应条目。
 * 用 id 而非 userId 做键，是为了让「同一用户换了凭证」自然失效 ——
 * 因为换凭证会生成新的 id。
 */
interface CacheEntry {
  at: number;
  value: ResolvedCredential;
}

const globalForCredCache = globalThis as unknown as { credentialCache?: Map<string, CacheEntry> };
const CACHE_TTL_MS = 60_000;

function cache(): Map<string, CacheEntry> {
  if (!globalForCredCache.credentialCache) globalForCredCache.credentialCache = new Map();
  return globalForCredCache.credentialCache;
}

/** 使某条凭证的缓存失效（更新/删除/切换启用状态时调用） */
export function invalidateCredentialCache(id?: string): void {
  if (!id) {
    cache().clear();
    return;
  }
  cache().delete(id);
}

function toResolved(row: {
  id: string;
  label: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKeyEncrypted: string;
}): ResolvedCredential {
  const provider = normalizeProvider(row.provider) ?? 'custom';
  return {
    id: row.id,
    label: row.label,
    provider,
    model: resolveModel(provider, row.model),
    baseUrl: resolveBaseUrl(provider, row.baseUrl),
    apiKey: decryptSecret(row.apiKeyEncrypted),
  };
}

/**
 * 取用户当前启用的凭证。没有启用任何凭证时返回 null（走站点自己的 key）。
 *
 * 解密失败（AUTH_SECRET 变更）不抛给调用方，而是返回 null 并记日志：
 * 用户配了 key 却因为我们的密钥变更而整条管线崩掉，体验很差；
 * 退回站点 key 至少能出结果，同时用户会在设置页看到解密失败的提示。
 */
export async function loadActiveCredential(userId: string): Promise<ResolvedCredential | null> {
  const row = await prisma.apiCredential.findFirst({
    where: { userId, active: true },
  });
  if (!row) return null;

  const hit = cache().get(row.id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  try {
    const value = toResolved(row);
    cache().set(row.id, { at: Date.now(), value });
    return value;
  } catch (e) {
    console.error(`[credentials] 凭证 ${row.id} 解密失败，本次回退到站点默认通道：`, e);
    return null;
  }
}

/** 按 id 读取凭证（任务里快照了 credentialId，重跑时要能还原当时用的配置） */
export async function loadCredentialById(
  userId: string,
  id: string,
): Promise<ResolvedCredential | null> {
  const row = await prisma.apiCredential.findFirst({ where: { id, userId } });
  if (!row) return null;

  const hit = cache().get(row.id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  try {
    const value = toResolved(row);
    cache().set(row.id, { at: Date.now(), value });
    return value;
  } catch (e) {
    console.error(`[credentials] 凭证 ${row.id} 解密失败：`, e);
    return null;
  }
}

/**
 * 记录一次使用结果。
 *
 * 为什么不放进主流程的 await：计量与主流程解耦。
 * 写失败只会让「最近使用时间」不准，但绝不该让用户的摘要生成失败。
 */
export async function touchCredential(
  id: string,
  outcome: { ok: boolean; errorCode?: string },
): Promise<void> {
  try {
    await prisma.apiCredential.update({
      where: { id },
      data: outcome.ok
        ? { lastUsedAt: new Date(), lastErrorCode: null, lastErrorAt: null }
        : { lastUsedAt: new Date(), lastErrorCode: outcome.errorCode ?? 'UNKNOWN', lastErrorAt: new Date() },
    });
  } catch (e) {
    console.error('[credentials] 记录凭证使用状态失败（不影响主流程）：', e);
  }
}

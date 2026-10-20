import type { Attributes } from '@opentelemetry/api';

/**
 * span 属性的脱敏与截断。
 *
 * ## 威胁模型（为什么不能只依赖「接入时小心」）
 *
 * trace 会被写到磁盘（`.lumenote-data/traces/*.jsonl`），而它可能：
 *   1. 被开发者在本地打开、贴进 issue/面试作品集；
 *   2. 被采集到第三方 APM（TRACE_EXPORT=otlp 时）。
 *
 * 一旦 span 里出现 API Key 或完整 prompt/文档正文，就是**凭据泄漏 + 用户内容外泄**。
 * 所以这里做**结构性防御**：即使未来有人手滑把 `prompt` 塞进 attributes，
 * 写出前也会被拦掉。接入点的自觉不能当作安全边界。
 *
 * ## 策略（两层）
 *
 * 1. **键名黑名单**：密钥类与正文类 key 直接替换为 `[redacted]` / `[omitted]`。
 *    正文类被丢弃而不是截断 —— 「prompt 的前 200 字」也可能含敏感信息。
 * 2. **值级兜底**：看起来像 `sk-...` / `Bearer ...` 的字符串按密钥处理；
 *    其余字符串统一截断到 200 字符。
 *
 * 正文本身不是完全不记录：调用方应改用 `digestText()` 记录**长度 + 哈希**，
 * 既能检索「同一次输入」又不泄漏内容。
 */

/** 绝不能出现在 trace 里的键（大小写不敏感） */
const SECRET_KEY_PATTERN =
  /^(api[-_]?key|authorization|proxy[-_]?authorization|secret|password|passwd|cookie|set[-_]?cookie|x[-_]?api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|deepseek[-_]?api[-_]?key|openai[-_]?api[-_]?key)$/i;

/**
 * 正文类键：不是密钥，但属于用户内容，一律不落 trace。
 * 调用方必须改用 digestText / 长度 / 摘要。
 */
const CONTENT_KEY_PATTERN =
  /^(prompt|prompttext|systemprompt|messages|content|input|output|question|answer|quote|body|text|document|chunks?|reasoning|completion)$/i;

/**
 * 值级兜底：常见的密钥字面量形态。
 *
 * ⚠️ `sk-` 前必须是非单词字符或字符串开头：否则像 `task-export-1` 这种
 * 正常 id（里面恰好含 `sk-export-1`）会被误伤成 [redacted] ——
 * 实测确实踩到过：taskId 被脱敏后 trace 检索直接失效。
 * 脱敏规则宁可漏一点，也不能误伤用于检索的标识符。
 */
const SECRET_VALUE_PATTERN =
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{8,}/;

/** 单个属性值的最大长度（字符）。超长会被截断并标注 */
export const MAX_ATTRIBUTE_VALUE_LENGTH = 200;

/** 脱敏后的属性值类型（与 OTel AttributeValue 兼容的简单子集） */
export type SanitizedValue = string | number | boolean;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function isContentKey(key: string): boolean {
  return CONTENT_KEY_PATTERN.test(key);
}

/**
 * 脱敏单个属性值。
 *
 * - number / boolean 原样保留（含 token 数、耗时等指标）；
 * - 字符串：密钥形态 → `[redacted]`；超长 → 截断；
 * - 其它（对象/数组/bigint）→ JSON 字符串化后再按字符串规则处理。
 */
export function sanitizeAttributeValue(value: unknown): SanitizedValue {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);

  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = '[unserializable]';
    }
  }

  if (SECRET_VALUE_PATTERN.test(text)) return '[redacted]';
  if (text.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
    return `${text.slice(0, MAX_ATTRIBUTE_VALUE_LENGTH)}…(len=${text.length})`;
  }
  return text;
}

/**
 * 批量脱敏属性。
 *
 * 返回 `Record<string, SanitizedValue>`：span.setAttributes 接受它。
 * 密钥键 → `[redacted]`；正文键 → `[omitted]`；其余走 sanitizeAttributeValue。
 */
export function sanitizeAttributes(attributes: Attributes | Record<string, unknown>): Record<string, SanitizedValue> {
  const result: Record<string, SanitizedValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (isSecretKey(key)) {
      result[key] = '[redacted]';
      continue;
    }
    if (isContentKey(key)) {
      result[key] = '[omitted]';
      continue;
    }
    result[key] = sanitizeAttributeValue(value);
  }
  return result;
}

/** 文本指纹：长度 + 非密码学哈希（FNV-1a 32bit）。用于「同一次输入」的关联而不泄漏正文 */
export function digestText(text: string): { length: number; hash: string } {
  const normalized = text ?? '';
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return { length: normalized.length, hash: hash.toString(16).padStart(8, '0') };
}

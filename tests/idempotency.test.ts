import { describe, expect, it } from 'vitest';
import { normalizeIdempotencyKey } from '@/lib/idempotency';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('normalizeIdempotencyKey', () => {
  it('没有 header 时生成随机 UUID', () => {
    const key = normalizeIdempotencyKey(null);
    expect(key).toMatch(UUID_RE);
  });

  it('合法 key 原样保留（大写/数字/._:- 都是允许字符）', () => {
    expect(normalizeIdempotencyKey('Order-1234.abc:xyz_9')).toBe('Order-1234.abc:xyz_9');
  });

  it('非法字符被清洗、超长截断到 64', () => {
    expect(normalizeIdempotencyKey('abc def!')).toBe('abcdef');
    expect(normalizeIdempotencyKey('x'.repeat(100))).toHaveLength(64);
  });

  it('清洗后为空时必须回退为随机 UUID，而不是空串', () => {
    // 中文、空格、符号都会被清洗掉；空串会让同用户所有请求命中同一个
    // (userId, '') 唯一键，静默重放第一条任务。
    const key = normalizeIdempotencyKey('中文 空格 !@#$%^&*()');
    expect(key).not.toBe('');
    expect(key).toMatch(UUID_RE);
  });

  it('两次清洗后为空的输入生成不同的键（不会互相重放）', () => {
    expect(normalizeIdempotencyKey('中文')).not.toBe(normalizeIdempotencyKey('中文'));
  });
});

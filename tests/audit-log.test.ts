import { describe, it, expect } from 'vitest';
import { sanitizeAuditMeta, auditActionLabel, AUDIT_ACTION_LABELS } from '@/lib/audit/log';

/**
 * 审计 meta 的脱敏。
 *
 * 这块出错的性质很严重：审计日志会被导出、发给外部审计方。
 * 一旦有人图省事把 apiKey 塞进 meta，密钥就跟着导出文件一起流出去了，
 * 而这种错误在 code review 里几乎看不出来。
 */
describe('sanitizeAuditMeta：敏感字段剔除', () => {
  it.each([
    'apiKey',
    'api_key',
    'api-key',
    'password',
    'passwordHash',
    'secret',
    'token',
    'accessToken',
    'authorization',
    'cookie',
    'verificationCode',
    'verification_code',
  ])('剔除 %s', (key) => {
    const out = sanitizeAuditMeta({ [key]: 'leak-me', keep: 'ok' });
    expect(out).not.toHaveProperty(key);
    expect(out).toEqual({ keep: 'ok' });
  });

  it('嵌套对象里的敏感字段同样剔除', () => {
    const out = sanitizeAuditMeta({
      credential: { provider: 'deepseek', apiKey: 'sk-xxx', model: 'deepseek-flash' },
    });
    expect(JSON.stringify(out)).not.toContain('sk-xxx');
    expect(out).toEqual({ credential: { provider: 'deepseek', model: 'deepseek-flash' } });
  });

  it('嵌套对象被剔空后整个键都不留（不留 {} 噪音）', () => {
    expect(sanitizeAuditMeta({ credential: { apiKey: 'x' } })).toBeNull();
  });
});

describe('sanitizeAuditMeta：裁剪规则', () => {
  it('长字符串截断并加省略号', () => {
    const out = sanitizeAuditMeta({ note: 'x'.repeat(500) });
    expect(String(out?.note).endsWith('…')).toBe(true);
    expect(String(out?.note).length).toBe(201);
  });

  it('数组只保留标量，最多 20 项', () => {
    const out = sanitizeAuditMeta({
      fields: [...Array.from({ length: 30 }, (_, i) => `f${i}`), { nested: true }],
    });
    const arr = out?.fields as unknown[];
    expect(arr).toHaveLength(20);
    expect(arr.every((v) => typeof v === 'string')).toBe(true);
  });

  it('标量原样保留，null 也保留（它有语义：明确为空）', () => {
    expect(sanitizeAuditMeta({ a: 1, b: true, c: null })).toEqual({ a: 1, b: true, c: null });
  });

  it('空对象 / undefined 一律返回 null，不写空 JSON', () => {
    expect(sanitizeAuditMeta({})).toBeNull();
    expect(sanitizeAuditMeta(undefined)).toBeNull();
  });
});

describe('AUDIT_ACTION_LABELS', () => {
  it('每个动作都有中文名，且未知动作回落到原值', () => {
    for (const [action, label] of Object.entries(AUDIT_ACTION_LABELS)) {
      expect(auditActionLabel(action)).toBe(label);
      expect(label.length).toBeGreaterThan(0);
    }
    expect(auditActionLabel('unknown.action')).toBe('unknown.action');
  });
});

import { describe, it, expect } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  maskApiKey,
  validateBaseUrl,
  resolveBaseUrl,
  resolveModel,
  normalizeProvider,
  PROVIDERS,
} from '@/lib/llm/credentials';

/**
 * 凭证加解密与地址校验的单测。
 *
 * 这是全项目**最不该出错**的一块：密钥保管不当的后果是直接的资金损失，
 * 而地址校验不当的后果是服务端被当成跳板。
 * 所以这里覆盖的重点是「失败路径」而不是「正常路径」。
 */

describe('encryptSecret / decryptSecret', () => {
  it('往返一致', () => {
    const key = 'sk-abcdef0123456789abcdef0123456789';
    expect(decryptSecret(encryptSecret(key))).toBe(key);
  });

  it('同一明文两次加密结果不同（IV 随机）', () => {
    const key = 'sk-same-input';
    const a = encryptSecret(key);
    const b = encryptSecret(key);
    expect(a).not.toBe(b);
    // 但都能解回同一个明文
    expect(decryptSecret(a)).toBe(key);
    expect(decryptSecret(b)).toBe(key);
  });

  it('密文里不含明文片段（不是「编码」而是真加密）', () => {
    const key = 'sk-super-secret-value-1234567890';
    const cipher = encryptSecret(key);
    expect(cipher).not.toContain('super-secret');
    expect(cipher).not.toContain(key);
  });

  it('密文被篡改时解密失败，而不是返回错误内容', () => {
    const cipher = encryptSecret('sk-original-key-value');
    const parts = cipher.split('.');
    // 翻转密文最后一个字符
    const last = parts[2]!;
    const tampered = [
      parts[0],
      parts[1],
      last.slice(0, -1) + (last.endsWith('A') ? 'B' : 'A'),
    ].join('.');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('authTag 被篡改时解密失败（GCM 的完整性保护）', () => {
    const cipher = encryptSecret('sk-original-key-value');
    const parts = cipher.split('.');
    expect(() => decryptSecret([parts[0], 'AAAAAAAAAAAAAAAAAAAAAA', parts[2]].join('.'))).toThrow();
  });

  it('格式不合法的密文抛错，而不是静默返回空串', () => {
    // 空 key 会让上游返回 401，用户看到「凭证无效」而真实原因是数据损坏 ——
    // 报错比返回空串更容易定位
    expect(() => decryptSecret('not-a-valid-payload')).toThrow();
    expect(() => decryptSecret('a.b')).toThrow();
  });
});

describe('maskApiKey', () => {
  it('保留前 3 后 4，中间用省略号', () => {
    expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-…cdef');
  });

  it('短 key 整体打码，不泄露长度以外的信息', () => {
    expect(maskApiKey('short')).toBe('••••••••');
    expect(maskApiKey('123456789012')).toBe('••••••••');
  });

  it('掩码里不含完整密钥', () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz';
    const masked = maskApiKey(key);
    expect(masked).not.toBe(key);
    expect(masked.length).toBeLessThan(key.length);
  });
});

describe('validateBaseUrl', () => {
  it('接受 https 公网地址', () => {
    const r = validateBaseUrl('https://api.example.com/v1');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://api.example.com/v1');
  });

  it('去掉尾部斜杠，避免拼出 //chat/completions', () => {
    expect(validateBaseUrl('https://api.example.com/v1/').url).toBe('https://api.example.com/v1');
  });

  it('拒绝非本机的 http（明文传输密钥）', () => {
    const r = validateBaseUrl('http://api.example.com/v1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BASE_URL_UNSAFE_PROTOCOL');
  });

  it('允许本机 http，方便接本地网关', () => {
    expect(validateBaseUrl('http://localhost:11434/v1').ok).toBe(true);
    expect(validateBaseUrl('http://127.0.0.1:8080').ok).toBe(true);
  });

  it('拒绝明显的内网地址', () => {
    for (const raw of [
      'https://10.0.0.5/v1',
      'https://192.168.1.10/v1',
      'https://172.16.3.4/v1',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      const r = validateBaseUrl(raw);
      expect(r.ok, raw).toBe(false);
      expect(r.reason, raw).toBe('BASE_URL_PRIVATE');
    }
  });

  it('拒绝非 http/https 协议', () => {
    expect(validateBaseUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateBaseUrl('ftp://example.com').ok).toBe(false);
    expect(validateBaseUrl('javascript:alert(1)').ok).toBe(false);
  });

  it('拒绝带用户名密码的地址（常见于绕过与钓鱼）', () => {
    expect(validateBaseUrl('https://user:pass@example.com/v1').ok).toBe(false);
  });

  it('空值与乱七八糟的输入都拒绝', () => {
    expect(validateBaseUrl('').reason).toBe('BASE_URL_REQUIRED');
    expect(validateBaseUrl('   ').reason).toBe('BASE_URL_REQUIRED');
    expect(validateBaseUrl('not a url').reason).toBe('BASE_URL_INVALID');
  });
});

describe('normalizeProvider / resolveBaseUrl / resolveModel', () => {
  it('识别大小写与空白', () => {
    expect(normalizeProvider(' DeepSeek ')).toBe('deepseek');
    expect(normalizeProvider('OPENAI')).toBe('openai');
    expect(normalizeProvider('custom')).toBe('custom');
  });

  it('未知 provider 返回 null（由调用方报校验错误）', () => {
    expect(normalizeProvider('anthropic')).toBeNull();
    expect(normalizeProvider('')).toBeNull();
  });

  it('自定义 baseUrl 优先于内置默认值', () => {
    expect(resolveBaseUrl('deepseek', 'https://my-gateway.example.com/v1')).toBe(
      'https://my-gateway.example.com/v1',
    );
    expect(resolveBaseUrl('deepseek', null)).toBe(PROVIDERS.deepseek.baseUrl);
  });

  it('模型留空时回落到该 provider 的默认模型', () => {
    expect(resolveModel('deepseek', '')).toBe('deepseek-flash');
    expect(resolveModel('deepseek', null)).toBe('deepseek-flash');
    expect(resolveModel('openai', undefined)).toBe('gpt-4o-mini');
  });

  it('用户填的模型原样保留（BYOK 不限制模型选择）', () => {
    expect(resolveModel('custom', 'my-local-model-7b')).toBe('my-local-model-7b');
  });
});

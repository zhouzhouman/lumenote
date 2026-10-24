import { describe, it, expect } from 'vitest';
import { asciiFilename, contentDisposition } from '@/lib/http/download';

/**
 * 这组用例来自一个真实故障：
 *
 *   批次名是中文（「e2e 批次」），导出 CSV 时把名字拼进
 *   `Content-Disposition: attachment; filename="batch-e2e 批次-xxxx.csv"`，
 *   构造 Response 时抛出
 *     TypeError: Cannot convert argument to a ByteString ...
 *   用户看到的是 500「服务内部错误」——明明只是导出。
 *
 * 所以这里最关键的断言不是「字符串长什么样」，而是
 * **这个头能不能真的被构造出来**（下面用 new Headers 复现同样的校验）。
 */
describe('contentDisposition：中文文件名不能直接进 HTTP 头', () => {
  it('中文名生成的头部可被 Headers 接受（等价于真实构造 Response）', () => {
    const h = contentDisposition('批次-e2e-2026 年报表.csv');
    expect(() => new Headers({ 'content-disposition': h })).not.toThrow();
  });

  it('头部里的每个字符都在 ByteString 范围内（≤ 0xFF）', () => {
    const h = contentDisposition('批次.csv');
    for (const ch of h) expect(ch.codePointAt(0)!).toBeLessThanOrEqual(0xff);
  });

  it('ASCII 兜底名不含中文，但仍保留扩展名', () => {
    const h = contentDisposition('批次.csv');
    const m = h.match(/filename="([^"]+)"/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/\.csv$/);
    expect(m![1]).not.toMatch(/[^\x20-\x7E]/);
  });

  it('filename* 能还原出原始中文名（浏览器优先用它）', () => {
    const h = contentDisposition('批次.csv');
    const m = h.match(/filename\*=UTF-8''(.+)$/);
    expect(m).not.toBeNull();
    expect(decodeURIComponent(m![1]!)).toBe('批次.csv');
  });

  it('引号与反斜杠会被清理，不会破坏头部语法', () => {
    const h = contentDisposition('a"b\\c.csv');
    const m = h.match(/filename="([^"]+)"/);
    expect(m![1]).not.toContain('"');
    expect(m![1]).not.toContain('\\');
  });
});

describe('asciiFilename', () => {
  it('把连续替代符压成一个，避免 a____b 这种噪声', () => {
    expect(asciiFilename('批次测试.csv')).not.toMatch(/_{2,}/);
  });

  it('空名字或全是非法字符时给出可用兜底', () => {
    expect(asciiFilename('')).toBe('download');
    expect(asciiFilename('批次')).toBe('download'); // 不要给用户一个「_.csv」
  });
});

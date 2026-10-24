import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `recordAudit` 的两条硬性质：
 *  1. **写不进去也不能影响业务**（吞异常，只打 error 日志）
 *  2. **落库前必须脱敏**（导出会给外部审计方，密钥不能跟着出去）
 *
 * 这两条一旦退化，症状都很隐蔽：前者表现为「某个操作偶尔 500」，
 * 后者表现为「导出文件里出现了 sk-xxx」。用 mock 把行为钉死。
 */
const create = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: { auditLog: { create: (...args: unknown[]) => create(...args) } },
}));

const { recordAudit } = await import('@/lib/audit/log');

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({});
});

describe('recordAudit', () => {
  it('正常写入：邮箱小写化，敏感字段被剔除', async () => {
    await recordAudit({
      userId: 'u1',
      actorEmail: '  MixedCase@Example.COM ',
      action: 'batch.export',
      targetType: 'batch',
      targetId: 'b1',
      meta: { apiKey: 'sk-leak', format: 'csv' },
      context: { ip: '10.0.0.1', userAgent: 'ua' },
    });

    expect(create).toHaveBeenCalledTimes(1);
    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.actorEmail).toBe('mixedcase@example.com');
    expect(data.ip).toBe('10.0.0.1');
    // 关键：密钥没有进库
    expect(JSON.stringify(data.meta)).not.toContain('sk-leak');
    expect(data.meta).toEqual({ format: 'csv' });
  });

  it('userId 缺省时写 null（用户被删后日志仍要留）', async () => {
    await recordAudit({
      actorEmail: 'gone@example.com',
      action: 'share.revoke',
      targetType: 'share',
    });

    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.userId).toBeNull();
    expect(data.outcome).toBe('success');
  });

  it('没有 meta 时写 null，而不是空对象', async () => {
    await recordAudit({ actorEmail: 'a@b.c', action: 'credential.delete', targetType: 'credential' });
    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.meta).toBeNull();
  });

  it('写入失败不抛异常（审计不能让业务失败），但要打 error 日志', async () => {
    create.mockRejectedValueOnce(new Error('db is down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      recordAudit({ actorEmail: 'a@b.c', action: 'batch.create', targetType: 'batch' }),
    ).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('调用方传 null 的 userId 也能接受（类型与运行时一致）', async () => {
    await recordAudit({
      userId: null,
      actorEmail: 'a@b.c',
      action: 'audit.export',
      targetType: 'audit',
    });
    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.userId).toBeNull();
  });
});

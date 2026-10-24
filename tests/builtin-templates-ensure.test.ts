import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ensureBuiltinTemplates, BUILTIN_TEMPLATES } from '@/lib/tasks/builtin-templates';

/**
 * `ensureBuiltinTemplates` 是「新部署自愈」的核心：模板缺失时由应用自己写入。
 *
 * 它不需要真库也能测 —— 逻辑分支只有三条：找不到就建、找到就更新、
 * 版本永远走 upsert（幂等）。用假 client 把这些分支钉死，
 * 比在集成测试里跑一遍要快得多，也能在 CI 的覆盖率门禁里留下证据。
 */
function fakeClient(existing?: { id: string; slug: string }) {
  const created: string[] = [];
  const updated: string[] = [];
  const versions: string[] = [];

  const client = {
    promptTemplate: {
      findFirst: vi.fn(async ({ where }: { where: { slug: string } }) =>
        existing && existing.slug === where.slug ? { id: existing.id, slug: existing.slug } : null,
      ),
      create: vi.fn(async ({ data }: { data: { slug: string } }) => {
        created.push(data.slug);
        return { id: `new-${data.slug}`, slug: data.slug };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { slug?: string } }) => {
        updated.push(where.id);
        return { id: where.id, slug: data.slug ?? 'x' };
      }),
    },
    promptVersion: {
      upsert: vi.fn(async ({ where, create }: { where: unknown; create: { templateId: string } }) => {
        versions.push(create.templateId);
        return { where, create };
      }),
    },
  };

  return { client: client as unknown as PrismaClient, created, updated, versions, raw: client };
}

describe('ensureBuiltinTemplates', () => {
  it('模板不存在时创建，并为每个模板写一条 v1 版本', async () => {
    const { client, created, versions } = fakeClient();
    const slugs = await ensureBuiltinTemplates(client);

    expect(slugs).toEqual(BUILTIN_TEMPLATES.map((t) => t.slug));
    expect(created).toHaveLength(BUILTIN_TEMPLATES.length);
    // 每个模板都要有一版 prompt，否则任务渲染时拿不到内容
    expect(versions).toHaveLength(BUILTIN_TEMPLATES.length);
  });

  it('模板已存在时走 update，不重复创建', async () => {
    const first = BUILTIN_TEMPLATES[0]!;
    const { client, created, updated } = fakeClient({ id: 'exist-1', slug: first.slug });
    await ensureBuiltinTemplates(client);

    expect(updated).toContain('exist-1');
    // 只有第一个是「已存在」，其余仍走创建
    expect(created).toHaveLength(BUILTIN_TEMPLATES.length - 1);
    expect(created).not.toContain(first.slug);
  });

  it('版本写入用 upsert（幂等），重复执行不会产生 v2', async () => {
    const { client, raw } = fakeClient();
    await ensureBuiltinTemplates(client);
    await ensureBuiltinTemplates(client);

    for (const call of raw.promptVersion.upsert.mock.calls) {
      const arg = call[0] as unknown as { where: { templateId_version: { version: number } } };
      expect(arg.where.templateId_version.version).toBe(1);
    }
  });

  it('写库时把模板标记为 active（否则查询会过滤掉自己写的模板）', async () => {
    const { client, raw } = fakeClient();
    await ensureBuiltinTemplates(client);

    for (const call of raw.promptTemplate.create.mock.calls) {
      expect((call[0] as unknown as { data: { isActive: boolean } }).data.isActive).toBe(true);
    }
    for (const call of raw.promptVersion.upsert.mock.calls) {
      const arg = call[0] as unknown as { update: { status: string }; create: { status: string } };
      expect(arg.update.status).toBe('active');
      expect(arg.create.status).toBe('active');
    }
  });
});

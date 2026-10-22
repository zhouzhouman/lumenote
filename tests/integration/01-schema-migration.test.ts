/**
 * 用例 1：空库迁移。
 *
 * globalSetup 已经把 public schema 整体 drop 再 `prisma migrate deploy` 过一遍，
 * 所以这里断言的是「那次从零迁移的可观测结果」——不是重新造数据库，
 * 而是确认它确实按预期落地了：
 *   - `_prisma_migrations` 有且只有 7 条成功记录（当前仓库的迁移数）
 *   - 所有迁移都 finished、没有 rolled back
 *   - 核心表真实存在（不是「代码里定义了」而是「库里查得到」）
 *   - 应用能连上这个库（/api/health 的 db.ok）
 *
 * ⚠️ 新增迁移后这个用例会失败，这是**刻意的**：迁移数变化应该被显式确认，
 * 而不是让「空库能否从零迁移」悄悄退化。届时把 EXPECTED_MIGRATIONS 一起更新。
 */
import { describe, expect, it } from 'vitest';
import { db } from './helpers/db';
import { baseUrl } from './helpers/env';

/** 当前仓库 prisma/migrations 下的 7 个迁移（按应用顺序） */
const EXPECTED_MIGRATIONS = [
  '20261012052437_init',
  '20261014090000_add_api_credential',
  '20261016120000_add_auth_security',
  '20261016123225_add_agent_step',
  '20261016124919_add_eval_framework',
  '20261017054435_judge_calibration_add_question',
  // 批次：团队内部文档流水线（Batch 表 + Task.batchId/batchOrder）
  '20261022035000_add_batch',
] as const;

/** 核心业务表：缺任何一张都说明迁移链断了 */
const CORE_TABLES = [
  'User',
  'Session',
  'LoginAttempt',
  'SecurityEvent',
  'EmailVerificationCode',
  'PromptTemplate',
  'PromptVersion',
  'Task',
  'Batch',
  'UsageLog',
  'AgentStep',
  'KnowledgeChunk',
  'ShareLink',
  'ApiCredential',
  'GlossaryTerm',
] as const;

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
  logs: string | null;
}

describe('空库迁移（globalSetup 的 DROP + migrate deploy 结果）', () => {
  it('`_prisma_migrations` 记录了 7 条已成功应用的迁移', async () => {
    const rows = await db().$queryRawUnsafe<MigrationRow[]>(
      'SELECT migration_name, finished_at, rolled_back_at, logs FROM "_prisma_migrations" ORDER BY started_at ASC',
    );

    expect(rows).toHaveLength(EXPECTED_MIGRATIONS.length);
    expect(rows.map((r) => r.migration_name)).toEqual([...EXPECTED_MIGRATIONS]);

    for (const row of rows) {
      expect(row.finished_at, `迁移 ${row.migration_name} 尚未完成`).not.toBeNull();
      expect(row.rolled_back_at, `迁移 ${row.migration_name} 被回滚了`).toBeNull();
    }
  });

  it('核心业务表全部存在于 public schema', async () => {
    const rows = await db().$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const existing = new Set(rows.map((r) => r.table_name));

    for (const table of CORE_TABLES) {
      expect(existing.has(table), `缺少核心表 public."${table}"`).toBe(true);
    }
  });

  it('迁移产生的外键/唯一约束真实生效（UsageLog.taskId 唯一）', async () => {
    // UsageLog.taskId 唯一是「一个任务只结算一次」的最终防线，
    // 这条约束如果没被迁移出来，幂等计费用例会假通过。
    const constraints = await db().$queryRawUnsafe<{ indexname: string; indexdef: string }[]>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'UsageLog'`,
    );
    const uniqueOnTaskId = constraints.some(
      (c) => /UNIQUE/i.test(c.indexdef) && c.indexdef.toLowerCase().includes('taskid'),
    );
    expect(uniqueOnTaskId, 'UsageLog.taskId 唯一索引不存在').toBe(true);
  });

  it('/api/health 返回 200 且 db.ok=true', async () => {
    const res = await fetch(`${baseUrl()}/api/health`, { signal: AbortSignal.timeout(10_000) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status?: string; db?: { ok?: boolean } };
    expect(json.status).toBe('ok');
    expect(json.db?.ok).toBe(true);
  });
});

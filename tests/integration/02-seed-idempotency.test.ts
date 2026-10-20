/**
 * 用例 2：seed 幂等。
 *
 * seed 会在每次部署后重跑（CI 的 integration job 就显式跑了一次，
 * 再叠加 globalSetup 与「重复执行安全」的承诺），所以它必须真的幂等：
 * 重复执行不能多出 User / PromptTemplate / KnowledgeChunk / Task / UsageLog。
 *
 * 这里跑两次 `tsx prisma/seed.ts`（不是 import 函数），因为要验证的就是
 * **这条命令**能被安全重放；同时断言输出里出现「已存在，已更新」——
 * 光看行数不变还不够：如果 seed 把旧行删掉再重建，行数也不变，
 * 但历史外键会断。输出文案能佐证它走的是「更新」分支。
 */
import { describe, expect, it } from 'vitest';
import { checkEvidence } from '@/lib/agent/evidence';
import type { AgentStructuredOutput } from '@/lib/agent/types';
import { estimateTokens } from '@/lib/llm/mock';
import type { TextChunk } from '@/lib/pipeline/chunk';
import { db } from './helpers/db';
import { runSeed } from './helpers/seed';

const DEMO_EMAIL = 'demo@lumenote.dev';
const DEMO_TASK_KEY = 'seed:demo-docqa-v1';

interface SeedCounts {
  demoUsers: number;
  builtinTemplates: number;
  builtinTemplateVersions: number;
  demoTaskIds: number;
  demoKnowledgeChunks: number;
  demoAgentSteps: number;
  demoUsageLogs: number;
}

async function snapshotCounts(): Promise<SeedCounts> {
  const demoTask = await db().task.findFirst({
    where: { idempotencyKey: DEMO_TASK_KEY },
    select: { id: true },
  });
  const demoTaskId = demoTask?.id ?? '__missing__';

  const [
    demoUsers,
    builtinTemplates,
    builtinTemplateVersions,
    demoTaskIds,
    demoKnowledgeChunks,
    demoAgentSteps,
    demoUsageLogs,
  ] = await Promise.all([
    db().user.count({ where: { email: DEMO_EMAIL } }),
    db().promptTemplate.count({ where: { userId: null } }),
    db().promptVersion.count({ where: { template: { userId: null } } }),
    db().task.count({ where: { idempotencyKey: DEMO_TASK_KEY } }),
    db().knowledgeChunk.count({ where: { taskId: demoTaskId } }),
    db().agentStep.count({ where: { taskId: demoTaskId } }),
    db().usageLog.count({ where: { taskId: demoTaskId } }),
  ]);

  return {
    demoUsers,
    builtinTemplates,
    builtinTemplateVersions,
    demoTaskIds,
    demoKnowledgeChunks,
    demoAgentSteps,
    demoUsageLogs,
  };
}

const EXPECTED_COUNTS: SeedCounts = {
  demoUsers: 1,
  builtinTemplates: 4,
  builtinTemplateVersions: 4,
  demoTaskIds: 1,
  demoKnowledgeChunks: 3,
  demoAgentSteps: 3,
  demoUsageLogs: 1,
};

describe('seed 幂等（tsx prisma/seed.ts 重复执行）', () => {
  it('globalSetup 的首次 seed 已写入预期行数', async () => {
    expect(await snapshotCounts()).toEqual(EXPECTED_COUNTS);
  });

  it('连续两次执行 seed：行数不变，且第二次输出「已存在，已更新」', async () => {
    const before = await snapshotCounts();

    // ---- 第 1 次重跑 ----
    const first = runSeed();
    expect(first.status, `seed 失败：\n${first.stderr.slice(0, 1500)}`).toBe(0);
    expect(first.stdout).toContain('[seed] ✓ 全部完成');
    expect(await snapshotCounts()).toEqual(before);

    // ---- 第 2 次重跑 ----
    const second = runSeed();
    expect(second.status, `seed 失败：\n${second.stderr.slice(0, 1500)}`).toBe(0);
    expect(second.stdout).toContain('[seed] ✓ 全部完成');
    // 演示 Agent 任务走的是「已存在 → 更新」分支（不是删掉重建）
    expect(second.stdout).toContain('已存在，已更新');
    expect(second.stdout).toContain('表行数');
    expect(await snapshotCounts()).toEqual(before);
  });

  it('演示 Agent 任务的证据链可被确定性校验（只读断言）', async () => {
    const task = await db().task.findFirst({
      where: { idempotencyKey: DEMO_TASK_KEY },
      include: { chunks: { orderBy: { seq: 'asc' } } },
    });
    expect(task, 'seed 的演示 Agent 任务不存在').not.toBeNull();
    expect(task?.status).toBe('succeeded');
    expect(task?.outputContent?.length).toBeGreaterThan(0);

    const outputMeta = (task?.outputMeta ?? {}) as {
      structured?: AgentStructuredOutput | null;
    };
    const structured = outputMeta.structured ?? null;
    expect(structured?.conclusions?.length).toBe(3);

    const chunks: TextChunk[] = (task?.chunks ?? []).map((c) => ({
      index: c.seq,
      content: c.content,
      tokens: estimateTokens(c.content),
    }));
    assertChunks(chunks);

    const check = checkEvidence(structured ?? null, chunks);
    expect(check.total).toBe(4);
    expect(check.verified).toBe(4);
    expect(check.missing).toEqual([]);
    expect(check.rate).toBe(1);
  });
});

/** 证据校验的前置条件：分块序号必须是 0,1,2（chunk:N 的 N 与 seq 对齐） */
function assertChunks(chunks: TextChunk[]): void {
  expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  for (const chunk of chunks) {
    expect(chunk.content.length).toBeGreaterThan(0);
  }
}

/**
 * 用例 6：任务状态机。
 *
 * 两条路径都必须验证：
 *  1. **成功路径**：POST 只建任务（queued），after() 异步跑管线，状态经
 *     queued/running 到 succeeded。这是「两段式流式」架构的地基，
 *     POST 必须立刻返回 taskId，而不是等模型跑完。
 *  2. **失败路径**：输入为空的任务在 lifecycle 阶段就落 failed（INPUT_EMPTY），
 *     且失败后 errorCode/errorMessage/completedAt 齐全 —— 前端据此展示可读错误。
 *
 * 失败路径刻意**直接插库**造数据：正常 API 有「content 至少 10 字符」校验，
 * 根本造不出空输入任务。而 lifecycle 的兜底必须能处理历史数据/手工改库
 * 造成的坏行，所以这个用例绕开 API、直接驱动 runner（这正是它存在的意义）。
 */
import { describe, expect, it } from 'vitest';
import { registerTestUser } from './helpers/auth';
import { db } from './helpers/db';
import { createTask, getTaskDetail, isTerminalStatus, LONG_DOC } from './helpers/tasks';
import { sleep } from './helpers/wait';

describe('任务状态机', () => {
  it(
    'POST 立即返回 queued，轮询可观察到非终态，最终 succeeded 且用量/指纹齐全',
    async () => {
      const user = await registerTestUser();

      // 长文档 → 走 Map-Reduce 多块路径，运行时间足够被轮询观察到
      const created = await createTask(user.client, { content: LONG_DOC });
      expect(created.response.status).toBe(200);
      expect(created.data.replayed).toBe(false);
      // 创建接口不等模型：返回时任务不应已经是 succeeded
      expect(['queued', 'running']).toContain(created.data.status);

      const observed: string[] = [];
      const deadline = Date.now() + 60_000;
      let detail = await getTaskDetail(user.client, created.data.taskId);
      while (!isTerminalStatus(detail.status) && Date.now() < deadline) {
        observed.push(detail.status);
        await sleep(120);
        detail = await getTaskDetail(user.client, created.data.taskId);
      }
      observed.push(detail.status);

      expect(detail.status, `错误信息：${String(detail.errorCode)} / ${String(detail.errorMessage)}`).toBe(
        'succeeded',
      );
      // 必须真的观察到过「进行中」——否则两段式异步执行就没被证明
      expect(
        observed.some((s) => s === 'queued' || s === 'running'),
        `观察到的状态序列：${observed.join(' → ')}`,
      ).toBe(true);

      expect(detail.outputContent?.length ?? 0).toBeGreaterThan(0);
      expect(detail.completedAt).not.toBeNull();
      expect(detail.latencyMs).toBeGreaterThan(0);
      expect(detail.promptVersion.templateName).toBe('长文摘要');
      expect(detail.promptVersion.version).toBe(1);
      expect(detail.usage, '成功的任务必须有计量记录').not.toBeNull();
      expect(detail.usage!.inputTokens).toBeGreaterThan(0);
      expect(detail.usage!.outputTokens).toBeGreaterThan(0);

      // 长文真的走了多块路径（outputMeta.chunks 是 pipeline 落库的分块数）
      const outputMeta = (detail.outputMeta ?? {}) as { chunks?: number };
      expect(outputMeta.chunks ?? 0).toBeGreaterThanOrEqual(2);

      // DB 侧：状态与计量都落库了
      const row = await db().task.findUnique({
        where: { id: detail.id },
        select: { status: true, completedAt: true },
      });
      expect(row?.status).toBe('succeeded');
      expect(row?.completedAt).not.toBeNull();

      // 详情接口的用量与 DB 的计量一致（不是只在 memory 里算了一下）
      const usage = await db().usageLog.findUnique({ where: { taskId: detail.id } });
      expect(usage).not.toBeNull();
      expect(detail.usage!.inputTokens).toBe(usage!.promptTokens);
    },
    120_000,
  );

  it(
    '输入为空的任务由 runner 落为 failed（INPUT_EMPTY），并带可读错误信息',
    async () => {
      const user = await registerTestUser();

      // 取种子写入的摘要模板与 active 版本，构造一条「结构合法但内容非法」的任务
      const template = await db().promptTemplate.findFirst({
        where: { userId: null, slug: 'sys:summarize.long' },
        include: {
          versions: { where: { status: 'active' }, orderBy: { version: 'desc' }, take: 1 },
        },
      });
      expect(template, 'seed 未写入摘要模板').not.toBeNull();
      const version = template!.versions[0];
      expect(version).toBeDefined();

      const badTask = await db().task.create({
        data: {
          userId: user.id,
          type: 'summarize',
          title: '坏任务：空输入',
          status: 'queued',
          inputType: 'text',
          inputContent: '',
          inputMeta: { charCount: 0 } as never,
          templateId: template!.id,
          promptVersionId: version!.id,
          params: {
            model: 'deepseek-flash',
            style: '要点式',
            maxPoints: '5',
            targetReader: '普通读者',
          } as never,
        },
      });

      // 在测试进程中直接驱动 runner（与 after() 里调用的是同一个函数）
      const { runSummarizePipeline } = await import('@/lib/pipeline/runner');
      await expect(runSummarizePipeline({ taskId: badTask.id })).rejects.toThrow();

      const failed = await db().task.findUnique({ where: { id: badTask.id } });
      expect(failed?.status).toBe('failed');
      expect(failed?.errorCode).toBe('INPUT_EMPTY');
      expect(failed?.errorMessage).toBe('输入内容为空');
      expect(failed?.completedAt).not.toBeNull();
    },
    120_000,
  );
});

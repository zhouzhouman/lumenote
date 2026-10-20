/**
 * 用例 4 & 5：幂等键与每日配额。
 *
 * 这两条都是**成本保护**，而且都必须在真实 DB 上验证：
 *  - 幂等依赖 `Task @@unique([userId, idempotencyKey])` 与 `UsageLog.taskId @unique`，
 *    单测里 mock 掉数据库就只是在测 mock；
 *  - 配额依赖 Task 表的计数，必须真的落库才能验证「第 2 次被拦」。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { registerTestUser, type TestUser } from './helpers/auth';
import { db } from './helpers/db';
import { createTask, LONG_DOC, runSummarizeTask, waitForTaskSucceeded, waitForTaskTerminal } from './helpers/tasks';

describe('幂等键：同一 key 重复 POST 不重复建任务/计费', () => {
  it(
    '两次相同 Idempotency-Key 返回同一 taskId，DB 只有一条任务与一条 UsageLog',
    async () => {
      const user = await registerTestUser();
      const idempotencyKey = `it-idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const body = {
        type: 'summarize',
        content:
          '幂等键是 AI 应用的头号成本防线：用户双击按钮、网络超时重试、SSE 断线重连都会造成重复提交，' +
          '而每一次重复提交在 LLM 场景里都意味着真实扣费。',
        params: { style: '要点式', maxPoints: '5', targetReader: '普通读者' },
      };

      const first = await user.client.post('/api/tasks', body, {
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      expect(first.status, first.text.slice(0, 500)).toBe(200);
      expect(first.json?.data?.replayed).toBe(false);
      const taskId = String(first.json?.data?.taskId);
      expect(taskId.length).toBeGreaterThan(0);

      // 立刻重放（此时任务可能还在 queued/running，命中「快路径」不产生第二次调用）
      const second = await user.client.post('/api/tasks', body, {
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      expect(second.status, second.text.slice(0, 500)).toBe(200);
      expect(second.json?.data?.taskId).toBe(taskId);
      expect(second.json?.data?.replayed).toBe(true);

      // 数据库层面：该用户该幂等键只有 1 条任务
      const taskCount = await db().task.count({ where: { userId: user.id, idempotencyKey } });
      expect(taskCount).toBe(1);
      const totalTasks = await db().task.count({ where: { userId: user.id } });
      expect(totalTasks).toBe(1);

      // 等任务完成后再断言计量：UsageLog.taskId 唯一 → 一个任务只结算一次
      await waitForTaskSucceeded(user.client, taskId);
      const usageLogs = await db().usageLog.findMany({ where: { taskId } });
      expect(usageLogs).toHaveLength(1);
      expect(usageLogs[0]!.userId).toBe(user.id);
      expect(usageLogs[0]!.promptTokens).toBeGreaterThan(0);
      expect(usageLogs[0]!.completionTokens).toBeGreaterThan(0);

      // 再用同一 key 提交一次（任务已完成），仍然只是重放
      const third = await user.client.post('/api/tasks', body, {
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      expect(third.status).toBe(200);
      expect(third.json?.data?.taskId).toBe(taskId);
      expect(third.json?.data?.replayed).toBe(true);
      expect(await db().task.count({ where: { userId: user.id } })).toBe(1);
    },
    120_000,
  );

  it('不同 key 会创建不同的任务（确保上一条不是「所有 POST 都返回同一任务」）', async () => {
    const user = await registerTestUser();
    const { data: one } = await createTask(user.client, {}, { 'Idempotency-Key': 'it-key-one' });
    // 等第一个任务进入终态：并发上限是 1，未完成时第二个 POST 会先被 TOO_MANY_RUNNING 拦下
    const firstDetail = await waitForTaskTerminal(user.client, one.taskId);
    expect(firstDetail.status).toBe('succeeded');

    const { data: two } = await createTask(user.client, {}, { 'Idempotency-Key': 'it-key-two' });
    expect(one.taskId).not.toBe(two.taskId);
    expect(one.replayed).toBe(false);
    expect(two.replayed).toBe(false);
  });
});

describe('每日配额：dailyQuota=1 时第 2 个任务被拒绝', () => {
  /** 共享前置：一个配额=1 的用户 + 已成功的第 1 个任务 */
  let user: TestUser;

  beforeAll(async () => {
    user = await registerTestUser();
    // 直接改库把配额压到 1（模拟「今日免费额度已用完」的最短路径）
    await db().user.update({ where: { id: user.id }, data: { dailyQuota: 1 } });
    // 第 1 个任务：成功（必须等它进入终态，否则第 2 个会先撞并发上限而不是配额）
    const first = await runSummarizeTask(user.client);
    expect(first.status).toBe('succeeded');
  }, 120_000);

  function postSecondTask() {
    return user.client.post('/api/tasks', {
      type: 'summarize',
      content: '第二条任务应该因为每日免费配额已用完而被拒绝，这段文字只是为了通过长度校验。',
      params: { style: '要点式', maxPoints: '5', targetReader: '普通读者' },
    });
  }

  it(
    '第 2 个任务返回 429 + QUOTA_EXCEEDED + Retry-After，且不会多建任务',
    async () => {
      const res = await postSecondTask();

      // CR-1 已修复（main commit 10465d2）：配额错误现在真正 throw LLMError，
      // handleError 会走 429 分支并带 Retry-After，前端才能提示「额度用完」。
      expect(res.status, res.text.slice(0, 500)).toBe(429);
      expect(res.json?.error?.code).toBe('QUOTA_EXCEEDED');
      expect(String(res.json?.error?.message)).toContain('今日免费额度已用完');
      expect(res.headers.get('retry-after')).toBe('30');

      // 核心成本属性：被拒绝的请求不能留下任务记录（否则配额只拦了调用、没拦住数据）
      expect(await db().task.count({ where: { userId: user.id } })).toBe(1);
      expect(await db().task.count({ where: { userId: user.id, status: 'queued' } })).toBe(0);
    },
    120_000,
  );

  it(
    '并发上限：前一个任务未完成时，第二个 POST 返回 429 TOO_MANY_RUNNING',
    async () => {
      const concurrentUser = await registerTestUser();
      // 长文档 → 多块 Map-Reduce，保证第一个任务在第二个请求到达时仍在执行
      const { data: first } = await createTask(concurrentUser.client, { content: LONG_DOC });
      expect(['queued', 'running']).toContain(first.status);

      const second = await concurrentUser.client.post('/api/tasks', {
        type: 'summarize',
        content: '这个问题不应该被创建：同一用户同时只允许一个进行中的任务，第二笔会放大成本。',
        params: { style: '要点式', maxPoints: '5', targetReader: '普通读者' },
      });
      expect(second.status, second.text.slice(0, 500)).toBe(429);
      expect(second.json?.error?.code).toBe('TOO_MANY_RUNNING');
      expect(second.headers.get('retry-after')).toBe('30');

      // 只留下第一个任务；第二个被拦在创建之前
      expect(await db().task.count({ where: { userId: concurrentUser.id } })).toBe(1);
      // 等第一个任务收尾，避免影响后续用例的并发计数
      await waitForTaskTerminal(concurrentUser.client, first.taskId);
    },
    120_000,
  );
});

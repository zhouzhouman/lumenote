/**
 * 用例 3：越权（IDOR）。
 *
 * 这是本项目最关键的安全属性：用户 B 拿到用户 A 的 taskId 后，
 * 读详情 / 删除 / 订阅 SSE / 做 diff / 列追问 全部必须失败。
 *
 * 判定标准统一是 **404 而不是 403**：区分「存在但无权」与「不存在」
 * 本身就是信息泄露（可以拿来枚举 id）。所以这里断言 404 + NOT_FOUND。
 *
 * 同时必须有「对照组」：A 访问自己的同一资源要成功。
 * 只有 404 断言没有对照组时，一个「所有请求都 404」的实现也能让用例通过。
 */
import { describe, expect, it } from 'vitest';
import { ApiClient } from './helpers/api';
import { registerTestUser, uniqueXff } from './helpers/auth';
import { db } from './helpers/db';
import { findSseEvent, lastDoneEvent, subscribeSse } from './helpers/sse';
import { createTask, runSummarizeTask, waitForTaskSucceeded } from './helpers/tasks';

describe('越权防护（IDOR）', () => {
  it(
    'B 无法读取 / 删除 / 订阅 / diff / 追问 A 的任务，A 自己可以',
    async () => {
      const alice = await registerTestUser({ name: 'Alice' });
      const bob = await registerTestUser({ name: 'Bob' });

      // A 的任务（后面所有越权尝试的目标）
      const { data: createdA } = await createTask(alice.client);
      const aTask = await waitForTaskSucceeded(alice.client, createdA.taskId);

      // B 自己的任务：用来构造「一方是自己的、另一方是别人的」diff
      const bTask = await runSummarizeTask(bob.client);

      // ---- 1) 读详情 ----
      const bGet = await bob.client.get(`/api/tasks/${aTask.id}`);
      expect(bGet.status, bGet.text.slice(0, 300)).toBe(404);
      expect(bGet.json?.error?.code).toBe('NOT_FOUND');

      // ---- 2) 删除 ----
      const bDelete = await bob.client.delete(`/api/tasks/${aTask.id}`);
      expect(bDelete.status, bDelete.text.slice(0, 300)).toBe(404);
      const untouched = await db().task.findUnique({
        where: { id: aTask.id },
        select: { deletedAt: true },
      });
      expect(untouched?.deletedAt, 'B 的越权 DELETE 不应产生任何写入').toBeNull();

      // ---- 3) 订阅 SSE ----
      // SSE 不能返回 JSON 错误（EventSource 会静默失败），所以越权通过 error 事件表达
      const stream = await subscribeSse({
        client: bob.client,
        pathname: `/api/tasks/${aTask.id}/stream`,
        timeoutMs: 20_000,
      });
      expect(stream.error).toBeNull();
      expect(stream.status).toBe(200);
      expect(findSseEvent(stream.events, 'error')?.data?.code).toBe('NOT_FOUND');
      expect(lastDoneEvent(stream.events)?.data?.status).toBe('failed');
      // 越权订阅绝不能泄漏任何正文
      expect(stream.events.some((e) => e.event === 'token')).toBe(false);

      // ---- 4) diff：任何一侧不属于自己都 404 ----
      const diff = await bob.client.get(`/api/diff?a=${bTask.id}&b=${aTask.id}`);
      expect(diff.status, diff.text.slice(0, 300)).toBe(404);
      expect(diff.json?.error?.code).toBe('NOT_FOUND');

      // 记录既有语义：a === b 在鉴权之前就被 422 拦下（见 diff/route.ts 的参数校验顺序）。
      // 这不是越权漏洞（没有任何内容返回），但行为与「404」不同，用例里显式固化下来。
      const sameId = await bob.client.get(`/api/diff?a=${aTask.id}&b=${aTask.id}`);
      expect(sameId.status).toBe(422);
      expect(sameId.json?.error?.code).toBe('VALIDATION_ERROR');

      // ---- 5) 追问列表 ----
      const followup = await bob.client.get(`/api/followup?taskId=${aTask.id}`);
      expect(followup.status, followup.text.slice(0, 300)).toBe(404);
      expect(followup.json?.error?.code).toBe('NOT_FOUND');

      // ---- 对照组：A 访问自己的资源必须成功 ----
      const aGet = await alice.client.get(`/api/tasks/${aTask.id}`);
      expect(aGet.status).toBe(200);
      expect(aGet.json?.data?.id).toBe(aTask.id);

      // A 可以对自己的任务做 diff（两个自己的任务）
      const { data: createdA2 } = await createTask(alice.client);
      await waitForTaskSucceeded(alice.client, createdA2.taskId);
      const aDiff = await alice.client.get(`/api/diff?a=${aTask.id}&b=${createdA2.taskId}`);
      expect(aDiff.status).toBe(200);
      expect(aDiff.json?.data?.a?.id).toBe(aTask.id);
      expect(aDiff.json?.data?.b?.id).toBe(createdA2.taskId);
    },
    120_000,
  );

  it('匿名访问受保护接口返回 401（而不是 404 或 200）', async () => {
    const alice = await registerTestUser();
    const task = await runSummarizeTask(alice.client);
    const anonymous = new ApiClient({ xff: uniqueXff() });

    const get = await anonymous.get(`/api/tasks/${task.id}`);
    expect(get.status).toBe(401);
    expect(get.json?.error?.code).toBe('UNAUTHENTICATED');

    const create = await anonymous.post('/api/tasks', {
      type: 'summarize',
      content: '匿名用户不应该能创建任务，这段文字只是为了通过长度校验。',
      params: { style: '要点式', maxPoints: '5' },
    });
    expect(create.status).toBe(401);
  });

  it(
    '对照组：A 删除自己的任务后不可读，PATCH 恢复后重新可读',
    async () => {
      const alice = await registerTestUser();
      const task = await runSummarizeTask(alice.client);

      const del = await alice.client.delete(`/api/tasks/${task.id}`);
      expect(del.status).toBe(200);
      expect((await alice.client.get(`/api/tasks/${task.id}`)).status).toBe(404);

      const restore = await alice.client.patch(`/api/tasks/${task.id}`, {});
      expect(restore.status).toBe(200);
      expect((await alice.client.get(`/api/tasks/${task.id}`)).status).toBe(200);
    },
    120_000,
  );
});

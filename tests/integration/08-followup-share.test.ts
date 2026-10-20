/**
 * 用例 9（加分项）：追问链与分享链接。
 *
 * 追问：创建子任务并关联 parentTaskId；GET 列表与 ?whole=1 的整条对话链。
 * 分享：匿名可读（全项目唯一免登录读取路径）、越权创建 404、撤销后失效。
 *
 * 这两条都涉及「绕过常规归属校验的读取路径」，因此光断言 200 不够，
 * 越权与撤销后的 404 必须一起验证。
 */
import { describe, expect, it } from 'vitest';
import { ApiClient } from './helpers/api';
import { registerTestUser, uniqueXff } from './helpers/auth';
import { db } from './helpers/db';
import { findSseEvent, subscribeSse } from './helpers/sse';
import { runSummarizeTask, waitForTaskSucceeded } from './helpers/tasks';

interface FollowupChainItem {
  id: string;
  parentTaskId: string | null;
  kind: 'root' | 'followup';
  question: string | null;
  status: string;
  outputContent: string | null;
}

describe('追问（followup）', () => {
  it(
    '创建子任务并关联 parentTaskId；列表与整条链都能看到',
    async () => {
      const user = await registerTestUser();
      const parent = await runSummarizeTask(user.client);

      const res = await user.client.post('/api/followup', {
        parentTaskId: parent.id,
        question: '第二条能展开说说吗？',
      });
      expect(res.status, res.text.slice(0, 500)).toBe(200);
      const childId = String(res.json?.data?.taskId);
      expect(childId.length).toBeGreaterThan(0);
      expect(res.json?.data?.parentTaskId).toBe(parent.id);

      const child = await waitForTaskSucceeded(user.client, childId);
      expect(child.type).toBe(parent.type);
      const childRow = await db().task.findUnique({
        where: { id: childId },
        select: { parentTaskId: true, title: true },
      });
      expect(childRow?.parentTaskId).toBe(parent.id);
      expect(childRow?.title).toContain('追问');

      // ---- 直接子任务列表 ----
      const list = await user.client.get(`/api/followup?taskId=${parent.id}`);
      expect(list.status).toBe(200);
      const items = (list.json?.data?.items ?? []) as { id: string }[];
      expect(items).toHaveLength(1);
      expect(items[0]!.id).toBe(childId);

      // ---- 整条对话链（从根展开） ----
      const whole = await user.client.get(`/api/followup?taskId=${parent.id}&whole=1`);
      expect(whole.status).toBe(200);
      expect(whole.json?.data?.rootId).toBe(parent.id);
      const chain = (whole.json?.data?.items ?? []) as FollowupChainItem[];
      expect(chain).toHaveLength(2);
      expect(chain[0]!.id).toBe(parent.id);
      expect(chain[0]!.kind).toBe('root');
      expect(chain[1]!.id).toBe(childId);
      expect(chain[1]!.kind).toBe('followup');
      expect(chain[1]!.question).toContain('第二条能展开');
      expect(chain[1]!.outputContent?.length ?? 0).toBeGreaterThan(0);

      // 子任务的 SSE 也必须可订阅（追问靠同一个 stream 接口消费）
      const stream = await subscribeSse({
        client: user.client,
        pathname: `/api/tasks/${childId}/stream`,
        timeoutMs: 30_000,
      });
      expect(stream.error).toBeNull();
      expect(findSseEvent(stream.events, 'done')?.data?.status).toBe('succeeded');
    },
    150_000,
  );
});

describe('分享链接（share）', () => {
  it(
    '匿名可读；越权创建 404；撤销后链接失效',
    async () => {
      const alice = await registerTestUser({ name: 'Alice' });
      const bob = await registerTestUser({ name: 'Bob' });
      const task = await runSummarizeTask(alice.client, {
        title: '可分享的可追溯性摘要',
      });

      // ---- 创建分享链接（仅本人任务） ----
      const created = await alice.client.post('/api/share', { taskId: task.id });
      expect(created.status, created.text.slice(0, 500)).toBe(200);
      const token = String(created.json?.data?.token ?? '');
      expect(token.length).toBeGreaterThan(20);

      // ---- 匿名读取（不带 cookie）----
      const anonymous = new ApiClient({ xff: uniqueXff() });
      const page = await anonymous.get(`/share/${token}`, {
        headers: { Accept: 'text/html' },
        withCookies: false,
      });
      expect(page.status, page.text.slice(0, 500)).toBe(200);
      expect(page.headers.get('content-type') ?? '').toContain('text/html');
      // 页面渲染了只读提示与标题（说明真的读出并渲染了任务内容）
      expect(page.text).toContain('只读分享');
      expect(page.text).toContain('可分享的可追溯性摘要');

      // 无效 token 一律 404（不区分「不存在」与「无权限」）
      const invalid = await anonymous.get('/share/not-a-valid-token-format!!!', {
        headers: { Accept: 'text/html' },
        withCookies: false,
      });
      expect(invalid.status).toBe(404);

      // ---- 越权：B 不能给 A 的任务创建分享链接 ----
      const bobShare = await bob.client.post('/api/share', { taskId: task.id });
      expect(bobShare.status, bobShare.text.slice(0, 300)).toBe(404);
      expect(bobShare.json?.error?.code).toBe('NOT_FOUND');

      // B 也不能查询 A 任务的分享状态
      const bobGet = await bob.client.get(`/api/share?taskId=${task.id}`);
      expect(bobGet.status).toBe(404);

      // ---- 撤销后链接必须失效（否则「删除/撤销」就是假动作）----
      const revoked = await alice.client.delete(`/api/share?taskId=${task.id}`);
      expect(revoked.status).toBe(200);
      const afterRevoke = await anonymous.get(`/share/${token}`, {
        headers: { Accept: 'text/html' },
        withCookies: false,
      });
      expect(afterRevoke.status).toBe(404);

      // 撤销后重新创建：复用同一条 ShareLink 并复活（不是一个新 token 覆盖旧链接）
      const revived = await alice.client.post('/api/share', { taskId: task.id });
      expect(revived.status).toBe(200);
      expect(revived.json?.data?.reused).toBe(true);
      expect(revived.json?.data?.token).toBe(token);
      expect(
        (await anonymous.get(`/share/${token}`, { headers: { Accept: 'text/html' }, withCookies: false }))
          .status,
      ).toBe(200);

      // 分享页的访问计数被持久化（读取路径的副作用）
      const link = await db().shareLink.findUnique({ where: { taskId: task.id } });
      expect(link?.viewCount ?? 0).toBeGreaterThan(0);
    },
    150_000,
  );
});

/**
 * 用例 7：SSE 与断线重连。
 *
 * 要验证的是「流式协议在真实跨请求生命周期下成立」，这是单测完全覆盖不到的部分：
 *  - 进行中订阅：能收到 meta / token / usage / done，且 done 在 usage 之后；
 *  - 完成后订阅：直接回放已落库的完整内容（服务重启也不丢，因为内容在 DB）；
 *  - 中途断开再重连：带 `Last-Event-ID`（已收到字符数）重连，补发剩余内容，
 *    拼接结果必须与落库的 outputContent **逐字一致**（多发/漏发/重复都算失败）。
 *
 * 为什么必须断言「拼接后与 outputContent 一致」而不是只看「收到了内容」：
 * 断线续传最典型的 bug 是重连后从头重放，客户端再把增量追加到已有内容上，
 * 于是内容翻倍 —— 只看「有内容」是发现不了的。
 */
import { describe, expect, it } from 'vitest';
import { registerTestUser } from './helpers/auth';
import { createTask, waitForTaskSucceeded } from './helpers/tasks';
import {
  findSseEvent,
  lastDoneEvent,
  sseEventNames,
  sseTokens,
  subscribeSse,
} from './helpers/sse';

describe('SSE 订阅与重连', () => {
  it(
    '进行中订阅收到 meta/token/usage/done，done.status=succeeded',
    async () => {
      const user = await registerTestUser();
      const { data } = await createTask(user.client);

      // 立刻订阅：任务大概率还在 queued/running，走的正是「实时」路径
      const stream = await subscribeSse({
        client: user.client,
        pathname: `/api/tasks/${data.taskId}/stream`,
        timeoutMs: 40_000,
      });

      expect(stream.error).toBeNull();
      expect(stream.status).toBe(200);
      const names = sseEventNames(stream.events);
      expect(names[0], `事件序列：${names.join(' → ')}`).toBe('meta');
      expect(names).toContain('token');
      expect(names).toContain('usage');
      expect(names).toContain('done');
      expect(names).not.toContain('error');

      const meta = findSseEvent(stream.events, 'meta');
      expect(meta?.data?.taskId).toBe(data.taskId);
      expect(typeof meta?.data?.promptVersion).toBe('string');

      // usage 必须在 done 之前（协议约定：先结算再终止）
      expect(names.lastIndexOf('usage')).toBeLessThan(names.lastIndexOf('done'));
      expect(lastDoneEvent(stream.events)?.data?.status).toBe('succeeded');

      const tokens = sseTokens(stream.events);
      expect(tokens.length).toBeGreaterThan(0);

      // 流式内容与落库内容一致
      const detail = await waitForTaskSucceeded(user.client, data.taskId);
      expect(tokens).toBe(detail.outputContent);
    },
    120_000,
  );

  it(
    '任务完成后再订阅：回放完整内容且 done.status=succeeded',
    async () => {
      const user = await registerTestUser();
      const { data } = await createTask(user.client);
      const detail = await waitForTaskSucceeded(user.client, data.taskId);

      const replay = await subscribeSse({
        client: user.client,
        pathname: `/api/tasks/${data.taskId}/stream`,
        timeoutMs: 30_000,
      });

      expect(replay.error).toBeNull();
      expect(replay.status).toBe(200);
      const names = sseEventNames(replay.events);
      expect(names).toContain('token');
      expect(names).toContain('usage');
      expect(lastDoneEvent(replay.events)?.data?.status).toBe('succeeded');
      // 回放 = 落库内容，逐字一致
      expect(sseTokens(replay.events)).toBe(detail.outputContent);
    },
    120_000,
  );

  it(
    '中途 abort 后带 Last-Event-ID 重连，拼接内容与落库内容逐字一致',
    async () => {
      const user = await registerTestUser();
      const { data } = await createTask(user.client);

      // ---- 第一次订阅：收到第一个 token 就主动断开 ----
      let aborted = false;
      const first = await subscribeSse({
        client: user.client,
        pathname: `/api/tasks/${data.taskId}/stream`,
        timeoutMs: 40_000,
        onEvent: (event, controls) => {
          if (event.event === 'token' && !aborted) {
            aborted = true;
            controls.abort();
          }
        },
      });
      expect(first.error).toBeNull();
      expect(first.closedByClient).toBe(true);
      const received = sseTokens(first.events);
      expect(received.length, '断开前应至少收到一个 token').toBeGreaterThan(0);

      // ---- 第二次订阅：带上已收到的字符数，服务端只补发剩余部分 ----
      const second = await subscribeSse({
        client: user.client,
        pathname: `/api/tasks/${data.taskId}/stream`,
        headers: { 'Last-Event-ID': String(received.length) },
        timeoutMs: 60_000,
      });
      expect(second.error).toBeNull();
      expect(second.status).toBe(200);

      const detail = await waitForTaskSucceeded(user.client, data.taskId);
      const combined = received + sseTokens(second.events);
      expect(combined).toBe(detail.outputContent);

      // 重连的 done 也必须是终态
      expect(lastDoneEvent(second.events)?.data?.status).toBe('succeeded');
    },
    120_000,
  );
});

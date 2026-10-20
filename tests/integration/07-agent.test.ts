/**
 * 用例 8：Agent 工具边界（Mock 下）。
 *
 * MockProvider 的 capabilities.tools = false，所以 Agent 循环不会真的调用工具：
 * 第一次 plan 调用返回纯文本 → 直接 finalize。这个用例锁定的是
 * 「mock 模式下 Agent 链路能跑通且不产生证据幻觉」这条零成本基线：
 *  - 任务最终 succeeded，且落库了轨迹（AgentStep）；
 *  - structured 为 null（Mock 输出不是 JSON），此时证据校验必须是
 *    total=0 / rate=0，而**不是**凭空算出 100%；
 *  - 已完成任务的 SSE 回放必须带 step 事件（历史 bug：已完成任务收不到轨迹）。
 *
 * 另外对 seed 的演示 Agent 任务做了只读断言（见 02-seed-idempotency），
 * 那里验证的是「有证据时 4/4 可精确匹配」的另一半语义。
 */
import { describe, expect, it } from 'vitest';
import { checkEvidence } from '@/lib/agent/evidence';
import type { AgentStructuredOutput } from '@/lib/agent/types';
import { chunkText } from '@/lib/pipeline/chunk';
import { registerTestUser } from './helpers/auth';
import { db } from './helpers/db';
import { findSseEvent, sseEventNames, subscribeSse } from './helpers/sse';
import { SHORT_DOC, waitForTaskSucceeded } from './helpers/tasks';

describe('Agent（Mock 模式）', () => {
  it(
    'POST /api/agent → succeeded；Mock 无工具、structured=null、证据 rate=0',
    async () => {
      const user = await registerTestUser();
      const question = 'Lumenote 如何保证 AI 输出可追溯？';

      const res = await user.client.post('/api/agent', { content: SHORT_DOC, question });
      expect(res.status, res.text.slice(0, 500)).toBe(200);
      const taskId = String(res.json?.data?.taskId);
      expect(taskId.length).toBeGreaterThan(0);
      expect(res.json?.data?.replayed).toBe(false);

      const detail = await waitForTaskSucceeded(user.client, taskId);
      expect(detail.type).toBe('agent');
      expect(detail.outputContent?.length ?? 0).toBeGreaterThan(0);

      const outputMeta = (detail.outputMeta ?? {}) as {
        structured?: AgentStructuredOutput | null;
        stopReason?: string;
        stepCount?: number;
        agentSteps?: { seq: number; phase: string; note?: string }[];
      };

      // Mock 输出是 Markdown 散文而非 JSON → structured 必须为 null
      expect(outputMeta.structured ?? null).toBeNull();
      expect(outputMeta.stopReason).toBe('model_finalized');
      expect(outputMeta.stepCount).toBeGreaterThanOrEqual(1);

      // 轨迹落库：至少一条 finalize 步骤
      const steps = await db().agentStep.findMany({
        where: { taskId },
        orderBy: { seq: 'asc' },
      });
      expect(steps.length).toBeGreaterThanOrEqual(1);
      expect(steps.some((s) => s.phase === 'finalize')).toBe(true);
      expect(outputMeta.agentSteps?.length ?? 0).toBeGreaterThanOrEqual(1);

      // 证据语义：structured 为 null 时 total=0、rate=0（不能凭空算成 100%）
      const chunks = chunkText(detail.inputContent ?? '', { maxTokens: 1200, overlapTokens: 100 });
      expect(chunks.length).toBeGreaterThan(0);
      const check = checkEvidence(outputMeta.structured ?? null, chunks);
      expect(check.total).toBe(0);
      expect(check.verified).toBe(0);
      expect(check.missing).toEqual([]);
      expect(check.rate).toBe(0);

      // 计量：一次 Agent 任务只结算一条 UsageLog
      const usageLogs = await db().usageLog.findMany({ where: { taskId } });
      expect(usageLogs).toHaveLength(1);
      expect(usageLogs[0]!.provider).toBe('mock');
      expect(usageLogs[0]!.promptTokens).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    '已完成 Agent 任务的 SSE 回放带 step 事件（轨迹不能因「已完成」而丢失）',
    async () => {
      const user = await registerTestUser();
      const res = await user.client.post('/api/agent', {
        content: SHORT_DOC,
        question: '成本控制有哪些手段？',
      });
      expect(res.status).toBe(200);
      const taskId = String(res.json?.data?.taskId);
      await waitForTaskSucceeded(user.client, taskId);

      const replay = await subscribeSse({
        client: user.client,
        pathname: `/api/tasks/${taskId}/stream`,
        timeoutMs: 30_000,
      });
      expect(replay.error).toBeNull();
      const names = sseEventNames(replay.events);
      expect(names).toContain('step');
      expect(names).toContain('token');
      expect(names).toContain('done');

      const stepEvent = findSseEvent(replay.events, 'step');
      expect(stepEvent?.data?.seq).toBeGreaterThanOrEqual(1);
      expect(typeof stepEvent?.data?.phase).toBe('string');
    },
    120_000,
  );
});

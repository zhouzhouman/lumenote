import { prisma } from '@/lib/db';
import { estimateTokens } from '@/lib/llm/mock';
import { redactOutput } from '@/lib/llm/guardrail';
import type { SingleRunResult } from './map-reduce';

/**
 * 模块职责：**任务结果的持久化与终态流转**（成功 / 失败 / 取消）。
 *
 * ## 为什么单独成模块
 *
 * 「任务最后以什么状态结束」是用户能直接观察到的契约：成功要带输出、
 * 失败要带可读错误码、取消要落 canceled。这些写库动作分散在编排代码里时，
 * 很容易出现某条失败路径忘了写 completedAt、或忘记脱敏就入库。
 *
 * 集中之后，所有终态更新都要经过这里，脱敏与截断策略只有一份：
 *  - 输出脱敏：模型可能复述用户输入里的密钥，不能原样入库；
 *  - 错误信息截断：不存完整上游错误（可能含内部细节），只存 code + 简短文案。
 */

/** 写成功结果（含脱敏后的输出与元信息） */
export async function persistResult(args: {
  taskId: string;
  output: string;
  degraded: boolean;
  usage: SingleRunResult['usage'];
  ttftMs?: number;
  latencyMs: number;
  extraMeta: Record<string, unknown>;
}): Promise<void> {
  // 输出脱敏：万一模型复述了用户输入里的密钥，不应原样入库
  const safe = redactOutput(args.output);

  await prisma.task.update({
    where: { id: args.taskId },
    data: {
      status: 'succeeded',
      outputContent: safe.text,
      degraded: args.degraded,
      latencyMs: args.latencyMs,
      ttftMs: args.ttftMs ?? null,
      completedAt: new Date(),
      outputMeta: {
        ...args.extraMeta,
        redacted: safe.redacted,
        redactedPatterns: safe.hits,
        outputTokens: estimateTokens(safe.text),
      } as never,
    },
  });
}

/** 写失败终态 */
export async function failTask(taskId: string, code: string, message: string): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: {
      status: 'failed',
      errorCode: code,
      // 不存完整上游错误信息，可能含内部细节。只存 code + 简短文案
      errorMessage: message.slice(0, 300),
      completedAt: new Date(),
    },
  });
}

/** 写取消终态（用户主动中止，不是失败） */
export async function cancelTask(taskId: string): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: { status: 'canceled', completedAt: new Date() },
  });
}

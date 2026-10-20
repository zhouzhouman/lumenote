import { fail, handleError, ok } from '@/lib/api';
import { requireUserId, authzTask } from '@/lib/auth/authz';
import { diffLines, isSameSource, type DiffResult } from '@/lib/tasks/diff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 对比两个任务的输出差异。
 *
 * ## 为什么参数是两个 taskId 而不是「同源任务组 id」
 *
 * 直觉上应该先做「同源分组」再给组内对比，但那样会限制用户：
 * 真实需求里经常要对比**不同参数**（要点式 vs 段落式）、
 * 甚至不同能力（摘要 vs 润色对同一段原文）的结果。
 * 直接接受两个 taskId 最灵活，分组只是历史页的一个便利提示。
 *
 * ## 越权是这里最需要防的点
 *
 * 必须**两次都**走 authzTask —— 只校验其中一个是个典型疏漏：
 * 攻击者拿自己的 taskId 当 a、别人的当 b，就能读到别人的输出。
 * 两次独立校验后，任何一侧不属于当前用户都返回 404。
 */
export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const aId = url.searchParams.get('a');
    const bId = url.searchParams.get('b');

    if (!aId || !bId) {
      return fail('VALIDATION_ERROR', '需要提供两个任务 id（a 与 b）', 422);
    }
    if (aId === bId) {
      return fail('VALIDATION_ERROR', '两个任务 id 相同，无需对比', 422);
    }

    // ⚠️ 两次都要校验归属
    const [a, b] = await Promise.all([authzTask(userId, aId), authzTask(userId, bId)]);

    if (a.outputContent === null || b.outputContent === null) {
      return fail('NOT_READY', '其中一个任务还没有输出结果，无法对比', 422);
    }

    const diff: DiffResult = diffLines(a.outputContent, b.outputContent);

    const summarise = (t: typeof a) => ({
      id: t.id,
      title: t.title,
      type: t.type,
      status: t.status,
      degraded: t.degraded,
      createdAt: t.createdAt.toISOString(),
      charCount: t.outputContent?.length ?? 0,
      templateName: t.template.name,
      promptVersion: t.promptVersion.version,
      // 参数差异往往就是「为什么两次结果不同」的答案，所以带上
      params: (t.params ?? {}) as Record<string, unknown>,
    });

    /**
     * 把两侧的参数差异也算出来。
     *
     * 这是「可追溯」的直接体现：用户看到内容不同时，
     * 最想知道的下一件事就是「两次哪里不一样」——
     * 只给内容 diff 而不给参数 diff，等于让他自己去翻两条记录猜。
     */
    const aParams = (a.params ?? {}) as Record<string, unknown>;
    const bParams = (b.params ?? {}) as Record<string, unknown>;
    const paramKeys = [...new Set([...Object.keys(aParams), ...Object.keys(bParams)])].filter(
      // model 与 credentialId 是运行时快照，不是用户可调参数
      (k) => k !== 'glossary',
    );

    const paramDiff = paramKeys
      .map((key) => ({
        key,
        a: aParams[key] === undefined ? null : String(aParams[key]),
        b: bParams[key] === undefined ? null : String(bParams[key]),
      }))
      .filter((p) => p.a !== p.b);

    return ok({
      a: summarise(a),
      b: summarise(b),
      diff,
      paramDiff,
      /** 是否判定为「同源」（同一篇原文/同一个父任务）—— 前端据此提示对比的意义 */
      sameSource: isSameSource(
        { inputContent: a.inputContent, parentTaskId: a.parentTaskId },
        { inputContent: b.inputContent, parentTaskId: b.parentTaskId },
      ),
    });
  } catch (e) {
    return handleError(e);
  }
}

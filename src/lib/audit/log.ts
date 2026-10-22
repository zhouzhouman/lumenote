import { prisma } from '@/lib/db';
import { clientIp } from '@/lib/rate-limit/client-ip';

/**
 * 审计日志写入。
 *
 * ## 与 SecurityEvent 的分工
 *
 *   SecurityEvent：认证侧 —— 谁试图登录、失败几次、是否被锁
 *   AuditLog     ：业务侧 —— 谁跑了批次、导出了什么、改了凭证、建了分享链接
 *
 * ## 为什么写入失败不抛异常
 *
 * 与 `recordSecurityEvent` 保持一致：用户要的是「批次建成功」，不是
 * 「因为审计表写不进去所以业务失败」。所以这里吞掉异常，只打 error 日志。
 *
 * ⚠️ 这是**权衡，不是无懈可击**：真正合规级的要求是「审计写失败即拒绝业务」
 * （两阶段提交）。本项目当前选择可用性优先，并在 README 的已知限制里写明。
 * 如果哪天要过审计，改法是把 recordAudit 的返回结果纳入业务事务。
 *
 * ## 为什么要有 meta 的键名黑名单
 *
 * 审计表会被导出、被发给外部审计方。一旦有人图省事把 `apiKey` 塞进 meta，
 * 密钥就跟着导出文件一起流出了 —— 而这种错误在 code review 里极难发现。
 * 这里做一层兜底剔除，但**拦不住起错名的字段**，调用方仍需自觉。
 */

export type AuditAction =
  | 'batch.create'
  | 'batch.cancel'
  | 'batch.export'
  | 'credential.create'
  | 'credential.update'
  | 'credential.delete'
  | 'share.create'
  | 'share.revoke'
  /** 导出审计日志本身也要留痕：审计数据外流同样敏感 */
  | 'audit.export';

export type AuditTargetType = 'batch' | 'task' | 'credential' | 'share' | 'audit';
export type AuditOutcome = 'success' | 'denied' | 'failed';

/** 展示用的中文名。放这里而不是散在页面里，避免两处文案逐渐不一致 */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  'batch.create': '创建批次',
  'batch.cancel': '取消批次',
  'batch.export': '导出批次结果',
  'credential.create': '新增模型凭证',
  'credential.update': '修改模型凭证',
  'credential.delete': '删除模型凭证',
  'share.create': '创建分享链接',
  'share.revoke': '撤销分享链接',
  'audit.export': '导出审计日志',
};

export const AUDIT_OUTCOME_LABELS: Record<AuditOutcome, string> = {
  success: '成功',
  denied: '被拒绝',
  failed: '失败',
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action as AuditAction] ?? action;
}

/** 键名里出现这些词的字段一律不写进 meta（含大小写与分隔符变体） */
const SENSITIVE_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|verif(y|ication)[-_]?code)/i;

/** 单个字符串值的上限：审计要的是「发生了什么」，不是把正文抄一份 */
const MAX_STRING = 200;

/**
 * 递归剔除敏感字段并截断过长字符串。
 *
 * 纯函数，方便单测 —— 「审计会不会泄漏密钥」这件事不该靠人肉检查。
 */
export function sanitizeAuditMeta(
  meta: Record<string, unknown> | null | undefined,
  depth = 0,
): Record<string, unknown> | null {
  if (!meta || depth > 4) return null;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_KEY.test(key)) continue;

    if (value === null || value === undefined) {
      out[key] = null;
    } else if (typeof value === 'string') {
      out[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (Array.isArray(value)) {
      // 数组只保留标量项，避免把「对象数组」整包塞进审计
      out[key] = value
        .filter((v) => ['string', 'number', 'boolean'].includes(typeof v))
        .slice(0, 20);
    } else if (typeof value === 'object') {
      const nested = sanitizeAuditMeta(value as Record<string, unknown>, depth + 1);
      if (nested && Object.keys(nested).length > 0) out[key] = nested;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

export interface AuditContext {
  ip?: string | null;
  userAgent?: string | null;
}

/** 从请求里取 IP / UA，供调用方透传 */
export function auditContextFrom(req: Request): AuditContext {
  return {
    ip: clientIp(req.headers),
    userAgent: req.headers.get('user-agent'),
  };
}

export interface RecordAuditInput {
  /** 操作者 id。用户已被删除时可为 null */
  userId?: string | null;
  /** 操作者邮箱快照。**必填** —— 没有它就说不清「是谁做的」 */
  actorEmail: string;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId?: string | null;
  outcome?: AuditOutcome;
  meta?: Record<string, unknown>;
  context?: AuditContext;
}

/**
 * 写一条审计日志。**永不抛异常**（原因见文件头）。
 *
 * 调用点都是「动作已经成功落库之后」，所以这里失败不会造成业务半完成，
 * 只会造成审计缺一条 —— 这是当前明确的取舍。
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: input.userId ?? null,
        actorEmail: input.actorEmail.trim().toLowerCase().slice(0, 160),
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        outcome: input.outcome ?? 'success',
        ip: input.context?.ip?.slice(0, 64) ?? null,
        userAgent: input.context?.userAgent?.slice(0, 255) ?? null,
        meta: sanitizeAuditMeta(input.meta) as never,
      },
    });
  } catch (e) {
    // 用 error 级别而不是 warn：审计缺一条是「需要人来看」的事，不该被日志级别淹掉
    console.error(
      `[audit] 写入失败（不影响主流程）：action=${input.action} target=${input.targetType}:${input.targetId ?? '-'}`,
      e,
    );
  }
}

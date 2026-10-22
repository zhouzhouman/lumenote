import { prisma } from '@/lib/db';
import { handleError } from '@/lib/api';
import { requireActor } from '@/lib/auth/authz';
import { auditActionLabel, recordAudit, auditContextFrom, AUDIT_OUTCOME_LABELS } from '@/lib/audit/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 审计日志导出（给外部审计方 / 归档用）。
 *
 * 两条刻意的规则：
 *  1. **导出动作本身要留痕**（`audit.export`）。审计数据外流同样敏感 ——
 *     只记「谁看了业务操作」却不记「谁把这些记录拷走了」，是自相矛盾的。
 *  2. **上限 5000 条**。不设上限的导出接口在审计场景里是个隐患：
 *     一次请求把全表拉走，既可能拖垮数据库，也让「导出」这个动作的
 *     影响面不可控。要全量归档请走数据库备份，不要走 HTTP 接口。
 */
const EXPORT_LIMIT = 5000;

export async function GET(req: Request) {
  try {
    const actor = await requireActor();
    const url = new URL(req.url);
    const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
    const isAuditor = actor.role === 'auditor';

    const rows = await prisma.auditLog.findMany({
      // 与列表页同一条可见性规则，不允许导出越权
      where: isAuditor ? {} : { userId: actor.userId },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_LIMIT,
      select: {
        actorEmail: true,
        action: true,
        targetType: true,
        targetId: true,
        outcome: true,
        ip: true,
        userAgent: true,
        meta: true,
        createdAt: true,
      },
    });

    await recordAudit({
      userId: actor.userId,
      actorEmail: actor.email,
      action: 'audit.export',
      targetType: 'audit',
      meta: { format, count: rows.length, scope: isAuditor ? 'all' : 'self' },
      context: auditContextFrom(req),
    });

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `audit-${stamp}-${isAuditor ? 'all' : 'self'}`;

    if (format === 'json') {
      return new Response(JSON.stringify(rows, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}.json"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return new Response(buildCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        // 中文名用 filename*，否则部分浏览器存成乱码
        'Content-Disposition':
          `attachment; filename="${filename}.csv"; filename*=UTF-8''${encodeURIComponent(filename)}.csv`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return handleError(e);
  }
}

type ExportRow = {
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: string;
  ip: string | null;
  userAgent: string | null;
  meta: unknown;
  createdAt: Date;
};

function buildCsv(rows: ExportRow[]): string {
  const header = ['时间', '操作者', '动作', '动作说明', '对象类型', '对象 id', '结果', 'IP', 'User-Agent', '细节'];

  const body = rows.map((r) => [
    fmtTime(r.createdAt),
    r.actorEmail,
    r.action,
    auditActionLabel(r.action),
    r.targetType,
    r.targetId ?? '',
    AUDIT_OUTCOME_LABELS[r.outcome as keyof typeof AUDIT_OUTCOME_LABELS] ?? r.outcome,
    r.ip ?? '',
    r.userAgent ?? '',
    // meta 压成一行 JSON：Excel 里能看、脚本也能解析
    r.meta ? JSON.stringify(r.meta) : '',
  ]);

  // BOM：没有它 Excel 打开中文会乱码
  return '\uFEFF' + [header, ...body].map((c) => c.map(cell).join(',')).join('\r\n');
}

function cell(value: string): string {
  return `"${value.replace(/\r?\n/g, ' ').replace(/"/g, '""')}"`;
}

function fmtTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

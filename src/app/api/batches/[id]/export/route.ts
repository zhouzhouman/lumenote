import { prisma } from '@/lib/db';
import { handleError, fail } from '@/lib/api';
import { requireActor } from '@/lib/auth/authz';
import { recordAudit, auditContextFrom } from '@/lib/audit/log';
import { usdToCny } from '@/lib/llm/pricing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 批次结果导出。
 *
 * 这是「团队内部流水线」里**最容易被忽略但最实用**的一环：
 * 用户不会在网页里一条条读完 20 份材料，他要的是「下载下来、贴进周报/邮件」。
 *
 * 导出内容刻意带上**留痕字段**（模型、Prompt 版本、token、成本、是否降级），
 * 否则导出的文件就和「随便找个人用 ChatGPT 跑一遍」没有区别了 ——
 * 而这些字段正是内部流程审计时唯一能自证的东西。
 *
 * 两种格式：
 *  - md：给人读，也方便贴进 Confluence/飞书
 *  - csv：给 Excel/数据透视，方便统计成本与失败分布
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor();
    const userId = actor.userId;
    const { id } = await params;
    const format = new URL(req.url).searchParams.get('format') === 'csv' ? 'csv' : 'md';

    const batch = await prisma.batch.findFirst({
      where: { id, userId },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        total: true,
        succeeded: true,
        failed: true,
        skipped: true,
        budgetCny: true,
        costUsd: true,
        createdAt: true,
        finishedAt: true,
        params: true,
      },
    });
    if (!batch) return fail('NOT_FOUND', '批次不存在', 404);

    const tasks = await prisma.task.findMany({
      where: { batchId: batch.id, userId },
      orderBy: { batchOrder: 'asc' },
      take: 200,
      select: {
        title: true,
        status: true,
        batchOrder: true,
        degraded: true,
        errorCode: true,
        errorMessage: true,
        latencyMs: true,
        outputContent: true,
        params: true,
        promptVersionId: true,
        usageLog: {
          select: { model: true, promptTokens: true, completionTokens: true, estimatedCost: true },
        },
      },
    });

    const filenameBase = `batch-${sanitize(batch.name)}-${batch.id.slice(0, 8)}`;
    const body =
      format === 'csv'
        ? buildCsv(tasks)
        : buildMarkdown(batch, tasks, usdToCny(batch.costUsd));

    /*
     * 导出的审计要**在返回文件之前**写：这个动作本身就等于「数据出站」，
     * 事后补记会漏掉「导出失败了但文件已经生成」的边界。
     */
    await recordAudit({
      userId: actor.userId,
      actorEmail: actor.email,
      action: 'batch.export',
      targetType: 'batch',
      targetId: batch.id,
      meta: { format, itemCount: tasks.length },
      context: auditContextFrom(req),
    });

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type':
          format === 'csv'
            ? 'text/csv; charset=utf-8'
            : 'text/markdown; charset=utf-8',
        // 中文文件名用 RFC 5987 的 filename*，否则部分浏览器会存成乱码
        'Content-Disposition':
          `attachment; filename="${filenameBase}.${format}"; ` +
          `filename*=UTF-8''${encodeURIComponent(filenameBase)}.${format}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return handleError(e);
  }
}

type ExportTask = {
  title: string;
  status: string;
  batchOrder: number | null;
  degraded: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  outputContent: string | null;
  params: unknown;
  promptVersionId: string;
  usageLog: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    estimatedCost: number;
  } | null;
};

function buildMarkdown(
  batch: {
    name: string;
    type: string;
    status: string;
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    budgetCny: number | null;
    createdAt: Date;
    finishedAt: Date | null;
    params: unknown;
  },
  tasks: ExportTask[],
  costCny: number,
): string {
  const lines: string[] = [];
  lines.push(`# 批次：${batch.name}`);
  lines.push('');
  lines.push(`- 类型：${batch.type}`);
  lines.push(`- 状态：${statusLabel(batch.status)}`);
  lines.push(`- 创建时间：${fmtDate(batch.createdAt)}`);
  if (batch.finishedAt) lines.push(`- 完成时间：${fmtDate(batch.finishedAt)}`);
  lines.push(
    `- 材料数：${batch.total}（成功 ${batch.succeeded} / 失败 ${batch.failed} / 未执行 ${batch.skipped}）`,
  );
  lines.push(`- 已发生成本：¥${costCny.toFixed(4)}`);
  if (batch.budgetCny != null) lines.push(`- 预算上限：¥${batch.budgetCny.toFixed(2)}`);
  const model = readModel(batch.params);
  if (model) lines.push(`- 模型：${model}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (tasks.length === 0) {
    lines.push('（本批次没有条目）');
  }

  for (const t of tasks) {
    const index = (t.batchOrder ?? 0) + 1;
    const flags = [statusLabel(t.status)];
    if (t.degraded) flags.push('降级');
    lines.push(`## ${index}. ${t.title}　（${flags.join(' · ')}）`);
    lines.push('');

    const meta: string[] = [];
    if (t.usageLog) {
      meta.push(`模型 ${t.usageLog.model}`);
      meta.push(`输入 ${t.usageLog.promptTokens} / 输出 ${t.usageLog.completionTokens} token`);
      meta.push(`成本 ¥${usdToCny(t.usageLog.estimatedCost).toFixed(4)}`);
    }
    if (t.latencyMs != null) meta.push(`耗时 ${(t.latencyMs / 1000).toFixed(1)}s`);
    // Prompt 版本是「这条结果为什么可复现」的凭据，导出时不能丢
    meta.push(`Prompt 版本 ${t.promptVersionId.slice(0, 8)}`);
    lines.push(`> ${meta.join('　·　')}`);
    lines.push('');

    if (t.errorMessage) {
      lines.push(`⚠️ ${t.errorCode ? `[${t.errorCode}] ` : ''}${t.errorMessage}`);
      lines.push('');
    }
    lines.push(t.outputContent?.trim() || '（无输出）');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function buildCsv(tasks: ExportTask[]): string {
  const header = [
    '序号',
    '标题',
    '状态',
    '是否降级',
    '模型',
    '输入token',
    '输出token',
    '成本(元)',
    '耗时(ms)',
    '错误码',
    '错误信息',
    '输出',
  ];
  const rows = tasks.map((t) => [
    String((t.batchOrder ?? 0) + 1),
    t.title,
    statusLabel(t.status),
    t.degraded ? '是' : '否',
    t.usageLog?.model ?? '',
    String(t.usageLog?.promptTokens ?? 0),
    String(t.usageLog?.completionTokens ?? 0),
    t.usageLog ? usdToCny(t.usageLog.estimatedCost).toFixed(4) : '0',
    t.latencyMs != null ? String(t.latencyMs) : '',
    t.errorCode ?? '',
    t.errorMessage ?? '',
    t.outputContent ?? '',
  ]);

  // BOM：没有它 Excel 打开中文 CSV 会乱码（这是最常见的「导出坏了」投诉）
  return '\uFEFF' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** CSV 单元格转义：引号翻倍 + 整体加引号，避免逗号/换行破坏列结构 */
function csvCell(value: string): string {
  const v = value.replace(/\r?\n/g, ' ');
  return `"${v.replace(/"/g, '""')}"`;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'succeeded':
      return '成功';
    case 'failed':
      return '失败';
    case 'canceled':
      return '未执行';
    case 'running':
      return '进行中';
    case 'queued':
      return '排队中';
    case 'partial':
      return '部分成功';
    default:
      return status;
  }
}

function readModel(params: unknown): string | null {
  if (params && typeof params === 'object' && 'model' in params) {
    const m = (params as Record<string, unknown>).model;
    if (typeof m === 'string' && m) return m;
  }
  return null;
}

function fmtDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 文件名里去掉 Windows 不允许的字符，否则下载会失败 */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
}

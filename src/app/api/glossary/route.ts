import { prisma } from '@/lib/db';
import { fail, handleError, ok } from '@/lib/api';
import { requireUserId } from '@/lib/auth/authz';
import { validateGlossaryInput } from '@/lib/tasks/glossary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 术语表 CRUD。
 *
 * ## 为什么需要它（产品理由）
 *
 * 通用翻译模型对同一术语在不同段落可能给出不同译法
 * （"token" 一会儿「令牌」一会儿「标记」）。对技术文档这是硬伤 ——
 * 读者会以为是两个不同的东西。术语表把这个约定显式写进 prompt，强制统一。
 *
 * ## 安全约束
 *
 * 所有查询都带 `userId`。这里的越权后果不是「看到别人的数据」，
 * 而是「改掉别人的术语译法」—— 更隐蔽，因为受害者很难立刻发现。
 */

/**
 * 出参字段白名单。
 *
 * ⚠️ 注意 GlossaryTerm **没有 updatedAt 字段**（见 schema：只有 createdAt）。
 * 一开始我按其他模型的习惯把它加进来了，结果是 Prisma 抛
 * `Unknown field 'updatedAt' for select statement`，整个接口 500 ——
 * 而且四条路由全挂（都用同一个 SELECT）。这类错误的教训是：
 * **新增 select 白名单后必须真的调一次接口**，类型检查抓不到它
 * （Prisma 的 select 类型在拼写错误时才会报错，而我这里是通过常量间接引用的）。
 */
const SELECT = {
  id: true,
  source: true,
  target: true,
  domain: true,
  caseSensitive: true,
  note: true,
  createdAt: true,
} as const;

/** GET：列出当前用户的术语 */
export async function GET() {
  try {
    const userId = await requireUserId();

    const items = await prisma.glossaryTerm.findMany({
      where: { userId },
      orderBy: [{ domain: 'asc' }, { source: 'asc' }],
      select: SELECT,
    });

    // 领域列表供前端做筛选/下拉：从已有数据里归纳，不硬编码一套「领域枚举」——
    // 用户可能做医学、法律、游戏本地化，硬编码的列表一定会不够用
    const domains = [...new Set(items.map((i) => i.domain).filter((d): d is string => Boolean(d)))].sort();

    return ok({ items, domains });
  } catch (e) {
    return handleError(e);
  }
}

/** POST：新增术语 */
export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const check = validateGlossaryInput(await req.json());
    if (!check.ok) {
      return fail('VALIDATION_ERROR', check.reason ?? '参数不正确', 422);
    }
    const input = check.value!;

    /**
     * 唯一约束是 `@@unique([userId, source, domain])`。
     * 重复时返回明确提示而不是 500 —— 这是最常见的用户操作
     * （「我以为没加过」），应当可预期地处理。
     */
    const existing = await prisma.glossaryTerm.findFirst({
      where: { userId, source: input.source, domain: input.domain },
      select: { id: true },
    });
    if (existing) {
      return fail('DUPLICATE', `术语「${input.source}」已存在，可直接编辑它`, 409, {
        source: '该术语已存在',
      });
    }

    const created = await prisma.glossaryTerm.create({
      data: {
        userId,
        source: input.source,
        target: input.target,
        domain: input.domain,
        caseSensitive: input.caseSensitive ?? false,
        note: input.note,
      },
      select: SELECT,
    });

    return ok(created, { status: 201 });
  } catch (e) {
    return handleError(e);
  }
}

/** PATCH：更新术语 */
export async function PATCH(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) return fail('VALIDATION_ERROR', '缺少术语 id', 422);

    // 防越权：先确认归属（updateMany 带 userId 亦可，这里需要「不存在」与
    // 「非本人」都返回同样的 404）
    const current = await prisma.glossaryTerm.findFirst({ where: { id, userId } });
    if (!current) return fail('NOT_FOUND', '术语不存在', 404);

    const check = validateGlossaryInput(await req.json());
    if (!check.ok) return fail('VALIDATION_ERROR', check.reason ?? '参数不正确', 422);
    const input = check.value!;

    const updated = await prisma.glossaryTerm.update({
      where: { id },
      data: {
        source: input.source,
        target: input.target,
        domain: input.domain,
        caseSensitive: input.caseSensitive ?? false,
        note: input.note,
      },
      select: SELECT,
    });

    return ok(updated);
  } catch (e) {
    return handleError(e);
  }
}

/** DELETE：删除术语 */
export async function DELETE(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) return fail('VALIDATION_ERROR', '缺少术语 id', 422);

    // deleteMany 天然带条件且找不到时不抛错：越权返回 404 而不是 500
    const result = await prisma.glossaryTerm.deleteMany({ where: { id, userId } });
    if (result.count === 0) return fail('NOT_FOUND', '术语不存在', 404);

    return ok({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}

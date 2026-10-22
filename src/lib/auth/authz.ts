import { prisma } from '@/lib/db';
import { cookies } from 'next/headers';
import { LLMError } from '@/lib/llm/types';
import { ACCESS_COOKIE, verifyAccessToken } from './jwt';

/**
 * 越权防护 —— 本项目最关键的安全模块。
 *
 * 要防的漏洞叫 **IDOR（不安全的直接对象引用）**：
 * 用户 A 拿到用户 B 的 taskId，把 URL 里的 id 换成 B 的，
 * 就能读到 B 的摘要。这类漏洞的成因几乎总是同一句话：
 * 「查的时候忘了带 userId」。
 *
 * 防御策略：**让忘记带 userId 这件事变得困难，而不是靠人记住。**
 *
 * 1. 本文件提供统一的 authz()，所有按 id 取用户资源的地方必须走它
 * 2. 代码审查规则：禁止出现裸的 `prisma.task.findUnique({ where: { id } })`
 *    —— 这是唯一能真正拦住疏忽的手段，靠自觉一定会漏
 * 3. 查不到或不属于当前用户时，返回同一个错误（404 而非 403）：
 *    区分「存在但无权」和「不存在」会泄漏资源是否存在，是个信息泄露
 */

export class AuthzError extends LLMError {
  constructor(message = '资源不存在或无权访问') {
    // 用 404 语义而非 403，避免泄漏资源是否存在
    super(message, 'NOT_FOUND', false, 404);
  }
}

/** 从 cookie 中解析当前用户 ID。无有效 token 返回 null */
export async function currentUserId(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  if (!token) return null;
  const payload = await verifyAccessToken(token);
  return payload?.userId ?? null;
}

/** 要求登录，否则抛错。用于所有需要身份的路由 */
export async function requireUserId(): Promise<string> {
  const userId = await currentUserId();
  if (!userId) {
    throw new LLMError('请先登录', 'UNAUTHENTICATED', false, 401);
  }
  return userId;
}

/** 需要「谁」而不只是「谁 id」时用（审计要写操作者邮箱快照） */
export interface AuthActor {
  userId: string;
  email: string;
  /** member | auditor —— 只用于「能否查看全员审计日志」这一个判断 */
  role: string;
}

/**
 * 取当前操作者的 id + 邮箱 + 角色。
 *
 * 为什么不直接在审计里只存 userId：用户被删除后 `AuditLog.userId` 会被置空
 * （外键 SET NULL），届时「这条日志是谁产生的」就只能靠邮箱快照。
 * 所以写审计时**必须**把邮箱一起落下来。
 */
export async function requireActor(): Promise<AuthActor> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true },
  });
  if (!user) {
    // 账号已被删但 cookie 还没过期：当作未登录处理
    throw new LLMError('账号不存在，请重新登录', 'UNAUTHENTICATED', false, 401);
  }
  return { userId, email: user.email, role: user.role };
}

/**
 * 按 id 取任务，并校验归属。
 *
 * ⚠️ 这是全项目取 Task 的**唯一合法入口**。
 * 任何绕过此函数直接按 id 查询的代码都应被视为安全缺陷。
 *
 * 用 findFirst（带 userId 条件）而非 findUnique + 事后比对：
 * 前者在 SQL 层面就过滤掉了不属于你的行，
 * 避免了「先查到再判断」的竞态与疏漏空间。
 */
export async function authzTask(userId: string, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, userId, deletedAt: null },
    include: {
      template: true,
      promptVersion: true,
    },
  });

  if (!task) throw new AuthzError();
  return task;
}

/** 同理：分享链接必须属于当前用户 */
export async function authzShareLink(userId: string, taskId: string) {
  const link = await prisma.shareLink.findFirst({
    where: { taskId, userId },
  });
  if (!link) throw new AuthzError();
  return link;
}

/** 同理：Prompt 模板。系统内置模板（userId=null）对所有人可读，但不可改 */
export async function authzTemplate(userId: string, templateId: string) {
  const template = await prisma.promptTemplate.findFirst({
    where: {
      id: templateId,
      OR: [{ userId }, { userId: null }], // 自建的 + 系统内置
    },
    include: { versions: { orderBy: { version: 'desc' } } },
  });

  if (!template) throw new AuthzError();

  // 系统内置模板只读：修改会影响到所有用户，且会破坏历史 Task 的溯源
  if (template.userId === null) {
    throw new LLMError('系统内置模板不可修改，可复制后自行编辑', 'FORBIDDEN', false, 403);
  }

  return template;
}

/** 同理：术语表 */
export async function authzGlossaryTerm(userId: string, termId: string) {
  const term = await prisma.glossaryTerm.findFirst({
    where: { id: termId, userId },
  });
  if (!term) throw new AuthzError();
  return term;
}

/**
 * 公开分享链接的读取 —— 唯一不走用户校验的路径。
 *
 * 即使是可分享资源也必须校验：
 *  - revokedAt 非空 → 已撤销
 *  - expiresAt 早于现在 → 已过期
 *  - 所属任务已被软删 → 不再可访问
 * 任何一条不满足都返回 404，且不泄漏原因。
 */
export async function resolveShareToken(token: string) {
  const link = await prisma.shareLink.findUnique({
    where: { token },
    include: {
      task: {
        include: {
          template: true,
          promptVersion: { select: { version: true, notes: true } },
        },
      },
    },
  });

  if (!link || link.revokedAt) throw new AuthzError('分享链接不存在或已撤销');
  if (link.expiresAt && link.expiresAt < new Date()) throw new AuthzError('分享链接已过期');
  if (link.task.deletedAt) throw new AuthzError('分享内容已被删除');

  // 计数失败不应阻断访问
  void prisma.shareLink
    .update({
      where: { id: link.id },
      data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
    })
    .catch(() => undefined);

  return link;
}
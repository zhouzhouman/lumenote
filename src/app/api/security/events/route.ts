import { ok, handleError } from '@/lib/api';
import { requireUserId } from '@/lib/auth/authz';
import { listSecurityEvents, failureCount } from '@/lib/auth/security';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 「登录活动 / 安全事件」查询。
 *
 * ## 为什么要给用户看这个
 *
 * 安全事件审计通常只给运维看，但对个人工具来说，
 * **用户自己是唯一能发现「账号被盗」的人** —— 他看到一条来自陌生城市、
 * 陌生设备的登录记录，才知道要改密码。运维看不到「这不该是我」。
 *
 * ## 事件类型的翻译放在服务端
 *
 * 前端直接渲染英文枚举值（login_success）对普通用户没有意义；
 * 翻译表放服务端可以保证：新增事件类型时前端不用改，
 * 而且缺翻译时能明显看出来（会回落到原始值）。
 */

const EVENT_LABELS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  login_success: { label: '登录成功', tone: 'ok' },
  login_failed: { label: '登录失败', tone: 'warn' },
  login_locked: { label: '账号被临时锁定', tone: 'bad' },
  register: { label: '注册账号', tone: 'ok' },
  register_blocked: { label: '注册被阻止', tone: 'warn' },
  verification_sent: { label: '发送验证码', tone: 'neutral' },
  verification_failed: { label: '验证码校验失败', tone: 'warn' },
  logout: { label: '退出登录', tone: 'neutral' },
};

/** 从 User-Agent 粗略识别设备，只为了让人一眼看懂，不追求准确 */
function describeDevice(ua: string | null): string {
  if (!ua) return '未知设备';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Safari\//.test(ua)
        ? 'Safari'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : '未知浏览器';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '未知系统';
  return `${browser} · ${os}`;
}

/** GET /api/security/events —— 当前用户的安全事件与活跃会话 */
export async function GET() {
  try {
    const userId = await requireUserId();

    const [events, sessions, user, failures] = await Promise.all([
      listSecurityEvents(userId, 50),
      // 活跃会话 = 还能用来换 access token 的登录态
      prisma.session.findMany({
        where: { userId, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, userAgent: true, ip: true, createdAt: true, expiresAt: true },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { lastLoginAt: true, emailVerified: true, createdAt: true },
      }),
      failureCount((await currentEmail(userId)) ?? ''),
    ]);

    return ok({
      account: {
        emailVerified: user?.emailVerified ?? false,
        /*
         * 把「本站是否要求验证」一起告诉前端。
         * 否则关闭验证的部署里，安全页会显示「邮箱未验证」，
         * 用户会以为哪里出错了、到处找验证入口。
         */
        emailVerificationRequired: env().REQUIRE_EMAIL_VERIFICATION,
        createdAt: user?.createdAt.toISOString() ?? null,
        lastLoginAt: user?.lastLoginAt?.toISOString() ?? null,
        /** 当前锁定窗口内的失败次数，用于提示「你的账号正处于风险中」 */
        recentFailures: failures,
      },
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        label: EVENT_LABELS[e.type]?.label ?? e.type,
        tone: EVENT_LABELS[e.type]?.tone ?? 'neutral',
        ip: e.ip,
        device: describeDevice(e.userAgent),
        createdAt: e.createdAt.toISOString(),
      })),
      sessions: sessions.map((s) => ({
        id: s.id,
        device: describeDevice(s.userAgent),
        ip: s.ip,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
      })),
    });
  } catch (e) {
    return handleError(e);
  }
}

/** 取用户邮箱（安全事件列表里不需要，但失败计数要按 identifier 统计） */
async function currentEmail(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return u?.email ?? null;
}

/**
 * DELETE /api/security/events?sessionId=... —— 踢掉指定会话
 *
 * 「退出所有其他设备」是账号被盗后最有效的自救动作：
 * 改密码只能阻止未来的登录，已登录的会话必须显式销毁。
 */
export async function DELETE(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) return handleError(new Error('缺少 sessionId'));

    // 带 userId 的 deleteMany：越权时 count 为 0，不泄漏会话是否存在
    const result = await prisma.session.deleteMany({ where: { id: sessionId, userId } });

    return ok({ ok: result.count > 0, deleted: result.count });
  } catch (e) {
    return handleError(e);
  }
}

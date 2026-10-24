import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { LLMError } from '@/lib/llm/types';
import { AuthzError } from '@/lib/auth/authz';

/**
 * 统一 API 响应与错误处理。
 *
 * 集中处理的意义是：**错误信息对客户端保持一致的形状**。
 * 散在各路由里 return 会逐渐变成有的返回 { message }、有的 { error }、
 * 有的直接把上游异常透传 —— 那既不安全（可能泄漏内部细节）也不好用。
 *
 * 安全原则：**对外错误信息必须经过筛选**。
 * 上游报错常包含 URL、密钥片段、内部路径，直接透传等于给攻击者送情报。
 * 所以未知错误一律返回通用文案，具体原因只进服务端日志。
 */

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ data }, init);
}

/**
 * 追加一个 Set-Cookie 头。
 *
 * ⚠️ 不能写 `'Set-Cookie': [a, b]` —— HeadersInit 的类型定义不接受数组，
 * 而更重要的是：多个 Set-Cookie 必须是**多个独立的头**，
 * 合并成一个用逗号分隔会被浏览器错误解析（cookie 值本身可能含逗号）。
 * 正确做法是用 Headers.append() 逐个追加。
 */
export function appendSetCookie(res: Response, cookie: string): void {
  res.headers.append('Set-Cookie', cookie);
}

/** 一次追加多个 cookie（登出时清两个） */
export function appendSetCookies(res: Response, cookies: string[]): void {
  for (const c of cookies) res.headers.append('Set-Cookie', c);
}

/** 构造带多个 Set-Cookie 的 JSON 响应 */
export function okWithCookies<T>(data: T, cookies: string[]): NextResponse {
  const res = NextResponse.json({ data });
  appendSetCookies(res, cookies);
  return res;
}

export function fail(
  code: string,
  message: string,
  status: number,
  fields?: Record<string, string>,
): NextResponse {
  return NextResponse.json({ error: { code, message, ...(fields ? { fields } : {}) } }, { status });
}

/**
 * 把异常转成合适的 HTTP 响应。
 *
 * 状态码映射的考量：
 *  - 401 未登录 → 客户端应跳登录页
 *  - 404 资源不存在/无权 → 不区分，避免泄漏资源是否存在（见 authz.ts）
 *  - 429 限流 → 带上 Retry-After，让客户端知道何时可重试
 *  - 422 内容被过滤 → 不是用户能通过重试解决的，不该返回 5xx
 *  - 503 上游故障 → 可重试，配合 SSE 的 retryable 字段
 */
/**
 * 允许把原始消息透给客户端的 5xx 错误码。
 *
 * 判定标准：消息描述的是**部署/配置状态**，且不含用户数据、密钥、内部路径。
 * 不要把「数据库连接失败」「某条 SQL 报错」这类放进来 —— 那才是真正的信息泄露。
 */
const EXPOSABLE_SERVER_CODES = new Set([
  'TEMPLATE_MISSING',
  'INSUFFICIENT_BALANCE',
  'UNAUTHORIZED',
  'MAIL_NOT_CONFIGURED',
]);

export function handleError(e: unknown): NextResponse {
  if (e instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of e.issues) {
      fields[issue.path.join('.')] = issue.message;
    }
    return fail('VALIDATION_ERROR', '请求参数有误', 422, fields);
  }

  if (e instanceof AuthzError) {
    return fail('NOT_FOUND', e.message, 404);
  }

  if (e instanceof LLMError) {
    const status = e.statusCode ?? 500;

    /*
     * 服务端错误默认不暴露细节，但**配置类错误必须透出**：
     *
     * `TEMPLATE_MISSING` 这类错误码说的不是「系统内部炸了」，而是
     * 「部署少了基础数据」。把它掩成「服务暂时不可用」，自托管的运维
     * 只能去翻容器日志才能知道要跑 seed —— 这是纯粹的信息损耗，
     * 而且泄漏风险为零（消息里只有模板名）。
     */
    const exposable = EXPOSABLE_SERVER_CODES.has(e.code);
    const safeMessage = status >= 500 && !exposable ? '服务暂时不可用，请稍后重试' : e.message;

    if (status === 429) {
      return NextResponse.json(
        { error: { code: e.code, message: safeMessage } },
        { status: 429, headers: { 'Retry-After': '30' } },
      );
    }

    return fail(e.code, safeMessage, status);
  }

  // 未知错误：记录详情，对外只给通用信息
  console.error('[api] 未处理异常：', e);
  return fail('INTERNAL_ERROR', '服务内部错误', 500);
}

/** 分页参数校验（cursor 分页） */
export function parseLimit(value: string | null, defaultValue = 20, max = 100): number {
  const n = Number(value ?? defaultValue);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.min(Math.floor(n), max);
}
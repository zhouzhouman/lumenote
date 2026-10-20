import type { ApiError } from '@/types/api';

/**
 * 客户端 API 封装。
 *
 * 职责：
 *  1. 解包 `{ data }` / `{ error }` 统一信封，前端拿到的永远是裸数据或抛异常
 *  2. 401 时自动尝试 refresh 并重放原请求 —— 这让业务代码完全不用关心 token 过期
 *  3. 统一错误类型，让 UI 能按 code 做差异化处理
 */

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** 配额/限流等「稍后重试」类错误，UI 应展示为提示而非报错 */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

async function parse<T>(res: Response): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiRequestError('服务返回了无法解析的响应', 'PARSE_ERROR', res.status);
  }

  if (!res.ok) {
    const err = body as ApiError;
    const fields = err?.error?.fields;

    /**
     * 把字段级错误合并进 message。
     *
     * 否则 Zod 的字段错误会被 message 这个笼统的「请求参数有误」盖住：
     * 服务端明明已经算出了「链接需以 http:// 开头」这种可直接照做的提示，
     * 却因为前端只显示 message 而丢掉，用户只能猜哪里填错了。
     *
     * 合并而不是改显示逻辑：只影响错误文案，UI 一处都不用动，
     * 而这些文案本来就是给用户看的。fields 仍然保留，需要精细展示的地方照旧可用。
     */
    const fieldHints = fields ? Object.values(fields).filter(Boolean) : [];
    const baseMessage = err?.error?.message ?? '请求失败';
    const message =
      fieldHints.length > 0 ? `${baseMessage}：${[...new Set(fieldHints)].join('；')}` : baseMessage;

    throw new ApiRequestError(message, err?.error?.code ?? 'UNKNOWN', res.status, fields);
  }

  return (body as { data: T }).data;
}

/** 并发刷新时的单例锁 —— 避免多个 401 同时触发多次 refresh */
let refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = fetch('/api/auth/refresh', { method: 'POST' })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        // 下次需要时重新发起
        setTimeout(() => {
          refreshPromise = null;
        }, 1000);
      });
  }
  return refreshPromise;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** 内部使用：标记这是重试，避免无限递归 */
  _retried?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, _retried, headers, ...rest } = options;

  const res = await fetch(path, {
    ...rest,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // 401：尝试静默刷新一次，成功则重放原请求
  if (res.status === 401 && !_retried && !path.startsWith('/api/auth/')) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return api<T>(path, { ...options, _retried: true });
    }
  }

  return parse<T>(res);
}

/** GET */
export const apiGet = <T>(path: string, options?: RequestOptions) =>
  api<T>(path, { ...options, method: 'GET' });

/** POST */
export const apiPost = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  api<T>(path, { ...options, method: 'POST', body });

/** PATCH */
export const apiPatch = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  api<T>(path, { ...options, method: 'PATCH', body });

/** DELETE */
export const apiDelete = <T>(path: string, options?: RequestOptions) =>
  api<T>(path, { ...options, method: 'DELETE' });

/** 构造带查询参数的路径，自动编码 */
export function withQuery(path: string, params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}
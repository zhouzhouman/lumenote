/**
 * 带 cookie jar 的 HTTP 客户端（真实 HTTP，打真实 Next dev server）。
 *
 * 两个关键设计：
 *  1. **cookie jar**：注册/登录会下发 httpOnly 的 access + refresh cookie，
 *     后续请求必须带上。Node 的 fetch 不会自动保存，所以自己维护。
 *  2. **每个客户端固定一个 X-Forwarded-For**：限流按 IP 分桶
 *     （TRUST_PROXY_HOPS=1 时从 XFF 右侧取）。如果所有测试共用一个 IP，
 *     注册接口 5 次/5 分钟的限制会立刻互相干扰，表现为随机的 429。
 *     给每个测试用户一个独立的 10.x.x.x，问题就消失了。
 */
import { baseUrl as resolveBaseUrl } from './env';

export interface ApiRequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 默认 true；设为 false 时不带 cookie（验证匿名访问） */
  withCookies?: boolean;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  text: string;
  json: any;
  elapsedMs: number;
  url: string;
}

/** 断言失败时打印响应片段，避免只看到「期望 200 得到 404」而无从定位 */
export function summarizeResponse(r: ApiResponse, max = 500): string {
  const text = r.text.length > max ? `${r.text.slice(0, max)}…` : r.text;
  return `HTTP ${r.status} ${r.url}\n${text}`;
}

export class ApiClient {
  readonly baseUrl: string;
  readonly xff: string;
  /** name -> "name=value"（值已经是 Set-Cookie 里的原样编码） */
  private readonly cookies = new Map<string, string>();

  constructor(options: { xff: string; baseUrl?: string; cookies?: Iterable<[string, string]> }) {
    this.xff = options.xff;
    this.baseUrl = (options.baseUrl ?? resolveBaseUrl()).replace(/\/+$/, '');
    if (options.cookies) {
      for (const [name, value] of options.cookies) this.cookies.set(name, value);
    }
  }

  hasCookies(): boolean {
    return this.cookies.size > 0;
  }

  cookieHeader(): string {
    return [...this.cookies.values()].join('; ');
  }

  /** SSE / 原始 fetch 需要的基础头（含 cookie 与 XFF） */
  headers(extra: Record<string, string> = {}, withCookies = true): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Forwarded-For': this.xff,
      ...extra,
    };
    if (withCookies && this.cookies.size > 0) headers.Cookie = this.cookieHeader();
    return headers;
  }

  private storeSetCookies(res: Response): void {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const pair = raw.split(';')[0];
      if (!pair || !pair.includes('=')) continue;
      this.cookies.set(pair.slice(0, pair.indexOf('=')), pair);
    }
  }

  async request(
    method: string,
    pathname: string,
    options: ApiRequestOptions = {},
  ): Promise<ApiResponse> {
    const withCookies = options.withCookies !== false;
    const headers = this.headers(
      {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      withCookies,
    );

    const t0 = Date.now();
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    this.storeSetCookies(res);

    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON（SSE、HTML 错误页）时保留原文，由调用方断言
    }

    return {
      status: res.status,
      headers: res.headers,
      text,
      json,
      elapsedMs: Date.now() - t0,
      url: `${this.baseUrl}${pathname}`,
    };
  }

  get(pathname: string, options: ApiRequestOptions = {}): Promise<ApiResponse> {
    return this.request('GET', pathname, options);
  }

  post(pathname: string, body: unknown, options: ApiRequestOptions = {}): Promise<ApiResponse> {
    return this.request('POST', pathname, { ...options, body });
  }

  patch(pathname: string, body: unknown, options: ApiRequestOptions = {}): Promise<ApiResponse> {
    return this.request('PATCH', pathname, { ...options, body });
  }

  delete(pathname: string, options: ApiRequestOptions = {}): Promise<ApiResponse> {
    return this.request('DELETE', pathname, options);
  }
}

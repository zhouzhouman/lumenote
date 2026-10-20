/**
 * SSE 订阅与事件解析（真实 HTTP 流）。
 *
 * 为什么用 fetch + ReadableStream 而不是 EventSource：
 * Node 没有内置 EventSource；而且测试需要手动控制 abort（中途断线重连用例）
 * 与超时，fetch 的 AbortSignal 正好满足。
 *
 * 支持的能力：
 *  - 收集 meta / token / step / usage / done / error 事件
 *  - 收到 done 自动停止（避免测试挂在已经结束的流上）
 *  - 通过 onEvent 回调在收到指定事件时主动 abort（断线重连用例）
 *  - 超时/断线分别标记，避免把「测试自己断开」误判成失败
 */
import type { ApiClient } from './api';

export interface SseEvent {
  event: string;
  data: any;
  raw: string;
}

export interface SseControls {
  abort: () => void;
}

export interface SseSubscribeOptions {
  client: ApiClient;
  pathname: string;
  /** 额外请求头（如断线重连时的 Last-Event-ID） */
  headers?: Record<string, string>;
  /** 默认 60s。集成测试里任务 mock 下 1-3s 完成，超时只用于兜底 */
  timeoutMs?: number;
  /** 默认 true：收到 done 就主动断开 */
  stopOnDone?: boolean;
  onEvent?: (event: SseEvent, controls: SseControls) => void;
}

export interface SseSubscribeResult {
  status: number;
  events: SseEvent[];
  error: string | null;
  /** 被调用方（或收到 done）主动断开 */
  closedByClient: boolean;
  timedOut: boolean;
}

/** 解析单个 SSE 帧；注释帧（心跳 `: ping`）返回 null */
export function parseSseFrame(frame: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
  }
  if (dataLines.length === 0) return null;

  const raw = dataLines.join('\n');
  let data: unknown = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // 保留原文，断言失败时能打印出来
  }
  return { event, data, raw };
}

export async function subscribeSse(options: SseSubscribeOptions): Promise<SseSubscribeResult> {
  const { client, pathname } = options;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const stopOnDone = options.stopOnDone !== false;

  const controller = new AbortController();
  const events: SseEvent[] = [];
  let timedOut = false;
  let closedByClient = false;
  let responseStatus = 0;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const controls: SseControls = {
    abort: () => {
      closedByClient = true;
      controller.abort();
    },
  };

  try {
    const res = await fetch(`${client.baseUrl}${pathname}`, {
      headers: client.headers({
        Accept: 'text/event-stream',
        ...options.headers,
      }),
      signal: controller.signal,
    });
    responseStatus = res.status;

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      return {
        status: res.status,
        events,
        error: `SSE 订阅失败：HTTP ${res.status} ${text.slice(0, 300)}`,
        closedByClient,
        timedOut,
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseSseFrame(frame);
        if (!parsed) continue;
        events.push(parsed);
        options.onEvent?.(parsed, controls);
        if (stopOnDone && parsed.event === 'done') {
          closedByClient = true;
          controller.abort();
          break;
        }
      }
      if (controller.signal.aborted) break;
    }

    try {
      await reader.cancel();
    } catch {
      /* 已关闭 */
    }

    return { status: responseStatus, events, error: null, closedByClient, timedOut };
  } catch (e) {
    if (timedOut) {
      return {
        status: responseStatus,
        events,
        error: `SSE 订阅超时（${timeoutMs}ms），已收到 ${events.length} 个事件`,
        closedByClient,
        timedOut,
      };
    }
    if (closedByClient) {
      // 主动 abort 是正常路径（断线重连用例），不是错误
      return { status: responseStatus, events, error: null, closedByClient, timedOut };
    }
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: responseStatus,
      events,
      error: `SSE 读取失败：${message}`,
      closedByClient,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 拼接所有 token 事件的正文（即客户端应展示的完整内容） */
export function sseTokens(events: SseEvent[]): string {
  return events
    .filter((e) => e.event === 'token')
    .map((e) => String(e.data?.d ?? ''))
    .join('');
}

export function sseEventNames(events: SseEvent[]): string[] {
  return events.map((e) => e.event);
}

export function findSseEvent(events: SseEvent[], name: string): SseEvent | undefined {
  return events.find((e) => e.event === name);
}

/** 最后一个 done 事件（错误路径可能先 error 后 done） */
export function lastDoneEvent(events: SseEvent[]): SseEvent | undefined {
  return [...events].reverse().find((e) => e.event === 'done');
}

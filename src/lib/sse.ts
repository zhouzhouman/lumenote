/**
 * SSE（Server-Sent Events）封装。
 *
 * 为什么自研而不用 Vercel AI SDK 的 useChat？
 * 因为摘要场景和对话场景的协议需求不同：
 *  - 对话是「多轮增量」，客户端要维护消息列表
 *  - 摘要是「单次任务的结果流」，而且**需要断线续传**（长文摘要可能要几十秒）
 * 这里定义的事件协议能同时满足 meta/usage/error 的业务语义，
 * 且客户端只需要一个通用 parser。
 *
 * 事件的划分理由：
 *  - meta：任务开始时告知模型与 Prompt 版本 —— 这是「Prompt 指纹」的前端呈现
 *  - token：正文增量
 *  - usage：**必须在 done 之前单独发出**，因为用户可能因为别的原因提前关闭页面
 *  - step：Agent 任务的一步（工具调用与结果）
 *  - done / error：终止态
 *
 * ## 为什么加了第六个事件 `step`
 *
 * 原本是五个事件，且刻意保持精简。加 `step` 是因为 Agent 任务的
 * **过程本身就是产物的一部分**：用户要看到「检索了什么、命中几段」，
 * 而不是盯着一个转圈等 30 秒。没有这个事件，Agent 的「可观测」
 * 就只剩事后查轨迹 —— 而实时看到推理过程正是这个功能的核心价值。
 *
 * 它不破坏既有客户端：老客户端会忽略未知事件类型（SSE 的天然行为），
 * 普通摘要/翻译任务也永远不会发出它。所以这是一次**向后兼容的扩展**，
 * 而不是协议重写。
 *
 * 三个「不写就会翻车」的实现细节：
 *  1. **心跳**：不发的空闲连接会被代理层（Nginx/Vercel）静默掐断，
 *     表现为前端转圈到超时。
 *     对 Agent 尤其关键：一轮工具调用可能十几秒没有 token 输出。
 *  2. **防缓冲**：`no-transform` + `X-Accel-Buffering: no`，
 *     否则所有 token 会攒到结束一次性蹦出来，流式就没了。
 *  3. **必须用 new Response(stream)**：NextResponse.json() 会缓冲整个响应体。
 */

export type SseEventType = 'meta' | 'token' | 'usage' | 'step' | 'done' | 'error';

/** Agent 单步的事件载荷（与 AgentStepRecord 对齐，但只带前端要用的字段） */
export interface SseStepPayload {
  seq: number;
  phase: string;
  /** 这一步做了什么（给人看的一行说明） */
  note: string;
  /** 工具调用 [{name, display, ok}] —— 只带展示所需信息，参数不进事件 */
  tools: { name: string; display: string; ok: boolean }[];
  cumulativeTokens: number;
  latencyMs: number;
}

export interface SseEventPayloadMap {
  meta: {
    taskId: string;
    model: string;
    promptVersion: string;
    templateName: string;
  };
  token: { d: string };
  step: SseStepPayload;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costCny: number;
    cacheHitRate: number;
    peak: boolean;
  };
  done: {
    /** running = 订阅超时但任务仍在服务端执行，客户端应重连 */
    status: 'succeeded' | 'failed' | 'canceled' | 'running';
    degraded: boolean;
    message?: string;
  };
  error: { code: string; message: string; retryable: boolean };
}

const encoder = new TextEncoder();

/** 格式化为一个 SSE 帧 */
export function formatSse<T extends SseEventType>(
  event: T,
  data: SseEventPayloadMap[T],
): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 心跳注释帧。注释帧不会触发前端的 message 事件，仅用于保活 */
export function heartbeatFrame(): Uint8Array {
  return encoder.encode(': ping\n\n');
}

export interface SseResponseOptions {
  /** 心跳间隔，默认 15s */
  heartbeatMs?: number;
}

/**
 * 从 ReadableStream 创建 SSE 响应。
 *
 * 返回的是普通 Response 而非 NextResponse —— 后者会缓冲。
 */
export function createSseResponse(
  run: (emit: SseEmitter) => Promise<void>,
  options: SseResponseOptions = {},
): Response {
  const heartbeatMs = options.heartbeatMs ?? 15_000;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const emit = <T extends SseEventType>(event: T, data: SseEventPayloadMap[T]) => {
        if (closed) return;
        try {
          controller.enqueue(formatSse(event, data));
        } catch {
          // 客户端已断开。enqueue 在流关闭后会抛错，这是正常路径不是bug
          closed = true;
        }
      };

      // 心跳必须在管线之外单独跑：LLM 思考期间可能十几秒无输出，
      // 那段时间连接依然需要保活
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(heartbeatFrame());
        } catch {
          closed = true;
        }
      }, heartbeatMs);

      const emitter: SseEmitter = {
        meta: (d) => emit('meta', d),
        token: (d) => emit('token', { d }),
        step: (d) => emit('step', d),
        usage: (d) => emit('usage', d),
        done: (d) => emit('done', d),
        error: (d) => emit('error', d),
      };

      try {
        await run(emitter);
      } catch (e) {
        if (!closed) {
          try {
            controller.enqueue(
              formatSse('error', {
                code: 'INTERNAL',
                message: e instanceof Error ? e.message : '内部错误',
                retryable: false,
              }),
            );
          } catch {
            /* 客户端已断开 */
          }
        }
      } finally {
        clearInterval(heartbeat);
        if (!closed) {
          try {
            controller.close();
          } catch {
            /* 已关闭 */
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform 告诉代理不要压缩/转换响应体，否则流式会被缓冲
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx 侧保险：显式关闭缓冲
      'X-Accel-Buffering': 'no',
      // 禁止被 CDN 缓存
      'CDN-Cache-Control': 'no-store',
    },
  });
}

export interface SseEmitter {
  meta(data: SseEventPayloadMap['meta']): void;
  token(delta: string): void;
  /** Agent 任务的单步进度（普通任务不发这个事件） */
  step(data: SseEventPayloadMap['step']): void;
  usage(data: SseEventPayloadMap['usage']): void;
  done(data: SseEventPayloadMap['done']): void;
  error(data: SseEventPayloadMap['error']): void;
}

/**
 * 解析上游传来的 Last-Event-ID，支持断线续传。
 *
 * 当前实现的续传策略：客户端重连时带上前一次收到的 token 数，
 * 服务端已落库的内容会整体重放，由客户端按累计长度裁剪。
 * 这样做比维护精确的事件序号简单得多，且因为内容是持久化的，
 * 服务重启后依然能续传 —— 纯内存流做不到这一点。
 */
export function parseResumeToken(lastEventId: string | null): number {
  if (!lastEventId) return 0;
  const n = Number(lastEventId);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
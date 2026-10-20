/**
 * SSE 客户端。
 *
 * 为什么不用浏览器原生 EventSource？
 * 三个原因：
 *  1. **不支持自定义请求头**。我们要发 Authorization 与幂等相关头，EventSource 做不到
 *  2. **不支持 POST**。EventSource 只能 GET
 *  3. **无法携带 AbortSignal**。原生 API 没有中止能力，只能调 `.close()`，
 *     拿不到细粒度的取消控制
 *
 * 代价是要自己解析帧。但解析 SSE 并不难（见下），而且这份逻辑是「可控资产」：
 * 我们能在断线时自动重连、能精确知道已收到多少字符用于续传。
 */

export interface StreamHandlers {
  onMeta?: (data: { taskId: string; model: string; promptVersion: string; templateName: string }) => void;
  onDelta: (delta: string, accumulated: string) => void;
  /**
   * Agent 任务的单步进度。
   *
   * 只在 agent 任务上触发；普通任务的流里不会有 step 帧。
   * 与 token 的区别是语义：token 是"结果在长出来"，step 是"过程在推进"。
   */
  onStep?: (data: {
    seq: number;
    phase: string;
    note: string;
    tools: { name: string; display: string; ok: boolean }[];
    cumulativeTokens: number;
    latencyMs: number;
  }) => void;
  onUsage?: (data: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costCny: number;
    cacheHitRate: number;
    peak: boolean;
  }) => void;
  onDone?: (data: { status: string; degraded: boolean }) => void;
  onError?: (data: { code: string; message: string; retryable: boolean }) => void;
  /** 重连时触发，携带已累计的长度 */
  onReconnect?: (attempt: number, accumulatedLength: number) => void;
}

export interface StreamOptions extends StreamHandlers {
  signal?: AbortSignal;
  /** 最多重连次数 */
  maxRetries?: number;
  /** 每次 SSE 事件的自定义 id（用于 Last-Event-ID） */
  lastEventId?: string;
}

const MAX_RECONNECT_DELAY_MS = 8000;

/**
 * 订阅任务输出流。
 *
 * @returns 累计接收到的文本长度，供调用方在重连时判断续传位置
 */
export async function subscribeTaskStream(
  taskId: string,
  options: StreamOptions,
): Promise<void> {
  const { signal, maxRetries = 5 } = options;

  let accumulated = '';
  let attempt = 0;
  /**
   * 续传锚点：客户端已收到的字符数，作为 Last-Event-ID 发给服务端。
   *
   * ⚠️ 这个变量必须在重连前被赋值。
   * 早先只在初始化时读了 options.lastEventId（而所有调用方都不传），
   * 于是断线重连时服务端从 0 重放全文，客户端把它追加到 accumulated 后面 ——
   * 用户看到「要点一…要点二…要点一…要点二…」。协议两端各自都「看着没问题」，
   * 错在中间那条从未被赋值的通道。
   */
  let lastEventId = options.lastEventId;

  while (attempt <= maxRetries) {
    if (signal?.aborted) return;

    try {
      const res = await fetch(`/api/tasks/${taskId}/stream`, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
        },
        // 透传 cookie（同源请求默认带上，但显式写出来更清晰）
        credentials: 'same-origin',
        signal,
      });

      if (!res.ok) {
        // SSE 端点在鉴权失败时也返回 200 + error 事件；
        // 能走到这里说明是网络层或服务异常
        throw new Error(`订阅失败：HTTP ${res.status}`);
      }

      if (!res.body) throw new Error('当前浏览器不支持流式响应');

      let terminated = false; // 服务端已发 done/error，不该再重连

      await parseSseStream(res.body, {
        onFrame: (event, data) => {
          switch (event) {
            case 'meta':
              options.onMeta?.(data as never);
              break;

            case 'token': {
              const delta = (data as { d: string }).d;
              accumulated += delta;
              options.onDelta?.(delta, accumulated);
              break;
            }

            case 'usage':
              options.onUsage?.(data as never);
              break;

            case 'step':
              options.onStep?.(data as never);
              break;

            case 'done': {
              /**
               * ⚠️ 只有终态才结束循环。
               *
               * 协议里 done.status 可能是 'running' —— 含义是「订阅超时，但任务仍在
               * 服务端执行，请重连」。早先这里无条件 terminated = true，
               * 于是超过 10 分钟的长任务会永远停在半截文本上，还会被当成已完成，
               * 让整套「可重连」的设计（心跳、retryable、退避）全部失效。
               */
              const status = (data as { status?: string }).status;
              if (status !== 'running') terminated = true;
              options.onDone?.(data as never);
              break;
            }

            case 'error': {
              const payload = data as { code: string; message: string; retryable: boolean };
              // retryable 表示服务端建议重连（如订阅超时），
              // 其余情况重连也没用
              if (!payload.retryable) terminated = true;
              options.onError?.(payload);
              break;
            }

            default:
              break;
          }
        },
      });

      if (terminated) return;
    } catch (e) {
      if (signal?.aborted) return;
      // 正常中断（如切换页面）不重连
      if (e instanceof DOMException && e.name === 'AbortError') return;
      console.warn(`[sse] 第 ${attempt + 1} 次连接中断：`, e);
    }

    attempt += 1;
    if (attempt > maxRetries) {
      options.onError?.({
        code: 'MAX_RETRIES',
        message: '多次重连失败，请刷新页面查看结果',
        retryable: false,
      });
      return;
    }

    // 重连前把「已收到多少字符」同步给服务端，否则会收到重复内容
    lastEventId = String(accumulated.length);

    // 指数退避 + 抖动
    const delay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      500 * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5),
    );

    await new Promise((r) => setTimeout(r, delay));
    options.onReconnect?.(attempt, accumulated.length);
  }
}

/**
 * SSE 帧解析。
 *
 * 关键点：
 *  1. **必须按 \n\n 切帧**，但最后一帧可能不完整（还没收到分隔符），
 *     要留在缓冲区等下一批 —— 这是最容易写错的地方
 *  2. **心跳帧以 : 开头**（注释），必须跳过，否则会被误解析成空事件
 *  3. TextDecoder 要用 `{ stream: true }`，否则多字节 UTF-8 字符（中文、emoji）
 *     跨 chunk 边界时会被截断成乱码。这是最容易忽略也最影响体验的 bug
 */
async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  handlers: { onFrame: (event: string, data: unknown) => void },
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 保留最后一段（可能是不完整的帧）
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        parseFrame(frame, handlers.onFrame);
      }
    }

    // 处理流结束时残留的帧
    if (buffer.trim()) parseFrame(buffer, handlers.onFrame);
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string, onFrame: (event: string, data: unknown) => void): void {
  const trimmed = frame.trim();
  if (!trimmed) return;

  // 心跳/注释帧
  if (trimmed.startsWith(':')) return;

  let event = 'message';
  const dataLines: string[] = [];

  for (const line of trimmed.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // data 可能有多行，要用 \n 拼接（每行去掉一个前导空格）
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }

  if (dataLines.length === 0) return;

  const raw = dataLines.join('\n');
  try {
    onFrame(event, JSON.parse(raw));
  } catch {
    // 非 JSON 的 data 视为纯文本（便于调试）
    onFrame(event, raw);
  }
}
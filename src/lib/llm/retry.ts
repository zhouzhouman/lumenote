import { LLMError } from './types';

/**
 * 重试策略：指数退避 + 全抖动。
 *
 * 为什么是「全抖动（full jitter）」而不是固定指数退避？
 *
 * 固定退避（2s, 4s, 8s）会让所有被限流的客户端在**同一时刻**一起重试，
 * 形成第二波脉冲（thundering herd），把刚恢复的服务again 打挂。
 * 全抖动 delay = random(0, min(cap, base * 2^attempt)) 把请求摊平到整个窗口内，
 * 这是 AWS Architecture Blog 那篇经典文章里的结论。
 *
 * 只对 retryable 错误重试：429 / 5xx / 网络超时。
 * 4xx 参数错误和内容过滤重试没有意义 —— 结果必然一样，只是白烧 token。
 */

export interface RetryConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  baseDelayMs: 500,
  maxDelayMs: 8000,
  maxAttempts: 3,
};

export function computeDelay(attempt: number, cfg: RetryConfig = DEFAULT_RETRY): number {
  const ceiling = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LLMError('已取消', 'ABORTED', false));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new LLMError('已取消', 'ABORTED', false));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 带重试地执行一次调用。
 *
 * onRetry 回调用于记录每次尝试的轨迹 —— 这在排查「为什么这次变贵了」时很关键：
 * 一个请求重试 3 次，成本就是 3 倍，日志里必须能看出来。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: {
    cfg?: RetryConfig;
    signal?: AbortSignal;
    onRetry?: (info: { attempt: number; delayMs: number; error: LLMError }) => void;
  } = {},
): Promise<T> {
  const cfg = options.cfg ?? DEFAULT_RETRY;
  let lastError: LLMError | undefined;

  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    /**
     * 每一轮开始前都要检查中止状态，**包括第一次**。
     *
     * 只在 sleep 里检查是不够的：如果调用进来时 signal 已经中止，
     * 第一次请求仍会真实发出去 —— 而那一次请求就是真金白银的 token 花费。
     * 用户点了「停止」，任务却还在烧钱，这是最不能接受的失败模式。
     */
    if (options.signal?.aborted) {
      throw new LLMError('已取消', 'ABORTED', false);
    }

    try {
      return await fn(attempt);
    } catch (e) {
      const err = e instanceof LLMError ? e : new LLMError(String(e), 'UNKNOWN', false);

      // 不可重试，或已用尽次数，直接抛出
      if (!err.retryable || attempt === cfg.maxAttempts - 1) {
        throw err;
      }

      const delayMs = computeDelay(attempt, cfg);
      options.onRetry?.({ attempt: attempt + 1, delayMs, error: err });

      try {
        await sleep(delayMs, options.signal);
      } catch {
        // sleep 期间被取消，直接把原始错误抛出去
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError ?? new LLMError('重试失败', 'UNKNOWN', false);
}
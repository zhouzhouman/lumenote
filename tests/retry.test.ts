import { describe, it, expect, vi } from 'vitest';
import { computeDelay, withRetry, DEFAULT_RETRY } from '@/lib/llm/retry';
import { LLMError } from '@/lib/llm/types';

describe('computeDelay', () => {
  /**
   * 全抖动 vs 固定指数退避的关键区别：延迟必须被摊平到整个窗口内。
   * 如果所有客户端算出相同的延迟，限流场景下会形成第二波脉冲。
   */
  it('返回区间内随机值，不是固定值', () => {
    const samples = new Set<number>();
    for (let i = 0; i < 50; i++) samples.add(computeDelay(0));
    expect(samples.size).toBeGreaterThan(10);
  });

  it('永远不超过上限（否则退避形同虚设）', () => {
    for (let i = 0; i < 200; i++) {
      expect(computeDelay(10)).toBeLessThanOrEqual(DEFAULT_RETRY.maxDelayMs);
      expect(computeDelay(10)).toBeGreaterThanOrEqual(0);
    }
  });

  it('窗口随重试次数指数增长', () => {
    const maxAt = (attempt: number) => {
      let max = 0;
      for (let i = 0; i < 300; i++) max = Math.max(max, computeDelay(attempt));
      return max;
    };
    expect(maxAt(1)).toBeGreaterThan(maxAt(0));
    expect(maxAt(3)).toBeGreaterThan(maxAt(1));
  });

  it('接受自定义配置', () => {
    const cfg = { baseDelayMs: 100, maxDelayMs: 200, maxAttempts: 2 };
    for (let i = 0; i < 100; i++) {
      expect(computeDelay(5, cfg)).toBeLessThanOrEqual(200);
    }
  });
});

describe('withRetry', () => {
  // 把 baseDelay 压到极小，避免测试真的等待
  const fast = { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 3 };

  it('首次成功不重试', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { cfg: fast });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('可重试错误会重试并最终成功', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new LLMError('限流', 'RATE_LIMITED', true);
        return 'success';
      },
      { cfg: fast },
    );

    expect(result).toBe('success');
    expect(calls).toBe(3);
  });

  /**
   * 不可重试错误必须立刻抛出。
   * 参数错误（400）重试结果必然相同，只是白白多烧两次 token。
   */
  it('不可重试错误立即抛出，不做无谓重试', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new LLMError('参数错误', 'INVALID_REQUEST', false);
        },
        { cfg: fast },
      ),
    ).rejects.toThrow('参数错误');

    expect(calls).toBe(1);
  });

  it('用尽次数后抛出最后一次的错误', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new LLMError('服务不可用', 'UPSTREAM_UNAVAILABLE', true);
        },
        { cfg: fast },
      ),
    ).rejects.toThrow('服务不可用');

    expect(calls).toBe(fast.maxAttempts);
  });

  /**
   * 重试轨迹必须被记录。
   * 一个请求重试 3 次成本就是 3 倍，日志里看不出来就没法排查成本异常。
   */
  it('通过 onRetry 暴露每一次重试', async () => {
    const onRetry = vi.fn();
    let calls = 0;

    await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new LLMError('限流', 'RATE_LIMITED', true);
        return 'ok';
      },
      { cfg: fast, onRetry },
    );

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1 });
    expect(onRetry.mock.calls[0]![0].delayMs).toBeGreaterThanOrEqual(0);
  });

  it('AbortSignal 已中止时立即拒绝', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      withRetry(async () => 'never', { cfg: fast, signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('非 LLMError 的异常被包装为 LLMError，不丢失调用栈', async () => {
    await expect(
      withRetry(
        async () => {
          throw new TypeError('undefined is not a function');
        },
        { cfg: fast },
      ),
    ).rejects.toBeInstanceOf(LLMError);
  });
});
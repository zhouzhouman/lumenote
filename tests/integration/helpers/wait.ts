/**
 * 轮询工具：等一个异步条件成立。
 *
 * 集成测试里大量出现「等任务到终态」「等 DB 行出现」这类等待。
 * 统一实现在这里，避免各处写 `while + setTimeout` 时出现：
 *  - 没有超时（测试挂死，CI 等到 job timeout 才失败）
 *  - 超时信息不完整（不知道最后一次观察到的值，排查全靠猜）
 */
export interface WaitOptions {
  /** 总超时，默认 45s（mock 管线约 1-3s，留足 dev 首次编译的余量） */
  timeoutMs?: number;
  /** 轮询间隔，默认 150ms */
  intervalMs?: number;
}

export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  options: WaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const intervalMs = options.intervalMs ?? 150;
  const deadline = Date.now() + timeoutMs;
  let last: unknown = '(尚未探测)';
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const value = await probe();
      if (value) return value;
      last = value;
    } catch (e) {
      last = e instanceof Error ? `异常：${e.message}` : e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`等待「${label}」超时（${timeoutMs}ms，轮询 ${attempts} 次）。最后一次结果：${String(last)}`);
}

/** 固定等待（只用于「让时序推进」的场景，例如等 after() 启动管线） */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

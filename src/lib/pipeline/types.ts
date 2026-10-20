/**
 * 模块职责：摘要管线的**公共结果/选项类型**。
 *
 * 单独放一个文件是为了避免拆分后的循环引用：`runner` 与 `map-reduce`
 * 都需要引用 `PipelineResult`，把类型放在任一方都会让另一方反向依赖。
 * 这里只有类型，没有运行时依赖。
 */

export interface RunPipelineOptions {
  taskId: string;
  /** 每个 token 增量回调（SSE 推送） */
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface PipelineResult {
  outputContent: string;
  degraded: boolean;
  degradedReason?: string;
  attempts: { label: string; ok: boolean; error?: string }[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costCny: number;
    cacheHitRate: number;
    peak: boolean;
  };
  ttftMs?: number;
}

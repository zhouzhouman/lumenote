import { appendFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { HrTime } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-node';
import { sanitizeAttributes, type SanitizedValue } from './sanitize';

/**
 * 把 span 写成 JSONL 的自定义 exporter（每行一个 span，便于 grep / jq）。
 *
 * ## 为什么自己写一个而不是用 ConsoleSpanExporter
 *
 * ConsoleSpanExporter 的输出是给人看的多行结构，无法按 `taskId` 检索；
 * 而本任务的核心诉求是「**给定 taskId，捞出它整条链路的 span**」。
 * JSONL 一行一个 span，`grep '"taskId":"xxx"'` 就够了 ——
 * 不引入 Jaeger/Tempo 也能在本地做任务级排障，符合「最小可运行」的取舍。
 *
 * ## 落盘策略：SimpleSpanProcessor + 同步追加
 *
 * - 用 `appendFileSync` 而不是流/缓冲：**进程可能立刻退出**（CLI 脚本、测试），
 *   异步缓冲会丢掉最后几条 span —— 而最后几条往往正是收尾/失败相关的。
 * - 用 Simple 而不是 Batch 处理器是同一考虑：不依赖进程存活到定时 flush。
 *   单进程 trace 量级是「每任务几十条」，同步追加的开销可忽略。
 *   （TRACE_EXPORT=otlp 时才用 Batch，那里有真实网络开销。）
 *
 * ## 失败语义：**绝不影响主流程**
 *
 * 磁盘满、目录不可写、权限不足都可能发生。这些都是可观测性问题，
 * 不该让用户的摘要任务失败。所以：
 *   - 导出失败只 warn（且同一实例只 warn 一次，避免刷屏）；
 *   - export() 永不抛错；
 *   - 目录在**第一次导出时**才创建（TRACE_EXPORT=none/未启用时不产生任何目录）。
 */

/** 与 @opentelemetry/core 的 ExportResultCode 数值一致（避免为两个常量多引一个包） */
const EXPORT_RESULT_SUCCESS = 0;
const EXPORT_RESULT_FAILED = 1;

/** JSONL 中的一条 span（脱敏后的稳定结构，报告与测试都读它） */
export interface TraceSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  /** ISO 8601 时间戳 */
  startTime: string;
  endTime: string;
  durationMs: number;
  status: { code: string; message?: string };
  attributes: Record<string, SanitizedValue>;
  events: { name: string; time: string; attributes?: Record<string, SanitizedValue> }[];
}

/** HrTime（[秒, 纳秒]）转毫秒 */
export function hrTimeToMillis(hr: HrTime): number {
  return hr[0] * 1000 + hr[1] / 1e6;
}

function hrTimeToIso(hr: HrTime): string {
  return new Date(hrTimeToMillis(hr)).toISOString();
}

/** UTC 日期（YYYY-MM-DD）。用 UTC 而不是本地时区，避免同一份 trace 因时区漂移落到不同文件 */
export function traceFileDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * ReadableSpan → 可落盘的一行。
 *
 * 只保留排障必要字段：标识、名称、父子关系、耗时、状态、脱敏属性、事件。
 * resource / instrumentationScope 被刻意丢弃 —— 它们每行都相同，占体积且无助于任务级检索。
 */
export function spanToRecord(span: ReadableSpan): TraceSpanRecord {
  const spanContext = span.spanContext();
  const parentSpanContext = span.parentSpanContext;

  const record: TraceSpanRecord = {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    ...(parentSpanContext?.spanId ? { parentSpanId: parentSpanContext.spanId } : {}),
    name: span.name,
    kind: typeof span.kind === 'number' ? String(span.kind) : String(span.kind),
    startTime: hrTimeToIso(span.startTime),
    endTime: hrTimeToIso(span.endTime),
    durationMs: Number(hrTimeToMillis(span.duration).toFixed(3)),
    status: {
      code: String(span.status.code),
      ...(span.status.message ? { message: span.status.message } : {}),
    },
    attributes: sanitizeAttributes(span.attributes),
    events: span.events.map((event) => ({
      name: event.name,
      time: hrTimeToIso(event.time),
      ...(event.attributes
        ? { attributes: sanitizeAttributes(event.attributes) }
        : {}),
    })),
  };

  return record;
}

export interface JsonlSpanExporterOptions {
  /** 落盘目录（绝对或相对路径）。在第一次成功导出时才创建 */
  dir: string;
  /** 时钟注入（测试用）。默认 `() => new Date()` */
  now?: () => Date;
  /** 失败告警回调。默认 console.warn */
  warn?: (message: string) => void;
  /**
   * 只导出满足条件的 span。默认全部接受（测试可注入）。
   *
   * 生产路径（见 tracing.ts buildExporter）只接受 instrumentationScope.name === 'lumenote'
   * 的 span：全局 provider 注册后，Next.js 内部也会通过 @opentelemetry/api 产生大量
   * 框架 span（prepare route module / render route / GET /...）。它们对「按 taskId 检索」
   * 没有价值，还会把 JSONL 撑大、增加 dev watcher 触发频率。
   */
  acceptSpan?: (span: ReadableSpan) => boolean;
}

/**
 * JSONL span exporter。
 *
 * ⚠️ 只实现 `SpanExporter` 的三个方法；`export()` 内部同步追加，不抛错。
 */
export class JsonlSpanExporter implements SpanExporter {
  private readonly dir: string;
  private readonly now: () => Date;
  private readonly acceptSpan: (span: ReadableSpan) => boolean;
  private readonly warn: (message: string) => void;
  /** 同一实例只告警一次，避免磁盘不可写时每条 span 刷一行日志 */
  private warned = false;
  private dirReady = false;

  constructor(options: JsonlSpanExporterOptions) {
    this.dir = options.dir;
    this.now = options.now ?? (() => new Date());
    this.acceptSpan = options.acceptSpan ?? (() => true);
    this.warn =
      options.warn ??
      ((message) => {
        console.warn(message);
      });
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: number; error?: Error }) => void,
  ): void {
    try {
      const accepted = spans.filter((span) => this.acceptSpan(span));
      if (accepted.length === 0) {
        resultCallback({ code: EXPORT_RESULT_SUCCESS });
        return;
      }

      this.ensureDir();

      // 按导出时刻分文件：长进程跨天时 span 会自然落到两天的文件里
      const file = path.join(this.dir, `${traceFileDate(this.now())}.jsonl`);
      const payload = `${accepted.map((span) => JSON.stringify(spanToRecord(span))).join('\n')}\n`;
      appendFileSync(file, payload, 'utf8');

      resultCallback({ code: EXPORT_RESULT_SUCCESS });
    } catch (error) {
      this.reportFailure(error);
      resultCallback({
        code: EXPORT_RESULT_FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async shutdown(): Promise<void> {
    // 无缓冲、无需 flush
  }

  async forceFlush(): Promise<void> {
    // 同步追加，没有待刷新的数据
  }

  private ensureDir(): void {
    if (this.dirReady) return;
    mkdirSync(this.dir, { recursive: true });
    this.dirReady = true;
  }

  private reportFailure(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const message = error instanceof Error ? error.message : String(error);
    this.warn(`[observability] 写入 trace 失败，已跳过后续导出（不影响应用）：${message}`);
  }
}

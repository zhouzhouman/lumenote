import {
  context,
  createContextKey,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { BatchSpanProcessor, ConsoleSpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import type { SpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  DEFAULT_TRACE_DIR,
  resolveObservabilityConfig,
  type ObservabilityConfig,
} from './config';
import { JsonlSpanExporter } from './jsonl-exporter';
import { digestText, sanitizeAttributes } from './sanitize';

/**
 * 任务级 tracing 的统一入口。
 *
 * ## 设计目标（按优先级）
 *
 * 1. **零侵入**：业务模块只调 `withSpan` / `withTaskSpan`，不认识 OTel。
 *    关掉 tracing 时这些调用会退化成 OTel API 的 no-op span（微秒级），
 *    业务代码里不需要任何 `if (enabled)` 分支。
 * 2. **永不阻塞启动**：`initTracing()` 自己吞掉所有异常，只 warn。
 * 3. **taskId 贯穿**：根 span 带上 `taskId`，并通过 OTel Context 传下去，
 *    子 span 自动继承（见 `taskAttributes`），因此可以在 JSONL 里按 taskId 检索整条链路。
 *
 * ## 为什么用 Context 传 taskId，而不是全局变量
 *
 * Next.js 会并发处理多个任务。全局变量在并发下会把 A 任务的 taskId
 * 写到 B 任务的 span 上 —— 那比没有 taskId 更糟（错误关联会误导排障）。
 * OTel Context 基于 AsyncLocalStorage，天然按异步调用链隔离。
 *
 * ## span 命名约定（面试可讲：名字就是查询接口）
 *
 *   task.pipeline      根 span（一次任务执行）
 *   task.lifecycle     任务生命周期前置（加载/校验/分块）
 *   task.persist       产物落库
 *   llm.request        一次模型调用（phase=map|reduce|agent）
 *   agent.plan         Agent 状态机的一次 plan
 *   agent.tool         一次工具执行
 *   agent.observe      一次 act→observe 决策
 *   agent.finalize     Agent 终止
 *   agent.evidence_check 证据链校验
 */

const TRACER_NAME = 'lumenote';
const TRACER_VERSION = '1.0.0';

/** Context key：当前任务的 taskId。子 span 从这里继承，避免并发串号 */
const TASK_ID_CONTEXT_KEY = createContextKey('lumenote.taskId');

let provider: NodeTracerProvider | null = null;
let activeConfig: ObservabilityConfig | null = null;

export interface InitTracingOptions {
  /** 环境变量来源，默认 process.env（单测可注入） */
  env?: NodeJS.ProcessEnv;
  /** 相对 TRACE_DIR 的基准目录，默认 process.cwd() */
  cwd?: string;
  /** 注入 exporter（单测用 InMemorySpanExporter；生产留空按配置构建） */
  exporter?: SpanExporter;
  /** 强制重新初始化（测试/报告脚本重复调用） */
  force?: boolean;
  /** 告警输出，默认 console.warn */
  warn?: (message: string) => void;
}

function warnDefault(message: string): void {
  console.warn(message);
}

/** 当前 tracer。未注册 provider 时 OTel API 返回廉价 no-op tracer */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

/** 已生效的配置（未初始化时为 null） */
export function getObservabilityConfig(): ObservabilityConfig | null {
  return activeConfig;
}

/** tracing 是否真的会产出 span（enabled 且不是 none） */
export function isTracingActive(): boolean {
  return Boolean(provider && activeConfig?.enabled && activeConfig.exportMode !== 'none');
}

/** 当前异步上下文里的 taskId（无则 undefined） */
export function currentTaskId(): string | undefined {
  return context.active().getValue(TASK_ID_CONTEXT_KEY) as string | undefined;
}

/** 在当前上下文里绑定 taskId（供跨模块的收尾/持久化使用） */
export function runWithTaskContext<T>(taskId: string, fn: () => T): T {
  return context.with(context.active().setValue(TASK_ID_CONTEXT_KEY, taskId), fn);
}

/**
 * 初始化 tracing。
 *
 * **永不抛错**：任何失败（缺包、exporter 构造失败、重复注册冲突）都只 warn。
 * 这样 `instrumentation.ts` 的 register() 可以无条件调用它，
 * 不会因为可观测性配置问题阻塞 Next.js 启动。
 */
export function initTracing(options: InitTracingOptions = {}): ObservabilityConfig {
  const warn = options.warn ?? warnDefault;

  let config: ObservabilityConfig;
  try {
    config = resolveObservabilityConfig(options.env ?? process.env, options.cwd ?? process.cwd());
  } catch (error) {
    // resolveObservabilityConfig 理论上永不抛错；这里只是最后一道保险
    const message = error instanceof Error ? error.message : String(error);
    warn(`[observability] 配置解析异常，已禁用 tracing：${message}`);
    config = { enabled: false, exportMode: 'none', traceDir: DEFAULT_TRACE_DIR, warnings: [] };
  }

  activeConfig = config;

  for (const warning of config.warnings) {
    warn(`[observability] ${warning}`);
  }

  if (!config.enabled || config.exportMode === 'none') {
    /**
     * 关闭/丢弃模式：**先停掉可能存在的旧 provider**，再返回。
     *
     * 这一步在「测试里反复 init」或「运行期把配置改成 none」时很关键：
     * 只把 activeConfig 改掉而留旧 provider 在注册表里，span 仍会继续
     * 被旧 exporter 导出 —— 用户以为关了，其实文件还在写。
     */
    const previous = provider;
    provider = null;
    if (previous) {
      void previous.shutdown().catch(() => undefined);
    }
    return config;
  }

  try {
    const exporter = options.exporter ?? buildExporter(config, warn);
    const processor =
      config.exportMode === 'otlp'
        ? new BatchSpanProcessor(exporter)
        : new SimpleSpanProcessor(exporter);

    const next = new NodeTracerProvider({ spanProcessors: [processor] });
    next.register();

    // 先注册新的再关旧的：避免两次初始化之间出现「没有 provider」的窗口
    const previous = provider;
    provider = next;
    if (previous) {
      void previous.shutdown().catch(() => undefined);
    }
  } catch (error) {
    // 初始化失败不改变 provider：保持默认 no-op，业务继续跑
    const message = error instanceof Error ? error.message : String(error);
    warn(`[observability] 初始化失败，已跳过 tracing（不影响应用启动）：${message}`);
  }

  return config;
}

function buildExporter(config: ObservabilityConfig, warn: (message: string) => void): SpanExporter {
  switch (config.exportMode) {
    case 'console':
      return new ConsoleSpanExporter();
    case 'otlp': {
      const endpoint = (config.otlpEndpoint ?? '').trim();
      // OTLP/HTTP 的 trace 信号路径是 /v1/traces；用户配的是 base endpoint
      const url = endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint.replace(/\/+$/, '')}/v1/traces`;
      return new OTLPTraceExporter({ url });
    }
    case 'jsonl':
    default:
      return new JsonlSpanExporter({ dir: config.traceDir, warn });
  }
}

/** 关闭 provider（脚本/测试收尾用）。永不抛错 */
export async function shutdownTracing(): Promise<void> {
  const current = provider;
  provider = null;
  if (!current) return;
  try {
    await current.shutdown();
  } catch {
    // 停止 tracing 失败不值得影响进程退出
  }
}

/** 强制 flush（Process 即将退出/读文件前调用） */
export async function flushTracing(): Promise<void> {
  try {
    await provider?.forceFlush();
  } catch {
    // 同上
  }
}

/** 测试用：重置模块级状态（不注册 provider） */
export function resetTracingForTests(): void {
  provider = null;
  activeConfig = null;
}

/**
 * 子 span 的公共属性：自动继承当前上下文的 taskId。
 * 调用方显式传入的 taskId 优先（例如根 span）。
 */
function withTaskAttributes(attributes: Attributes): Attributes {
  const taskId = currentTaskId();
  return taskId ? { taskId, ...attributes } : { ...attributes };
}

/** 对 span 设置一批**已脱敏**的属性（值仍会过一遍截断/密钥兜底） */
export function setSpanAttributes(span: Span, attributes: Attributes | Record<string, unknown>): void {
  span.setAttributes(sanitizeAttributes(attributes));
}

/** 给当前活动 span 设置属性（根 span 延后补属性时用） */
export function setActiveSpanAttributes(attributes: Attributes | Record<string, unknown>): void {
  trace.getActiveSpan()?.setAttributes(sanitizeAttributes(attributes));
}

async function endSpan<T>(span: Span, fn: (span: Span) => T | Promise<T>): Promise<T> {
  try {
    const result = await fn(span);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    if (error instanceof Error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message.slice(0, 200) });
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error).slice(0, 200) });
    }
    throw error;
  } finally {
    span.end();
  }
}

/**
 * 创建根 span，并把 taskId 写进 OTel Context 供所有子 span 继承。
 *
 * 用法（pipeline runner / agent runner 的外层包装）：
 *   return withTaskSpan('task.pipeline', taskId, { type: 'agent' }, () => runCore());
 */
export function withTaskSpan<T>(
  name: string,
  taskId: string,
  attributes: Attributes,
  fn: (span: Span) => T | Promise<T>,
): Promise<T> {
  const ctx = context.active().setValue(TASK_ID_CONTEXT_KEY, taskId);
  return context.with(ctx, () =>
    getTracer().startActiveSpan(
      name,
      { attributes: sanitizeAttributes({ taskId, ...attributes }) },
      (span) => endSpan(span, fn),
    ),
  );
}

/**
 * 创建子 span（自动处于当前活动 span 之下，并继承 taskId）。
 *
 * 业务接入点的标准写法；无论 tracing 开关，调用形式一致。
 */
export function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => T | Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(
    name,
    { attributes: sanitizeAttributes(withTaskAttributes(attributes)) },
    (span) => endSpan(span, fn),
  );
}

/**
 * 记录一段文本的**长度与哈希**（不落正文）。
 * 供需要关联输入但不得泄漏内容的场景使用。
 */
export function textDigestAttributes(text: string, prefix = 'text'): Attributes {
  const digest = digestText(text);
  return {
    [`${prefix}Length`]: digest.length,
    [`${prefix}Hash`]: digest.hash,
  };
}

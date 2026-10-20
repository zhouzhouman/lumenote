import * as path from 'node:path';

/**
 * 可观测性配置解析（纯函数，便于单测）。
 *
 * ## 为什么不用 `src/lib/env.ts`
 *
 * `env.ts` 是**启动即失败**的校验器：给不出 DATABASE_URL / AUTH_SECRET 就抛错。
 * 而可观测性是**尽力而为**的横切能力：缺 OTLP 地址不该让整个应用起不来，
 * 只该降级并 warn。两者的失败语义相反，混进同一个 zod schema 会让
 * 「tracing 配置写错」升级成「服务无法启动」—— 那正是本任务明确禁止的。
 *
 * 所以这里直接读 `process.env`，并且**永不抛错**：非法值一律回退到安全默认。
 *
 * ## 环境变量
 *
 * - `OBSERVABILITY_ENABLED`：`true` / `false`。缺省时 development 开、其它关。
 *   （production 默认关：trace 是排障工具，生产是否落盘应由运维显式开启。）
 * - `TRACE_EXPORT`：`jsonl`（默认）| `console` | `otlp` | `none`。
 * - `TRACE_DIR`：JSONL 落盘目录，默认 `.lumenote-data/traces`（已 gitignore）。
 * - `OTEL_EXPORTER_OTLP_ENDPOINT`：仅 `TRACE_EXPORT=otlp` 时使用；缺失则降级为 jsonl。
 */

export type TraceExportMode = 'jsonl' | 'console' | 'otlp' | 'none';

export interface ObservabilityConfig {
  /** 总开关；false 时所有 span 调用都是 OTel API 的廉价 no-op */
  enabled: boolean;
  /** 导出方式；`none` 表示启用但丢弃（便于「打开链路但暂不落盘」） */
  exportMode: TraceExportMode;
  /** JSONL 导出目录（绝对路径） */
  traceDir: string;
  /** OTLP HTTP endpoint（仅 exportMode=otlp 时存在） */
  otlpEndpoint?: string;
  /** 解析过程中产生的降级说明，由初始化方负责 warn 出来 */
  warnings: string[];
}

/** JSONL trace 默认落盘目录。`.lumenote-data/` 已在 .gitignore 中 */
export const DEFAULT_TRACE_DIR = '.lumenote-data/traces';

const TRACE_EXPORT_MODES: readonly TraceExportMode[] = ['jsonl', 'console', 'otlp', 'none'];

function isTraceExportMode(value: string | undefined): value is TraceExportMode {
  return value !== undefined && (TRACE_EXPORT_MODES as readonly string[]).includes(value);
}

/**
 * 解析 `OBSERVABILITY_ENABLED` 的三态默认值。
 *
 * - 显式 `true` / `false` 优先；
 * - 未设置时：development 开、production / test / 其它关。
 *
 * 测试环境默认关是刻意的：单测不该因为 import 了业务模块就产生磁盘文件。
 */
export function resolveEnabled(source: NodeJS.ProcessEnv): boolean {
  const raw = source.OBSERVABILITY_ENABLED?.trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return source.NODE_ENV === 'development';
}

/**
 * 解析可观测性配置。**纯函数、永不抛错**。
 *
 * @param source 环境变量来源，默认 `process.env`；单测可传入构造的对象。
 * @param cwd     解析相对 TRACE_DIR 的基准目录，默认 `process.cwd()`。
 */
export function resolveObservabilityConfig(
  source: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ObservabilityConfig {
  const warnings: string[] = [];

  const enabled = resolveEnabled(source);

  const rawMode = source.TRACE_EXPORT?.trim().toLowerCase();
  let exportMode: TraceExportMode = 'jsonl';
  if (rawMode !== undefined && rawMode !== '') {
    if (isTraceExportMode(rawMode)) {
      exportMode = rawMode;
    } else {
      warnings.push(`TRACE_EXPORT=${rawMode} 不是合法值（可选 jsonl/console/otlp/none），已回退为 jsonl`);
    }
  }

  const otlpEndpoint = source.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined;

  /**
   * otlp 缺少 endpoint 时**降级而不是关闭**：
   * 本地排障仍希望留下 trace，所以退到默认的 jsonl 落盘，并 warn 说明原因。
   */
  if (exportMode === 'otlp' && !otlpEndpoint) {
    warnings.push(
      'TRACE_EXPORT=otlp 但未设置 OTEL_EXPORTER_OTLP_ENDPOINT，已降级为 jsonl（不会向网络发送任何数据）',
    );
    exportMode = 'jsonl';
  }

  const rawDir = source.TRACE_DIR?.trim() || DEFAULT_TRACE_DIR;
  const traceDir = path.resolve(cwd, rawDir);

  return {
    enabled,
    exportMode,
    traceDir,
    ...(exportMode === 'otlp' && otlpEndpoint ? { otlpEndpoint } : {}),
    warnings,
  };
}

/** 给日志/报告用的一行摘要（绝不包含任何密钥） */
export function describeObservabilityConfig(config: ObservabilityConfig): string {
  const parts = [
    `enabled=${config.enabled}`,
    `export=${config.exportMode}`,
    `dir=${config.traceDir}`,
  ];
  if (config.otlpEndpoint) parts.push(`otlp=${config.otlpEndpoint}`);
  return parts.join(' ');
}

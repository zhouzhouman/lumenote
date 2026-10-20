import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import {
  DEFAULT_TRACE_DIR,
  resolveEnabled,
  resolveObservabilityConfig,
} from '@/lib/observability/config';
import {
  JsonlSpanExporter,
  spanToRecord,
  traceFileDate,
} from '@/lib/observability/jsonl-exporter';
import {
  digestText,
  MAX_ATTRIBUTE_VALUE_LENGTH,
  sanitizeAttributeValue,
  sanitizeAttributes,
} from '@/lib/observability/sanitize';
import { flushTracing, initTracing, shutdownTracing, withTaskSpan } from '@/lib/observability/tracing';
import { parseTraceJsonl } from '@/lib/observability/trace-reader';

/**
 * 配置/脱敏/导出容错 的单测。
 *
 * 重点验证三条「必须成立但很容易写坏」的性质：
 *   1. `TRACE_EXPORT=none` / 关闭时**不产生任何文件**且 span 调用不抛错；
 *   2. exporter 写失败（目录不可写）**不影响主流程**，只 warn 一次；
 *   3. span 属性在落盘前被脱敏/截断（API Key 与正文绝不落盘）。
 */

const TMP = mkdtempSync(path.join(os.tmpdir(), 'lumenote-obs-export-'));

afterAll(async () => {
  await shutdownTracing();
  rmSync(TMP, { recursive: true, force: true });
});

describe('配置解析（纯函数）', () => {
  it('OBSERVABILITY_ENABLED 三态默认：development 开、production 关、显式优先', () => {
    expect(resolveEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(resolveEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(resolveEnabled({ NODE_ENV: 'production', OBSERVABILITY_ENABLED: 'true' })).toBe(true);
    expect(resolveEnabled({ NODE_ENV: 'development', OBSERVABILITY_ENABLED: 'false' })).toBe(false);
  });

  it('非法 TRACE_EXPORT 回退 jsonl 并给出 warning', () => {
    const config = resolveObservabilityConfig({ NODE_ENV: 'development', TRACE_EXPORT: 'zip' }, TMP);
    expect(config.exportMode).toBe('jsonl');
    expect(config.warnings.join()).toContain('TRACE_EXPORT=zip');
  });

  it('otlp 缺 endpoint 时降级 jsonl 并 warning', () => {
    const config = resolveObservabilityConfig(
      { NODE_ENV: 'development', TRACE_EXPORT: 'otlp' },
      TMP,
    );
    expect(config.exportMode).toBe('jsonl');
    expect(config.otlpEndpoint).toBeUndefined();
    expect(config.warnings.join()).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
  });

  it('otlp + endpoint 保留配置；TRACE_DIR 解析为绝对路径', () => {
    const config = resolveObservabilityConfig(
      {
        NODE_ENV: 'development',
        TRACE_EXPORT: 'otlp',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        TRACE_DIR: 'custom-traces',
      },
      TMP,
    );
    expect(config.exportMode).toBe('otlp');
    expect(config.otlpEndpoint).toBe('http://127.0.0.1:4318');
    expect(config.traceDir).toBe(path.resolve(TMP, 'custom-traces'));
  });

  it('缺省目录是 .lumenote-data/traces', () => {
    const config = resolveObservabilityConfig({ NODE_ENV: 'development' }, TMP);
    expect(config.traceDir).toBe(path.resolve(TMP, DEFAULT_TRACE_DIR));
  });
});

describe('脱敏与截断', () => {
  it('密钥类 key 与正文类 key 被替换，指标类数值原样保留', () => {
    const sanitized = sanitizeAttributes({
      apiKey: 'sk-live-abcdefghijklmnop',
      prompt: '用户的完整文档正文',
      inputTokens: 1234,
      model: 'deepseek-flash',
      ok: true,
    });

    expect(sanitized.apiKey).toBe('[redacted]');
    expect(sanitized.prompt).toBe('[omitted]');
    expect(sanitized.inputTokens).toBe(1234);
    expect(sanitized.model).toBe('deepseek-flash');
    expect(sanitized.ok).toBe(true);
    expect(JSON.stringify(sanitized)).not.toContain('sk-live');
    expect(JSON.stringify(sanitized)).not.toContain('用户的完整文档正文');
  });

  it('值级兜底：即使 key 名正常，密钥形态的值也会被替换', () => {
    expect(sanitizeAttributeValue('Bearer abcdefghijklmnop.qrstu')).toBe('[redacted]');
    expect(sanitizeAttributeValue('sk-1234567890abcdef')).toBe('[redacted]');
  });

  it('超长字符串被截断并标注原始长度', () => {
    const long = 'x'.repeat(MAX_ATTRIBUTE_VALUE_LENGTH + 50);
    const sanitized = sanitizeAttributeValue(long);
    expect(typeof sanitized).toBe('string');
    expect((sanitized as string).length).toBeLessThan(long.length);
    expect(sanitized as string).toContain(`len=${long.length}`);
  });

  it('digestText 稳定且不泄漏正文', () => {
    const a = digestText('同一段文本');
    const b = digestText('同一段文本');
    const c = digestText('另一段文本');
    expect(a).toEqual(b);
    expect(a.hash).not.toBe(c.hash);
    expect(a.length).toBe('同一段文本'.length);
    expect(a.hash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('JSONL exporter', () => {
  /** 用 SDK 生成一个真实的 ReadableSpan（不注册全局 provider，避免影响其它测试） */
  function makeFinishedSpan(attributes: Record<string, string | number | boolean>) {
    const memory = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
    const tracer = provider.getTracer('exporter-test');
    tracer.startActiveSpan('unit.span', { attributes }, (span) => {
      span.setAttribute('ok', true);
      span.end();
    });
    const finished = memory.getFinishedSpans();
    expect(finished).toHaveLength(1);
    return { provider, span: finished[0]! };
  }

  it('正常写盘：文件名按日期、每行一个 span、属性脱敏', async () => {
    const dir = path.join(TMP, 'ok-traces');
    const { provider, span } = makeFinishedSpan({
      taskId: 'task-export-1',
      apiKey: 'sk-should-not-leak-12345678',
      prompt: '不应落盘的正文',
      phase: 'map',
    });
    const warnings: string[] = [];
    const exporter = new JsonlSpanExporter({ dir, warn: (m) => warnings.push(m) });

    let code = -1;
    exporter.export([span], (result) => {
      code = result.code;
    });
    await provider.shutdown();

    expect(code).toBe(0);
    expect(warnings).toEqual([]);

    const file = path.join(dir, `${traceFileDate(new Date())}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(1);
    expect(raw).not.toContain('sk-should-not-leak');
    expect(raw).not.toContain('不应落盘的正文');

    const { spans } = parseTraceJsonl(raw);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('unit.span');
    expect(spans[0]!.attributes.taskId).toBe('task-export-1');
    expect(spans[0]!.attributes.apiKey).toBe('[redacted]');
    expect(spans[0]!.attributes.prompt).toBe('[omitted]');
    expect(spans[0]!.attributes.ok).toBe(true);

    // spanToRecord 输出稳定结构
    const record = spanToRecord(span);
    expect(record.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('目录不可写时只 warn 一次、返回失败码、不抛错', async () => {
    // 造一个「父路径是文件」的非法目录：mkdir 必然失败
    const blockedRoot = path.join(TMP, 'blocked');
    writeFileSync(blockedRoot, 'not a directory');
    const dir = path.join(blockedRoot, 'traces');

    const { provider, span } = makeFinishedSpan({ taskId: 'task-export-blocked' });
    const warnings: string[] = [];
    const exporter = new JsonlSpanExporter({ dir, warn: (m) => warnings.push(m) });

    let code = -1;
    expect(() => {
      exporter.export([span], (result) => {
        code = result.code;
      });
    }).not.toThrow();
    await provider.shutdown();

    expect(code).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('写入 trace 失败');

    // 第二次导出不再刷屏（同一实例只 warn 一次）
    exporter.export([span], () => undefined);
    expect(warnings).toHaveLength(1);
  });
});

describe('tracing 关闭时零副作用', () => {
  it('TRACE_EXPORT=none：不注册 provider、不产文件、span 调用不抛错', async () => {
    const dir = path.join(TMP, 'none-traces');
    const warnings: string[] = [];
    initTracing({
      force: true,
      env: {
        NODE_ENV: 'test',
        OBSERVABILITY_ENABLED: 'true',
        TRACE_EXPORT: 'none',
        TRACE_DIR: dir,
      },
      warn: (m) => warnings.push(m),
    });

    await expect(
      withTaskSpan('test.noop', 'task-none', {}, async () => undefined),
    ).resolves.toBeUndefined();
    await flushTracing();

    expect(existsSync(dir)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('OBSERVABILITY_ENABLED=false：即使 export=jsonl 也不产文件', async () => {
    const dir = path.join(TMP, 'disabled-traces');
    initTracing({
      force: true,
      env: {
        NODE_ENV: 'test',
        OBSERVABILITY_ENABLED: 'false',
        TRACE_EXPORT: 'jsonl',
        TRACE_DIR: dir,
      },
      warn: () => undefined,
    });

    await expect(
      withTaskSpan('test.noop', 'task-disabled', {}, async () => undefined),
    ).resolves.toBeUndefined();
    await flushTracing();

    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(TMP).filter((name) => name.endsWith('.jsonl'))).toHaveLength(0);
  });

  it('全局 exporter 写失败不影响业务代码（只 warn，不抛错）', async () => {
    const blockedRoot = path.join(TMP, 'blocked-global');
    writeFileSync(blockedRoot, 'not a directory');
    const dir = path.join(blockedRoot, 'traces');
    const warnings: string[] = [];

    initTracing({
      force: true,
      env: {
        NODE_ENV: 'test',
        OBSERVABILITY_ENABLED: 'true',
        TRACE_EXPORT: 'jsonl',
        TRACE_DIR: dir,
      },
      warn: (m) => warnings.push(m),
    });

    await expect(
      withTaskSpan('test.fail-safe', 'task-fail-safe', { model: 'deepseek-flash' }, async () => '业务结果'),
    ).resolves.toBe('业务结果');
    await flushTracing();

    expect(warnings.join('\n')).toContain('写入 trace 失败');
  });
});

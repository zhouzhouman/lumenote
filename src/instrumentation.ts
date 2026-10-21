/**
 * Next.js instrumentation 入口（Next 16 稳定支持 `src/instrumentation.ts`）。
 *
 * ## 三条硬性约束
 *
 * 1. **任何失败都不阻塞启动**：`register()` 里全部逻辑包 try/catch，
 *    只 warn。可观测性配置错误（例如 TRACE_EXPORT=otlp 但 ep 写错）
 *    不该让整个应用起不来 —— 那会把「排障工具」变成「新故障源」。
 * 2. **只跑 Node.js runtime**：tracing 依赖 fs / async_hooks，
 *    Edge runtime 里没有。用 NEXT_RUNTIME 判断并直接返回。
 * 3. **动态 import**：OTel SDK 只在 Node 侧需要。静态 import 会让
 *    bundler 在构建期尝试打包 node 专用依赖，也违背「失败不阻塞」的隔离。
 *
 * ## 配置（全部读 process.env，不碰 src/lib/env.ts）
 *
 *   OBSERVABILITY_ENABLED=true|false  缺省 development 开、production 关
 *   TRACE_EXPORT=jsonl|console|otlp|none  默认 jsonl
 *   TRACE_DIR=<系统临时目录>/lumenote-traces  JSONL 落盘目录。
 *     **默认刻意在项目目录之外**：dev 下写在项目内会触发 Next 文件 watcher，
 *     形成「刷新 → 写 trace → 热重载 → 再刷新」的死循环。只有确需持久化
 *     （容器日志卷、评测报告）时才显式指到项目内或挂载卷。
 *   OTEL_EXPORTER_OTLP_ENDPOINT       TRACE_EXPORT=otlp 时必填，缺失降级 jsonl
 *
 * ## 为什么不做成「默认开启且全量」
 *
 * 生产环境默认关是刻意的：trace 落盘会产生磁盘 IO 与用户内容（已脱敏）
 * 的本地副本，是否开启应由运维显式决定，而不是框架替他们决定。
 */

export async function register(): Promise<void> {
  // Edge runtime 不支持 OTel Node SDK；直接跳过（不 warn，避免噪音）
  const runtime = process.env.NEXT_RUNTIME;
  if (runtime && runtime !== 'nodejs') return;

  try {
    const { initTracing } = await import('@/lib/observability/tracing');
    const config = initTracing();
    if (config.enabled && config.exportMode !== 'none') {
      console.info(
        `[observability] tracing 已启用：export=${config.exportMode}` +
          (config.exportMode === 'jsonl' ? ` dir=${config.traceDir}` : ''),
      );
    }
  } catch (error) {
    // 最后一道保险：动态 import 失败 / SDK 内部异常都不能影响应用启动
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[observability] instrumentation 初始化失败，已跳过（不影响应用启动）：${message}`);
  }
}

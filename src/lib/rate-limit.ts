/**
 * 限流模块的稳定入口（facade）。
 *
 * ⚠️ 历史原因：这个文件过去是全部实现（进程内存 Map）。现在实现拆到了
 * `src/lib/rate-limit/` 目录（memory / redis 两个 store + 可信代理边界），
 * 但**公开导入路径 `@/lib/rate-limit` 保持不变** —— 调用方不需要知道
 * 审计点在哪、store 有几个实现。
 *
 * 这里刻意用显式 re-export 而不是 `export *`：显式列表是一份「公开契约」，
 * 新增内部辅助函数不会意外泄漏成公开 API，也方便一眼看出哪些函数被路由使用。
 *
 * ## 为什么本项目当年只用内存实现，而现在要支持 Redis
 *
 * 旧注释（保留其结论，仍然成立）：
 *  - 限流的第一目标是「防意外刷爆」，不是「精确限速」；单实例内存限流足够挡住
 *    爬虫式高频请求，真正的成本保护靠幂等 + 每日配额 + 并发上限（都在 DB 层，全局有效）。
 *  - 内存实现失效的方向是「放行」（fail-open），安全上可接受，但不能宣称是严格限流。
 *
 * 新增 Redis 实现解决的是「**多实例 / Serverless 下每实例各算各的**」这个既定缺陷：
 * 打开 RATE_LIMIT_DRIVER=redis 后计数全局共享。默认仍是 memory，
 * 不配置 Redis 的部署行为与以前一致。Redis 故障时的降级语义见 index.ts。
 */

export {
  rateLimit,
  rateLimitByIp,
  rateLimitByUser,
  rateLimitAuthByIp,
  purgeBuckets,
  clientIp,
  resolveClientIp,
  normalizeIp,
  UNKNOWN_CLIENT_IP,
  rateLimitSettings,
  createRateLimitStore,
  resetRateLimitRuntime,
} from './rate-limit/index';

export type {
  RateLimitResult,
  RateLimitStore,
  RateLimitCallOptions,
  RateLimitDriver,
  RateLimitFailMode,
  RateLimitCount,
  RateLimitRuntimeSettings,
  ClientIpOptions,
} from './rate-limit/index';

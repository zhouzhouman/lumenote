/**
 * 熔断器。
 *
 * 解决的是「上游已经挂了，但我们还在不停地打它」这个问题。
 * 重试只能缓解单次失败；当服务持续不可用时，重试反而会加剧拥塞
 * （每个请求都打 3 次，等于把压力放大 3 倍）。熔断器让系统在故障期间
 * **快速失败并降级**，把资源留给能成功的路径。
 *
 * 状态机：
 *
 *   CLOSED ──连续失败达阈值/ 错误率超限──> OPEN
 *     ↑                                      │
 *     │                              冷却期结束
 *   探针成功                                  ↓
 *     └──────────────────────────── HALF_OPEN
 *                                            │ 探针失败 → OPEN（冷却期加倍）
 *                                            ↓
 *                                          OPEN
 *
 * ⚠️ Serverless 的重要限制：
 * 本实现状态存在**进程内存**中，Serverless 每个实例独立，互不共享。
 * 所以它只能保护单个实例，无法做全局限流。要做全局需要 Redis。
 * 这个限制必须写进 README 而不是假装它很可靠 ——
 * 面试时被问到「你的熔断在多实例下有效吗」，答案要是「无效，我知道为什么」，
 * 而不是「有效」（那是错的）。
 */

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitState {
  state: BreakerState;
  failureCount: number;
  successCount: number;
  openedAt: number;
  halfOpenInFlight: boolean;
}

export interface BreakerConfig {
  /** 连续失败多少次后打开 */
  failureThreshold: number;
  /** 冷却时长（毫秒） */
  cooldownMs: number;
  /** 统计窗口（毫秒），用于错误率判定 */
  windowMs: number;
  /** 窗口内错误率超过此值也打开 */
  errorRateThreshold: number;
  /** 窗口内最少请求数，低于此值不启用错误率判定（避免 1 次失败就 100%） */
  minRequestsForRate: number;
}

export const DEFAULT_BREAKER: BreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  windowMs: 60_000,
  errorRateThreshold: 0.5,
  minRequestsForRate: 10,
};

interface WindowEntry {
  at: number;
  failed: boolean;
}

class CircuitBreaker {
  private state: CircuitState = {
    state: 'CLOSED',
    failureCount: 0,
    successCount: 0,
    openedAt: 0,
    halfOpenInFlight: false,
  };
  private window: WindowEntry[] = [];

  constructor(
    readonly name: string,
    private readonly cfg: BreakerConfig = DEFAULT_BREAKER,
  ) {}

  get currentState(): BreakerState {
    // 读取时顺带判断冷却期是否结束，让状态自愈而无需定时任务
    if (this.state.state === 'OPEN' && Date.now() - this.state.openedAt >= this.cfg.cooldownMs) {
      this.state.state = 'HALF_OPEN';
      this.state.halfOpenInFlight = false;
    }
    return this.state.state;
  }

  /** 请求是否可以执行。OPEN 状态下直接拒绝，快速失败 */
  canRequest(): boolean {
    const state = this.currentState;
    if (state === 'OPEN') return false;
    if (state === 'HALF_OPEN') {
      // 半开状态只放一个探针，避免故障恢复期被瞬时流量打穿
      if (this.state.halfOpenInFlight) return false;
      this.state.halfOpenInFlight = true;
      return true;
    }
    return true;
  }

  recordSuccess(): void {
    this.record(false);
    this.state.failureCount = 0;
  }

  recordFailure(): void {
    this.record(true);
    this.state.failureCount += 1;

    if (this.state.state === 'HALF_OPEN') {
      // 探针失败：回到 OPEN 且冷却期加倍，给上游更多恢复时间
      this.trip(this.cfg.cooldownMs * 2);
      return;
    }

    if (this.state.failureCount >= this.cfg.failureThreshold) {
      this.trip(this.cfg.cooldownMs);
      return;
    }

    // 错误率判定
    const stats = this.windowStats();
    if (stats.total >= this.cfg.minRequestsForRate && stats.errorRate >= this.cfg.errorRateThreshold) {
      this.trip(this.cfg.cooldownMs);
    }
  }

  recordAborted(): void {
    // 用户主动取消不算上游故障，否则会误触发熔断
    this.state.halfOpenInFlight = false;
  }

  private record(failed: boolean): void {
    const now = Date.now();
    this.window.push({ at: now, failed });
    const cutoff = now - this.cfg.windowMs;
    this.window = this.window.filter((w) => w.at >= cutoff);
    this.state.halfOpenInFlight = false;
  }

  private windowStats(): { total: number; failures: number; errorRate: number } {
    const cutoff = Date.now() - this.cfg.windowMs;
    const recent = this.window.filter((w) => w.at >= cutoff);
    const failures = recent.filter((w) => w.failed).length;
    return {
      total: recent.length,
      failures,
      errorRate: recent.length === 0 ? 0 : failures / recent.length,
    };
  }

  private trip(cooldownMs: number): void {
    this.state.state = 'OPEN';
    this.state.openedAt = Date.now();
    this.state.halfOpenInFlight = false;
    // 打开时清空窗口，避免旧数据让半开状态立刻再次触发
    this.window = [];
    console.warn(
      `[breaker:${this.name}] 已熔断，冷却 ${cooldownMs / 1000}s。` +
        '注意：Serverless 多实例下状态不共享，此保护仅对单实例有效。',
    );
  }

  /** 测试与运维用 */
  reset(): void {
    this.state = { state: 'CLOSED', failureCount: 0, successCount: 0, openedAt: 0, halfOpenInFlight: false };
    this.window = [];
  }

  snapshot() {
    return { name: this.name, state: this.currentState, ...this.windowStats() };
  }
}

const globalForBreakers = globalThis as unknown as { breakers?: Map<string, CircuitBreaker> };

/**
 * 按 **Provider + 模型** 维度各有一个熔断器。
 *
 * 为什么下标不能只是 provider 名？
 * 降级链的前两档是同一个 provider 的两个模型（flash → v4-pro）。
 * 若共用一个熔断器，主模型失败达到阈值后熔断打开，
 * 备用模型会在「发请求之前」就被判为熔断中跳过 —— 同厂商换型号这一档永远失效。
 * 加上模型名后，两个模型各自统计，才真正实现「一个型号挂了换另一个」。
 */
export function getBreaker(name: string): CircuitBreaker {
  if (!globalForBreakers.breakers) {
    globalForBreakers.breakers = new Map();
  }
  const map = globalForBreakers.breakers;
  if (!map.has(name)) {
    map.set(name, new CircuitBreaker(name));
  }
  return map.get(name)!;
}

/**
 * 列出当前已存在的熔断器 key（未创建的不会凭空出现）。
 *
 * 健康检查需要它。之前运维端点静态写死 `['deepseek', 'openai']` 去读快照，
 * 而真实 key 是 `deepseek:deepseek-flash` 这类形式 —— 结果永远读到两个
 * 初始状态快照，监控界面一片祥和，真正打开的那个熔断器完全不显示。
 * 运维端点「查不到」比「报错」危险得多，所以这里返回真实 key 集合。
 */
export function listBreakers(): string[] {
  return [...(globalForBreakers.breakers?.keys() ?? [])];
}

/** 只读读取某个熔断器；不存在时返回 null，避免为查询造出一个假快照 */
export function peekBreaker(name: string): CircuitBreaker | null {
  return globalForBreakers.breakers?.get(name) ?? null;
}
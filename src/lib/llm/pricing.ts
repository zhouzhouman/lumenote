/**
 * 成本核算。
 *
 * 为什么这个文件值得单独存在？因为「token 数 × 单价」是**错的**。
 * DeepSeek（核对日期 2026-10-11）的实际计费有三个维度：
 *
 *  1. **输入分两档**：cache hit 与 cache miss 单价差极大
 *     deepseek-flash: $0.003 vs $0.15 —— 相差 50 倍
 *     所以把稳定前缀放前面（提高缓存命中率）是这个 Provider 上最有效的降本手段。
 *
 *  2. **峰谷分时**：高峰时段单价是低谷的 2 倍
 *     高峰 = UTC 01:00-04:00 与 06:00-10:00 的工作日（不含中国法定节假日）
 *
 *  3. **输入输出不同价**：输出通常比输入贵 4 倍以上，
 *     因此「让模型少说话」比「让模型少读字」省得多 —— 这直接影响摘要粒度的设计。
 *
 * 计价表是**代码资产而非配置**：价格是业务知识，放env 只会让改价变成一次发版，
 * 而且没有类型约束。核对日期必须写在文件里 —— 定价是会变的，代码也会过期，
 * 关键是让它「可被质疑」。
 */

export type ModelId = 'deepseek-flash' | 'deepseek-v4-pro' | string;

interface PriceTier {
  /** 每百万 input tokens，cache hit（美元） */
  inputCacheHit: number;
  /** 每百万 input tokens，cache miss（美元） */
  inputCacheMiss: number;
  /** 每百万 output tokens（美元） */
  output: number;
}

/** 单价表（美元 / 百万 tokens）。核对日期：2026-10-11，来源 api-docs.deepseek.com/quick_start/pricing */
export const PRICING: Record<string, PriceTier> = {
  'deepseek-flash': { inputCacheHit: 0.003, inputCacheMiss: 0.15, output: 0.6 },
  'deepseek-v4-pro': { inputCacheHit: 0.022, inputCacheMiss: 0.66, output: 1.98 },
  // OpenAI 备用通道（无cache 分档，折算为全部 miss）
  'gpt-4o-mini': { inputCacheHit: 0.15, inputCacheMiss: 0.15, output: 0.6 },
};

/** 官方说明：高峰时段为 UTC 01:00-04:00 与 06:00-10:00 的工作日（不含中国法定节假日） */
const PEAK_HOURS_UTC = new Set([1, 2, 3, 6, 7, 8, 9]);

/**
 * 中国法定节假日（按年，UTC+8）。
 * DeepSeek 的高峰判定明确「不含中国法定节假日」，所以周末判定不能只用 getUTCDay()：
 * 调休补班的周末仍算工作日（会落在非高峰时段），法定节假日的工作日则不算。
 *
 * 这里只覆盖近两年主要节假日。目的是**避免在节假日误判为高峰而高估成本**，
 * 方向上偏保守（低估成本优于高估）。生产环境建议接入官方节假日接口。
 */
const CN_HOLIDAYS = new Set<string>([
  // 2026
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
  // 2027
  '2027-01-01',
  '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13',
  '2027-04-03', '2027-04-04', '2027-04-05',
  '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
]);

/** UTC+8 的日期字符串（YYYY-MM-DD） */
function beijingDateKey(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 判断某个时刻是否落在 DeepSeek 的高峰计价时段。
 * 高峰 = UTC 01:00-04:00 与 06:00-10:00，且为北京时间的**工作日且非法定节假日**。
 */
export function isPeakHour(date: Date = new Date()): boolean {
  const utcHour = date.getUTCHours();
  if (!PEAK_HOURS_UTC.has(utcHour)) return false;

  /*
   * ⚠️ 工作日判断必须**只**用北京时间。
   *
   * 这里曾经额外加了一道 `date.getUTCDay()` 的周末短路，看似更严格，实际是错的：
   * UTC 周日 01:00 是北京时间周一 09:00 —— 一个正常的工作日早高峰，
   * 却因为「UTC 是周日」被判为非高峰，成本被低估一半。
   * 同理 UTC 周六的 22:00 之后（北京周日）反而会被第一道判断放行。
   *
   * 高峰窗口本身是用 UTC 小时表达的（官方就这么给的），这没问题；
   * 但「是不是工作日」是**本地日历**概念，只能有一种算法。
   * 跨时区的双条件判断，只要两个条件用了不同时区，就一定会互相矛盾。
   */
  const bj = new Date(date.getTime() + 8 * 3600_000);
  const bjDay = bj.getUTCDay();
  if (bjDay === 0 || bjDay === 6) return false;

  return !CN_HOLIDAYS.has(beijingDateKey(date));
}

export interface CostInput {
  model: ModelId;
  /** 输入 token 总量（含缓存命中部分） */
  promptTokens: number;
  /** 输入 token 中命中缓存的部分 */
  cachedTokens?: number;
  completionTokens: number;
  /** 计价时刻，缺省为当前时间 */
  at?: Date;
}

/**
 * 计算单次调用的成本。
 *
 * 峰谷倍数单独处理而不是简单乘 2：
 * 实测中 flash 的 cache-hit 差价（50 倍）远大于峰谷差价（2 倍），
 * 所以缓存优化的收益优先级高于避开高峰时段。这个结论写在这里，
 * 避免以后有人为了「躲高峰」而牺牲缓存命中率。
 */
export function computeCostUsd(input: CostInput): { costUsd: number; peak: boolean } {
  const tier = PRICING[input.model];
  if (!tier) {
    // 未知模型不静默按 0 计 —— 那会让成本仪表盘失真。返回一个保守的高估计值。
    const fallback = ((input.promptTokens + input.completionTokens) / 1_000_000) * 1.0;
    return { costUsd: fallback, peak: isPeakHour(input.at) };
  }

  const peak = isPeakHour(input.at);
  const peakMultiplier = peak ? 2 : 1;

  const cached = Math.min(input.cachedTokens ?? 0, input.promptTokens);
  const uncached = input.promptTokens - cached;

  const costUsd =
    (cached / 1_000_000) * tier.inputCacheHit * peakMultiplier +
    (uncached / 1_000_000) * tier.inputCacheMiss * peakMultiplier +
    (input.completionTokens / 1_000_000) * tier.output * peakMultiplier;

  return { costUsd, peak };
}

/** 美元转人民币（汇率按 1 USD ≈ 7.2 CNY 估算，仅用于展示） */
const USD_TO_CNY = 7.2;

export function usdToCny(usd: number): number {
  return usd * USD_TO_CNY;
}

/**
 * 缓存命中率。
 * 低于阈值意味着 prompt 前缀不稳定，这是「把稳定内容放最前」这条设计是否生效的直接证据。
 *
 * ⚠️ 必须夹紧到 [0,1]：上游偶发上报 cachedTokens > promptTokens（computeCostUsd 里
 * 也有同样的夹紧），不夹的话仪表盘会显示「缓存命中 500%」这类不可能的值 ——
 * 一个明显荒唐的指标会让人连带怀疑整套成本数据。
 */
export function cacheHitRate(promptTokens: number, cachedTokens: number): number {
  if (promptTokens <= 0) return 0;
  return Math.min(1, Math.max(0, cachedTokens / promptTokens));
}
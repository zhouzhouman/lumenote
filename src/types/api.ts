/** 前后端共享的 API 响应类型 */

// ============================================================
// 通用响应封装
// ============================================================

export interface ApiError {
  error: {
    code: string;
    message: string;
    /** 字段级校验错误 */
    fields?: Record<string, string>;
  };
}

export interface ApiSuccess<T> {
  data: T;
}

export type ApiResult<T> = ApiSuccess<T> | ApiError;

export function isApiError(r: unknown): r is ApiError {
  return typeof r === 'object' && r !== null && 'error' in r;
}

// ============================================================
// 任务
// ============================================================

/**
 * ⚠️ 必须与 `lib/tasks/types.ts` 的 TaskType 保持同步。
 *
 * 两处定义同一个联合类型是历史遗留（api.ts 先存在，后来才抽出共享注册表）。
 * 加 'agent' 时如果只改了注册表，这里少一个成员**不会**让类型检查报错 ——
 * 它只是让类型更窄，于是界面里 `type === 'agent'` 的分支会被 TS 判为
 * 「不可能成立」而静默不生效。这类"类型过窄导致分支永不执行"的问题
 * 比类型错误难查得多，所以专门写注释提醒。
 */
export type TaskType = 'summarize' | 'translate' | 'write' | 'agent';
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface TaskSummary {
  id: string;
  type: TaskType;
  title: string;
  status: TaskStatus;
  /** 摘要输出的前若干字符，用于列表预览 */
  preview: string;
  charCount: number;
  degraded: boolean;
  createdAt: string;
  completedAt: string | null;
  /** Prompt 指纹：让用户知道这条结果是怎么来的 */
  promptVersion: { templateName: string; version: number; notes: string | null };
}

export interface TaskDetail extends TaskSummary {
  inputType: string;
  inputRef: string | null;
  inputContent: string | null;
  outputContent: string | null;
  inputMeta: Record<string, unknown> | null;
  outputMeta: Record<string, unknown> | null;
  params: Record<string, unknown>;
  latencyMs: number | null;
  ttftMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costCny: number;
    cacheHitRate: number;
    peak: boolean;
  } | null;
  /** 降级与重试轨迹 */
  attempts: { label: string; ok: boolean; error?: string }[];
}

/** Cursor（keyset）分页。不用 offset 的理由见 docs/architecture.md */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CreateTaskRequest {
  type: TaskType;
  title?: string;
  content: string;
  /** 用户填写的模板变量 */
  params?: Record<string, string>;
  /** 覆盖默认模型（调试用，生产可禁用） */
  model?: string;
}

// ============================================================
// SSE
// ============================================================

export interface StreamMetaEvent {
  taskId: string;
  model: string;
  promptVersion: string;
  templateName: string;
  /** 断线续传：客户端已有多少字符 */
  resumedFrom?: number;
}

export interface StreamUsageEvent {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costCny: number;
  cacheHitRate: number;
  peak: boolean;
}

export interface StreamDoneEvent {
  /** running 表示仍在进行中（订阅超时但任务未结束），客户端应重连 */
  status: TaskStatus;
  degraded: boolean;
  message?: string;
}

export interface StreamErrorEvent {
  code: string;
  message: string;
  retryable: boolean;
}

// ============================================================
// 成本
// ============================================================

export interface UsageSummaryDto {
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  cacheHitRate: number;
  totalCostCny: number;
  avgLatencyMs: number;
  p95TtftMs: number;
  byModel: {
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costCny: number;
  }[];
  /**
   * 今日配额进度。
   *
   * limit 与「真正执行配额检查的那处」必须同源（User.dailyQuota，读不到回落 env），
   * 否则用户会遇到「进度条没满却提示额度用完」。
   */
  quota: {
    limit: number;
    used: number;
    plan: string;
    /** 用户配了自己的 API Key 时不占站点配额，前端据此改变文案 */
    bypassedByUserCredential: boolean;
  };
}
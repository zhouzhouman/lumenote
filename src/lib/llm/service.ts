import { buildFallbackChain, sanitizeRequest, type UserProviderConfig } from './registry';
import { getBreaker } from './breaker';
import { withRetry, DEFAULT_RETRY } from './retry';
import { clampInput, heuristicSummary } from './budget';
import { LLMError, type LLMRequest, type LLMUsage } from './types';

/**
 * LLM 服务门面 —— 整个可靠性设计的汇合点。
 *
 * 调用方（pipeline）只跟这一个模块打交道，拿到的是「一定会给我一个结果」的流。
 * 背后的重试、熔断、降级切换、预算裁剪全部封装在这里。
 *
 * 降级链的完整轨迹（对应 pipeline 里 user 能看到的元信息）：
 *
 *   attempt 1: deepseek/deepseek-flash        → 失败（429）
 *   attempt 1 重试 ×2（全抖动退避）
 *   连续失败达阈值 → deepseek 熔断打开
 *   attempt 2: deepseek/deepseek-v4-pro       → 跳过（熔断中）
 *   attempt 3: openai/gpt-4o-mini             → 成功
 *
 * 若全部失败，调用方收到 degraded=true 的本地启发式结果而非异常。
 */

export interface StreamOutcome {
  /** 完整文本（流式结束时可用） */
  text: string;
  usage: LLMUsage;
  /** 实际生效的 Provider/模型组合 */
  usedLabel: string;
  /** 是否走了降级 */
  degraded: boolean;
  /** 降级原因说明，用于展示给用户 */
  degradedReason?: string;
  /** 重试与切换轨迹 */
  attempts: { label: string; ok: boolean; error?: string; retryable?: boolean }[];
  ttftMs?: number;
}

export interface StreamWithFallbackOptions {
  request: LLMRequest;
  signal?: AbortSignal;
  /** 每收到一个 text 增量就回调（用于 SSE 推送） */
  onText?: (delta: string, reasoningSoFar: string) => void;
  /** 每收到一段思考内容就回调（仅 thinking 模式） */
  onReasoning?: (delta: string) => void;
  /**
   * 用户自带的模型凭证（BYOK）。
   *
   * 传了它，降级链就只剩这一条 —— 用户用自己的 key 时不会被静默切回站点额度，
   * 理由见 registry.ts 里 UserProviderConfig 的注释。
   */
  userProvider?: UserProviderConfig | null;
}

/**
 * 带完整降级链的流式调用。
 */
export async function streamWithFallback(
  options: StreamWithFallbackOptions,
): Promise<StreamOutcome> {
  const { request: baseRequest, signal, onText, onReasoning, userProvider } = options;
  const attempts: StreamOutcome['attempts'] = [];

  // 按能力裁剪请求（降级到不支持某能力的模型时自动关闭该能力）
  const sanitized = sanitizeRequest(baseRequest);
  let request: LLMRequest = {
    ...baseRequest,
    jsonMode: sanitized.jsonMode,
    thinking: sanitized.thinking,
    reasoningEffort: sanitized.reasoningEffort,
  };

  const chain = buildFallbackChain(userProvider);

  for (const attempt of chain) {
    /*
     * ⚠️ 熔断器必须按 **provider + model** 而不是只按 provider 记。
     *
     * 降级链的前两项是同一个 provider 的两个模型
     * （deepseek-flash → deepseek-v4-pro）。若熔断器只认 'deepseek'，
     * 主模型连续失败打开熔断后，备用模型会在发请求前就被跳过 ——
     * 「换同厂商备用模型」这一档永远不可能生效，用户直接掉到跨厂商或本地降级。
     *
     * 这是一个「设计上写了、代码上失效」的典型：降级链看起来有四层，
     * 实际只有三层。
     */
    const breaker = getBreaker(`${attempt.provider.name}:${attempt.model}`);

    if (!breaker.canRequest()) {
      attempts.push({ label: attempt.label, ok: false, error: '熔断中，已跳过' });
      continue;
    }

    let text = '';
    let reasoningSoFar = '';
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let ttftMs: number | undefined;
    const startedAt = Date.now();
    let finished = false;

    try {
      await withRetry(
        async () => {
          /*
           * ⚠️ 每次尝试都必须**清空累积状态**。
           *
           * text / usage / finished 声明在 withRetry 之外，如果在闭包里直接累加：
           *  1. 第 2 次尝试会把第 1 次已推送的半截文本再接一遍 —— 用户看到重复内容
           *     （onText 已经把第 1 次的增量实时发给了前端，重试再发一次就是翻倍）
           *  2. usage 被 `usage = ev.usage` 覆盖，第 1 次真实消耗的 token 从账单里消失，
           *     与「即使失败也要计费」的原则直接冲突
           *
           * 这也是最容易漏掉的一处：闭包写法看起来「反正每次循环都重新声明了」，
           * 但变量的作用域其实是 for 循环体，而重试发生在 withRetry 内部。
           */
          text = '';
          reasoningSoFar = '';
          finished = false;
          usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
          ttftMs = undefined;

          const stream = attempt.provider.stream({ ...request, model: attempt.model, stream: true });

          for await (const ev of stream) {
            switch (ev.type) {
              case 'reasoning':
                reasoningSoFar += ev.delta;
                onReasoning?.(ev.delta);
                break;
              case 'text':
                if (ttftMs === undefined) ttftMs = Date.now() - startedAt;
                text += ev.delta;
                onText?.(ev.delta, reasoningSoFar);
                break;
              case 'usage':
                usage = ev.usage;
                break;
              case 'tool-call':
                // 本阶段不启用工具，收到即视为异常（避免静默丢弃）
                throw new LLMError('当前管线未启用工具调用', 'TOOLS_DISABLED', false);
              case 'done':
                finished = true;
                break;
            }
          }
        },
        {
          signal,
          cfg: DEFAULT_RETRY,
          onRetry: (info) => {
            attempts.push({
              label: attempt.label,
              ok: false,
              error: `${info.error.code} (重试第 ${info.attempt} 次)`,
              retryable: true,
            });
          },
        },
      );

      breaker.recordSuccess();

      if (!finished && !text) {
        throw new LLMError('上游未返回任何内容', 'EMPTY_RESPONSE', true);
      }

      attempts.push({ label: attempt.label, ok: true });
      return {
        text,
        usage,
        usedLabel: attempt.label,
        degraded: false,
        attempts,
        ttftMs,
      };
    } catch (e) {
      const err = e instanceof LLMError ? e : new LLMError(String(e), 'UNKNOWN', false);

      if (err.code === 'ABORTED') {
        // 用户主动取消：不算上游故障，也不降级，直接抛出让上层记录 partial
        throw err;
      }

      breaker.recordFailure();
      attempts.push({ label: attempt.label, ok: false, error: err.message });

      // 能力不同的模型，重试时也要把请求适配过去
      request = {
        ...request,
        ...sanitizeRequest({ model: attempt.model, jsonMode: request.jsonMode, thinking: request.thinking }),
      };
    }
  }

  // ---- 降级链全部失败：本地启发式 ----
  const fallback = heuristicSummary(request.prompt);

  const lastError = attempts[attempts.length - 1]?.error;

  /**
   * 用户自带凭证失败时，说明文字必须与站点通道失败区分开。
   *
   * 否则用户会以为「站点额度用完了」，而真实原因是自己的 key 有问题
   * （余额不足 / 权限不对 / 地址填错），排查方向完全反了。
   * 这里把上游错误码一起带出来，用户能自助定位。
   */
  const degradedReason = userProvider
    ? `你配置的凭证（${userProvider.provider} · ${userProvider.model}）调用失败` +
      `${lastError ? `：${lastError}` : ''}。` +
      '已切换为本地规则提取（结果未经模型处理）。请到「模型设置」检查 API Key、余额与接口地址；' +
      '为免产生意外费用，系统不会自动改用站点内置通道。'
    : '所有 AI 通道当前不可用，已切换为本地规则提取（结果未经模型处理）';

  attempts.push({
    label: 'local/heuristic',
    ok: true,
    error: userProvider ? '用户凭证调用失败' : '全部 AI 通道不可用',
  });

  return {
    text: fallback.summary,
    // 本地降级不消耗 token，但为诚实起见记 0 并标记 degraded
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    usedLabel: 'local/heuristic',
    degraded: true,
    degradedReason,
    attempts,
  };
}

/** 输入侧预算裁剪的便捷包装 */
export function applyInputBudget(request: LLMRequest): { request: LLMRequest; truncated: boolean } {
  const { text, truncated } = clampInput(request.prompt);
  return { request: truncated ? { ...request, prompt: text } : request, truncated };
}

/** 统一的对外错误分类，供 API 层映射HTTP 状态码 */
export function httpStatusForError(err: LLMError): number {
  switch (err.code) {
    case 'RATE_LIMITED':
      return 429;
    case 'UNAUTHORIZED':
      return 502; // 上游鉴权失败是我们自己的配置问题，不是用户的
    case 'INSUFFICIENT_BALANCE':
      return 503;
    case 'CONTENT_FILTER':
      return 422;
    case 'TIMEOUT':
    case 'UPSTREAM_ERROR':
    case 'NETWORK_ERROR':
      return 503;
    default:
      return 500;
  }
}
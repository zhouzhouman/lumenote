import { env } from '@/lib/env';
import type { LLMProvider, ProviderCapabilities } from './types';
import { DeepSeekProvider } from './adapters/deepseek';
import { OpenAIProvider } from './adapters/openai';
import { MockProvider } from './mock';

/**
 * 本次请求使用的模型通道配置。
 *
 * 两种来源：
 *  - **站点凭证**（user 为空）：用 env 里的 key，走完整降级链
 *  - **用户自带凭证**（user 非空，BYOK）：只用用户这一条，
 *    失败即降级到本地启发式 —— **绝不静默切回站点 key**
 *
 * 最后一条是刻意的产品与安全决策：用户配了自己的 key，却因为他的 key 余额不足
 * 而悄悄用站点额度出结果，等于让用户在不知情的情况下产生费用。
 * 宁可明确标记「降级结果」，也不做这种「为你好」的隐式切换。
 */
export interface UserProviderConfig {
  credentialId: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * Provider 路由与降级链。
 *
 * 降级顺序是刻意设计的，每一步都对应一类不同的故障：
 *
 *   deepseek + 主模型
 *     → 换同厂商备用模型   （主模型下线/限流，语义不变，最省事）
 *     → 换 openai 备用通道  （DeepSeek 整体故障，需要跨厂商兜底）
 *     → 本地启发式降级       （全部外部通道不可用，例：余额耗尽、网络不通）
 *
 * 最后一档是刻意设计的：**用户体验永不空白**。
 * 即使所有 LLM 都挂了，也要返回一个明确标注「降级结果」的本地摘要，
 * 而不是 500。区别在于：前者用户还能用、且知道结果不可信；
 * 后者用户只看到一个错误页，下次就不来了。
 */

/** 各模型的静态能力声明。用于在发请求前拦截非法组合，而不是让上游报错 */
const MODEL_CAPABILITIES: Record<string, Partial<ProviderCapabilities>> = {
  'deepseek-flash': {
    streaming: true,
    tools: true,
    jsonMode: true,
    promptCaching: true,
    thinking: true,
  },
  'deepseek-v4-pro': {
    streaming: true,
    tools: true,
    jsonMode: true,
    promptCaching: true,
    thinking: true,
  },
};

export function modelCapabilities(modelId: string): ProviderCapabilities {
  return {
    streaming: true,
    tools: true,
    jsonMode: true,
    promptCaching: false,
    thinking: false,
    ...MODEL_CAPABILITIES[modelId],
  };
}

let deepseekProvider: DeepSeekProvider | null = null;
let openaiProvider: OpenAIProvider | null = null;

/** 获取主 Provider（DeepSeek） */
export function primaryProvider(): LLMProvider {
  const e = env();

  if (e.MOCK_LLM) return new MockProvider();
  if (!e.DEEPSEEK_API_KEY) {
    throw new Error('未配置 DEEPSEEK_API_KEY，且未启用 MOCK_LLM');
  }

  if (!deepseekProvider) {
    deepseekProvider = new DeepSeekProvider(
      e.DEEPSEEK_API_KEY,
      e.DEEPSEEK_BASE_URL,
      e.DEFAULT_MODEL,
    );
  }
  return deepseekProvider;
}

/** 获取跨厂商备用 Provider（OpenAI）。未配置凭证时返回 null */
export function fallbackProvider(): LLMProvider | null {
  const e = env();
  if (e.MOCK_LLM || !e.OPENAI_API_KEY) return null;

  if (!openaiProvider) {
    openaiProvider = new OpenAIProvider(e.OPENAI_API_KEY);
  }
  return openaiProvider;
}

/**
 * 构造降级链：按顺序尝试的「模型 + Provider」组合。
 * 熔断器判定某个 Provider 不可用时，直接跳过对应项。
 */
export interface Attempt {
  provider: LLMProvider;
  model: string;
  label: string;
}

/**
 * 用户自带凭证的尝试项。
 *
 * 注意 label 用 `byok:<provider>` 而不是复用 deepseek/openai：
 * 这样任务详情里的「重试与降级轨迹」能一眼看出这次用的是用户自己的 key，
 * 而不是站点的。排查「为什么这次的账单不在站点账上」时这是唯一的线索。
 */
function userAttempt(config: UserProviderConfig): Attempt {
  const provider =
    config.provider === 'openai'
      ? new OpenAIProvider(config.apiKey, config.model)
      : new DeepSeekProvider(config.apiKey, config.baseUrl, config.model);

  return {
    // 上游 Provider 名保持真实厂商名（熔断器与健康检查按它归类），
    // 但 label 前缀 byok: 以区分凭证来源
    provider,
    model: config.model,
    label: `byok:${config.provider}/${config.model}`,
  };
}

export function buildFallbackChain(userConfig?: UserProviderConfig | null): Attempt[] {
  const e = env();

  /**
   * ⚠️ 判定顺序：**用户凭证优先于 MOCK_LLM**。
   *
   * 用户明确配了自己的 key，就不该再被 Mock 拦住 —— 否则
   * 「MOCK_LLM=true 的开发环境」里，用户填了真 key 也只会拿到模拟输出，
   * 而他完全不知道为什么。本地开发要验证真实调用时这是很实际的需求。
   */
  if (userConfig) {
    return [userAttempt(userConfig)];
  }

  if (e.MOCK_LLM) {
    return [{ provider: new MockProvider(), model: e.DEFAULT_MODEL, label: 'mock' }];
  }

  const chain: Attempt[] = [];

  chain.push({
    provider: primaryProvider(),
    model: e.DEFAULT_MODEL,
    label: `deepseek/${e.DEFAULT_MODEL}`,
  });

  if (e.FALLBACK_MODEL !== e.DEFAULT_MODEL) {
    chain.push({
      provider: primaryProvider(),
      model: e.FALLBACK_MODEL,
      label: `deepseek/${e.FALLBACK_MODEL}`,
    });
  }

  const fb = fallbackProvider();
  if (fb) {
    chain.push({ provider: fb, model: 'gpt-4o-mini', label: 'openai/gpt-4o-mini' });
  }

  return chain;
}

/**
 * 按能力裁剪请求。
 *
 * 这一层是防御性的：调用方可能组合出「JSON 模式 + 不支持的模型」这种请求，
 * 与其等上游返回 400 再重试，不如在本地就降级为纯文本模式。
 * 静默降级比报错更糟，所以这里同时把降级信息放进返回的 warnings。
 */
export function sanitizeRequest(req: {
  model: string;
  jsonMode?: boolean;
  thinking?: 'enabled' | 'disabled';
  reasoningEffort?: 'low' | 'high' | 'max';
}): { jsonMode?: boolean; thinking?: 'enabled' | 'disabled'; reasoningEffort?: 'low' | 'high' | 'max'; warnings: string[] } {
  const caps = modelCapabilities(req.model);
  const warnings: string[] = [];

  let jsonMode = req.jsonMode;
  if (jsonMode && !caps.jsonMode) {
    jsonMode = undefined;
    warnings.push(`模型 ${req.model} 不支持 JSON 模式，已降级为纯文本输出`);
  }

  let thinking = req.thinking;
  if (thinking === 'enabled' && !caps.thinking) {
    thinking = 'disabled';
    warnings.push(`模型 ${req.model} 不支持思考模式，已关闭`);
  }

  let reasoningEffort = req.reasoningEffort;
  if (reasoningEffort && thinking !== 'enabled') {
    reasoningEffort = undefined;
    warnings.push('思考模式未开启，reasoningEffort 已忽略');
  }

  return { jsonMode, thinking, reasoningEffort, warnings };
}
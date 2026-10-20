import type { LLMProvider } from '@/lib/llm/types';
import type { TextChunk } from '@/lib/pipeline/chunk';
import type { AgentToolContext, ToolName } from './tools';

/**
 * 模块职责：Agent 模块的**公共类型契约**（与实现无关）。
 *
 * ## 为什么单独抽一个类型模块
 *
 * 拆分后 `orchestrator`、`budget`、`tool-dispatch`、`output`、`evidence`、
 * `trajectory` 之间需要共享同一套数据结构。如果把这些类型留在
 * `orchestrator.ts` 里，其它模块就要反向依赖「编排器」——
 * 那会让依赖关系变成环，也让单测一个纯函数时被迫加载整个状态机。
 *
 * 抽出来后依赖是单向的：所有实现模块 → types（只 import type，无运行时代价）。
 * `loop.ts` 仍把它们原样 re-export，外部 import 路径不变。
 */

/** 状态机阶段。plan/act/observe 是循环内阶段，finalize/give_up 是终止阶段 */
export type AgentPhase = 'plan' | 'act' | 'observe' | 'finalize' | 'give_up';

export interface AgentStepRecord {
  seq: number;
  phase: AgentPhase;
  /** 本步模型产出的正文（可能为空） */
  text: string;
  /** 本步模型产出的思维链（thinking 关闭时为空） */
  reasoning: string;
  /** 本步发起的工具调用（plan 之后的 act） */
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  /** 每个工具调用的执行结果（observe） */
  toolResults: { toolCallId: string; name: string; ok: boolean; display: string; error?: string }[];
  /** 本步累计消耗 */
  inputTokens: number;
  outputTokens: number;
  cumulativeTokens: number;
  latencyMs: number;
  /** 本步的说明（给人看的） */
  note?: string;
}

export interface AgentRunResult {
  /** finalize = 模型正常给出结论；give_up = 预算耗尽但给出了部分结果 */
  status: 'succeeded' | 'gave_up' | 'failed';
  /** 模型的完整原始输出（含 JSON，供排查与审计） */
  text: string;
  /**
   * 剥掉 JSON 块后的散文，**给用户看的文本**。
   *
   * 与 `text` 的区别是职责不同：`structured` 渲染成结论卡片，
   * `displayText` 是模型的解释性说明。直接把 `text` 展示给用户
   * 会让他看到一大段机器格式。
   */
  displayText: string;
  /** 结构化结论（若能解析出来） */
  structured: AgentStructuredOutput | null;
  steps: AgentStepRecord[];
  /** 为什么收敛（succeeded 时为 'model_finalized'） */
  stopReason:
    | 'model_finalized'
    | 'max_steps'
    | 'max_tokens'
    | 'repeat_loop'
    | 'tool_quota'
    | 'error';
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  /** 最终文档分块（含抓取网页后新增的），供证据链校验使用 */
  finalChunks: TextChunk[];
  error?: string;
}

/** 收敛原因（succeeded 之外的正常终止都可能是这些之一） */
export type AgentStopReason = AgentRunResult['stopReason'];

/** 结构化的最终输出 —— 有它才能机器校验证据链 */
export interface AgentStructuredOutput {
  conclusions: {
    text: string;
    evidence: { source: string; quote: string }[];
    confidence?: string;
  }[];
  limitations?: string[];
}

/** 双预算：步数与 token 上限，可部分覆盖 */
export interface AgentBudgetOptions {
  maxSteps?: number;
  maxTokens?: number;
}

export interface RunAgentOptions {
  provider: LLMProvider;
  model: string;
  /** 用户的问题 */
  question: string;
  /** 文档的初始分块 */
  chunks: TextChunk[];
  toolContext: AgentToolContext;
  budget?: AgentBudgetOptions;
  toolQuotas?: Partial<Record<ToolName, number>>;
  thinking?: 'enabled' | 'disabled';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 每完成一步回调（用于 SSE 推送给前端） */
  onStep?: (step: AgentStepRecord) => void;
}

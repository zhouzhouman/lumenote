import { describe, it, expect } from 'vitest';
import * as loop from '@/lib/agent/loop';
import { TOOL_NAMES } from '@/lib/agent/tools';
import { CTX, ScriptedProvider } from './helpers';
import type {
  AgentBudgetLimits,
  AgentBudgetOptions,
  AgentPhase,
  AgentRunResult,
  AgentStepRecord,
  AgentStopReason,
  AgentStructuredOutput,
  BudgetExhaustedReason,
  ConvergeReason,
  DispatchToolCallsArgs,
  EvidenceCheck,
  RepeatRecord,
  RepeatVerdict,
  RunAgentOptions,
  StepRecordInput,
  ToolDispatchOutcome,
  ToolDispatchState,
  ToolResultMessage,
  TrajectoryCheck,
} from '@/lib/agent/loop';

/**
 * 公开导出兼容性测试。
 *
 * `loop.ts` 拆分成了 7 个模块，但它是**对外门面**：
 * 所有拆分前从 `@/lib/agent/loop` 导入的符号必须继续可用，
 * 否则路由、评测脚本与既有测试会在编译期或运行期直接断掉。
 *
 * 这里按「运行期符号 + 类型符号」两类逐一断言。
 * 类型符号无法在运行期检查，但写在 import type 列表里就意味着
 * `pnpm typecheck` 会验证它们存在 —— 删掉任一导出都会让本文件编译失败。
 */

/** 拆分前 loop.ts 的既有运行期导出 + 拆分后新增模块的公共 API */
const RUNTIME_EXPORTS = [
  // 状态机
  'runAgent',
  'buildAgentSystemPrompt',
  // 预算 / 重复检测
  'DEFAULT_AGENT_BUDGET',
  'REPEAT_WARN_THRESHOLD',
  'REPEAT_STOP_THRESHOLD',
  'CONVERGE_REASON_TEXT',
  'isConvergeReason',
  'resolveBudgetLimits',
  'AgentBudgetTracker',
  'RepeatCallTracker',
  'repeatWarning',
  'repeatStopMessage',
  'documentTokens',
  // 工具调度
  'canonicalizeArgs',
  'resolveToolQuotas',
  'createToolDispatchState',
  'dispatchToolCalls',
  'TOOL_LABELS',
  // 输出解析
  'parseStructuredOutput',
  'normalizeStructured',
  'extractDisplayText',
  // 证据链
  'normalizeForMatch',
  'parseChunkRef',
  'checkEvidence',
  // 轨迹
  'StepRecorder',
  'checkTrajectory',
] as const;

describe('@/lib/agent/loop 公共导出兼容性', () => {
  it('全部运行期导出存在', () => {
    for (const name of RUNTIME_EXPORTS) {
      expect(loop, `缺少导出：${name}`).toHaveProperty(name);
      expect((loop as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it('TOOL_LABELS 覆盖全部已注册工具', () => {
    expect(Object.keys(loop.TOOL_LABELS).sort()).toEqual(Object.values(TOOL_NAMES).sort());
  });

  it('类型导出可直接用于标注（编译期兼容）', () => {
    const phase: AgentPhase = 'finalize';
    const stop: AgentStopReason = 'max_steps';
    const exhausted: BudgetExhaustedReason = 'max_tokens';
    const converge: ConvergeReason = 'repeat_loop';
    const verdict: RepeatVerdict = 'warn';
    const repeat: RepeatRecord = { count: 2, verdict };
    const budgetOptions: AgentBudgetOptions = { maxSteps: 3 };
    const limits: AgentBudgetLimits = { maxSteps: 3, maxTokens: 1000 };
    const structured: AgentStructuredOutput = { conclusions: [] };
    const evidence: EvidenceCheck = {
      total: 0,
      verified: 0,
      exact: 0,
      normalized: 0,
      missing: [],
      rate: 0,
    };
    const trajectory: TrajectoryCheck = {
      hasLoop: false,
      usedTools: [],
      overSteps: false,
      overTokens: false,
      unsupportedConclusions: 0,
      totalSteps: 0,
    };
    const stepInput: StepRecordInput = {
      phase,
      text: '',
      reasoning: '',
      toolCalls: [],
      toolResults: [],
      inputTokens: 0,
      outputTokens: 0,
      cumulativeTokens: 0,
      latencyMs: 0,
    };
    const step: AgentStepRecord = { seq: 1, ...stepInput };
    const options: RunAgentOptions = {
      provider: new ScriptedProvider([]),
      model: 'm',
      question: 'q',
      chunks: [],
      toolContext: CTX,
      budget: budgetOptions,
    };
    const dispatchArgs: DispatchToolCallsArgs = {
      calls: [],
      quotas: loop.resolveToolQuotas(),
      context: CTX,
      chunks: [],
      state: loop.createToolDispatchState(new loop.RepeatCallTracker()),
    };
    const dispatchState: ToolDispatchState = dispatchArgs.state;
    const dispatchOutcome: ToolDispatchOutcome = {
      chunks: [],
      toolResults: [],
      toolMessages: [],
      hitQuota: false,
      hitRepeatStop: false,
    };
    const toolResultMessage: ToolResultMessage = { toolCallId: 'c1', toolName: 'x' };
    const runResult: AgentRunResult = {
      status: 'succeeded',
      text: '',
      displayText: '',
      structured,
      steps: [step],
      stopReason: stop,
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      finalChunks: [],
    };

    expect([
      exhausted,
      converge,
      repeat,
      limits,
      evidence,
      trajectory,
      options,
      dispatchState,
      dispatchOutcome,
      toolResultMessage,
      runResult,
    ]).toHaveLength(11);
  });
});

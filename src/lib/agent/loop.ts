/**
 * Agent 循环的公共入口（向后兼容门面）。
 *
 * ## 这个文件现在只做 re-export
 *
 * 拆分前这里是 968 行的「什么都干」模块：状态机、预算、工具调度、
 * 输出解析、证据校验、轨迹断言都挤在一起。拆分后各职责落到独立模块，
 * 本文件只保留**机器可读的职责地图**与**稳定的 import 路径**：
 * 所有 `@/lib/agent/loop` 的既有导入（`runAgent`、`checkEvidence`、
 * `parseStructuredOutput`、`DEFAULT_AGENT_BUDGET` …）继续可用。
 *
 * ## 职责对照
 *
 *   types.ts        公共类型契约（AgentStepRecord / AgentRunResult / …）
 *   orchestrator.ts 高层状态机：plan → act → observe → finalize / give_up
 *   budget.ts       双预算、停止策略、重复调用阈值与收敛文案
 *   tool-dispatch.ts 工具调度、参数 canonicalize、额度与重复记账
 *   evidence.ts     证据链校验（chunk ref 解析、归一化匹配）
 *   output.ts       结构化输出解析、归一化、displayText 剥离
 *   trajectory.ts   轨迹记录器与 checkTrajectory 断言
 *
 * 依赖方向是单向的：orchestrator / trajectory → 其余模块 → types。
 * 想找某段逻辑时按下表直达，不必再在一个大文件里滚动。
 */

export { runAgent, buildAgentSystemPrompt } from './orchestrator';
export { TOOL_LABELS } from './tools';

export type {
  AgentPhase,
  AgentStepRecord,
  AgentRunResult,
  AgentStopReason,
  AgentStructuredOutput,
  AgentBudgetOptions,
  RunAgentOptions,
} from './types';

export * from './budget';
export * from './output';
export * from './evidence';
export * from './trajectory';
export * from './tool-dispatch';

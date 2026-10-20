/**
 * 任务相关的测试辅助：创建 / 轮询 / 等终态。
 *
 * 所有请求都走**真实 HTTP 接口**（POST /api/tasks、GET /api/tasks/:id），
 * 不直接调 runner 或直接写库 —— 任务状态机、after() 异步执行、幂等快路径
 * 这些正是集成测试要验证的层，绕过去就失去意义了。
 */
import type { TaskDetail } from '@/types/api';
import type { ApiClient, ApiResponse } from './api';
import { waitFor, type WaitOptions } from './wait';

/** 摘要模板的必填变量（见 src/lib/tasks/types.ts 的 summarize.variables） */
export const SUMMARIZE_PARAMS = {
  style: '要点式',
  maxPoints: '5',
  targetReader: '普通读者',
} as const;

/** 短文档：单块（< CHUNK_SIZE_TOKENS=1200），mock 下约 1s 完成 */
export const SHORT_DOC = [
  '# 可追溯的 AI 文本工作台',
  '',
  'Lumenote 的核心主张不是「生成得更快」，而是「每一次生成都能被复现与审计」。',
  '同一条历史记录会保存当时使用的 Prompt 模板、版本号、模型参数与 Token 用量。',
  '',
  '## 三个支点',
  '',
  '第一，Prompt 版本化：模板存库并按版本递增，历史任务引用具体的版本行。',
  '第二，参数快照：影响输出的参数在创建任务时随任务落库，而不是执行时现读。',
  '第三，用量与轨迹：Token 按任务结算一次，Agent 任务还会记录每一步的工具调用。',
  '',
  '## 成本控制',
  '',
  '幂等键防止重复扣费，每日配额限制单用户总量，并发上限阻止同时烧太多钱，',
  '前缀缓存把稳定内容前置，让输入 token 按 cache hit 计价。',
  '这些防线都落在数据库或请求层，不依赖用户自觉。',
].join('\n');

/**
 * 长文档：超过 CHUNK_SIZE_TOKENS（1200），会走 Map-Reduce 多块路径。
 * 用于需要稳定观察到「任务还在 queued/running」的用例。
 */
export const LONG_DOC = Array.from({ length: 10 }, (_, i) =>
  [
    `## 第 ${i + 1} 段：可追溯性与成本控制的长文材料`,
    '',
    '这一段用于把输入撑到多个分块，从而走到并发 Map + Reduce 的路径。',
    '文本内容本身没有意义，重点是长度：分块器会按 token 预算把它切分为若干块，',
    '每一块单独摘要，最后再把多份摘要合并成最终结果。',
    '这样可以稳定观察到任务在 queued / running 状态停留一段时间，',
    '而不是在一个轮询间隔内就直接变成 succeeded。',
    '同时它也验证了长文路径下 UsageLog 仍然只结算一次（UsageLog.taskId 唯一约束）。',
  ].join('\n'),
).join('\n\n');

export interface CreateTaskResponse {
  taskId: string;
  status: string;
  replayed: boolean;
}

export interface CreateTaskOptions {
  type?: 'summarize' | 'translate' | 'write';
  content?: string;
  title?: string;
  params?: Record<string, string>;
  model?: string;
}

export interface CreatedTask {
  response: ApiResponse;
  data: CreateTaskResponse;
}

/** POST /api/tasks。调用方负责断言 HTTP 状态（失败时要打印完整响应） */
export async function createTask(
  client: ApiClient,
  overrides: CreateTaskOptions = {},
  headers: Record<string, string> = {},
): Promise<CreatedTask> {
  const body = {
    type: overrides.type ?? 'summarize',
    content: overrides.content ?? SHORT_DOC,
    params: overrides.params ?? { ...SUMMARIZE_PARAMS },
    ...(overrides.title ? { title: overrides.title } : {}),
    ...(overrides.model ? { model: overrides.model } : {}),
  };

  const response = await client.post('/api/tasks', body, { headers });
  const taskId = response.json?.data?.taskId;
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error(`创建任务失败（HTTP ${response.status}）：${response.text.slice(0, 500)}`);
  }
  return {
    response,
    data: {
      taskId,
      status: String(response.json?.data?.status ?? ''),
      replayed: response.json?.data?.replayed === true,
    },
  };
}

/** 创建任务并等待它成功，返回任务详情（最常用的组合） */
export async function runSummarizeTask(
  client: ApiClient,
  overrides: CreateTaskOptions = {},
  options: WaitOptions = {},
): Promise<TaskDetail> {
  const { data } = await createTask(client, overrides);
  return waitForTaskSucceeded(client, data.taskId, options);
}

export async function getTaskDetail(client: ApiClient, taskId: string): Promise<TaskDetail> {
  const res = await client.get(`/api/tasks/${taskId}`);
  if (res.status !== 200) {
    throw new Error(
      `GET /api/tasks/${taskId} 失败（HTTP ${res.status}）：${res.text.slice(0, 500)}`,
    );
  }
  return res.json.data as TaskDetail;
}

export const TERMINAL_STATUSES = ['succeeded', 'failed', 'canceled'] as const;

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** 轮询任务详情直到终态（succeeded/failed/canceled） */
export async function waitForTaskTerminal(
  client: ApiClient,
  taskId: string,
  options: WaitOptions = {},
): Promise<TaskDetail> {
  return waitFor(
    `任务 ${taskId} 进入终态`,
    async () => {
      const detail = await getTaskDetail(client, taskId);
      return isTerminalStatus(detail.status) ? detail : null;
    },
    { timeoutMs: 60_000, intervalMs: 100, ...options },
  );
}

/** 轮询到 succeeded，失败时抛出带 errorCode/errorMessage 的错误 */
export async function waitForTaskSucceeded(
  client: ApiClient,
  taskId: string,
  options: WaitOptions = {},
): Promise<TaskDetail> {
  const detail = await waitForTaskTerminal(client, taskId, options);
  if (detail.status !== 'succeeded') {
    throw new Error(
      `任务 ${taskId} 未成功：status=${detail.status} ` +
        `errorCode=${String(detail.errorCode)} errorMessage=${String(detail.errorMessage)}`,
    );
  }
  return detail;
}

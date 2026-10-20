import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chunkText } from '@/lib/pipeline/chunk';
import { runAgent } from '@/lib/agent/orchestrator';
import { ScriptedAgentProvider, SCRIPTED_EVIDENCE_QUOTE } from '@/lib/eval/scripted-provider';
import {
  flushTracing,
  getObservabilityConfig,
  initTracing,
  shutdownTracing,
} from '@/lib/observability/tracing';
import {
  buildSpanTree,
  formatSpanTree,
  readSpansForTask,
  summarizeTrace,
  type TraceSpanRecord,
} from '@/lib/observability/trace-reader';

/**
 * tracing 的集成测试：不 mock OTel，而是真的走 JSONL exporter 落盘，
 * 再读回来断言「同一 taskId → 同一 traceId → 父子关系正确」。
 *
 * 为什么值得用真实落盘而不是 InMemorySpanExporter：
 * 任务要求的第一交付物就是「磁盘上可按 taskId 检索的 JSONL」。
 * 只测内存 exporter 会漏掉「文件名/序列化/脱敏/append 逻辑」这一整层 ——
 * 而那一层恰恰是最容易把 traceId 写丢的地方。
 */

const TRACE_DIR = mkdtempSync(path.join(os.tmpdir(), 'lumenote-trace-test-'));
const warnings: string[] = [];

initTracing({
  force: true,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    OBSERVABILITY_ENABLED: 'true',
    TRACE_EXPORT: 'jsonl',
    TRACE_DIR,
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
  },
  warn: (message) => warnings.push(message),
});

const QUESTION = '缓存命中率为什么是最重要的成本杠杆？';
const DOCUMENT = [
  '# 前缀缓存与成本优化',
  '',
  '## 成本影响',
  '',
  '缓存命中率是 AI 应用里最重要的成本杠杆。',
  '',
  '## 机制',
  '',
  '前缀缓存按最长公共前缀匹配，命中部分可直接复用。',
].join('\n');

const TASK_ID = 'task-trace-test-0001';

afterAll(async () => {
  await shutdownTracing();
  rmSync(TRACE_DIR, { recursive: true, force: true });
});

describe('任务级 trace（JSONL 真实落盘）', () => {
  it('初始化后配置生效且无告警', () => {
    const config = getObservabilityConfig();
    expect(config?.enabled).toBe(true);
    expect(config?.exportMode).toBe('jsonl');
    expect(config?.traceDir).toBe(TRACE_DIR);
    expect(warnings).toEqual([]);
  });

  it('同一 taskId 的 span 共享 traceId，且 plan/tool/observe/finalize/evidence 父子关系正确', async () => {
    const provider = new ScriptedAgentProvider({ conclusionText: SCRIPTED_EVIDENCE_QUOTE });
    const result = await runAgent({
      provider,
      model: 'deepseek-flash',
      question: QUESTION,
      chunks: chunkText(DOCUMENT),
      toolContext: { glossary: [], loadTaskOutput: async () => null },
      budget: { maxSteps: 4, maxTokens: 20_000 },
      thinking: 'disabled',
      taskId: TASK_ID,
      promptVersionId: 'pv-test-1',
    });

    await flushTracing();

    // 先确认 Agent 真的跑通了完整链路（否则下面的 span 断言没有意义）
    expect(result.status).toBe('succeeded');
    expect(result.structured?.conclusions).toHaveLength(1);

    const read = readSpansForTask(TASK_ID, { dir: TRACE_DIR });
    const spans = read.spans;

    // 1) taskId 贯穿 + 单一 traceId
    // 结构：task.pipeline(1) + plan(2) + llm.request(2) + tool(1) + observe(1)
    //       + finalize(1) + evidence_check(1) = 9
    expect(spans.length).toBeGreaterThanOrEqual(9);
    expect(read.traceIds).toHaveLength(1);
    expect(new Set(spans.map((span) => span.attributes.taskId))).toEqual(new Set([TASK_ID]));

    // 2) 根 span
    const root = spans.find((span) => span.name === 'task.pipeline');
    expect(root).toBeDefined();
    expect(root!.parentSpanId).toBeUndefined();
    expect(root!.attributes.type).toBe('agent');
    expect(root!.attributes.model).toBe('deepseek-flash');
    expect(root!.attributes.promptVersionId).toBe('pv-test-1');

    // 3) 结构：两次 plan、两次 llm.request、一次 tool、两次 observe、finalize + evidence_check
    const byName = (name: string): TraceSpanRecord[] => spans.filter((span) => span.name === name);
    expect(byName('agent.plan')).toHaveLength(2);
    expect(byName('llm.request')).toHaveLength(2);
    expect(byName('agent.tool')).toHaveLength(1);
    // observe 只在「执行过工具的那一轮」产生；本轮之后模型直接 finalize，所以是 1
    expect(byName('agent.observe')).toHaveLength(1);
    expect(byName('agent.finalize')).toHaveLength(1);
    expect(byName('agent.evidence_check')).toHaveLength(1);

    // 4) 父子：plan 挂根，llm.request 挂对应 step 的 plan
    const plans = byName('agent.plan');
    expect(plans.every((plan) => plan.parentSpanId === root!.spanId)).toBe(true);

    const llmCalls = byName('llm.request');
    for (const llm of llmCalls) {
      expect(llm.attributes.phase).toBe('agent');
      const plan = plans.find((candidate) => candidate.attributes.step === llm.attributes.step);
      expect(plan).toBeDefined();
      expect(llm.parentSpanId).toBe(plan!.spanId);
    }

    // 5) 工具与 observe 挂根（工具执行发生在 plan span 之外）
    expect(byName('agent.tool')[0]!.parentSpanId).toBe(root!.spanId);
    expect(byName('agent.tool')[0]!.attributes.toolName).toBe('search_chunks');
    expect(byName('agent.tool')[0]!.attributes.ok).toBe(true);
    expect(byName('agent.observe').every((o) => o.parentSpanId === root!.spanId)).toBe(true);

    // 6) finalize → evidence_check 嵌套；证据链校验结果正确
    const finalize = byName('agent.finalize')[0]!;
    expect(finalize.parentSpanId).toBe(root!.spanId);
    expect(finalize.attributes.status).toBe('succeeded');

    const evidence = byName('agent.evidence_check')[0]!;
    expect(evidence.parentSpanId).toBe(finalize.spanId);
    expect(evidence.attributes.rate).toBe(1);
    expect(evidence.attributes.verified).toBe(1);
    expect(evidence.attributes.unsupported).toBe(0);

    // 7) 树能正确组装
    const tree = buildSpanTree(spans);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.span.name).toBe('task.pipeline');
    expect(tree[0]!.children.length).toBeGreaterThanOrEqual(4);

    // 8) 缩进树文本可读，且每个节点带 taskId（证明「按 taskId 检索」不是巧合）
    const treeText = formatSpanTree(spans);
    expect(treeText).toContain('task.pipeline');
    expect(treeText).toContain('agent.evidence_check');
    expect(treeText).toContain(`taskId=${TASK_ID}`);
    expect(treeText.split('\n').length).toBe(spans.length);

    // 9) 汇总信息
    const summary = summarizeTrace(spans);
    expect(summary.spanCount).toBe(spans.length);
    expect(summary.traceIds).toHaveLength(1);
    expect(summary.rootName).toBe('task.pipeline');
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('span 中不落 API Key、问题或文档正文（只落长度/哈希）', () => {
    const read = readSpansForTask(TASK_ID, { dir: TRACE_DIR });
    const serialized = JSON.stringify(read.spans);

    expect(serialized).not.toContain(QUESTION);
    expect(serialized).not.toContain('前缀缓存按最长公共前缀匹配');
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    // 正文类 key 即使被误传也应被替换为 [omitted]
    expect(serialized).not.toContain('"prompt":"');
    expect(serialized).not.toContain('"content":"');
  });
});

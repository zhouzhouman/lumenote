/**
 * Seed：写入系统内置的 Prompt 模板与首个版本，以及本地演示数据（demo 用户 / 示例文档）。
 *
 * ## 幂等设计（可重复执行）
 *
 *   - 模板按 slug 查找（内置模板 userId 为 null）
 *   - 版本按 (templateId, version) upsert
 *   - 演示用户按 email 查找：存在则更新必要字段，不存在才创建
 *   - 演示 Agent 任务按 (userId, idempotencyKey) 查找；分块与轨迹按
 *     (taskId, seq) / (taskId, seq) 唯一键 upsert
 *   - 因此 seed 可以在每次部署后安全重跑，不会产生重复数据，也不会破坏用户数据
 *
 * ⚠️ 一个必须知道的操作细节：**改了模板文案后必须重跑 `pnpm prisma:seed`**。
 * 内置模板存在数据库里（这是「Prompt 指纹可追溯」的前提 ——
 * 历史任务引用的是具体的 PromptVersion 行，改代码不会改变已发生的事实），
 * 所以只改源码不重跑 seed，线上跑的还是旧文案。
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnv } from 'dotenv';
import bcrypt from 'bcryptjs';
import { TASK_TYPES, type TaskTypeDef } from '../src/lib/tasks/types';
import { estimateTokens } from '../src/lib/llm/mock';
import { ensureBuiltinTemplates } from '../src/lib/tasks/builtin-templates';

// tsx 不会自动读 .env.local（与 Next.js 的约定一致），必须显式加载，
// 否则连接串为 undefined，pg 会退回默认用户导致 SASL 认证失败。
loadEnv({ path: ['.env.local', '.env'] });

// Prisma 7 需通过 driver adapter 建立连接
const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// 内置模板的定义已移到 src/lib/tasks/builtin-templates.ts（应用可自愈，不依赖 seed）。
// 这里只是调用它，保证 `pnpm prisma:seed` 的行为不变。

// ============================================================
// 演示数据（本地开发 / Mock 模式可直接演示）
// ============================================================

/**
 * 演示账号。
 *
 * 密码取 `Lumenote2026!` 而不是随便换个别的：`scripts/verify/*.e2e.mjs`
 * 等多个既有验收脚本都硬编码了这个账号密码，改掉会让它们全部失败。
 * 这是一个**固定的开发密码**，只在本地/演示环境使用，生产环境绝不应存在该账号。
 */
const DEMO_USER = {
  email: 'demo@lumenote.dev',
  password: 'Lumenote2026!',
  name: 'Demo',
  /** 演示要连续跑很多任务，默认 20 次不够；500 次足够一整天演示 */
  dailyQuota: 500,
  /** 与 src/lib/auth/password.ts 的 COST 一致（bcryptjs 默认 cost 10 偏弱） */
  bcryptCost: 12,
} as const;

/**
 * 示例文档：为「文档问答 Agent」准备的三段材料。
 *
 * ## 为什么写成三段而不是一整段
 *
 * Agent 的检索单位是**分块**（`chunk:N`）。演示要让人看到
 * 「结论引用了第几个分块、摘录了哪句原文」，就必须有多个可区分的分块。
 * 这里的三段对应产品的三个卖点：可追溯、证据链、成本控制。
 *
 * ## 与 `KnowledgeChunk` 的关系
 *
 * `KnowledgeChunk` 在 schema 里是**向量检索的预留位**（embedding 为 Unsupported
 * "vector(1536)"），当前代码路径并不读写它（Agent 循环在内存里对文档分块）。
 * 但表结构完整且 `taskId` 非空，所以写入方式唯一合理的选择是：
 * 挂在一条真实的 Agent 任务下，作为「这份文档当时被切成了哪几块」的持久化快照。
 * 这样等 Week 6 启用 pgvector 时，这批数据可以直接复用。
 * 不写入的替代方案是伪造一条没有 taskId 的行 —— 那会直接违反外键约束。
 */
const DEMO_DOC_CHUNKS = [
  {
    seq: 0,
    content: [
      '# Lumenote 产品说明（演示文档）',
      '',
      '## 一、定位',
      'Lumenote 是一个「可追溯的 AI 文本工作台」，提供长文摘要、翻译、润色改写与文档问答四种能力。',
      '它的核心主张不是「更快的生成」，而是「每一次生成都能被复现与审计」：',
      '同一条历史记录会保存当时使用的 Prompt 模板、版本号、模型参数与 Token 用量。',
    ].join('\n'),
  },
  {
    seq: 1,
    content: [
      '## 二、可追溯的实现',
      'PromptTemplate 与 PromptVersion 分表存储，版本永不被物理删除；任务创建时会把',
      'promptVersionId 与用户当次填写的参数一起快照进 Task，因此后续修改模板不会改变历史结果。',
      'Agent 任务还会把每一步的推理轨迹写入 AgentStep 表，包括检索词、命中的分块与工具结果。',
      '最终结论要求附带证据引用（chunk:N + 原文摘录），证据链完整率可以被确定性地校验。',
    ].join('\n'),
  },
  {
    seq: 2,
    content: [
      '## 三、成本控制',
      '成本控制有四道闸门：Idempotency-Key 加数据库唯一约束防止重复扣费；',
      '每日配额按任务数计；同一用户并发任务数设上限；Prompt 前缀缓存把稳定内容前置以压低输入单价。',
      '此外还有一条降级链：主模型失败时依次切换到备用模型、跨厂商通道，最后回落到本地启发式摘要，',
      '保证用户不会只看到一个空白错误页，同时明确标记「降级结果」。',
    ].join('\n'),
  },
] as const;

const DEMO_DOCUMENT = DEMO_DOC_CHUNKS.map((c) => c.content).join('\n\n');

const DEMO_QUESTION = 'Lumenote 如何保证 AI 输出可追溯？成本上有哪些控制手段？';

/** 演示任务的结构化结论。证据引用的原文必须**逐字**出现在对应分块里（见下方自检） */
const DEMO_STRUCTURED = {
  conclusions: [
    {
      text: '任务创建时会把 Prompt 版本与当次参数快照下来，历史结果可以完整复现。',
      evidence: [
        {
          source: 'chunk:1',
          quote: 'promptVersionId 与用户当次填写的参数一起快照进 Task',
        },
      ],
      confidence: 'high',
    },
    {
      text: 'Agent 的推理过程与证据链会落库，结论必须附带可校验的原文引用。',
      evidence: [
        {
          source: 'chunk:1',
          quote: '最终结论要求附带证据引用（chunk:N + 原文摘录）',
        },
      ],
      confidence: 'high',
    },
    {
      text: '幂等键、每日配额、并发上限与前缀缓存共同构成成本控制，失败时会走降级链而不是空白报错。',
      evidence: [
        {
          source: 'chunk:2',
          quote: 'Idempotency-Key 加数据库唯一约束防止重复扣费',
        },
        {
          source: 'chunk:2',
          quote: '主模型失败时依次切换到备用模型、跨厂商通道，最后回落到本地启发式摘要',
        },
      ],
      confidence: 'medium',
    },
  ],
  limitations: [
    '本演示任务的数据由 seed 直接写入（Mock 模式），没有调用真实模型；真实模式下由 Agent 循环现场检索生成。',
  ],
};

const DEMO_ANSWER_TEXT = [
  '## 结论',
  '',
  '1. **可追溯**：任务创建时快照 Prompt 版本与当次参数，历史结果因此可以完整复现。',
  '2. **证据链**：Agent 的推理轨迹落库，结论附带 chunk 引用与原文摘录，可确定性校验。',
  '3. **成本控制**：幂等键 + 每日配额 + 并发上限 + 前缀缓存四道闸门，失败时走降级链而非空白报错。',
  '',
  '## 证据',
  '',
  '- chunk:1 —— “promptVersionId 与用户当次填写的参数一起快照进 Task”',
  '- chunk:1 —— “最终结论要求附带证据引用（chunk:N + 原文摘录）”',
  '- chunk:2 —— “Idempotency-Key 加数据库唯一约束防止重复扣费”',
  '- chunk:2 —— “主模型失败时依次切换到备用模型、跨厂商通道，最后回落到本地启发式摘要”',
  '',
  '## 局限',
  '',
  '- 本演示数据由 seed 写入，未调用真实模型；真实模式下证据由 Agent 循环现场检索产生。',
].join('\n');

/** 演示任务的固定幂等键 —— 重复 seed 靠它定位同一条任务，而不是靠标题 */
const DEMO_TASK_KEY = 'seed:demo-docqa-v1';

/** 演示任务的推理轨迹（让历史详情页的时间线在 Mock 模式下也有内容可看） */
const DEMO_STEPS = [
  {
    seq: 1,
    phase: 'act',
    text: '先看看这份文档的结构。',
    toolCalls: [{ id: 'seed-call-list', name: 'list_sections', arguments: {} }],
    toolResults: [
      {
        toolCallId: 'seed-call-list',
        name: 'list_sections',
        ok: true,
        display: '查看文档结构：3 个分块',
      },
    ],
    inputTokens: 780,
    outputTokens: 24,
    cumulativeTokens: 804,
    latencyMs: 820,
    note: '查看文档结构（3 段）',
  },
  {
    seq: 2,
    phase: 'act',
    text: '检索「可追溯」和「成本」相关段落。',
    toolCalls: [
      { id: 'seed-call-search', name: 'search_chunks', arguments: { query: '可追溯' } },
    ],
    toolResults: [
      {
        toolCallId: 'seed-call-search',
        name: 'search_chunks',
        ok: true,
        display: '检索「可追溯」：命中 1 段（chunk:1）',
      },
    ],
    inputTokens: 640,
    outputTokens: 48,
    cumulativeTokens: 1492,
    latencyMs: 910,
    note: '检索「可追溯」：命中 1 段',
  },
  {
    seq: 3,
    phase: 'finalize',
    text: DEMO_ANSWER_TEXT,
    toolCalls: [],
    toolResults: [],
    inputTokens: 720,
    outputTokens: 210,
    cumulativeTokens: 2422,
    latencyMs: 1180,
    note: '模型给出最终结论',
  },
] as const;

/**
 * 写入/更新演示用户。
 *
 * 用 findUnique + 分支而不是 upsert：需要在「已存在」时保留 id 与 createdAt，
 * 并且要显式说明「为什么每次重跑都重算密码哈希」——
 * 用固定开发密码重新哈希是刻意的：保证任何一次 seed 之后，
 * 文档里写的演示密码一定真的能登录（改了代码常量但忘了迁移时不会静默失效）。
 */
async function upsertDemoUser() {
  const passwordHash = await bcrypt.hash(DEMO_USER.password, DEMO_USER.bcryptCost);
  if (passwordHash.length !== 60) {
    throw new Error('内部错误：bcrypt 哈希长度异常，演示账号密码将无法登录');
  }

  const existing = await prisma.user.findUnique({ where: { email: DEMO_USER.email } });
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          name: DEMO_USER.name,
          // 演示账号是本地预置的，跳过验证码；quota 调大以便连续演示
          emailVerified: true,
          dailyQuota: DEMO_USER.dailyQuota,
        },
      })
    : await prisma.user.create({
        data: {
          email: DEMO_USER.email,
          passwordHash,
          name: DEMO_USER.name,
          emailVerified: true,
          dailyQuota: DEMO_USER.dailyQuota,
        },
      });

  console.info(
    `[seed]   演示账号 ${DEMO_USER.email}（id=${user.id}，dailyQuota=${user.dailyQuota}，emailVerified=${user.emailVerified}）`,
  );
  return user;
}

/**
 * 写入/更新演示 Agent 任务、它的知识分块、推理轨迹与用量记录。
 *
 * ⚠️ 定位既有任务用 `(userId, idempotencyKey)` 唯一约束（数据库层面保证唯一），
 * 而不是按标题模糊匹配 —— 标题是可变文案，改一次就会多出一条重复任务。
 */
async function upsertDemoAgentTask(userId: string) {
  const template = await prisma.promptTemplate.findFirst({
    where: { userId: null, slug: TASK_TYPES.agent.slug },
    include: { versions: { where: { status: 'active' }, orderBy: { version: 'desc' }, take: 1 } },
  });
  if (!template || template.versions.length === 0) {
    throw new Error(`演示任务依赖模板 ${TASK_TYPES.agent.slug}，但它不存在（模板写入步骤应先执行）`);
  }
  const version = template.versions[0]!;

  const charCount = DEMO_DOCUMENT.length;
  /** 演示任务记录的模型名。单独提出来，避免从 `as never` 的 JSON 字段上取属性 */
  const demoModel = process.env.DEFAULT_MODEL ?? 'deepseek-flash';
  const taskData = {
    title: DEMO_QUESTION,
    status: 'succeeded',
    inputContent: DEMO_DOCUMENT,
    inputMeta: {
      charCount,
      tokenCount: estimateTokens(DEMO_DOCUMENT),
      sourceHost: null,
      extractedTitle: 'Lumenote 产品说明（演示文档）',
      truncated: false,
      credentialId: null,
      credentialLabel: null,
      question: DEMO_QUESTION,
      seeded: true,
    } as never,
    outputContent: DEMO_ANSWER_TEXT,
    outputMeta: {
      taskType: 'agent',
      structured: DEMO_STRUCTURED,
      stopReason: 'model_finalized',
      stepCount: DEMO_STEPS.length,
      usedTools: ['list_sections', 'search_chunks'],
      finalChunkCount: DEMO_DOC_CHUNKS.length,
      costCny: 0,
      cacheHitRate: 0,
      peak: false,
      model: demoModel,
      provider: 'mock',
      seeded: true,
    } as never,
    params: {
      question: DEMO_QUESTION,
      maxSteps: '12',
      model: demoModel,
      seeded: true,
    } as never,
    degraded: false,
    errorCode: null,
    errorMessage: null,
    // 该任务不是真实执行出来的，但保留一个可解释的耗时，避免详情页显示 0ms 像坏数据
    latencyMs: 2910,
    ttftMs: 820,
  };

  const existing = await prisma.task.findFirst({
    where: { userId, idempotencyKey: DEMO_TASK_KEY },
  });

  const task = existing
    ? await prisma.task.update({ where: { id: existing.id }, data: taskData })
    : await prisma.task.create({
        data: {
          ...taskData,
          userId,
          type: 'agent',
          inputType: 'text',
          inputRef: null,
          templateId: template.id,
          promptVersionId: version.id,
          idempotencyKey: DEMO_TASK_KEY,
          completedAt: new Date(),
        },
      });

  // 分块：@@unique([taskId, seq])，天然幂等
  for (const chunk of DEMO_DOC_CHUNKS) {
    await prisma.knowledgeChunk.upsert({
      where: { taskId_seq: { taskId: task.id, seq: chunk.seq } },
      update: { content: chunk.content },
      create: { taskId: task.id, seq: chunk.seq, content: chunk.content },
    });
  }

  // 轨迹：@@unique([taskId, seq])，同样幂等
  for (const step of DEMO_STEPS) {
    await prisma.agentStep.upsert({
      where: { taskId_seq: { taskId: task.id, seq: step.seq } },
      update: {
        phase: step.phase,
        text: step.text,
        toolCalls: step.toolCalls as never,
        toolResults: step.toolResults as never,
        inputTokens: step.inputTokens,
        outputTokens: step.outputTokens,
        cumulativeTokens: step.cumulativeTokens,
        latencyMs: step.latencyMs,
        note: step.note,
      },
      create: {
        taskId: task.id,
        seq: step.seq,
        phase: step.phase,
        text: step.text,
        toolCalls: step.toolCalls as never,
        toolResults: step.toolResults as never,
        inputTokens: step.inputTokens,
        outputTokens: step.outputTokens,
        cumulativeTokens: step.cumulativeTokens,
        latencyMs: step.latencyMs,
        note: step.note,
      },
    });
  }

  // 用量：UsageLog.taskId 唯一，保证「一个任务只结算一次」（这里成本记 0）
  await prisma.usageLog.upsert({
    where: { taskId: task.id },
    update: {
      provider: 'mock',
      model: demoModel,
      promptTokens: DEMO_STEPS.reduce((s, x) => s + x.inputTokens, 0),
      completionTokens: DEMO_STEPS.reduce((s, x) => s + x.outputTokens, 0),
      cachedTokens: 0,
      estimatedCost: 0,
      peakPricing: false,
      latencyMs: taskData.latencyMs,
      ttftMs: 820,
      success: true,
    },
    create: {
      userId,
      taskId: task.id,
      provider: 'mock',
      model: demoModel,
      promptTokens: DEMO_STEPS.reduce((s, x) => s + x.inputTokens, 0),
      completionTokens: DEMO_STEPS.reduce((s, x) => s + x.outputTokens, 0),
      cachedTokens: 0,
      estimatedCost: 0,
      peakPricing: false,
      latencyMs: taskData.latencyMs,
      ttftMs: 820,
      success: true,
      meta: { seeded: true, demo: 'docqa' } as never,
    },
  });

  console.info(`[seed]   演示 Agent 任务 ${task.id}（${existing ? '已存在，已更新' : '新建'}）`);
  return task.id;
}

/**
 * 证据链自检。
 *
 * 演示数据的价值全在「证据能对上」：如果引用摘录与分块原文有任何一个字不同，
 * 页面上就会出现一条无法核实的证据。这个检查是确定性的、零成本，
 * 所以每次 seed 都跑一遍 —— 写错文案时立刻在 seed 阶段失败，而不是等演示时尴尬。
 */
function verifyDemoEvidence(): { total: number; verified: number; rate: number } {
  // `as const` 让 DEMO_DOC_CHUNKS 的 seq 收窄成字面量联合，这里显式放宽成 number 以便按解析出的序号查
  const bySeq = new Map<number, string>(
    DEMO_DOC_CHUNKS.map((c) => [c.seq as number, String(c.content)]),
  );
  let total = 0;
  let verified = 0;
  for (const conclusion of DEMO_STRUCTURED.conclusions) {
    for (const ev of conclusion.evidence) {
      total += 1;
      const m = /chunk\s*[:：]\s*(\d+)/i.exec(ev.source);
      const content = m ? bySeq.get(Number(m[1])) : undefined;
      if (content && content.includes(ev.quote)) verified += 1;
      else console.warn(`[seed]   ⚠️ 证据无法匹配：${ev.source} / ${ev.quote.slice(0, 40)}`);
    }
  }
  return { total, verified, rate: total === 0 ? 0 : Number((verified / total).toFixed(4)) };
}

/** 打印关键表行数，便于人工确认「重跑没有制造重复数据」 */
async function printCounts() {
  const [users, templates, versions, chunks, steps] = await Promise.all([
    prisma.user.count(),
    prisma.promptTemplate.count(),
    prisma.promptVersion.count(),
    prisma.knowledgeChunk.count(),
    prisma.agentStep.count(),
  ]);
  console.info(
    `[seed] 表行数: User=${users} PromptTemplate=${templates} PromptVersion=${versions} KnowledgeChunk=${chunks} AgentStep=${steps}`,
  );
}

async function main() {
  /**
   * 生产环境告警（不是硬失败：Docker/演示部署可能确实需要在 production 下 seed）。
   * 固定密码的 demo 账号是公开凭据，真实生产库不应该存在它。
   */
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[seed] ⚠️ 正在 production 环境写入演示数据：会创建固定密码账号 demo@lumenote.dev（Lumenote2026!）。',
    );
    console.warn(
      '[seed]    真实生产部署请勿执行，或在执行后立即删除/禁用该账号（它等同于公开凭据）。',
    );
  }

  console.info('[seed] 开始写入内置模板…');

  const slugs = await ensureBuiltinTemplates(prisma);

  console.info(`[seed] 完成：共 ${slugs.length} 个模板 —— ${slugs.join(', ')}`);

  // ---------- 演示数据 ----------
  // 模板先写入：演示 Agent 任务需要引用 sys:agent.docqa 的 promptVersionId
  console.info('[seed] 写入演示账号与示例文档…');
  const demoUser = await upsertDemoUser();
  await upsertDemoAgentTask(demoUser.id);

  const evidence = verifyDemoEvidence();
  console.info(
    `[seed] 证据链自检：${evidence.verified}/${evidence.total} 条引用可在对应分块中精确匹配（rate=${evidence.rate}）`,
  );

  await printCounts();

  console.info('');
  console.info('[seed] ✓ 全部完成（可重复执行，不会产生重复数据）');
  console.info(`[seed]   演示账号: ${DEMO_USER.email} / ${DEMO_USER.password}`);
  console.info('[seed]   说明: 该密码是固定的本地开发密码，与 scripts/verify/*.e2e.mjs 保持一致');
}

main()
  .catch((e) => {
    console.error('[seed] 失败：', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


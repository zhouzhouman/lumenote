# 面试指南：Lumenote 的设计取舍

> 这份文档写给「要在 3 分钟内讲清楚这个项目」的人，也写给面试官：
> 每一节都指向真实代码与真实限制，不拿「已实现」粉饰「没验证」。
>
> 核对日期：2026-10-20。所有数字均可在仓库内用文中命令复现（见 [README](../README.md) 的验证状态表）。

---

## 0. 一句话定位

**Lumenote 是一个「可追溯」的 AI 文本工作台**：摘要 / 翻译 / 润色 / 文档问答四种能力共用同一条
「Prompt 版本快照 + 计量 + 降级」管线，每条结果都能回答三个问题 ——
**这条结果怎么生成的？可靠吗？花了多少钱？**

### 与「套个壳调用大模型」的区别

| 维度 | 常见套壳 | 本项目 |
|---|---|---|
| Prompt 管理 | 字符串写在代码里 | 模板与版本落库，任务快照 `promptVersionId`；改 Prompt 不改变历史事实 |
| 成本 | 不知道/不展示 | 输入/输出/缓存分档/峰谷分时计价，任务级 `UsageLog` 唯一结算 |
| 可靠性 | 失败即 500 | 重试（仅可重试错误）→ 熔断 → 降级链 → 本地启发式兜底，且**明确标记降级** |
| 输出可信度 | 无法验证 | Agent 结论强制 `chunk:N` + 原文摘录，证据链可确定性校验 |
| 长任务 | 单请求硬扛超时 | 两段式：POST 建任务（<200ms），`after()` 异步执行，SSE 可断线重连 |
| 安全 | 基本没有 | 越权统一入口、SSRF 四层校验、Prompt 注入护栏、幂等防重复计费、BYOK 加密 |

一句话收束：**「生成得对」靠模型，「敢让人查」靠工程。这个项目做的是后半句。**

---

## 1. 两段式异步任务 + 可恢复 SSE（最核心的设计）

### 问题

长文摘要的 Map-Reduce 可能跑几十秒到几分钟。Serverless 有单请求时长上限，一个请求撑不住；
用户切走页面 / 网络抖动就前功尽弃。

### 做法

```
POST /api/tasks              建任务（queued）→ after() 挂管线 → 立即返回 taskId
GET  /api/tasks/:id/stream   订阅：已完成回放 / 失败报错 / 进行中轮询 DB 增量推送
```

- **第一段不执行任何 LLM**：实现见 [src/app/api/tasks/route.ts](../src/app/api/tasks/route.ts)；
  实测建任务 98–157ms（Mock / standalone）。
- **第二段只消费**：见 [src/app/api/tasks/[id]/stream/route.ts](../src/app/api/tasks/[id]/stream/route.ts)。
- **SSE 协议 6 个事件**：`meta`（Prompt 指纹）/ `token`（增量）/ `step`（Agent 步骤）/
  `usage`（先结算）/ `done` / `error`，见 [src/lib/sse.ts](../src/lib/sse.ts)。
- **断线续传**：客户端重连带 `Last-Event-ID`（已收到字符数），服务端按此裁剪重放
  （`parseResumeToken`），拼接后与落库 `outputContent` 逐字一致 —— 集成测试
  [tests/integration/06-sse.test.ts](../tests/integration/06-sse.test.ts) 断言的正是这个不变量。
- **执行边界必须讲清楚**：`after()` 没有队列、没有重试、没有租约。单实例常驻下可用；
  崩溃/重启时任务会停在 `running` 且不自动恢复。完整边界见
  [docs/adr/0005-async-execution-boundary.md](adr/0005-async-execution-boundary.md)。

### 面试可讲的取舍

> 「为什么不用 WebSocket / 为什么不让 SSE 直接订阅内存流？」
> 因为执行在**另一个请求**里，Serverless 下甚至不在同一实例。数据库是分布式下唯一正确的共享状态。
> 代价是订阅期每 300ms 一次查询、以及轮询延迟；当前规模可接受。
>
> 「为什么 Mock 模式要在 SSE 里就地执行一次？」
> 只是演示兜底（`updateMany` 原子抢占 `queued → running`），**不是队列**。真实模式下绝不能这么做 —— 会重复计费。

---

## 2. LLM Provider 抽象与降级链

### 抽象有多薄

`LLMProvider` 只有 `generate / stream / isAvailable / capabilities`（[src/lib/llm/types.ts](../src/lib/llm/types.ts)）。
抽象层越薄，厂商能力变化时越容易直接改适配器，而不是被抽象层挡住。

### 降级链

```
MOCK_LLM=true → MockProvider（本地模拟流式，不联网）
否则：deepseek-flash → deepseek-v4-pro → openai（配了 key 才启用）→ 本地启发式摘要
```

- 实现在 [src/lib/llm/service.ts](../src/lib/llm/service.ts)：重试（仅 retryable）→ 熔断 →
  切换下一档 → 全失败时 `heuristicSummary` 兜底，**永不返回空白**。
- **降级一定被标记**：`degraded=true` 落库、详情页可见、SSE `done.degraded` 透出。
  不标记等于欺骗用户 —— 用户以为拿到模型输出，其实是本地拼接。
- **BYOK 用户不静默切回站点 Key**：凭证失败就标记降级并说明原因，绝不在用户不知情时花站点额度
  （[src/lib/llm/registry.ts](../src/lib/llm/registry.ts)）。
- DeepSeek 能力约束（thinking 默认开、temperature 静默失效、tool 轮次必须回传
  `reasoning_content`）是**实查官方文档**后的结论，见
  [docs/adr/0003-deepseek-capability-constraints.md](adr/0003-deepseek-capability-constraints.md)。

### 诚实边界

熔断器状态在**进程内存**（[src/lib/llm/breaker.ts](../src/lib/llm/breaker.ts)），多实例不共享。
限流已经可以做 Redis 共享（见第 5 节），但熔断的分布式化**没有做** —— 多实例下每个实例
各自撞几次失败才会各自打开熔断。

---

## 3. Agent：控制权在代码，不在模型

### 为什么不是「让模型自由循环」

自由循环的演示很好看，工程上不可控：死循环调工具、空转烧钱、预算耗尽无法中断。
本项目的状态机由**代码**驱动：

```
plan ──→ act ──→ observe ──┐
  ↑                        │
  └────────────────────────┘
  ├─→ finalize  模型给出纯文本（无工具调用）
  └─→ give_up   步数/Token 预算到顶、或检测到重复调用
```

- 状态机：[src/lib/agent/orchestrator.ts](../src/lib/agent/orchestrator.ts)
- 双预算与重复检测：[src/lib/agent/budget.ts](../src/lib/agent/budget.ts)
  （`maxSteps` 用户可选 6/12/20，`maxTokens` 兜底；相同工具+相同参数第 2 次提醒、第 3 次强制收敛）
- 工具调度与额度：[src/lib/agent/tool-dispatch.ts](../src/lib/agent/tool-dispatch.ts)
- **工具全部只读**：`list_sections / search_chunks / fetch_url / get_glossary / diff_with_task`，
  没有写权限工具 —— 这是 Prompt 注入的真正防线（[src/lib/agent/tools.ts](../src/lib/agent/tools.ts)）。
- **`give_up` ≠ `failed`**：预算到顶时交回「阶段性结论」并标 degraded，而不是让用户白等白花钱。

### 证据链：Agent 评测里最值钱的一处

`checkEvidence()`（[src/lib/agent/evidence.ts](../src/lib/agent/evidence.ts)）做的是
**确定性、零成本**的校验：结论里的 `source: chunk:N` 是否真实存在、`quote` 是否真的出现在
那个分块里（先精确子串、再归一化匹配）。「结论对不对」需要领域知识，「结论有没有依据」不需要。

seed 的演示 Agent 任务（[prisma/seed.ts](../prisma/seed.ts)）写了 3 条结论 + 4 条
`chunk:N` 证据，4/4 可在分块原文中精确命中 —— Mock 模式下也能演示证据 UI。

### 模块拆分（可讲的重构）

拆前 `loop.ts` 是 968 行的「什么都干」；拆后 [src/lib/agent/loop.ts](../src/lib/agent/loop.ts)
只剩 43 行门面（re-export），职责落到
`orchestrator / budget / tool-dispatch / evidence / output / trajectory / types`，
依赖单向。行为不变由 characterization tests 锁定（`tests/agent-loop.test.ts` + `tests/agent/**`）。

---

## 4. 幂等、配额、越权、BYOK

### 幂等：AI 应用的止损器

普通 CRUD 重复请求最多写两遍数据；LLM 重复请求**每次都真花钱**。双保险：

1. `Idempotency-Key` 请求头 + 快路径查重（命中则完全不碰 LLM）；
2. 数据库唯一约束 `Task @@unique([userId, idempotencyKey])` 兜底并发。

正确性由数据库保证，内存缓存只做性能优化 —— 搞反了在多实例下就会重复计费。
实现：[src/lib/idempotency.ts](../src/lib/idempotency.ts)、[prisma/schema.prisma](../prisma/schema.prisma)。

### 成本三道闸

- 每日配额（按任务数，不用 token 数：用户理解「20 次/天」）
- 并发上限（同一用户同时 1 个进行中任务；BYOK 同样受限，保护的是用户自己的钱包）
- 峰值计价 + 缓存分档（[src/lib/llm/pricing.ts](../src/lib/llm/pricing.ts)）

**已知竞态**：配额是「先查后写」，并发提交理论上可绕过，靠并发上限与限流把窗口压小。
彻底修法是把「检查 + 插入」放进 `Serializable` 事务或用户级咨询锁 —— 未做。

### 越权：让「忘记带 userId」变得困难

统一 `authzTask / authzShareLink / authzTemplate / authzGlossaryTerm`
（[src/lib/auth/authz.ts](../src/lib/auth/authz.ts)），一律 `findFirst({ where: { id, userId } })`，
查不到返回 **404 而非 403**（不泄漏资源是否存在）。
集成测试 [tests/integration/03-authz.test.ts](../tests/integration/03-authz.test.ts)
覆盖「B 读/删/订阅/diff/追问 A 的任务全部失败」。

### BYOK：用户自带 Key

- AES-256-GCM 加密落库（密钥由 `AUTH_SECRET` 经 scrypt 派生），接口只回掩码，密文不出服务端；
- 任务只记 `credentialId`，绝不把密钥写进任务参数/日志；
- 失败不静默切站点 Key（见第 2 节）；
- 更换 `AUTH_SECRET` 会导致已存密钥全部无法解密 —— 这是加密存储的必然代价，界面上有失败记录。

---

## 5. 限流：memory / redis 双驱动与多实例边界

- 抽象 `RateLimitStore`，默认 `memory`，多实例可切 `redis`
  （[src/lib/rate-limit/index.ts](../src/lib/rate-limit/index.ts)、
  [redis-store.ts](../src/lib/rate-limit/redis-store.ts)）。
- Redis 侧用 **Lua 原子 INCR + PEXPIRE**，避免「先读后写」竞态；
  验证脚本 [scripts/verify/rate-limit-redis.mjs](../scripts/verify/rate-limit-redis.mjs)
  （`pnpm test:redis`，Redis 不可用时打印 SKIPPED 并以**退出码 2** 结束 —— 没验证 ≠ 通过）。
- **故障策略可选**：`RATE_LIMIT_FAIL_MODE=open` 回退内存（可用性优先）、
  `closed` 直接 429（安全优先）。两种都不把异常冒到业务层。
- **信任边界 `TRUST_PROXY_HOPS`**：默认 0，完全不信任 `X-Forwarded-For`；
  部署在反向代理后**必须按实际层数配置**，否则所有客户端共享 `unknown` 限流桶
  （表现：别人请求多了你也 429）。设 >0 的前提是应用端口只对可信代理开放。

### 诚实的多实例结论

限流可以共享了，**熔断器仍是进程内存**；「分布式限流 + 本地熔断」是当前真实状态，
不要把它讲成完整的分布式可靠性方案。

---

## 6. 评测与可观测性（Mock 报告的定位）

- 评测框架：数据集 / 用例 / 运行 / 结果 / judge 校准表（`EvalDataset` … `JudgeCalibration`），
  规则断言（contains/regex/json/证据链/工具使用/死循环/步数）+ 可选 LLM judge。
- 报告由 `MOCK_LLM=true pnpm eval:report` 生成 → [docs/eval-report.md](eval-report.md)。
  **它是 Mock 模式**：MockProvider 输出固定占位文本，规则断言失败是预期的
  （恰恰证明断言有区分力）。报告里的通过率 / 延迟 / 成本**不代表真实模型质量**。
- judge 未运行、人工校准未做 —— 所以没有「通过率 87%」这种数字可讲，只有机制。
- 失败样本回归集 8/8 检出 + 2/2 对照组通过，证明断言能区分好坏输出。
- 可观测性：任务级 OTel trace，`taskId` 贯穿 `task.pipeline / llm.request / agent.*`，
  默认 JSONL 落盘 `.lumenote-data/traces/`（gitignore），`TRACE_EXPORT=otlp` 需自备 Collector。
  属性脱敏（不落 prompt/正文/Key，只留长度与哈希）见
  [src/lib/observability/sanitize.ts](../src/lib/observability/sanitize.ts)。
  **OTLP 端到端未验证**（环境无 Collector）。

---

## 7. 已知限制与「如果重做会改什么」

### 当前真实限制（不要藏着）

1. **`after()` 不是队列**：进程崩溃留下永久 `running`，无 reaper / 租约 / 重投。
2. **执行中不落增量输出**：崩溃后已生成内容丢失（ADR-0005 已列为实现缺口）。
3. **熔断器进程内存**，多实例不共享。
4. **配额先查后写**有竞态窗口。
5. **CSP 是 Report-Only**，`script-src` 含 `unsafe-inline`、无 nonce；HSTS 仅生产；
   `proxy.ts` 只做乐观 cookie 检查、**不是安全边界**。
6. **MockProvider 不支持 tools**：`MOCK_LLM=true` 时新建 Agent 任务只有 1 步 finalize、
   `structured=null`、证据 rate=0；证据演示请用 seed 的演示任务。
7. **Docker / Redis / 真实模型 / GitHub Actions 均未在本环境实际运行**：
   - Docker 未安装 → `docker build` / `docker compose` / `docker run` 全部未运行，
     只有 standalone 产物 `node server.js` 实测（20/20 断言）与 PyYAML 静态校验；
   - Redis 未安装 → 真实限流未连过，只有 fake-client 单测；CI 的 `rate-limit-redis` job 从未在 GitHub 跑过；
   - 真实模型评测未运行、零费用；judge 未校准；
   - 仓库没有 remote，CI workflow 只用 actionlint + PyYAML 校验过 YAML。
8. **覆盖率门槛当前不达标**：实测 branches 82.81% < `vitest.config.ts` 阈值 83%，
   `pnpm test:coverage` 以退出码 1 结束（statements/lines 40.67、functions 72.22）。
   这是**真实红灯**，不是"接近通过"。

### 如果重做，会优先改什么

1. **把 `after()` 换成外部队列**（Trigger.dev / QStash / Redis 队列）：租约 + 心跳 + 重试 + 死信，
   接口边界已经在 ADR-0005 列好，状态枚举与幂等键可直接复用。
2. **增量落库**：长任务按分块写 `outputContent` 快照，让崩溃后重连能看到部分结果。
3. **取消 API**：把 `AbortSignal` 真正接进管线（现在 `canceled` 状态不可达）。
4. **配额用 Serializable 事务**或用户级 advisory lock。
5. **CSP 切 Enforce + nonce**（前提：接受根 layout 动态化、放弃静态页 CDN 缓存）。
6. **分布式熔断**（Redis 共享失败计数）。
7. **judge 人工校准闭环**：先证明 judge 可信，再谈模型输出质量。

---

## 8. 面试官可能追问的 10 个问题

> 回答都指向真实文件；不确定的部分明确说「没验证」，不编。

**Q1：为什么拆成两个请求？直接流式返回不行吗？**
Serverless 单请求有执行时长上限，长文 Map-Reduce 撑不住；更重要的是断线可重连 ——
内容与状态都在 DB，重连按 `Last-Event-ID` 裁剪重放。见
[src/app/api/tasks/route.ts](../src/app/api/tasks/route.ts) 与
[docs/adr/0001-two-stage-streaming.md](adr/0001-two-stage-streaming.md)。
代价：订阅期轮询 DB、非终态不落增量（ADR-0005 已承认）。

**Q2：`after()` 挂了怎么办？**
明确说：没有恢复。它没有队列/重试/租约；崩溃会留下 `running` 脏任务。
Mock 模式的 SSE 就地执行只是演示兜底。生产迁移外部队列的接口边界见 ADR-0005。

**Q3：幂等怎么做的？并发下会不会重复扣费？**
请求头 `Idempotency-Key` + `Task @@unique([userId, idempotencyKey])`。快路径先查，
并发时唯一约束兜底（P2002 后回查）。`UsageLog.taskId @unique` 做「一个任务只结算一次」的最终防线。
见 [src/lib/idempotency.ts](../src/lib/idempotency.ts)。局限：只能防「同一 key」，
客户端每次点生成都新 key，所以还要靠并发上限防开 5 个标签页。

**Q4：降级链怎么避免「静默用便宜模型糊弄用户」？**
每一次降级都落 `degraded=true`，详情页与 SSE 都透出；BYOK 用户失败时绝不切回站点 Key。
见 [src/lib/llm/service.ts](../src/lib/llm/service.ts)。

**Q5：Agent 为什么不会死循环烧钱？**
双层：代码硬限（步数/Token/单工具额度/相同参数重复检测，第 3 次强制收敛）+ System prompt
软提示（预算写进 prompt 让模型主动收敛）。到顶时 `give_up` 交阶段性结论而不是报错。
见 [src/lib/agent/budget.ts](../src/lib/agent/budget.ts) 与
[src/lib/agent/orchestrator.ts](../src/lib/agent/orchestrator.ts)。

**Q6：怎么证明 Agent 的结论不是编的？**
`checkEvidence()` 校验每个 `chunk:N` 存在且 `quote` 确在原文中（精确/归一化两档），
这是确定性、零成本的。但它只能证明「引文真实」，不能证明「结论正确」—— 后者需要领域知识或 judge 校准，
而 judge 本轮未校准，所以不下结论。见 [src/lib/agent/evidence.ts](../src/lib/agent/evidence.ts)。

**Q7：Why Redis 限流？为什么默认不开启？**
默认 memory 是因为单实例/本地够用、零额外故障点；多实例下进程内存等于每实例各限一遍，
所以要能切 Redis（Lua 原子计数）。默认不开是「不为不存在的多实例付出运维成本」。
TRUST_PROXY_HOPS 必须配合部署形态配置，否则共享 `unknown` 桶。见
[src/lib/rate-limit/index.ts](../src/lib/rate-limit/index.ts)。

**Q8：越权怎么防的？为什么返回 404 不是 403？**
统一 `authz*` 入口 + `findFirst` 带 `userId`，从 SQL 层过滤；404 不泄漏资源是否存在。
代码审查规则禁止裸 `findUnique({ where: { id } })`。见 [src/lib/auth/authz.ts](../src/lib/auth/authz.ts)。

**Q9：成本怎么算的？能对上账单吗？**
三个维度：缓存分档（hit 是 miss 的 1/50）、峰谷分时（2 倍）、输入输出不同价（输出约 4 倍）。
未知模型不能按 0 计（否则仪表盘显示几乎免费，是最危险的失败模式）。
Mock 报告里的成本是估算、不是账单；真实账单要等真实模型跑过才能对。见
[src/lib/llm/pricing.ts](../src/lib/llm/pricing.ts)。

**Q10：这个项目哪里还没做完？**
按诚实优先级回答：外部队列/增量落库/取消 API、CSP 未 enforce、熔断未分布式、
配额竞态、Docker/Redis/真实模型/CI 全部未在本环境实际运行、覆盖率 branches 当前低于阈值。
「没跑过的验证不写进简历，只写进已知限制」—— 这本身就是这个项目想表达的工程态度。

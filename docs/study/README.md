# Lumenote 源码学习手册

这套资料的唯一目标：**读完能读懂代码、能改 bug、能被追问底层时答得出来**。
所以每一节都按同一个结构写：

```
它解决什么问题 → 数据怎么流动 → 代码在哪（file:line）→ 为什么这样设计 → 坑在哪 → 面试怎么答
```

不讲"什么是 JWT"这种通用知识，只讲**这个项目里**怎么用的、为什么这么选。

---

## 一、先选一条路径

| 你现在的目的 | 读什么 | 时间 |
|---|---|---|
| **明天要面试** | 本文件 + `08-interview-bank.md` + `01` 的流程图 | 2 小时 |
| **接手要改 bug** | `09-bug-handbook.md` + 对应模块章节 | 3~4 小时 |
| **系统学一遍** | 按 01→07 顺序，每章做完"动手练习" | 3 天（每天 4h） |
| **只看最核心的** | `01`（请求链路）+ `02`（LLM 可靠性）+ `04`（安全） | 半天 |

---

## 二、全局地图

```
┌──────────────────────────── 浏览器 ────────────────────────────┐
│  /workspace 提交表单     /history 看结果     /batches 批量     │
└───────────┬──────────────────┬──────────────────┬──────────────┘
            │ POST /api/tasks  │ GET .../stream   │ POST /api/batches
            ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  proxy.ts：只做"有没有 cookie"的乐观检查（不验签、不查库）        │
├─────────────────────────────────────────────────────────────────┤
│  API 层（23 个 route）                                           │
│   鉴权 requireUserId → 限流 → Zod 校验 → 幂等 → 并发上限 → 配额   │
│   ↓ 只落库（status=queued），**不调模型**                        │
│   after(() => runSummarizePipeline(taskId))  ← 真正的执行体      │
├─────────────────────────────────────────────────────────────────┤
│  管线 pipeline/                                                  │
│   取任务 → 置 running → 分块 → Map(并发3) → Reduce → 落库/计量    │
├─────────────────────────────────────────────────────────────────┤
│  LLM 层 llm/                                                     │
│   buildFallbackChain → 熔断检查 → withRetry(3次) → adapter       │
│   全挂 → heuristicSummary（本地降级，标 degraded）                │
├─────────────────────────────────────────────────────────────────┤
│  横切：guardrail 输入包裹/输出脱敏 · metering 计费 · audit 留痕    │
└─────────────────────────────────────────────────────────────────┘
            │                                    │
            ▼                                    ▼
        PostgreSQL                            Redis（可选）
     19 张表 / 8 条迁移                    多实例共享限流
```

**记住这句话就能解释整个架构**：
> 提交是"异步两段式"——API 只落库并立刻返回，执行挂在 `after()`；
> 前端靠 SSE **轮询数据库**拿结果，不是服务端推送 token。

---

## 三、术语表（面试时别说错）

| 词 | 在本项目里的准确含义 |
|---|---|
| **降级（degraded）** | 模型全链失败后**用本地规则**生成摘要，任务仍算 succeeded，但 `degraded=true` |
| **熔断（breaker）** | 上游连续失败后**跳过**该模型一段时间，粒度是 `provider:model` |
| **链（chain）** | 一串候选 `provider+model`，按顺序尝试；BYOK 时只有一条 |
| **幂等键** | 客户端传的 `Idempotency-Key`，落库成唯一约束，重复提交返回同一 taskId |
| **配额 vs 限流 vs 锁定** | 配额=今天用了多少次（DB）；限流=每秒多少次（内存/Redis）；锁定=密码错太多次（DB） |
| **skipped** | 批次条目"没跑"（预算/取消），**不是失败**，因为没花钱 |
| **trajectory / AgentStep** | Agent 每一步的计划与工具结果，逐步落库 |
| **证据校验 rate** | 结论里的 quote 能在原文分块中匹配上的比例（精确优先、归一化兜底） |

---

## 四、数值速查表（面试最爱问"阈值多少"）

| 项 | 值 | 出处 |
|---|---|---|
| access token TTL | 15 分钟 | `env.ts` `JWT_ACCESS_TTL_MINUTES` |
| refresh token TTL | 7 天 | `JWT_REFRESH_TTL_DAYS` |
| bcrypt cost | 12（约 250ms） | `auth/password.ts:15` |
| 登录失败锁定 | 同一账号 5 次 / 15 分钟；同 IP 15 次 | `auth/security.ts:146` |
| 注册限流 | 5 次 / 5 分钟 / IP | `rate-limit/index.ts:228` |
| 建任务限流 | 20 次 / 60 秒 / 用户 | `rate-limit/index.ts:218` |
| 并发任务上限 | 1（只数近 10 分钟的 queued/running） | `idempotency.ts:106` |
| 每日配额 | 20（`User.dailyQuota` 可覆盖） | `env.ts:64` |
| 单次输入上限 | 100,000 字符（**拒绝**，不截断） | `env.ts:121` |
| 分块 | 1200 token / 重叠 100 / 并发 3 | `env.ts:224-226` |
| Map 合并预算 | 4000 token，80% 给分块 | `pipeline/runner.ts:173` |
| 重试 | 3 次，`random(0, min(8000, 500·2ⁿ))` | `llm/retry.ts:23-32` |
| 熔断 | 连续 5 次失败或错误率 50%（≥10 次）→ 开 30s | `llm/breaker.ts:51-57` |
| 摘要采样 | temperature 0.3 / maxTokens 1200 | `tasks/types.ts` |
| SSE 心跳 / 轮询 | 15s / 300ms | `sse.ts:107`、`stream/route.ts:170` |
| SSE 单连接上限 | 10 分钟（到时 done{status:running}，客户端重连） | `stream/route.ts:35` |
| URL 抓取 | 15s 超时 / 5MB / 最多 3 跳 / 仅 80,443 | `safe-fetch.ts` |
| Agent 最大步数 | 12（可选 6/12/20，硬夹 30） | `agent/runner.ts:362` |
| Agent token 预算 | 60,000 | `agent/budget.ts:28-33` |

---

## 五、源码阅读顺序（别从 main 开始读）

依赖关系是从下往上，按这个顺序读不会"跳来跳去"：

1. `prisma/schema.prisma` —— 先看表，知道数据长什么样
2. `src/lib/env.ts` —— 所有阈值集中在这里，读完就有"参数感"
3. `src/lib/tasks/types.ts` —— 三种任务类型的注册表（slug/变量/采样参数）
4. `src/lib/llm/types.ts` → `service.ts` → `retry.ts`/`breaker.ts` —— 可靠性主干
5. `src/lib/pipeline/runner.ts` —— 管线主干（先看 `runSummarizePipelineCore`）
6. `src/lib/pipeline/chunk.ts` + `map-reduce.ts` —— 分块与并发
7. `src/app/api/tasks/route.ts` —— 入口，看它如何只落库
8. `src/lib/auth/*` —— 鉴权
9. `src/lib/batch/*` + `src/lib/audit/*` —— 后加的两块业务
10. `src/lib/agent/*` —— 最复杂，最后看

---

## 六、各章导读

| 文件 | 讲什么 | 读完你应该能回答 |
|---|---|---|
| `01-request-lifecycle.md` | 一次提交从点击到看到结果 | "POST 之后到出结果之间发生了什么" |
| `02-llm-reliability.md` | 调用层：重试/熔断/降级/计费 | "模型挂了怎么办""钱怎么算的" |
| `03-pipeline.md` | 分块/Map-Reduce/Prompt/引用 | "长文怎么处理""为什么这么分块" |
| `04-auth-security.md` | 认证/限流/幂等/配额/SSRF | "怎么防越权""刷新怎么轮换" |
| `05-batch-audit.md` | 批次与审计 | "预算怎么控""审计怎么不可篡改" |
| `06-agent.md` | Agent 循环与工具 | "为什么不用一个函数搞定""工具怎么防滥用" |
| `07-testing-deploy.md` | 测试/CI/Docker | "怎么保证质量""镜像怎么分层" |
| `08-interview-bank.md` | 60 道题 + 追问链 | 直接背 |
| `09-bug-handbook.md` | 排查手册 + 真实 bug 复盘 | "线上 500 你怎么定位" |

---

## 七、边读边验证（别只看）

```bash
cd lumenote

# 1) 看清全部阈值（读完 env.ts 立刻核对）
grep -nE "intFromEnv|default\(" src/lib/env.ts | head -40

# 2) 看一次真实调用链（把断点式的 grep 串起来）
grep -n "streamWithFallback\|buildFallbackChain\|recordUsage" -r src/lib | head

# 3) 跑单测，看断言即文档
node scripts/test.mjs tests/retry.test.ts tests/pricing.test.ts

# 4) 跑集成测试（要真库；会自己 migrate + seed + 起 next dev）
pnpm test:integration
```

**核心心法**：这个项目的注释密度极高，而且注释里写的是**踩过的坑**（"早先写成 X，导致 Y"）。
读代码时先读注释里的"为什么"，再读实现——这是最快理解设计意图的方式，也是面试时能讲出深度的原因。

---

## 八、一句话记住每个模块的"存在理由"

| 模块 | 一句话 |
|---|---|
| `env.ts` | 所有魔法数字的唯一来源，改参数不用找代码 |
| `llm/service.ts` | 让"一定会给用户一个结果"成为契约 |
| `llm/breaker.ts` | 上游病了就别再打它，省下 3 倍重试压力 |
| `pipeline/chunk.ts` | 长文切成模型吃得下的块，且切口不切断语义 |
| `pipeline/map-reduce.ts` | 先局部总结再全局合并，成本随长度线性而非平方 |
| `tasks/create.ts` | 单篇与批次共用的唯一创建路径（防两套逻辑漂移） |
| `auth/authz.ts` | 越权防护的最后一道：查询层就带 userId |
| `idempotency.ts` | 重复提交只花一次钱，靠数据库唯一索引 |
| `rate-limit` | 挡脚本，内存降级是刻意的取舍 |
| `batch/guard.ts` | 花到上限就停，且区分"没跑"与"失败" |
| `audit/log.ts` | 出事时能说清"谁做了什么"，且改不了 |
| `agent/loop.ts` | 多轮工具调用的循环，控制权在代码不在模型 |

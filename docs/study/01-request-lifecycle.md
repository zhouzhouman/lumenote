# 01 · 一次提交的完整生命周期

> 目标：闭着眼能讲出"我点了提交，到看到摘要之间发生了什么"。

---

## 1. 一句话版本

**两次请求**：第一次 `POST /api/tasks` 只落库并立刻返回（<200ms，不碰模型），
第二次 `GET /api/tasks/[id]/stream` 订阅结果。真正的执行发生在 `after()` 里。

```ts
// src/app/api/tasks/route.ts:146-156
after(() => runSummarizePipeline({ taskId: task.id }));   // 不阻塞响应
return ok({ taskId: task.id, status: 'queued', replayed: false });
```

> 面试点：为什么不直接 await？
> 因为一次摘要可能几十秒（长文分块更多），HTTP 连接撑不住、用户关页面就断。
> `after()` 让响应与执行解耦。代价是**它不是队列**——进程重启就丢，见第 6 节。

---

## 2. 创建段：17 步，每步都有理由

| # | 步骤 | 位置 | 关键判断 / 数值 |
|---|---|---|---|
| 1 | 强制 Node runtime | `tasks/route.ts:27` | Prisma / SSE / `after()` 在 Edge 行为不一致 |
| 2 | 鉴权 | `authz.ts:40` | 无 cookie 或验签失败 → 401 |
| 3 | 限流 | `rate-limit/index.ts:218` | `task:create` = **20 次/60s** |
| 4 | Zod 校验 | `tasks/route.ts:58-85` | `content` ≥10 字符；url 模式必须 `^https?://` |
| 5 | 幂等键清洗 | `idempotency.ts:69-79` | 截断 64、只留 `A-Za-z0-9._:-`；清洗成空 → 随机 UUID |
| 6 | 幂等命中快路径 | `tasks/route.ts:114-129` | 命中直接返回 `replayed:true`，**完全不碰模型** |
| 7 | 取凭证 | `tasks/route.ts:178` | **放在配额之前**：BYOK 不占站点额度 |
| 8 | 并发上限 | `idempotency.ts:97-111` | 只数近 **10 分钟**的 `queued/running`，上限 1 |
| 9 | 日配额 | `tasks/route.ts:194-218` | 仅站点通道；`User.dailyQuota ?? 20` |
| 10 | 定模型 | `tasks/route.ts:227-231` | BYOK 用凭证模型；站点通道**生产禁止用户指定** |
| 11 | 正文提取 | `tasks/create.ts:150` → `extract/text.ts` | URL 走 SSRF 防护抓取；失败 422 |
| 12 | 模板解析 | `create.ts:50-96` | slug 由 type 决定；缺失时**自愈写入**内置模板 |
| 13 | 术语表快照 | `create.ts:160` | 仅翻译；最多 60 条；写进 `Task.params.glossary` |
| 14 | 落库 queued | `create.ts:170-201` | 同时写 `inputMeta.tokenCount` 与 `params.model` |
| 15 | 唯一键兜底 | `create.ts:202-209` | 并发双写撞 P2002 → 回查返回已存在那条 |
| 16 | 异步执行 | `tasks/route.ts:146` | `after(...)` |
| 17 | 响应 | `tasks/route.ts:156` | `{ taskId, status:'queued', replayed }` |

**为什么 7 要在 9 之前？** 顺序写反会出现"用户填了自己的 key，却被站点额度拦住"。

---

## 3. 执行段：管线三层

```
runSummarizePipeline(taskId)                 runner.ts:141
 └─ withTaskSpan('task.pipeline')            埋点，可观测
    └─ runSummarizePipelineCore
       ├─ prepareSummarizeTask(taskId)       lifecycle.ts:110
       │    取任务+模板+版本 → 空输入检查 → 置 running
       │    → 凭证解析 → 变量校验 → **渲染 system prompt（只渲染一次）**
       │    → 分块（按 taskType.supportsChunking）
       └─ chunks.length === 1 ? 单次调用 : Map(并发3) → Reduce
```

**两段失败语义**（这是设计得最细的一处）：

| 阶段 | 失败后果 | 代码 |
|---|---|---|
| `prepare` 阶段（还没开始跑） | lifecycle 自己落 `failed`，**不进 runner 的 catch** | `lifecycle.ts:74-108` |
| 执行阶段（已经开始跑） | 补记 partial usage（`taskId:null`）→ `failTask` → `touchCredential(ok:false)` | `runner.ts:294-328` |

为什么区分？因为"没开始跑"和"跑到一半失败"的**计费与错误码**完全不同：
后者已经花了钱，必须留下用量记录。

---

## 4. 状态机（面试高频）

```
POST → queued ──prepare──▶ running ──persistResult──▶ succeeded
                 │              │
                 │              ├──failTask──────────▶ failed
                 │              └──signal.aborted────▶ canceled
                 └──prepare 失败──▶ failed
```

| 迁移 | 触发点 |
|---|---|
| `∅ → queued` | `create.ts:174` |
| `queued → running` | `lifecycle.ts:124` |
| `queued → running`（原子抢占） | 仅 `MOCK_LLM`，`stream/route.ts:116` |
| `running → succeeded` | `persistence.ts:36`（含输出脱敏） |
| `running → failed` | `runner.ts:317` |
| `running → canceled` | 仅 `err.code === 'ABORTED'`，`runner.ts:225` |

**为什么 `status` 是 String 而不是 Postgres enum？**
schema 注释写了：迁移 enum 值需要 `ALTER TYPE`，在 8 条迁移的开发节奏里太重；
代价是**合法性只由应用代码保证**，DB 不会拒绝写进 `'done'` 这种错值。

**为什么单任务的 `canceled` 实际不可达？**
`cancelTask` 只由 `signal.aborted` 触发，而 `after()` 调用时**没传 signal**（`route.ts:146`）。
所以单篇任务没有"用户取消"接口——只有批次有 `/api/batches/[id]/cancel`。
面试可以说成"协议里保留了 canceled，入口未接"。

---

## 5. SSE：这里有个反直觉的真相

### 事件协议（6 种）

| 事件 | 载荷 | 说明 |
|---|---|---|
| `meta` | taskId / model / promptVersion | 连接建立时发一次 |
| `step` | seq / phase / tools / cumulativeTokens | **仅 Agent** |
| `token` | `{d: "文本增量"}` | 见下方真相 |
| `usage` | input/output/cached/costCny/peak | **必在 done 之前单独发**，没记录也发零值 |
| `done` | `{status, degraded}` | `status==='running'` 表示"还没完，请重连" |
| `error` | `{code, message, retryable}` | — |

### 真相：正常路径下 token 不是"实时增量"

```
SSE 每 300ms 查一次 DB 的 Task.outputContent  ← stream/route.ts:170,190
而 outputContent 只在任务**结束时**由 persistResult 写入  ← persistence.ts:33-49
```

所以普通摘要的真实体验是：**等 20 秒 → 一次性刷出全文**。
真正的逐字推送只发生在 `MOCK_LLM` 内联执行分支（`route.ts:267`，`onDelta` 接的是 Mock 的流）。

> 面试怎么答：不要吹"我们做了流式输出"，要说
> "架构上是 DB 轮询 + 终态回放，真增量只在 Mock 分支；要做真流式需要把管线搬到同进程并挂 onDelta，
> 或者引入消息队列把 token 推给 SSE"。
> **能主动说出这个局限，比背十个优点更有说服力。**

### 断线重连（三段配合）

```
客户端 sse-client.ts:171   lastEventId = String(len)      // 已经有几个字
服务端 stream/route.ts:52  parseResumeToken → resumeFrom
推送时 slice(resumeFrom)                                  // 从断点续
```

| 机制 | 值 |
|---|---|
| 心跳 | `: ping\n\n`，15s（防代理 60s 断连） |
| 轮询间隔 | 300ms |
| 单连接上限 | 10 分钟 → `done{status:'running'}`，让客户端重连 |
| 客户端重连 | 5 次，退避 `500·2ⁿ·(0.5~1)`，上限 8s |

**防缓冲头**（少了它前端就是"憋到最后一起出来"）：
`Cache-Control: no-cache,no-transform` + `X-Accel-Buffering: no`，且必须 `new Response(stream)`。

**服务端如何知道客户端断开**：两条独立路径——`req.signal.aborted` 检查、`controller.enqueue` 抛错。

---

## 6. `after()` 的真实性质（面试必须说准）

| 事实 | 含义 |
|---|---|
| 它绑定在请求生命周期上 | 平台会尽力执行完，但**不保证**跨进程重启 |
| 没有重试、没有可见性 | 崩了就永远 `queued/running` |
| 没有背压 | 20 个用户同时提交就 20 个并发管线 |

**所以这是个"演示级"的执行器**。生产要做的事（`README` 已知限制 §1）：
换成 BullMQ/Redis 队列 + worker，并补"卡住任务的 reaper"。

目前能兜住的只有一处：批次取消接口在 `queued` 时**直接收尾**（`cancel/route.ts:41-56`），
因为批次可能永远等不到执行器。

---

## 7. 动手练习

1. **验证异步**：`POST /api/tasks` 后用 `docker logs` 看，模型调用发生在响应之后。
2. **验证幂等**：同一个 `Idempotency-Key` 连发三次，观察 `replayed` 变 true、库里只有 1 条任务。
3. **验证状态机**：把 `content` 设成空字符串绕过前端直接打接口，应得 422 且**没有**任务落库。
4. **验证 SSE 真相**：把 `SSE 轮询间隔` 改成 3000ms，观察出字时机不变（因为它读的是终态）。

---

## 8. 面试问答

**Q：为什么 POST 不直接返回结果？**
> 一次摘要可能几十秒，长文要 Map-Reduce 更久。同步会让连接超时、页面一关就丢。
> 所以两段式：POST 只落库（可幂等、可审计、可重试），执行挂 `after()`，结果用 SSE 订阅。
> 代价是 `after()` 不是真队列，进程重启会丢——这是已知限制，修法是 BullMQ + reaper。

**Q：`queued` 到 `running` 之间用户点了取消会怎样？**
> 单任务没有取消入口（`cancelTask` 只由 signal 触发，而 `after()` 没传 signal）。
> 批次有：取消接口在 `queued` 时直接把批次和条目置为 canceled 并写 `finishedAt`；
> 在 `running` 时只置 `cancelRequested=true`，由执行器在**条目边界**停。

**Q：SSE 是服务端推送吗？**
> 传输层是 SSE，但数据源是**每 300ms 查一次 DB**。所以正常路径下是"终态一次性回放"，
> 不是逐字推送。真增量只在 Mock 内联分支成立。

**追问：那为什么还要 SSE 而不直接前端轮询？**
> 因为要处理断线续传（`Last-Event-ID` + 服务端 slice）、心跳、10 分钟连接上限，
> 这些逻辑放在服务端比每个前端各写一遍可靠。而且 Agent 有多步 `step` 事件需要有序到达。

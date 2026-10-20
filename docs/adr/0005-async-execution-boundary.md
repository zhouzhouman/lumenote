# ADR 0005：异步执行边界（`after()` 的能力与限制）

- **状态**：已采纳（本阶段实现；外部队列明确推迟）
- **日期**：2026-10-20
- **相关代码**：
  - [src/app/api/tasks/route.ts](../../src/app/api/tasks/route.ts)（创建任务、`after()`）
  - [src/lib/pipeline/runner.ts](../../src/lib/pipeline/runner.ts)（管线执行与状态落库）
  - [src/app/api/tasks/[id]/stream/route.ts](../../src/app/api/tasks/[id]/stream/route.ts)（SSE 订阅）
  - [Dockerfile](../../Dockerfile)、[docker-compose.yml](../../docker-compose.yml)（部署形态与迁移）
- **相关 ADR**：[ADR-0001 两段式流式](0001-two-stage-streaming.md)

---

## 背景

[ADR-0001](0001-two-stage-streaming.md) 已经决定「创建任务」与「消费输出」拆成两个请求，
异步执行挂在 Next.js 的 `after()` 上。那篇文档回答的是**为什么**要这么拆；
本篇回答的是更具体、也更容易被误解的问题：

> 任务创建完之后，**到底由谁在执行、执行到哪一步、进程崩了会怎样**？

这个问题必须写清楚，因为 `after()` 的语义很容易被过度解读成「任务队列」：

- 它**没有**持久化、**没有**重试、**没有**租约、**没有**死信；
- 它绑定在「某一次 HTTP 请求的生命周期」上，而不是「某一条任务的生命周期」上。

本项目现在同时存在两种部署形态（Serverless 预览 + Docker Compose 单机/自建），
两者的异步执行保证**强度不同**。把边界写成文档，是为了避免下游代码
（重试逻辑、监控、运维手册）建立在「after() 是队列」这个错误假设上。

---

## 决策

### 1. 两段式：POST 只负责落库，SSE 只负责消费

`POST /api/tasks` 的实际工作**不包含任何 LLM 调用**，它只做：

1. 鉴权、限流、幂等键查重（`Idempotency-Key` 请求头，`@@unique([userId, idempotencyKey])` 兜底）；
2. 成本保护（并发上限、免费日配额）与 Prompt/术语表快照；
3. 写入 `Task(status='queued')`；
4. 用 `after()` 挂上管线，立即返回 `{ taskId, status, replayed }`。

实测（standalone 产物、Mock 模式）创建响应在 **98–157ms**，与管线耗时无关。

`GET /api/tasks/:id/stream` 是第二段，只做三件事：

- 已完成 → 回放 `outputContent`（按 `Last-Event-ID` 裁剪已收到的部分）；
- 失败 → 发送 `error` + `done`；
- 进行中 → **每 300ms 轮询数据库**，把新增状态/内容推给客户端（最长 10 分钟，见 `MAX_STREAM_MS`）。

> 为什么是轮询而不是订阅内存流：执行发生在**另一个请求**里，两者之间没有共享内存；
> Serverless 下甚至可能不在同一实例。数据库是唯一在分布式下正确的共享状态。

**状态机**（`prisma/schema.prisma` 的 `Task.status`，默认 `queued`）：

```
queued ──(管线开始)──> running ──(成功)──> succeeded
   │                        └──(失败)────> failed
   └──(仅收到 AbortSignal 时)──> canceled
```

关于 `canceled`，必须如实说明：**当前没有对外取消接口**。
只有管线自己收到 `AbortSignal` 时才会调用 `cancelTask`，
而 `after()` 与 SSE 兜底路径都没有传 `signal` —— 所以这个状态在本阶段的
正常链路中**不可达**，它只是为后续取消能力预留的终态。

### 2. `after()` 的语义：响应之后、同一进程、best effort

`after(callback)` 的语义是「等这次响应发送完成后，在同一 Node 进程的事件循环里执行回调」。
它提供的价值只有一个：**不让管线阻塞响应**。除此之外不应假设任何东西。

**它保证的**：

- 响应先返回，客户端拿到的延迟 ≈ 建任务 + 落库的时间；
- 在**单实例常驻进程**且进程存活的前提下，回调会被执行（Node 事件循环不退出）；
- 回调里可以用与请求相同的进程内资源（Prisma 连接池、限流内存计数、熔断器状态）。

**它不保证的**：

- **不保证被执行**：进程崩溃、容器重启、滚动更新、OOM、平台回收实例、部署替换，
  都会让回调直接消失，且**没有任何重放机制**；
- **不保证时长**：Serverless 平台对「响应之后还能跑多久」有硬上限；
  超长文档的 Map-Reduce 可能被截断，而截断时任务停在 `running`；
- **不保证一次且仅一次**：平台/进程层面的重复触发与丢失都不由 `after()` 负责；
  重复的成本记录由 `UsageLog.taskId @unique` 兜底（一个任务只结算一次），
  但**执行本身没有全局去重**；
- **不跨实例协调**：没有队列、租约、心跳、重试、死信、优先级。

### 3. 分部署形态的保证强度

| 部署形态 | 保证什么 | 不保证什么 |
|---|---|---|
| **单实例常驻容器**（`docker compose --profile app up app`） | 进程存活期间 `after()` 会跑完；`queued → running → succeeded/failed` 正常推进；SSE 轮询与回放可用 | 容器重启/崩溃/`docker compose up` 重建容器时，正在跑的管线丢失，任务卡在 `running`；无自动恢复 |
| **Serverless**（Vercel 等） | 在平台允许的「响应后执行窗口」内尽量跑完；短任务（Mock/短文本）可正常完成 | 有平台时长上限；实例被回收即中断；被截断后不可续跑；`after()` 无法跨函数实例存活 |
| **多实例水平扩展** | 回调只发生在处理该 POST 的实例上；各实例任务彼此独立 | 无全局调度/租约/心跳；无法跨实例取消或迁移；没有全局重试与死信；真实模式下不能靠 SSE 兜底重跑（会重复计费、内容分叉） |

**本阶段的定位**：
Docker 单实例部署下，`after()` 是一个可用的**单机异步执行**方案；
Serverless 下它只适合演示/短任务；
**任何形态下它都不是生产级多实例任务系统**。

### 4. 故障场景下任务实际会发生什么（据代码行为，不虚构）

| 场景 | 任务状态 | 用户可见 | 是否有恢复机制 |
|---|---|---|---|
| 正常完成 | `queued → running → succeeded` | SSE 收到 `token/usage/done`（回放或轮询） | — |
| 管线失败（上游 5xx、模板缺失、输入为空、Zod 校验失败等） | `running → failed`，落 `errorCode/errorMessage` | SSE `error` + `done`；详情页可查错误码 | 无自动重试；用户重新提交，幂等键防重复扣费 |
| **进程崩溃 / 部署重启时任务仍是 `queued`** | 保持 `queued` | 一直排队；SSE 轮询到 10 分钟超时后 `done(status=running)` | **真实模式无恢复**；仅 Mock 模式在 SSE 分支用 `updateMany({status:'queued'} → 'running')` 原子抢占后**就地执行**（这是演示兜底，不是队列） |
| **进程崩溃 / 部署重启时任务已是 `running`** | 永久保持 `running` | 同上；轮询超时后客户端被告知可重连，但重连也不会推进 | 无。只能按 `@@index([status, createdAt])` 做运维巡检/人工处理（schema 注释已写明该用途） |
| POST 请求超时 / 客户端提前断开 | 不受影响（响应早已发出，管线在 `after()` 里） | 无感知；重新进入任务详情可继续看 | 管线继续；但见「不保证时长/不保证执行」 |
| SSE 连接断开（切页、弱网、主动关闭） | 不影响任务；管线继续写库 | 重连带 `Last-Event-ID` 从断点续传；已完成任务直接回放 | 有：内容与状态都在数据库 |
| SSE 单次订阅超过 10 分钟 | 任务可能仍在执行 | 收到 `error(STREAM_TIMEOUT, retryable:true)` + `done(status='running')`，客户端应重连 | 有（重连继续轮询），但受任务本身是否能跑完限制 |
| 幂等重放（同一 `Idempotency-Key`） | 返回既有任务，不新建 | `{ taskId, status, replayed: true }` | 有：快路径查重 + 唯一约束兜底并发 |

**一个必须承认的实现缺口**：
管线目前**只在终态写 `outputContent`**（`persistResult` 一次更新），
执行过程中没有把已生成的增量写库。因此 ADR-0001 里「重连可以拿到
**已落库的部分结果**」这句话，当前只对「已成功完成的任务」成立；
如果进程在 `running` 中途崩溃，已经花掉的 token 与已生成的内容都不会留下
（只有 `UsageLog` 的部分计量）。这是本阶段的已知限制，不是设计意图。

### 5. 为什么任务内容必须落库，而不是只放内存

- **跨连接**：SSE 可能重连、用户可能刷新页面、可能换设备打开历史；
- **跨请求**：执行在 POST 的 `after()` 里，消费在另一个请求里；
- **跨进程/跨实例**：轮询数据库是唯一在分布式下正确的做法；
- **产品定位**：本项目的核心卖点是「可追溯」——Prompt 版本、模型、参数、成本、输出
  必须永久可查，内存态结构天然无法承担这一点；
- **成本幂等**：`UsageLog.taskId @unique` 让「一个任务只结算一次」成为数据库约束，
  而不是应用层的自觉。

代价是：订阅期间每 300ms 一次查询、`outputContent` 的写放大、以及「轮询延迟」带来的
观感延迟（当前 Mock 任务实测端到端约 1.6s）。这些代价在当前规模下可接受。

---

## 部署侧的异步边界：迁移只执行一次

异步执行的另一个边界是「谁有权改变数据库结构」。本项目明确：

**`prisma migrate deploy` 是一次性部署动作，不是应用启动步骤。**

实现见 [Dockerfile](../../Dockerfile) 的 `migrator` stage 与
[docker-compose.yml](../../docker-compose.yml) 的 `migrate` 服务：

```bash
docker compose up -d postgres redis     # 1. 依赖就绪（等 healthy）
docker compose run --rm migrate         # 2. 一次性迁移，非 0 退出则中止部署
docker compose --profile app up -d app  # 3. 启动应用（只连库，不碰 schema）
```

为什么不能放进 app 的 entrypoint：

- 多副本时每个副本都会尝试迁移，把部署顺序交给竞速；
- 迁移失败会让应用进入重启循环（`restart: unless-stopped`），真实原因被日志淹没；
- app 镜像刻意不含 prisma CLI（见 Dockerfile runner），从最小权限角度也不该有；
- `migrate` 服务固定 `restart: "no"`，执行完即退出；重复 `run --rm migrate` 是幂等的
  （已应用的迁移会被跳过），但正常流程里它只应被执行一次。

`migrate` 与 `app` 都放在 `docker-compose.yml` 的 `app` profile 下，
避免 `docker compose up` 顺手启动它们；显式指定服务名时 profile 会被忽略，
因此上面的 `run --rm migrate` 仍然可用。`app` 只 `depends_on` postgres/redis 的
healthy 状态，**不**依赖自动迁移 —— 顺序由操作者按上面三步保证。

---

## 未来迁移外部队列的接口边界

外部队列是注定的下一步，但**本轮不实现**。先把边界写成接口，是为了让今天的代码
（状态字段、幂等键、终态语义）与明天的队列实现兼容，而不是等到迁移时重写。

| 能力 | 接口语义（建议签名） | 与现有实现的关系 |
|---|---|---|
| **enqueue** | `enqueue(taskId, { idempotencyKey, priority, availableAt })` | POST 落库成功后调用；幂等键已有（`Task.@@unique([userId, idempotencyKey])`） |
| **claim / lease** | `claim(queue) → { taskId, leaseId, attempt, visibilityTimeout }`，原子把 `queued → running` | 替换 `after()`；SSE 里 Mock 的 `updateMany` 抢占思路可复用为租约抢占 |
| **heartbeat** | `heartbeat(leaseId, extendBy)`，长任务定期续租 | 目前没有；没有心跳就无法区分「慢任务」与「死任务」 |
| **retry / backoff** | `retry(taskId, attempt, backoff)`，只对可重试错误（超时/网络/5xx/上游限流）重试 | 管线目前一次失败即 `failed`；错误已带 `retryable` 语义（`LLMError`） |
| **timeout** | `timeout(taskId, deadline)`，超时转为可重试或 `failed` | 目前只有 SSE 的 10 分钟订阅上限，不是任务超时 |
| **idempotency** | 队列层按 `taskId` 去重；重复投递不得产生第二次执行/第二次结算 | `UsageLog.taskId @unique` 已能防重复结算，但防不住重复执行 |
| **dead-letter** | 超过最大尝试或不可重试错误 → `failed`（保留 `errorCode`），可人工查看与手动重放 | 需要新增 `attempts/lease/nextRunAt` 字段或独立队列表 |
| **状态映射** | `queued`=等待；`running`=有活跃租约；`succeeded/failed/canceled`=终态 | 现有枚举可直接复用，不需要改 SSE 协议 |
| **SSE 角色变化** | 从「轮询数据库 + Mock 兜底执行」退化为**只读订阅者**（DB 或 Pub/Sub） | 届时删除 `stream/route.ts` 的 Mock 就地执行分支，避免与队列双重执行 |

**明确不做的**：本轮不引入 Redis 队列、Trigger.dev、QStash、云队列或自建 worker；
不会把 `after()` 包装成「多实例任务系统」。当前边界的准确表述是：
**Docker 单实例常驻部署下可用的单机异步执行；Serverless 与多实例下仅演示级。**

---

## 验证（本机无 Docker，使用 standalone 产物替代）

⚠️ **本机未安装 Docker**。因此：

- `docker build` **未运行**；
- `docker compose config` **未运行**；
- `docker run` **未运行**。

替代验证分两部分，均为实际执行：

### 1. standalone 产物实测

```bash
# 构建（BUILD_STANDALONE=true 由 Dockerfile builder 阶段显式设置，这里手工对齐）
$env:BUILD_STANDALONE='true'; pnpm build

# 按 Dockerfile runner 的布局摆放后启动：standalone + .next/static + public
node scripts/docker/verify-standalone.mjs --keep
```

验证脚本 [scripts/docker/verify-standalone.mjs](../../scripts/docker/verify-standalone.mjs)
用与镜像相同的三件套（standalone 根 + `.next/static` + `public`）在 `127.0.0.1:3300`
以 `NODE_ENV=production` 启动 `node server.js`，环境变量从 `.env.local` 读取（Mock 模式，
不产生真实付费调用），随后逐项断言。实测结果 **20/20 通过**，关键证据：

| 断言 | 实测结果 |
|---|---|
| `/api/health` | **200**，`db.ok=true`（首请求 latencyMs≈348，含连接建立）→ Prisma Client / pg / adapter 已被 tracing 带入 |
| 未登录访问受保护接口 | 401（鉴权链路正常） |
| 注册（console 通道验证码从服务端日志读取） | 200 |
| 登录 | 200，返回 2 个会话 cookie |
| `POST /api/tasks` | 200，**120ms** 返回 `taskId`（两段式第一段不等管线） |
| `after()` 管线在 standalone 运行时中执行 | 状态 `succeeded`，`latencyMs≈1572` |
| 任务详情 `outputContent` | 363 字符（结果确实落库） |
| SSE 回放（已完成任务） | 200，734 bytes，含 `event: usage` 与 `event: done` |
| `GET /api/tasks` 列表 | 200 |

另外单独验证了 `migrate` 服务实际执行的命令（`pnpm prisma:deploy`）：
对本地已迁移的数据库执行时输出 `6 migrations found in prisma/migrations` /
`No pending migrations to apply.`，退出码 0 —— 即重复执行是幂等的，
「一次性」靠的是「只显式执行一次」的编排，而不是靠迁移每次都会改变状态。

注：在这次验证中，worktree 的 `node_modules` 先按 Lead 指示用
`pnpm install --frozen-lockfile` 落成真实目录（不修改 `package.json` / `pnpm-lock.yaml`）。
原因：Next 16 的 Turbopack 无法解析「指向项目根之外」的 node_modules junction，
会直接 panic —— 这是本地多 worktree 共享依赖的环境限制，与项目代码无关；
容器内 `node_modules` 是 `pnpm install` 生成的真实目录，不受影响。

### 2. compose 与 Dockerfile 的静态校验

没有 `docker compose config` / `docker build` 可用，改用
[scripts/docker/validate-deploy-config.py](../../scripts/docker/validate-deploy-config.py)
做静态核对（YAML 解析 + 逐项语义断言 + `.dockerignore` 与构建输入的冲突检查）：

- **51/51 项通过**；
- 覆盖：四个服务存在性与依赖条件、`migrate` 的 `restart: "no"` / `target: migrator` /
  `postgres healthy` 依赖、postgres 库名与 `.env.example` 一致、app 不执行迁移、
  `AUTH_SECRET` 无默认值（缺失即报错）、`/api/health` 探活、REDIS_URL 注入、
  `.dockerignore` 不排除构建必需文件、Dockerfile 的 standalone/非 root/HEALTHCHECK/不 COPY `.env`。

这仍然只是静态校验，不能替代 `docker build` 与 `docker compose config`。

### 未覆盖的部分（如实列出）

- Dockerfile 的 `docker build` 未运行：基础镜像拉取、BuildKit cache mount、
  `corepack prepare`、Alpine 上的 openssl/libc6-compat、多阶段 COPY 路径
  均只经过人工核对，未实测；
- 容器内非 root 用户、`HEALTHCHECK`、端口映射、资源限制未实测；
- 镜像体积只做了设计约束（runner 不含源码/测试/docs/node_modules 全量），
  没有 `docker images` 实测数字。

---

## 后果

**正面**：

- 异步执行的语义被固定为「单实例 best effort」，不会有人误以为它是可靠队列；
- 两段式让 UI 的等待时间与管线耗时解耦（实测建任务 < 200ms）；
- 状态与内容全落库，断线重连、刷新、多设备场景可用；
- 部署侧把「结构变更」与「应用启动」分离，多副本不会各自迁移；
- 未来接入外部队列时，状态枚举、幂等键、SSE 协议都不需要重写。

**负面 / 已知限制**：

- 进程崩溃会留下永久 `running` 的任务（无 reaper、无租约过期重投）；
- 执行过程中不落增量输出，崩溃后已生成内容丢失（见上文「实现缺口」）；
- Serverless 下超长任务仍可能被平台截断；
- 没有对外取消接口，`canceled` 状态暂时不可达；
- Docker 相关改动未经真实构建验证（本机无 Docker）。

---

## 后续

- **外部队列**：按上表接口接入（Trigger.dev / QStash / 自建 worker + Redis），
  同时删除 SSE 的 Mock 兜底执行，避免双写；
- **stuck task reaper**：按 `@@index([status, createdAt])` 巡检长时间停留的
  `queued/running` 任务，转 `failed` 或重新投递；
- **增量落库**：长任务按 token/分块写 `outputContent` 快照，使断线重连能看到部分结果；
- **取消 API**：补上 `POST /api/tasks/:id/cancel`，把 `AbortSignal` 真正接进管线；
- **Docker 实测**：在有 Docker 的环境补跑 `docker build` / `docker compose config` /
  `docker run`，把本文「未覆盖」一节的项补齐；
- **迁移纳入 CI**：在部署流水线里把 `run --rm migrate` 作为 app 发布的前置步骤，
  并把「迁移失败则阻断发布」写成显式门禁。

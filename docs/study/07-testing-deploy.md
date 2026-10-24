# 07 · 测试、CI 与部署

> 目标：能回答"怎么保证质量""集成测试怎么跑""镜像怎么分层"。

---

## 1. 测试分两层，边界很清楚

| | 单测 | 集成 |
|---|---|---|
| 配置 | `vitest.config.ts` | `vitest.integration.config.ts` |
| 依赖 | 无 DB、无 HTTP，毫秒级 | 真实 Postgres + 真实 `next dev` |
| 数量 | 46 个文件 | 8 个套件 |
| 跑法 | `pnpm test` | `pnpm test:integration` |
| 覆盖 | `src/lib/**` 纯逻辑 | 路由、SSE、事务、越权、幂等、配额 |

**为什么路由不进单测覆盖率？**
一 import 路由就会把 `next/server` 的请求上下文拉进来，在纯单测里没有意义。
所以 `coverage.exclude` 里有 `src/app/**`，并在注释里明确写：
**"不要把覆盖率数字当成集成路径已被覆盖的证据。"**

### 覆盖率阈值是"防倒退"，不是"目标"

```
statements 41 / branches 82 / functions 71 / lines 41
```

按基线**向下取整**（不取整会因浮点抖动让 CI 变红）。
新功能上线时先补测试、再动阈值 —— 这次修 bug 时 functions 掉到 69.4%，
处理方式是**补了 4 个测试文件**（batch-runner / create-task-record / audit-record / builtin-templates-ensure），
而不是把 71 改成 69。

---

## 2. 集成测试的 globalSetup（这里的设计最值得学）

```
① resetSchema(directUrl)
     └─ 安全阀：库名必须含 "test"，否则直接抛错（防误 DROP 生产库）
        DROP SCHEMA public CASCADE; CREATE SCHEMA public;
② prisma migrate deploy      ← 用真实 CLI，顺带验证"空库能否迁移成功"
③ tsx prisma/seed.ts         ← 模板 + demo 用户 + 演示任务
④ next dev -p <port>         ← 不 build，省一次构建也避免跑旧产物
⑤ 轮询 /api/health 直到 db.ok===true
   └─ 实例新鲜度校验：health.uptimeSec 比本次 elapsed 大 15s 以上 → 判定是旧进程，中止
teardown: killTree（Windows taskkill /T /F；POSIX 杀进程组）→ 等端口释放
```

| 加固点 | 为什么 |
|---|---|
| 端口占用先杀残留，8s 未释放则换随机端口 | 避免"跑到了上一次残留的服务"这种最诡异的失败 |
| 强制 `MOCK_LLM=true` + 把 `DEEPSEEK/OPENAI/RESEND_API_KEY` 置空字符串 | **零付费风险**；空串也算"已存在"，不会被 `.env.local` 覆盖 |
| 每个测试用户唯一 email + 唯一 XFF | 避免限流互相干扰 |
| 测试侧 Prisma 用独立 client（max:3） | 测试进程与应用进程各自持连接池 |

> 面试点：集成测试最贵的不是写用例，而是**让环境"可重复"**。
> 这里的安全阀（库名含 test）、实例新鲜度校验、密钥置空，都是被真实事故逼出来的。

---

## 3. CI 六个 job（`ci.yml`）

| job | 做什么 | 关键细节 |
|---|---|---|
| `verify` | validate → generate → typecheck → lint → test → **build** | 不需要真库，只给合法假值 |
| `integration` | 起 `pgvector/pgvector:pg16` → `test:integration` | **不能用官方 postgres 镜像**：init 迁移首行 `CREATE EXTENSION vector` 会报 `E0A000` |
| `rate-limit-redis` | 起 `redis:7-alpine` → `test:redis` | 退出码 0/1/2 区分 通过/失败/Redis 不可用，**不把跳过当通过** |
| `coverage` | `test:coverage` + 上传报告 | 未达标非 0 退出；报告 `if: always()` 上传 |
| `dependency-review` | 仅 PR | `fail-on-severity: high` |
| `secret-scan` | gitleaks 固定版本扫工作树 | 不用 action（组织仓库要 license） |

**失败可诊断性**是刻意设计的：CI 里加了 `::error` 注解 + Step Summary + 日志 artifact 三条通道，
因为 Actions 原始日志需要登录才能看。

---

## 4. Dockerfile：5 个 stage（不是 3 个）

| stage | 职责 | 关键取舍 |
|---|---|---|
| `base` | node:22-alpine + `libc6-compat openssl` + corepack pnpm | Alpine 用 musl，Prisma schema engine 需要 openssl 才能被探测到 |
| `deps` | 只 `COPY package.json pnpm-lock.yaml .npmrc` → `pnpm install --frozen-lockfile` | **lockfile 变才失效**，是缓存命中的关键层；用 BuildKit cache mount 挂 pnpm store |
| `builder` | `COPY . .` → `pnpm build`（含 prisma generate）→ standalone | 必须显式 `BUILD_STANDALONE=true`，否则没有 `server.js` |
| `migrator` | prisma CLI + schema + migrations + **seed.ts + src** + `prisma generate` | 一次性迁移单独成 stage：多副本时"每个副本都迁移"会把部署顺序交给竞速 |
| `runner` | 只复制 `.next/standalone` / static / public；非 root uid 1001 | 不含 CLI、源码、tests；`HOSTNAME=0.0.0.0` |

### 两个"只在镜像里坏"的坑（都真实踩过）

**① 动态 import 的包可能没被打进 standalone**

`nodemailer` 是 `serverExternalPackages`（不打包，运行时 require）。
打包器的追踪启发式如果不带上它，本地一切正常，镜像里 `MODULE_NOT_FOUND`，
而报错发生在**用户点"获取验证码"**的那一刻。

修法：`outputFileTracingIncludes: {'/**': ['./node_modules/nodemailer/**/*']}`，几 MB 换确定性。

**② migrator 跑 seed 需要 `prisma generate`**

`migrate deploy` 不需要生成的 client，但 `seed.ts` 直接 `import '@prisma/client'`。
缺了这行 → `MODULE_NOT_FOUND`，报错栈指向 node_modules 深处，很难看出是"构建期少了一步"。

### 环境变量的延迟求值约束

builder 阶段**刻意不注入** `DATABASE_URL` / `AUTH_SECRET`，用来守住
"没有 env 也能构建成功"这条约束 —— 否则本地能 build、CI 不能，或反过来。

---

## 5. compose：服务与 profile

| 服务 | profile | 作用 |
|---|---|---|
| `postgres` | 默认 | `pgvector/pgvector:pg16`（必须带 pgvector），`--locale=C` 固定排序规则 |
| `redis` | 默认 | 多实例共享限流；单实例可用 memory driver |
| `migrate` | `app` | `run --rm migrate`，一次性，退出码 0 才继续 |
| `seed` | `demo` | 灌演示数据（含固定密码账号，**等同公开凭据**） |
| `app` | `app` | `AUTH_SECRET` 用 `${AUTH_SECRET:?...}` fail fast |

```
1) up -d postgres redis      # 等 healthy
2) run --rm migrate          # 幂等，可重跑
3) --profile app up -d app   # 只连库，不碰 schema
   (可选) --profile demo run --rm seed
```

**为什么 migrate 单独一个服务而不是在 app entrypoint 里跑？**
多副本时每个副本都会执行迁移，把部署顺序交给竞速；失败还会让"应用起不来"和"迁移失败"混在一起。

**项目不需要单独跑 seed**：内置模板已在 `src/lib/tasks/builtin-templates.ts`，
应用缺模板时**自愈写入**。seed 只负责演示数据。

---

## 6. 八条迁移各加了什么

| # | 迁移 | 内容 |
|---|---|---|
| 1 | init | `CREATE EXTENSION vector` + 10 张表 + 一批查询索引与唯一键 |
| 2 | add_api_credential | `ApiCredential` + 索引，级联删除 |
| 3 | add_auth_security | `LoginAttempt` / `SecurityEvent` / `EmailVerificationCode`；User 加 `emailVerified`/`lastLoginAt` |
| 4 | add_agent_step | `AgentStep` + `@@unique([taskId,seq])`，级联删除 |
| 5 | add_eval_framework | 评测 5 张表 |
| 6 | judge_calibration_add_question | `JudgeCalibration` 加 `isSeed` 与题目字段 |
| 7 | add_batch | `Batch` + `Task.batchId/batchOrder`；**`onDelete: SetNull`**（任务有价值，不该跟着批次消失） |
| 8 | add_audit_log | `User.role` + `AuditLog`；`userId` 用 **SET NULL**，靠 `actorEmail` 快照追溯 |

**为什么 status 都是 String 不是 enum？**
改 enum 值要 `ALTER TYPE`，在 8 条迁移的开发节奏里成本太高。代价：合法性只由应用保证。

---

## 7. 动手练习

1. `docker compose config --quiet` 验证 compose 语法；`--profile demo config --services` 看服务。
2. 跑 `pnpm build` 后 `ls .next/standalone/node_modules | head`，确认哪些包被打进去了。
3. `docker compose build app` 第二次应该**全部 CACHED**——这是"镜像与源码一致"的可靠证明。
4. 在容器里 `node -e "require.resolve('nodemailer')"` 验证外部包真的在。

---

## 8. 面试问答

**Q：你们怎么保证质量？**
> 两层：46 个单测覆盖 `src/lib` 纯逻辑（重试、定价、分块、护栏、审计脱敏），
> 8 个集成套件覆盖真实路由（越权、幂等、配额、SSE、分享）。
> 覆盖率阈值是防倒退的（41/82/71/41），新代码把 functions 拉低时我补测试而不是降阈值。
> CI 六个 job，其中 integration 用带 pgvector 的镜像，因为 init 迁移里有 `CREATE EXTENSION vector`。

**Q：集成测试怎么保证可重复？**
> globalSetup 做四件事：库名必须含 test 才允许 DROP SCHEMA（安全阀）、
> `prisma migrate deploy`（顺带验证空库可迁移）、seed、起 `next dev` 并轮询 health。
> 还校验实例新鲜度（uptime 比本次启动耗时大 15s 就判定是残留进程），
> 强制 `MOCK_LLM=true` 且把三个真实 key 置空串，保证零付费。

**Q：镜像为什么这么大 / 怎么分层？**
> app 316MB：standalone + 46MB 依赖，非 root，无 `.env`、无测试、源码只带 6 个被追踪的文件。
> migrator 1.4GB：要带 prisma CLI + tsx + 完整 devDependencies 才能迁移和 seed。
> 分层关键是 `deps` 只 COPY lockfile —— 改业务代码不会让依赖层失效。

**Q：如果部署后功能 500，你怎么定位？**
> 三步：① `docker logs` 看错误码（配置类错误现在会透出，比如 `TEMPLATE_MISSING`）；
> ② 核对 `docker compose exec app printenv` 与 `.env` 是否一致（compose 的 environment 是白名单，漏一个就空）；
> ③ 用 `docker compose build app` 看是否全部 CACHED —— 如果不是，说明跑的是旧镜像。

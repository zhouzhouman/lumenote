# 3 分钟演示脚本

> 目标：让面试官在 3 分钟内看到「这不是聊天套壳」，并且**每一步都能追问到代码**。
> 默认走 Mock 模式（`MOCK_LLM=true`，不需要 API Key、零费用）；真实模式切换见 §4。
>
> 演示账号：`demo@lumenote.dev` / `Lumenote2026!`（由 `pnpm prisma:seed` 幂等写入，
> `dailyQuota=500`，并包含一条带证据链的演示 Agent 任务）。

---

## 0. 开场前的一次性准备（30 秒，不占演示时间）

```bash
# 1. 依赖（已装可跳过；worktree/CI 推荐 frozen lockfile）
pnpm install --frozen-lockfile

# 2. 环境变量：从样例复制，至少设置 AUTH_SECRET
cp .env.example .env.local
#   .env.example 默认 MOCK_LLM="true" —— 不配 Key 也能完整演示

# 3. 数据库：有 Docker 时
docker compose up -d postgres redis
#   没有 Docker 时：确保本机 PostgreSQL 16 在 127.0.0.1:5432，
#   并让 scripts/dev.mjs 能找到它（PGHOME 或 PG* 变量，见 §5）

# 4. 迁移 + 种子（幂等，可重复执行）
pnpm prisma:deploy     # 不要用 prisma:migrate（那是开发期交互式迁移）
pnpm prisma:seed

# 5. 启动
pnpm dev               # http://localhost:3000
```

打开 <http://localhost:3000>，用上面的演示账号登录。

---

## 1. 演示前自检（15 秒，避免现场翻车）

| 检查 | 期望 |
|---|---|
| `http://localhost:3000/api/health` | `200`，`"db":{"ok":true}` |
| 登录 `demo@lumenote.dev` | 进入工作台，右上角显示 Demo |
| 历史列表第一页 | 至少 2 条记录（对比演示需要），且有「Lumenote 如何保证…」演示 Agent 任务 |
| 终端日志 | `MOCK_LLM=true` 时没有任何外部 LLM 请求 |

> 如果历史为空：先在工作台生成 2 条摘要（见 §2 第 2 步），或重跑 `pnpm prisma:seed`。

---

## 2. 主脚本（Mock 模式，约 3 分钟）

### 0:00–0:20 首页：先讲「可追溯」

1. 停在首页，指向产品预览卡里的真实字段：**Token 明细 / 缓存命中率 / 成本 / 降级标记**。
2. 一句话定位：
   > 「这不是聊天套壳。每条结果都会记录 Prompt 版本、模型参数、Token 与成本，
   > 所以半年后还能回答『这条结果怎么来的、可不可信、花了多少钱』。」
3. 点右上角「登录」→ 用演示账号进入工作台。

### 0:20–1:10 摘要：两段式 + 流式 + 指纹

1. 工作台默认「长文摘要」。粘贴一段中文长文（或直接回车使用浏览器里的示例文本）。
2. 点 **「开始长文摘要」**。
   - 先讲结构：`POST /api/tasks` 只落库并返回 `taskId`（<200ms），LLM 在 `after()` 里跑，
     前端通过 `GET /api/tasks/:id/stream` 订阅 SSE。
   - 预期看到：状态徽标「生成中…」→ 文字**逐段流出** → 结束后出现 usage 区
     （输入/输出 token、成本、缓存命中率、峰谷标记）。
3. 结果区下方会自动展示 **Prompt 指纹**：模板名 + 版本号；Mock 输出顶部有
   「这是 Mock 模式输出」的显式标记（不伪装成真实模型结果）。
4. 讲取舍：为什么 Map-Reduce 的 Map 阶段不推流（中间产物是噪音，只有 Reduce 推给用户）。

### 1:10–1:40 历史详情：可追溯落到字段

1. 点左侧导航 **「历史」** → 点刚生成的那条记录 → 打开详情。
2. 指给面试官看：
   - Prompt 版本与参数快照（改模板不会改变这条历史）；
   - 输入/输出 token、缓存命中、实际成本、峰值计价；
   - 降级与重试轨迹（Mock 下为正常路径，`degraded=false`）。
3. 讲断线可恢复：刷新页面/重新进入详情，内容仍在 —— 因为状态与输出在数据库，不在内存。

### 1:40–2:20 Agent：结论卡片 + 证据引用（用 seed 的演示任务）

1. 历史列表里打开标题以 **「Lumenote 如何保证 AI 输出可追溯」** 开头的那条（seed 写入）。
2. 预期看到：
   - **3 条结构化结论**卡片；
   - 每条结论下挂着 **`chunk:N` 证据 + 原文摘录**（共 4 条，全部可在文档分块中精确命中）；
   - **推理过程时间线**：3 步（act → act → finalize），每步有工具与命中数。
3. 讲设计：Agent 的控制权在代码（状态机 + 双预算 + 重复检测 + 单工具额度），
   工具全部只读；`checkEvidence()` 用「引文是否真实存在于 `chunk:N`」做**确定性**校验 ——
   不需要 judge、不花钱。
4. **必须主动说明限制**：MockProvider 不支持 tools，所以现场**新建** Agent 任务只会走
   1 步 finalize、没有结构化证据。证据演示请用 seed 的这条任务；真实模型下才会现场检索。
5. （可选 10 秒）点该任务里的「追问」输入框，问一句「用一句话总结」，展示父子任务链。

### 2:20–2:40 版本对比：diff + 参数差异

1. 回历史列表 → 点 **「对比版本」** → 依次点两条记录（先旧后新）→ **「开始对比」**。
2. 预期看到：逐行 diff + 两次的**参数差异**（模型/风格/要点数等）。
3. 讲取舍：接受任意两个 taskId（真实需求常对比不同参数甚至不同能力）；两次都走 `authzTask`；
   自研 LCS 且行数积超过 10^6 退化为整体替换并标 truncated（不让大输入打满 CPU）。

### 2:40–3:00 成本页 + 收尾

1. 点左侧 **「成本」**：今日配额、按模型分布、缓存命中与峰谷统计。
2. 收尾讲三条「不吹」的边界（每条约 5 秒）：
   - `after()` 是单实例异步执行，**不是生产级队列**（ADR-0005）；
   - Docker / Redis / 真实模型 / CI 在本环境**均未实际运行**，只有 standalone 本地验证；
   - CSP 目前是 Report-Only，`proxy.ts` 只做乐观检查、不是安全边界。
3. 结束句：
   > 「所以这份工程的重点不是『功能多』，而是每个结论都有验证或明确的『未验证』标注。」

---

## 3. 演示路线变体

| 场景 | 调整 |
|---|---|
| 时间只有 1 分钟 | 首页 → 工作台生成摘要（看流式+指纹）→ 演示 Agent 任务的证据卡片 → 收尾限制 |
| 面试官关注 AI/Agent | 跳过 diff 与成本页，把 1:40–2:20 扩成：轨迹时间线、`give_up` 与 `failed` 的区别、证据校验、预算护栏 |
| 面试官关注后端/安全 | 重点：两段式、幂等与唯一约束、越权 404、限流双驱动、CSP、SSRF（可现场打开 `src/lib/http/safe-fetch.ts`） |
| 无浏览器/纯终端 | 见 §6 的 curl 版两段式演示 |

---

## 4. 切换到真实模型（有 Key 时）

Mock 与真实模型的差别只在 Provider 选择，链路其余部分完全相同。

```bash
# 方式 A：站点 Key（推荐演示「降级链」）
#   .env.local 中设置：
#   MOCK_LLM="false"
#   DEEPSEEK_API_KEY="sk-..."
#   然后重启：pnpm dev

# 方式 B：BYOK（用户自带 Key，不占站点配额）
#   保持 MOCK_LLM="false" 且不配站点 Key 也可以：
#   登录后进「模型设置」→ 填入 Key → 返回工作台生成
#   任务只记录 credentialId，密钥 AES-256-GCM 加密落库、接口只回掩码
```

- 真实模式会产生**真实费用**；演示时建议用短文 + 少量任务。
- 真实模式下 Agent 会真正调用工具，才会出现多步轨迹与 `structured` 证据；
  但 `MOCK_LLM=true` 时这些不会发生（见 §2 第 3 步的说明）。
- 切回 Mock：把 `MOCK_LLM="true"` 后重启即可；历史记录不受影响。
- 部署/评测相关的真实模型验证**本轮未运行**（无 Key、零费用），见
  [docs/eval-report.md](eval-report.md) 与 [README](../README.md) 的验证状态表。

---

## 5. 失败兜底（现场最可能遇到的 4 种）

### 5.1 数据库没起

症状：`pnpm dev` 直接非 0 退出并打印修复指引；或页面 500、`/api/health` 返回 503。

```bash
node scripts/dev.mjs --dry-run     # 只做数据库探测，先定位问题
# 有 Docker：
docker compose up -d postgres
# 无 Docker：指定便携版/本机 PostgreSQL 根目录（含 pgsql/bin 与 pgdata）
$env:PGHOME='C:\path\to\postgresql'; pnpm dev     # PowerShell
PGHOME=/opt/postgresql pnpm dev                    # bash
# 临时跳过数据库检查（数据库需已可用）：
pnpm dev -- --skip-db
```

### 5.2 seed 没跑 / 账号不存在

症状：登录 401（`INVALID_CREDENTIALS`），或建任务报「模板未初始化，请先执行 pnpm prisma:seed」。

```bash
pnpm prisma:deploy && pnpm prisma:seed
```

### 5.3 端口被占用

```bash
pnpm dev -- -p 3200          # 换端口；注意 NEXT_PUBLIC_APP_URL 一般无需改
# 或释放 3000：
# Windows: netstat -ano | findstr :3000  然后 taskkill /PID <pid> /T /F
```

### 5.4 Mock 模式下 Agent 没有证据 / 只有一步

**这不是 bug**：MockProvider 的能力声明是 `tools:false`，Agent 循环拿不到工具调用，
只能 finalize 一次。演示证据请用 seed 写入的演示 Agent 任务（§2 第 3 步）。
真实模式下（§4）才会出现检索步骤与 `structured`。

---

## 6. 纯终端演示（无浏览器，约 40 秒）

```bash
# 登录拿 cookie
curl -s -c /tmp/ln.cookie -H 'Content-Type: application/json' \
  -d '{"email":"demo@lumenote.dev","password":"Lumenote2026!"}' \
  http://localhost:3000/api/auth/login

# 第一段：建任务，立刻返回 taskId（不等待 LLM）
curl -s -b /tmp/ln.cookie -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{"type":"summarize","content":"在这里放一段至少十个字的中文长文……","params":{"style":"要点式","maxPoints":"5"}}' \
  http://localhost:3000/api/tasks

# 第二段：订阅 SSE（Ctrl+C 结束）
curl -N -b /tmp/ln.cookie http://localhost:3000/api/tasks/<taskId>/stream

# 幂等重放：同一个 Idempotency-Key 再发一次，返回同一 taskId 且 replayed=true
```

---

## 7. 一页速查

```bash
pnpm prisma:deploy && pnpm prisma:seed   # 迁移 + 演示数据（幂等）
pnpm dev                                 # 启动（自动确保数据库就绪）
pnpm smoke                               # 端到端冒烟（mock、28 断言、自动起停 dev）
MOCK_LLM=true pnpm eval:report           # 评测报告（mock，不代表真实质量）
pnpm test && pnpm test:integration       # 单测 + 真实 PG 集成测试
```

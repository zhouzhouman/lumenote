# 09 · 改 Bug 手册

> 目标：看到症状能在 5 分钟内定位到层，以及**知道这个项目踩过哪些坑**。

---

## 1. 通用排查流程（四步，别跳）

```
① 定位层：是哪一层的错？
   浏览器/前端 → API（HTTP 码）→ 管线（任务状态）→ LLM 层（上游）→ 数据/配置

② 拿证据：
   docker logs app --tail 50          # 服务端异常栈
   curl -i ...                        # 响应头 + 状态码（很多 bug 在头里）
   psql -c "select status,errorCode from \"Task\" order by createdAt desc limit 5"
   docker compose exec app printenv   # 环境变量是否真的进去了

③ 二分：
   单测能复现 → 逻辑错
   单测不能、集成能 → 交互/DB 错
   都正常、只有容器里错 → 配置/镜像/网络

④ 修完必须加断言：能复现的 bug 就是一条缺失的测试。
```

**一句经验**：这个项目 80% 的"诡异 bug"出在**容器 vs 本地**的差异上（环境变量白名单、空串、
动态包的打包、时区）。所以"本地正常"永远不能作为排除理由。

---

## 2. 症状 → 可能原因对照表

| 症状 | 先查什么 |
|---|---|
| 登录接口 200 但页面还是未登录 | Cookie 属性：`secure` 是否在 HTTP 下被拒、`domain` 是否不匹配 → `curl -D -` 看 `Set-Cookie` |
| 接口 500 且 message 是"服务暂时不可用" | 日志里找真实错误码；可能是配置类错误被掩码（现已白名单放行） |
| 容器启动就报环境变量校验失败 | `printenv` 看是否有**空字符串**变量撞上 `z.coerce.number().positive()` |
| 任务一直是 `queued` 不动 | `after()` 没执行/进程重启 → 看日志有没有 `[batch]`/pipeline 开始；确认没有卡住的 `running` 占并发额度 |
| 任务卡在 `running` 永不结束 | 准备阶段抛错但没落库（历史 bug，现已兜底）；或上游无响应且没超时 |
| 建任务 500 `TEMPLATE_MISSING` | 模板缺失；现在会自愈，若仍失败看 DB 写权限 |
| 导出 500 | `Content-Disposition` 里有中文（HTTP 头只允许 ASCII）；或审计写入顺序 |
| 批次卡在 `running` | 执行器崩了；只有取消接口在 `queued` 时才直接收尾 |
| 批次显示"失败"但其实是没跑 | 看 `errorCode` 是不是 `SKIPPED_BUDGET`（那是跳过，不是失败） |
| 成本对不上 | 是否混用了人民币/美元；是否用了预估值而非 `UsageLog` |
| 注册收不到验证码 | `MAIL_TRANSPORT=console` 时**不发信**，码在容器日志里 |
| 多实例下限流失效 | 限流还在用 memory driver → 每实例各算各的 |

---

## 3. 真实 Bug 复盘（13 个，全部本仓库实际修过）

> 每一条都给出：**症状 → 根因 → 修法 → 怎么提前发现**。
> 最后一项是最有价值的——它告诉你"下次怎么不让它发生"。

### ① compose 传空串导致环境变量校验失败（P0）

- **症状**：镜像重建后注册直接 500，日志 `SMTP_PORT: Number must be greater than 0`
- **根因**：compose 用 `${SMTP_PORT:-}` 透传，未定义时是**空字符串**；
  `z.coerce.number()` 把 `''` 变成 `0`，撞上 `.positive()`
- **修法**：`emptyAsUndefined` 预处理，空串视为未设置
- **怎么提前发现**：env schema 的单字段测试（`serverEnvSchema.shape.SMTP_PORT.safeParse('')`）；
  以及"容器里跑一次注册"这种 smoke test

### ② 缺 `MOCK_LLM=true` 导致启动即失败

- **症状**：`未配置任何 LLM API Key` 500
- **根因**：`NODE_ENV=production` 下 env 校验要求有可用模型配置
- **修法**：`.env` 补 `MOCK_LLM=true`（或填真实 key）
- **怎么提前发现**：部署文档把"必填项"列成清单；compose 用 `${VAR:?}` fail fast

### ③ Cookie 策略导致局域网访问"登录即掉线"（P0）

- **症状**：登录接口 200，页面仍显示未登录，控制台无报错
- **根因**：`secure: isProd` + `domain: APP_URL.hostname`。
  内网 `http://192.168.x.x` 不是安全上下文 → Secure Cookie 被**静默丢弃**；`domain=localhost` 也不匹配
- **修法**：secure 按 APP_URL 协议推断（可 `COOKIE_SECURE` 覆盖）；domain 默认不写（host-only）
- **怎么提前发现**：`curl -D -` 看 `Set-Cookie` 属性；或用局域网 IP 访问一次（本地 curl 不会暴露这个问题）

### ④ 新部署模板缺失且无合法修复路径（P0）

- **症状**：全新容器库里 `PromptTemplate=0`，建任务 500 `TEMPLATE_MISSING`
- **根因**：模板只定义在 `prisma/seed.ts`（镜像里没有）；而 `prisma:seed` 又会创建
  **固定弱密码**的 demo 账号，生产不敢跑 → 新部署与安全之间没有交集
- **修法**：模板定义搬进 `src/lib/tasks/builtin-templates.ts`，`resolveTemplate` 缺失时**自愈**
- **怎么提前发现**：用空库跑一次"建任务"；或把"基础数据是否就绪"做成部署自检

### ⑤ 配置类错误被掩成"服务暂时不可用"

- **症状**：500 但 message 是通用文案，运维只能翻日志
- **根因**：`handleError` 把所有 5xx 的 LLMError 消息替换成通用文案
- **修法**：白名单放行 `TEMPLATE_MISSING` 等配置类错误码（消息里只有模板名，零泄漏）
- **怎么提前发现**：错误处理加"哪些码可以透出"的清单评审

### ⑥ `params` 契约不一致

- **症状**：单篇任务 422 `Expected string, received number`，批次却照跑
- **根因**：`/api/tasks` 用 `z.record(z.string())`，批次用 `z.unknown()`，前端发数字
- **修法**：批次端 coerce 成字符串，前端也发字符串
- **怎么提前发现**：两个接口共享同一个 zod schema（或至少让契约测试覆盖两边）

### ⑦ 中文批次名导出 500

- **症状**：`TypeError: Cannot convert argument to a ByteString (character 25209「批」)`
- **根因**：HTTP 头只允许 ByteString（≤0xFF），中文拼进 `filename="…"` 在 `new Response()` 时抛错
- **修法**：`contentDisposition()` = ASCII 兜底 + RFC 5987 编码真实名
- **怎么提前发现**：**用中文数据测导出**。这条最讽刺——产品的主要用户是中文用户，
  但测试数据全是英文

### ⑧ 审计把失败记成成功

- **症状**：导出返回 500，但审计里有 `batch.export success`
- **根因**：先写审计再构造 Response；构造抛错时审计已经落库
- **修法**：先构造、成功后再记账
- **怎么提前发现**：审计"结果与事实一致"的断言——失败路径不应该有 success 记录

### ⑨ 动态 import 的包没进镜像（潜在）

- **症状**：镜像里 `require.resolve('nodemailer')` 失败（本地正常）
- **根因**：`serverExternalPackages` + 动态 import，打包器追踪可能不带
- **修法**：`outputFileTracingIncludes`
- **怎么提前发现**：`docker run --rm --entrypoint node <image> -e "require.resolve('x')"`

### ⑩ migrator 跑不了 seed

- **症状**：`MODULE_NOT_FOUND @prisma/client`
- **根因**：migrator 只装依赖、没 `prisma generate`；也没拷 `seed.ts` 与 `src`
- **修法**：补 `RUN pnpm exec prisma generate` + `COPY`
- **怎么提前发现**：在容器里真的跑一次 seed（用临时库，别污染主库）

### ⑪ 验证码「已发送」但没发出去

- **症状**：接口说"验证码已发送，请查收邮件"，邮箱里没有
- **根因**：`console` 通道 `ok:true`（内容打日志），接口把它当成"已投递"
- **修法**：`SendMailResult.delivered` 区分"已生成"与"已投递"，文案分开
- **怎么提前发现**：把"成功"拆成"动作成功"与"目标达成"两个字段

### ⑫ 注册页在构建期读 env 报错（隐患）

- **症状**：`next build` 时执行 `env()` 失败（构建环境没有生产密钥）
- **根因**：注册页要读 `REQUIRE_EMAIL_VERIFICATION`，默认会被预渲染
- **修法**：`export const dynamic = 'force-dynamic'`
- **怎么提前发现**：任何"页面读运行时配置"都要顺手确认它不是静态预渲染

### ⑬ 重试把半截文本推了两次（历史 bug，代码注释记录）

- **症状**：用户看到重复内容，且账单少了第一次的 token
- **根因**：重试前没清空 `text/usage/finished`，`onText` 累积推送
- **修法**：每次尝试开始前重置累积量（`service.ts:116-120`）
- **怎么提前发现**：流式场景的重试测试；断言"累计文本长度等于最终文本长度"

---

## 4. 改 Bug 的五条守则（这个项目的实践）

1. **先写能复现的测试**，再改代码。失败了才叫"修好了"，否则只是"看起来好了"。
2. **优先修根因，不要修症状**。比如"登录掉线"不要加提示文案，要修 Cookie 属性。
3. **区分"数据错"与"显示错"**。成本差 7.2 倍是数据层混用币种，不是格式化问题。
4. **任何"我先记账再做事"的地方都要审一遍顺序**（审计那条就是这么来的）。
5. **改完想一遍"这套逻辑在容器里还成立吗"**：空串、白名单、动态包、时区。

---

## 5. 故意留的三个练习（找找看）

在这个仓库里，以下三处是**真实存在**的缺口，你可以试着定位并写出修法：

1. **熔断器回不到 CLOSED**：找到 `recordSuccess`，看它有没有把 state 改回 `CLOSED`。
   修法：加 `if (state === 'HALF_OPEN') state = 'CLOSED'`，并补单测。
2. **`clampInput` 是死代码**：搜 `applyInputBudget` 的调用点，
   再看翻译/润色超长文本实际会怎样。修法：在 `lifecycle` 里对 `supportsChunking:false`
   且超长的输入做截断或显式拒绝。
3. **Map 阶段降级不反映到任务**：看 `runner.ts` 的 `anyDegraded` 赋值，
   再想"用户怎么知道某个分块降级了"。修法：把 map 的降级合并进 `outputMeta`。

> 这三个练习的共同点：**代码能跑、测试能过，但语义是错的**。
> 面试时能主动讲出这类缺口，比背十个优点有说服力。

---

## 6. 快速命令备忘

```bash
# 服务端异常
docker logs lumenote-app-1 --tail 80 | grep -A10 "未处理异常\|Error"

# 环境变量是否进门
docker compose exec app printenv | grep -E "MOCK_LLM|MAIL_|SMTP_|COOKIE_|REQUIRE_"

# 任务状态分布
docker exec lumenote-postgres psql -U lumenote -d lumenote \
  -c 'select status, count(*) from "Task" group by 1 order by 2 desc'

# 最近一条批次的计数
docker exec lumenote-postgres psql -U lumenote -d lumenote \
  -c 'select name,status,total,succeeded,failed,skipped,"costUsd" from "Batch" order by "createdAt" desc limit 3'

# 镜像是否与源码一致（秒级 = 一致）
docker compose build app

# 单测 / 集成 / 覆盖率
node scripts/test.mjs                       # 或 pnpm test
pnpm test:integration
pnpm test:coverage
```

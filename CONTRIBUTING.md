# 贡献指南

Lumenote 是「可追溯的 AI 文本工作台」。这份文档只写**必须遵守的工程约定**，不重复产品设计文档（见 `docs/`）。

---

## 1. 本地开发

### 前置要求

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20.9（CI 用 22） | 版本由 `package.json` 的 `engines` 约束 |
| pnpm | 10.33.2 | 以 `package.json` 的 `packageManager` 为唯一事实来源，推荐 `corepack enable` |
| PostgreSQL | 16 | 本地需监听 `127.0.0.1:5432` |

> **pnpm 版本只有一个来源**：`package.json` 的 `packageManager`（当前 `pnpm@10.33.2`）。CI 从该字段动态读取版本，Dockerfile 也使用同一版本；不要在本地额外安装别的 pnpm 版本，也不要让 `corepack` 之外的包管理器改写 lockfile。
>
> **依赖构建脚本白名单只有一个来源**：`package.json` 的 `pnpm.onlyBuiltDependencies`（当前放行 `@prisma/engines`、`prisma`、`esbuild`、`unrs-resolver`）。pnpm 10.33 不再读取 `.npmrc` 里的 `onlyBuiltDependencies[]` 写法（实测无效），因此 `.npmrc` 只保留说明注释，不要在那里重新添加。

> 本项目**不需要** Docker 即可开发与测试；`docker-compose.yml` 只是可选的本地库方案，镜像构建只在 main 分支的发布流程里发生。

### 首次启动

```bash
corepack enable                 # 自动使用 packageManager 指定的 pnpm 版本
pnpm install --frozen-lockfile  # 不要用 pnpm install 随意改 lockfile
cp .env.example .env.local      # 然后填入本地值，绝不要提交 .env.local
pnpm prisma:generate
pnpm prisma:deploy              # 应用迁移
pnpm prisma:seed                # 可选：写入本地种子数据
pnpm dev
```

### 常用脚本

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 开发服务器 |
| `pnpm typecheck` | TypeScript 类型检查（不产出文件） |
| `pnpm lint` | ESLint，`--max-warnings 0`，任何 warning 都会失败 |
| `pnpm test` | 单元测试（纯逻辑，不连 DB / 不连网络） |
| `pnpm test:coverage` | 单元测试 + 覆盖率报告（产物在 `coverage/`） |
| `pnpm test:integration` | 集成测试（需要真实 Postgres，见 CI 配置） |
| `pnpm test:redis` | 真实 Redis 限流验证；0=通过，1=失败，**2=Redis 不可用而 SKIPPED** |
| `pnpm build` | 生产构建（含 `prisma generate`） |
| `pnpm verify:all` | 本地一次性跑完质量门禁（validate + typecheck + lint + test + build） |

**提交前至少跑**：`pnpm typecheck && pnpm lint && pnpm test`。改动涉及构建配置、Prisma schema、Next.js 路由时，再加 `pnpm build`。

---

## 2. 分支策略

- `main` 是受保护分支：**所有改动必须经由 Pull Request**，禁止直接 push。
- 分支命名：`feat/<简短描述>`、`fix/<简短描述>`、`chore/<简短描述>`、`docs/<简短描述>`。
- 不要改写已推送的提交历史，禁止 `git push --force`（分支未被他人引用时也请避免）。
- 合并方式：squash 或常规 merge 均可，合并后删除源分支。
- 每个 PR 应保持单一目的；重构与行为变更尽量拆开，便于回滚。

---

## 3. 提交规范（Conventional Commits）

格式：`<type>(<scope>): <subject>`

允许的 `type`：`feat`、`fix`、`chore`、`docs`、`refactor`、`test`、`perf`、`ci`、`build`。

示例：

```text
feat(agent): 为每个任务步骤记录 OpenTelemetry span
fix(auth): 修复 session 过期后仍返回 200 的问题
ci: 复用 package.json 的 pnpm 版本替代硬编码
chore(deps): 升级 prisma 到 7.11
```

要求：

- `subject` 使用祈使句、不超过 72 字符，结尾不加句号；
- 一次提交只做一件事，避免「顺便改格式」污染 diff；
- 破坏性变更在正文写 `BREAKING CHANGE:` 并说明迁移方式。

---

## 4. 测试与质量门禁

PR 合并前以下检查必须在 CI 中通过（对应 `.github/workflows/ci.yml`）：

| 检查 | 命令 | 阻断策略 |
| --- | --- | --- |
| Prisma schema 校验 | `pnpm prisma validate` | 必须通过 |
| 类型检查 | `pnpm typecheck` | 必须通过 |
| Lint | `pnpm lint` | 必须通过（0 warning） |
| 单元测试 | `pnpm test` | 必须通过 |
| 生产构建 | `pnpm build` | 必须通过 |
| 集成测试 | `pnpm test:integration` | 必须通过（Postgres 16 service；harness 自行 DROP schema/migrate/seed 并起 next dev） |
| Redis 限流验证 | `pnpm test:redis` | 必须通过（真实 `redis:7-alpine` service；退出码 2=SKIPPED 同样判失败） |
| 覆盖率 | `pnpm test:coverage` | 产出 `coverage/` artifact；阈值在 `vitest.config.ts` 维护，未达标会让 job 失败 |
| 依赖审查 | `actions/dependency-review-action` | 仅在 PR，high 及以上阻断 |
| 凭据扫描 | `gitleaks dir`（固定版本 CLI） | 有疑似凭据即阻断 |

### CI job 一览

| job | 触发 | 依赖服务 | 说明 |
| --- | --- | --- | --- |
| `verify` | push / PR 到 main | 无 | prisma validate → generate → typecheck → lint → test → build（全部使用假环境变量，不连库） |
| `integration` | push / PR 到 main | Postgres 16 | globalSetup：DROP schema → migrate deploy → seed → next dev → 等 `/api/health`；**不需要先 build** |
| `rate-limit-redis` | push / PR 到 main | Redis 7 | `pnpm test:redis`：Lua 脚本、并发原子计数、TTL/窗口恢复；SKIPPED(2) 视为失败 |
| `coverage` | push / PR 到 main | 无 | `pnpm test:coverage`，阈值未达标 → vitest 非 0 → job 失败；报告始终上传 |
| `dependency-review` | 仅 PR | 无 | 依赖变更审查，高危阻断；不需要任何预配置 secret |
| `secret-scan` | push / PR 到 main | 无 | gitleaks 固定版本 CLI 扫工作树（非全量历史，见 §5 局限） |
| `docker-publish` | 仅 push main / 手动触发 | 无 | 独立 workflow；不会在 PR 运行；缺 Registry Secrets 时跳过而不失败 |

### 本地复现 CI 的服务型检查

CI 里需要真实服务的检查，本地可以这样复现（**不要指向开发库**）：

- **集成测试**：本地 PostgreSQL 16 监听 `127.0.0.1:5432`，用户/密码/库名 `lumenote`，测试库 `lumenote_test`。`pnpm test:integration` 的 globalSetup 会 `DROP SCHEMA public CASCADE` 后重新迁移并 seed，所以 `DATABASE_URL` 必须指向测试库。
- **Redis 限流**：需要有可达 Redis（`docker compose up -d redis`，或本机 `redis-server`），然后 `pnpm test:redis`。没有 Redis 时脚本会打印 `[SKIPPED]` 并以**退出码 2** 结束 —— 这表示「没有验证」，不是「验证通过」。

约定：

- 新增逻辑必须有对应测试；**不要**为了让 CI 变绿而删除、跳过或削弱既有测试；
- 测试里使用的 key / token / 连接串一律是**明确的假值**，不要复制任何真实值；
- 修 bug 时优先补一个能复现该 bug 的测试，再修。

---

## 5. 绝不提交 secret

这是硬性规则，违反会导致凭据泄露，后果由提交者承担。

**禁止入库：**

- `.env`、`.env.local`、`.env*.local` 等本地环境文件（`.env.example` 只放变量名与占位符）；
- 任何真实 API Key（`sk-...`）、数据库连接串、JWT/AUTH secret、cookie、私有证书；
- `scripts/verify/.auth-seed.json`（含可用验证码）、`node_modules/`、`.next/`、`coverage/`、测试报告与 trace 产物。

**要求：**

- 新环境变量先加到 `.env.example`，只写名称、类型与说明，值留空或写明显占位符；
- 凭据只存在于本地 `.env.local` 与部署平台的 Secrets 中；
- 一旦怀疑某个凭据已被提交：**先轮换该凭据**，再清理历史，并在 PR 描述中说明影响范围；
- CI 的凭据扫描只是兜底，不等于安全审计，也不能替代提交前自查：

```bash
git status --short
git diff --cached --name-only   # 提交前确认没有 .env / 产物文件
```

> 局限说明：CI 的 `secret-scan` job 使用 `gitleaks dir` 扫描**当前工作树**（固定版本 8.30.1），
> 不扫描完整 git 历史，因此无法发现「曾提交后又删除」的凭据；它的规则来自
> `.github/gitleaks.toml`，只豁免 `tests/` 下的伪造测试值。

---

## 6. PR 与 Review

- 使用 `.github/pull_request_template.md`，其中「测试结果」必须贴**真实命令与输出**，不接受「已测试」；
- PR 描述需写清风险与回滚方式；涉及数据迁移时说明是否可逆；
- 至少一名维护者 approve 后才可合并；
- 安全相关改动（认证、授权、配额、凭据处理）需要额外 review。

## 7. 报告问题

- 缺陷与功能建议通过 `.github/ISSUE_TEMPLATE/` 提交；
- **安全漏洞不要开公开 issue**，请私下联系维护者；
- 提交 issue 前先搜索是否已有重复。

# 仓库设置与部署验证清单

> 这份文档只讲**不属于 git 的那部分**：分支保护、Actions Secrets、真实环境验证。
> 它们改的是 GitHub / 宿主机上的状态，代码里看不到，所以必须留下「怎么做的」记录，
> 否则换台机器、换个仓库就要从头摸索一遍。

---

## 1. 一次性的仓库加固（分支保护 + Secrets）

设置不能只靠网页点：不可复现、不可评审，而且「谁把 required checks 关了」没有任何记录。
所以把它们写成脚本 `scripts/github/harden-repo.mjs`，用 GitHub REST API 完成。

### 1.1 准备 token

| 类型 | 需要的权限 | 说明 |
| --- | --- | --- |
| classic PAT | `repo` + `workflow` | 最省事；`repo` 里已包含分支保护的读写 |
| fine-grained PAT | Administration: **Read and write**、Secrets: Read and write、Actions: Read | 更安全，但要把仓库加入 token 的 scope |

生成入口：GitHub → Settings → Developer settings → Personal access tokens。
**用完立刻删掉，或把有效期设成最短。** token 只放在环境变量里，不要写进命令行
（会进 shell 历史），更不要提交。

```bash
export GH_TOKEN=github_pat_xxx
```

### 1.2 看当前状态（只读，随便跑）

```bash
pnpm github:status
# 等价于 node scripts/github/harden-repo.mjs status
```

它只列**名字**，不会回显任何 secret 值。

### 1.3 配分支保护

```bash
node scripts/github/harden-repo.mjs protect --dry-run   # 先看要提交什么，不需要 token
pnpm github:protect                                     # 真的写
```

写入的内容与理由：

| 设置 | 取值 | 为什么 |
| --- | --- | --- |
| 要求走 PR | `required_pull_request_reviews` | main 只能通过 PR 进入，保证 CI 在合并前跑过 |
| 需要几个 approve | **0** | 单人仓库设 1 会锁死：GitHub 不允许自己批自己的 PR。等有协作者再 `--approvals 1` |
| required checks | `CI / verify`、`CI / secret-scan`、`CI / dependency-review` | 快（≤1 分钟）且不依赖真实外部服务，适合当硬门禁 |
| 禁止 force push | `allow_force_pushes: false` | 防止改写 main 历史 |
| 禁止删除分支 | `allow_deletions: false` | 同上 |
| 话题必须 resolve | `required_conversation_resolution: true` | 避免「先合了再说」 |
| 管理员是否受限 | `enforce_admins: false` | 保留一个应急出口；想要绝对不可绕过再改 true（那时你自己也推不进去） |
| strict（要求先 rebase） | `false` | 单人开发每次都要多一次 rebase，收益不大 |

### 1.4 第二阶段：把慢 job 也加成门禁

`CI / integration` 与 `CI / rate-limit-redis` 要起 Postgres/Redis service、跑真实 HTTP，
比前三个慢 3~5 倍。**先确认它们至少在 main 上成功跑过一次**，再写成 required：

```bash
node scripts/github/harden-repo.mjs protect \
  --checks "CI / verify,CI / secret-scan,CI / dependency-review,CI / integration,CI / rate-limit-redis"
```

为什么不在第一轮就全加：required check 一旦配错（job 名拼错、job 永远 skipped），
main 会变成**谁都不能合**。先让它们自然跑绿，确认状态再上锁。

> ⚠️ `dependency-review` 只在 `pull_request` 事件运行（push 到 main 时没有 diff 可比），
> 所以它在 main 的 run 里是 skipped。作为 **PR 的** required check 是正常的。

### 1.5 写 Secrets

```bash
# 从 .env.local 读取值并上传（不回显明文，只打印长度）
node scripts/github/harden-repo.mjs secrets --from-env-local DEEPSEEK_API_KEY

# 直接给值（注意会进 shell 历史，优先用文件/环境变量）
node scripts/github/harden-repo.mjs secrets --set RESEND_API_KEY=re_xxx
```

GitHub 的 secret 必须用仓库公钥做 sealed box 加密（X25519 + XSalsa20-Poly1305），
Node 标准库没有这套算法，脚本因此依赖 `libsodium-wrappers`。
它**不是**项目依赖（加进 `pnpm-lock` 会让 CI 的 `--frozen-lockfile` 直接失败），
按脚本内提示临时安装即可。

| Secret | 用途 | 不配的后果 |
| --- | --- | --- |
| `REGISTRY` | 镜像仓库地址（如 `ghcr.io`） | `docker-publish.yml` **自动跳过发布**，不报错 |
| `REGISTRY_USER` | 推送账号 | 同上 |
| `REGISTRY_TOKEN` | 推送口令（classic PAT，勾 `write:packages`） | 同上 |
| `RESEND_API_KEY` | 生产邮件发验证码 | 只能用 `MAIL_TRANSPORT=console`，验证码打到日志 |
| `DEEPSEEK_API_KEY` | 真实模型评测 job | 评测只能跑 mock 分支 |

---

## 2. Docker 主部署路径验证

前提：宿主机装了 Docker（Windows 需要 Docker Desktop + WSL2 后端）。
**只下载安装包不算装好** —— 判断标准是 `docker version` 能打印出 Server 版本。

### 2.0 Windows 前置条件：WSL2（实测踩坑）

`Docker Desktop.exe` 装完、托盘图标也在，但 `docker info` 报：

```
Error response from daemon: Docker Desktop is unable to start
```

真正的原因藏在 `%LOCALAPPDATA%\Docker\log\host\docker-desktop.exe.log` 里：

```
stopReason: "engine linux/wsl failed to start: checking preconditions:
             checking WSL version: wsl is not installed"
```

也就是说**Docker Desktop 装了，但 Linux 虚拟机后端没有**（WSL 的内核/可选功能没启用）。
`wsl.exe` 文件存在也没用 —— 它只是个入口，功能未启用时跑 `wsl --version` 会提示缺少内核。

解决（**管理员** PowerShell，需要重启）：

```powershell
# 方式一：一条命令（Windows 11）
wsl --install --no-distribution

# 方式二：手动启用两个可选功能，再装内核
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
wsl --update
# 然后重启
```

重启后再开 Docker Desktop，`docker info --format '{{.ServerVersion}}'` 应该打印版本号。

前置条件是 CPU 虚拟化已开（任务管理器 → 性能 → CPU → 「虚拟化：已启用」）。
本机实测：Windows 11 Build 26300、虚拟化已开、Hypervisor 已存在，
所以只缺 WSL 这一层。

> agent 沙箱把 `wsl.exe` 加入了程序黑名单，所以这一步必须由你本人在管理员终端执行。

```bash
docker compose config          # 1. 渲染配置：变量插值、profile、healthcheck 是否合法
docker build -t lumenote-app:local --target runner .    # 2. 应用镜像
docker compose up -d postgres redis                     # 3. 依赖就绪（等 healthy）
docker compose run --rm migrate                          # 4. 一次性迁移，退出码必须是 0
docker compose --profile app up -d app                   # 5. 起应用
curl -s localhost:3000/api/health                        # 6. 必须 200 且 db.ok
```

判定标准：
- 第 4 步**退出码 0**，且日志里没有 `E0A000` / `P1001`；
- 第 6 步 `/api/health` 返回 200 —— 该接口只有在 `db.ok` 时才 200，
  所以它同时证明「进程活着」和「数据库可用」；
- `docker compose ps` 里 postgres/redis/app 都是 `healthy`。

### 已知会踩的坑

1. **`extension "vector" is not available`（E0A000）**
   init 迁移第一行是 `CREATE EXTENSION IF NOT EXISTS vector`，
   而官方 `postgres:16-alpine` **不含 pgvector**。必须用
   `pgvector/pgvector:pg16`（官方 PG16 + 预编译扩展）。`docker-compose.yml`
   与 CI 的 integration job 都已固定成该镜像。
2. **`DATABASE_URL 未配置，无法初始化 Prisma Client`（构建期）— 已从根因修复**
   `next build` 在「收集页面数据」阶段会 import 每个路由模块，而 import 会执行
   模块顶层代码。`src/lib/db.ts` 原本在**顶层**就 `new PrismaClient()`，于是任何
   没有连接串的构建环境都会失败：

   ```
   Failed to collect configuration for /api/auth/refresh
   Error: DATABASE_URL 未配置，无法初始化 Prisma Client
     at src/lib/db.ts:19
   ```

   **根因是模块加载期副作用**，不是缺 env。修法是把创建推迟到第一次真正使用
   （`db.ts` 导出一个惰性 Proxy，调用点零改动），与 `src/lib/env.ts` 已有的
   延迟解析保持一致。

   因此 Dockerfile 的 builder 阶段**刻意不注入** `DATABASE_URL`：
   「无 env 也能构建」本身就是回归防线 —— 谁再写顶层求值的代码，
   `docker build` 会立刻失败。CI 的 verify job 仍会注入假值（历史写法），
   不影响这条约束。
3. **`AUTH_SECRET` 未设置**：compose 用 `${AUTH_SECRET:?...}` 写成 fail fast，
   缺了直接报错退出，而不是用默认密钥跑起来。
4. **`.env.local` 不能直接喂给容器**：它里面 `NODE_ENV=development`，
   且 `DATABASE_URL` 指向宿主机 localhost，在容器网络里不可达。
5. **拉不到镜像 / `auth.docker.io` 报 Bad Gateway**：Docker Desktop 默认走系统代理，
   而系统代理指向的端口（如 `127.0.0.1:7890`）没进程监听时，daemon 的所有出站请求
   都会失败。要么打开代理软件，要么在 Settings → Resources → Proxies 里关掉系统代理，
   并在 `~/.docker/daemon.json` 配国内镜像源（`registry-mirrors`）。

### 2.1 本机实测记录（Docker Desktop + WSL2）

| 步骤 | 结果 |
| --- | --- |
| `docker compose config`（含 `--profile app`） | exit 0，4 个 service 全部正确渲染 |
| `docker compose --profile app build` | 两个镜像产出：`lumenote-app:local`、`lumenote-migrator:local`，约 2 分钟 |
| `docker compose up -d postgres redis` | 两个容器 `healthy`；`pg_available_extensions` 里有 `vector 0.8.7` |
| `docker compose run --rm migrate` | **exit 0**，6 个迁移全部应用 |
| `docker compose --profile app up -d app` | `healthy` |
| `curl /api/health` | **HTTP 200**，`{"status":"ok","db":{"ok":true,"latencyMs":8}}` |
| `select count(*) from information_schema.tables` | 21 张表；`pg_extension` 里有 `vector 0.8.7` |

`/api/health` 返回 200 就同时证明了「进程活着」和「数据库可用」——
该接口只有在 `db.ok` 时才是 200。


没有 Docker 时能做的静态校验（本次已通过 51/51）：

```bash
python scripts/docker/validate-deploy-config.py
```

它检查 compose/Dockerfile 的语义一致性（迁移是否独立、app 是否漏挂 .env、
runner 是否非 root、healthcheck 是否指向 /api/health……），
**但不能替代 `docker build` 与 `docker compose config` 的真实执行**。

---

## 3. Redis 限流真实验证

```bash
docker compose up -d redis
REDIS_URL=redis://127.0.0.1:6379 pnpm test:redis   # 期望 exit 0
```

脚本 `scripts/verify/rate-limit-redis.mjs` 的退出码有严格语义：

| 退出码 | 含义 |
| --- | --- |
| 0 | 全部检查通过（真实 Redis 已验证） |
| 1 | 验证失败 |
| 2 | Redis 不可用 → SKIPPED（**绝不伪装成功**） |

它验证 5 组行为：Lua 原子计数与首次 TTL、50 并发不丢计数、
固定窗口超限判定、TTL 过期后窗口恢复、key 命名空间。

Windows 上不必装 Docker：`D:\Redis\Redis-x64-3.2.100\redis-server.exe` 直接可用，
实测 12 项检查全过（连 Redis 3.2 这种老版本也通过，说明脚本没有依赖新命令）。

---

## 4. CI 首次运行观察（实测记录）

| 观察点 | 结论 |
| --- | --- |
| `pnpm/action-setup` 版本 | 从 `package.json` 的 `packageManager` 读取（`pnpm@10.33.2`），不在 workflow 里手写版本号；必须排在 `setup-node` 之前，否则 `cache: pnpm` 会因 `pnpm store path` 失败 |
| gitleaks | 固定 8.30.1 的官方 CLI，不用 `gitleaks-action`（org 仓库需要 `GITLEAKS_LICENSE`）；扫描工作树而非全量历史 |
| Postgres service | `pg_isready` healthcheck 生效，需用 `pgvector/pgvector:pg16` |
| Redis service | `redis-cli ping` healthcheck 生效 |

### 排查 CI 失败的正确姿势

**Actions 的原始日志需要登录才能看**（公开仓库也一样）。所以 workflow 里刻意加了两条
「失败也能看到」的通道：

1. **Job Summary**：gitleaks 命中表、集成测试日志尾部会写进 Summary，公开可读；
2. **error 注解**：`::error title=...::` 会出现在 Checks 页面，也能通过
   `GET /repos/{owner}/{repo}/check-runs/{id}/annotations` 读到（无需鉴权）。

```bash
# 不需要登录就能读失败原因
curl -s "https://api.github.com/repos/OWNER/REPO/commits/SHA/check-runs" \
  | jq -r '.[] | "\(.id) \(.name) \(.conclusion)"'
curl -s "https://api.github.com/repos/OWNER/REPO/check-runs/<id>/annotations" | jq -r '.[].message'
```

本次就是靠这个定位到两个真实故障：
- `extension "vector" is not available` → 镜像缺 pgvector（影响 CI **和**主部署路径）；
- `generic-api-key@tests/integration/helpers/auth.ts:18` → 测试夹具里的固定密码被误报。

---

## 5. 本机环境已知限制

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `prisma migrate deploy` 报 `P1001`，但 psql / pg 都能连 | schema-engine 是独立 native 进程，本机连不上（沙箱/防火墙层面） | 本机跑集成测试改用 CI，或放开该进程的网络权限 |
| vitest 报 `winmm.dll not found` | 项目路径含中文，esbuild 的 Go 运行时加载 DLL 失败 | `scripts/test.mjs` 已自动把 esbuild 复制到纯 ASCII 路径 |
| 接口验收脚本连跑报 429 | 注册限流「单 IP 5 次 / 5 分钟」 | 等 5 分钟，或让每个用例用不同 XFF |

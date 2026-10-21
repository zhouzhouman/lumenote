# syntax=docker/dockerfile:1.7
#
# ============================================================
# Lumenote 生产镜像
# ============================================================
#
# 四个阶段，各自负责一件事，产物只向下游传递：
#
#   base     固定 Node + pnpm 版本，所有阶段的共同起点
#   deps     只装依赖（lockfile 变才失效，构建缓存的关键层）
#   builder  执行 prisma generate + next build，产出 standalone
#   migrator 带 prisma CLI + schema + migrations，**只用于一次性迁移**
#   runner   只带 .next/standalone + static + public，最小运行面
#
# 镜像里**不包含**源码、测试、docs、.git 与 .env*。
#
# ⚠️ 本机（开发机）没有安装 Docker，本文件未经过 `docker build` 实际构建。
#    可执行的替代验证见 scripts/docker/verify-standalone.mjs 与
#    docs/adr/0005-async-execution-boundary.md 的「验证」一节：
#    用同样布局的 standalone 产物跑 `node server.js` 并请求 /api/health。
# ============================================================

# ---- 基础镜像 ----
# node:22-alpine 与项目 engines（>=20.9）对齐，Alpine 的体积远小于 debian 变体。
# 取舍：Alpine 用 musl 而非 glibc，Prisma 的 schema engine 在 musl 上需要
# openssl 才能被正确探测，所以显式装上（比在运行时遇到 "failed to detect
# libssl" 后再排查便宜得多）。libc6-compat 是 Next.js 官方 Alpine 镜像的惯例，
# 给仍按 glibc 假设写的原生依赖留后路。
#
# 生产可复现性提示：tag 会随基础镜像重新发布而漂移，正式发版应固定 digest
# （node:22-alpine@sha256:...），这里保持可读的 tag 以便本地直接构建。
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
# pnpm 版本与 package.json 的 packageManager 字段保持一致，
# 避免 Corepack 自动拉取到不同版本导致 lockfile 校验失败
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app


# ---- 依赖层 ----
FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
# 这一层只在 lockfile 变化时失效，是构建缓存命中率的关键。
# BuildKit cache mount 让 pnpm store 跨构建复用，但不会被打进镜像层。
# ⚠️ pnpm 10 默认拦截依赖的构建脚本。仓库 .npmrc 里虽然声明了
# onlyBuiltDependencies，但 pnpm 10.33 已改为从 pnpm-workspace.yaml /
# package.json 读取该设置，.npmrc 的声明实际不生效（本地 install 也确认被跳过）。
# 受影响的是 @prisma/engines 的 postinstall（下载 schema engine 二进制）。
# 不在这里绕开 pnpm 的策略，而是由下面的 builder / migrator 阶段用
# `prisma` CLI 显式预取（CLI 会在需要时自行下载引擎），见各阶段注释。
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile


# ---- 构建层 ----
FROM base AS builder
# 构建期环境变量：
#  - BUILD_STANDALONE=true 必须显式设置。next.config.ts 用这个开关决定
#    output='standalone'；只在本地碰巧设置的话，镜像里的 `pnpm build`
#    会退化成普通构建，runner 的 `node server.js` 直接不存在。
#  - NEXT_TELEMETRY_DISABLED 避免构建期外联，也让构建可复现。
#  - DATABASE_URL / AUTH_SECRET 是**构建期占位值**，不是真实凭据。
#    原因：next build 在「收集页面数据」阶段会 import 路由模块，而
#    src/lib/db.ts 在**模块加载期**就 new PrismaClient —— 缺 DATABASE_URL
#    直接抛错，整个构建失败（实测报错）：
#        Failed to collect configuration for /api/auth/refresh
#        Error: DATABASE_URL 未配置，无法初始化 Prisma Client
#    src/lib/env.ts 的 schema 校验同理。CI 的 verify job 也是这么做的。
#    这两个值只存在于 builder 阶段：runner 阶段有自己的 ENV，运行时真实值
#    由 compose / 平台注入，所以占位值不会进入最终镜像，也不会被拿去连库。
#    取值刻意复用 CI 里已有的合法假值，避免 secret-scan 把它们当成新凭据。
ENV NEXT_TELEMETRY_DISABLED=1 \
    BUILD_STANDALONE=true \
    DATABASE_URL="postgresql://u:p@localhost:5432/test" \
    AUTH_SECRET="test-secret-that-is-at-least-32-characters-long" \
    DEFAULT_MODEL="deepseek-flash"

COPY --from=deps /app/node_modules ./node_modules
# .dockerignore 已排除 .env*、.git、node_modules、.next 等，这里拿到的是
# 纯源码 + 构建配置。prisma generate 在 build 脚本里（package.json），
# 它需要 schema，所以必须在 COPY . 之后执行。
COPY . .
RUN pnpm build


# ---- 迁移层（一次性，不进入 app 镜像）----
# 为什么迁移要单独一个 stage / 单独一个容器：
#
#   `prisma migrate deploy` 是**一次性**动作，不是应用启动步骤。
#   如果放进 app 的 entrypoint，多副本部署时每个副本都会执行一遍；
#   Prisma 虽然用 advisory lock 防并发，但「每个实例都尝试迁移」这件事本身
#   就把「部署顺序」交给竞速，且失败时应用会反复重启、无限重试。
#
#   正确顺序（见 docker-compose.yml）：
#     1. up postgres（等 healthy）
#     2. run --rm migrate（执行一次，退出码 0 才继续）
#     3. up app（只连库，不碰 schema）
#
# 这个 stage 继承 deps 的完整 node_modules（prisma CLI 是 devDependency，
# 只装生产依赖会没有 CLI），但最终的 runner 镜像完全不含它。
FROM base AS migrator
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml .npmrc ./
# prisma.config.ts 负责加载连接串（DATABASE_URL / DIRECT_URL），
# 也把 migrations 目录与 schema 的位置告诉 CLI。缺一个都会在容器里才报错。
COPY prisma.config.ts ./
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY prisma/migrations ./prisma/migrations

# 预取 Prisma 的 schema engine 二进制。
# 原因：pnpm 10 拦截了 @prisma/engines 的 postinstall（见 deps 阶段注释），
# 而 `prisma migrate deploy` 需要 schema engine。如果留到生产容器首次运行时
# 才让 CLI 去下载，部署环境通常没有外网 —— 那会变成「迁移失败」而不是「下载失败」，
# 排查成本高得多。`prisma -v` 会触发引擎下载并校验。
RUN pnpm exec prisma -v

# 显式失败语义：迁移失败 → 容器以非 0 退出，编排层据此中止部署。
CMD ["pnpm", "prisma:deploy"]


# ---- 运行层 ----
# 不继承 base：runner 不需要 corepack/pnpm/apk 工具链，
# 从干净的 node:22-alpine 开始能少掉一层包管理器与 root 工具面的攻击面。
# 注意：runner 里**没有** prisma CLI、没有源码、没有 tests/docs。
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    # standalone 产物自带 HTTP server，HOSTNAME/PORT 由它读取。
    # 绑 0.0.0.0 而不是 127.0.0.1：容器网络下监听 loopback 会让端口映射
    # 与同网络服务都连不上。
    HOSTNAME=0.0.0.0 \
    PORT=3000

# 非 root：容器被突破时，uid 1001 的权限远小于 root。
# 固定 uid/gid 1001 而不是让 adduser 自选，避免不同构建环境下 uid 漂移，
# 影响宿主挂载卷（如日志目录）的属主。node 用户冲突时用 nextjs 独立用户。
RUN addgroup -g 1001 -S nodejs \
    && adduser -u 1001 -S -G nodejs nextjs

# standalone 布局（Next 官方约定）：
#   .next/standalone/  → /app          （含 server.js 与 traced 的 node_modules）
#   .next/static/      → /app/.next/static
#   public/            → /app/public
# 只复制这三处，不复制 .next 全量（里面有 .next/cache、构建中间产物），
# 也不复制 node_modules 全量（standalone 的 node_modules 是 trace 出来的最小集）。
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# 探活 /api/health：只有 db.ok=true 才 200，数据库不可用时返回 503（见 health/route.ts）。
# 因此这个 HEALTHCHECK 同时覆盖「进程活着」与「依赖可用」，而不只是端口能连。
# 用 node 内建 fetch 而不是 curl/wget：alpine 镜像里不必额外装包。
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# standalone server 而不是 `next start`：后者需要 next CLI 与完整 node_modules，
# 这与「runner 只带 traced 依赖」的目标矛盾。
CMD ["node", "server.js"]

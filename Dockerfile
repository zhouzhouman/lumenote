# ---- 基础镜像 ----
# 分阶段构建：deps 只装依赖，builder 做构建，runner 只带运行期产物。
# 关键是让 node_modules 不携带编译期的重型依赖，且 runner 不含源码。

FROM node:22-alpine AS base
# pnpm 版本与 package.json 的 packageManager 字段保持一致，
# 避免 Corepack 自动拉取到不同版本导致 lockfile 校验失败
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app


# ---- 依赖层 ----
FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
# 这一层只在 lockfile 变化时失效，是构建缓存命中率的关键
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile


# ---- 构建层 ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# prisma generate 需要在 next build 之前跑，因为客户端代码由 schema 生成。
# 但它需要 schema 文件存在，而 schema 属于源码，所以放在 COPY . 之后。
RUN pnpm prisma:generate

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build


# ---- 运行层 ----
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# 不要以 root 运行：一旦容器被突破，root 权限会直接放大影响面
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
# prisma 目录：运行时 prisma migrate deploy 需要 schema
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]
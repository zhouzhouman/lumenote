#!/usr/bin/env python3
"""
部署配置静态校验（Docker 不可用时的替代验证）。

本机没有安装 Docker，`docker compose config` / `docker build` 无法执行。
但「配置是否自洽」这件事可以脱离 Docker 校验：

  1. docker-compose.yml 能被 YAML 解析，且服务/依赖/健康检查/迁移一次性语义符合预期；
  2. .dockerignore 排除了密钥与无关产物，同时**没有**排除构建必需文件；
  3. Dockerfile 的几处关键约束（builder 设置 BUILD_STANDALONE、真 standalone runner、
     非 root、HEALTHCHECK、migrator 独立 stage、runner 不复制源码/全量 node_modules）确实存在；
  4. postgres 库名与 .env.example 的 DATABASE_URL 一致（此前的 P0 不一致就是这里）。

它不能替代 `docker build` —— 镜像层、构建缓存、基础镜像行为仍需在有 Docker 的环境实测。
用法：python scripts/docker/validate-deploy-config.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]

results: list[tuple[bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((bool(ok), name))
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail else ""))


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


# ============================================================
# 1. docker-compose.yml
# ============================================================
compose_raw = read("docker-compose.yml")
compose = yaml.safe_load(compose_raw)
services = compose.get("services", {})

check("docker-compose.yml 可被 PyYAML 解析", isinstance(services, dict))
check(
    "compose 含 postgres / redis / migrate / app 四个服务",
    {"postgres", "redis", "migrate", "app"}.issubset(services.keys()),
    ", ".join(sorted(services.keys())),
)

postgres = services.get("postgres", {})
check(
    "postgres 库名与 .env.example 一致（lumenote，而不是 lumenote_dev）",
    postgres.get("environment", {}).get("POSTGRES_DB") == "lumenote",
    str(postgres.get("environment", {}).get("POSTGRES_DB")),
)
env_example = read(".env.example")
check(
    ".env.example 的 DATABASE_URL 指向库 lumenote",
    "postgresql://lumenote:lumenote@localhost:5432/lumenote" in env_example,
)
check(
    "postgres healthcheck 用 pg_isready 且库名一致",
    "pg_isready" in str(postgres.get("healthcheck", {}).get("test"))
    and "-d lumenote" in str(postgres.get("healthcheck", {}).get("test")),
)
check(
    "postgres 数据卷用命名卷（不落进镜像层）",
    "lumenote-pgdata" in compose.get("volumes", {})
    and "lumenote-pgdata" in str(postgres.get("volumes", [])),
)

redis = services.get("redis", {})
check("redis 保留健康检查", "redis-cli" in str(redis.get("healthcheck", {}).get("test")))
check(
    "compose 注释说明 redis 已由 RATE_LIMIT_DRIVER=redis 使用",
    "RATE_LIMIT_DRIVER=redis" in compose_raw,
)

migrate = services.get("migrate", {})
check("migrate 是一次性服务：restart: 'no'", str(migrate.get("restart")) == "no", str(migrate.get("restart")))
check(
    "migrate 构建 target=migrator",
    str(migrate.get("build", {}).get("target")) == "migrator",
    str(migrate.get("build", {}).get("target")),
)
check(
    "migrate 等 postgres healthy 再执行",
    migrate.get("depends_on", {}).get("postgres", {}).get("condition") == "service_healthy",
)
check("migrate 归入 app profile（避免被 docker compose up 顺手拉起）", "app" in migrate.get("profiles", []))
check(
    "migrate 的 DATABASE_URL 在容器网络内指向服务名 postgres",
    "@postgres:5432/lumenote" in str(migrate.get("environment", {}).get("DATABASE_URL")),
)

app = services.get("app", {})
app_env = app.get("environment", {})
check("app 构建 target=runner", str(app.get("build", {}).get("target")) == "runner")
check(
    "app 依赖 postgres 与 redis 的 healthy",
    app.get("depends_on", {}).get("postgres", {}).get("condition") == "service_healthy"
    and app.get("depends_on", {}).get("redis", {}).get("condition") == "service_healthy",
)
app_text = str(app)
check("app 启动时不执行迁移（无 migrate deploy / prisma 命令）", "migrate" not in app_text.lower() and "prisma" not in app_text.lower())
check("app 明确 NODE_ENV=production", app_env.get("NODE_ENV") == "production")
check("app 明确 HOSTNAME=0.0.0.0", app_env.get("HOSTNAME") == "0.0.0.0")
check("app 端口 3000 由环境变量控制", str(app_env.get("PORT")) == "3000")
check("app 注入 REDIS_URL", str(app_env.get("REDIS_URL", "")).startswith("redis://"))
check(
    "AUTH_SECRET 必须由外部注入（缺失时 compose 直接报错，不给默认值）",
    ":?" in str(app_env.get("AUTH_SECRET", "")),
    str(app_env.get("AUTH_SECRET", ""))[:40],
)
check(
    "app healthcheck 指向 /api/health",
    "/api/health" in str(app.get("healthcheck", {}).get("test")),
)
check(
    "app 不在 compose 里挂载或写入 .env 文件",
    "env_file" not in app or not str(app.get("env_file")).strip(),
)

# ============================================================
# 2. .dockerignore
# ============================================================
dockerignore_lines = [
    line.strip()
    for line in read(".dockerignore").splitlines()
    if line.strip() and not line.strip().startswith("#")
]

required_build_inputs = [
    "package.json",
    "pnpm-lock.yaml",
    ".npmrc",
    "next.config.ts",
    "tsconfig.json",
    "postcss.config.mjs",
    "tailwind.config.ts",
    "eslint.config.mjs",
    "prisma.config.ts",
    "src/app/layout.tsx",
    "prisma/schema.prisma",
    "public/favicon.ico",
]


def dockerignore_matches(pattern: str, path: str, is_dir: bool) -> bool:
    """极简 .dockerignore 语义：无斜杠按 basename 匹配，含斜杠按相对路径前缀匹配。"""
    path = path.replace("\\", "/")
    pattern = pattern.rstrip("/")
    if not pattern:
        return False
    if "/" not in pattern:
        target = path.rsplit("/", 1)[-1]
        return _glob(pattern, target)
    return _glob(pattern, path)


def _glob(pattern: str, name: str) -> bool:
    # 只支持 * / ** 两种通配，够校验本仓库的规则
    regex = re.escape(pattern).replace(r"\*\*", "\x00").replace(r"\*", "[^/]*").replace("\x00", ".*")
    return re.fullmatch(regex, name) is not None


ignored_required = []
for relative in required_build_inputs:
    for pattern in dockerignore_lines:
        if pattern.startswith("!"):
            continue
        if dockerignore_matches(pattern, relative, False):
            ignored_required.append((relative, pattern))
            break
check(
    "构建必需文件没有被 .dockerignore 排除",
    not ignored_required,
    ", ".join(f"{p} <- {pat}" for p, pat in ignored_required) or f"{len(required_build_inputs)} 项",
)

must_ignore = {
    "node_modules": "node_modules",
    ".git": ".git",
    ".env.local": ".env.local",
    ".github": ".github",
    "docs": "docs",
    "tests": "tests",
    ".worktrees": ".worktrees",
    ".lumenote-data": ".lumenote-data",
    "coverage": "coverage",
    ".next": ".next",
}
for display, relative in must_ignore.items():
    ignored = any(
        not p.startswith("!") and dockerignore_matches(p, relative, True) for p in dockerignore_lines
    )
    check(f".dockerignore 排除 {display}", ignored)

check(
    ".dockerignore 不把 .env.example 放回构建上下文（镜像不需要样例文件）",
    not any(p == "!.env.example" for p in dockerignore_lines),
)

# ============================================================
# 3. Dockerfile
# ============================================================
dockerfile = read("Dockerfile")

check(
    "builder 阶段显式设置 BUILD_STANDALONE=true（与 next.config.ts 开关一致）",
    re.search(r"AS builder[\s\S]*?BUILD_STANDALONE=true", dockerfile) is not None,
)
check("存在独立的 migrator stage", re.search(r"AS migrator", dockerfile) is not None)
check("存在独立的 runner stage", re.search(r"AS runner", dockerfile) is not None)
check(
    "runner 复制 .next/standalone（真 standalone，而不是全量 .next）",
    "COPY --from=builder" in dockerfile and "/app/.next/standalone ./" in dockerfile,
)
check("runner 复制 .next/static 到 .next/static", "/app/.next/static ./.next/static" in dockerfile)
check("runner 复制 public", "/app/public ./public" in dockerfile)
check(
    "runner 不复制整个 node_modules / 源码 / tests",
    not re.search(r"AS runner[\s\S]*COPY[^\n]*node_modules", dockerfile)
    and not re.search(r"AS runner[\s\S]*COPY[^\n]*\bsrc\b", dockerfile),
)
check("runner 使用非 root 用户", re.search(r"adduser[^\n]*1001", dockerfile) is not None and "USER nextjs" in dockerfile)
check("runner 设置 HOSTNAME=0.0.0.0 / PORT=3000", "HOSTNAME=0.0.0.0" in dockerfile and "PORT=3000" in dockerfile)
check("runner CMD 为 node server.js", 'CMD ["node", "server.js"]' in dockerfile)
check("HEALTHCHECK 指向 /api/health", "/api/health" in dockerfile and "HEALTHCHECK" in dockerfile)
check("Dockerfile 不 COPY 任何 .env 文件", not re.search(r"COPY[^\n]*\.env", dockerfile))
check("migrate 通过 pnpm prisma:deploy 执行（一次性）", "prisma:deploy" in dockerfile)
check("设置 NEXT_TELEMETRY_DISABLED", "NEXT_TELEMETRY_DISABLED=1" in dockerfile)
check("deps 层使用 pnpm install --frozen-lockfile + BuildKit cache mount", "--frozen-lockfile" in dockerfile and "cache,id=pnpm" in dockerfile)

# ============================================================
# 4. next.config.ts 的 standalone 开关
# ============================================================
next_config = read("next.config.ts")
check(
    "next.config.ts 用 BUILD_STANDALONE 控制 output='standalone'",
    "BUILD_STANDALONE === 'true' ? 'standalone'" in next_config,
)

# ============================================================
# 汇总
# ============================================================
passed = sum(1 for ok, _ in results if ok)
print(f"\n== 结果汇总：通过 {passed}/{len(results)} 项静态检查 ==")
failed = [name for ok, name in results if not ok]
if failed:
    print("失败项：")
    for name in failed:
        print(f"- {name}")
    sys.exit(1)
print("注意：这是静态校验，不能替代 docker build / docker compose config 的实际执行。")

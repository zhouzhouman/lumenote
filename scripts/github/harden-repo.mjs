#!/usr/bin/env node
/**
 * GitHub 仓库加固脚本：分支保护 + Actions Secrets。
 *
 * ## 为什么要有这个脚本
 *
 * 仓库设置（分支保护、required checks、Secrets）**不在 git 里**，
 * 它们在 GitHub 的数据库里，只能通过 Web UI 或 REST API 改。
 * 全在网页上点的问题有两个：
 *   1. 不可复现 —— 换个仓库要从头点一遍，还容易漏一项；
 *   2. 不可评审 —— 谁把 required checks 关掉了，没有任何记录。
 * 所以把「设置」写成脚本，让它可以被 review、被重跑、被当文档看。
 *
 * ## 用法
 *
 *   # 1) 先把 token 放进环境变量（不要写进命令行，会进 shell 历史）
 *   export GH_TOKEN=github_pat_xxx
 *
 *   # 2) 看当前状态（只读，可随便跑）
 *   node scripts/github/harden-repo.mjs status
 *
 *   # 3) 配分支保护（默认就是本仓库要的那套）
 *   node scripts/github/harden-repo.mjs protect
 *
 *   # 4) 写入 Secrets（值从 .env.local 读，不回显）
 *   node scripts/github/harden-repo.mjs secrets --from-env-local DEEPSEEK_API_KEY
 *
 *   # 5) 首次 CI 绿了之后，再把两个慢 job 加进 required checks
 *   node scripts/github/harden-repo.mjs protect \
 *     --checks "CI / verify,CI / secret-scan,CI / dependency-review,CI / integration,CI / rate-limit-redis"
 *
 * ## token 需要什么权限
 *
 * - classic PAT：勾 `repo`（含 repo 级别的 admin 读写）+ `workflow`
 * - fine-grained PAT：Administration = Read and write、Secrets = Read and write、
 *   Actions = Read（配 branch protection 必须 Administration 可写）
 *
 * 用完请立刻在 GitHub 上删掉 token，或把有效期设到最短。
 *
 * ## 关于 approvals 的默认值
 *
 * 默认 `--approvals 0`：**要求走 PR，但不要求别人 approve**。
 * 单人仓库如果设成 1，自己开的 PR 永远没人能批（GitHub 不允许自我 approve），
 * 结果就是 main 再也合不进去 —— 这是最典型的「保护规则把自己锁死」。
 * 等有协作者了再加：`--approvals 1`。
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';

// libsodium-wrappers 是 CJS 包，用 createRequire 才能按目录解析 package.json 的 main
const require = createRequire(import.meta.url);

const API = 'https://api.github.com';
const DEFAULT_CHECKS = [
  // 前三个是「每次 PR 都必须绿」的硬门禁
  'CI / verify',
  'CI / secret-scan',
  'CI / dependency-review',
];

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const [mode = 'status', ...rest] = argv;
  const opts = { mode, fromEnvLocal: [], dryRun: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--repo') opts.repo = rest[++i];
    else if (arg === '--checks') opts.checks = rest[++i];
    else if (arg === '--approvals') opts.approvals = Number(rest[++i]);
    else if (arg === '--from-env-local') {
      // 支持一次给多个 key：--from-env-local A B C
      while (rest[i + 1] && !rest[i + 1].startsWith('--')) opts.fromEnvLocal.push(rest[++i]);
    } else if (arg === '--set') {
      const pair = rest[++i] ?? '';
      const eq = pair.indexOf('=');
      if (eq < 0) fail(`--set 需要 NAME=VALUE 形式，收到：${pair}`);
      opts.fromEnvLocal.push(pair.slice(0, eq));
      opts.setValues = opts.setValues ?? {};
      opts.setValues[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else {
      fail(`未知参数：${arg}`);
    }
  }
  return opts;
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function resolveRepo(explicit) {
  if (explicit) return explicit;
  // 从 git remote 里取：兼容 origin 不存在、用别的名字做远程的情况
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) fail(`无法从 remote 解析 owner/repo：${url}，请用 --repo owner/name 指定`);
  return `${m[1]}/${m[2]}`;
}

function token() {
  const t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  // dry-run 不打 API，也就不需要 token —— 这样「先看要改什么」不需要任何凭据
  if (!t && opts.dryRun) return '';
  if (!t) {
    fail(
      '缺少 token：请先 export GH_TOKEN=...\n' +
        '  classic PAT 勾 repo + workflow；fine-grained 需要 Administration: write。',
    );
  }
  return t;
}

async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'lumenote-harden-repo',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const detail = json?.message ? `${json.message}（HTTP ${res.status}）` : `HTTP ${res.status}: ${text.slice(0, 300)}`;
    throw new Error(detail);
  }
  return json;
}

// ---------------------------------------------------------------------------
// 分支保护
// ---------------------------------------------------------------------------

function protectionPayload(opts) {
  const contexts = (opts.checks ? opts.checks.split(',') : DEFAULT_CHECKS).map((s) => s.trim()).filter(Boolean);
  const approvals = Number.isFinite(opts.approvals) ? opts.approvals : 0;
  return {
    payload: {
      // ---- 必须走 PR ----
      // required_approving_review_count: 0 的含义是「PR 是唯一入口，但不需要别人批」。
      // 单人仓库必须有这个设置，否则 self-approve 不被允许 → main 锁死。
      required_pull_request_reviews: {
        required_approving_review_count: approvals,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
      },
      required_status_checks: {
        // strict: true 会要求分支必须先 rebase 到最新 main 才能合，
        // 单人开发时每次都要多一次 rebase，收益不大，这里关掉。
        strict: false,
        contexts,
      },
      // 话题必须全部 resolve 才能合（避免「先合了再说」）
      required_conversation_resolution: true,
      // 明确禁止破坏性操作
      allow_force_pushes: false,
      allow_deletions: false,
      // 推送白名单（只有组织仓库才有意义）。
      // ⚠️ 必须显式传 null：个人账号仓库调这个接口时，漏掉该字段会返回
      //    422 Invalid request. "restrictions" wasn't supplied.
      restrictions: null,
      // 管理员也受限：false 表示不强制管理员遵守 —— 保留一个应急出口。
      // 想要「管理员也不能绕过」就改成 true（但那时你自己也推不进去了）。
      enforce_admins: false,
      // 线性历史：只允许 squash / rebase 合并，避免 merge commit 打结
      required_linear_history: false,
    },
    contexts,
    approvals,
  };
}

async function protect(tok, repo, opts) {
  const { payload, contexts, approvals } = protectionPayload(opts);
  const [owner, name] = repo.split('/');
  console.log(`\n→ 配置分支保护：${repo} @ main`);
  console.log(`  · 必须走 PR（approvals=${approvals}）`);
  console.log(`  · required checks：${contexts.join(' | ')}`);
  console.log('  · 禁止 force push / 禁止删除分支');
  if (opts.dryRun) {
    console.log('\n[dry-run] 请求体：');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  await api(tok, 'PUT', `/repos/${owner}/${name}/branches/main/protection`, payload);
  console.log('✓ 分支保护已生效');
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

async function loadSodium() {
  const candidates = [
    'libsodium-wrappers',
    // 本机 WorkBuddy 托管的 node 依赖目录（不想给项目加 devDependency，
    // 因为 pnpm-lock 变化会让 CI 的 --frozen-lockfile 直接失败）。
    // 显式装在一个独立目录里：`npm i libsodium-wrappers --prefix <dir>`
    'C:/Users/qwert/.workbuddy/binaries/node/libsodium/node_modules/libsodium-wrappers',
    'C:/Users/qwert/.workbuddy/binaries/node/workspace/node_modules/libsodium-wrappers',
  ];
  // 让 NODE_PATH 也能生效
  for (const p of (process.env.NODE_PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    if (p) candidates.push(`${p}/libsodium-wrappers`);
  }
  for (const spec of candidates) {
    try {
      const sodium = require(spec);
      await sodium.ready;
      return sodium;
    } catch {
      /* 试下一个 */
    }
  }
  fail(
    '找不到 libsodium-wrappers（GitHub 的 secret 必须用 sealed box 加密）。\n' +
      '  临时装一份即可：\n' +
      '    cd ~/.workbuddy/binaries/node/workspace && npm i libsodium-wrappers\n' +
      '  或用 NODE_PATH 指向已安装目录。',
  );
}

/** 从 .env.local / .env 里读一个变量（不读 process.env，避免串值） */
function readEnvFile(name) {
  for (const file of ['.env.local', '.env']) {
    if (!fs.existsSync(file)) continue;
    const line = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith(`${name}=`));
    if (line) {
      return line
        .slice(line.indexOf('=') + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

async function setSecrets(tok, repo, opts) {
  if (opts.fromEnvLocal.length === 0) fail('没有要写的 secret：用 --from-env-local NAME 或 --set NAME=VALUE');
  const [owner, name] = repo.split('/');
  const sodium = await loadSodium();
  const { key, key_id } = await api(tok, 'GET', `/repos/${owner}/${name}/actions/secrets/public-key`);

  for (const secretName of opts.fromEnvLocal) {
    const value = opts.setValues?.[secretName] ?? readEnvFile(secretName);
    if (!value) {
      console.log(`  ⚠ ${secretName}：本地为空，跳过（镜像相关变量留空时流水线会自动跳过发布）`);
      continue;
    }
    const sealed = sodium.crypto_box_seal(value, sodium.from_base64(key, sodium.base64_variants.ORIGINAL));
    await api(tok, 'PUT', `/repos/${owner}/${name}/actions/secrets/${secretName}`, {
      encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
      key_id,
    });
    // 只打印长度与首尾，绝不回显明文
    console.log(`  ✓ ${secretName}（${value.length} 字符）已写入`);
  }
}

async function status(tok, repo) {
  const [owner, name] = repo.split('/');
  console.log(`\n仓库：${repo}`);

  try {
    const p = await api(tok, 'GET', `/repos/${owner}/${name}/branches/main/protection`);
    console.log('\n分支保护（main）：');
    console.log(`  · 要求 PR：${p.required_pull_request_reviews ? '是' : '否'}` +
      (p.required_pull_request_reviews ? `（approvals=${p.required_pull_request_reviews.required_approving_review_count}）` : ''));
    console.log(`  · required checks：${(p.required_status_checks?.contexts ?? []).join(' | ') || '（空）'}`);
    console.log(`  · 禁止 force push：${p.allow_force_pushes?.enabled ? '否' : '是'}`);
    console.log(`  · 禁止删除分支：${p.allow_deletions?.enabled ? '否' : '是'}`);
    console.log(`  · 强制管理员遵守：${p.enforce_admins?.enabled ? '是' : '否'}`);
  } catch (e) {
    console.log(`\n分支保护：未配置或无权读取（${e.message}）`);
  }

  try {
    const s = await api(tok, 'GET', `/repos/${owner}/${name}/actions/secrets?per_page=100`);
    console.log(`\nSecrets（${s.total_count} 个，只列名字）：`);
    for (const item of s.secrets ?? []) console.log(`  · ${item.name}  更新于 ${item.updated_at}`);
  } catch (e) {
    console.log(`\nSecrets：无权读取（${e.message}）`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const repo = resolveRepo(opts.repo);
const tok = token();

switch (opts.mode) {
  case 'status':
    await status(tok, repo);
    break;
  case 'protect':
    await protect(tok, repo, opts);
    break;
  case 'secrets':
    await setSecrets(tok, repo, opts);
    break;
  default:
    fail(`未知模式：${opts.mode}（可用：status / protect / secrets）`);
}

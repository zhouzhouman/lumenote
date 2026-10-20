/**
 * 在测试里执行 `tsx prisma/seed.ts`（与 CI / 部署时同一条命令）。
 *
 * 用子进程而不是把 seed 逻辑 import 进来：
 *  1. seed.ts 顶层会 `loadEnv()` 并 `main()`，直接 import 会污染测试进程；
 *  2. 集成测试要验证的正是「这条命令能否被安全地重复执行」，
 *     而不是「函数能否复用」。
 */
import { spawnSync } from 'node:child_process';
import { projectRoot, resolveDatabaseUrl, resolveDirectUrl, tsxCliPath } from './config';

export interface SeedRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runSeed(): SeedRunResult {
  const root = projectRoot();
  const result = spawnSync(process.execPath, [tsxCliPath(root), 'prisma/seed.ts'], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: resolveDatabaseUrl(),
      DIRECT_URL: resolveDirectUrl(),
      NODE_ENV: 'development',
    },
    encoding: 'utf8',
    timeout: 180_000,
  });

  if (result.error) {
    throw new Error(`seed 子进程启动失败：${result.error.message}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

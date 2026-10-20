/**
 * 测试进程里的被测应用地址。
 *
 * 地址由 globalSetup 通过 `provide('integrationBaseUrl')` 传下来；
 * 同时兼容 `INTEGRATION_BASE_URL` 环境变量（复用外部服务的场景）。
 * 两种方式都拿不到时**直接报错**——静默回落到某个默认端口会让
 * 「测试跑在错误的实例上」这种问题看起来像业务 bug。
 */
import { inject } from 'vitest';

let cached: string | null = null;

export function baseUrl(): string {
  if (cached) return cached;

  let injected: unknown;
  try {
    injected = inject('integrationBaseUrl');
  } catch {
    injected = undefined;
  }

  const raw =
    (typeof injected === 'string' && injected.length > 0 ? injected : undefined) ??
    process.env.INTEGRATION_BASE_URL;

  if (!raw) {
    throw new Error(
      '缺少被测应用地址：globalSetup 没有运行（或没有 provide integrationBaseUrl）。' +
        '请通过 `pnpm test:integration` 启动，或设置 INTEGRATION_BASE_URL 复用外部服务。',
    );
  }

  cached = raw.replace(/\/+$/, '');
  return cached;
}

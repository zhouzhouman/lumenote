import { prisma } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 健康检查。部署平台的探活端点 + 外部监控（UptimeRobot 等）。
 *
 * 同时暴露熔断器状态 —— 这是比「进程活着」更有意义的健康信号：
 * 熔断打开说明上游出问题了，此时应用虽然能响应，但业务实际不可用。
 * 只检查「能返回 200」的监控会漏掉这种情况。
 */
export async function GET() {
  const startedAt = Date.now();

  let dbOk = false;
  let dbLatencyMs = 0;

  try {
    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - t0;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  // 熔断器快照。
  // ⚠️ 不能静态写死 provider 名：熔断器的 key 是 `${provider}:${model}`，
  // 写死名字只会读到初始状态，真正打开的熔断器永远不显示（见 breaker.ts 注释）。
  const { listBreakers, peekBreaker } = await import('@/lib/llm/breaker');
  const breakers = listBreakers()
    .map((name) => peekBreaker(name)?.snapshot())
    .filter((b): b is NonNullable<typeof b> => Boolean(b));

  // 数据库不通时返回 503，让平台知道服务不可用
  const status = dbOk ? 200 : 503;

  return Response.json(
    {
      status: dbOk ? 'ok' : 'degraded',
      db: { ok: dbOk, latencyMs: dbLatencyMs },
      breakers,
      uptimeSec: Math.round(process.uptime()),
      version: process.env.npm_package_version ?? 'dev',
      checkedAt: new Date().toISOString(),
      totalMs: Date.now() - startedAt,
    },
    {
      status,
      headers: {
        // 健康检查不应被任何一层缓存
        'Cache-Control': 'no-store',
      },
    },
  );
}
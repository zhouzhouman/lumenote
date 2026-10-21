import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Prisma 单例（**延迟创建**）。
 *
 * ## 为什么不能在模块顶层创建
 *
 * `next build` 在「收集页面数据」阶段会 import 每一个路由模块，而 import
 * 会执行模块顶层代码。若顶层就 `new PrismaClient()`，那么**任何没有数据库
 * 连接串的构建环境都会直接失败**（实测）：
 *
 *     Failed to collect configuration for /api/auth/refresh
 *     Error: DATABASE_URL 未配置，无法初始化 Prisma Client
 *       at src/lib/db.ts:19
 *
 * 构建期本来就不该连库 —— 它只需要读代码结构。把创建推迟到「第一次真正
 * 用 prisma」的时刻，构建就能在没有任何 env 的情况下完成。
 * 这与 `src/lib/env.ts` 的做法一致（那里也是延迟解析，注释写的是
 * 「避免 build 阶段因缺 env 直接崩溃」）。
 *
 * ## 为什么用 Proxy 而不是改成 getPrisma()
 *
 * 调用方有几十处 `import { prisma }` 后直接 `prisma.user.findMany()`。
 * 改成函数式取用（`getPrisma().user...`）要么全量改调用点，要么保留一个
 * 顶层就求值的导出（等于没改）。Proxy 让「导出的是一个对象」这件事保持不变，
 * 只在真正读取属性时才落库连接，调用点零改动。
 *
 * ## 单例与热重载
 *
 * Next.js 开发模式下模块会被反复热重载，每次热重载都 new 一个客户端会让
 * 连接池不断累积直到数据库拒绝连接。挂到 globalThis 上是标准解法：
 * 开发环境复用同一个实例，生产环境（模块只求值一次）走模块级缓存。
 *
 * Prisma ORM v7 不再从 schema 读连接串，改为通过 driver adapter 注入：
 * PrismaPg 包裹 node-postgres 的连接池，池大小由 max 明确指定 ——
 * 这比 v6 的内建池更可控，尤其在 Serverless 环境下（每个实例独立计数）。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** 模块级缓存：生产环境靠它保证「只建一次」 */
let cached: PrismaClient | null = null;

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // 这条错误只会在「真的要用数据库但没有连接串」时出现，
    // 不会在 build 阶段被触发 —— 那正是延迟创建要解决的问题。
    throw new Error('DATABASE_URL 未配置，无法初始化 Prisma Client');
  }

  // Serverless 单实例复用连接；开发环境放宽以适应热重载
  const max = process.env.VERCEL_ENV ? 1 : 5;
  const adapter = new PrismaPg({ connectionString: url, max });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

function instance(): PrismaClient {
  if (cached) return cached;

  cached = globalForPrisma.prisma ?? createClient();

  // 仅开发环境挂到 globalThis：热重载后还能拿到同一个实例
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = cached;
  }

  return cached;
}

/**
 * 对外导出的 `prisma` 是一个**惰性代理**：
 * 读任何属性（`prisma.user`、`prisma.$transaction`、`prisma.$queryRaw` …）
 * 时才真正建立连接。
 *
 * 注意 `bind`：Prisma 的方法是挂在实例上的，脱离实例调用会丢 `this`
 * （`prisma.$transaction` / `$queryRaw` 对 this 敏感），所以取到函数后
 * 必须绑定回真实客户端。
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = instance();
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

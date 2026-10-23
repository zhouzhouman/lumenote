import { z } from 'zod';

/**
 * 启动时环境变量校验。
 *
 * 设计取向：**缺失即启动失败**，而不是运行到一半才报错。
 * 过去把 env 校验放在某个 API 路由里，结果是「用户点了按钮才看到 500」；
 * 提前到启动期失败，能把配置问题暴露在部署日志里，而不是线上流量里。
 *
 * 注意：这里没有用 @t3-oss/env-nextjs，而是手写。原因是手写版本可以把
 * 「预览环境强制 mock LLM」这类业务规则直接写进解析逻辑，更直白也更好讲。
 */

const intFromEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().positive());

/**
 * 允许 0 的整数（例如「信任 0 层代理」）。
 *
 * 不能复用 intFromEnv：它要求 positive，而 0 是这里最有意义的取值。
 */
const nonNegativeIntFromEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(0));

const serverSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 不能为空'),
  DIRECT_URL: z.string().optional(),

  AUTH_SECRET: z.string().min(16, 'AUTH_SECRET 至少 16 字符，请用 openssl rand -base64 32 生成'),
  JWT_ACCESS_TTL_MINUTES: intFromEnv(15),
  JWT_REFRESH_TTL_DAYS: intFromEnv(7),

  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEFAULT_MODEL: z.string().default('deepseek-flash'),
  FALLBACK_MODEL: z.string().default('deepseek-v4-pro'),

  OPENAI_API_KEY: z.string().optional(),

  MOCK_LLM: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  FREE_DAILY_QUOTA: intFromEnv(20),
  RATE_LIMIT_PER_MINUTE: intFromEnv(10),

  // ---------- 限流后端（新增，全部可选）----------
  /**
   * 限流后端：`memory`（默认）| `redis`。
   *
   * memory = 进程内存，单实例/本地开发够用；重启即清零，多实例之间不共享。
   * redis  = 多实例共享计数（需要 REDIS_URL）。选择是**启动期**决定，运行中不热切换。
   */
  RATE_LIMIT_DRIVER: z
    .enum(['memory', 'redis'])
    .optional()
    .transform((v) => v ?? 'memory'),
  /** Redis 连接串。只有 RATE_LIMIT_DRIVER=redis 时才会真正连接 */
  REDIS_URL: z
    .string()
    .optional()
    .transform((v) => v?.trim() || 'redis://127.0.0.1:6379')
    .pipe(z.string().url()),
  /**
   * Redis 计数 key 前缀。
   *
   * 多个环境（生产/预发/本地）共用一个 Redis 时必须区分，否则计数会互相污染。
   */
  RATE_LIMIT_REDIS_PREFIX: z
    .string()
    .optional()
    .transform((v) => v?.trim() || 'lumenote:rl:'),
  /**
   * Redis 故障时的降级策略：`open`（默认）| `closed`。
   *
   * - open：本次请求降级到进程内存限流，记录 warn，业务不中断。
   *   代价是故障期间多实例限流退化为「每实例限流」，比完全放行严格，但弱于全局。
   * - closed：拒绝本次请求（调用方按 429 处理）。安全优先、可用性让位，
   *   适用于「宁可全站拒绝，也不能让限流失效」的场景。
   *
   * ⚠️ 两种模式都不会把异常抛到业务层。closed 的返回是明确的 ok:false。
   */
  RATE_LIMIT_FAIL_MODE: z
    .enum(['open', 'closed'])
    .optional()
    .transform((v) => v ?? 'open'),
  /**
   * 可信反向代理层数（X-Forwarded-For 信任边界）。
   *
   * 0（默认）= 不信任任何转发头：XFF / x-real-ip 一律忽略，返回常量 `unknown`。
   *   此时所有请求共享一个「unknown」桶 —— 无法被伪造绕过，但多客户端会互相挤占。
   * N > 0  = 从 XFF 右往左数第 N 个地址作为客户端 IP（客户端在最左，代理逐跳追加）。
   *   nginx 单层代理通常设 1；Cloudflare + nginx 两层设 2。
   *
   * ⚠️ 设置 N > 0 的前提：应用端口只对可信代理开放（否则直连者可以伪造 XFF）。
   */
  TRUST_PROXY_HOPS: nonNegativeIntFromEnv(0),

  MAX_CONCURRENT_TASKS_PER_USER: intFromEnv(1),

  MAX_INPUT_CHARS: intFromEnv(100_000),
  FETCH_TIMEOUT_MS: intFromEnv(15_000),
  FETCH_MAX_BYTES: intFromEnv(5_000_000),
  FETCH_ALLOWED_HOSTS: z.string().default(''),

  /**
   * 用户自带 API Key（BYOK）开关。
   *
   * 默认开：这是一个对用户有利的能力，默认关会让人以为「没做这个功能」。
   * 但对内网部署或受合规约束的场景，运维可能要求禁止用户把 key 交给本站，
   * 因此留一个明确的开关，而不是硬编码。
   */
  ALLOW_USER_CREDENTIALS: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),

  /**
   * 是否允许自定义接口地址（中转网关 / 自建端点）。
   * 关闭后只能用内置服务商的官方地址；内网与云元数据地址**任何情况下**都拦截。
   */
  ALLOW_CUSTOM_BASE_URL: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),

  // ---------- 邮件（注册验证码）----------
  /**
   * 邮件通道：console | resend | smtp。
   *
   * console 不发信，只把验证码打到服务端日志、并在**非生产环境**回传给页面
   * （默认值，便于本地开发）。生产环境用 console 会导致用户收不到码，
   * 因为代码里硬性禁止把验证码回传给客户端 —— 必须换成 resend 或 smtp。
   */
  MAIL_TRANSPORT: z.string().optional(),
  MAIL_FROM: z.string().default('Lumenote <no-reply@lumenote.local>'),
  RESEND_API_KEY: z.string().optional(),

  /**
   * 注册时是否要求验证邮箱。
   *
   * **默认关闭**（因为这个项目的目标场景是内网部署，很多内网没有可用邮件通道，
   * 强制验证会把所有新用户挡在门外）。
   *
   * 关闭后注册只需「账号 + 密码」—— 代价是**无法确认邮箱真实性**：
   * 人可以填别人的邮箱。所以此时唯一的防线是 IP 限流与密码强度，
   * 这一点写进 README 已知限制，不假装它和「验证过」等价。
   */
  REQUIRE_EMAIL_VERIFICATION: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // ---------- 内网 SMTP（MAIL_TRANSPORT=smtp）----------
  /**
   * 中继地址。填了就通过这台 SMTP 服务器投递（企业邮箱 / Exchange / postfix）。
   * `SMTP_DIRECT=true` 时可以留空 —— 此时按收件人域名的 MX 记录直投。
   */
  SMTP_HOST: z.string().optional(),
  /** 缺省按端口约定推断：465 → 直连 TLS，其余 → 587 明文 + STARTTLS */
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  /** 'true' / 'false' 显式指定是否直连 TLS；不填则按端口推断 */
  SMTP_SECURE: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** 发件人地址；缺省回落到 MAIL_FROM */
  SMTP_FROM: z.string().optional(),
  /**
   * 是否校验服务器证书。内网自签证书（很多企业内部中继都是）需要设为 false。
   *
   * 默认 true：放宽 TLS 校验会让人在公网环境下也悄悄失去中间人防护，
   * 这种「为了方便顺手关掉」的默认值不该由我们来定。
   */
  SMTP_REJECT_UNAUTHORIZED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  /**
   * true = 不走中继，直接投递到收件人域名的 MX。
   *
   * ⚠️ 要求出站 25 端口可用，且收件方 DNS 里能查到 MX。
   * 家宽/办公网普遍封 25，云主机默认也封 —— 所以这是「内网同域直投」用的，
   * 不是绕过公网邮件服务商的手段。
   */
  SMTP_DIRECT: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // ---------- 登录安全 ----------
  /** 连续失败多少次后锁定账号（设为 0 关闭锁定，仅保留限流） */
  LOGIN_MAX_FAILURES: intFromEnv(5),
  /** 锁定时长（分钟） */
  LOGIN_LOCKOUT_MINUTES: intFromEnv(15),

  CHUNK_SIZE_TOKENS: intFromEnv(1200),
  CHUNK_OVERLAP_TOKENS: intFromEnv(100),
  CHUNK_CONCURRENCY: intFromEnv(3),

  // ---------- Agent 护栏 ----------
  /**
   * Agent 任务的默认步数上限。
   *
   * 用户可以在工作台选 6/12/20，这是**默认值**与**硬上限的来源**。
   * 数值的取舍：12 步对一篇文档问答通常够用（1 次看结构 + 若干次检索 +
   * 1 次收敛），再高主要是给"文档特别散"的场景留余量。
   */
  AGENT_MAX_STEPS: intFromEnv(12),
  /**
   * Agent 任务的 token 预算上限。
   *
   * 这是**双预算**的另一半。只用步数限制不住成本：
   * 一步里如果工具返回了很长的内容，token 可以涨得比步数快得多。
   * 60k 的取值参考：一份 1.2k token 的文档分块，加上 12 轮对话与工具结果，
   * 正常落在 10k~30k 区间；60k 给足余量但能兜住异常。
   */
  AGENT_MAX_TOKENS: intFromEnv(60_000),
});

export type ServerEnv = z.infer<typeof serverSchema>;

function load(): ServerEnv {
  const parsed = serverSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `环境变量校验失败，请检查 .env.local（参考 .env.example）：\n${issues}\n\n` +
        'AUTH_SECRET 可用 openssl rand -base64 32 生成。',
    );
  }

  const env = parsed.data;

  /**
   * Mock 判定规则：
   *  1. 显式 MOCK_LLM=true → 开
   *  2. 预览环境（Vercel 的 VERCEL_ENV !== 'production'）→ 强制开
   *
   * 第2 条很关键：预览环境每次 push 都会自动部署，如果那里跑真实 LLM 请求，
   * 仅仅"试一下部署"就会持续烧钱。这是 AI 项目特有的部署陷阱。
   */
  const isPreview = process.env.VERCEL_ENV !== undefined && process.env.VERCEL_ENV !== 'production';
  const mock = env.MOCK_LLM || isPreview;

  if (!mock && !env.DEEPSEEK_API_KEY && !env.OPENAI_API_KEY) {
    throw new Error(
      '未配置任何 LLM API Key。请设置 DEEPSEEK_API_KEY，或将 MOCK_LLM=true 以使用本地模拟模式。',
    );
  }

  return { ...env, MOCK_LLM: mock } as ServerEnv;
}

/** 延迟解析：避免 build 阶段因缺 env 直接崩溃（build 时环境变量尚未注入） */
let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) return cached;
  cached = load();
  return cached;
}

/** 允许的抓取主机白名单（空数组 = 不限制） */
export function fetchAllowedHosts(): string[] {
  return env()
    .FETCH_ALLOWED_HOSTS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
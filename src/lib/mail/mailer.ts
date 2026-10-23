import { env } from '@/lib/env';

/**
 * 邮件发送通道。
 *
 * ## 为什么做成可插拔
 *
 * 开发阶段不该被「邮箱服务商账号」卡住，但生产又必须真发信 ——
 * 这两种需求对应完全不同的实现。把它们收敛到一个接口后面，
 * 换通道就只是换一个环境变量，业务代码（注册流程）一行都不用动。
 *
 * 三种通道：
 *  - `console`：不发信，验证码打日志（**仅非生产可用**）。无任何外部依赖。
 *  - `resend` ：调 Resend HTTP API，只需一个 API Key，无需 SMTP 配置。
 *  - `smtp`   ：走标准 SMTP（QQ/163/企业邮箱都行）。
 *
 * ## 一个刻意的设计：send 返回可选的 devCode
 *
 * `console` 通道会把验证码回传给调用方，供非生产环境在界面上直接显示，
 * 省掉「去翻服务端日志」这一步。生产环境这条路被硬性堵死
 * （见下方 assertNotProductionLeak），因为那等于把验证码公开给任何人。
 */

export type MailTransport = 'console' | 'resend' | 'smtp';

export interface SendMailInput {
  to: string;
  subject: string;
  /** 纯文本正文。本项目不追求花哨的 HTML 邮件 —— 纯文本反而更难被判成垃圾邮件 */
  text: string;
}

export interface SendMailResult {
  ok: boolean;
  transport: MailTransport;
  /**
   * 邮件是否**真的**发出去了。
   *
   * 为什么不能只看 ok：`console` 通道会「成功」返回（内容打到日志里），
   * 但一封邮件都没发。调用方若把 ok 当成「已送达」，就会对着一个
   * 没配邮件通道的部署说「验证码已发送，请查收邮件」——用户永远等不到。
   * 这个字段就是用来区分「发信成功」与「只是记了个日志」的。
   */
  delivered: boolean;
  /** 仅 console 通道且非生产环境返回；调用方可据此在页面上提示 */
  devCode?: string;
  error?: string;
}

export function mailTransport(): MailTransport {
  const raw = (env().MAIL_TRANSPORT ?? 'console').trim().toLowerCase();
  if (raw === 'resend' || raw === 'smtp') return raw;
  return 'console';
}

/**
 * 生产环境绝不允许把验证码回传给客户端。
 *
 * 这不是「最好别这样」，而是**必须拦住**：一旦泄露，
 * 任何人只要知道邮箱就能完成注册/改密，验证码环节等于不存在。
 * 所以这里直接改写成失败，而不是打个警告继续。
 */
function assertNotProductionLeak(devCode: string | undefined): string | undefined {
  if (!devCode) return undefined;
  if (process.env.NODE_ENV === 'production') {
    console.error(
      '[mailer] 生产环境禁止回传验证码（会把验证环节变成摆设）。' +
        '请配置 MAIL_TRANSPORT=resend 或 smtp 以真实发信。',
    );
    return undefined;
  }
  return devCode;
}

export async function sendMail(input: SendMailInput, devCode?: string): Promise<SendMailResult> {
  const transport = mailTransport();
  const from = env().MAIL_FROM;

  try {
    switch (transport) {
      case 'resend':
        return await sendViaResend(from, input, devCode);
      case 'smtp':
        return await sendViaSmtp(from, input, devCode);
      default:
        return sendViaConsole(input, devCode);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[mailer] 通过 ${transport} 发送失败：`, message);
    return { ok: false, transport, delivered: false, error: message };
  }
}

/**
 * 控制台通道：把邮件内容打到服务端日志，并把验证码回传给调用方。
 *
 * 为什么打印完整正文而不是只打印验证码：方便核对文案与排版，
 * 这在做「发信前先自查一遍」时很有用。
 */
function sendViaConsole(input: SendMailInput, devCode?: string): SendMailResult {
  console.info(
    [
      '',
      '──────────── 邮件（console 通道，未真实发送）────────────',
      `收件人: ${input.to}`,
      `主题:   ${input.subject}`,
      '',
      input.text,
      '─────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );

  // console 通道：日志里有，邮箱里没有
  return { ok: true, transport: 'console', delivered: false, devCode: assertNotProductionLeak(devCode) };
}

/** Resend：直接调 HTTP API，不引 SDK（少一个依赖，行为也更透明） */
async function sendViaResend(
  from: string,
  input: SendMailInput,
  devCode?: string,
): Promise<SendMailResult> {
  const apiKey = env().RESEND_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      transport: 'resend',
      delivered: false,
      error: '未配置 RESEND_API_KEY（MAIL_TRANSPORT=resend 时必须提供）',
    };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      text: input.text,
    }),
    // 邮件发送不该拖住注册请求太久；10s 足够，超时就当失败让用户重试
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      transport: 'resend',
      delivered: false,
      error: `Resend 返回 ${res.status}：${body.slice(0, 200)}`,
    };
  }

  return { ok: true, transport: 'resend', delivered: true, devCode: assertNotProductionLeak(devCode) };
}

/**
 * SMTP 通道 —— 面向**内网部署**的真实发信。
 *
 * 典型场景：公司内网有一台中继（Exchange / 企业邮箱 / postfix），
 * 或者整个环境根本不连公网，只希望同一网段的人能收到验证码。
 * 这两种情况都不该依赖 Resend（它需要出站 HTTPS 到 api.resend.com）。
 *
 * ## 为什么用 nodemailer 而不是手写
 *
 * SMTP 看起来只是「连上去发几行文本」，实际要处理：明文/STARTTLS/直连 TLS 协商、
 * AUTH 机制选择（PLAIN/LOGIN/CRAM-MD5）、MIME 与中文编码、多行响应码、
 * 超时与连接复用。手写出来的版本通常能跑通 happy path，然后在某个企业邮箱上
 * 静默失败。协议实现引入成熟库是划算的。
 *
 * ## 配置形态（三选一）
 *
 *   1. 内网中继：SMTP_HOST + 端口（+ 账号）
 *   2. 直投 MX：SMTP_DIRECT=true（需要出站 25 端口，通常只在内网同域可用）
 *   3. 自签证书中继：额外 SMTP_REJECT_UNAUTHORIZED=false
 */

export interface SmtpConfigInput {
  host?: string;
  port?: number;
  secure?: string;
  user?: string;
  pass?: string;
  rejectUnauthorized?: boolean;
  direct?: boolean;
}

export interface SmtpTransportOptions {
  host?: string;
  port: number;
  secure: boolean;
  direct: boolean;
  tls: { rejectUnauthorized: boolean };
  auth?: { user: string; pass: string };
  /** 连接/握手/读写超时：配错地址时不该把请求吊死几十秒 */
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}

export type SmtpConfigResult =
  | { ok: true; options: SmtpTransportOptions }
  | { ok: false; error: string };

/**
 * 由环境变量推出 nodemailer 的连接参数。
 *
 * 抽成纯函数是为了能单测：端口/加密/证书校验这些「配错就静默不可用」的
 * 分支，靠人肉点一遍是测不全的。
 */
export function smtpTransportOptions(input: SmtpConfigInput): SmtpConfigResult {
  const direct = input.direct === true;
  const host = input.host?.trim() || undefined;

  if (!direct && !host) {
    return {
      ok: false,
      error:
        'SMTP 通道缺少 SMTP_HOST。请填写内网中继地址（如 mail.intra.local:25），' +
        '或设 SMTP_DIRECT=true 直投收件域 MX。',
    };
  }

  // 账号与密码必须成对出现：只给用户名会让上游回 535，报错信息还看不出是配漏了
  const user = input.user?.trim() || undefined;
  const pass = input.pass ?? '';
  if (user && !input.pass) {
    return { ok: false, error: '配置了 SMTP_USER 但没有 SMTP_PASS（内网无认证中继请两个都留空）' };
  }

  // 端口与加密方式的约定：465 = 直连 TLS；25/587 = 明文连接后按需 STARTTLS
  const explicitSecure =
    input.secure === 'true' ? true : input.secure === 'false' ? false : undefined;
  const port = input.port ?? (direct ? 25 : explicitSecure === false ? 587 : 587);
  const secure = explicitSecure ?? port === 465;

  return {
    ok: true,
    options: {
      ...(host ? { host } : {}),
      port,
      secure,
      direct,
      tls: { rejectUnauthorized: input.rejectUnauthorized !== false },
      ...(user ? { auth: { user, pass } } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    },
  };
}

async function sendViaSmtp(
  from: string,
  input: SendMailInput,
  devCode?: string,
): Promise<SendMailResult> {
  const e = env();
  const config = smtpTransportOptions({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_SECURE,
    user: e.SMTP_USER,
    pass: e.SMTP_PASS,
    rejectUnauthorized: e.SMTP_REJECT_UNAUTHORIZED,
    direct: e.SMTP_DIRECT,
  });

  if (!config.ok) {
    return { ok: false, transport: 'smtp', delivered: false, error: config.error };
  }

  const sender = e.SMTP_FROM?.trim() || from;

  try {
    // 动态 import：只有真正走 SMTP 时才把 nodemailer 载入（console/resend 部署不需要它）
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport(config.options);

    try {
      await transporter.sendMail({
        from: sender,
        to: input.to,
        subject: input.subject,
        text: input.text,
      });
    } finally {
      // 发送完主动关闭连接池：验证码是低频动作，留着连接只会占住上游的会话数
      transporter.close?.();
    }

    return {
      ok: true,
      transport: 'smtp',
      delivered: true,
      devCode: assertNotProductionLeak(devCode),
    };
  } catch (err) {
    /*
     * 错误信息要能定位问题，但**不能带密码**。
     * nodemailer 的报错包含 host/port/响应码，不含 auth 凭据，所以可以透出；
     * 这里再做一次兜底替换，防止上游把 AUTH 行回显进错误里。
     */
    const raw = err instanceof Error ? err.message : String(err);
    const safe = e.SMTP_PASS ? raw.split(e.SMTP_PASS).join('***') : raw;

    return {
      ok: false,
      transport: 'smtp',
      delivered: false,
      error: `SMTP 发送失败（${config.options.direct ? '直投 MX' : `${config.options.host}:${config.options.port}`}）：${safe.slice(0, 300)}`,
    };
  }
}

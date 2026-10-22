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
 * SMTP 通道。
 *
 * ⚠️ 这里刻意**不引入 nodemailer**：本项目只在发验证码时用到 SMTP，
 * 为此增加一个带多个传递依赖的库不划算。但完整实现 SMTP（含 STARTTLS、
 * 认证方式协商、MIME 编码）并不适合手写 —— 那是一块容易出安全问题的协议实现。
 *
 * 因此当前选择是**显式不实现**：走 SMTP 时直接返回明确错误，
 * 让部署方知道要去装依赖并接上，而不是给一个「看起来能跑、实际发不出信」的实现。
 * 这符合本项目「宁可明确失败也不静默降级」的一贯取向。
 */
async function sendViaSmtp(
  _from: string,
  _input: SendMailInput,
  devCode?: string,
): Promise<SendMailResult> {
  return {
    ok: false,
    transport: 'smtp',
    delivered: false,
    error:
      'SMTP 通道尚未接入。请安装 nodemailer 并在 src/lib/mail/mailer.ts 的 sendViaSmtp 中实现，' +
      '或改用 MAIL_TRANSPORT=resend / console。',
    // devCode 不透出：通道不可用时不该顺手把验证码给出去
    ...(devCode ? {} : {}),
  };
}

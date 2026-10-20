/**
 * 分享链接的有效性判断（**纯函数**）。
 *
 * ## 为什么单独抽出来
 *
 * 抽出来的直接原因是 `react-hooks/purity` 规则：它禁止在组件渲染期间调用
 * `Date.now()` 这类「非纯」函数。这个规则本身是对的（渲染函数应当可被重复调用
 * 而结果稳定），但它把「分享链接是否过期」这个**纯判断逻辑**一起挡在了组件里。
 *
 * 正确的处理不是加一行 eslint-disable，而是把逻辑挪到它本该在的地方：
 * 「给定有效期与当前时间，链接是否有效」是一个纯函数，
 * 只是需要把「当前时间」作为参数传入 —— 这也顺带让它变得可单测
 * （不用 mock 系统时钟）。
 */

export interface ShareLinkValidity {
  /** 是否可访问 */
  valid: boolean;
  /** 不可访问的原因（用于服务端日志，不返回给客户端） */
  reason?: 'revoked' | 'expired' | 'task_deleted';
}

export interface ShareLinkState {
  revokedAt: Date | null;
  expiresAt: Date | null;
  taskDeletedAt: Date | null;
}

/**
 * 判断一条分享链接当前是否可访问。
 *
 * ⚠️ 任何一条不满足都必须视为「不可访问」，且调用方对外统一返回 404 ——
 * 不区分「不存在 / 已撤销 / 已过期 / 任务已删」，否则状态码差异
 * 就成了「这个 token 曾经有效」的探测手段。
 *
 * @param state 链接与所属任务的状态
 * @param now   当前时间（显式传入以便单测）
 */
export function checkShareLink(
  state: ShareLinkState,
  now: Date = new Date(),
): ShareLinkValidity {
  if (state.revokedAt) return { valid: false, reason: 'revoked' };

  // expiresAt 为 null 表示永不过期 —— 这是刻意支持的选项，
  // 判断时必须用显式的 null 检查，不能写成 `expiresAt < now`
  // （null 参与比较会隐式转成 0，反而把「永不过期」判成「早已过期」）
  if (state.expiresAt && state.expiresAt.getTime() <= now.getTime()) {
    return { valid: false, reason: 'expired' };
  }

  // 任务被软删后链接必须失效，否则「删除」就成了假动作
  if (state.taskDeletedAt) return { valid: false, reason: 'task_deleted' };

  return { valid: true };
}

/**
 * 生成分享 token。
 *
 * 用 32 字节密码学随机数而不是 cuid / 自增 id：
 * 分享链接是**公开可访问**的，可枚举就意味着所有人都能看到所有人的内容。
 * 32 字节 base64url 约 43 字符，暴力枚举在算力上不可行。
 */
export function isValidShareTokenShape(token: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(token);
}

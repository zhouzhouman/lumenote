/**
 * 密码强度评估（**纯函数，无任何依赖**）。
 *
 * ## 为什么单独一个文件，而不是和 password.ts 放一起
 *
 * `password.ts` 里 import 了 bcryptjs —— 那是服务端才需要的哈希实现，
 * 体积约 30KB，而且模块顶层会 `bcrypt.hashSync()` 算一个假比对哈希（约 250ms）。
 * 注册页需要在**浏览器里**实时显示强度条，如果从 password.ts 导入，
 * 整个 bcryptjs 就会被打进客户端 bundle：用户为了看一眼强度条，
 * 要先下载并执行一遍 KDF。
 *
 * 拆成零依赖的纯模块，前端只拿这几十行逻辑。
 *
 * ## 为什么不引入 zxcvbn
 *
 * zxcvbn 会检测字典词、键盘序列、l33t 变形，准确性确实好得多，
 * 但代价是约 800KB 的字典数据。对这个项目来说，
 * 「长度 + 字符种类 + 高频弱口令黑名单 + 连号/重复」已能覆盖绝大多数真实弱密码，
 * 而体积几乎为零。这是记录在案的有意取舍 ——
 * 若面向真实用户上线，应换成 zxcvbn（前端按需加载）。
 */

export interface PasswordStrength {
  /** 0-4，与注册页强度条的 5 档一一对应 */
  score: 0 | 1 | 2 | 3 | 4;
  level: '很弱' | '弱' | '一般' | '强' | '很强';
  /** 可操作的改进建议（中文），而不是「请加强密码」这种废话 */
  hints: string[];
}

/**
 * 常见弱口令片段。
 *
 * 这是「最低成本、最高收益」的一层：真实泄露库里排名靠前的密码
 * 几乎都含这些片段。全部匹配显然不现实，只挡最高频的即可。
 */
const COMMON_WEAK_PATTERNS = [
  /123456/i,
  /password/i,
  /qwerty/i,
  /admin/i,
  /letmein/i,
  /welcome/i,
  /iloveyou/i,
  /monkey/i,
  /dragon/i,
  /abc123/i,
  /111111/,
  /000000/,
  /888888/,
  /666666/,
  /woaini/i,
  /5201314/,
];

/**
 * 评分逻辑：长度权重最高（这是唯一真正有效的维度），字符种类次之，
 * 再对「纯数字」「纯字母」「常见弱口令」「连号/重复」扣分。
 */
export function assessPasswordStrength(pw: string): PasswordStrength {
  if (!pw) return { score: 0, level: '很弱', hints: ['请输入密码'] };

  const hints: string[] = [];
  let score = 0;

  // 长度
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (pw.length >= 16) score += 1;
  if (pw.length < 8) hints.push('至少 8 位，越长越安全');

  // 字符种类
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length;
  if (kinds >= 2) score += 1;
  if (kinds >= 3) score += 1;
  if (kinds < 2) hints.push('混合使用大小写字母、数字与符号');

  // 扣分项：真实弱密码的典型形态
  if (/^\d+$/.test(pw)) {
    score -= 2;
    hints.push('不要只用数字');
  }
  if (/^[a-zA-Z]+$/.test(pw)) {
    score -= 1;
    hints.push('只含字母的密码容易被字典攻击');
  }
  if (COMMON_WEAK_PATTERNS.some((re) => re.test(pw))) {
    score -= 2;
    hints.push('包含常见弱口令片段（如 123456、qwerty、password、admin）');
  }
  if (/(.)\1{2,}/.test(pw)) {
    score -= 1;
    hints.push('避免连续重复字符');
  }
  if (/(?:abc|bcd|cde|def|123|234|345|456|567|678|789|890)/i.test(pw)) {
    score -= 1;
    hints.push('避免键盘顺序或数字连号');
  }
  if (/^(19|20)\d{2}/.test(pw) || /\d{4}$/.test(pw)) {
    hints.push('避免用年份、生日等易猜信息');
  }

  const clamped = Math.max(0, Math.min(4, score)) as 0 | 1 | 2 | 3 | 4;
  const level = (['很弱', '弱', '一般', '强', '很强'] as const)[clamped]!;

  return { score: clamped, level, hints };
}

/**
 * 基础规则校验（服务端**必须**再校验一遍）。
 *
 * 前端调用它只是为了即时反馈；真正的准入判断在 register 接口里，
 * 因为前端校验永远可以被绕过（直接调 API 即可）。
 */
export function validatePasswordStrength(pw: string): { ok: boolean; reason?: string } {
  if (pw.length < 8) return { ok: false, reason: '密码至少 8 位' };
  if (pw.length > 128) return { ok: false, reason: '密码过长' };
  if (!/[a-zA-Z]/.test(pw) && !/[一-鿿]/.test(pw)) {
    return { ok: false, reason: '密码需包含字母或中文' };
  }
  if (!/\d/.test(pw) && !/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(pw)) {
    return { ok: false, reason: '密码需包含数字或符号' };
  }
  return { ok: true };
}

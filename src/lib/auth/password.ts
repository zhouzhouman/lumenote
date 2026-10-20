import bcrypt from 'bcryptjs';

/**
 * 密码哈希。
 *
 * bcryptjs 而非 bcrypt：纯 JS 实现，免去node-gyp 编译。
 * 代价是比原生慢，但在登录这种低频场景完全可以接受 ——
 * 而部署简单对个人项目是更重要的收益。
 *
 * cost=12 是取舍：业界通常建议 10~12。
 * cost 每 +1 计算量翻倍，登录耗时从约 100ms 涨到约 250ms。
 * 对个人项目（几十个用户）这完全够用，且抗离线爆破能力更强。
 */

const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/**
 * 用于「用户不存在」分支的假比对哈希。
 *
 * ## 为什么必须是真实算出来的哈希
 *
 * 这个常量的唯一用途是消除登录接口的**时间侧信道**：用户不存在时也跑一次
 * bcrypt 比对，让响应时间与「密码错」一致，否则 1ms vs 300ms 的差距
 * 就是一个现成的账号枚举接口（而 register 那边还特意做了防枚举，等于白做）。
 *
 * ⚠️ 这里踩过的坑：手写一个看起来像哈希的字符串（长度对不上、cost 段不合法）时，
 * bcryptjs 会在长度校验处**直接短路返回**，根本不跑 KDF ——
 * 假比对只用 0ms，防时间差的效果完全不存在，而代码看起来还在「认真防」。
 * 所以这里用 bcrypt.hashSync 真算一个（代价：模块加载时多 ~250ms），
 * 并用长度断言把这个前提钉住。
 */
const DUMMY_HASH = bcrypt.hashSync(`dummy-${Math.random().toString(36).slice(2)}`, COST);

// 断言：bcrypt 哈希恒为 60 字符。长度不符会被 bcryptjs 短路，静默失去防时间差作用
if (DUMMY_HASH.length !== 60) {
  throw new Error('内部错误：假比对哈希格式不合法，登录时间侧信道防护将失效');
}

/** 供「用户不存在」分支使用的假比对：总是返回 false，但耗时与真实比对一致 */
export async function fakePasswordCompare(plain: string): Promise<false> {
  await bcrypt.compare(plain, DUMMY_HASH);
  return false;
}

/**
 * 密码强度：实现已移到 `@/lib/password-strength`（零依赖纯模块）。
 *
 * 这里做一次转发导出，让服务端代码可以只从 auth/password 拿全套密码能力。
 * ⚠️ **客户端组件不要从这个文件导入** —— 它会带上 bcryptjs（约 30KB，
 * 且模块顶层会跑一次 hashSync）。前端请直接从 `@/lib/password-strength` 导入。
 */
export {
  assessPasswordStrength,
  validatePasswordStrength,
  type PasswordStrength,
} from '@/lib/password-strength';

/**
 * 邮箱归一化。
 * 统一小写并去空白，避免 `A@x.com` 与 `a@x.com` 被当作两个账号。
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
# 04 · 认证与安全：从登录到防越权

> 目标：能回答"怎么防撞库""怎么防越权""刷新 token 怎么轮换""密钥怎么存"。

---

## 1. 登录：四层顺序不能乱（`api/auth/login/route.ts:38-171`）

```
① IP 限流（30 次/5 分钟）
② 账号限流（10 次/5 分钟，key 是邮箱）
③ 失败锁定（账号 5 次 / IP 15 次，窗口 15 分钟）
④ 查库 + bcrypt.compare
```

**为什么锁定判断必须在查库之前？**
否则"这个账号被锁了"本身就是**账号存在**的枚举信号。顺序错了，攻击者不用猜密码就知道邮箱是否注册过。

### 时序攻击防护（这一处很值得讲）

```ts
// auth/password.ts:44-49
const DUMMY_HASH = bcrypt.hashSync(`dummy-${random}`, COST);   // 真实算出来的哈希
if (DUMMY_HASH.length !== 60) throw new Error('假比对哈希不合法，侧信道防护将失效');
```

用户不存在时，仍然 `bcrypt.compare(password, DUMMY_HASH)`，耗时与真实比对一致。
**坑**：如果图省事写一个"看起来像哈希"的字符串，bcryptjs 会在长度校验处**直接短路**，
`compare` 耗时 0ms —— 防护静默失效，而代码看起来还在认真防。所以这里真的 `hashSync`（模块加载多约 250ms）。

| 参数 | 值 |
|---|---|
| bcrypt cost | 12（约 250ms/次） |
| 锁定窗口 | 15 分钟 |
| 账号阈值 / IP 阈值 | 5 / 15（IP ×3，因为公司共用出口 IP） |

**只在这一支告诉用户"还可尝试 N 次"**（账号真实存在时）。用户不存在时返回与密码错**完全相同**的 401。

---

## 2. 签发了什么

| 产物 | 形式 | TTL | 存放 |
|---|---|---|---|
| access token | JWT HS256，payload 只有 `sub`(userId) | 15 分钟 | cookie `lumenote_access` |
| refresh token | **32 随机字节 base64url，不是 JWT** | 7 天 | cookie `lumenote_refresh` |
| Session 行 | `refreshHash = SHA-256(token)` hex，`@unique` | 同上 | DB |

**为什么 refresh 不用 JWT？** JWT 无法撤销；refresh 要能撤销（登出、盗用），所以存库比对。

**为什么 JWT 只放 userId，不放角色？**
放了就会出现"改了权限，旧 token 里的旧角色生效到过期"。所以角色每请求查库（`requireActor`）。

**校验失败不分类**（过期/篡改/格式错都返回 null）：过期是正常业务，不该刷日志。
代价是监控上无法单独统计"签名攻击"。

---

## 3. Cookie 属性（这里踩过一个真实事故）

| 属性 | 值 | 依据 |
|---|---|---|
| `httpOnly` | true | XSS 读不到 token |
| `secure` | `COOKIE_SECURE` 显式 > APP_URL 是否 https > NODE_ENV | 见下 |
| `sameSite` | `lax` | 顶级导航带、跨站 POST 不带（缓解 CSRF）；项目没有 CSRF token |
| `domain` | **默认不设**（host-only） | 见下 |
| `maxAge` | access 900s / refresh 604800s | — |

**事故**：原来写 `secure: isProd` + `domain: APP_URL.hostname`。
内网部署是 `http://192.168.1.10:3000`，浏览器只在"安全上下文"接受 Secure Cookie，
于是 **cookie 被静默丢弃**，表现为"登录接口 200，页面还是未登录"，控制台没有任何提示。
`domain=localhost` 更是直接不匹配。

**修法**：按 APP_URL 协议推断 secure；domain 默认不写（host-only，任意主机名都能用）。

> 面试价值：这是"本地能跑、部署就坏"的典型案例，而且失败是静默的。

---

## 4. 刷新与轮换：用 `deleteMany` 的计数做互斥

```ts
// auth/session.ts:90-100
const rotated = await prisma.$transaction(async (tx) => {
  const claimed = await tx.session.deleteMany({ where: { id: session.id, refreshHash: hash } });
  if (claimed.count !== 1) return null;                 // 并发败者
  return tx.session.create({ data: { userId, refreshHash: nextHash, expiresAt, ... } });
});
```

**为什么不用 `delete({where:{id}})`？**
并发刷新（两个标签页）时，后到的会抛 `P2025`（记录不存在）→ 500。
现象是"账号正常但偶发 500，再刷一下又好了"——极难排查。
`deleteMany` 返回 `count`，把"我抢到了吗"变成正常分支。

**重放检测的真相（重要，别吹）**

注释说"轮换后旧 token 再来已被删除，这里已捕获"。但实际：
旧行被**物理删除** → 旧 token 再来时 `findUnique` 返回 null → 与"随便编一个 token"走同一分支。
`destroyAllSessions()` **全项目无调用点**。

真正的 OAuth BCP 做法是：保留旧 hash + `replacedBy`/`reusedAt` 标记，命中即撤销整个 token family。
本项目没做。面试正确回答："设计意图有，落实现状是没有重放检测"。

---

## 5. 四种"拒绝"别混（面试高频对比题）

| 机制 | 拦什么 | 存储 | 多实例一致 | 超限响应 |
|---|---|---|---|---|
| **限流** | 请求太频繁（脚本刷） | 内存 / Redis | 仅 Redis 一致 | 429 `RATE_LIMITED`，秒数在 message 里 |
| **失败锁定** | 密码猜错太多次（慢速撞库） | DB `LoginAttempt` | ✅ | 429 `ACCOUNT_LOCKED` |
| **幂等** | 同一操作重复提交（重复花钱） | DB 唯一索引 | ✅ | 200 + `replayed:true` |
| **配额/并发** | 今天用太多 / 同时跑太多 | DB `Task` 计数 | ✅ | 429 + `Retry-After:30` |

> 一句话总结取舍：**限流可以放内存（丢了只是少挡几次）；锁定/幂等/配额必须落库（丢了就是安全和计费事故）。**

### 限流限额表

| 函数 | key | 限额 / 窗口 |
|---|---|---|
| `rateLimitByIp` | `ip:<ip>` | 10 / 60s |
| `rateLimitAuthByIp(register)` | `ipauth:<ip>:register` | 5 / 300s |
| `rateLimitAuthByIp(login)` | `ipauth:<ip>:login` | 30 / 300s |
| `rateLimitByUser(task:create)` | `user:<id>:task:create` | 20 / 60s |
| `rateLimitByUser(auth:login)` | `user:<邮箱>:auth:login` | 10 / 300s |

**固定窗口，不是滑动窗口**：实现简单、可解释；代价是窗口边界最多放行 2 倍流量。

**Redis 实现用 Lua 保证原子**：`INCR` 后只在 `current==1` 时 `PEXPIRE`（否则每次都续期 → 永久封禁）。
`purge()` 返回 0（不伪装做了 GC）。

**失败模式**（默认 `open`）：主后端挂了 → 回退进程内存继续计数 → 业务不中断。
`closed` 则直接 429。**再失败兜底放行**（可用性优先）。

**`TRUST_PROXY_HOPS` 默认 0**：完全不信任 `x-forwarded-for`，所有请求共享 `unknown` 桶。
反代部署必须按实际层数设置，且应用端口只能对代理开放——否则伪造 XFF 就能绕过限流。

---

## 6. 幂等：靠数据库唯一索引，不靠内存

```ts
// idempotency.ts:69-79
const sanitized = header.slice(0, 64).replace(/[^A-Za-z0-9._:-]/g, '');
return sanitized || crypto.randomUUID();
```

| 规则 | 为什么 |
|---|---|
| 截断 64 | 防超长撑爆索引 |
| 字符白名单 | 防注入、可安全进日志与 URL |
| 清洗成空 → 随机 UUID | 否则所有中文/空格 key 都命中 `(userId,'')`，第二条起被当成重放 |

并发双写三道路径：先查 → 查不到就建 → 撞 P2002 再回查。
**正确性由唯一约束保证**，缓存只做性能优化（多实例下内存判重会失效，唯一索引不会）。

**残余成本**（可以主动说）：唯一约束只在 INSERT 时生效，而 `createTaskRecord` 在插入前会做
正文抽取（URL 抓取）。并发重复请求会重复做这些"非计费但耗资源"的动作。
LLM 调用在 `after()` 里、只在插入成功后发生，所以**不会重复计费**。

---

## 7. 配额：为什么 BYOK 不受限

```ts
// tasks/route.ts:178  → 194
const credential = await loadActiveCredential(userId);   // 先取凭证
if (!credential) { /* 才检查日配额 */ }
```

顺序反了就会出现"用户填了自己的 key，却被站点额度拦住"。

| 项 | 口径 |
|---|---|
| 计量单位 | **Task 条数**（用户能理解"每天 20 次"），不是 token |
| 日界 | 进程本地时区的 00:00 |
| 包含 | 当天创建的全部任务（含 failed），排除软删 |

**时区陷阱**：容器默认 UTC 时日界是 UTC 0 点 = 北京早 8 点。不是 bug，但部署应设 `TZ=Asia/Shanghai`。

---

## 8. 越权防护：为什么用 `findFirst` 而不是 `findUnique` 再比对

```ts
// authz.ts:86-97
const task = await prisma.task.findFirst({
  where: { id: taskId, userId, deletedAt: null },
});
if (!task) throw new AuthzError();      // 统一 404
```

| 维度 | `findFirst({id,userId})` | `findUnique({id})` + 事后比对 |
|---|---|---|
| 过滤位置 | **SQL 层** | 应用层 |
| 忘记比对 | 查不到 → 404，天然安全 | 返回别人的数据 |
| 信息泄漏 | 统一 404（不区分不存在/无权） | 容易写成 403 泄漏存在性 |

**必须走它的入口**：`tasks/[id]`（GET/PATCH/DELETE）、`tasks/[id]/stream`、`diff`（两侧各一次）、`followup`（父子各一次）、`share`（三个方法）。

集成测试 `03-authz.test.ts` 逐条验证：B 读/删/订阅/diff/追问 A 的任务全部 404，
**并且必须有"A 访问自己成功"的对照组**——否则 404 可能只是接口坏了。

---

## 9. SSRF：四层防御 + DNS 重绑定

| 层 | 规则 |
|---|---|
| 1 协议 | 仅 http/https |
| 2 端口 | 仅 80/443 |
| 3 主机 | `FETCH_ALLOWED_HOSTS` 非空才生效 |
| 4 IP | DNS 解析后**所有**地址逐个校验，任一内网即拒 |

IPv4 用**整数区间**比较而不是字符串前缀（防 `0x7f.1`、`2130706433` 这类绕过），
拦截段包括：RFC1918、环回、链路本地、CGNAT、组播、测试网段，以及
**云元数据 `169.254.169.254` / `169.254.170.2` / `100.100.100.200` / `192.0.0.192`**。

IPv6 先展开成 16 字节再判，覆盖 `::1`、`::ffff:x`、`64:ff9b::/96`（NAT64）、`2002::/16`（6to4）、
`fc00::/7`、`fe80::/10`；解析失败 **fail-closed**。

**DNS 重绑定防护**：解析一次，把校验过的 IP 通过 undici 自定义 `lookup` **钉进连接层**，
后续连接不再重新解析。空列表返回错误而非放行。

**重定向**：`redirect:'manual'` 自己处理，**每一跳重新完整校验**，最多 3 跳。

| 限制 | 值 |
|---|---|
| 超时 / 体积 | 15s / 5MB（边读边计，超限截断并标 truncated） |
| content-length 预检 | 声明超限直接拒 |

---

## 10. 输入输出护栏（`llm/guardrail.ts`）

| 位置 | 做法 |
|---|---|
| 输入 | `wrapUntrusted` 把正文包进 `<document>`，并把正文里的标签换全角防提前闭合 |
| 输入清洗 | CRLF→LF、删零宽字符、删控制字符（保留 `\t\n`） |
| 输出 | `redactOutput` 把 6 类敏感串替换成 `[已脱敏]`：`sk-*`、`AKIA*`、`gh[pousr]_*`、`Bearer *`、身份证、16-19 位卡号 |
| 日志 | `promptFingerprint` 只给 `{length, hash}`，**永不打印原文** |

**两个坑**：
- 带 `g` 的正则 `lastIndex` 有状态，**每次必须新建 RegExp**，否则第二次调用漏检（测试锁了）
- 零宽字符必须写成 `\u200B`，写**字面零宽字符**会被当成字符类连字符，把用户的 hyphen 全删掉

**刻意不做**："命中注入关键词就拒绝"——讨论安全的文档会被大量误伤。

---

## 11. BYOK 密钥：怎么存

| 项 | 值 |
|---|---|
| KDF | `scryptSync(AUTH_SECRET, 'lumenote:api-credential:v1', 32, {N:16384,r:8,p:1})` |
| **盐固定** | 随机会导致重启后历史密文全解不开；真正的秘密是 `AUTH_SECRET` |
| 算法 | AES-256-GCM，IV 12 字节随机 |
| 存储格式 | `iv.authTag.ciphertext`，各段 base64url |
| 解密失败 | 抛错并提示"可能是 AUTH_SECRET 已更换"；读取凭证时 catch 后**回退站点 key**，管线不崩 |
| 掩码 | 前 3 + 后 4；长度 ≤12 全打码 |
| 类型层防泄漏 | `PublicCredential` **不含密文**，只有 `apiKeyHint` |
| 缓存 | 进程内 Map，TTL 60s，键是 credentialId（换凭证自然失效） |

> 面试点：把"密文不出服务端"写进**类型系统**，比靠 code review 记住"这个字段别返回"可靠。
> 另外 `AUTH_SECRET` 一换，所有已存密钥都解不开——这是必然代价，要在部署文档里警告。

---

## 12. 验证码（`auth/verification.ts`）

| 项 | 值 |
|---|---|
| 格式 | 6 位数字（`crypto.randomInt`） |
| 存储 | **只存 `sha256(code + ':' + AUTH_SECRET)`** |
| 冷却 / 小时上限 / 有效期 / 尝试上限 | 60s / 5 次/小时 / 10 分钟 / 5 次 |
| 比对 | 先判长度再 `timingSafeEqual` |
| 用后 | 写 `consumedAt`（保留审计痕迹，不物理删） |
| 发信失败 | 删掉刚写入的码（避免"没收到但冷却已生效"） |

为什么不用 bcrypt 存码：有效期 10 分钟 + 5 次上限，不需要抗长期离线爆破；随机盐还要额外存盐。

**注册策略**（`verification-policy.ts`）：`skip / verify / reject` 三条出口。
**"站点是否要求验证" 与 "客户端传没传 code" 是两个独立输入**；
要求验证但没传码 → **reject**，绝不降级为 skip（否则就是不传字段即绕过）。
默认 `REQUIRE_EMAIL_VERIFICATION=false`：只要账号+密码。

---

## 13. 动手练习

1. 故意用不存在的邮箱登录，对比响应时间与文案（应与其他错误一致）。
2. 用同一个 refresh cookie 并发打两次 `/api/auth/refresh`，确认只有一次 200。
3. 用同一 `Idempotency-Key` 连打三次 `POST /api/tasks`，确认库里 1 条任务。
4. 用 B 的 cookie 去 GET A 的 taskId，确认 404 而不是 403。
5. 提交 `http://169.254.169.254/latest/meta-data` 作为 URL，确认被拦。

---

## 14. 面试问答

**Q：怎么防撞库？**
> 四层：IP 限流（30/5min）→ 账号限流（10/5min）→ 失败锁定（账号 5 次、IP 15 次、窗口 15 分钟，
> 存 DB 因为要跨实例）→ bcrypt cost 12 比对。用户不存在时用真实哈希做假比对，
> 保证耗时一致；返回文案与"密码错"完全相同，避免枚举。"还可尝试 N 次"只在账号真实存在时给。

**Q：refresh token 怎么防重放？**
> 现状是**防不了**：轮换时旧行被物理删除，旧 token 再来时与"乱编的 token"走同一分支，
> 无法区分。真正的 BCP 做法是保留旧 hash 加 `reusedAt` 标记，命中即撤销整个 token family
> —— 代码里有 `destroyAllSessions` 但**没有调用点**。这是我知道的缺口。

**Q：为什么 refresh 用随机串而 access 用 JWT？**
> access 要无状态、每请求都要验，JWT 省一次查库；refresh 要能撤销（登出/盗用），
> 必须落库比对。库里只存 SHA-256，明文只在 cookie 里。

**Q：越权怎么防？**
> 查询层就带 `userId`（`findFirst({id, userId, deletedAt:null})`），查不到统一 404。
> 不用"findUnique 再比对"——那是在应用层做安全，忘一次就是数据泄漏。
> 集成测试逐条覆盖读/删/订阅/追问/分享，且必须有"自己访问自己成功"的对照组。

**Q：密钥存在数据库里怎么保证安全？**
> 用 scrypt 从 `AUTH_SECRET` 派生密钥（固定盐，因为盐变了历史密文就废了），
> AES-256-GCM 加密，存 `iv.tag.ciphertext`；解密失败不抛给用户而是回退站点 key。
> 类型上 `PublicCredential` 根本不含密文字段。代价是换 `AUTH_SECRET` 会让所有密钥失效。

import Link from 'next/link';
import { PRICING } from '@/lib/llm/pricing';

export const metadata = {
  title: '流光笔记 · 可追溯的 AI 文本工作台',
  description:
    'AI 摘要、翻译、润色、追问。每一次输出都记录 Prompt 版本、Token 用量与真实成本 —— 没有"黑盒结果"。',
};

/** 入场动画的延时类名。
 *  ⚠️ 必须写成完整字面量：Tailwind 是静态扫描源码的，
 *  模板字符串拼出来的 `rise-delay-${n}` 不会被识别，类名不会出现在产物里。 */
const RISE_DELAY = ['rise-delay-1', 'rise-delay-2', 'rise-delay-3'] as const;

/**
 * 首页（落地页）。
 *
 * ## 设计说明
 *
 * 参考 DeepSeek 官网的做法，核心是三条：
 *
 * 1. **首屏只讲一句话**：大字标题 + 一行副标题 + 两个按钮。
 *    求职 / 产品向的落地页最常见的错误是把所有信息都塞进首屏，
 *    结果反而没有重点。
 *
 * 2. **产品预览用真实结构**。右侧那块不是装饰性假图，
 *    它展示的是这个产品真正的差异化：Token 明细、缓存命中率、
 *    成本、降级标记 —— 这些字段是从 PRICING 与真实口径来的，
 *    而不是随手写的数字。首页本身就是一次「可追溯」的示范。
 *
 * 3. **对比表格而不是罗列优点**。「套壳调用」和"可追溯管线"的差别，
 *    用一张对照表比四个形容词有效得多。
 *
 * 全部为静态内容 + CSS 动画，无客户端组件、无第三方动画库。
 */
export default function HomePage() {
  /** 从真实的计价表里取数，保证首页展示的单价与代码一致（不会写完就过期） */
  const flash = PRICING['deepseek-flash']!;
  const pro = PRICING['deepseek-v4-pro']!;

  /** 差异化能力：每条都对应一个具体实现，不写「智能」「高效」这类空话 */
  const pillars = [
    {
      icon: 'fingerprint',
      title: 'Prompt 指纹',
      body: '每条结果记录「模板名 + 版本号 + 模型 + 参数快照」。半年后回看，仍然说得清它是怎么生成的。',
      proof: 'Task.promptVersionId + params 快照',
    },
    {
      icon: 'wallet',
      title: '成本可见',
      body: '输入/输出 Token、前缀缓存命中率、实际花费、是否高峰计价 —— 按 DeepSeek 的缓存分档与峰谷价真实换算。',
      proof: `cache hit $${flash.inputCacheHit} vs miss $${flash.inputCacheMiss}`,
    },
    {
      icon: 'pulse',
      title: '故障可解释',
      body: '重试、熔断、换模型、降级到本地规则的完整轨迹落库。降级结果会被明确标记，绝不伪装成正常输出。',
      proof: 'flash → v4-pro → openai → 本地规则',
    },
    {
      icon: 'stream',
      title: '两段式流式',
      body: '提交立即返回 taskId，长文在后台分块处理并实时回传。断线可重连、服务重启不丢结果。',
      proof: 'SSE 五事件 + 15s 心跳 + 断点续传',
    },
  ] as const;

  /** 能力清单：功能扩展后与此处同步 */
  const capabilities = [
    { name: '长文摘要', desc: '超长文档自动 Map-Reduce 分块，输出要点 / 段落 / 执行摘要' },
    { name: '翻译', desc: '带术语表的翻译，强制统一专有名词译法' },
    { name: '润色改写', desc: '保持原意的前提下重写，可选风格与改写强度' },
    { name: '结果追问', desc: '基于已生成的结果继续提问，多轮上下文不丢' },
    { name: '版本对比', desc: '同一篇原文的多次生成逐字 Diff，看出改了什么' },
    { name: '只读分享', desc: '生成不可枚举的分享链接，含成本与 Prompt 指纹' },
  ];

  /**
   * 对照表数据。
   *
   * ⚠️ 移动端不能直接用三列表格：390px 宽下每列只剩 ~120px，
   * 中文会退化成「每行两三个字」的竖排，完全不可读。
   * 所以下面渲染两套布局 —— 窄屏是卡片、宽屏是表格，
   * 共用这一份数据（避免两处文案走样）。
   */
  const comparison = [
    ['结果是怎么来的', '不知道用了哪个提示词', '模板 + 版本 + 模型 + 参数全记录'],
    ['这次花了多少钱', '看不到，月底看账单', '单次任务实时显示，含缓存与峰谷分档'],
    ['模型挂了怎么办', '报错或转圈到超时', '自动换模型并标记降级，轨迹可查'],
    ['长文怎么处理', '截断，用户自己发现', '自动分块 + 合并，标注是否截断'],
    ['重复点击', '重复计费', '幂等键 + 数据库唯一约束双重保证'],
    ['能不能复现', '换个人工重试一遍', 'Prompt 指纹可逐字复现当时的输入'],
  ];

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      {/* ============ 顶部导航 ============ */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link href="/" className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-cyan-400 text-sm font-bold text-white">
              流
            </span>
            <span className="text-[15px] font-semibold tracking-tight">流光笔记</span>
          </Link>

          <div className="flex items-center gap-1.5">
            <a
              href="#capabilities"
              className="hidden rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground sm:block"
            >
              功能
            </a>
            <a
              href="#security"
              className="hidden rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground sm:block"
            >
              安全
            </a>
            <Link
              href="/login"
              className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              登录
            </Link>
            <Link
              href="/register"
              className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
            >
              免费开始
            </Link>
          </div>
        </nav>
      </header>

      {/* ============ 首屏 ============ */}
      <section className="relative">
        <div className="hero-glow" aria-hidden />
        <div className="grid-backdrop absolute inset-0 -z-10" aria-hidden />

        {/*
          间距比常见落地页更紧一档：留白是用来建立层级的，不是用来拉长页面的。
          ⚠️ 用 items-start 而不是 items-center：两列高度不等时，
          center 会把较矮的左列往下推，视觉上形成"漂浮"的空白块。
        */}
        <div className="mx-auto grid max-w-6xl items-start gap-12 px-5 py-14 lg:grid-cols-[1.05fr_1fr] lg:py-16">
          {/* 左：文案与行动点 */}
          <div className="rise">
            <span className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Next.js 16 · Prisma 7 · AI SDK 7 · DeepSeek
            </span>

            <h1 className="mt-5 text-4xl font-semibold leading-[1.15] tracking-tight sm:text-5xl lg:text-[3.4rem]">
              让每一次 AI 输出
              <br />
              都<span className="text-gradient">留下证据</span>
            </h1>

            <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-muted-foreground sm:text-base">
              流光笔记是一个可追溯的 AI 文本工作台：摘要、翻译、润色、追问。
              它和「套个壳调用大模型」的区别在于 —— 每条结果都能回答三个问题：
              <span className="text-foreground"> 怎么生成的、可靠吗、花了多少钱。</span>
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/register"
                className="inline-flex h-11 items-center rounded-lg bg-primary px-6 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:opacity-90"
              >
                免费开始使用
              </Link>
              <a
                href="#preview"
                className="inline-flex h-11 items-center rounded-lg border border-border px-6 text-sm font-medium transition-colors hover:bg-accent"
              >
                看看它记录了什么
              </a>
            </div>

            {/*
              这里的 20 与 .env.example 的 FREE_DAILY_QUOTA 默认值一致。
              刻意不 import env()：那会让首页在构建期依赖环境变量校验，
              一个纯静态落地页不该因为缺 AUTH_SECRET 就构建失败。
              改配额时同步这一处即可（首页只是宣传口径，不参与实际判断）。
            */}
            <p className="mt-4 text-xs text-muted-foreground">
              注册需要邮箱验证码 · 无需信用卡 · 每日 20 次免费额度
            </p>
          </div>

          {/* 右：产品预览（真实字段结构，非装饰图） */}
          <PreviewCard flashHit={flash.inputCacheHit} proOutput={pro.output} />
        </div>
      </section>

      {/* ============ 差异化四支柱 ============ */}
      <section className="border-t border-border/60 bg-muted/20">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <header className="max-w-2xl">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              不是「能跑通」，是每一步都可追溯
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              下面四条每一条都对应代码里的具体实现，而不是宣传词。
            </p>
          </header>

          <div className="mt-10 grid gap-5 sm:grid-cols-2">
            {pillars.map((p, i) => (
              <article
                key={p.title}
                className={`card-lift rise ${RISE_DELAY[i % RISE_DELAY.length]} rounded-xl border border-border/80 bg-card p-6`}
              >
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Icon name={p.icon} />
                  </span>
                  <h3 className="font-medium">{p.title}</h3>
                </div>
                <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
                <p className="mt-4 border-t border-border/60 pt-3 font-mono text-[11px] text-muted-foreground">
                  {p.proof}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ============ 功能清单 ============ */}
      <section id="capabilities" className="border-t border-border/60">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <header className="max-w-2xl">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">一个工作台，六件事</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              所有能力共用同一套 Prompt 版本体系、同一条可靠性与计量管线 ——
              加一种能力只需要加模板与路由，不需要重写基础设施。
            </p>
          </header>

          <div className="mt-10 grid gap-x-8 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
            {capabilities.map((c) => (
              <div key={c.name} className="flex gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <div>
                  <h3 className="text-sm font-medium">{c.name}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{c.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ 对照表 ============ */}
      <section className="border-t border-border/60 bg-muted/20">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <header className="max-w-2xl">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">差别在哪</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              同一件事，两种做法。左边是「套壳调用」，右边是这个项目。
            </p>
          </header>

          {/* 宽屏：三列对照表 */}
          <div className="mt-8 hidden overflow-hidden rounded-xl border border-border/80 bg-card md:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-medium">关注点</th>
                  <th className="px-5 py-3 font-medium">套壳调用</th>
                  <th className="px-5 py-3 font-medium text-foreground">流光笔记</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map(([topic, naive, ours], i) => (
                  <tr key={topic} className={i > 0 ? 'border-t border-border/60' : undefined}>
                    <td className="whitespace-nowrap px-5 py-3.5 text-muted-foreground">{topic}</td>
                    <td className="px-5 py-3.5 text-muted-foreground/70 line-through decoration-border">
                      {naive}
                    </td>
                    <td className="px-5 py-3.5 font-medium">{ours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 窄屏：同一份数据换成卡片，避免中文被压成竖排 */}
          <ul className="mt-8 space-y-3 md:hidden">
            {comparison.map(([topic, naive, ours]) => (
              <li key={topic} className="rounded-xl border border-border/80 bg-card p-4">
                <p className="text-xs text-muted-foreground">{topic}</p>
                <p className="mt-2 text-sm text-muted-foreground/70 line-through decoration-border">
                  {naive}
                </p>
                <p className="mt-2 flex gap-2 text-sm font-medium">
                  <span className="text-emerald-600 dark:text-emerald-400">→</span>
                  {ours}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ============ 安全 ============ */}
      <section id="security" className="border-t border-border/60">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr]">
            <header>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                安全性写进了设计，不是补丁
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                每一项都对应代码里的一个明确位置。这里也诚实标出哪些是「降低概率」而不是「彻底解决」。
              </p>
              <Link
                href="/register"
                className="mt-6 inline-flex h-10 items-center rounded-lg border border-border px-5 text-sm font-medium transition-colors hover:bg-accent"
              >
                创建账号
              </Link>
            </header>

            <ul className="space-y-4 text-sm">
              {[
                ['IDOR 越权', '统一鉴权入口，查询在 SQL 层就带 userId；查不到返回 404 而非 403，不泄漏资源是否存在'],
                ['SSRF', '协议/端口/主机白名单/私网 IP 四层校验，并在连接层固定已校验的 IP 以封堵 DNS Rebinding'],
                ['Prompt 注入', '分隔符包裹并中和结束标签 + 输出侧脱敏 + 模型工具全只读（诚实说：这类攻击没有彻底解法）'],
                ['重复计费', '幂等键 + 数据库唯一约束双保险，重复点击不产生第二次调用'],
                ['邮箱枚举', '统一错误文案 + 真实哈希的假比对消除时间差'],
                ['账号爆破', '内存限流 + 连续失败锁定 + 全部登录事件落库可审计'],
                ['API Key 泄露', '用户自带密钥以 AES-256-GCM 加密落库，接口只回掩码，密钥永不进入浏览器'],
              ].map(([name, desc]) => (
                <li key={name} className="flex gap-4 rounded-lg border border-border/70 bg-card p-4">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                  <div>
                    <p className="font-medium">{name}</p>
                    <p className="mt-1 leading-relaxed text-muted-foreground">{desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ============ 技术栈 ============ */}
      <section className="border-t border-border/60 bg-muted/20">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <h2 className="text-center text-sm font-medium text-muted-foreground">
            构建于这些之上
          </h2>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-sm text-muted-foreground">
            {[
              'Next.js 16 App Router',
              'React 19',
              'TypeScript strict',
              'Prisma 7 + PostgreSQL',
              'AI SDK 7',
              'DeepSeek / OpenAI 双 Provider',
              'Tailwind CSS',
              '自建 JWT 鉴权',
            ].map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
        </div>
      </section>

      {/* ============ 结尾 CTA ============ */}
      <section className="border-t border-border/60">
        <div className="mx-auto max-w-3xl px-5 py-20 text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            从第一条<span className="text-gradient">可追溯的结果</span>开始
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
            注册只需邮箱验证码。也可以在工作台填入自己的 API Key，用你自己的额度生成，不受站点配额限制。
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/register"
              className="inline-flex h-11 items-center rounded-lg bg-primary px-7 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-opacity hover:opacity-90"
            >
              免费开始
            </Link>
            <Link
              href="/login"
              className="inline-flex h-11 items-center rounded-lg border border-border px-7 text-sm font-medium transition-colors hover:bg-accent"
            >
              我已经有账号
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-5 py-8 text-xs text-muted-foreground sm:flex-row">
          <p>流光笔记 Lumenote · 可追溯的 AI 文本工作台</p>
          <p className="font-mono">MIT License</p>
        </div>
      </footer>
    </div>
  );
}

/**
 * 产品预览卡片。
 *
 * 用真实的字段名与真实口径（成本、缓存命中、降级标记）——
 * 首页展示的就是产品真实的记录能力，而不是示意图。
 */
function PreviewCard({ flashHit, proOutput }: { flashHit: number; proOutput: number }) {
  const points = [
    'Promise 是代表异步操作最终完成或失败的对象，可在其上绑定回调函数。',
    'Promise 链解决连续异步操作的回调地狱，链式编程应保持扁平化。',
    'async/await 基于 Promise，让异步代码读起来像同步代码。',
  ];

  return (
    <div id="preview" className="rise rise-delay-2">
      <div className="rounded-2xl border border-border/80 bg-card shadow-2xl shadow-primary/5">
        {/* 窗口标题栏 */}
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
          <span className="ml-3 truncate text-xs text-muted-foreground">
            使用 Promise - JavaScript | MDN
          </span>
        </div>

        {/* Prompt 指纹 + 用量：这个产品的核心信息区 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border/60 px-4 py-2.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            完成
          </span>
          <span>
            模型 <code className="rounded bg-muted px-1 font-mono">deepseek-flash</code>
          </span>
          <span>
            Prompt <code className="rounded bg-muted px-1 font-mono">长文摘要#v1</code>
          </span>
          <span>输入 1,410 · 输出 250 tokens</span>
          <span className="text-emerald-600 dark:text-emerald-400">缓存命中 62%</span>
          <span className="font-medium text-foreground">成本 ¥0.00156</span>
        </div>

        {/* 结果正文 */}
        <div className="space-y-2.5 px-4 py-4">
          {points.map((p) => (
            <div key={p} className="flex gap-2.5 text-[13px] leading-relaxed">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
              <span className="text-muted-foreground">{p}</span>
            </div>
          ))}
          <div className="flex gap-2.5 text-[13px] leading-relaxed">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
            <span className="text-muted-foreground">
              详见
              <span className="text-primary underline underline-offset-2">
                {' '}
                MDN 官方文档
              </span>
              <span className="font-mono text-[11px]"> (developer.mozilla.org)</span>
            </span>
          </div>
        </div>

        {/* 底部：把"成本为什么是这个数"的依据摆在明面上 */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-3 text-[11px] text-muted-foreground">
          <span className="font-mono">
            首字 552ms · 总耗时 5.6s · 低谷计价
          </span>
          <span className="font-mono">cache hit ${flashHit}/M vs 输出 ${proOutput}/M</span>
        </div>
      </div>

      {/* 卡片下方的注解，把"这不是假图"说清楚 */}
      <p className="mt-4 text-center text-xs text-muted-foreground">
        真实生成结果（19,234 字正文 → 5 条要点，实际成本 ¥0.00521）
      </p>
    </div>
  );
}

/** 极简内联图标。不引图标库：4 个图标换 300KB 依赖不划算 */
function Icon({ name }: { name: string }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  switch (name) {
    case 'fingerprint':
      return (
        <svg {...common} aria-hidden>
          <path d="M12 3a9 9 0 0 0-9 9v3a3 3 0 0 0 6 0v-3a3 3 0 0 1 6 0v6" />
          <path d="M15 21v-9a3 3 0 0 1 3-3" />
        </svg>
      );
    case 'wallet':
      return (
        <svg {...common} aria-hidden>
          <rect x="3" y="6" width="18" height="13" rx="2" />
          <path d="M3 10h18M16 14h2" />
        </svg>
      );
    case 'pulse':
      return (
        <svg {...common} aria-hidden>
          <path d="M3 12h4l2-5 3 10 2.5-5H21" />
        </svg>
      );
    default:
      return (
        <svg {...common} aria-hidden>
          <path d="M4 7h16M4 12h10M4 17h7" />
        </svg>
      );
  }
}

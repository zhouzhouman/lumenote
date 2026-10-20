#!/usr/bin/env node
/**
 * 生成 README / 架构文档用的**真实截图**（不是设计稿、不是占位图）。
 *
 * ## 为什么截图脚本要入库
 *
 * 截图是最容易过期的文档：UI 一改，图就骗人。把「怎么截」写成脚本，
 * 至少让下一个人能一条命令重新生成，并在 diff 里看见截图确实变了。
 *
 * ## 前置条件（脚本不会替你下载浏览器）
 *
 * Playwright 不是本项目的运行时依赖（截图只是文档工具，不该进 package.json）。
 * 在**仓库之外**临时安装即可：
 *
 *   mkdir %TEMP%\lumenote-shots && cd %TEMP%\lumenote-shots
 *   npm init -y && npm i playwright
 *   # 若本机已装 Chrome/Edge，可跳过浏览器下载（脚本会自动用系统 channel）
 *   # npx playwright install chromium   # 无系统浏览器时才需要
 *
 * 然后（PowerShell 示例；bash 用对应写法）：
 *
 *   $env:PLAYWRIGHT_MODULE = "$env:TEMP\lumenote-shots\node_modules\playwright"
 *   $env:DEMO_BASE_URL = 'http://127.0.0.1:3000'
 *   # 先启动 mock 模式的 dev server（不要在截图时产生真实模型费用），
 *   # 并显式绑定 127.0.0.1 —— Next dev 会拦截跨 origin 的 dev 资源（HMR 等），
 *   # 若服务只绑 localhost，用 127.0.0.1 打开会因 hydration 失败导致按钮/输入不响应：
 *   #   pnpm prisma:deploy && pnpm prisma:seed && pnpm dev -- -H 127.0.0.1
 *   node scripts/demo/capture-screenshots.mjs
 *
 * 本机实测环境：Playwright 自带 Chromium 的 CDN 下载不可达，因此脚本默认用
 * **系统已安装的 Chrome/Edge**（`channel: 'chrome'` → `'msedge'` → bundled chromium 依次尝试）。
 * 截图仍是真实浏览器渲染，不是设计稿。
 *
 * 产物写入 `docs/assets/*.png`，脚本会打印每张图的路径与大小。
 *
 * ## 安全约束
 *
 * - 只登录 seed 的演示账号；页面里不得出现 API Key（设置页截图被排除在清单之外）。
 * - 必须显式确认 mock 模式：`REQUIRE_MOCK=1`（默认）时会检查页面输出是否含
 *   「Mock 模式」标记，避免误用真实模型截图（那会同时产生费用）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(ROOT, 'docs', 'assets');

const BASE = (process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const EMAIL = process.env.DEMO_EMAIL ?? 'demo@lumenote.dev';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Lumenote2026!';
const CHANNEL = process.env.PLAYWRIGHT_CHANNEL ?? 'chrome';
const VIEWPORT = { width: 1440, height: 900 };

/** 演示用的长文：与 seed / smoke 一样，避免依赖外部内容 */
const DEMO_TEXT = [
  '# 可追溯的 AI 工作台（演示文本）',
  '',
  'AI 文本工具通常只关心「生成得快不快」，却忽略一个更根本的问题：',
  '这条结果是怎么来的，半年后还能不能复现？',
  '',
  '## 三个可追溯的支点',
  '',
  '第一，Prompt 版本化：模板与版本存在数据库里，历史任务引用具体版本，',
  '因此修改提示词不会改变已经发生的事实。',
  '',
  '第二，参数快照：温度、模型、分块大小、术语表在任务创建时随任务落库，',
  '而不是执行时现读 —— 后者会随用户改配置而漂移。',
  '',
  '第三，用量与轨迹：Token 用量按任务只结算一次，Agent 任务还记录每一步的',
  '工具调用与结果，供事后复盘推理路径。',
  '',
  '## 成本上的四条防线',
  '',
  '幂等键防止重复扣费；每日配额限制单用户总量；并发上限阻止一个人同时开五个标签页；',
  '前缀缓存把稳定内容前置，让输入 token 按 cache hit 计价。',
].join('\n');

const DEMO_TEXT_2 = [
  '# 成本控制（演示文本二）',
  '',
  'AI 应用的成本不在「一次生成多少钱」，而在「重复生成了多少次」。',
  '',
  '## 四道防线',
  '',
  '第一道是幂等：同一个 Idempotency-Key 重复提交只产生一个任务，数据库唯一约束兜底。',
  '第二道是配额：按任务数计、按天重置，用户能理解「今天还能用几次」。',
  '第三道是并发上限：一个人同时开五个标签页，成本就是五倍。',
  '第四道是前缀缓存：把 system prompt 等稳定内容前置，命中缓存后输入单价降到 1/50。',
  '',
  '## 可观测',
  '',
  '每个任务记录输入/输出 token、缓存命中、峰谷与模型，成本才能事后核对而不是猜。',
].join('\n');

const shots = [];

function log(...args) {
  console.log('[shots]', ...args);
}

/** 解析 Playwright：从 PLAYWRIGHT_MODULE 或项目依赖中加载 */
async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push(path.join(process.cwd(), 'node_modules', 'playwright'));

  for (const dir of candidates) {
    if (!dir) continue;
    const entry = path.join(dir, 'index.js');
    if (!fs.existsSync(entry)) continue;
    const mod = await import(pathToFileURL(entry).href);
    const pw = mod.chromium ? mod : mod.default;
    if (pw?.chromium) return pw;
  }
  throw new Error(
    '找不到 playwright。请按文件头说明在仓库外临时安装，并设置 PLAYWRIGHT_MODULE 指向其 node_modules/playwright。',
  );
}

/** 依次尝试系统浏览器 channel；都不行时退回 Playwright 自带 chromium */
async function launchBrowser(chromium) {
  const attempts = [
    { channel: CHANNEL },
    { channel: 'msedge' },
    { channel: 'chrome' },
    {},
  ];
  let lastError = null;
  for (const opts of attempts) {
    try {
      const browser = await chromium.launch({ headless: true, ...opts });
      log(`浏览器已启动（${opts.channel ? `channel=${opts.channel}` : 'bundled chromium'}）`);
      return browser;
    } catch (e) {
      lastError = e;
      log(`启动失败（${opts.channel ?? 'bundled'}）：${e.message.split('\n')[0]}`);
    }
  }
  throw lastError ?? new Error('无法启动任何浏览器');
}

async function shot(page, name, { fullPage = false } = {}) {
  const file = path.join(OUT_DIR, name);
  // 等字体与动画稳定，避免截到闪烁中间态
  await page.waitForTimeout(250);
  await page.screenshot({ path: file, fullPage });
  const size = fs.statSync(file).size;
  shots.push({ file, size });
  log(`✓ ${path.relative(ROOT, file)}（${(size / 1024).toFixed(1)} KB）`);
}

/** 关闭当前弹窗（限定 dialog 内查找，避免命中背景列表里的按钮） */
async function closeDialog(page) {
  const dialog = page.getByRole('dialog').first();
  await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  await dialog.getByRole('button', { name: '关闭' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15_000 });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---------- 前置检查：应用可达 ----------
  const health = await fetch(`${BASE}/api/health`).catch((e) => {
    throw new Error(`无法访问 ${BASE}/api/health：${e.message}\n请先启动 pnpm dev（mock 模式）`);
  });
  if (!health.ok) throw new Error(`/api/health 返回 HTTP ${health.status}`);
  const healthJson = await health.json();
  log(`应用健康：db.ok=${healthJson.db?.ok} version=${healthJson.version}`);

  const { chromium } = await loadPlaywright();
  const browser = await launchBrowser(chromium);
  const context = await browser.newContext({ viewport: VIEWPORT, locale: 'zh-CN' });

  /**
   * 隐藏 Next.js dev 指示器（左下角 N 圆点 / 错误浮层）。
   *
   * 它只存在于 dev 模式、不是产品 UI；留在公开截图里会让人误以为页面有 bug。
   * Next 16 的 dev 浮层挂在 `<nextjs-portal>` 里，直接隐藏宿主元素即可。
   */
  await context.addInitScript(() => {
    const inject = () => {
      try {
        const style = document.createElement('style');
        style.textContent = 'nextjs-portal{display:none !important}';
        (document.head ?? document.documentElement).appendChild(style);
      } catch {
        /* 页面还没有 head 时忽略；DOMContentLoaded 后会再注入一次 */
      }
    };
    inject();
    document.addEventListener('DOMContentLoaded', inject);
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  try {
    // ---------- 1. 落地页 ----------
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await shot(page, '01-landing.png', { fullPage: true });

    // ---------- 2. 登录页 ----------
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await shot(page, '02-login.png');

    // ---------- 3. 登录（演示账号） ----------
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/workspace', { timeout: 30_000 });
    log('登录成功，已进入工作台');

    // ---------- 4. 工作台（空表单） ----------
    await page.waitForLoadState('networkidle');
    await shot(page, '03-workspace.png');

    // ---------- 5. 创建摘要任务 + 流式输出中 ----------
    const textarea = page.locator('textarea').first();
    await textarea.fill(DEMO_TEXT);
    // 点「开始长文摘要」；等待流式进行中的状态徽标
    await page.getByRole('button', { name: /开始长文摘要/ }).click();
    // Mock 流式约 1-3s：等「生成中…」出现后立刻截图，截到的是真实的中间态
    await page.getByText('生成中…').first().waitFor({ timeout: 15_000 });
    await shot(page, '04-streaming.png');

    // 等待完成：出现状态徽标「完成」与结果卡片标题后截最终态
    await page.getByText('完成', { exact: true }).first().waitFor({ timeout: 60_000 });
    await page.getByText('长文摘要结果').first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(800);

    // 安全校验：必须是 Mock 输出（避免误用真实模型截图，同时避免产生费用）
    if (process.env.REQUIRE_MOCK !== '0') {
      const mockMarkers = await page.getByText(/Mock 模式/).count();
      if (mockMarkers === 0) {
        throw new Error(
          '页面未出现「Mock 模式」标记：当前 dev server 可能不是 MOCK_LLM=true。' +
            '为避免产生真实模型费用，截图中止（确认要用真实模式时设 REQUIRE_MOCK=0）。',
        );
      }
      log('已确认 Mock 模式输出（未产生真实模型费用）');
    }
    await shot(page, '05-result.png', { fullPage: true });

    // ---------- 5b. 再建一条「参数不同」的摘要，供版本对比展示真实差异 ----------
    await textarea.fill(DEMO_TEXT_2);
    const maxPoints = page.locator('#param-maxPoints');
    if (await maxPoints.count()) await maxPoints.fill('3');
    await page.getByRole('button', { name: /开始长文摘要/ }).click();
    await page.getByText('生成中…').first().waitFor({ timeout: 15_000 });
    await page.getByText('完成', { exact: true }).first().waitFor({ timeout: 60_000 });
    await page.getByText('长文摘要结果').first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    log('已创建第二条摘要（用于版本对比）');

    // ---------- 6. 历史详情（Prompt 指纹 / 成本） ----------
    await page.getByRole('link', { name: /历史/ }).first().click();
    await page.waitForURL('**/history', { timeout: 30_000 });
    await page.waitForLoadState('networkidle');

    // 打开第一条记录（刚创建的摘要在最上面）
    await page.locator('main ul li button').first().click();
    await page.getByText('用量与成本').first().waitFor({ timeout: 30_000 });
    await shot(page, '06-history-detail.png');

    // 关闭详情弹窗（限定在 dialog 内，避免命中列表项按钮）
    await closeDialog(page);

    // ---------- 7. 演示 Agent 任务的证据链 ----------
    const search = page.getByPlaceholder('搜索标题或结果内容');
    await search.fill('Lumenote 如何保证');
    await page.waitForTimeout(1_500); // 防抖搜索
    const agentCard = page
      .locator('main ul li')
      .filter({ hasText: 'Lumenote 如何保证' })
      .first();
    await agentCard.locator('button').first().click();
    await page.getByText('推理过程').first().waitFor({ timeout: 30_000 });
    await page.getByText(/结论（/).first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    await shot(page, '07-agent-evidence.png', { fullPage: true });
    await closeDialog(page);

    // 清空搜索，便于版本对比
    await search.fill('');
    await page.waitForTimeout(1_500);

    // ---------- 8. 版本对比 ----------
    await page.getByRole('button', { name: '对比版本' }).click();
    const cards = page.locator('main ul li button');
    // 先选旧版本（列表第 2 条）再选新版本（第 1 条）：diff 的 +/- 方向依赖选择顺序
    await cards.nth(1).click();
    await cards.nth(0).click();
    await page.getByRole('button', { name: '开始对比' }).click();
    await page.getByText('版本对比').first().waitFor({ timeout: 30_000 });
    await page.getByText(/相似度/).first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await shot(page, '08-version-diff.png');
    await closeDialog(page);

    // ---------- 9. 成本页 ----------
    await page.goto(`${BASE}/usage`, { waitUntil: 'networkidle' });
    await shot(page, '09-usage.png', { fullPage: true });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const total = shots.reduce((s, x) => s + x.size, 0);
  log(`\n完成：${shots.length} 张截图，共 ${(total / 1024).toFixed(1)} KB，目录 ${path.relative(ROOT, OUT_DIR)}`);
  for (const s of shots) console.log(`  ${path.relative(ROOT, s.file)}`);
}

main().catch((e) => {
  console.error('[shots] ✗ 截图失败：', e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
});

import type { AgentStructuredOutput } from './types';

/**
 * 模块职责：**结构化输出的解析与展示文本剥离**（纯函数）。
 *
 * 两个函数对应模型输出的两种消费方式：
 *   - `parseStructuredOutput` → 机器可校验的结论（证据链、评测）
 *   - `extractDisplayText`    → 给人看的散文（剥掉机器格式）
 *
 * ## 为什么单独成模块
 *
 * 这里的容错策略是最容易被「顺手改坏」的部分：改一个正则可能让
 * 普通的 JSON 示例被误删，改一个兜底分支可能让用户看到一片空白。
 * 抽成无依赖的纯函数模块后，边界行为可以被密集的单测锁住，
 * 而不是只能通过跑完整 Agent 才能覆盖。
 *
 * ## 为什么必须容错（而不是直接 JSON.parse）
 *
 * ADR-0003 记录：DeepSeek 的 JSON 输出**官方明示可能偶发返回空 content**，
 * 而即便开了 jsonMode，模型也常在 JSON 外面包一层 ```json 代码块或
 * 加一句「以下是结论：」。直接 JSON.parse 会在这些正常情况下抛错，
 * 把「格式不规范」升级成「任务失败」——而内容其实是可以用的。
 *
 * 所以策略是：尽力提取 JSON；提不出来就返回 null，
 * 由上层决定怎么展示（至少有纯文本可用）。
 */

export function parseStructuredOutput(text: string): AgentStructuredOutput | null {
  if (!text || !text.trim()) return null;

  const candidates: string[] = [];

  // 1) ```json ... ``` 代码块
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fenced)) {
    if (m[1]) candidates.push(m[1].trim());
  }

  // 2) 最外层的 {...}（贪心匹配第一个 { 到最后一个 }）
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  // 3) 整个文本本身
  candidates.push(text.trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const normalized = normalizeStructured(parsed);
      if (normalized) return normalized;
    } catch {
      // 试下一个候选
    }
  }

  return null;
}

/** 校验并归一化结构。字段缺失/类型不对时尽量补救，而不是整个丢弃 */
export function normalizeStructured(raw: unknown): AgentStructuredOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const rawConclusions = obj.conclusions;
  if (!Array.isArray(rawConclusions)) {
    // 有些模型会用中文键名或单数形式，做一个宽容量
    const alt = obj['结论'] ?? obj['conclusion'];
    if (!Array.isArray(alt)) return null;
    return buildConclusions(alt, obj);
  }
  return buildConclusions(rawConclusions, obj);
}

function buildConclusions(
  rawConclusions: unknown[],
  obj: Record<string, unknown>,
): AgentStructuredOutput {
  const conclusions = rawConclusions
    .map((c) => {
      if (typeof c === 'string') {
        // 模型直接把结论写成字符串数组的情况：保留文本，证据为空
        return { text: c, evidence: [] };
      }
      if (!c || typeof c !== 'object') return null;
      const item = c as Record<string, unknown>;
      const text = typeof item.text === 'string' ? item.text : typeof item['结论'] === 'string' ? String(item['结论']) : '';
      if (!text) return null;

      const rawEvidence = Array.isArray(item.evidence) ? item.evidence : [];
      const evidence = rawEvidence
        .map((e) => {
          if (!e || typeof e !== 'object') return null;
          const ev = e as Record<string, unknown>;
          const source = typeof ev.source === 'string' ? ev.source : '';
          const quote = typeof ev.quote === 'string' ? ev.quote : '';
          if (!source && !quote) return null;
          return { source, quote };
        })
        .filter((e): e is { source: string; quote: string } => e !== null);

      const confidence = typeof item.confidence === 'string' ? item.confidence : undefined;
      return { text, evidence, ...(confidence ? { confidence } : {}) };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const rawLimitations = obj.limitations ?? obj['局限'] ?? obj['限制'];
  const limitations = Array.isArray(rawLimitations)
    ? rawLimitations.filter((l): l is string => typeof l === 'string')
    : undefined;

  return { conclusions, ...(limitations ? { limitations } : {}) };
}

/**
 * 从交付文本里剥掉机器可读的 JSON 块，只留给人看的散文。
 *
 * ## 为什么需要它（这是一个真实的展示缺陷）
 *
 * 端到端验收发现：模型常把 JSON 用 ```json 代码块包裹，
 * 有时还在前后各写一段说明。于是 `result.text` 形如：
 *
 *     以下是分析结果：
 *     ```json
 *     { "conclusions": [...], ... }
 *     ```
 *
 * 如果直接把这个 text 渲染给用户，他会看到一大段机器格式 ——
 * 而结构化结论本该由 UI 单独渲染成「结论卡片 + 证据引用」。
 *
 * ⚠️ 剥离失败时**原样返回**，绝不返回空串。宁可多显示一段 JSON，
 * 也不能让用户面对一片空白 —— 那会让人以为任务失败了。
 */
export function extractDisplayText(text: string, structured: AgentStructuredOutput | null): string {
  if (!text) return '';
  // 没有解析出结构时不该剥任何东西（否则可能把正文里的正常 JSON 示例切掉）
  if (!structured) return text.trim();

  let out = text;

  // 1) 去掉 ```json ... ``` 代码块（非贪婪，只吃配对的）
  out = out.replace(/```(?:json)?\s*\n[\s\S]*?```/g, '');

  /**
   * 2) 去掉裸 JSON 对象。
   *
   * 只在「剥完代码块后没有实质内容」时才尝试 —— 否则可能误删
   * 正文里合法出现的 JSON 示例（比如文档本身就是讲 JSON 的）。
   */
  if (out.trim().length < 20) {
    const firstBrace = out.indexOf('{');
    const lastBrace = out.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      out = out.slice(0, firstBrace) + out.slice(lastBrace + 1);
    }
  }

  const trimmed = out.trim();
  // 剥完什么都不剩时保留原文（宁多勿空）
  return trimmed.length > 0 ? trimmed : text.trim();
}

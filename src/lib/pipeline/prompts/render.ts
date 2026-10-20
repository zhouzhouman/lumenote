/**
 * Prompt 模板变量渲染。
 *
 * 自己实现而不是引mustache 库：功能只有几十行，而「Prompt 渲染规则」
 * 本身就是这个项目的业务逻辑，必须完全可控。
 *
 * ## 一个关键的设计：稳定内容 vs 变动内容的顺序
 *
 * DeepSeek 的前缀缓存要求：prompt 开头的一段完全一致，才会命中 cache hit。
 * 而 cache hit 的输入价只有 miss 的 1/50（$0.003 vs $0.15，flash 模型）。
 *
 * 所以 system prompt 必须放在最前且尽量稳定（它是模板的一部分，不随用户输入变化），
 * 用户正文放在后面。**这个顺序不是风格问题，是直接决定成本的。**
 *
 * 详见 docs/adr/0002-llm-provider-abstraction.md 与 pricing.ts。
 */

export interface TemplateVariable {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'enum';
  options?: string[];
  required?: boolean;
  default?: string;
}

/** 未填写的占位符用空字符串替换，而不是保留 {{x}} */
const VAR_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

export class TemplateRenderError extends Error {
  constructor(
    message: string,
    readonly missingVars: string[] = [],
  ) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

/**
 * 渲染模板。
 *
 * 变量来源优先级：用户传入 > 变量定义里的 default。
 * 必填变量缺失时抛错而非填空 —— 摘要风格这类参数缺失会导致结果完全跑偏，
 * 静默填默认值比报错更糟（用户会拿到一个不匹配需求的结果还不知道原因）。
 */
export function renderTemplate(
  template: string,
  values: Record<string, string>,
  definitions: TemplateVariable[] = [],
): string {
  const resolved = new Map<string, string>();

  for (const def of definitions) {
    const provided = values[def.key]?.trim();
    if (provided) {
      resolved.set(def.key, provided);
    } else if (def.default !== undefined) {
      resolved.set(def.key, def.default);
    } else if (def.required) {
      throw new TemplateRenderError(`缺少必填参数：${def.label || def.key}`, [def.key]);
    } else {
      resolved.set(def.key, '');
    }
  }

  /**
   * 替换时**必须走 resolved 映射，不能直接读 values**。
   *
   * 否则上面算好的 default 根本用不上：values[key] 存在但为空白时
   * （表单里清了输入框但没删字段，很常见），会原样注入空白，
   * 让提示词变成「风格：   」而模型无从判断。
   *
   * 同时把结果 trim 掉，避免注入的空白影响 prompt 前缀的稳定性。
   */
  return template.replace(VAR_PATTERN, (_match, key: string) => {
    const raw = values[key];
    const provided = raw?.trim();
    const value = provided ? provided : resolved.get(key);
    return value !== undefined ? value : '';
  });
}

/** 校验用户提交的变量是否符合定义（枚举值必须在白名单内） */
export function validateVariables(
  values: Record<string, string>,
  definitions: TemplateVariable[],
): void {
  const errors: string[] = [];

  for (const def of definitions) {
    const value = values[def.key]?.trim();

    if (def.required && !value && def.default === undefined) {
      errors.push(`${def.label || def.key} 为必填项`);
      continue;
    }

    if (value && def.type === 'enum' && def.options && !def.options.includes(value)) {
      errors.push(`${def.label || def.key} 必须是以下值之一：${def.options.join(' / ')}`);
    }

    if (value && def.type === 'number' && !/^\d+$/.test(value)) {
      errors.push(`${def.label || def.key} 必须是数字`);
    }
  }

  if (errors.length > 0) {
    throw new TemplateRenderError(errors.join('；'), Object.keys(values));
  }
}

/**
 * 提取模板中用到的所有变量名。
 * 用于「模板编辑页」提示作者哪些占位符可用。
 */
export function extractVariables(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(VAR_PATTERN)) {
    names.add(match[1]);
  }
  return [...names];
}

/**
 * 计算渲染后的 prompt 指纹（不存内容，只存 hash）。
 *
 * 用于日志与排查：能回答「这两条结果是不是用了完全相同的输入」，
 * 又不把用户内容写进日志。内容本身存在 Task.renderedPrompt 中（用户可复现自己的输入）。
 */
export function promptHash(system: string, prompt: string): string {
  // 分隔符用不可见字符，避免不同的 system/prompt 拼接后产生相同哈希。
  // 写成转义序列而不是字面 NUL，否则源码里的一个“看不见字符”会容易在复制中丢失。
  const input = `${system}\u0000${prompt}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
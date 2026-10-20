import { describe, it, expect } from 'vitest';
import {
  TASK_TYPES,
  TASK_TYPE_LIST,
  normalizeTaskType,
  taskTypeDef,
  defaultParams,
} from '@/lib/tasks/types';
import { validateGlossaryInput, type GlossaryEntry } from '@/lib/tasks/glossary';
import { checkShareLink, isValidShareTokenShape } from '@/lib/tasks/share';

/**
 * 任务类型注册表、术语表校验、分享链接判断的单测。
 *
 * 这三块的共同点是「**配置与规则的单一事实来源**」：
 * 它们错了不会崩，而是让界面、数据库、提示词三处悄悄不一致 ——
 * 那类问题通常要在用户抱怨「我选了翻译但它给我摘要」时才会被发现。
 */

describe('任务类型注册表', () => {
  it('三种能力都有完整定义', () => {
    // 这条断言会随新增能力而失败 —— 那正是它的作用：
    // 强制「加能力时同时补上定义」这件事被看见，而不是悄悄漏掉
    expect(TASK_TYPE_LIST.map((t) => t.type)).toEqual([
      'summarize',
      'translate',
      'write',
      'agent',
    ]);
    for (const t of TASK_TYPE_LIST) {
      expect(t.slug, t.type).toMatch(/^sys:/);
      expect(t.templateName.length, t.type).toBeGreaterThan(0);
      expect(t.variables.length, t.type).toBeGreaterThan(0);
      expect(t.maxOutputTokens, t.type).toBeGreaterThan(0);
      expect(t.temperature, t.type).toBeGreaterThanOrEqual(0);
      expect(t.temperature, t.type).toBeLessThanOrEqual(1);
    }
  });

  it('slug 互不重复（否则会用错模板）', () => {
    const slugs = TASK_TYPE_LIST.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('只有摘要支持分块', () => {
    // 翻译/润色分块会导致人称、语气、术语前后不一致，且合并阶段无法恢复
    // Agent 自己管理上下文与分块，同样不走 Map-Reduce
    expect(TASK_TYPES.summarize.supportsChunking).toBe(true);
    expect(TASK_TYPES.translate.supportsChunking).toBe(false);
    expect(TASK_TYPES.write.supportsChunking).toBe(false);
    expect(TASK_TYPES.agent.supportsChunking).toBe(false);
  });

  it('Agent 的步数选项是 6/12/20 且默认为 12', () => {
    const maxSteps = TASK_TYPES.agent.variables.find((v) => v.key === 'maxSteps');
    expect(maxSteps).toBeDefined();
    expect(maxSteps?.default).toBe('12');
    expect(maxSteps?.options).toEqual(['6', '12', '20']);
  });

  it('Agent 的 question 是必填项（没有它任务毫无意义）', () => {
    const question = TASK_TYPES.agent.variables.find((v) => v.key === 'question');
    expect(question?.required).toBe(true);
  });

  it('不支持分块的类型给了更大的输出预算（整篇输出需要空间）', () => {
    expect(TASK_TYPES.translate.maxOutputTokens).toBeGreaterThan(
      TASK_TYPES.summarize.maxOutputTokens,
    );
    expect(TASK_TYPES.write.maxOutputTokens).toBeGreaterThan(
      TASK_TYPES.summarize.maxOutputTokens,
    );
  });

  it('翻译温度低于润色（前者要确定，后者要灵活）', () => {
    expect(TASK_TYPES.translate.temperature).toBeLessThan(TASK_TYPES.write.temperature);
  });

  it('枚举型变量都提供了 non-empty 的选项列表', () => {
    for (const t of TASK_TYPE_LIST) {
      for (const v of t.variables) {
        if (v.type === 'enum') {
          expect(v.options?.length ?? 0, `${t.type}.${v.key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('必填变量都有默认值或明确要求用户填写', () => {
    for (const t of TASK_TYPE_LIST) {
      for (const v of t.variables) {
        // 界面要求：required 的字段必须有 default，否则用户不填就会提交失败
        if (v.required) {
          expect(v.default, `${t.type}.${v.key} 是必填但没有默认值`).toBeDefined();
        }
      }
    }
  });

  it('glossary 只出现在翻译的变量里，且不是必填', () => {
    const translateKeys = TASK_TYPES.translate.variables.map((v) => v.key);
    expect(translateKeys).toContain('glossary');
    const glossary = TASK_TYPES.translate.variables.find((v) => v.key === 'glossary')!;
    expect(glossary.required).toBeFalsy();

    // 其他能力不该有它 —— 摘要/润色用不到术语表
    for (const t of TASK_TYPE_LIST.filter((x) => x.type !== 'translate')) {
      expect(t.variables.map((v) => v.key)).not.toContain('glossary');
    }
  });
});

describe('normalizeTaskType', () => {
  it('接受三种合法值', () => {
    expect(normalizeTaskType('summarize')).toBe('summarize');
    expect(normalizeTaskType('translate')).toBe('translate');
    expect(normalizeTaskType('write')).toBe('write');
  });

  it('拒绝未知值与空值（不能静默回落成摘要）', () => {
    // 回落到 summarize 会让翻译任务用摘要提示词跑 —— 结果看起来正常但完全不对
    expect(normalizeTaskType('translate2')).toBeNull();
    expect(normalizeTaskType('')).toBeNull();
    expect(normalizeTaskType(null)).toBeNull();
    expect(normalizeTaskType(undefined)).toBeNull();
    expect(normalizeTaskType('SUMMARIZE')).toBeNull();
  });
});

describe('defaultParams', () => {
  it('每种类型都能给出一份满足必填项的参数', () => {
    for (const t of TASK_TYPE_LIST) {
      const params = defaultParams(t.type);
      for (const v of t.variables) {
        if (v.required) {
          expect(params[v.key], `${t.type}.${v.key}`).toBeDefined();
        }
      }
    }
  });

  it('切换类型时不会把上一个类型的字段带过来', () => {
    const sum = defaultParams('summarize');
    const tr = defaultParams('translate');
    expect(sum).toHaveProperty('style');
    expect(tr).not.toHaveProperty('maxPoints');
    expect(tr).toHaveProperty('targetLang');
  });

  it('service 端的 taskTypeDef 与注册表一致', () => {
    expect(taskTypeDef('translate').slug).toBe(TASK_TYPES.translate.slug);
  });
});

describe('validateGlossaryInput', () => {
  it('接受合法输入并归一化', () => {
    const r = validateGlossaryInput({
      source: '  prompt  ',
      target: '  提示词 ',
      domain: '  技术 ',
      caseSensitive: true,
      note: '  统一用词 ',
    });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({
      source: 'prompt',
      target: '提示词',
      domain: '技术',
      caseSensitive: true,
      note: '统一用词',
    });
  });

  it('空领域归一化为 null（不能同时存在 "" 与 null 两种表示）', () => {
    // 否则领域过滤的 OR: [{domain: null}, {domain: '技术'}] 会漏掉 '' 那一批
    const r = validateGlossaryInput({ source: 'a', target: 'b', domain: '' });
    expect(r.value?.domain).toBeNull();
    expect(validateGlossaryInput({ source: 'a', target: 'b' }).value?.domain).toBeNull();
  });

  it('空备注归一化为 null', () => {
    expect(validateGlossaryInput({ source: 'a', target: 'b', note: '   ' }).value?.note).toBeNull();
  });

  it('缺少源词或译法都被拒', () => {
    expect(validateGlossaryInput({ source: '', target: 'b' }).ok).toBe(false);
    expect(validateGlossaryInput({ source: 'a', target: '  ' }).ok).toBe(false);
  });

  it('超长输入被拒（术语会进每条翻译请求，长文本会持续烧钱）', () => {
    expect(validateGlossaryInput({ source: 'x'.repeat(121), target: 'b' }).ok).toBe(false);
    expect(validateGlossaryInput({ source: 'a', target: 'y'.repeat(121) }).ok).toBe(false);
    expect(validateGlossaryInput({ source: 'a', target: 'b', note: 'z'.repeat(301) }).ok).toBe(false);
  });

  it('非对象输入被拒（不抛异常）', () => {
    expect(validateGlossaryInput(null).ok).toBe(false);
    expect(validateGlossaryInput('string').ok).toBe(false);
    expect(validateGlossaryInput(42).ok).toBe(false);
  });

  it('caseSensitive 只认真正的 true', () => {
    expect(validateGlossaryInput({ source: 'a', target: 'b', caseSensitive: true }).value?.caseSensitive).toBe(true);
    expect(validateGlossaryInput({ source: 'a', target: 'b', caseSensitive: 'yes' }).value?.caseSensitive).toBe(false);
  });
});

describe('checkShareLink', () => {
  const now = new Date('2026-10-16T12:00:00Z');

  function state(over: Partial<Parameters<typeof checkShareLink>[0]> = {}) {
    return { revokedAt: null, expiresAt: null, taskDeletedAt: null, ...over };
  }

  it('正常情况下有效', () => {
    expect(checkShareLink(state(), now).valid).toBe(true);
  });

  it('已撤销则无效', () => {
    const r = checkShareLink(state({ revokedAt: new Date('2026-10-15T00:00:00Z') }), now);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('revoked');
  });

  it('已过期则无效', () => {
    const r = checkShareLink(state({ expiresAt: new Date('2026-10-16T11:59:59Z') }), now);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('expired');
  });

  it('expiresAt 为 null 表示永不过期（不能被当成"早已过期"）', () => {
    // 写成 `expiresAt < now` 时 null 会隐式转成 0，把永不过期判成过期
    expect(checkShareLink(state({ expiresAt: null }), now).valid).toBe(true);
  });

  it('恰好到期的瞬间算过期（用 <= 而不是 <）', () => {
    expect(checkShareLink(state({ expiresAt: now }), now).valid).toBe(false);
  });

  it('任务被软删除后链接必须失效', () => {
    // 否则「删除任务」变成假动作：用户以为删了，链接还能打开
    const r = checkShareLink(state({ taskDeletedAt: new Date('2026-10-15T00:00:00Z') }), now);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('task_deleted');
  });

  it('撤销优先于过期（先报更明确的原因）', () => {
    const r = checkShareLink(
      state({ revokedAt: new Date('2026-10-15T00:00:00Z'), expiresAt: new Date('2026-10-14T00:00:00Z') }),
      now,
    );
    expect(r.reason).toBe('revoked');
  });
});

describe('isValidShareTokenShape', () => {
  it('接受 base64url 形态的 token', () => {
    expect(isValidShareTokenShape('AbC-123_xyz'.padEnd(43, 'a'))).toBe(true);
  });

  it('拒绝过短、含非法字符、含路径穿越的输入', () => {
    expect(isValidShareTokenShape('short')).toBe(false);
    expect(isValidShareTokenShape('a'.repeat(200))).toBe(false);
    expect(isValidShareTokenShape('../../etc/passwd')).toBe(false);
    expect(isValidShareTokenShape('has space here padding')).toBe(false);
    expect(isValidShareTokenShape('中文token中文token中文')).toBe(false);
  });

  it('形态校验的意义是先挡垃圾请求，省一次数据库查询', () => {
    expect(isValidShareTokenShape('')).toBe(false);
  });
});

/**
 * 术语表条目类型用于 prompt 拼接 —— 这里只断言类型层面的形状，
 * 真正的拼接逻辑（buildGlossaryPrompt）需要数据库，交由端到端验收覆盖。
 */
describe('GlossaryEntry 形状', () => {
  it('包含拼 prompt 所需的全部字段', () => {
    const entry: GlossaryEntry = {
      source: 'prompt',
      target: '提示词',
      domain: null,
      caseSensitive: false,
      note: null,
    };
    expect(Object.keys(entry).sort()).toEqual(
      ['caseSensitive', 'domain', 'note', 'source', 'target'].sort(),
    );
  });
});

import { describe, it, expect } from 'vitest';
import { BUILTIN_TEMPLATES } from '@/lib/tasks/builtin-templates';
import { TASK_TYPES } from '@/lib/tasks/types';

/**
 * 内置模板与任务类型注册表的一致性。
 *
 * 这些模板是「缺了就整个功能不可用」的系统级数据（见文件头注释）。
 * 加一种任务类型却忘了配提示词，运行期表现为「创建任务 500」，
 * 而测试能在一秒内指出问题。
 */
describe('BUILTIN_TEMPLATES', () => {
  it('每种任务类型恰好一个模板', () => {
    const types = Object.keys(TASK_TYPES).sort();
    const fromTemplates = BUILTIN_TEMPLATES.map((t) => t.category).sort();
    expect(fromTemplates).toEqual(types);
  });

  it('slug 与注册表一致且不重复', () => {
    const slugs = BUILTIN_TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const [type, def] of Object.entries(TASK_TYPES)) {
      expect(BUILTIN_TEMPLATES.find((t) => t.category === type)?.slug).toBe(def.slug);
    }
  });

  it('system prompt 与 user prompt 都不为空', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.systemPrompt.trim().length, `${t.slug} 的 systemPrompt 为空`).toBeGreaterThan(20);
      expect(t.userPromptTemplate.trim().length, `${t.slug} 的 userPromptTemplate 为空`).toBeGreaterThan(10);
    }
  });

  it('每个 user prompt 都引用了正文变量（否则模型拿不到材料）', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const hasContent =
        t.userPromptTemplate.includes('{{content}}') || t.userPromptTemplate.includes('{{question}}');
      expect(hasContent, `${t.slug} 的模板没有引用正文/问题变量`).toBe(true);
    }
  });

  it('变量定义来自共享注册表（保证前后端一致）', () => {
    for (const [type, def] of Object.entries(TASK_TYPES)) {
      const t = BUILTIN_TEMPLATES.find((x) => x.category === type)!;
      expect(t.variables).toEqual(def.variables);
    }
  });
});

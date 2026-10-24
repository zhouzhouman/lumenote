import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `createTaskRecord` 是单篇任务与批次**共用**的创建路径。
 *
 * 它便宜又关键：一旦这里出问题（模板解析、术语表快照、批次字段没带上），
 * 表现是「任务建出来了但跑不对」或「批次里的任务找不到归属」——都很隐蔽。
 * 用 mock 把参数装配与自愈分支钉死，比在集成测试里反查数据库快得多。
 */
const findFirst = vi.fn();
const create = vi.fn();
const extractText = vi.fn();
const ensureBuiltinTemplates = vi.fn();
const buildGlossaryPrompt = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    promptTemplate: { findFirst: (...a: unknown[]) => findFirst(...a) },
    task: { create: (...a: unknown[]) => create(...a), findFirst: vi.fn() },
  },
}));
vi.mock('@/lib/pipeline/extract/text', () => ({
  extractText: (...a: unknown[]) => extractText(...a),
}));
vi.mock('@/lib/tasks/builtin-templates', () => ({
  ensureBuiltinTemplates: (...a: unknown[]) => ensureBuiltinTemplates(...a),
}));
vi.mock('@/lib/tasks/glossary', () => ({
  buildGlossaryPrompt: (...a: unknown[]) => buildGlossaryPrompt(...a),
}));
vi.mock('@/lib/idempotency', () => ({
  isUniqueViolation: (e: unknown) =>
    typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002',
}));

const { createTaskRecord, createFailedTaskRecord } = await import('@/lib/tasks/create');

const TEMPLATE = { id: 'tpl-1', versions: [{ id: 'ver-1', version: 1 }] };

beforeEach(() => {
  findFirst.mockReset().mockResolvedValue(TEMPLATE);
  create.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'task-1',
    ...data,
  }));
  extractText.mockReset().mockResolvedValue({
    content: '正文内容',
    meta: { charCount: 4, tokenCount: 2, title: null, sourceHost: null, truncated: false },
  });
  ensureBuiltinTemplates.mockReset().mockResolvedValue([]);
  buildGlossaryPrompt.mockReset().mockResolvedValue('');
});

const baseInput = {
  userId: 'u1',
  type: 'summarize' as const,
  inputType: 'text' as const,
  content: '原始输入',
  params: { pointCount: '3' },
  model: 'deepseek-flash',
  idempotencyKey: 'k1',
};

describe('createTaskRecord', () => {
  it('正常创建：带上模板/版本、模型与批次归属', async () => {
    await createTaskRecord({ ...baseInput, batchId: 'b1', batchOrder: 2 });

    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      userId: 'u1',
      type: 'summarize',
      templateId: 'tpl-1',
      promptVersionId: 'ver-1',
      batchId: 'b1',
      batchOrder: 2,
      status: 'queued',
    });
    // 模型必须写进 params：任务详情与重跑都靠它还原「当时用的哪个模型」
    expect((data.params as Record<string, unknown>).model).toBe('deepseek-flash');
    expect(ensureBuiltinTemplates).not.toHaveBeenCalled();
  });

  it('翻译任务会把术语表快照进 params（改术语表不影响历史任务）', async () => {
    buildGlossaryPrompt.mockResolvedValue('术语：API=接口');
    await createTaskRecord({ ...baseInput, type: 'translate', params: { targetLang: 'en' } });

    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(buildGlossaryPrompt).toHaveBeenCalledWith('u1', 'en');
    expect((data.params as Record<string, unknown>).glossary).toBe('术语：API=接口');
  });

  it('摘要任务不查术语表（避免无谓的库查询）', async () => {
    await createTaskRecord(baseInput);
    expect(buildGlossaryPrompt).not.toHaveBeenCalled();
  });

  it('模板缺失时自愈一次，然后重查', async () => {
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(TEMPLATE);
    await createTaskRecord(baseInput);
    expect(ensureBuiltinTemplates).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('自愈后仍然没有模板 → 抛 TEMPLATE_MISSING（不能静默建出坏任务）', async () => {
    findFirst.mockResolvedValue(null);
    await expect(createTaskRecord(baseInput)).rejects.toMatchObject({
      code: 'TEMPLATE_MISSING',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('幂等键冲突时返回已存在的那条（并发下的兜底）', async () => {
    const existing = { id: 'task-existing', idempotencyKey: 'k1' };
    create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    // 第二次查询走 task.findFirst
    const db = (await import('@/lib/db')).prisma as unknown as {
      task: { findFirst: ReturnType<typeof vi.fn> };
    };
    db.task.findFirst.mockResolvedValueOnce(existing);

    const result = await createTaskRecord(baseInput);
    expect(result).toEqual(existing);
  });

  it('URL 输入会把原始链接存进 inputRef（可追溯来源）', async () => {
    await createTaskRecord({ ...baseInput, inputType: 'url', content: 'https://e.com/a' });
    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.inputRef).toBe('https://e.com/a');
  });
});

describe('createFailedTaskRecord', () => {
  it('创建阶段就失败的条目也要落一条 failed 记录（否则详情页会少一行）', async () => {
    await createFailedTaskRecord({
      ...baseInput,
      title: '打不开的链接',
      batchId: 'b1',
      batchOrder: 0,
      errorCode: 'EXTRACT_FAILED',
      errorMessage: '404',
    });

    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      status: 'failed',
      errorCode: 'EXTRACT_FAILED',
      inputContent: null,
      batchId: 'b1',
      batchOrder: 0,
    });
  });
});

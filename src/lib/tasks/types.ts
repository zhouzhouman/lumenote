/**
 * 任务类型与内置模板的**单一事实来源**。
 *
 * ## 为什么要把这些元数据集中到一个文件
 *
 * 一个「任务类型」牵扯到四处，它们必须完全一致：
 *  1. `prisma/seed.ts` —— 写入模板与变量定义
 *  2. `POST /api/tasks` —— 校验 type 并挑对应的 template.slug
 *  3. `pipeline/runner.ts` —— 决定用哪套 Prompt、是否走 Map-Reduce
 *  4. 前端工作台 —— 渲染参数表单
 *
 * 分散写的话，加一种能力就要改四处，而漏改一处的表现是
 * 「界面能选、提交报模板不存在」或「参数填了但没进 prompt」这类
 * 只在特定路径下才复现的问题。集中定义后，加能力只需要动这个文件 + seed。
 *
 * ⚠️ 客户端也会 import 这个文件（渲染表单），所以它必须是**纯数据、零依赖**：
 * 不能 import prisma / node: 模块 / env，否则会把服务端代码打进客户端 bundle。
 */

export type TaskType = 'summarize' | 'translate' | 'write' | 'agent';

/** 模板变量的定义（与 prisma/seed.ts 写入 PromptTemplate.variables 的结构一致） */
export interface TemplateVariableDef {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'enum';
  options?: readonly string[];
  required?: boolean;
  default?: string;
}

export interface TaskTypeDef {
  type: TaskType;
  /** 界面上显示的名称 */
  label: string;
  /** 界面上的简短说明 */
  hint: string;
  /** 系统内置模板的 slug（与 seed 写入的一致） */
  slug: string;
  templateName: string;
  variables: readonly TemplateVariableDef[];
  /**
   * 是否适合走 Map-Reduce 分块。
   *
   * 摘要：适合（长文可分段摘要再合并）。
   * 翻译：**不适合**。分块翻译会丢上下文，代词指代、语气一致性都会崩，
   *   而且合并阶段无法「恢复」被切断的语义。所以翻译走单次调用 + 输入截断。
   * 润色：不适合（需要看完整上下文才能改好）。
   *
   * ⚠️ 这个字段必须在发送前就确定，因为当前的 pipeline 是按「单个 task.type」
   * 决定走 Map 还是单跑 —— 而 Map-Reduce 的行为差异很大（输出质量与成本都不同）。
   */
  supportsChunking: boolean;
  /** 单次调用的输出上限（token）。不用分块的能力需要给足输出预算 */
  maxOutputTokens: number;
  /** 采样温度。翻译要更确定，润色可以稍灵活 */
  temperature: number;
}

export const TASK_TYPES: Record<TaskType, TaskTypeDef> = {
  summarize: {
    type: 'summarize',
    label: '长文摘要',
    hint: '超长文档自动分块摘要，输出要点/段落/执行摘要',
    slug: 'sys:summarize.long',
    templateName: '长文摘要',
    supportsChunking: true,
    maxOutputTokens: 1200,
    temperature: 0.3,
    variables: [
      {
        key: 'style',
        label: '摘要风格',
        type: 'enum',
        options: ['要点式', '段落式', '执行摘要'],
        required: true,
        default: '要点式',
      },
      { key: 'maxPoints', label: '要点数量', type: 'number', required: true, default: '5' },
      { key: 'targetReader', label: '目标读者', type: 'text', required: false, default: '普通读者' },
    ],
  },

  translate: {
    type: 'translate',
    label: '翻译',
    hint: '带术语表的翻译，强制统一专有名词译法',
    slug: 'sys:translate.default',
    templateName: '专业翻译',
    // 翻译不分块：上下文一断，人称与语气就会前后不一致
    supportsChunking: false,
    maxOutputTokens: 4000,
    // 翻译要尽量确定，温度压低
    temperature: 0.2,
    variables: [
      {
        key: 'targetLang',
        label: '目标语言',
        type: 'enum',
        options: ['中文', '英文', '日文', '韩文', '法文', '德文', '西班牙文', '俄文'],
        required: true,
        default: '中文',
      },
      {
        key: 'tone',
        label: '语气风格',
        type: 'enum',
        options: ['忠实直译', '自然流畅', '正式书面', '口语化'],
        required: true,
        default: '自然流畅',
      },
      {
        key: 'keepTerms',
        label: '保留不译的词',
        type: 'text',
        required: false,
        default: '',
      },
      /** 由服务端从术语表拼好注入，用户不直接编辑 */
      { key: 'glossary', label: '术语表', type: 'text', required: false, default: '' },
    ],
  },

  write: {
    type: 'write',
    label: '润色改写',
    hint: '保持原意重写，可选风格与改写强度',
    slug: 'sys:write.polish',
    templateName: '润色改写',
    supportsChunking: false,
    maxOutputTokens: 4000,
    temperature: 0.6,
    variables: [
      {
        key: 'intensity',
        label: '改写强度',
        type: 'enum',
        options: ['轻度润色', '中度改写', '大幅重写'],
        required: true,
        default: '轻度润色',
      },
      {
        key: 'style',
        label: '目标风格',
        type: 'enum',
        options: ['保持原风格', '简洁干练', '正式书面', '生动通俗'],
        required: true,
        default: '保持原风格',
      },
      {
        key: 'audience',
        label: '面向读者',
        type: 'text',
        required: false,
        default: '普通读者',
      },
    ],
  },

  agent: {
    type: 'agent',
    label: '文档问答',
    hint: '对文档提问，Agent 自主检索并给出带证据引用的结论',
    slug: 'sys:agent.docqa',
    templateName: '文档问答 Agent',
    // Agent 自己管理上下文与分块，不走 Map-Reduce
    supportsChunking: false,
    maxOutputTokens: 4000,
    // 检索与结论属于判别式工作，温度压低保证稳定
    temperature: 0.2,
    variables: [
      { key: 'question', label: '你想问什么', type: 'text', required: true, default: '' },
      {
        key: 'maxSteps',
        label: '最多检索轮数',
        type: 'enum',
        options: ['6', '12', '20'],
        required: true,
        default: '12',
      },
    ],
  },
};

/** 所有类型的有序列表（界面按这个顺序渲染 tab） */
export const TASK_TYPE_LIST: readonly TaskTypeDef[] = [
  TASK_TYPES.summarize,
  TASK_TYPES.translate,
  TASK_TYPES.write,
  TASK_TYPES.agent,
];

/** 校验并归一化 type 参数 */
export function normalizeTaskType(raw: string | null | undefined): TaskType | null {
  if (raw === 'summarize' || raw === 'translate' || raw === 'write' || raw === 'agent') {
    return raw;
  }
  return null;
}

/** 取某个类型的定义（调用方应确保 type 已校验过） */
export function taskTypeDef(type: TaskType): TaskTypeDef {
  return TASK_TYPES[type];
}

/**
 * 用变量定义给出一份「默认参数」。
 *
 * 用途：前端切换类型时重置表单，避免把「摘要风格」这类字段带进翻译请求。
 * 服务端也会用它兜底 —— prompt 渲染要求必填项有值，
 * 用户没填时必须回落到定义的 default，而不是注入空字符串。
 */
export function defaultParams(type: TaskType): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of TASK_TYPES[type].variables) {
    if (v.default !== undefined) out[v.key] = v.default;
  }
  return out;
}

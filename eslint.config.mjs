import next from 'eslint-config-next';

/**
 * ESLint Flat Config（ESLint 9 + eslint-config-next 16）。
 *
 * ## 为什么从 .eslintrc.json 迁移过来
 *
 * 两个原因，都是被迫的：
 *  1. Next.js 16 移除了 `next lint` 命令，没有内置的 lint 入口了
 *  2. eslint-config-next 16 只导出 flat config（一个数组），
 *     旧的 eslintrc 加载器在解析它时会抛
 *     "Converting circular structure to JSON"
 *
 * 所以这不是「顺手 modernize」，而是升级 Next 的必然代价。
 */
export default [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'build/**',
      'coverage/**',
      'next-env.d.ts',
      // Prisma 生成产物不属于我们的代码，不该被规则检查
      'src/generated/**',
    ],
  },

  ...next,

  {
    /**
     * 这条规则块**必须限定 files**。
     *
     * 不限定的话它会作用到所有文件，包括 scripts 目录下的 .mjs 脚本 —— 那些脚本
     * 不经过 TypeScript 解析，`@typescript-eslint` 插件不会被加载，于是 ESLint
     * 直接抛 "could not find plugin @typescript-eslint" 并整体退出。
     * 以前只 lint ts/tsx 所以没暴露；一旦把 scripts 纳入检查就会踩到。
     *
     * 注：本注释里刻意不写 glob 字面量（星号加斜杠连写会提前终止块注释，
     * 进而把后面整段配置解析成语法错误，报错位置离真正原因很远）。
     */
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // 未使用变量降为警告但保留，且允许 _ 前缀显式忽略
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      /**
       * 禁止 console.log，但允许 warn/error/info。
       *
       * 原因：AI 应用调试时几乎一定需要看日志，全禁会逼人用 process.stdout.write
       * 绕过规则，那更糟。真正该禁的是 console.log —— 它会遗留在生产代码里
       * 且不带级别，无法接入日志系统。
       */
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],

      // 禁止误用的 any。AI SDK 的 providerOptions 类型较松，
      // 必要时用 unknown + 显式收窄，而不是 any 逃逸。
      //
      // 注：这里刻意不开 type-aware 规则（如 await-thenable）。
      // 类型相关的检查 tsc 已经做得更准更全，而 type-aware linting
      // 会让每次 lint 都重新做一遍类型分析，CI 时间显著变长。
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  /**
   * 测试文件放宽规则。
   *
   * 测试里出现 any 和非空断言是合理的：
   * 我们故意构造错误的参数去验证边界行为，那正是 any 的用途。
   */
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
];
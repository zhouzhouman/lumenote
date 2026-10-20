/**
 * 扩展 Vitest 的 ProvidedContext 类型。
 *
 * globalSetup 通过 `provide('integrationBaseUrl', ...)` 把被测应用地址传给测试；
 * 测试通过 `inject('integrationBaseUrl')` 读取。Vitest 的 provide/inject
 * 是类型安全的，没在这里声明键名时 tsc 会直接报错（这正是我们要的：
 * 拼错键名应该在编译期失败，而不是运行时拿到 undefined）。
 */
declare module 'vitest' {
  export interface ProvidedContext {
    /** 被测应用根地址，例如 http://127.0.0.1:3210 */
    integrationBaseUrl: string;
  }
}

export {};

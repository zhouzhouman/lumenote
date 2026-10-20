'use client';

import * as React from 'react';
import { apiGet, apiPost, apiPatch, apiDelete, withQuery, ApiRequestError } from '@/lib/api-client';
import type { ProviderId, ProviderInfo, PublicCredential } from '@/lib/llm/credentials';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * 「模型设置」页面 —— 用户自带 API Key（BYOK）。
 *
 * ## 几个刻意的产品/安全选择
 *
 * 1. **密钥框用 type="password"，且提交后立刻清空 state**。
 *    不是为了防「用户看到自己的 key」，而是防「离开页面时 key 还留在 DOM / 内存里」。
 *
 * 2. **界面上永久只显示掩码**。用户想确认 key 是不是填对了，看后四位就够；
 *    真要改就重填一次（这也是所有正经云平台的做法）。
 *
 * 3. **「启用」是单选而不是开关列表**。语义上同时只能有一条生效 ——
 *    用一堆独立开关会让人以为可以同时开两条。
 */

interface CredentialsPayload {
  items: PublicCredential[];
  serverFallbackAvailable: boolean;
  mockMode: boolean;
  /** 部署方是否允许自定义接口地址（关闭时不显示该输入框） */
  allowCustomBaseUrl: boolean;
  providers: ProviderInfo[];
}

interface FormState {
  id: string | null;
  label: string;
  provider: ProviderId;
  model: string;
  baseUrl: string;
  apiKey: string;
}

const EMPTY_FORM: FormState = {
  id: null,
  label: '',
  provider: 'deepseek',
  model: '',
  baseUrl: '',
  apiKey: '',
};

export function CredentialsSettings() {
  /**
   * 用「请求键 + 重载令牌」驱动加载，而不是在 effect 里调一个会 setState 的
   * async 函数（那正是 react-hooks/set-state-in-effect 要拦的写法：
   * effect 内同步 setState 会触发级联渲染）。
   *
   * 改动数据后只需要 setReloadToken(n => n + 1)，effect 自然重跑 ——
   * 比手动维护 loading / 手动再调一次 load 更不容易漏状态。
   */
  const [reloadToken, setReloadToken] = React.useState(0);
  const [data, setData] = React.useState<CredentialsPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [showForm, setShowForm] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const reload = React.useCallback(() => setReloadToken((n) => n + 1), []);

  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const payload = await apiGet<CredentialsPayload>('/api/credentials');
        if (cancelled) return;
        setData(payload);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiRequestError ? e.message : '加载失败');
      }
    })();

    // 卸载后不再 setState
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const loading = data === null && error === null;

  const providers = data?.providers ?? [];
  const currentProvider = providers.find((p) => p.id === form.provider);

  function openCreate() {
    setForm(EMPTY_FORM);
    setFieldErrors({});
    setShowForm(true);
  }

  function openEdit(item: PublicCredential) {
    setForm({
      id: item.id,
      label: item.label,
      provider: item.provider,
      model: item.model,
      baseUrl: item.baseUrl ?? '',
      apiKey: '', // 编辑时留空表示不换 key
    });
    setFieldErrors({});
    setShowForm(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;

    setSaving(true);
    setFieldErrors({});
    setNotice(null);

    try {
      if (form.id) {
        await apiPatch(withQuery('/api/credentials', { id: form.id }), {
          label: form.label,
          model: form.model,
          baseUrl: form.baseUrl,
          // 空字符串表示「不改密钥」，不能提交空值让服务端报「过短」
          ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        });
        setNotice('已保存修改');
      } else {
        await apiPost('/api/credentials', {
          label: form.label || currentProvider?.label || '我的 API Key',
          provider: form.provider,
          model: form.model,
          baseUrl: form.baseUrl,
          apiKey: form.apiKey,
        });
        setNotice('凭证已保存，已自动启用');
      }

      // 提交后立刻清空表单里的密钥，避免它继续留在客户端内存里
      setForm(EMPTY_FORM);
      setShowForm(false);
      reload();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message);
        if (err.fields) setFieldErrors(err.fields);
      } else {
        setError('保存失败，请稍后重试');
      }
    } finally {
      setSaving(false);
    }
  }

  async function activate(item: PublicCredential) {
    setBusyId(item.id);
    setNotice(null);
    try {
      await apiPatch(withQuery('/api/credentials', { id: item.id }), { active: true });
      setNotice(`已切换到「${item.label}」`);
      reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : '切换失败');
    } finally {
      setBusyId(null);
    }
  }

  async function deactivate(item: PublicCredential) {
    setBusyId(item.id);
    try {
      await apiPatch(withQuery('/api/credentials', { id: item.id }), { active: false });
      setNotice('已停用，将回退到站点默认通道');
      reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : '停用失败');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(item: PublicCredential) {
    if (!window.confirm(`确定删除「${item.label}」？删除后无法恢复，需要重新填写 key。`)) return;
    setBusyId(item.id);
    try {
      await apiDelete(withQuery('/api/credentials', { id: item.id }));
      setNotice('已删除');
      reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : '删除失败');
    } finally {
      setBusyId(null);
    }
  }

  const items = data?.items ?? [];
  const activeItem = items.find((i) => i.active) ?? null;

  return (
    <div className="space-y-5">
      {/* 当前生效的通道 —— 用户最需要一眼确认的信息 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">当前使用的模型通道</CardTitle>
          <CardDescription>
            {activeItem ? (
              <>
                使用你自己的凭证「{activeItem.label}」（{activeItem.provider} · {activeItem.model}），
                消耗你自己的额度，不占用站点免费配额。
              </>
            ) : data?.mockMode ? (
              <>当前为 Mock 模式，输出的是本地模拟内容，不会调用真实模型。</>
            ) : data?.serverFallbackAvailable ? (
              <>
                使用站点内置的模型通道（受站点免费配额限制）。
                在下方配置你自己的 API Key 可以不受配额限制。
              </>
            ) : (
              <>
                站点未配置任何模型通道，且你还没有添加自己的 API Key —— 现在生成摘要会直接降级为本地规则提取。
              </>
            )}
          </CardDescription>
        </CardHeader>
      </Card>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-emerald-600/30 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          {notice}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">我的 API Key</CardTitle>
            <CardDescription>
              密钥使用 AES-256-GCM 加密后存储，界面上只显示掩码，任何接口都不会把它回传。
            </CardDescription>
          </div>
          {!showForm && (
            <Button size="sm" onClick={openCreate}>
              添加
            </Button>
          )}
        </CardHeader>

        <CardContent className="space-y-3">
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">加载中…</p>
          ) : items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              还没有配置。点击「添加」填入你自己的 API Key。
            </p>
          ) : (
            <ul className="space-y-2">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{item.label}</span>
                      {item.active && <Badge variant="success">正在使用</Badge>}
                      {item.lastErrorCode && (
                        <Badge variant="warning" title={`最近一次失败：${item.lastErrorCode}`}>
                          最近调用失败
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.provider} · {item.model} · {item.apiKeyHint}
                    </p>
                    {item.lastUsedAt && (
                      <p className="text-xs text-muted-foreground">
                        最近使用 {new Date(item.lastUsedAt).toLocaleString('zh-CN')}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {item.active ? (
                      <Button
                        variant="outline"
                        size="sm"
                        loading={busyId === item.id}
                        onClick={() => deactivate(item)}
                      >
                        停用
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        loading={busyId === item.id}
                        onClick={() => activate(item)}
                      >
                        启用
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => openEdit(item)}>
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={busyId === item.id}
                      onClick={() => remove(item)}
                    >
                      删除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {showForm && (
            <form onSubmit={save} className="space-y-4 rounded-md border bg-muted/20 p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="cred-provider">模型服务</Label>
                  <select
                    id="cred-provider"
                    value={form.provider}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, provider: e.target.value as ProviderId }))
                    }
                    disabled={Boolean(form.id)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  {form.id && (
                    <p className="text-xs text-muted-foreground">
                      服务类型不可修改；要换服务请新增一条
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="cred-label">名称</Label>
                  <Input
                    id="cred-label"
                    value={form.label}
                    onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                    placeholder={currentProvider?.label ?? '我的 Key'}
                    maxLength={40}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="cred-model">模型</Label>
                  {currentProvider && currentProvider.models.length > 0 ? (
                    <>
                      <Input
                        id="cred-model"
                        list="cred-model-options"
                        value={form.model}
                        onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                        placeholder={currentProvider.defaultModel}
                      />
                      <datalist id="cred-model-options">
                        {currentProvider.models.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    </>
                  ) : (
                    <Input
                      id="cred-model"
                      value={form.model}
                      onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                      placeholder="例如 gpt-4o-mini"
                    />
                  )}
                  <p className="text-xs text-muted-foreground">留空则使用默认模型</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="cred-baseurl">
                    接口地址{data?.allowCustomBaseUrl ? '（可选）' : ''}
                  </Label>
                  {data?.allowCustomBaseUrl ? (
                    <>
                      <Input
                        id="cred-baseurl"
                        value={form.baseUrl}
                        onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                        placeholder={currentProvider?.baseUrl || 'https://your-gateway.example.com/v1'}
                      />
                      {fieldErrors.baseUrl && (
                        <p className="text-xs text-destructive">{fieldErrors.baseUrl}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        走中转网关时填写；非本机地址必须是 https
                      </p>
                    </>
                  ) : (
                    // 管理员关掉了自定义地址：仍然显示生效中的值，让用户知道请求会发往哪里，
                    // 但不给编辑入口（服务端也会拒绝）
                    <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      {form.baseUrl || currentProvider?.baseUrl || '由服务端决定'}
                      <br />
                      本站未开放自定义接口地址
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cred-key">
                  API Key {form.id && <span className="text-muted-foreground">（留空表示不修改）</span>}
                </Label>
                <Input
                  id="cred-key"
                  type="password"
                  autoComplete="off"
                  value={form.apiKey}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                  placeholder={form.id ? '••••••••（不修改）' : 'sk-…'}
                />
                {fieldErrors.apiKey && <p className="text-xs text-destructive">{fieldErrors.apiKey}</p>}
                {currentProvider?.consoleUrl && (
                  <p className="text-xs text-muted-foreground">
                    还没有 key？
                    <a
                      href={currentProvider.consoleUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1 text-primary underline underline-offset-2"
                    >
                      去 {currentProvider.label} 控制台创建
                    </a>
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Button type="submit" loading={saving} disabled={!form.id && !form.apiKey}>
                  {form.id ? '保存修改' : '保存并启用'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setShowForm(false);
                    setForm(EMPTY_FORM);
                    setFieldErrors({});
                  }}
                >
                  取消
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">关于密钥安全</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-sm text-muted-foreground">
          <p>· 密钥加密后存库（AES-256-GCM），派生自服务端 AUTH_SECRET，不随数据库一起泄露。</p>
          <p>· 所有读取接口只返回掩码（如 sk-…a1b2），密钥不会回传到浏览器。</p>
          <p>· 生成摘要时密钥仅在服务端用于调用模型，不写入任何日志与任务记录。</p>
          <p>· 任务记录里只保存「用了哪条凭证」的 id，便于你自己核对成本来源。</p>
        </CardContent>
      </Card>
    </div>
  );
}

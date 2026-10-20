'use client';

import * as React from 'react';
import { apiGet, apiPost, apiPatch, apiDelete, withQuery, ApiRequestError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export interface GlossaryItem {
  id: string;
  source: string;
  target: string;
  domain: string | null;
  caseSensitive: boolean;
  note: string | null;
  createdAt: string;
}

interface Payload {
  items: GlossaryItem[];
  domains: string[];
}

interface FormState {
  id: string | null;
  source: string;
  target: string;
  domain: string;
  caseSensitive: boolean;
  note: string;
}

const EMPTY: FormState = {
  id: null,
  source: '',
  target: '',
  domain: '',
  caseSensitive: false,
  note: '',
};

/**
 * 术语表管理。
 *
 * ## 为什么领域（domain）不做成硬编码下拉
 *
 * 第一版想枚举「技术 / 医学 / 法律」这类选项，但那一定会不够用 ——
 * 用户可能在做游戏本地化、跨境电商、学术论文。所以领域是一个**自由文本**，
 * 界面上的下拉选项从已有数据里归纳出来（`domains`），
 * 既提供便利又不限制表达。
 *
 * ## 为什么空领域要存 null 而不是空串
 *
 * 「未指定领域」如果同时存在 `''` 与 `null` 两种表示，
 * 领域过滤的 `OR: [{domain: null}, {domain: '技术'}]` 就会漏掉 `''` 那一批。
 * 归一化在服务端 `validateGlossaryInput` 里做，这里保持一致（空串即不传）。
 */
export function GlossaryManager() {
  const [reloadToken, setReloadToken] = React.useState(0);
  const [data, setData] = React.useState<Payload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [form, setForm] = React.useState<FormState>(EMPTY);
  const [showForm, setShowForm] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const reload = React.useCallback(() => setReloadToken((n) => n + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await apiGet<Payload>('/api/glossary');
        if (cancelled) return;
        setData(payload);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiRequestError ? e.message : '加载失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const loading = data === null && error === null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setFieldErrors({});
    setNotice(null);

    const body = {
      source: form.source,
      target: form.target,
      domain: form.domain,
      caseSensitive: form.caseSensitive,
      note: form.note,
    };

    try {
      if (form.id) {
        await apiPatch(withQuery('/api/glossary', { id: form.id }), body);
        setNotice('已保存修改');
      } else {
        await apiPost('/api/glossary', body);
        setNotice('已添加术语');
      }
      setForm(EMPTY);
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

  async function remove(item: GlossaryItem) {
    if (!window.confirm(`确定删除术语「${item.source}」？`)) return;
    try {
      await apiDelete(withQuery('/api/glossary', { id: item.id }));
      setNotice('已删除');
      reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : '删除失败');
    }
  }

  const items = data?.items ?? [];
  const domains = data?.domains ?? [];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">术语表</CardTitle>
          <CardDescription>
            在这里指定专有名词的固定译法，翻译时会自动套用，
            保证同一术语在整篇译文中前后一致。
            {items.length > 0 && ` 当前已配置 ${items.length} 条。`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => { setForm(EMPTY); setShowForm(true); }}>
              添加术语
            </Button>
            {domains.length > 0 && (
              <span className="text-xs text-muted-foreground">
                已有领域：{domains.join(' / ')}
              </span>
            )}
          </div>

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {notice && (
            <p className="rounded-md border border-emerald-600/30 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
              {notice}
            </p>
          )}

          {showForm && (
            <form onSubmit={save} className="space-y-4 rounded-md border bg-muted/20 p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="g-source">源词</Label>
                  <Input
                    id="g-source"
                    value={form.source}
                    onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
                    placeholder="例如 prompt"
                  />
                  {fieldErrors.source && (
                    <p className="text-xs text-destructive">{fieldErrors.source}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="g-target">指定译法</Label>
                  <Input
                    id="g-target"
                    value={form.target}
                    onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))}
                    placeholder="例如 提示词"
                  />
                  {fieldErrors.target && (
                    <p className="text-xs text-destructive">{fieldErrors.target}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="g-domain">适用领域（可选）</Label>
                  <Input
                    id="g-domain"
                    list="g-domain-options"
                    value={form.domain}
                    onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))}
                    placeholder="留空 = 所有领域通用"
                  />
                  <datalist id="g-domain-options">
                    {domains.map((d) => (
                      <option key={d} value={d} />
                    ))}
                  </datalist>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="g-note">备注（可选）</Label>
                  <Input
                    id="g-note"
                    value={form.note}
                    onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                    placeholder="给未来的自己看的说明"
                  />
                </div>
              </div>

              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.caseSensitive}
                  onChange={(e) => setForm((f) => ({ ...f, caseSensitive: e.target.checked }))}
                  className="h-4 w-4 rounded border-input"
                />
                区分大小写（如 <code className="rounded bg-muted px-1">npm</code> 与{' '}
                <code className="rounded bg-muted px-1">NPM</code> 视为不同术语）
              </label>

              <div className="flex gap-2">
                <Button type="submit" loading={saving}>
                  {form.id ? '保存修改' : '添加'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setShowForm(false);
                    setForm(EMPTY);
                  }}
                >
                  取消
                </Button>
              </div>
            </form>
          )}

          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">加载中…</p>
          ) : items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              还没有术语。添加后，翻译任务会自动遵守这些译法。
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono">{item.source}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-medium">{item.target}</span>
                      {item.domain && <Badge variant="outline">{item.domain}</Badge>}
                      {item.caseSensitive && <Badge variant="secondary">区分大小写</Badge>}
                    </div>
                    {item.note && (
                      <p className="mt-1 text-xs text-muted-foreground">{item.note}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setForm({
                          id: item.id,
                          source: item.source,
                          target: item.target,
                          domain: item.domain ?? '',
                          caseSensitive: item.caseSensitive,
                          note: item.note ?? '',
                        });
                        setShowForm(true);
                      }}
                    >
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => remove(item)}
                    >
                      删除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">术语是怎么生效的</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-sm text-muted-foreground">
          {/*
            ⚠️ 这里是纯文本，不要用 Markdown 语法。
            第一版写了 `**快照进任务参数**`，界面上就原样显示了那两个星号 ——
            这类「作者以为是 Markdown、渲染出来是字面量」的问题在纯文本块里很常见。
            要强调就用「」或直接用更明确的措辞。
          */}
          <p>· 提交翻译任务时，服务端读取你当前的术语表，并把结果快照进任务参数。</p>
          <p>· 之后修改术语表不会影响已完成的历史任务 —— 这样 Prompt 指纹才是可信的。</p>
          <p>· 未指定领域的术语对所有翻译生效；指定领域的术语只在该领域生效。</p>
          <p>· 术语会被拼进每一条翻译请求，所以请只放真正需要的词（上限 60 条）。</p>
        </CardContent>
      </Card>
    </div>
  );
}

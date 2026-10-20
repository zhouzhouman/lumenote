import { CredentialsSettings } from '@/components/settings/credentials-settings';

export const metadata = {
  title: '模型设置 · Lumenote',
};

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">模型设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          填入你自己的 API Key，就用你自己的额度生成摘要 —— 不受站点免费配额限制，
          密钥加密存储且永不回传到浏览器。
        </p>
      </header>
      <CredentialsSettings />
    </div>
  );
}

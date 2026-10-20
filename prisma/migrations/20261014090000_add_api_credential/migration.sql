-- 用户自带 LLM 凭证（BYOK）。
--
-- 这张表让用户在工作台配置自己的 AI API Key，从而：
--   * 用自己的额度，不受站点免费配额限制
--   * 站点侧不再承担 token 成本
--
-- 安全前提（务必保持）：
--   * apiKeyEncrypted 只存 AES-256-GCM 密文，密钥由 AUTH_SECRET 派生；
--     任何情况下都不要新增存放明文的列。
--   * apiKeyHint 只是展示用掩码，不得用于调用。
--   * baseUrl 落库前必须经过白名单校验，否则等于把用户的 key 指向任意地址。

-- CreateTable
CREATE TABLE "ApiCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKeyEncrypted" TEXT NOT NULL,
    "apiKeyHint" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiCredential_userId_active_idx" ON "ApiCredential"("userId", "active");

-- CreateIndex
CREATE INDEX "ApiCredential_userId_idx" ON "ApiCredential"("userId");

-- AddForeignKey
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

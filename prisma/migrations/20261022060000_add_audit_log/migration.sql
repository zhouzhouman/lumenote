-- 审计日志（合规用途）+ 审计员角色位
--
-- 两个关键决定写在 SQL 里，因为它们必须体现在数据层而不是应用层：
--
-- 1. `userId` 可空、外键 `ON DELETE SET NULL`
--    删掉一个账号时，他做过的操作**不能跟着消失** —— 出事时最先要查的
--    恰恰是「离职/被删账号做过什么」。真正的那个人靠 `actorEmail` 快照记住。
--
-- 2. 没有 updatedAt、没有 deletedAt
--    审计日志一旦写入就不该被业务代码改写。应用层不提供 update/delete 接口，
--    数据层也不给软删字段，避免「悄悄改一条审计」这种最难发现的篡改。
--    彻底的不可篡改需要独立数据库账号只授 INSERT，那是部署侧的事。

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'member';

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "actorEmail" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "ip" TEXT,
    "userAgent" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

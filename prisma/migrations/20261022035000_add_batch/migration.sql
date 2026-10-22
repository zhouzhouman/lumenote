-- 批次（团队内部文档流水线）
--
-- 三件事必须在这一层定住，否则应用层怎么写都会歪：
--   1. Batch 与 Task 是 1:N，且 Task.batchId 可空 —— 单篇任务不属于任何批次
--   2. Task 上加 (batchId, batchOrder) 复合索引 —— 执行器按此顺序串行取待跑条目
--   3. 删除批次时子任务 SET NULL 而非 CASCADE —— 批次是「组织维度」，
--      任务结果本身有价值，不该因为删了个批次就一起消失

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "batchOrder" INTEGER;

-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "total" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "params" JSONB NOT NULL,
    "budgetCny" DOUBLE PRECISION,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Batch_userId_createdAt_idx" ON "Batch"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Batch_status_idx" ON "Batch"("status");

-- CreateIndex
CREATE INDEX "Task_batchId_batchOrder_idx" ON "Task"("batchId", "batchOrder");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

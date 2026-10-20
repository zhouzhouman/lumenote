-- CreateTable
CREATE TABLE "AgentStep" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "text" TEXT,
    "reasoning" TEXT,
    "toolCalls" JSONB,
    "toolResults" JSONB,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cumulativeTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentStep_taskId_seq_idx" ON "AgentStep"("taskId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStep_taskId_seq_key" ON "AgentStep"("taskId", "seq");

-- AddForeignKey
ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

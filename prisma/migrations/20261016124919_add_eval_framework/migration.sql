-- CreateTable
CREATE TABLE "EvalDataset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "taskType" TEXT NOT NULL,
    "defaultParams" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvalDataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalCase" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "params" JSONB,
    "expectations" JSONB NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "isRegression" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalRun" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "promptVersionId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "model" TEXT,
    "judgeModel" TEXT,
    "judgePromptVersion" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "totalCases" INTEGER NOT NULL DEFAULT 0,
    "passedCases" INTEGER NOT NULL DEFAULT 0,
    "failedCases" INTEGER NOT NULL DEFAULT 0,
    "weightedScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "baselineRunId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalCaseResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "output" TEXT,
    "assertions" JSONB,
    "trace" JSONB,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalCaseResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JudgeCalibration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "output" TEXT NOT NULL,
    "humanScore" INTEGER NOT NULL,
    "judgeScore" INTEGER,
    "judgeReason" TEXT,
    "agreed" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JudgeCalibration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvalDataset_userId_taskType_idx" ON "EvalDataset"("userId", "taskType");

-- CreateIndex
CREATE UNIQUE INDEX "EvalDataset_userId_name_key" ON "EvalDataset"("userId", "name");

-- CreateIndex
CREATE INDEX "EvalCase_datasetId_enabled_idx" ON "EvalCase"("datasetId", "enabled");

-- CreateIndex
CREATE INDEX "EvalRun_datasetId_createdAt_idx" ON "EvalRun"("datasetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "EvalRun_userId_createdAt_idx" ON "EvalRun"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "EvalCaseResult_runId_idx" ON "EvalCaseResult"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "EvalCaseResult_runId_caseId_key" ON "EvalCaseResult"("runId", "caseId");

-- CreateIndex
CREATE INDEX "JudgeCalibration_userId_dimension_idx" ON "JudgeCalibration"("userId", "dimension");

-- AddForeignKey
ALTER TABLE "EvalDataset" ADD CONSTRAINT "EvalDataset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalCase" ADD CONSTRAINT "EvalCase_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "EvalDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "EvalDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalCaseResult" ADD CONSTRAINT "EvalCaseResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvalRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalCaseResult" ADD CONSTRAINT "EvalCaseResult_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "EvalCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JudgeCalibration" ADD CONSTRAINT "JudgeCalibration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

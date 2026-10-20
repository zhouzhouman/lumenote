-- AlterTable
ALTER TABLE "JudgeCalibration" ADD COLUMN     "isSeed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "question" TEXT;

-- CreateIndex
CREATE INDEX "JudgeCalibration_userId_dimension_isSeed_idx" ON "JudgeCalibration"("userId", "dimension", "isSeed");

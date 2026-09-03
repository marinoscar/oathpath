-- AlterTable
ALTER TABLE "practice_attempts" ADD COLUMN     "asr_confidence" DOUBLE PRECISION,
ADD COLUMN     "retry_of_attempt_id" UUID,
ADD COLUMN     "transcript" TEXT;

-- CreateIndex
CREATE INDEX "practice_attempts_retry_of_attempt_id_idx" ON "practice_attempts"("retry_of_attempt_id");

-- AddForeignKey
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_retry_of_attempt_id_fkey" FOREIGN KEY ("retry_of_attempt_id") REFERENCES "practice_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

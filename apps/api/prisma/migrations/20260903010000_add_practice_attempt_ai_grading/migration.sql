-- CreateEnum
CREATE TYPE "PracticeFailureCause" AS ENUM ('not_known', 'not_recalled', 'expression', 'misheard', 'nervous', 'unknown');

-- AlterTable
ALTER TABLE "practice_attempts" ADD COLUMN     "failure_cause" "PracticeFailureCause",
ADD COLUMN     "ai_feedback" JSONB,
ADD COLUMN     "ai_usage_event_id" UUID;

-- CreateIndex
CREATE INDEX "practice_attempts_ai_usage_event_id_idx" ON "practice_attempts"("ai_usage_event_id");

-- AddForeignKey
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_ai_usage_event_id_fkey" FOREIGN KEY ("ai_usage_event_id") REFERENCES "ai_usage_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

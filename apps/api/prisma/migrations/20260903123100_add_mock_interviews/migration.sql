-- CreateEnum
CREATE TYPE "MockInterviewMode" AS ENUM ('text', 'voice');

-- CreateEnum
CREATE TYPE "MockInterviewStatus" AS ENUM ('in_progress', 'completed', 'abandoned');

-- CreateEnum
CREATE TYPE "MockInterviewTurnRole" AS ENUM ('officer', 'applicant');

-- CreateEnum
CREATE TYPE "MockInterviewPhase" AS ENUM ('smalltalk', 'n400', 'civics', 'reading', 'writing', 'closing');

-- AlterTable
ALTER TABLE "practice_attempts" ADD COLUMN     "mock_interview_id" UUID;

-- CreateTable
CREATE TABLE "mock_interviews" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mode" "MockInterviewMode" NOT NULL DEFAULT 'text',
    "status" "MockInterviewStatus" NOT NULL DEFAULT 'in_progress',
    "test_version_code" TEXT NOT NULL,
    "senior_exemption" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    "civics_asked" INTEGER NOT NULL DEFAULT 0,
    "civics_correct" INTEGER NOT NULL DEFAULT 0,
    "passed_civics" BOOLEAN NOT NULL DEFAULT false,
    "result" JSONB,
    "transcript_retained" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "mock_interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_interview_turns" (
    "id" UUID NOT NULL,
    "mock_interview_id" UUID NOT NULL,
    "turn_index" INTEGER NOT NULL,
    "role" "MockInterviewTurnRole" NOT NULL,
    "phase" "MockInterviewPhase" NOT NULL,
    "question_id" UUID,
    "attempt_id" UUID,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mock_interview_turns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mock_interviews_user_id_started_at_idx" ON "mock_interviews"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "mock_interviews_user_id_status_passed_civics_idx" ON "mock_interviews"("user_id", "status", "passed_civics");

-- CreateIndex
CREATE INDEX "mock_interview_turns_attempt_id_idx" ON "mock_interview_turns"("attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "mock_interview_turns_mock_interview_id_turn_index_key" ON "mock_interview_turns"("mock_interview_id", "turn_index");

-- CreateIndex
CREATE INDEX "practice_attempts_mock_interview_id_idx" ON "practice_attempts"("mock_interview_id");

-- AddForeignKey
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_mock_interview_id_fkey" FOREIGN KEY ("mock_interview_id") REFERENCES "mock_interviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_interviews" ADD CONSTRAINT "mock_interviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_interviews" ADD CONSTRAINT "mock_interviews_test_version_code_fkey" FOREIGN KEY ("test_version_code") REFERENCES "civics_test_versions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_interview_turns" ADD CONSTRAINT "mock_interview_turns_mock_interview_id_fkey" FOREIGN KEY ("mock_interview_id") REFERENCES "mock_interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_interview_turns" ADD CONSTRAINT "mock_interview_turns_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "civics_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_interview_turns" ADD CONSTRAINT "mock_interview_turns_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "practice_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

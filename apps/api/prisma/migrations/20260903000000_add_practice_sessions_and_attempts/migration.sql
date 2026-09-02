-- CreateEnum
CREATE TYPE "PracticeSessionKind" AS ENUM ('quick', 'category', 'review', 'weak', 'mixed');

-- CreateEnum
CREATE TYPE "PracticeSessionStatus" AS ENUM ('in_progress', 'completed', 'abandoned');

-- CreateEnum
CREATE TYPE "PracticeAttemptSource" AS ENUM ('practice', 'mock_interview');

-- CreateEnum
CREATE TYPE "PracticeInputMode" AS ENUM ('typed', 'spoken');

-- CreateEnum
CREATE TYPE "PracticePromptMode" AS ENUM ('read', 'heard');

-- CreateEnum
CREATE TYPE "PracticeOutcome" AS ENUM ('correct', 'partial', 'incorrect', 'skipped');

-- CreateEnum
CREATE TYPE "PracticeGradingMethod" AS ENUM ('exact', 'self', 'ai');

-- CreateTable
CREATE TABLE "practice_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "PracticeSessionKind" NOT NULL,
    "status" "PracticeSessionStatus" NOT NULL DEFAULT 'in_progress',
    "test_version_code" TEXT NOT NULL,
    "category_id" UUID,
    "planned_count" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    "summary" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "practice_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "source" "PracticeAttemptSource" NOT NULL DEFAULT 'practice',
    "session_id" UUID,
    "input_mode" "PracticeInputMode" NOT NULL DEFAULT 'typed',
    "prompt_mode" "PracticePromptMode" NOT NULL DEFAULT 'read',
    "response_text" TEXT,
    "outcome" "PracticeOutcome" NOT NULL,
    "grading_method" "PracticeGradingMethod" NOT NULL,
    "revealed" BOOLEAN NOT NULL DEFAULT false,
    "hint_used" BOOLEAN NOT NULL DEFAULT false,
    "duration_ms" INTEGER,
    "answered_at" TIMESTAMPTZ NOT NULL,
    "answer_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "practice_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "practice_sessions_user_id_started_at_idx" ON "practice_sessions"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "practice_attempts_user_id_question_id_answered_at_idx" ON "practice_attempts"("user_id", "question_id", "answered_at");

-- CreateIndex
CREATE INDEX "practice_attempts_session_id_idx" ON "practice_attempts"("session_id");

-- AddForeignKey
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_test_version_code_fkey" FOREIGN KEY ("test_version_code") REFERENCES "civics_test_versions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "civics_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "civics_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "practice_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

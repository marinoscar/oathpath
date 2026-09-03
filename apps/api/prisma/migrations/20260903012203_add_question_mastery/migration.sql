-- CreateEnum
CREATE TYPE "MasteryState" AS ENUM ('new', 'learning', 'review', 'lapsed', 'mastered');

-- CreateTable
CREATE TABLE "question_mastery" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "state" "MasteryState" NOT NULL DEFAULT 'new',
    "due_at" TIMESTAMPTZ,
    "interval_days" INTEGER NOT NULL DEFAULT 0,
    "ease" DOUBLE PRECISION NOT NULL DEFAULT 2.5,
    "correct_streak" INTEGER NOT NULL DEFAULT 0,
    "lapses" INTEGER NOT NULL DEFAULT 0,
    "total_attempts" INTEGER NOT NULL DEFAULT 0,
    "distinct_correct_days" INTEGER NOT NULL DEFAULT 0,
    "last_outcome" "PracticeOutcome",
    "last_attempt_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "question_mastery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "question_mastery_user_id_due_at_idx" ON "question_mastery"("user_id", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "question_mastery_user_id_question_id_key" ON "question_mastery"("user_id", "question_id");

-- AddForeignKey
ALTER TABLE "question_mastery" ADD CONSTRAINT "question_mastery_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_mastery" ADD CONSTRAINT "question_mastery_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "civics_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

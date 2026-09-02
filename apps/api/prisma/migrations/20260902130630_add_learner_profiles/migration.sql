-- CreateEnum
CREATE TYPE "JourneyStage" AS ENUM ('uncertain', 'oriented', 'learning', 'remembering', 'speaking', 'practicing', 'performing', 'ready');

-- CreateTable
CREATE TABLE "civics_test_versions" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "questions_asked" INTEGER NOT NULL,
    "pass_threshold" INTEGER NOT NULL,
    "senior_questions_asked" INTEGER NOT NULL,
    "senior_pass_threshold" INTEGER NOT NULL,
    "content_hash" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "civics_test_versions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "learner_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "stage" "JourneyStage" NOT NULL DEFAULT 'uncertain',
    "interview_date" DATE,
    "state_code" CHAR(2),
    "test_version_code" TEXT,
    "senior_exemption" BOOLEAN NOT NULL DEFAULT false,
    "daily_goal_minutes" INTEGER NOT NULL DEFAULT 5,
    "explanation_language" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "orientation_completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "learner_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "learner_profiles_user_id_key" ON "learner_profiles"("user_id");

-- CreateIndex
CREATE INDEX "learner_profiles_test_version_code_idx" ON "learner_profiles"("test_version_code");

-- AddForeignKey
ALTER TABLE "learner_profiles" ADD CONSTRAINT "learner_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learner_profiles" ADD CONSTRAINT "learner_profiles_test_version_code_fkey" FOREIGN KEY ("test_version_code") REFERENCES "civics_test_versions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

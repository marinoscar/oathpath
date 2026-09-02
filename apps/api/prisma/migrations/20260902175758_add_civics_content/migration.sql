-- CreateEnum
CREATE TYPE "CivicsDynamicScope" AS ENUM ('none', 'national', 'state');

-- CreateTable
CREATE TABLE "civics_categories" (
    "id" UUID NOT NULL,
    "test_version_code" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "civics_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "civics_questions" (
    "id" UUID NOT NULL,
    "test_version_code" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "category_id" UUID NOT NULL,
    "prompt" TEXT NOT NULL,
    "senior_eligible" BOOLEAN NOT NULL,
    "dynamic_scope" "CivicsDynamicScope" NOT NULL DEFAULT 'none',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "civics_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "civics_answers" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "sort" INTEGER NOT NULL,
    "state_code" CHAR(2),
    "verified_at" TIMESTAMPTZ NOT NULL,
    "effective_from" TIMESTAMPTZ NOT NULL,
    "effective_to" TIMESTAMPTZ,
    "source_note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "civics_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "civics_categories_test_version_code_code_key" ON "civics_categories"("test_version_code", "code");

-- CreateIndex
CREATE INDEX "civics_questions_category_id_idx" ON "civics_questions"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "civics_questions_test_version_code_number_key" ON "civics_questions"("test_version_code", "number");

-- CreateIndex
CREATE INDEX "civics_answers_question_id_idx" ON "civics_answers"("question_id");

-- AddForeignKey
ALTER TABLE "civics_categories" ADD CONSTRAINT "civics_categories_test_version_code_fkey" FOREIGN KEY ("test_version_code") REFERENCES "civics_test_versions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "civics_questions" ADD CONSTRAINT "civics_questions_test_version_code_fkey" FOREIGN KEY ("test_version_code") REFERENCES "civics_test_versions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "civics_questions" ADD CONSTRAINT "civics_questions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "civics_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "civics_answers" ADD CONSTRAINT "civics_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "civics_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written: Prisma's schema language cannot express a partial index (a
-- WHERE clause) or an expression index (a function over a column), so this
-- one addition does not come from schema.prisma and will not reappear if the
-- migration is regenerated from a schema diff — see the comment on the
-- CivicsAnswer model, which is the canonical explanation and points back here.
--
-- Enforces, per question: at most one OPEN (effective_to IS NULL) answer per
-- (state_code, sort) slot. "Open" is deliberate, not "at most one answer per
-- slot ever" — a CLOSED row (effective_to IS NOT NULL, i.e. a superseded
-- dynamic answer like a past President) is historical record and must be
-- freely insertable into the same slot a new open answer now occupies.
--
-- COALESCE("state_code", '') is required, not decorative: Postgres treats
-- two NULLs as DISTINCT for uniqueness purposes, so a bare
-- (question_id, state_code, sort) unique index would silently permit
-- unlimited open national answers (state_code IS NULL) at the same sort —
-- exactly the rows a dynamic-answer lifecycle (President, Speaker of the
-- House) most needs constrained to one. Folding NULL to '' makes all national
-- answers to one question collide in the index the same way a real value
-- would, so Postgres enforces the same "one open answer per slot" rule for
-- them too.
CREATE UNIQUE INDEX "civics_answers_open_slot_unique"
  ON "civics_answers" ("question_id", COALESCE("state_code", ''), "sort")
  WHERE "effective_to" IS NULL;

-- CreateEnum
CREATE TYPE "EnglishSegmentKind" AS ENUM ('reading', 'writing');

-- CreateEnum
CREATE TYPE "EnglishOutcome" AS ENUM ('correct', 'partial', 'incorrect');

-- CreateTable
CREATE TABLE "english_sentences" (
    "id" UUID NOT NULL,
    "kind" "EnglishSegmentKind" NOT NULL,
    "version" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "vocab_tags" TEXT[],
    "source_url" TEXT NOT NULL,
    "retrieved_at" TIMESTAMPTZ NOT NULL,
    "content_sha256" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "english_sentences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "english_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "sentence_id" UUID NOT NULL,
    "kind" "EnglishSegmentKind" NOT NULL,
    "response_text" TEXT NOT NULL,
    "asr_confidence" DOUBLE PRECISION,
    "wer" DOUBLE PRECISION NOT NULL,
    "diff_ops" JSONB NOT NULL,
    "outcome" "EnglishOutcome" NOT NULL,
    "replay_count" INTEGER NOT NULL DEFAULT 0,
    "answered_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "english_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "english_sentences_kind_version_idx" ON "english_sentences"("kind", "version");

-- CreateIndex
CREATE UNIQUE INDEX "english_sentences_kind_version_ordinal_key" ON "english_sentences"("kind", "version", "ordinal");

-- CreateIndex
CREATE INDEX "english_attempts_user_id_sentence_id_answered_at_idx" ON "english_attempts"("user_id", "sentence_id", "answered_at");

-- CreateIndex
CREATE INDEX "english_attempts_user_id_kind_answered_at_idx" ON "english_attempts"("user_id", "kind", "answered_at");

-- AddForeignKey
ALTER TABLE "english_attempts" ADD CONSTRAINT "english_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "english_attempts" ADD CONSTRAINT "english_attempts_sentence_id_fkey" FOREIGN KEY ("sentence_id") REFERENCES "english_sentences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

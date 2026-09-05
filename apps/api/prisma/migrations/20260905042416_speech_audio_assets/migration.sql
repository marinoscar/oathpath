-- CreateEnum
CREATE TYPE "SpeechAudioScope" AS ENUM ('civics_question', 'civics_answer');

-- CreateTable
CREATE TABLE "speech_audio_assets" (
    "id" UUID NOT NULL,
    "scope" "SpeechAudioScope" NOT NULL,
    "ref_id" UUID NOT NULL,
    "voice" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "content_sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "char_count" INTEGER NOT NULL,
    "generated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "speech_audio_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "speech_audio_assets_storage_key_key" ON "speech_audio_assets"("storage_key");

-- CreateIndex
CREATE INDEX "speech_audio_assets_content_sha256_idx" ON "speech_audio_assets"("content_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "speech_audio_assets_scope_ref_id_voice_model_id_format_cont_key" ON "speech_audio_assets"("scope", "ref_id", "voice", "model_id", "format", "content_sha256");

-- AddForeignKey
ALTER TABLE "speech_audio_assets" ADD CONSTRAINT "speech_audio_assets_generated_by_user_id_fkey" FOREIGN KEY ("generated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

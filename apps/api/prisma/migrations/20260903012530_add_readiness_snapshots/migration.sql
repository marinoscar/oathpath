-- CreateTable
CREATE TABLE "readiness_snapshots" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL,
    "score" INTEGER NOT NULL,
    "stage" "JourneyStage" NOT NULL,
    "components" JSONB NOT NULL,
    "evidence_counts" JSONB NOT NULL,
    "cap_reason" TEXT,
    "top_recommendation" JSONB NOT NULL,
    "narrative" TEXT,
    "narrative_generated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "readiness_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "readiness_snapshots_user_id_computed_at_idx" ON "readiness_snapshots"("user_id", "computed_at");

-- AddForeignKey
ALTER TABLE "readiness_snapshots" ADD CONSTRAINT "readiness_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

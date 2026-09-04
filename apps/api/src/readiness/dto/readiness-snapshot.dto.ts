import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { JOURNEY_STAGE_KEYS } from '../../journey/journey-stages';
import { READINESS_COMPONENT_KEYS } from '../readiness-engine';

// =============================================================================
// `readiness_snapshots` response shape (issue #122, epic #55 / E6)
// =============================================================================
//
// A straight wire mapping of `docs/specs/readiness-model.md` §4/§5/§8 — the
// engine's `ReadinessResult`/`ReadinessTopRecommendation` shapes, plus the
// row's own `id`/`computedAt`/`stage`/`narrative*` columns. `components` and
// `evidenceCounts` are declared field-by-field (not `z.record(z.unknown())`)
// so a client can trust the shape from the OpenAPI document rather than the
// engine's own TypeScript types, the same posture `practiceAttemptSchema`
// takes for `aiFeedback` (`gradingVerdictSchema`, imported rather than
// loosened to `unknown`).
//
// `stage` reuses `JOURNEY_STAGE_KEYS` — the one registry
// `journey-stages.ts` already declares — rather than a second enumeration of
// the eight stage keys, matching `journey/dto/journey-profile.dto.ts` and
// `journey/dto/journey-home.dto.ts`.
// =============================================================================

const readinessComponentResultSchema = z.object({
  value: z.number(),
  weight: z.number(),
  contribution: z.number(),
});

/** `ReadinessComponentKey` (readiness-engine.ts), reused rather than restated. */
export const readinessComponentKeySchema = z.enum(
  READINESS_COMPONENT_KEYS as [string, ...string[]],
);

const readinessComponentsSchema = z.object({
  coverage: readinessComponentResultSchema,
  recall: readinessComponentResultSchema,
  retention: readinessComponentResultSchema,
  consistency: readinessComponentResultSchema,
  remediation: readinessComponentResultSchema,
  english: readinessComponentResultSchema,
  spoken: readinessComponentResultSchema,
  interview: readinessComponentResultSchema,
});

/** §5's `evidenceCounts` table, one shape per component, verbatim. */
const readinessEvidenceCountsSchema = z.object({
  coverage: z.object({
    distinctQuestionsAttempted: z.number().int(),
    totalQuestionsInVersion: z.number().int(),
  }),
  recall: z.object({
    qualifyingAttempts: z.number().int(),
    correctCount: z.number().int(),
    partialCount: z.number().int(),
    incorrectCount: z.number().int(),
    skippedCount: z.number().int(),
  }),
  retention: z.object({
    masteredCount: z.number().int(),
    reviewCount: z.number().int(),
    totalAttemptedQuestions: z.number().int(),
  }),
  consistency: z.object({ distinctPracticeDaysInLast14: z.number().int() }),
  remediation: z.object({ everWeakCount: z.number().int(), remediatedCount: z.number().int() }),
  // `english-test.md` §6.2, replacing E6's single
  // `distinctQuestionsCorrectSpokenInEnglish` count. The two credit fields are
  // NOT `.int()`: a `partial` sentence contributes `0.5`, so a fractional
  // credit is the ordinary case, not a rounding artefact.
  english: z.object({
    readingSentences: z.number().int(),
    writingSentences: z.number().int(),
    readingCredit: z.number(),
    writingCredit: z.number(),
  }),
  spoken: z.object({ attempts: z.number().int() }),
  interview: z.object({ attempts: z.number().int() }),
});

/** §8.2 — the single next action a snapshot recommends. */
export const readinessTopRecommendationSchema = z.object({
  /** Null when the recommendation is the fixed cap message (§3), not a component pick. */
  componentKey: readinessComponentKeySchema.nullable(),
  title: z.string(),
  reason: z.string(),
  path: z.string(),
});

export const readinessSnapshotSchema = z.object({
  id: z.uuid(),

  /** When `computeReadiness` produced this row — `Clock.now()`, never a wall-clock read. */
  computedAt: z.iso.datetime(),

  /** 0-100. `round(weightedSum * 100)` — see `readiness-engine.ts`. */
  score: z.number().int(),

  /** The learner's `JourneyStage` at the moment this snapshot was computed. */
  stage: z.enum(JOURNEY_STAGE_KEYS),

  components: readinessComponentsSchema,
  evidenceCounts: readinessEvidenceCountsSchema,

  /** `'typed_only'`, or `null` once real spoken or interview evidence exists (§3). */
  capReason: z.enum(['typed_only']).nullable(),

  topRecommendation: readinessTopRecommendationSchema,

  /**
   * The Progress Guide's one AI-generated paragraph (issue #134, §9) — always
   * `null` from this issue's own writers (`recomputeSnapshot`, the nightly
   * cron). Absence never blocks a snapshot from being a complete, useful row.
   */
  narrative: z.string().nullable(),
  narrativeGeneratedAt: z.iso.datetime().nullable(),
});

export type ReadinessSnapshotResponse = z.infer<typeof readinessSnapshotSchema>;

export class ReadinessSnapshotDto extends createZodDto(readinessSnapshotSchema) {}

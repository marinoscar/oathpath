import type { JourneyStage } from '@prisma/client';

import type { CapReason } from '../readiness/readiness-engine';

// =============================================================================
// Evidence-driven stage transitions, from a readiness snapshot (issue #127,
// epic #55 / E6 "Readiness and Progress")
// =============================================================================
//
// `docs/specs/readiness-model.md` §8.1. A **sibling** file to
// `journey/stage-transitions.ts` — deliberately not added to it — because
// that file's own header ties it explicitly to `MasteryState` and
// per-attempt events (its own import is `MasteryState` from
// `../practice/mastery/scheduler`), making it E5's file, not a generic
// "stage transitions" file two epics happen to share. A per-snapshot,
// aggregate-score-driven decision is a genuinely different KIND of trigger
// from a per-attempt mastery-state comparison, and giving it its own file
// mirrors how `study-coach.ts` sits beside `next-action.ts` rather than
// inside it (memory-model.md §6) — one function per file per triggering event.
//
// Pure, exactly like `nextStageOnMasteryEvent`: no Prisma, no `Clock`, no I/O
// of any kind — prior/next facts in, a decision out. The caller
// (`ReadinessService.recomputeSnapshot`) owns the `learner_profiles`
// read/write; this module only ever sees the values it was handed.
//
// -----------------------------------------------------------------------------
// ONLY THREE FORWARD TRANSITIONS. EVERY OTHER COMBINATION RETURNS `null`.
// -----------------------------------------------------------------------------
//
//   remembering -> practicing   when score >= READINESS_PRACTICING_THRESHOLD (50)
//   practicing  -> performing   when score >= READINESS_PERFORMING_THRESHOLD (65)
//   performing  -> ready        when score >= READINESS_READY_THRESHOLD (80)
//                                AND capReason === null
//
// `speaking` is E9's own axis (`remembering -> speaking`), orthogonal to
// this score-driven progression rather than a rung on the same ladder — a
// learner whose stage E9 has already advanced to `speaking` is not moved by
// this function at all. Reconciling a `speaking`-staged learner's forward
// path through `practicing`/`performing`/`ready` is E9's own design
// question when it ships, not this document's decision to make on E9's
// behalf.
//
// REGRESSION NEVER HAPPENS AUTOMATICALLY, on purpose, matching the identical
// rule `ROADMAP.md` §9 already states for `speaking -> remembering`: nothing
// here ever moves a stage BACKWARD even when a score falls below a
// threshold it once cleared. The score itself is always visible and always
// honest about a decline — a silently-regressing stage badge would be
// redundant discouragement `VISION.md` rules out, not additional
// information.
//
// `ready` is the one transition gated on more than score alone, requiring
// `capReason === null` in addition to clearing 80 — `ROADMAP.md` §9:
// "`performing -> ready` belongs to E6 (#55) — `ready` is a readiness
// judgement and nothing else is entitled to make it, requiring both that
// the score clears its threshold AND that the cap has lifted, so a learner
// can never reach `ready` on typed answers alone."
// =============================================================================

/** Score at which `remembering` advances to `practicing` (readiness-model.md §8.1). */
export const READINESS_PRACTICING_THRESHOLD = 50;

/** Score at which `practicing` advances to `performing`. */
export const READINESS_PERFORMING_THRESHOLD = 65;

/** Score at which `performing` advances to `ready` — AND `capReason` must be `null`. */
export const READINESS_READY_THRESHOLD = 80;

/**
 * Decide whether a newly-computed readiness snapshot also advances the
 * learner's journey stage.
 *
 * PURE: same inputs, same output, forever. Returns the new stage to
 * persist, or `null` when nothing about this snapshot changes it — the
 * caller writes `learner_profiles.stage` only when this returns non-null,
 * as part of the same write that creates the snapshot
 * (`docs/specs/readiness-model.md` §7, §8).
 */
export function nextStageOnReadinessSnapshot(
  currentStage: JourneyStage,
  score: number,
  capReason: CapReason,
): JourneyStage | null {
  if (currentStage === 'remembering' && score >= READINESS_PRACTICING_THRESHOLD) {
    return 'practicing';
  }

  if (currentStage === 'practicing' && score >= READINESS_PERFORMING_THRESHOLD) {
    return 'performing';
  }

  if (
    currentStage === 'performing' &&
    score >= READINESS_READY_THRESHOLD &&
    capReason === null
  ) {
    return 'ready';
  }

  return null;
}

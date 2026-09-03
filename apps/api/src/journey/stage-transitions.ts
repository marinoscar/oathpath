import type { JourneyStage } from '@prisma/client';

import type { MasteryState } from '../practice/mastery/scheduler';

// =============================================================================
// Evidence-driven stage transitions (issue #82, epic #54 / E5 "Memory")
// =============================================================================
//
// `docs/specs/memory-model.md` §7. A small, pure function, deliberately shaped
// like `nextSchedule` itself (`practice/mastery/scheduler.ts`): no Prisma, no
// `Clock`, no I/O of any kind — prior/next facts in, a decision out. The
// caller (`PracticeService.scheduleMastery`) owns the transaction and the
// `learner_profiles` read/write; this module only ever sees the values it was
// handed.
//
// Two transitions, both gated on the row's CURRENT stage alone (never on a
// count of how many times something has happened before) — the same posture
// `nextSchedule`'s own state-crossing rules take, ROADMAP.md's decision log
// entry: "Every journey stage has an owning epic."
//
//   oriented  -> learning     unconditionally, the instant ANY schedulable
//                              outcome produces (or updates) a
//                              `question_mastery` row — correct or incorrect
//                              alike (§3.8's Row 1 and Row 5). Because `stage`
//                              only ever moves forward and this check reads
//                              the profile's CURRENT stage inside the same
//                              transaction as the write that triggers it,
//                              "the first time this fires" and "every time
//                              this fires while still `oriented`" are the
//                              same event — there is no separate "is this
//                              really the first row" query to write.
//
//   learning  -> remembering  when a question is verified `mastered` for the
//                              first time: `priorMasteryState !== 'mastered'`
//                              and `nextMasteryState === 'mastered'`. Both
//                              facts are already sitting in `nextSchedule`'s
//                              own return value (paired with the record it
//                              was called against) from the same transaction
//                              — no separate count of "how many mastered rows
//                              does this user have" is computed.
//
// `speaking` and `ready` remain E9's and E6's respectively; nothing here
// touches either, and every other `(currentStage, prior, next)` combination —
// including a stage past `learning`, where no further automatic transition is
// defined by this epic — returns `null`, "no change".
// =============================================================================

/**
 * Decide whether one graded attempt's mastery transition also advances the
 * learner's journey stage.
 *
 * PURE: same inputs, same output, forever. Returns the new stage to persist,
 * or `null` when nothing about this event changes it — the caller writes
 * `learner_profiles.stage` only when this returns non-null, inside the same
 * transaction as the `question_mastery` write that produced
 * `nextMasteryState` (docs/specs/memory-model.md §4, §7).
 */
export function nextStageOnMasteryEvent(
  currentStage: JourneyStage,
  priorMasteryState: MasteryState,
  nextMasteryState: MasteryState,
): JourneyStage | null {
  if (currentStage === 'oriented') {
    return 'learning';
  }

  if (
    currentStage === 'learning' &&
    priorMasteryState !== 'mastered' &&
    nextMasteryState === 'mastered'
  ) {
    return 'remembering';
  }

  return null;
}

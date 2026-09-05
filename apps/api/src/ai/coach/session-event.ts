// =============================================================================
// Session summary → reaction event (issue #320, epic #305)
// =============================================================================
//
// The three `session.complete_*` cells of `reaction-lines.ts`, resolved from
// the only three numbers a completed session's own summary already carries.
//
// -----------------------------------------------------------------------------
// COMPUTED AT READ TIME, FROM THE STORED SUMMARY — NEVER WRITTEN INTO IT
// -----------------------------------------------------------------------------
//
// `practice_sessions.summary` is a cached rendering of the session's attempts
// (`practice-sessions.md` §2.1), written once at completion and never edited
// again. A reaction line written INTO it would be copy frozen at the moment a
// learner happened to finish — unimprovable without a backfill, and stale the
// first time the bank is edited — which is exactly the trade
// `docs/specs/coach-personality.md` §9 refuses for an attempt. This function
// is the "compute it on read, beside it" half of that refusal: the summary
// stays the tally it always was, and the line is derived from it every time
// the session is read.
//
// -----------------------------------------------------------------------------
// THE BANDS, AND WHY THESE CUTOFFS
// -----------------------------------------------------------------------------
//
// The civics test itself is the anchor a learner already has: USCIS's 2008
// version passes at 6 of 10 and the 2025 version at 12 of 20 — both 60%. So
// the three bands are drawn around what "passing" means to the person reading
// them rather than around a round number:
//
//   >= 80%  strong  — comfortably above the passing mark, on this set.
//   >= 50%  mixed   — around or just under it. Real progress, not a good day.
//   <  50%  weak    — more of this set is unlearned than learned.
//
// §6 states plainly that these cutoffs belong to "the reaction-selection
// module's own implementation, not to the epic's locked contract", so moving
// them is a tuning change and does not reopen that document.
//
// A `partial` answer counts as neither correct nor incorrect here, exactly as
// it does in the summary's own fields — the ratio is `correct / answered`, the
// same two numbers a summary screen puts at the top of itself, so the line and
// the number a learner is reading it next to can never disagree.
// =============================================================================

import type { CoachReactionEvent } from './reaction-lines';

/** At or above this share of answered questions correct: `strong`. */
export const COACH_SESSION_STRONG_RATIO = 0.8;

/** At or above this share (and below strong): `mixed`. Below it: `weak`. */
export const COACH_SESSION_MIXED_RATIO = 0.5;

/**
 * The two summary fields this reads, narrowed to a type a test can build in a
 * line. Every completed session's stored summary has both.
 */
export interface CoachSessionFacts {
  /** How many attempts the session actually produced. */
  readonly answered: number;

  /** How many of them were `outcome: 'correct'`, self-marks included. */
  readonly correct: number;
}

/**
 * Which of the three completion events a finished session is.
 *
 * A session with NO answered questions is `weak` — not for judgement's sake
 * but because it is the only honest one of the three: nothing was got right,
 * and the bank's `weak` lines are the ones written to end on a forward action
 * (the floor's seventh rule) rather than to commiserate about a score.
 */
export function coachEventForSessionSummary(
  facts: CoachSessionFacts,
): CoachReactionEvent {
  if (facts.answered <= 0) return 'session.complete_weak';

  const ratio = facts.correct / facts.answered;

  if (ratio >= COACH_SESSION_STRONG_RATIO) return 'session.complete_strong';
  if (ratio >= COACH_SESSION_MIXED_RATIO) return 'session.complete_mixed';

  return 'session.complete_weak';
}

import type { AttemptOutcome } from './scheduler';

// =============================================================================
// Outcome mapping between `practice_attempts` and `question_mastery` (issue
// #78, epic #54 / E5 "Memory")
// =============================================================================
//
// `nextSchedule` (scheduler.ts) speaks a THREE-value outcome —
// `AttemptOutcome`: `correct`, `incorrect`, `correct_self_marked`. Nothing
// else this codebase writes an attempt's result as matches that shape:
//
//   - `practice_attempts.outcome` is the FOUR-value `PracticeOutcome` enum —
//     `correct` / `partial` / `incorrect` / `skipped` — plus a SEPARATE
//     `gradingMethod` column (`exact` / `self` / `ai`) that is what actually
//     distinguishes a self-mark from a verified match.
//   - `question_mastery.last_outcome` reuses that same FOUR-value
//     `PracticeOutcome` enum on purpose (schema.prisma's own comment on the
//     column: "the four values a practice_attempts row can already carry ...
//     are exactly what 'the most recent attempt's result' means here too") —
//     it is NOT typed to hold `correct_self_marked`, which is not one of
//     Postgres's four `practice_outcome` values and never will be.
//
// This file is the one place those two shapes are reconciled, in both
// directions, so no caller re-derives the mapping and no caller stores a
// value the `question_mastery` column cannot actually hold.
//
// -----------------------------------------------------------------------------
// INTO the scheduler: (outcome, gradingMethod) -> AttemptOutcome
// -----------------------------------------------------------------------------
//
// `toAttemptOutcome` is what turns ONE GRADED ATTEMPT into the input
// `nextSchedule` expects:
//
//   - `outcome: 'correct'` graded by `gradingMethod: 'self'` (the self-mark
//     route, `PracticeService.selfMarkAttempt`) -> `'correct_self_marked'`,
//     which is exactly the case scheduler.ts's own header documents: half the
//     ease bump and half the interval growth of a verified correct answer.
//   - `outcome: 'correct'` by any other grading method (`exact` or `ai`) ->
//     `'correct'`.
//   - `outcome: 'partial'` and `outcome: 'skipped'` both collapse to
//     `'incorrect'`. Neither is a value `AttemptOutcome` has room for, and
//     both are, for scheduling purposes, "no correct recall was demonstrated
//     this time" — a partial or unanswered question earns no ease bump and no
//     interval growth, exactly like a wrong one. (Nothing in this epic
//     schedules a `skipped` attempt today — `PracticeService.grade` never
//     escalates a skip to the grader, and #78 wires scheduling onto the two
//     real call sites, `recordAttempt` and `selfMarkAttempt`, both of which
//     DO run this mapping for a skip. A skip is real evidence per
//     practice-sessions.md §6, and "was not recalled" is the honest thing to
//     tell the scheduler about it.)
//   - `outcome: 'incorrect'` -> `'incorrect'`.
export function toAttemptOutcome(
  outcome: 'correct' | 'partial' | 'incorrect' | 'skipped',
  gradingMethod: 'exact' | 'self' | 'ai',
): AttemptOutcome {
  if (outcome === 'correct') {
    return gradingMethod === 'self' ? 'correct_self_marked' : 'correct';
  }
  return 'incorrect';
}

// -----------------------------------------------------------------------------
// OUT of the scheduler: AttemptOutcome -> the value written into
// `question_mastery.last_outcome`
// -----------------------------------------------------------------------------
//
// `nextSchedule` returns `lastOutcome: outcome` verbatim — the very
// `AttemptOutcome` it was called with — because scheduler.ts (deliberately)
// has no notion of the DB's four-value enum. `toStoredMasteryOutcome` is what
// makes that return value writable: `correct_self_marked` collapses to
// `correct`.
//
// THIS IS A DELIBERATE, DOCUMENTED LOSS OF ONE BIT OF INFORMATION AT THIS ONE
// COLUMN, NOT A FORGOTTEN CASE. `question_mastery.last_outcome` exists for
// exactly one live read today — `nextSchedule`'s own same-UTC-calendar-day
// dedup for `distinctCorrectDays` (scheduler.ts, "DISTINCT-DAY COUNTING"),
// which only ever asks `isCorrectOutcome(lastOutcome)`, a boolean. Whether
// that most recent correct answer was self-marked is never read back from
// this column for any purpose — it is not what the column is for. The real,
// permanent, per-attempt record of self-marking is `practice_attempts.
// grading_method`, which this mapping never touches and which is what E5's
// mastery weighting (and any later reader) should consult for "was this
// SPECIFIC attempt self-marked", not this column.
export function toStoredMasteryOutcome(
  outcome: AttemptOutcome,
): 'correct' | 'incorrect' {
  return outcome === 'incorrect' ? 'incorrect' : 'correct';
}

// -----------------------------------------------------------------------------
// READING a mastery row back OUT of the database, into `MasteryRecord.lastOutcome`
// -----------------------------------------------------------------------------
//
// The inverse of `toStoredMasteryOutcome`, for the one caller that reads a
// persisted `question_mastery` row and hands it back to `nextSchedule` as a
// `MasteryRecord` — `PracticeService`'s mastery upsert. `partial` and
// `skipped` are included in the input type for totality (this column is
// typed `PracticeOutcome | null` in Prisma, so a value read back could in
// principle be either, even though `toStoredMasteryOutcome` above never
// writes them) and map to `'incorrect'` for the identical reason
// `toAttemptOutcome` does.
export function fromStoredMasteryOutcome(
  outcome: 'correct' | 'partial' | 'incorrect' | 'skipped' | null,
): AttemptOutcome | null {
  if (outcome === null) return null;
  return outcome === 'correct' ? 'correct' : 'incorrect';
}

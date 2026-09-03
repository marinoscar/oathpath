import {
  NEXT_ACTION_PATHS,
  recommendNextAction,
  type NextAction,
  type NextActionInput,
} from './next-action';

// =============================================================================
// The deterministic Study Coach (issue #82, epic #54 / E5 "Memory")
// =============================================================================
//
// `docs/specs/memory-model.md` §6. Widens `next-action.ts`'s closed
// `NextActionKind` union by exactly the one member its own header already
// anticipated by name: `review`. Nothing about the existing four kinds'
// ordering or paths changes — `orientation > interview_countdown > review >
// practice > explore` — `review` slots in between the two E1/E3 branches
// that already gate on "is there an interview coming up" and "has the
// learner practiced today", because reviewing material that is due or lapsed
// is a more specific, more urgent true thing to say than a generic
// five-question nudge, but never more urgent than an actual interview date
// on the calendar.
//
// -----------------------------------------------------------------------------
// WHY THIS WRAPS `recommendNextAction` RATHER THAN RE-IMPLEMENTING IT
// -----------------------------------------------------------------------------
//
// Branches 1 (orientation), 2 (interview countdown), and the practice/explore
// pair are already correct, already tested, and already the copy the product
// ships. Restating them here would be a second place that ordering and that
// copy could drift from `next-action.ts`'s own. Instead, `recommendStudyAction`
// below calls `recommendNextAction` for everything EXCEPT the one new rung —
// the same "extend-the-union-when-the-destination-exists discipline"
// `next-action.ts`'s own header already promises this epic will use.
//
// -----------------------------------------------------------------------------
// WHY THIS MUST BE A PURE FUNCTION, STATED AS PLAINLY AS `next-action.ts`'s
// OWN HEADER STATES IT, BECAUSE THE REASONING DOES NOT CHANGE ONE EPIC LATER
// -----------------------------------------------------------------------------
//
// "What should I do next" must produce an identical, explainable answer on
// two consecutive loads, must work with no AI key configured at all, and must
// never put a provider outage in front of the single most-viewed card in the
// product. E6 (`docs/specs/ai-evaluation.md`'s `tutor` role) may layer a
// model-written narrative GLOSS on top of whatever `kind`/`reason` this
// function already decided — epic #54's own decision 4 says so explicitly —
// but the decision itself never moves into `AiDispatchService`. NO AI CALL
// HAPPENS HERE, and none ever should.
// =============================================================================

/**
 * Widens {@link NextActionInput} with exactly the mastery facts this epic
 * adds — nothing broader. Both counts are computed the same way
 * `GET /api/practice/queue`'s response is (`mastery/selector.ts`'s
 * `classifyMasteryBucket`) — one shared query (`PracticeService.getQueue`),
 * not a duplicate count kept in sync by convention.
 */
export interface StudyCoachInput extends NextActionInput {
  /**
   * `question_mastery` rows in the selector's DUE bucket right now:
   * `state IN (review, lapsed)` with `dueAt <= now`. The same figure
   * `GET /api/practice/queue`'s `due` field reports.
   */
  dueCount: number;

  /**
   * `question_mastery` rows in the selector's WEAK bucket right now — a
   * `lapsed` row (any `dueAt`), or a `learning`/`review` row meeting
   * `WEAK_LAPSES_THRESHOLD`'s struggling predicate. The same figure
   * `GET /api/practice/queue`'s `weak` field reports. Named `lapsedCount`
   * here (docs/specs/memory-model.md §6's own field name) because the bucket
   * this counts is the design's "lapsed and weak" pool — see this file's own
   * header note on the one place this implementation had to make a judgment
   * call about the field's exact scope.
   */
  lapsedCount: number;
}

/**
 * The single recommendation to show, given a profile AND its mastery state.
 *
 * ORDERING IS THE CONTRACT:
 *
 *   orientation  >  interview_countdown  >  review  >  practice  >  explore
 *
 * Branches 1, 2, 4, and 5 are `recommendNextAction`'s own branches 1
 * through 4, called through unchanged — see that function for their reasons.
 * Branch 3, `review`, is the only new decision this file makes.
 */
export function recommendStudyAction(input: StudyCoachInput): NextAction {
  // 1. Not oriented — `recommendNextAction`'s own branch 1.
  if (input.orientationCompletedAt === null) {
    return recommendNextAction(input);
  }

  // 2. An interview date that has not passed — `recommendNextAction`'s own
  // branch 2. A booked date is the more specific true thing to say, and
  // outranks review exactly as it outranks the ordinary practice nudge.
  if (input.daysUntilInterview !== null && input.daysUntilInterview >= 0) {
    return recommendNextAction(input);
  }

  // 3. Oriented, no interview ahead of them, and there is real due or lapsed
  // evidence waiting. This is the one new rung E5 inserts.
  //
  // JUDGMENT CALL, flagged rather than silently resolved: §6's quoted reason
  // text is `"You have {dueCount} question(s) ready to review…"`, but the
  // FIRE condition is `dueCount + lapsedCount > 0`. Read literally, a
  // learner with `dueCount: 0, lapsedCount: 3` would both see this card AND
  // be told "You have 0 questions ready to review" — a fabricated-confidence
  // shape journey-shell.md §10 rules out elsewhere. `reviewCount` below is
  // the sum, used for BOTH the gate and the copy, so the number in the
  // sentence is always the number that made the card appear.
  const reviewCount = input.dueCount + input.lapsedCount;
  if (reviewCount > 0) {
    return {
      kind: 'review',
      title: reviewTitle(reviewCount),
      reason: `You have ${reviewCount} question${reviewCount === 1 ? '' : 's'} ready to review — reviewing what you've already learned keeps it from slipping.`,
      path: NEXT_ACTION_PATHS.review,
    };
  }

  // 4 & 5. Oriented, no interview ahead of them, nothing due or lapsed:
  // `recommendNextAction`'s own branches 3 and 4 (practice / explore),
  // decided by `hasPractisedToday` exactly as they always were.
  return recommendNextAction(input);
}

/** Mirrors `next-action.ts`'s own `countdownTitle` — spell out the singular. */
function reviewTitle(count: number): string {
  return count === 1 ? 'Review 1 question.' : `Review ${count} questions.`;
}

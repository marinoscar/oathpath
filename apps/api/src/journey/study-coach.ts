import type { JourneyStageKey } from './journey-stages';
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
// `docs/specs/memory-model.md` §6, extended by `docs/specs/mock-interview.md`
// §14.1 (#133, epic #57 / E8). This file owns the two rungs `next-action.ts`
// cannot decide on its own, and the full ordering is:
//
//   orientation > interview_countdown > review > practice > interview > explore
//
// `review` (E5, #82) slots between the two E1/E3 branches that already gate on
// "is there an interview coming up" and "has the learner practiced today",
// because reviewing material that is due or lapsed is a more specific, more
// urgent true thing to say than a generic five-question nudge, but never more
// urgent than an actual interview date on the calendar.
//
// `interview` (E8, #133) slots between `practice` and `explore` — after the
// four rungs that were already here, and before the "nothing more specific to
// say" fallback. Two things decide that position, and both are stated at the
// branch itself: an interview is the most realistic thing this product can
// offer someone with nothing more urgent to do, and it is a bigger ask than
// five questions, so it must never displace the daily nudge.
//
// -----------------------------------------------------------------------------
// WHY THIS WRAPS `recommendNextAction` RATHER THAN RE-IMPLEMENTING IT
// -----------------------------------------------------------------------------
//
// Branches 1 (orientation), 2 (interview countdown), and the practice/explore
// pair are already correct, already tested, and already the copy the product
// ships. Restating them here would be a second place that ordering and that
// copy could drift from `next-action.ts`'s own. Instead, `recommendStudyAction`
// below calls `recommendNextAction` for everything EXCEPT its own two rungs —
// the same "extend-the-union-when-the-destination-exists discipline"
// `next-action.ts`'s own header already promises every epic will use.
//
// The one subtlety worth naming, because delegating both ends of a chain to
// one function looks like it should not work: `recommendNextAction`'s branches
// 3 and 4 (`practice` / `explore`) are decided by `hasPractisedToday` alone, so
// this file can insert `interview` between them by checking that same boolean
// itself and delegating on either side of its own branch. Nothing is
// duplicated; the delegation simply happens twice, in two branches, for the two
// answers that boolean can give.
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

  /**
   * The learner's own `learner_profiles.stage` (#133, epic #57 / E8).
   *
   * READ, NOT INFERRED. It gates the `interview` rung below and nothing else —
   * `recommendNextAction`'s four branches never see it, which is why it lives
   * on this interface rather than on `NextActionInput`. A stage is exactly the
   * kind of fact `next-action.ts`'s own header keeps out of that narrower
   * input: "a future field on `learner_profiles` cannot quietly become an input
   * to the front page without a signature change." This is that signature
   * change, in a diff.
   */
  stage: JourneyStageKey;
}

/**
 * The journey stages at which a mock interview is worth recommending.
 *
 * `mock-interview.md` §14.1: "offered only at stage `practicing` or beyond —
 * never to a learner still in `remembering` or earlier, because a mock
 * interview presumes real civics competence to rehearse against; recommending
 * one earlier would be asking a learner to sit through a likely-failing
 * rehearsal of a test they have not yet demonstrated readiness for the ordinary
 * way."
 *
 * A SET OF THREE KEYS RATHER THAN AN INDEX COMPARISON over `JOURNEY_STAGE_KEYS`.
 * An ordinal check ("at or past `practicing`") reads as the more general rule
 * and is the more fragile one: the eight stages are ordered by narrative, not by
 * competence, and `speaking` sits before `practicing` while `ready` sits after
 * `performing`. Naming the three keys means inserting a ninth stage into the
 * registry cannot silently start or stop offering interviews to a population
 * nobody considered — it fails to compile if the key is misspelled and does
 * nothing at all if a new stage is added, which is the safe default for a card
 * that invites someone to sit a full rehearsal.
 */
const INTERVIEW_STAGES: readonly JourneyStageKey[] = [
  'practicing',
  'performing',
  'ready',
];

/**
 * The single recommendation to show, given a profile AND its mastery state.
 *
 * ORDERING IS THE CONTRACT:
 *
 *   orientation > interview_countdown > review > practice > interview > explore
 *
 * Branches 1, 2, 4 and 6 are `recommendNextAction`'s own branches 1 through 4,
 * called through unchanged — see that function for their reasons. Branches 3
 * (`review`, E5) and 5 (`interview`, E8) are the two decisions this file makes.
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

  // 4. Oriented, no interview ahead of them, nothing due or lapsed, and
  // nothing recorded today: `recommendNextAction`'s own branch 3, the
  // five-question nudge, unchanged.
  //
  // IT OUTRANKS `interview` DELIBERATELY, and `mock-interview.md` §14.1 gives
  // the reason as a trade rather than a preference: an interview is a bigger
  // ask than five questions, and `VISION.md`'s "Five Minutes Should Matter" is
  // what keeps this product usable on a day with little time to spare. Ranking
  // the interview higher would mean a learner who opens the app for a quick
  // five-question session is greeted instead with an invitation to a full
  // rehearsal — the wrong trade on the one card that has to answer "what should
  // I do next" with the single most useful true thing, not the single most
  // impressive one.
  if (!input.hasPractisedToday) {
    return recommendNextAction(input);
  }

  // 5. Oriented, no interview date, nothing due, today's practice already done,
  // and far enough along the journey to have something to rehearse. This is the
  // one new rung E8 inserts.
  //
  // There is genuinely nothing more urgent to recommend to this learner, and a
  // mock interview is the single most realistic thing this product can offer
  // someone in that position — which is the whole of `VISION.md`'s one
  // aspiration ("by the time a user walks into their naturalization interview,
  // the experience should feel familiar").
  //
  // THE COPY IS AN INVITATION, NOT A PUSH. No countdown, no streak, no "before
  // it's too late", no number they could lose. `VISION.md` is explicit: "we
  // should never create pressure, shame, fear, or unhealthy compulsion to
  // increase engagement metrics", and a full rehearsal is exactly the card most
  // tempting to sell with urgency. It says what the thing is and leaves the
  // decision with the learner.
  if (INTERVIEW_STAGES.includes(input.stage)) {
    return {
      kind: 'interview',
      title: 'Try a practice interview.',
      reason:
        "You've done today's practice. When you have a quiet twenty minutes, a full " +
        'practice interview is the closest this gets to the real thing — and the more ' +
        'familiar the day feels, the easier it is.',
      path: NEXT_ACTION_PATHS.interview,
    };
  }

  // 6. Everything else: `recommendNextAction`'s own branch 4 (`explore`),
  // reached by a learner who has practised today and is not yet far enough
  // along for an interview to be a fair suggestion.
  return recommendNextAction(input);
}

/** Mirrors `next-action.ts`'s own `countdownTitle` — spell out the singular. */
function reviewTitle(count: number): string {
  return count === 1 ? 'Review 1 question.' : `Review ${count} questions.`;
}

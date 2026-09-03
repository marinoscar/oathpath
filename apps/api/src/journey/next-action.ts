// =============================================================================
// The nextAction recommender (issue #65, epic #50; extended by #81, epic #52)
// =============================================================================
//
// Home renders ONE deterministic recommendation at a time. ROADMAP §7 is
// explicit that the function producing it "is a pure function over mastery
// counts, coverage, recency, and journey stage — not a model call. It must
// produce an identical, explainable answer on two consecutive loads."
//
// E1 had no mastery counts and no coverage (those are E5) and so had exactly
// three things to say. E3 adds the fourth — `practice` — because there is now
// somewhere real to send a learner and a real fact about today to decide on.
// It is still a plain exported function rather than a service method, for the
// reason journey-shell.md §4.2 gives: it is a pure function over a profile
// shape and is unit-tested directly, independently of DI, HTTP, or whether the
// live UI can currently reach a given branch.
//
// NO AI CALL HAPPENS HERE, and none ever should. Two consecutive loads of Home
// must produce the same card; a model call would make that a coin flip and
// would put a provider outage in front of the application's front page.
//
// -----------------------------------------------------------------------------
// `kind` IS A CLOSED UNION, AND THAT IS THE SECURITY-SHAPED PART
// -----------------------------------------------------------------------------
//
// journey-shell.md §4.1 states the invariant as a structural rule rather than
// a review note: A NEXT ACTION MUST NEVER POINT AT A ROUTE THAT REDIRECTS TO
// `/`. A learner who taps "Continue" and lands back on the screen the card was
// on has just watched the product contradict itself.
//
// The cap on `kind` is HOW that is enforced. Each kind maps to exactly one
// hardcoded path in {@link NEXT_ACTION_PATHS} below — never a caller-supplied
// string, never a path assembled from user input, never a value read out of
// the profile. Adding a kind in a later epic means adding one more hardcoded,
// verified path to the same closed map. §11 records the free-form-string
// alternative and why it lost.
//
// -----------------------------------------------------------------------------
// WHAT E3 CHANGED, AND WHY THE NOTE THAT USED TO SIT HERE IS GONE
// -----------------------------------------------------------------------------
//
// This block used to explain why BOTH non-orientation kinds pointed at
// `/learn`: `/practice` existed as a real route but held a designed empty
// state, so an interview countdown's honest advice was "start with the
// material", not "go to a page where practice does not exist yet". It ended
// with an instruction to the contributor who shipped E3 — re-point
// `interview_countdown` at `/practice` rather than "fix" the duplication into
// two identical branches.
//
// **That is what this file now does** (#81, epic #52). `/practice` runs real
// sessions — Quick 5, by category, graded, recorded as `practice_attempts` —
// so:
//
//   * `interview_countdown` points at `/practice`, and its reason no longer
//     promises practice as something to "build up to". It is here.
//   * `practice` joins the union as its own kind, for the learner with no
//     interview date who simply has not practised yet today.
//   * `explore` keeps pointing at `/learn` (practice-sessions.md §12 is
//     explicit that only the countdown re-points), but its copy changed too:
//     see the branch itself.
//
// One more hardcoded, verified path in the same closed map. Nothing about the
// mechanism changed — only how many real destinations there are to name.
//
// E5 adds `review` (#82, epic #54), on the same extend-the-union-when-the-
// destination-exists discipline this file's own header already promised: it
// is produced by `study-coach.ts`'s `recommendStudyAction`, which wraps this
// file's `recommendNextAction` rather than duplicating branches 1, 2, and 4 —
// see that file for the ordering.
//
// E8 CLAIMS `interview` (#133, epic #57). This block used to end "E8's
// `interview` is still unclaimed; neither route exists yet, so neither member
// does either", and the second half of that sentence is exactly the condition
// that has now been met: `/practice/interviews` is a real, mounted route from
// this epic on, so the member exists too. One more hardcoded, verified path in
// the same closed map; nothing about the mechanism changed. Like `review`, it
// is produced by `study-coach.ts` and never by this file's own
// `recommendNextAction`, which has no journey stage to decide it with — the
// ordering is `orientation > interview_countdown > review > practice >
// interview > explore`.
// =============================================================================

/**
 * The six recommendations this recommender's closed union can carry.
 *
 * `practice` is E3's addition (#81); `review` is E5's (#82) and `interview` is
 * E8's (#133) — both produced by `study-coach.ts`, never by this file's own
 * `recommendNextAction`, which still only ever returns one of the other four.
 * It has neither mastery counts nor a journey stage to decide those two
 * branches with, by design.
 *
 * Declared in ranking order, which is not decorative: `study-coach.ts`'s chain
 * runs top to bottom through this list.
 */
export const NEXT_ACTION_KINDS = [
  'orientation',
  'interview_countdown',
  'review',
  'practice',
  'interview',
  'explore',
] as const;

/** Derived from the array, so the two cannot disagree. */
export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number];

/**
 * The ONLY paths a next action can carry, one per kind.
 *
 * Every value here is a real, mounted, non-redirecting route:
 *
 *   - `/setup/journey` — the orientation screen, mounted OUTSIDE its own gate
 *     (journey-shell.md §5) so recommending it can never start a redirect loop.
 *   - `/practice` — one of the four bar destinations, a real route since E1
 *     (§2.3) and a real destination since E3: it runs the sessions
 *     `practice.controller.ts` serves.
 *   - `/learn` — likewise a bar destination, carrying E2's civics content.
 *   - `/practice/interviews` — E8's mock interview list and start screen
 *     (#133). Not a new destination: it mounts UNDER the existing `/practice`
 *     prefix, exactly as `/practice/sessions/:id` already does, so
 *     `destinations.ts` gains no entry. `mock-interview.md` §14 states the
 *     reachability-vs-content distinction that makes it content within a
 *     destination rather than a destination of its own.
 *
 * `interview_countdown`, `review`, and `practice` deliberately share
 * `/practice`. That is three kinds naming one destination, not a duplicated
 * branch: they differ in what they SAY (a countdown is about a date; `review`
 * is about specific due/lapsed evidence; `practice` is about today generally),
 * and collapsing them would lose the countdown, which is the single most
 * emotionally loaded card this product shows. The Practice page reads
 * `nextAction.kind` to decide which session kind (`review` vs. the default) to
 * default into.
 *
 * `interview` does NOT share it, and that is the point of adding a fourth
 * hardcoded path rather than a fifth kind pointing at `/practice`: a card that
 * invites a learner to rehearse a full interview and then lands them on the
 * five-question drill page would be the "points at a route that does not do
 * what the card said" failure this map exists to prevent, one step short of the
 * redirect case it was written for.
 *
 * Frozen because this is process-lifetime state a serialiser or a careless
 * `Object.assign` must not be able to repoint.
 */
export const NEXT_ACTION_PATHS: Readonly<Record<NextActionKind, string>> =
  Object.freeze({
    orientation: '/setup/journey',
    interview_countdown: '/practice',
    review: '/practice',
    practice: '/practice',
    interview: '/practice/interviews',
    explore: '/learn',
  });

/** One recommendation, exactly as `GET /api/journey/home` sends it. */
export interface NextAction {
  kind: NextActionKind;
  title: string;
  reason: string;
  /** Always one of {@link NEXT_ACTION_PATHS}' values. Never assembled. */
  path: string;
}

/**
 * Everything the recommender is allowed to see.
 *
 * Deliberately NOT the Prisma row, and deliberately not "the learner's
 * practice history" either: this narrows the input to the three facts the
 * decision actually turns on, so a future field on `learner_profiles` — or a
 * future column on `practice_attempts` — cannot quietly become an input to the
 * front page without a signature change.
 */
export interface NextActionInput {
  /** Null until orientation is submitted. */
  orientationCompletedAt: Date | null;

  /**
   * Whole calendar days from today to the interview, in the LEARNER'S
   * timezone — negative once the date has passed, null when none is set.
   * Computed by the caller through `Clock.calendarDateIn`, never here: this
   * function has no notion of "now" at all, which is what makes it trivially
   * deterministic.
   */
  daysUntilInterview: number | null;

  /**
   * Whether this learner has recorded at least one practice attempt on
   * TODAY'S calendar day IN THEIR OWN TIMEZONE (#81).
   *
   * A BOOLEAN, NOT A COUNT, on purpose. The branch below asks "any?" and
   * nothing else, and a number in this interface would be a number some later
   * copy change is tempted to render — "you have answered 3 questions today" —
   * at a point where `dailyGoal.tracked` is still `false` and Home has no
   * measured target to compare it against. journey-shell.md §10's rule against
   * displaying a figure the learner cannot interpret applies to a 3 exactly as
   * it applies to a 0. When E6/E7 land real session tracking they can widen
   * this with a reason; today the honest input is a yes or a no.
   *
   * Like `daysUntilInterview`, the timezone reduction happens in the caller.
   * This function still has no notion of "now".
   */
  hasPractisedToday: boolean;
}

/**
 * The single recommendation to show, given a profile.
 *
 * ORDERING IS THE CONTRACT — for THIS function:
 *
 *   orientation  >  interview_countdown  >  practice  >  explore
 *
 * `study-coach.ts`'s `recommendStudyAction` wraps this function with two more
 * rungs: `review` (E5, #82), ranked between `interview_countdown` and
 * `practice`, and `interview` (E8, #133), ranked between `practice` and
 * `explore`. This function itself is unchanged and still never returns either:
 * it has no mastery data and no journey stage to decide those branches with, by
 * design (see that file's header).
 *
 * A learner who has not finished setup has nothing useful to be told about a
 * date they entered halfway through it. A learner with a date on the calendar
 * is told about the date, whether or not they have already practised today —
 * the countdown outranks the nudge because it is the more specific true thing
 * to say. Everything else is "practise today", and `explore` is what is left
 * once they have.
 *
 * E3 inserted `practice` between the countdown and `explore` and moved nothing
 * that was already there. One consequence is worth naming rather than
 * discovering: a learner whose interview date has PASSED now falls through the
 * countdown into `practice` rather than into `explore`. That is the intended
 * reading — we do not know how their interview went (see branch 2), and
 * inviting them to practise is the one suggestion that is true either way.
 */
export function recommendNextAction(input: NextActionInput): NextAction {
  // 1. Not oriented.
  //
  // In the live product this branch NEVER RENDERS: `RequireOrientation`
  // hard-blocks an unoriented learner before Home mounts, so anyone who could
  // see this card was already redirected to `/setup/journey`. It stays in the
  // union anyway, for the reason journey-shell.md §4.2 gives — a profile with
  // no `orientation_completed_at` is a real input this pure function must
  // answer correctly regardless of whether the live gate makes that answer
  // reachable through the UI. Stating the gap is more honest than dropping the
  // case from the type and hoping nobody asks why.
  if (input.orientationCompletedAt === null) {
    return {
      kind: 'orientation',
      title: 'Finish setting up your plan.',
      reason: "A couple of quick questions, then you're ready to start.",
      path: NEXT_ACTION_PATHS.orientation,
    };
  }

  // 2. An interview date that has not passed. `>= 0` includes today: an
  // interview happening in a few hours is the most relevant thing this product
  // could possibly say to that learner.
  //
  // A date in the PAST falls through — to `practice` now, `explore` before E3
  // — rather than counting up. We do not know how the interview went; nobody
  // has told us. "Your interview was 12 days ago" would be a claim dressed as
  // a countdown, and §10's honesty rule covers exactly that shape of
  // fabricated confidence.
  //
  // The reason line no longer says "Start with the material, then build up to
  // full practice." That sentence was true only while `/practice` was an empty
  // state; it now points at real sessions, so it says what practice is FOR.
  if (input.daysUntilInterview !== null && input.daysUntilInterview >= 0) {
    return {
      kind: 'interview_countdown',
      title: countdownTitle(input.daysUntilInterview),
      reason:
        'Practice is the closest thing to the real interview. A few questions today, and the day itself will feel familiar.',
      path: NEXT_ACTION_PATHS.interview_countdown,
    };
  }

  // 3. Oriented, no interview ahead of them, and nothing recorded today.
  //
  // The whole product in one card: five questions is a few minutes, and the
  // attempts it records are the evidence E5's readiness model is built from.
  if (!input.hasPractisedToday) {
    return {
      kind: 'practice',
      title: 'Practice five questions.',
      reason:
        "It only takes a few minutes, and every answer you give builds the evidence that you're ready.",
      path: NEXT_ACTION_PATHS.practice,
    };
  }

  // 4. Oriented, no interview ahead of them, and they have already practised
  // today. There is genuinely nothing more urgent to ask of this learner.
  //
  // THE OLD COPY HERE BECAME FALSE THE MOMENT E3 SHIPPED. It read "The
  // learning and practice tools are on their way. For now, take a look at
  // what's ready." — honest in E1, when this branch was the answer for every
  // oriented learner and neither tool existed. Both exist now, and this branch
  // is only ever reached by someone who has just used one of them, so keeping
  // that sentence would have made the card tell a learner their own completed
  // practice session had not been built yet. journey-shell.md §9.1 still
  // records the E1 wording; it is superseded by this branch.
  return {
    kind: 'explore',
    title: "You've practiced today.",
    reason:
      "That's today's work done. Look around the material whenever you want, or come back later for another round.",
    path: NEXT_ACTION_PATHS.explore,
  };
}

/**
 * journey-shell.md §9.1 writes this title as "*N* days until your interview".
 * Zero and one are spelled out rather than rendered literally: "0 days until
 * your interview" is wrong about the day it is describing, and "1 days" is
 * simply broken English on the single most emotionally loaded card this
 * product shows. Neither is a change to the contract — the count is still the
 * same server-computed integer — only to how it reads at its two edge values.
 */
function countdownTitle(days: number): string {
  if (days === 0) {
    return 'Your interview is today.';
  }
  if (days === 1) {
    return '1 day until your interview';
  }
  return `${days} days until your interview`;
}

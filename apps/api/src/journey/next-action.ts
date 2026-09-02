// =============================================================================
// The nextAction recommender (issue #65, epic #50)
// =============================================================================
//
// Home renders ONE deterministic recommendation at a time. ROADMAP §7 is
// explicit that the function producing it "is a pure function over mastery
// counts, coverage, recency, and journey stage — not a model call. It must
// produce an identical, explainable answer on two consecutive loads."
//
// E1 has no mastery counts and no coverage (those are E5), so this version has
// exactly three things to say. It is a plain exported function rather than a
// service method for the reason journey-shell.md §4.2 gives: it is a pure
// function over a profile shape and is unit-tested directly, independently of
// DI, HTTP, or whether the live UI can currently reach a given branch.
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
// WHY BOTH NON-ORIENTATION KINDS POINT AT `/learn` TODAY
// -----------------------------------------------------------------------------
//
// Deliberate, not a missed distinction (journey-shell.md §4). `/learn` is
// created by #69 and receives E2's real civics content in the very next epic;
// E3's practice loop does not exist until after it. An interview countdown's
// honest advice today is "start with the material", not "go to a page where
// practice does not exist yet".
//
// **E3 (#52) re-points `interview_countdown` to `/practice`** once Practice
// has real content to send a learner to. A contributor finding both kinds
// pointing at `/learn` should extend the mapping when E3 ships, not "fix" this
// into two identical branches now.
// =============================================================================

/**
 * The three recommendations E1 can make.
 *
 * E3/E5/E8 each add exactly one member when their route exists to receive it —
 * `practice` (E3), `review` (E5), `interview` (E8) — following the same
 * extend-the-union-when-the-destination-exists discipline the stage and
 * destination registries use.
 */
export const NEXT_ACTION_KINDS = [
  'orientation',
  'interview_countdown',
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
 *   - `/learn` — one of the four bar destinations, which ship as real routes in
 *     E1 (§2.3) precisely so this invariant holds the moment E1 lands.
 *
 * Frozen because this is process-lifetime state a serialiser or a careless
 * `Object.assign` must not be able to repoint.
 */
export const NEXT_ACTION_PATHS: Readonly<Record<NextActionKind, string>> =
  Object.freeze({
    orientation: '/setup/journey',
    interview_countdown: '/learn',
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
 * Deliberately NOT the Prisma row: this narrows the input to the two facts the
 * decision actually turns on, so a future field on `learner_profiles` cannot
 * quietly become an input to the front page without a signature change.
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
}

/**
 * The single recommendation to show, given a profile.
 *
 * Ordering is the contract: orientation outranks a countdown, and a countdown
 * outranks exploring. A learner who has not finished setup has nothing useful
 * to be told about a date they entered halfway through it.
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
  // A date in the PAST falls through to `explore` rather than counting up. We
  // do not know how the interview went — nobody has told us — so "your
  // interview was 12 days ago" would be a claim dressed as a countdown, and
  // §10's honesty rule covers exactly that shape of fabricated confidence.
  if (input.daysUntilInterview !== null && input.daysUntilInterview >= 0) {
    return {
      kind: 'interview_countdown',
      title: countdownTitle(input.daysUntilInterview),
      reason: 'Start with the material, then build up to full practice.',
      path: NEXT_ACTION_PATHS.interview_countdown,
    };
  }

  // 3. Oriented, no upcoming date, and E1 has nothing more specific to say.
  return {
    kind: 'explore',
    title: "See what's here so far.",
    reason:
      "The learning and practice tools are on their way. For now, take a look at what's ready.",
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

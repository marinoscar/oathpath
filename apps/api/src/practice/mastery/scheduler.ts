// =============================================================================
// nextSchedule (issue #75, epic #54 / E5 "Memory")
// =============================================================================
//
// A pure SM-2 spaced-repetition variant over one question's mastery record.
// No NestJS, no Prisma, no `Clock`, no I/O of any kind — `now` is a plain
// parameter, exactly like `grading.ts` and `answer-matching.ts` take no
// runtime dependency on anything but their own inputs. The caller that will
// eventually wire this into `PracticeService` owns the `Clock` and reads
// `clock.now()`; this module only ever sees the `Date` it was handed.
//
// -----------------------------------------------------------------------------
// THE TWO FACTS ISSUE #67's docs-dev NEEDS TO MATCH EXACTLY
// -----------------------------------------------------------------------------
//
// 1. SELF-MARKED DISCOUNT: a `correct_self_marked` outcome applies HALF of the
//    ease bump a `correct` outcome would (`EASE_BUMP_SELF_MARKED` is exactly
//    half of `EASE_BUMP_CORRECT`) and HALF of the interval growth a `correct`
//    outcome would produce (`SELF_MARKED_INTERVAL_DISCOUNT = 0.5`, applied to
//    the same base interval a `correct` outcome would have computed, then
//    floored to a minimum of one day). Stated plainly: self-marked correct
//    applies 50% of the normal ease bump and interval growth.
//
// 2. DISTINCT-DAY COUNTING: `distinctCorrectDays` increments on any correct
//    outcome (`correct` or `correct_self_marked`) UNLESS `lastOutcome` was
//    itself a correct outcome AND `lastAttemptAt` falls on the same UTC
//    calendar date as `now` — in which case it is left unchanged. This is a
//    deliberate approximation: `MasteryRecord` stores only the single most
//    recent attempt, not a full history, so "distinct days" is tracked as a
//    rolling counter guarded by a one-attempt lookback rather than a true set
//    of dates. It cannot detect a same-day repeat that is not the IMMEDIATELY
//    preceding attempt (e.g. correct, then incorrect, then correct again, all
//    on one day, would double-count) — acceptable for a per-record counter
//    per the issue, and cheap to upgrade later if a full attempt history
//    (`practice_attempts`, which E5's caller will have on hand) is threaded
//    through instead.
//
// A `correct_self_marked` outcome still counts toward `distinctCorrectDays`
// on the same footing as an objective `correct` — the learner did produce or
// recognize the right answer on a real day, which is what that counter
// measures. Its "discount" is expressed entirely through the smaller ease
// bump and interval growth above, not by withholding the promotion to
// `mastered`: `MasteryRecord` keeps no record of *which* of the last three
// distinct days were self-marked, so gating promotion on that would need more
// state than this record carries. `review` → `mastered` uses the same
// `distinctCorrectDays >= MASTERY_PROMOTION_THRESHOLD` check regardless of
// which correct variant most recently pushed the counter there.
//
// -----------------------------------------------------------------------------
// STATE MACHINE
// -----------------------------------------------------------------------------
//
// On any correct outcome:
//   new      -> learning
//   learning -> review
//   lapsed   -> learning   (rebuilding after a regression, one step below review)
//   review   -> mastered   (only once distinctCorrectDays >= 3), else stays review
//   mastered -> mastered
//
// On an incorrect outcome:
//   review, mastered -> lapsed   (an actual regression; `lapses` increments)
//   new, learning, lapsed -> learning   (a miss on a question not yet proven,
//                                        not a regression; `lapses` unchanged)
// =============================================================================

/** The five mastery states a question can be in for one learner. */
export type MasteryState = 'new' | 'learning' | 'review' | 'lapsed' | 'mastered';

/** The three ways a practice attempt can be graded, as this scheduler sees it. */
export type AttemptOutcome = 'correct' | 'incorrect' | 'correct_self_marked';

/** One question's spaced-repetition state for one learner. */
export interface MasteryRecord {
  state: MasteryState;
  dueAt: Date | null;
  intervalDays: number;
  ease: number;
  correctStreak: number;
  lapses: number;
  totalAttempts: number;
  distinctCorrectDays: number;
  lastOutcome: AttemptOutcome | null;
  lastAttemptAt: Date | null;
}

/** SM-2's traditional starting ease factor. */
const STARTING_EASE = 2.5;

/** SM-2's traditional floor — an ease factor never drops below this. */
const MIN_EASE = 1.3;

/**
 * The ceiling this variant imposes on ease growth. Classic SM-2 leaves ease
 * unbounded above; this codebase caps it so a long correct streak converges
 * on a maximum spacing multiplier instead of growing without limit.
 */
const MAX_EASE = 3.0;

/** The ease bump for an objectively-graded correct outcome. */
const EASE_BUMP_CORRECT = 0.1;

/** Half of {@link EASE_BUMP_CORRECT} — see the file header's discount note. */
const EASE_BUMP_SELF_MARKED = EASE_BUMP_CORRECT / 2;

/** The ease penalty for an incorrect outcome. */
const EASE_PENALTY_INCORRECT = 0.2;

/** Half growth for a self-marked correct — see the file header's discount note. */
const SELF_MARKED_INTERVAL_DISCOUNT = 0.5;

/** The short interval an incorrect (or freshly-lapsed) attempt reschedules to. */
const LAPSE_INTERVAL_DAYS = 1;

/** The second-ever correct repetition's interval, before ease-driven growth begins. */
const SECOND_REPETITION_INTERVAL_DAYS = 3;

/** How many distinct correct days `review` needs to promote to `mastered`. */
const MASTERY_PROMOTION_THRESHOLD = 3;

function clampEase(ease: number): number {
  return Math.min(MAX_EASE, Math.max(MIN_EASE, ease));
}

/** Round to two decimal places — keeps ease values stable across repeated calls. */
function roundEase(ease: number): number {
  return Math.round(ease * 100) / 100;
}

function isCorrectOutcome(outcome: AttemptOutcome): boolean {
  return outcome === 'correct' || outcome === 'correct_self_marked';
}

/** Same UTC calendar date, matching `Clock.calendarDateIn`'s day-boundary semantics. */
function isSameUtcCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * The SM-2 interval progression an OBJECTIVELY correct outcome would produce,
 * seeded from the record's ease and its interval as of the previous attempt:
 * 1 day on the first correct repetition, 3 days on the second, then
 * `previousIntervalDays * ease` (rounded, floored at 1) from the third
 * repetition onward — the "1 -> 3 -> interval*ease" progression this issue
 * specifies. `correct_self_marked` reuses this same base and then discounts
 * it (see {@link SELF_MARKED_INTERVAL_DISCOUNT}) rather than defining a
 * second progression, so the two variants can never silently drift apart.
 */
function baseCorrectIntervalDays(
  newCorrectStreak: number,
  ease: number,
  previousIntervalDays: number,
): number {
  if (newCorrectStreak <= 1) return LAPSE_INTERVAL_DAYS;
  if (newCorrectStreak === 2) return SECOND_REPETITION_INTERVAL_DAYS;
  return Math.max(1, Math.round(previousIntervalDays * ease));
}

function nextStateOnCorrect(state: MasteryState, distinctCorrectDays: number): MasteryState {
  switch (state) {
    case 'new':
      return 'learning';
    case 'learning':
      return 'review';
    case 'lapsed':
      return 'learning';
    case 'review':
      return distinctCorrectDays >= MASTERY_PROMOTION_THRESHOLD ? 'mastered' : 'review';
    case 'mastered':
      return 'mastered';
  }
}

function nextStateOnIncorrect(state: MasteryState): MasteryState {
  return state === 'review' || state === 'mastered' ? 'lapsed' : 'learning';
}

/**
 * Advance one question's mastery record by one graded attempt.
 *
 * PURE: same inputs, same output, forever, and `mastery` is never mutated —
 * a new object is always returned. `totalAttempts`, `lastOutcome` and
 * `lastAttemptAt` are updated unconditionally; everything else follows the
 * branch below.
 */
export function nextSchedule(
  mastery: MasteryRecord,
  outcome: AttemptOutcome,
  now: Date,
): MasteryRecord {
  const totalAttempts = mastery.totalAttempts + 1;

  if (!isCorrectOutcome(outcome)) {
    const wasRegression = mastery.state === 'review' || mastery.state === 'mastered';

    return {
      ...mastery,
      state: nextStateOnIncorrect(mastery.state),
      dueAt: addDays(now, LAPSE_INTERVAL_DAYS),
      intervalDays: LAPSE_INTERVAL_DAYS,
      ease: roundEase(clampEase(mastery.ease - EASE_PENALTY_INCORRECT)),
      correctStreak: 0,
      lapses: mastery.lapses + (wasRegression ? 1 : 0),
      totalAttempts,
      distinctCorrectDays: mastery.distinctCorrectDays,
      lastOutcome: outcome,
      lastAttemptAt: now,
    };
  }

  // Both correct variants share the distinct-day rule verbatim — see the file
  // header. `correct_self_marked` counts on the same footing as `correct`.
  const lastAttemptWasCorrectToday =
    mastery.lastOutcome !== null &&
    isCorrectOutcome(mastery.lastOutcome) &&
    mastery.lastAttemptAt !== null &&
    isSameUtcCalendarDay(mastery.lastAttemptAt, now);

  const distinctCorrectDays = lastAttemptWasCorrectToday
    ? mastery.distinctCorrectDays
    : mastery.distinctCorrectDays + 1;

  const correctStreak = mastery.correctStreak + 1;
  const isSelfMarked = outcome === 'correct_self_marked';

  const easeBump = isSelfMarked ? EASE_BUMP_SELF_MARKED : EASE_BUMP_CORRECT;
  const ease = roundEase(clampEase(mastery.ease + easeBump));

  const baseIntervalDays = baseCorrectIntervalDays(correctStreak, mastery.ease, mastery.intervalDays);
  const intervalDays = isSelfMarked
    ? Math.max(1, Math.round(baseIntervalDays * SELF_MARKED_INTERVAL_DISCOUNT))
    : baseIntervalDays;

  return {
    ...mastery,
    state: nextStateOnCorrect(mastery.state, distinctCorrectDays),
    dueAt: addDays(now, intervalDays),
    intervalDays,
    ease,
    correctStreak,
    lapses: mastery.lapses,
    totalAttempts,
    distinctCorrectDays,
    lastOutcome: outcome,
    lastAttemptAt: now,
  };
}

/** A fresh mastery record for a question a learner has never attempted. */
export function initialMasteryRecord(): MasteryRecord {
  return {
    state: 'new',
    dueAt: null,
    intervalDays: 0,
    ease: STARTING_EASE,
    correctStreak: 0,
    lapses: 0,
    totalAttempts: 0,
    distinctCorrectDays: 0,
    lastOutcome: null,
    lastAttemptAt: null,
  };
}

// =============================================================================
// The streak engine (issue #119, epic #56 / E7 "Habit")
// =============================================================================
//
// `docs/specs/habit-streaks.md` §4.1-§4.2, implemented verbatim.
//
// PURE — no Nest, no Prisma, no Clock, and no import statement at all. That is
// the identical shape `nextSchedule` (`practice/mastery/scheduler.ts`,
// memory-model.md §3) and `computeReadiness` (`readiness/readiness-engine.ts`,
// readiness-model.md §5) already establish for a rule that must produce the
// same output for the same input forever, and that must be directly
// unit-testable against a table of cases with no database in the loop.
//
// Everything time-shaped this file needs is already resolved by its caller:
// `today` arrives as the string `Clock.calendarDateIn(timezone)` returned, and
// every `date` is a stored `daily_activity.activity_date` — a LOCAL calendar
// day (§3), never an instant. Nothing here reads a clock, so nothing here can
// disagree with the day the caller is asking about.
// =============================================================================

/** One `daily_activity` row, reduced to the three facts a streak is made of. */
export interface StreakDay {
  /** `YYYY-MM-DD`, this learner's `activity_date` — a LOCAL day (§3). */
  date: string;
  goalMet: boolean;
  freezeUsed: boolean;
}

export interface StreakEvidence {
  /** `YYYY-MM-DD`, the caller's `Clock.calendarDateIn(timezone)` result. */
  today: string;

  /**
   * Every `daily_activity` row this learner has, in ANY order.
   *
   * Deliberately the entire history rather than a bounded recent window (§4.2):
   * `longest` is defined over all of it, and a window would silently cap
   * `longest` at the window size the first time an account is old enough to
   * exceed it.
   */
  days: StreakDay[];
}

export interface StreakResult {
  current: number;
  longest: number;
}

/**
 * A day counts toward a streak when the learner met their goal on it, **or**
 * when settlement recorded a freeze covering it (§4.1).
 *
 * A settled freeze row is `goalMet: false, freezeUsed: true` (§4.4) — it is
 * not a fabricated practice day, which is exactly why "qualifies" is an OR of
 * two distinct columns here rather than one flag written by both writers.
 */
function qualifies(day: StreakDay): boolean {
  return day.goalMet || day.freezeUsed;
}

/**
 * A `YYYY-MM-DD` string as a day number: days since the Unix epoch.
 *
 * `Date.UTC` is a pure function of the numbers handed to it — it reads no
 * clock and has no timezone of its own — which is what keeps this file's
 * "no clock at all" promise intact while still doing calendar arithmetic.
 * Reducing both dates to integers first is what makes a comparison a count of
 * CALENDAR days rather than of elapsed time, so a DST transition inside a
 * learner's zone can neither shorten nor lengthen a streak.
 *
 * The identical construction `journey.service.ts` and `readiness.service.ts`
 * each already use for the same job; it is restated rather than imported
 * because this module imports nothing (see the header).
 */
function dayIndexOf(calendarDate: string): number {
  const [year, month, day] = calendarDate.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/**
 * `current` and `longest`, from a learner's whole `daily_activity` history.
 *
 * `longest` is the longest run of consecutive qualifying days anywhere in that
 * history — one pass over the sorted day indices.
 *
 * `current` uses §4.1's anchor rule: the walk starts at `today` if today
 * already qualifies, else at `yesterday` if yesterday does, else the streak is
 * `0`. Ending "today or yesterday" is deliberate — a learner who always
 * practises in the evening must not be shown `0` at 2pm, which is functionally
 * a false claim that their streak already broke. The grace is exactly one day
 * long: once a day genuinely ends with no qualifying row and no freeze, it
 * ages out of the window the next morning and the streak reflects that.
 *
 * A duplicate date cannot occur — `@@unique([userId, activityDate])` is a real
 * database constraint (§2.4) — but a repeated entry would still be harmless
 * here: days are reduced to a set of qualifying day indices, so a duplicate
 * contributes its day once.
 */
export function computeStreak(evidence: StreakEvidence): StreakResult {
  const qualifyingDayIndices = new Set<number>();
  for (const day of evidence.days) {
    if (qualifies(day)) {
      qualifyingDayIndices.add(dayIndexOf(day.date));
    }
  }

  const ordered = Array.from(qualifyingDayIndices).sort((a, b) => a - b);

  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const index of ordered) {
    run = previous !== null && index === previous + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = index;
  }

  const today = dayIndexOf(evidence.today);
  let anchor: number | null = null;
  if (qualifyingDayIndices.has(today)) {
    anchor = today;
  } else if (qualifyingDayIndices.has(today - 1)) {
    anchor = today - 1;
  }

  let current = 0;
  if (anchor !== null) {
    let cursor = anchor;
    while (qualifyingDayIndices.has(cursor)) {
      current += 1;
      cursor -= 1;
    }
  }

  return { current, longest };
}

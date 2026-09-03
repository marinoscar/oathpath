import type { StreakDay } from './streak-engine';

// =============================================================================
// Freeze settlement (issue #119, epic #56 / E7 "Habit")
// =============================================================================
//
// `docs/specs/habit-streaks.md` §4.3-§4.5, implemented verbatim: the budget,
// its replenishment, and the bounded backward walk that decides which missed
// days a freeze actually covers.
//
// PURE — the same idiom `streak-engine.ts` beside it follows, and for the same
// reason: "how many freezes does this learner hold, and which days do they
// cover" is a rule that must produce the same answer for the same input
// forever, and must be unit-testable against a table of cases with no database
// in the loop. The single import is a TYPE, erased at compile time; this module
// still reads no clock, holds no Prisma client, and performs no I/O.
//
// It DECIDES; it does not write. `EngagementService.settle` is what turns the
// plan below into `daily_activity` rows and a `learner_profiles` update, and
// the split is what makes "settlement is idempotent" (§4.4's first reason)
// testable as arithmetic rather than as a database race.
// =============================================================================

/** The hard ceiling on held freezes (§4.3). Not "2 plus whatever has accrued since". */
export const STREAK_FREEZE_MAX = 2;

/** At most one freeze granted per this many days (§4.3). */
export const FREEZE_REPLENISH_INTERVAL_DAYS = 7;

/**
 * How far back settlement will reach (§4.5).
 *
 * Deliberately separate from the budget itself: a learner returning after a
 * month away does not get a month of retroactive freeze rows even with an
 * unlimited budget. Bounding the look-back is what keeps "protection" from
 * quietly becoming "nothing ever actually breaks a streak".
 */
export const FREEZE_SETTLE_LOOKBACK_DAYS = 7;

export interface FreezeSettlementInput {
  /** `YYYY-MM-DD`, the caller's `Clock.calendarDateIn(timezone)` result. */
  today: string;

  /** Every `daily_activity` row this learner has, in ANY order. */
  days: StreakDay[];

  /** `learner_profiles.streak_freezes` — how many the learner holds right now. */
  streakFreezes: number;

  /**
   * Whole days since `learner_profiles.streak_freezes_granted_at`, or `null`
   * for "never replenished" — a real, distinct state, not a sentinel (§4.3).
   */
  daysSinceLastGrant: number | null;
}

export interface FreezeSettlementPlan {
  /** True when this settlement grants one freeze (§4.3). At most one, ever. */
  grantFreeze: boolean;

  /**
   * The local days a freeze covers, **oldest first** — one `daily_activity`
   * row each, `freezeUsed: true` with zeroed counters (§4.4). Empty whenever
   * nothing needs covering, nothing can be covered, or nothing is worth
   * covering.
   */
  freezeDays: string[];

  /** The balance after granting and spending — what the summary reports. */
  streakFreezesAfter: number;

  /**
   * True when this pass CHANGES the balance — granting or spending — and the
   * caller must therefore stamp `learner_profiles.streak_freezes_granted_at`
   * with this pass's instant (§4.3).
   *
   * IT IS NOT `grantFreeze`, AND A LATER READER MUST NOT COLLAPSE IT BACK INTO
   * ONE. Stamping only on a grant leaves the column at its `null` "never
   * replenished" value after a pass that only CONSUMED — and `null` is exactly
   * what {@link settleStreakFreezes} reads, one line above, as "the cooldown
   * does not apply". The very next pass would then see a below-ceiling balance
   * with no cooldown and grant the freeze straight back, one call after it was
   * spent, defeating `FREEZE_REPLENISH_INTERVAL_DAYS` entirely. That next pass
   * is not hypothetical: React 18 StrictMode double-invokes the mount effect
   * behind `GET /api/engagement/summary`, so a dev build fires two of these
   * back to back on essentially every page load.
   *
   * A consume therefore STARTS the seven-day clock, which is also what a
   * learner would expect the rule to be: you get a freeze back seven days
   * after you spend one. A pass that changes nothing leaves the column alone,
   * so `null` keeps meaning "this balance has never moved; a grant is due".
   */
  stampGrantedAt: boolean;
}

/** `YYYY-MM-DD` → days since the Unix epoch. Pure; see `streak-engine.ts`'s own copy. */
function dayIndexOf(calendarDate: string): number {
  const [year, month, day] = calendarDate.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/** Days since the Unix epoch → `YYYY-MM-DD`. The inverse of {@link dayIndexOf}. */
function calendarDateOfIndex(dayIndex: number): string {
  return new Date(dayIndex * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Replenish, then settle — the two halves of §4.6's "settlement", in that
 * order and for a stated reason: a freeze granted this second is a freeze the
 * learner genuinely holds, so refusing to spend it on the gap being settled in
 * the same pass would report a balance of 1 beside a streak that broke for
 * want of exactly that freeze.
 *
 * **Replenishment** (§4.3): at most one per `FREEZE_REPLENISH_INTERVAL_DAYS`,
 * up to `STREAK_FREEZE_MAX`. A learner who never lets their balance drop below
 * the ceiling never replenishes past it.
 *
 * **Consumption** (§4.5): walk backward from YESTERDAY — settlement never
 * touches today, which is accrual's row to write on its own event-driven
 * schedule (§2) — for at most `FREEZE_SETTLE_LOOKBACK_DAYS` days:
 *
 *  - a day that already qualifies (`goalMet` or `freezeUsed`) needs nothing,
 *    and the walk continues further back;
 *  - a day whose row neither met the goal nor used a freeze is an already
 *    settled genuine miss — the streak ended there, honestly, and the walk
 *    stops;
 *  - a day with NO ROW AT ALL is a gap, bridged only if a freeze is held
 *    **and** some qualifying row exists anywhere before it. A gap before the
 *    learner's first-ever active day is not an interrupted streak, it is a
 *    learner who had not started yet, so nothing is spent on it.
 *
 * Running out of budget mid-walk stops the walk: the streak genuinely ended at
 * that day, and reaching further back would leave a hole behind the run this
 * settlement just protected.
 */
export function settleStreakFreezes(input: FreezeSettlementInput): FreezeSettlementPlan {
  const grantFreeze =
    input.streakFreezes < STREAK_FREEZE_MAX &&
    (input.daysSinceLastGrant === null ||
      input.daysSinceLastGrant >= FREEZE_REPLENISH_INTERVAL_DAYS);

  let budget = input.streakFreezes + (grantFreeze ? 1 : 0);

  const byDayIndex = new Map<number, StreakDay>();
  for (const day of input.days) {
    byDayIndex.set(dayIndexOf(day.date), day);
  }

  const qualifyingDayIndices = Array.from(byDayIndex.entries())
    .filter(([, day]) => day.goalMet || day.freezeUsed)
    .map(([index]) => index);
  const earliestQualifying =
    qualifyingDayIndices.length > 0 ? Math.min(...qualifyingDayIndices) : null;

  const yesterday = dayIndexOf(input.today) - 1;
  const freezeDays: string[] = [];

  for (let offset = 0; offset < FREEZE_SETTLE_LOOKBACK_DAYS; offset += 1) {
    const dayIndex = yesterday - offset;
    const row = byDayIndex.get(dayIndex);

    if (row) {
      if (row.goalMet || row.freezeUsed) {
        continue;
      }
      break;
    }

    // A gap. Only a streak that already exists on the far side of it is worth
    // protecting, and only while the budget lasts.
    if (budget <= 0 || earliestQualifying === null || earliestQualifying >= dayIndex) {
      break;
    }

    freezeDays.push(calendarDateOfIndex(dayIndex));
    budget -= 1;
  }

  return {
    grantFreeze,
    // Oldest first, so the rows are written in the order the days happened.
    freezeDays: freezeDays.reverse(),
    streakFreezesAfter: budget,
    // The DECISION about when the replenishment clock restarts lives here,
    // with the rest of the freeze rule, and not in the service that writes it
    // — see {@link FreezeSettlementPlan.stampGrantedAt} for why "granting or
    // spending" and not "granting" alone.
    stampGrantedAt: grantFreeze || freezeDays.length > 0,
  };
}

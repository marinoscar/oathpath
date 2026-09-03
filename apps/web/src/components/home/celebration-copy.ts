/**
 * The session-end celebration's copy — chosen from what actually happened.
 *
 * Issue #138, epic #56 / E7 "Habit". `docs/specs/habit-streaks.md` §8.
 *
 * =============================================================================
 * PURE, AND IN ITS OWN FILE, ON PURPOSE
 * =============================================================================
 *
 * No React, no MUI, no fetch — the same shape `nextSchedule`
 * (`memory-model.md` §3) and `computeStreak` (§4.2) already establish on the
 * API side for a rule that must produce the same output for the same input
 * forever and must be unit-tested directly against a table of cases. The
 * component renders what this returns; it selects nothing of its own.
 *
 * =============================================================================
 * SPECIFIC AND EARNED — NEVER A GENERIC EXCLAMATION
 * =============================================================================
 *
 * §8 fixes the standard with two worked examples and one prohibition:
 *
 *   * "That is five minutes today — your goal." — derived from
 *     `practiceSeconds` against `dailyGoalMinutes * 60`, the exact transition
 *     `goalMet` records (§2.3).
 *   * "You practised on three different days this week." — derived from the
 *     `recentDays` window the same endpoint sends.
 *   * NEVER "Amazing! You're doing great!" — "any celebration copy that would
 *     read identically regardless of what actually happened... is not a
 *     celebration, it is decoration."
 *
 * The practical test every branch below is written to pass: could this
 * sentence have been shown to a learner for whom something DIFFERENT
 * happened? If yes, it is decoration and it does not belong here. That is why
 * `null` is a first-class result — a session with nothing measurable behind it
 * gets no celebration at all, rather than a sentence that would have fitted
 * anybody.
 *
 * =============================================================================
 * CONSISTENCY, NEVER READINESS
 * =============================================================================
 *
 * Nothing here names a score, a percentage, or preparedness. §1 keeps
 * engagement structurally out of the readiness engine; §8 keeps readiness's
 * vocabulary off this surface. A "you're 40% ready!" assembled from a streak
 * would be the conflation `PRD.md` forbids, arriving as copy instead of as an
 * input.
 */

import { formatMinutes } from './minutes';

/**
 * Everything the selection reads, flattened out of `EngagementSummary` and
 * the finished session by the caller — so the rule can be exercised against a
 * table without constructing either response.
 */
export interface CelebrationInput {
  /** `dailyGoalMinutes` — the learner's own goal. */
  goalMinutes: number;
  /** `today.practiceSeconds`, as the server measured it. */
  practiceSecondsToday: number;
  /** `today.goalMet` — the server's monotonic flag, never recomputed. */
  goalMetToday: boolean;
  /** `streak.current` — consecutive qualifying local days. */
  streakCurrent: number;
  /** Distinct days with measured practice in the last 7 of `recentDays` (see `countDaysPractisedThisWeek`). */
  daysPractisedThisWeek: number;
  /** `summary.answered` on the session that just ended. */
  sessionAnswered: number;
}

export type CelebrationKind = 'goal' | 'week' | 'minutes';

export interface CelebrationCopy {
  /** Which fact was named — the handle a test (or a later analytics need) can assert on. */
  kind: CelebrationKind;
  headline: string;
  /** A second, also-earned sentence, or `null` when there is no second fact. */
  detail: string | null;
}

/** How many of the last 7 recorded days carry measured practice. */
export function countDaysPractisedThisWeek(
  recentDays: ReadonlyArray<{ practiceSeconds: number }>,
): number {
  // `recentDays` is oldest first, so "this week" is the tail.
  return recentDays.slice(-7).filter((day) => day.practiceSeconds > 0).length;
}

/**
 * The ladder, top to bottom. Exactly one branch fires, and every branch names
 * a fact the caller could point at in the response that produced it.
 *
 * 1. **The goal was met today** — the strongest, most specific thing that can
 *    be true of a session, and the transition §8's first example is derived
 *    from. A streak of two or more days is added as the detail, because that
 *    is a second real fact, not a restatement of the first.
 * 2. **The goal was not met, but this is not an isolated day** — the week's
 *    real count of practice days, §8's second example. It is worth saying
 *    precisely because the goal was missed: consistency is the thing this
 *    surface measures, and a learner who has shown up four days running has
 *    done something a single day's shortfall does not undo.
 * 3. **Some time was measured today** — the smallest honest fact left. It
 *    names the minutes and the goal without characterising the gap between
 *    them.
 *
 * `null` when the session answered nothing, or when no time was measured on
 * the day at all: there is then no earned sentence to say, and §8's rule is
 * that no sentence beats a generic one.
 */
export function selectCelebrationCopy(input: CelebrationInput): CelebrationCopy | null {
  const {
    goalMinutes,
    practiceSecondsToday,
    goalMetToday,
    streakCurrent,
    daysPractisedThisWeek,
    sessionAnswered,
  } = input;

  if (sessionAnswered <= 0) return null;

  if (goalMetToday) {
    return {
      kind: 'goal',
      headline: `That is ${formatMinutes(practiceSecondsToday)} today — your goal.`,
      detail:
        streakCurrent >= 2
          ? `That makes ${streakCurrent} days in a row.`
          : null,
    };
  }

  if (daysPractisedThisWeek >= 2) {
    return {
      kind: 'week',
      headline: `You practised on ${daysPractisedThisWeek} different days this week.`,
      detail:
        practiceSecondsToday > 0
          ? `That is ${formatMinutes(practiceSecondsToday)} today.`
          : null,
    };
  }

  if (practiceSecondsToday > 0) {
    return {
      kind: 'minutes',
      headline: `That is ${formatMinutes(practiceSecondsToday)} today.`,
      detail: `Your daily goal is ${goalMinutes} ${
        goalMinutes === 1 ? 'minute' : 'minutes'
      }.`,
    };
  }

  return null;
}

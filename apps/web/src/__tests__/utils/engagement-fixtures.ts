/**
 * Engagement summary fixtures (issue #138, epic #56 / E7 "Habit").
 *
 * Shaped from `apps/api/src/engagement/dto/engagement-summary.dto.ts` rather
 * than invented, so a suite that passes here is exercising the wire shape the
 * server actually sends — including the two facts that shape every consumer:
 * `today` is ALWAYS present (honest zeros for a day nothing has happened on),
 * and `recentDays` is exactly 14 entries, OLDEST FIRST.
 */

import type { EngagementRecentDay, EngagementSummary } from '../../types';

/** `YYYY-MM-DD`, `offset` days before `2026-04-10`. */
function dayBefore(offset: number): string {
  const base = Date.UTC(2026, 3, 10);
  return new Date(base - offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 14 local days, oldest first, ending today. `practisedDayOffsets` counts
 * BACK from today (`0` is today), so a test can say "practised today and the
 * two days before" without hand-writing dates.
 */
export function recentDays(
  practisedDayOffsets: number[] = [],
  options: { freezeDayOffsets?: number[]; secondsPerDay?: number } = {},
): EngagementRecentDay[] {
  const { freezeDayOffsets = [], secondsPerDay = 300 } = options;

  return Array.from({ length: 14 }, (_, index) => {
    const offset = 13 - index;
    const practised = practisedDayOffsets.includes(offset);
    const frozen = freezeDayOffsets.includes(offset);
    return {
      date: dayBefore(offset),
      goalMet: practised,
      freezeUsed: frozen,
      practiceSeconds: practised ? secondsPerDay : 0,
    };
  });
}

/**
 * A learner mid-habit: goal met today, a 4-day streak, both freezes in hand.
 * The default for any suite that does not care about the specific numbers.
 */
export function engagementSummary(
  overrides: Partial<EngagementSummary> = {},
): EngagementSummary {
  return {
    dailyGoalMinutes: 5,
    today: {
      date: dayBefore(0),
      practiceSeconds: 300,
      attempts: 5,
      correct: 4,
      goalMet: true,
    },
    streak: { current: 4, longest: 9 },
    freezes: { remaining: 2, max: 2 },
    timezone: 'America/Los_Angeles',
    recentDays: recentDays([0, 1, 2, 3]),
    ...overrides,
  };
}

/**
 * A learner who has done nothing at all — no row today, no streak, no
 * history. The zero state every surface must render as an INVITATION rather
 * than as a deficit (`docs/specs/habit-streaks.md` §4.5, §8).
 */
export function emptyEngagementSummary(
  overrides: Partial<EngagementSummary> = {},
): EngagementSummary {
  return engagementSummary({
    today: {
      date: dayBefore(0),
      practiceSeconds: 0,
      attempts: 0,
      correct: 0,
      goalMet: false,
    },
    streak: { current: 0, longest: 0 },
    freezes: { remaining: 2, max: 2 },
    recentDays: recentDays([]),
    ...overrides,
  });
}

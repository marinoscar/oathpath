/**
 * Seconds -> the phrase a learner reads. ONE definition, shared by the goal
 * ring and by the session-end celebration.
 *
 * Issue #138, epic #56 / E7 "Habit".
 *
 * Two surfaces describe the same `today.practiceSeconds` — the ring on Home
 * and the celebration at the end of a session — and they must never round it
 * differently. A learner who reads "5 minutes today — your goal" on the
 * summary and then sees a ring reporting 4 has been told two things about one
 * measurement, and has no way to know which is the real one.
 *
 * ROUNDING IS DOWN, NEVER NEAREST. 4 minutes 55 seconds is "4 minutes": the
 * product may not credit a learner with time they did not spend, and the
 * moment the goal is genuinely met is `goalMet` on the server's own row
 * (`docs/specs/habit-streaks.md` §2.3), not arithmetic performed here.
 */

/** Whole minutes elapsed, floored. Never negative. */
export function wholeMinutes(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.floor(seconds / 60);
}

/**
 * "less than a minute" / "1 minute" / "12 minutes".
 *
 * `0` seconds is "no minutes" — a real measurement of a day nothing has
 * happened on yet, which the surfaces around it frame as an invitation
 * rather than a deficit.
 */
export function formatMinutes(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'no minutes';
  const minutes = wholeMinutes(seconds);
  if (minutes < 1) return 'less than a minute';
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

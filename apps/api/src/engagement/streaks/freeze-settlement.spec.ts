import {
  FREEZE_REPLENISH_INTERVAL_DAYS,
  FREEZE_SETTLE_LOOKBACK_DAYS,
  STREAK_FREEZE_MAX,
  settleStreakFreezes,
  type FreezeSettlementInput,
} from './freeze-settlement';
import type { StreakDay } from './streak-engine';

// =============================================================================
// settleStreakFreezes — tests (issue #119, epic #56 / E7 "Habit")
// =============================================================================
//
// The DECISION half of settlement, tested as arithmetic with no database in
// the loop — which is exactly why it is a pure module (`habit-streaks.md` §4,
// following `nextSchedule`'s idiom). `engagement.service.spec.ts` covers the
// I/O half: that the plan below actually becomes rows and a profile update,
// and that a second pass writes nothing.
// =============================================================================

const met = (date: string): StreakDay => ({ date, goalMet: true, freezeUsed: false });
const frozen = (date: string): StreakDay => ({ date, goalMet: false, freezeUsed: true });
const missed = (date: string): StreakDay => ({ date, goalMet: false, freezeUsed: false });

function plan(overrides: Partial<FreezeSettlementInput> = {}) {
  return settleStreakFreezes({
    today: '2026-04-10',
    days: [],
    streakFreezes: STREAK_FREEZE_MAX,
    daysSinceLastGrant: 0,
    ...overrides,
  });
}

describe('settleStreakFreezes', () => {
  // ---------------------------------------------------------------------------
  // Replenishment (§4.3)
  // ---------------------------------------------------------------------------

  describe('replenishment', () => {
    it('grants one to a learner who has never replenished and is below the ceiling', () => {
      expect(plan({ streakFreezes: 0, daysSinceLastGrant: null })).toMatchObject({
        grantFreeze: true,
        streakFreezesAfter: 1,
      });
    });

    it('grants nothing before the interval has elapsed', () => {
      expect(
        plan({ streakFreezes: 0, daysSinceLastGrant: FREEZE_REPLENISH_INTERVAL_DAYS - 1 }),
      ).toMatchObject({ grantFreeze: false, streakFreezesAfter: 0 });
    });

    it('grants exactly one once the interval has elapsed — never a backlog of them', () => {
      expect(
        plan({ streakFreezes: 0, daysSinceLastGrant: FREEZE_REPLENISH_INTERVAL_DAYS * 6 }),
      ).toMatchObject({ grantFreeze: true, streakFreezesAfter: 1 });
    });

    it('grants nothing at the ceiling — it is a hard cap, not "2 plus whatever accrued"', () => {
      expect(
        plan({ streakFreezes: STREAK_FREEZE_MAX, daysSinceLastGrant: null }),
      ).toMatchObject({ grantFreeze: false, streakFreezesAfter: STREAK_FREEZE_MAX });
    });
  });

  // ---------------------------------------------------------------------------
  // Consumption (§4.5)
  // ---------------------------------------------------------------------------

  describe('consumption', () => {
    it('covers a single missed day inside a real streak', () => {
      const result = plan({
        today: '2026-04-10',
        days: [met('2026-04-06'), met('2026-04-07'), met('2026-04-08')],
        streakFreezes: 2,
      });

      // 2026-04-09 is the one gap; 2026-04-10 is today, which settlement never touches.
      expect(result.freezeDays).toEqual(['2026-04-09']);
      expect(result.streakFreezesAfter).toBe(1);
    });

    it('never touches today — that row is accrual’s, on its own event-driven schedule', () => {
      const result = plan({
        today: '2026-04-10',
        days: [met('2026-04-08'), met('2026-04-09')],
        streakFreezes: 2,
      });

      expect(result.freezeDays).toEqual([]);
      expect(result.streakFreezesAfter).toBe(2);
    });

    it('spends nothing on a gap before the learner’s first-ever active day', () => {
      const result = plan({
        today: '2026-04-10',
        days: [],
        streakFreezes: 2,
      });

      // Not an interrupted streak — a learner who had not started yet.
      expect(result.freezeDays).toEqual([]);
      expect(result.streakFreezesAfter).toBe(2);
    });

    it('stops at an already-settled genuine miss rather than reaching past it', () => {
      const result = plan({
        today: '2026-04-10',
        days: [met('2026-04-05'), missed('2026-04-08')],
        streakFreezes: 2,
      });

      // 2026-04-09 is a gap worth covering; 2026-04-08 is a recorded miss, so
      // the walk stops there and 2026-04-07 and earlier are never considered.
      expect(result.freezeDays).toEqual(['2026-04-09']);
    });

    it('passes straight over a day an earlier pass already froze', () => {
      const result = plan({
        today: '2026-04-10',
        days: [met('2026-04-06'), frozen('2026-04-07'), met('2026-04-08')],
        streakFreezes: 1,
      });

      expect(result.freezeDays).toEqual(['2026-04-09']);
      expect(result.streakFreezesAfter).toBe(0);
    });

    it('stops when the budget runs out rather than leaving a hole behind the run', () => {
      const result = plan({
        today: '2026-04-10',
        days: [met('2026-04-01')],
        streakFreezes: 2,
      });

      // Two freezes reach 2026-04-09 and 2026-04-08 and stop; 2026-04-07 stays uncovered.
      expect(result.freezeDays).toEqual(['2026-04-08', '2026-04-09']);
      expect(result.streakFreezesAfter).toBe(0);
    });

    it('refuses to reach past the look-back even with an unlimited budget', () => {
      const result = plan({
        today: '2026-04-10',
        days: [met('2026-03-01')],
        streakFreezes: 99,
        daysSinceLastGrant: 0,
      });

      expect(result.freezeDays).toHaveLength(FREEZE_SETTLE_LOOKBACK_DAYS);
      // Yesterday back to exactly seven days before today — never an eighth.
      expect(result.freezeDays[result.freezeDays.length - 1]).toBe('2026-04-09');
      expect(result.freezeDays[0]).toBe('2026-04-03');
      expect(result.freezeDays).not.toContain('2026-04-02');
    });

    it('returns days oldest first, so rows are written in the order they happened', () => {
      const result = plan({
        today: '2026-04-10',
        days: [met('2026-04-01')],
        streakFreezes: 2,
      });

      expect(result.freezeDays).toEqual([...result.freezeDays].sort());
    });
  });

  // ---------------------------------------------------------------------------
  // stampGrantedAt — when the replenishment clock restarts (§4.3)
  // ---------------------------------------------------------------------------

  describe('stampGrantedAt', () => {
    it('is false when the pass changes nothing — `null` must keep meaning "never moved"', () => {
      expect(
        plan({ days: [met('2026-04-08'), met('2026-04-09')], streakFreezes: STREAK_FREEZE_MAX }),
      ).toMatchObject({ grantFreeze: false, freezeDays: [], stampGrantedAt: false });
    });

    it('is true on a grant', () => {
      expect(plan({ streakFreezes: 0, daysSinceLastGrant: null })).toMatchObject({
        grantFreeze: true,
        stampGrantedAt: true,
      });
    });

    it('is true on a pass that only SPENDS — the cooldown starts when a freeze is used', () => {
      // The balance is already at the ceiling, so nothing is granted; one gap
      // is covered. Reporting `false` here is what let the next pass regrant
      // the freeze immediately, defeating the seven-day interval entirely.
      const result = plan({
        days: [met('2026-04-07'), met('2026-04-08')],
        streakFreezes: STREAK_FREEZE_MAX,
        daysSinceLastGrant: null,
      });

      expect(result.grantFreeze).toBe(false);
      expect(result.freezeDays).toEqual(['2026-04-09']);
      expect(result.stampGrantedAt).toBe(true);
    });

    it('is true when a pass both grants and spends', () => {
      expect(
        plan({
          days: [met('2026-04-07'), met('2026-04-08')],
          streakFreezes: 0,
          daysSinceLastGrant: null,
        }),
      ).toMatchObject({ grantFreeze: true, freezeDays: ['2026-04-09'], stampGrantedAt: true });
    });
  });

  // ---------------------------------------------------------------------------
  // The two halves together
  // ---------------------------------------------------------------------------

  it('a freeze granted this pass is available to the same pass', () => {
    const result = plan({
      today: '2026-04-10',
      days: [met('2026-04-06'), met('2026-04-07'), met('2026-04-08')],
      streakFreezes: 0,
      daysSinceLastGrant: null,
    });

    expect(result.grantFreeze).toBe(true);
    expect(result.freezeDays).toEqual(['2026-04-09']);
    expect(result.streakFreezesAfter).toBe(0);
  });

  it('never mutates its input', () => {
    const days = [met('2026-04-08'), met('2026-04-06')];
    const before = JSON.parse(JSON.stringify(days));

    plan({ days, streakFreezes: 2 });

    expect(days).toEqual(before);
  });
});

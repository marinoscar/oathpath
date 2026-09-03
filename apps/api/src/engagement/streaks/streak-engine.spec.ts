import { computeStreak, type StreakDay, type StreakEvidence } from './streak-engine';

// =============================================================================
// computeStreak — tests (issue #119, epic #56 / E7 "Habit")
// =============================================================================
//
// A TABLE OF CASES AGAINST THE PURE FUNCTION, with no database, no Nest and no
// clock in the loop — the same posture `readiness-engine.spec.ts` and
// `mastery/scheduler.spec.ts` take toward their own pure engines, and the
// reason `streak-engine.ts` imports nothing at all.
//
// Each case states a whole history and the day it is being asked about, so a
// reader can check the expected `current`/`longest` by counting days on the
// line above them rather than by trusting a fixture builder.
// =============================================================================

/** A day the learner met their goal on. */
const met = (date: string): StreakDay => ({ date, goalMet: true, freezeUsed: false });

/** A day settlement covered with a freeze — zeroed counters, `goalMet` false (§4.4). */
const frozen = (date: string): StreakDay => ({ date, goalMet: false, freezeUsed: true });

/** A real, recorded miss: the learner practised, but not enough to clear the goal. */
const missed = (date: string): StreakDay => ({ date, goalMet: false, freezeUsed: false });

describe('computeStreak', () => {
  describe('the case table', () => {
    const cases: Array<{
      name: string;
      evidence: StreakEvidence;
      expected: { current: number; longest: number };
    }> = [
      {
        name: 'an empty history is 0 and 0 — never a fabricated streak',
        evidence: { today: '2026-04-10', days: [] },
        expected: { current: 0, longest: 0 },
      },
      {
        name: 'a single qualifying day, today, is a streak of 1',
        evidence: { today: '2026-04-10', days: [met('2026-04-10')] },
        expected: { current: 1, longest: 1 },
      },
      {
        name: 'a single day long past counts toward longest but not toward current',
        evidence: { today: '2026-04-10', days: [met('2026-01-01')] },
        expected: { current: 0, longest: 1 },
      },
      {
        name: 'four consecutive days ending today',
        evidence: {
          today: '2026-04-10',
          days: [met('2026-04-07'), met('2026-04-08'), met('2026-04-09'), met('2026-04-10')],
        },
        expected: { current: 4, longest: 4 },
      },
      {
        name: 'a gap breaks the run: only the days after it count toward current',
        evidence: {
          today: '2026-04-10',
          days: [
            met('2026-04-01'),
            met('2026-04-02'),
            met('2026-04-03'),
            // 2026-04-04 has no row at all — a genuine, unprotected gap.
            met('2026-04-09'),
            met('2026-04-10'),
          ],
        },
        expected: { current: 2, longest: 3 },
      },
      {
        name: 'a recorded but goal-missing day breaks the run exactly as a missing row does',
        evidence: {
          today: '2026-04-10',
          days: [met('2026-04-08'), missed('2026-04-09'), met('2026-04-10')],
        },
        expected: { current: 1, longest: 1 },
      },
      {
        name: 'a freeze-covered gap keeps the run whole across it',
        evidence: {
          today: '2026-04-10',
          days: [
            met('2026-04-07'),
            met('2026-04-08'),
            frozen('2026-04-09'),
            met('2026-04-10'),
          ],
        },
        expected: { current: 4, longest: 4 },
      },
      {
        name: 'longest can be an old run the current one has not caught up to',
        evidence: {
          today: '2026-04-10',
          days: [
            met('2026-03-01'),
            met('2026-03-02'),
            met('2026-03-03'),
            met('2026-03-04'),
            met('2026-03-05'),
            met('2026-04-09'),
            met('2026-04-10'),
          ],
        },
        expected: { current: 2, longest: 5 },
      },
      {
        name: 'the anchor rule: yesterday qualifies, today has no row yet — the streak still stands',
        evidence: {
          today: '2026-04-10',
          days: [met('2026-04-07'), met('2026-04-08'), met('2026-04-09')],
        },
        expected: { current: 3, longest: 3 },
      },
      {
        name: 'the anchor rule ends after exactly one day: the day before yesterday is not an anchor',
        evidence: {
          today: '2026-04-10',
          days: [met('2026-04-06'), met('2026-04-07'), met('2026-04-08')],
        },
        expected: { current: 0, longest: 3 },
      },
      {
        name: 'a freeze row is a valid anchor on its own',
        evidence: {
          today: '2026-04-10',
          days: [met('2026-04-08'), frozen('2026-04-09')],
        },
        expected: { current: 2, longest: 2 },
      },
      {
        name: 'a run crossing a month boundary is still consecutive',
        evidence: {
          today: '2026-04-02',
          days: [met('2026-03-30'), met('2026-03-31'), met('2026-04-01'), met('2026-04-02')],
        },
        expected: { current: 4, longest: 4 },
      },
      {
        name: 'a run crossing a leap day is still consecutive',
        evidence: {
          today: '2028-03-01',
          days: [met('2028-02-28'), met('2028-02-29'), met('2028-03-01')],
        },
        expected: { current: 3, longest: 3 },
      },
    ];

    it.each(cases)('$name', ({ evidence, expected }) => {
      expect(computeStreak(evidence)).toEqual(expected);
    });
  });

  // ---------------------------------------------------------------------------
  // Properties the interface promises
  // ---------------------------------------------------------------------------

  it('accepts `days` in ANY order — the interface says so, and the caller sorts nothing', () => {
    const days = [met('2026-04-10'), met('2026-04-08'), frozen('2026-04-09'), met('2026-04-07')];
    const shuffled = [days[2], days[0], days[3], days[1]];

    expect(computeStreak({ today: '2026-04-10', days: shuffled })).toEqual({
      current: 4,
      longest: 4,
    });
  });

  it('never mutates the evidence it was handed', () => {
    const days = [met('2026-04-09'), met('2026-04-10'), met('2026-04-07')];
    const before = JSON.parse(JSON.stringify(days));

    computeStreak({ today: '2026-04-10', days });

    expect(days).toEqual(before);
  });

  it('is deterministic — the same evidence produces the same result, forever', () => {
    const evidence: StreakEvidence = {
      today: '2026-04-10',
      days: [met('2026-04-08'), frozen('2026-04-09'), met('2026-04-10')],
    };

    expect(computeStreak(evidence)).toEqual(computeStreak(evidence));
  });

  it('current never exceeds longest', () => {
    const evidence: StreakEvidence = {
      today: '2026-04-10',
      days: [met('2026-04-08'), met('2026-04-09'), met('2026-04-10')],
    };

    const { current, longest } = computeStreak(evidence);
    expect(current).toBeLessThanOrEqual(longest);
  });
});

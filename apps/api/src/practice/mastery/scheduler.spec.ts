import {
  initialMasteryRecord,
  nextSchedule,
  type AttemptOutcome,
  type MasteryRecord,
} from './scheduler';

// =============================================================================
// scheduler.ts — tests (issue #75, epic #54 / E5 "Memory")
// =============================================================================
//
// `nextSchedule` is pure — same inputs, same output, no I/O, `now` handed in
// as a plain `Date` — so every case here pins `now` to a fixed, explicit UTC
// `Date` rather than reading the real clock. The two facts the file header
// calls out as load-bearing (the self-marked discount, and the one-attempt
// same-UTC-day lookback for `distinctCorrectDays`) each get their own
// section below, plus the state machine transitions the header documents.
// =============================================================================

const DAY1 = new Date('2026-01-01T10:00:00.000Z');
const DAY1_LATER = new Date('2026-01-01T22:00:00.000Z'); // same UTC calendar day as DAY1
const DAY2 = new Date('2026-01-02T09:00:00.000Z');
const DAY3 = new Date('2026-01-03T09:00:00.000Z');

/** `initialMasteryRecord()` with overrides, for fixtures that need a specific starting state. */
function record(overrides: Partial<MasteryRecord> = {}): MasteryRecord {
  return { ...initialMasteryRecord(), ...overrides };
}

/** `addDays` as the module implements it — UTC calendar days, no DST to worry about. */
function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

describe('initialMasteryRecord', () => {
  it('returns the all-zero "new" defaults', () => {
    expect(initialMasteryRecord()).toEqual({
      state: 'new',
      dueAt: null,
      intervalDays: 0,
      ease: 2.5,
      correctStreak: 0,
      lapses: 0,
      totalAttempts: 0,
      distinctCorrectDays: 0,
      lastOutcome: null,
      lastAttemptAt: null,
    });
  });
});

describe('nextSchedule — a brand-new record answered correct', () => {
  it('moves to learning, streak/day counters go to 1, and dueAt is now + intervalDays', () => {
    const result = nextSchedule(initialMasteryRecord(), 'correct', DAY1);

    expect(result.state).toBe('learning');
    expect(result.correctStreak).toBe(1);
    expect(result.distinctCorrectDays).toBe(1);
    expect(result.intervalDays).toBe(1);
    expect(result.dueAt).toEqual(addUtcDays(DAY1, result.intervalDays));
    expect(result.ease).toBeCloseTo(2.6, 5);
    expect(result.totalAttempts).toBe(1);
    expect(result.lapses).toBe(0);
  });
});

describe('nextSchedule — promotion to mastered needs 3 DISTINCT calendar days, not before', () => {
  it('is not yet mastered after the 2nd distinct-day correct, and is mastered exactly after the 3rd', () => {
    const afterDay1 = nextSchedule(initialMasteryRecord(), 'correct', DAY1);
    expect(afterDay1.state).toBe('learning');
    expect(afterDay1.distinctCorrectDays).toBe(1);

    const afterDay2 = nextSchedule(afterDay1, 'correct', DAY2);
    expect(afterDay2.distinctCorrectDays).toBe(2);
    expect(afterDay2.state).not.toBe('mastered');
    expect(afterDay2.state).toBe('review');

    const afterDay3 = nextSchedule(afterDay2, 'correct', DAY3);
    expect(afterDay3.distinctCorrectDays).toBe(3);
    expect(afterDay3.state).toBe('mastered');
  });
});

describe('nextSchedule — the same-UTC-day lookback for distinctCorrectDays', () => {
  it('does not increment distinctCorrectDays for a second correct on the same calendar day, and cannot promote off same-day repeats alone', () => {
    const first = nextSchedule(initialMasteryRecord(), 'correct', DAY1);
    expect(first.distinctCorrectDays).toBe(1);

    const second = nextSchedule(first, 'correct', DAY1_LATER);
    expect(second.distinctCorrectDays).toBe(1); // unchanged — same UTC calendar day as `first`
    expect(second.state).not.toBe('mastered');

    // Hammer the point: a third same-day correct still cannot push the
    // counter or promote the record, no matter how many same-day repeats.
    const third = nextSchedule(second, 'correct', DAY1_LATER);
    expect(third.distinctCorrectDays).toBe(1);
    expect(third.state).not.toBe('mastered');
  });
});

describe('nextSchedule — incorrect from review/mastered is a real regression', () => {
  it.each<MasteryRecord['state']>(['review', 'mastered'])(
    'drops a %s record to lapsed, resets correctStreak, increments lapses by exactly 1, and lowers ease',
    (state) => {
      const starting = record({ state, ease: 2.5, correctStreak: 4, lapses: 0 });

      const result = nextSchedule(starting, 'incorrect', DAY1);

      expect(result.state).toBe('lapsed');
      expect(result.correctStreak).toBe(0);
      expect(result.lapses).toBe(1);
      expect(result.ease).toBeLessThan(starting.ease);
      expect(result.ease).toBeCloseTo(2.3, 5);
    },
  );

  it('never lowers ease below the documented MIN_EASE floor of 1.3', () => {
    const starting = record({ state: 'review', ease: 1.35 });

    const result = nextSchedule(starting, 'incorrect', DAY1);

    expect(result.ease).toBe(1.3);
  });
});

describe('nextSchedule — incorrect from new/learning is a miss, not a regression', () => {
  it.each<MasteryRecord['state']>(['new', 'learning'])(
    'moves a %s record to (or keeps it in) learning, and does NOT increment lapses',
    (state) => {
      const starting = record({ state, lapses: 2 });

      const result = nextSchedule(starting, 'incorrect', DAY1);

      expect(result.state).toBe('learning');
      expect(result.lapses).toBe(2); // unchanged — only review/mastered -> lapsed counts
      expect(result.correctStreak).toBe(0);
    },
  );

  it('an incorrect from lapsed also does not count as a lapse (it is already the regressed state)', () => {
    const starting = record({ state: 'lapsed', lapses: 3 });

    const result = nextSchedule(starting, 'incorrect', DAY1);

    expect(result.state).toBe('learning');
    expect(result.lapses).toBe(3);
  });
});

describe('nextSchedule — correct_self_marked applies half the ease bump and half the interval growth', () => {
  it('produces a strictly smaller ease and intervalDays than an equivalent plain correct from the same starting record', () => {
    const starting = record({
      state: 'review',
      ease: 2.7,
      intervalDays: 3,
      correctStreak: 2,
      distinctCorrectDays: 2,
      lastOutcome: null,
      lastAttemptAt: null,
    });

    const viaCorrect = nextSchedule(starting, 'correct', DAY3);
    const viaSelfMarked = nextSchedule(starting, 'correct_self_marked', DAY3);

    expect(viaSelfMarked.ease).toBeLessThan(viaCorrect.ease);
    expect(viaSelfMarked.intervalDays).toBeLessThan(viaCorrect.intervalDays);

    // Pin the exact numbers so a silent change to either constant is caught,
    // not just a directional regression.
    expect(viaCorrect.ease).toBeCloseTo(2.8, 5);
    expect(viaSelfMarked.ease).toBeCloseTo(2.75, 5);
    expect(viaCorrect.intervalDays).toBe(8); // round(3 * 2.7)
    expect(viaSelfMarked.intervalDays).toBe(4); // round(8 * 0.5)
  });
});

describe('nextSchedule — correct_self_marked still counts toward distinctCorrectDays on a new day', () => {
  it('increments distinctCorrectDays exactly like an objective correct would, on a new calendar day', () => {
    const starting = record({ state: 'learning', distinctCorrectDays: 1 });

    const result = nextSchedule(starting, 'correct_self_marked', DAY2);

    expect(result.distinctCorrectDays).toBe(2);
  });

  it('is still subject to the same-day lookback — a same-day self-marked correct does not double-count', () => {
    const first = nextSchedule(initialMasteryRecord(), 'correct_self_marked', DAY1);
    expect(first.distinctCorrectDays).toBe(1);

    const second = nextSchedule(first, 'correct_self_marked', DAY1_LATER);
    expect(second.distinctCorrectDays).toBe(1);
  });
});

describe('nextSchedule — totalAttempts', () => {
  it.each<AttemptOutcome>(['correct', 'incorrect', 'correct_self_marked'])(
    'increments by exactly 1 for a %s outcome',
    (outcome) => {
      const starting = record({ totalAttempts: 7 });

      const result = nextSchedule(starting, outcome, DAY1);

      expect(result.totalAttempts).toBe(8);
    },
  );
});

describe('nextSchedule — lastOutcome / lastAttemptAt', () => {
  it.each<AttemptOutcome>(['correct', 'incorrect', 'correct_self_marked'])(
    'are always set to the just-passed outcome and now, for a %s outcome',
    (outcome) => {
      const starting = record({
        lastOutcome: 'incorrect',
        lastAttemptAt: new Date('2020-01-01T00:00:00.000Z'),
      });

      const result = nextSchedule(starting, outcome, DAY2);

      expect(result.lastOutcome).toBe(outcome);
      expect(result.lastAttemptAt).toEqual(DAY2);
    },
  );
});

describe('nextSchedule — purity: the input record is never mutated', () => {
  it.each<AttemptOutcome>(['correct', 'incorrect', 'correct_self_marked'])(
    'leaves the original object deep-equal to a pre-call snapshot for a %s outcome, and returns a new object',
    (outcome) => {
      const starting = record({
        state: 'review',
        ease: 2.2,
        intervalDays: 5,
        correctStreak: 3,
        distinctCorrectDays: 2,
        lastOutcome: 'correct',
        lastAttemptAt: DAY1,
      });
      const snapshot = { ...starting };

      const result = nextSchedule(starting, outcome, DAY2);

      expect(starting).toEqual(snapshot);
      expect(result).not.toBe(starting);
    },
  );
});

describe('nextSchedule — lapsed -> learning rebuild path', () => {
  it('a lapsed record answered correct moves back to learning, one step below review', () => {
    const starting = record({ state: 'lapsed', correctStreak: 0, distinctCorrectDays: 0 });

    const result = nextSchedule(starting, 'correct', DAY1);

    expect(result.state).toBe('learning');
    expect(result.correctStreak).toBe(1);
  });
});

describe('nextSchedule — ease never exceeds the documented MAX_EASE ceiling of 3.0', () => {
  it('clamps a correct outcome that would otherwise push ease above the ceiling', () => {
    const starting = record({ state: 'review', ease: 2.99 });

    const result = nextSchedule(starting, 'correct', DAY1);

    expect(result.ease).toBe(3.0);
  });
});

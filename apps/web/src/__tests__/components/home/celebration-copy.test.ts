/**
 * `selectCelebrationCopy` — the session-end celebration's rule (issue #138,
 * epic #56 / E7 "Habit", `docs/specs/habit-streaks.md` §8).
 *
 * A TABLE, not a walk through the component. The function is pure exactly so
 * that its rule can be exercised directly, the same way the API side tests
 * `nextSchedule` and `computeStreak`: a case here is six numbers in and one
 * object out, with no render, no fetch and no MUI in the loop.
 *
 * WHAT THIS PROTECTS, and why each would be cheap to break:
 *
 *  1. **Every sentence names something that actually happened.** §8's
 *     standard is that copy which "would read identically regardless of what
 *     actually happened" is decoration, not celebration. The strongest
 *     assertion for that is not per-case wording — it is the last test in this
 *     file, which runs every case in the table and requires that no two
 *     different situations produce the same headline.
 *  2. **`null` is a real result.** A session that answered nothing, and a day
 *     with no measured time, get NO celebration. A component that always has
 *     something to show is one generic sentence away from decoration.
 *  3. **The goal branch wins over the week branch.** Meeting the goal is the
 *     most specific true thing about the day; a learner who met it must never
 *     be told only about last week instead.
 *  4. **Nothing readiness-shaped appears** — §8's vocabulary boundary, and
 *     `PRD.md`'s requirement that engagement and readiness stay distinct.
 */

import { describe, it, expect } from 'vitest';

import {
  countDaysPractisedThisWeek,
  selectCelebrationCopy,
  type CelebrationCopy,
  type CelebrationInput,
} from '../../../components/home/celebration-copy';

/** A learner who answered five questions; every field overridable per case. */
function input(overrides: Partial<CelebrationInput> = {}): CelebrationInput {
  return {
    goalMinutes: 5,
    practiceSecondsToday: 300,
    goalMetToday: true,
    streakCurrent: 1,
    daysPractisedThisWeek: 1,
    sessionAnswered: 5,
    ...overrides,
  };
}

interface Case {
  name: string;
  input: CelebrationInput;
  expected: CelebrationCopy | null;
}

const CASES: Case[] = [
  {
    name: 'goal met — §8’s own worked example, with the measured minutes in it',
    input: input({ practiceSecondsToday: 300, goalMetToday: true, streakCurrent: 1 }),
    expected: {
      kind: 'goal',
      headline: 'That is 5 minutes today — your goal.',
      detail: null,
    },
  },
  {
    name: 'goal met on a streak of two or more — the streak is the second earned fact',
    input: input({ practiceSecondsToday: 420, goalMetToday: true, streakCurrent: 4 }),
    expected: {
      kind: 'goal',
      headline: 'That is 7 minutes today — your goal.',
      detail: 'That makes 4 days in a row.',
    },
  },
  {
    name: 'goal met with a one-day streak — no streak sentence invented',
    input: input({ practiceSecondsToday: 600, goalMetToday: true, streakCurrent: 1 }),
    expected: {
      kind: 'goal',
      headline: 'That is 10 minutes today — your goal.',
      detail: null,
    },
  },
  {
    name: 'goal met beats a strong week — the most specific true thing wins',
    input: input({ goalMetToday: true, daysPractisedThisWeek: 6, streakCurrent: 1 }),
    expected: {
      kind: 'goal',
      headline: 'That is 5 minutes today — your goal.',
      detail: null,
    },
  },
  {
    name: 'goal missed but the week is real — §8’s second worked example',
    input: input({
      goalMetToday: false,
      practiceSecondsToday: 120,
      daysPractisedThisWeek: 3,
    }),
    expected: {
      kind: 'week',
      headline: 'You practised on 3 different days this week.',
      detail: 'That is 2 minutes today.',
    },
  },
  {
    name: 'goal missed, two days this week — the floor of the week branch',
    input: input({
      goalMetToday: false,
      practiceSecondsToday: 45,
      daysPractisedThisWeek: 2,
    }),
    expected: {
      kind: 'week',
      headline: 'You practised on 2 different days this week.',
      // Under a minute is said as under a minute, never rounded up to one.
      detail: 'That is less than a minute today.',
    },
  },
  {
    name: 'goal missed on a first, isolated day — the minutes, and the goal, plainly',
    input: input({
      goalMetToday: false,
      practiceSecondsToday: 180,
      daysPractisedThisWeek: 1,
    }),
    expected: {
      kind: 'minutes',
      headline: 'That is 3 minutes today.',
      detail: 'Your daily goal is 5 minutes.',
    },
  },
  {
    name: 'one minute exactly — singular, not "1 minutes"',
    input: input({
      goalMetToday: false,
      practiceSecondsToday: 60,
      daysPractisedThisWeek: 1,
      goalMinutes: 1,
    }),
    expected: {
      kind: 'minutes',
      headline: 'That is 1 minute today.',
      detail: 'Your daily goal is 1 minute.',
    },
  },
  {
    name: 'a session that answered nothing — no celebration at all',
    input: input({ sessionAnswered: 0 }),
    expected: null,
  },
  {
    name: 'no measured time on the day and no week behind it — no celebration at all',
    input: input({
      goalMetToday: false,
      practiceSecondsToday: 0,
      daysPractisedThisWeek: 0,
    }),
    expected: null,
  },
];

describe('selectCelebrationCopy', () => {
  it.each(CASES)('$name', ({ input: given, expected }) => {
    expect(selectCelebrationCopy(given)).toEqual(expected);
  });

  it('never produces the same headline for two different situations', () => {
    // The generic-exclamation test, stated structurally rather than by
    // grepping for "Amazing!": a headline that could stand in for a different
    // set of facts is decoration, and the way that shows up is two unequal
    // inputs sharing one sentence.
    const headlines = CASES.map((testCase) => selectCelebrationCopy(testCase.input))
      .filter((copy): copy is CelebrationCopy => copy !== null)
      .map((copy) => `${copy.headline} ${copy.detail ?? ''}`);

    const distinctInputs = new Set(CASES.map((c) => JSON.stringify(c.input)));
    // Sanity: the table really does describe distinct situations.
    expect(distinctInputs.size).toBe(CASES.length);

    const collisions = headlines.filter(
      (headline, index) => headlines.indexOf(headline) !== index,
    );
    // The two "goal met, one-day streak" cases differ only in a field the
    // goal branch does not read (`daysPractisedThisWeek`), so they are
    // ALLOWED to agree — everything else must not.
    expect(new Set(collisions)).toEqual(
      new Set(['That is 5 minutes today — your goal. ']),
    );
  });

  it('names nothing readiness-shaped, in any branch — PRD.md’s two questions stay apart', () => {
    for (const testCase of CASES) {
      const copy = selectCelebrationCopy(testCase.input);
      if (!copy) continue;
      const text = `${copy.headline} ${copy.detail ?? ''}`;
      expect(text, testCase.name).not.toMatch(/\bready\b|\breadiness\b|\bprepared\b|\bscore\b/i);
    }
  });
});

describe('countDaysPractisedThisWeek', () => {
  it('counts only the last seven recorded days, and only days with measured time', () => {
    const days = [
      // Older than a week — real practice, deliberately out of the window.
      { practiceSeconds: 600 },
      { practiceSeconds: 600 },
      { practiceSeconds: 600 },
      { practiceSeconds: 600 },
      { practiceSeconds: 600 },
      { practiceSeconds: 600 },
      { practiceSeconds: 600 },
      // The last seven: three with practice, four without.
      { practiceSeconds: 0 },
      { practiceSeconds: 120 },
      { practiceSeconds: 0 },
      { practiceSeconds: 300 },
      { practiceSeconds: 0 },
      { practiceSeconds: 0 },
      { practiceSeconds: 60 },
    ];

    expect(countDaysPractisedThisWeek(days)).toBe(3);
  });

  it('counts a freeze day as what it is — a day with no practice on it', () => {
    // A settled freeze row carries `practiceSeconds: 0` by construction
    // (`docs/specs/habit-streaks.md` §4.4): it protects the streak, and it is
    // not a day the learner practised. The celebration must not claim it was.
    expect(countDaysPractisedThisWeek([{ practiceSeconds: 0 }, { practiceSeconds: 300 }])).toBe(1);
  });

  it('is zero for a learner with no history at all', () => {
    expect(countDaysPractisedThisWeek([])).toBe(0);
  });
});

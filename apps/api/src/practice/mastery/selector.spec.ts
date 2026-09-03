import {
  classifyMasteryBucket,
  selectQuestionsV2,
  WEAK_LAPSES_THRESHOLD,
  type MasterySelectableQuestion,
  type MasteryBucket,
  type QuestionMasterySnapshot,
} from './selector';
import type { MasteryState } from './scheduler';

// =============================================================================
// selector.ts — tests (issue #78, epic #54 / E5 "Memory")
// =============================================================================
//
// Table-driven over `classifyMasteryBucket`, the single classification rule
// this file's header calls out as shared between the selector and
// `PracticeService.getQueue` — every one of the FIVE buckets, including the
// two precedence boundaries the header itself documents: DUE beats WEAK for
// an overdue `lapsed` row, and a `dueAt` exactly equal to `now` still counts
// as due (`<=`, not `<`). `selectQuestionsV2` is then exercised end to end
// with the identity shuffle, so ordering assertions are exact rather than
// "eventually contains".
// =============================================================================

const NOW = new Date('2026-06-15T12:00:00.000Z');

/** `now` minus/plus some hours, for readable dueAt fixtures. */
function hoursFromNow(hours: number): Date {
  return new Date(NOW.getTime() + hours * 60 * 60 * 1000);
}

/** A full, valid snapshot with sensible defaults, overridable per test. */
function snapshot(overrides: Partial<QuestionMasterySnapshot> = {}): QuestionMasterySnapshot {
  return {
    state: 'learning',
    dueAt: null,
    lapses: 0,
    correctStreak: 1,
    lastAttemptAt: null,
    ...overrides,
  };
}

const identityShuffle = <T>(items: readonly T[]): T[] => [...items];

function question(id: string, categoryId = 'cat-default'): MasterySelectableQuestion {
  return { id, dynamicScope: 'none', categoryId };
}

// -----------------------------------------------------------------------------
// classifyMasteryBucket
// -----------------------------------------------------------------------------

describe('classifyMasteryBucket', () => {
  describe('NEW', () => {
    it('classifies a question with no mastery row at all as new (never attempted)', () => {
      expect(classifyMasteryBucket(undefined, NOW)).toBe('new');
    });

    it('classifies an explicit state: "new" row as new', () => {
      expect(classifyMasteryBucket(snapshot({ state: 'new' }), NOW)).toBe('new');
    });
  });

  describe('DUE', () => {
    it.each<MasteryState>(['review', 'lapsed'])(
      'classifies a %s row with dueAt in the past as due',
      (state) => {
        const result = classifyMasteryBucket(
          snapshot({ state, dueAt: hoursFromNow(-1) }),
          NOW,
        );
        expect(result).toBe('due');
      },
    );

    it('treats dueAt exactly equal to now as due (the <=, not <, boundary)', () => {
      const result = classifyMasteryBucket(snapshot({ state: 'review', dueAt: NOW }), NOW);
      expect(result).toBe('due');
    });

    it('does not classify learning or mastered as due, however old dueAt is', () => {
      expect(
        classifyMasteryBucket(snapshot({ state: 'learning', dueAt: hoursFromNow(-100) }), NOW),
      ).not.toBe('due');
      expect(
        classifyMasteryBucket(snapshot({ state: 'mastered', dueAt: hoursFromNow(-100) }), NOW),
      ).toBe('mastered');
    });

    it('a review row with dueAt in the future is not due', () => {
      const result = classifyMasteryBucket(
        snapshot({ state: 'review', dueAt: hoursFromNow(1) }),
        NOW,
      );
      expect(result).not.toBe('due');
    });
  });

  describe('WEAK', () => {
    it('DUE takes precedence over WEAK for an overdue lapsed row — a lapsed row is due-or-weak, never both', () => {
      const overdueLapsed = classifyMasteryBucket(
        snapshot({ state: 'lapsed', dueAt: hoursFromNow(-1) }),
        NOW,
      );
      expect(overdueLapsed).toBe('due');
    });

    it('a lapsed row not yet due (dueAt in the future) is weak, not due — a fresh lapse must not wait out its own interval', () => {
      const result = classifyMasteryBucket(
        snapshot({ state: 'lapsed', dueAt: hoursFromNow(24) }),
        NOW,
      );
      expect(result).toBe('weak');
    });

    it('a lapsed row with dueAt null is weak', () => {
      const result = classifyMasteryBucket(snapshot({ state: 'lapsed', dueAt: null }), NOW);
      expect(result).toBe('weak');
    });

    it.each<MasteryState>(['learning', 'review'])(
      'a %s row with lapses at the WEAK_LAPSES_THRESHOLD is weak',
      (state) => {
        const result = classifyMasteryBucket(
          snapshot({ state, dueAt: hoursFromNow(24), lapses: WEAK_LAPSES_THRESHOLD, correctStreak: 3 }),
          NOW,
        );
        expect(result).toBe('weak');
      },
    );

    it('a learning/review row one lapse BELOW the threshold, with a healthy streak, is not weak', () => {
      const result = classifyMasteryBucket(
        snapshot({
          state: 'learning',
          dueAt: null,
          lapses: WEAK_LAPSES_THRESHOLD - 1,
          correctStreak: 3,
        }),
        NOW,
      );
      expect(result).not.toBe('weak');
    });

    it.each<MasteryState>(['learning', 'review'])(
      'a %s row with correctStreak exactly 0 is weak regardless of lapses',
      (state) => {
        const result = classifyMasteryBucket(
          snapshot({ state, dueAt: hoursFromNow(24), lapses: 0, correctStreak: 0 }),
          NOW,
        );
        expect(result).toBe('weak');
      },
    );

    it('a review row not yet due, with a broken streak, is weak rather than steady', () => {
      const result = classifyMasteryBucket(
        snapshot({ state: 'review', dueAt: hoursFromNow(48), correctStreak: 0, lapses: 0 }),
        NOW,
      );
      expect(result).toBe('weak');
    });
  });

  describe('STEADY', () => {
    it('an ordinary in-progress learning row (streak > 0, lapses below threshold) is steady', () => {
      const result = classifyMasteryBucket(
        snapshot({ state: 'learning', lapses: 0, correctStreak: 2, dueAt: null }),
        NOW,
      );
      expect(result).toBe('steady');
    });

    it('a review row not yet due, with a healthy streak and no lapses, is steady', () => {
      const result = classifyMasteryBucket(
        snapshot({ state: 'review', dueAt: hoursFromNow(72), correctStreak: 4, lapses: 0 }),
        NOW,
      );
      expect(result).toBe('steady');
    });
  });

  describe('MASTERED', () => {
    it('classifies state: "mastered" as mastered', () => {
      expect(classifyMasteryBucket(snapshot({ state: 'mastered' }), NOW)).toBe('mastered');
    });

    it('mastered outranks nothing else — there is no lapses/streak condition that pulls a mastered row into weak', () => {
      const result = classifyMasteryBucket(
        snapshot({ state: 'mastered', lapses: 99, correctStreak: 0 }),
        NOW,
      );
      expect(result).toBe('mastered');
    });
  });

  describe('exhaustiveness', () => {
    const buckets: MasteryBucket[] = ['due', 'weak', 'new', 'steady', 'mastered'];

    it('every mastery state produces some bucket for some snapshot (sanity over the whole enum)', () => {
      const seen = new Set<MasteryBucket>();
      seen.add(classifyMasteryBucket(undefined, NOW));
      seen.add(classifyMasteryBucket(snapshot({ state: 'new' }), NOW));
      seen.add(classifyMasteryBucket(snapshot({ state: 'review', dueAt: hoursFromNow(-1) }), NOW));
      seen.add(
        classifyMasteryBucket(
          snapshot({ state: 'lapsed', dueAt: hoursFromNow(24) }),
          NOW,
        ),
      );
      seen.add(
        classifyMasteryBucket(
          snapshot({ state: 'learning', correctStreak: 3, lapses: 0, dueAt: null }),
          NOW,
        ),
      );
      seen.add(classifyMasteryBucket(snapshot({ state: 'mastered' }), NOW));

      for (const bucket of buckets) {
        expect(seen.has(bucket)).toBe(true);
      }
    });
  });
});

// -----------------------------------------------------------------------------
// selectQuestionsV2 — overall ordering
// -----------------------------------------------------------------------------

describe('selectQuestionsV2', () => {
  it('orders due-first (dueAt ascending) -> weak (lapses desc, then lastAttemptAt asc) -> new (category coverage) -> steady -> mastered (lastAttemptAt asc), using the identity shuffle for determinism', () => {
    // DUE — two candidates, out of dueAt order on purpose so the sort is proven.
    const dueLater = question('due-later');
    const dueSooner = question('due-sooner');

    // WEAK — same lapses, different lastAttemptAt (oldest-touched first), plus
    // a higher-lapses row that must sort ahead of both regardless of recency.
    const weakMoreLapses = question('weak-more-lapses');
    const weakOlder = question('weak-fewer-lapses-older');
    const weakNewer = question('weak-fewer-lapses-newer');

    // NEW — two categories; "y" has one MASTERED candidate in the pool, "x"
    // has none, so x's fewer-mastered category goes first in the round-robin.
    const newX1 = question('new-x-1', 'cat-x');
    const newX2 = question('new-x-2', 'cat-x');
    const newY1 = question('new-y-1', 'cat-y');

    // STEADY — one ordinary in-progress question.
    const steady = question('steady-1');

    // MASTERED — one in category y (feeds the coverage count above), ordered
    // by lastAttemptAt ascending against a second mastered row.
    const masteredOlder = question('mastered-older', 'cat-y');
    const masteredNewer = question('mastered-newer', 'cat-y');

    const masteryByQuestionId = new Map<string, QuestionMasterySnapshot>([
      [dueLater.id, snapshot({ state: 'review', dueAt: hoursFromNow(-1) })],
      [dueSooner.id, snapshot({ state: 'review', dueAt: hoursFromNow(-5) })],

      [
        weakMoreLapses.id,
        snapshot({ state: 'lapsed', dueAt: hoursFromNow(24), lapses: 5, lastAttemptAt: hoursFromNow(-1) }),
      ],
      [
        weakOlder.id,
        snapshot({ state: 'lapsed', dueAt: hoursFromNow(24), lapses: 2, lastAttemptAt: hoursFromNow(-48) }),
      ],
      [
        weakNewer.id,
        snapshot({ state: 'lapsed', dueAt: hoursFromNow(24), lapses: 2, lastAttemptAt: hoursFromNow(-2) }),
      ],

      [steady.id, snapshot({ state: 'learning', correctStreak: 2, lapses: 0, dueAt: null })],

      [masteredOlder.id, snapshot({ state: 'mastered', lastAttemptAt: hoursFromNow(-100) })],
      [masteredNewer.id, snapshot({ state: 'mastered', lastAttemptAt: hoursFromNow(-1) })],
      // newY1 has no mastery row (new); the second mastered row above is what
      // makes cat-y's mastered count 2 against cat-x's 0.
    ]);

    const questions = [
      newX1,
      dueLater,
      masteredNewer,
      weakOlder,
      newY1,
      steady,
      dueSooner,
      masteredOlder,
      weakNewer,
      newX2,
      weakMoreLapses,
    ];

    const result = selectQuestionsV2(questions, {
      learnerStateCode: null,
      masteryByQuestionId,
      now: NOW,
      shuffle: identityShuffle,
    });

    expect(result.map((q) => q.id)).toEqual([
      // DUE, dueAt ascending (most overdue first)
      dueSooner.id,
      dueLater.id,
      // WEAK, lapses desc then lastAttemptAt asc
      weakMoreLapses.id,
      weakOlder.id,
      weakNewer.id,
      // NEW, round-robin by category coverage: cat-x (0 mastered) before
      // cat-y (2 mastered), one per category per pass
      newX1.id,
      newY1.id,
      newX2.id,
      // STEADY
      steady.id,
      // MASTERED, lastAttemptAt ascending
      masteredOlder.id,
      masteredNewer.id,
    ]);
  });

  it('a question with no mastery row at all lands in the new bucket of the final ordering', () => {
    const seen = question('seen');
    const neverAttempted = question('never-attempted');

    const result = selectQuestionsV2([seen, neverAttempted], {
      learnerStateCode: null,
      masteryByQuestionId: new Map([[seen.id, snapshot({ state: 'mastered' })]]),
      now: NOW,
      shuffle: identityShuffle,
    });

    // new (never-attempted) outranks mastered (seen).
    expect(result.map((q) => q.id)).toEqual([neverAttempted.id, seen.id]);
  });

  it('still excludes state-scope questions for a learner with no state, exactly like v1', () => {
    const stateScoped: MasterySelectableQuestion = {
      id: 'state-scoped',
      dynamicScope: 'state',
      categoryId: 'cat-default',
    };
    const answerable = question('answerable');

    const result = selectQuestionsV2([stateScoped, answerable], {
      learnerStateCode: null,
      masteryByQuestionId: new Map(),
      now: NOW,
      shuffle: identityShuffle,
    });

    expect(result.map((q) => q.id)).toEqual([answerable.id]);
  });

  it('excludes ids in excludeQuestionIds before bucketing', () => {
    const excluded = question('excluded');
    const kept = question('kept');

    const result = selectQuestionsV2([excluded, kept], {
      learnerStateCode: null,
      masteryByQuestionId: new Map(),
      now: NOW,
      excludeQuestionIds: new Set([excluded.id]),
      shuffle: identityShuffle,
    });

    expect(result.map((q) => q.id)).toEqual([kept.id]);
  });
});

describe('WEAK_LAPSES_THRESHOLD', () => {
  it('is pinned at 2 — a single lapse is an ordinary state-machine event, not a struggling signal', () => {
    expect(WEAK_LAPSES_THRESHOLD).toBe(2);
  });
});

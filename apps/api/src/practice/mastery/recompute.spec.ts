import { recomputeMasteryForQuestion } from './recompute';
import { toStoredMasteryOutcome } from './outcome-mapping';
import {
  initialMasteryRecord,
  nextSchedule,
  type AttemptOutcome,
  type MasteryRecord,
} from './scheduler';

// =============================================================================
// recompute.ts — tests (issue #285, epic #280)
// =============================================================================
//
// The claim this file exists to prove is a NEGATIVE one, and it is the epic's:
// after a retry, the learner's `question_mastery` row must be exactly what it
// would have been if the superseded attempt had never been recorded. Every
// assertion below is therefore written against an INDEPENDENTLY COMPUTED
// expectation — a fold of `nextSchedule` (pure, and covered in its own
// `scheduler.spec.ts`) over the attempts that should have survived — rather
// than against numbers copied out of a passing run. A recompute that skipped
// the wrong attempt, replayed with the wrong `now`, or mapped the wrong
// outcome would still produce SOME plausible row; only comparing it against
// the history it claims to represent catches that.
//
// Prisma is a small hand-built stub, as in `practice.service.spec.ts`: this
// function touches three models and nothing here is about Prisma's own
// behaviour. No test in this repository touches a database (docs/TESTING.md).
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const QUESTION = '22222222-2222-4222-8222-222222222222';

const DAY1 = new Date('2026-01-01T10:00:00.000Z');
const DAY2 = new Date('2026-01-02T10:00:00.000Z');
const DAY3 = new Date('2026-01-03T10:00:00.000Z');
const DAY3_LATER = new Date('2026-01-03T18:30:00.000Z'); // same UTC day as DAY3

/** A `practice_attempts` row, exactly as `REPLAY_SELECT` reads it. */
function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'attempt-1',
    outcome: 'correct',
    gradingMethod: 'exact',
    answeredAt: DAY1,
    asrConfidence: null,
    answerSnapshot: {
      resolvedAt: DAY1.toISOString(),
      answerResolution: 'resolved',
      resolvedForStateCode: null,
      answers: [],
    },
    retryOfAttemptId: null,
    ...overrides,
  };
}

/**
 * A transaction client stub.
 *
 * Every model the function could reach is present — including
 * `learnerProfile`, which it must NEVER touch (detail C: a replay does not
 * re-fire the journey stage transition). A missing model would make that
 * assertion pass for the wrong reason.
 */
function txFor(attempts: ReturnType<typeof attempt>[]) {
  return {
    practiceAttempt: {
      findMany: jest.fn().mockResolvedValue(attempts),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    questionMastery: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    learnerProfile: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
  } as any;
}

/** The `question_mastery` payload the function wrote, as one object. */
function written(tx: any): Record<string, unknown> {
  expect(tx.questionMastery.upsert).toHaveBeenCalledTimes(1);
  return tx.questionMastery.upsert.mock.calls[0][0].update;
}

/**
 * The row a given sequence of graded attempts SHOULD produce, folded with the
 * pure scheduler — the independent expectation described in this file's
 * header. Note that each step carries its OWN instant.
 */
function expectedRow(
  steps: readonly (readonly [AttemptOutcome, Date])[],
): Record<string, unknown> {
  const record: MasteryRecord = steps.reduce<MasteryRecord>(
    (acc, [outcome, at]) => nextSchedule(acc, outcome, at),
    initialMasteryRecord(),
  );

  return {
    state: record.state,
    dueAt: record.dueAt,
    intervalDays: record.intervalDays,
    ease: record.ease,
    correctStreak: record.correctStreak,
    lapses: record.lapses,
    totalAttempts: record.totalAttempts,
    distinctCorrectDays: record.distinctCorrectDays,
    lastOutcome:
      record.lastOutcome === null ? null : toStoredMasteryOutcome(record.lastOutcome),
    lastAttemptAt: record.lastAttemptAt,
  };
}

// -----------------------------------------------------------------------------
// A history worth replaying, shared by the first two cases.
//
// Two genuine correct answers on two DISTINCT days (so the record reaches
// `review` with `distinctCorrectDays: 2` — a state a single attempt could not
// produce, which is what keeps the assertions below from being vacuous), then
// the pair the epic is about.
// -----------------------------------------------------------------------------
const EARLIER_1 = attempt({ id: 'earlier-1', outcome: 'correct', answeredAt: DAY1 });
const EARLIER_2 = attempt({ id: 'earlier-2', outcome: 'correct', answeredAt: DAY2 });

/** The retry that corrected whatever the recogniser got wrong. */
const RETRY = attempt({
  id: 'retry',
  outcome: 'correct',
  answeredAt: DAY3_LATER,
  asrConfidence: 0.95,
  retryOfAttemptId: 'spoken-miss',
});

/** What the row must be: the two earlier days, then the retry. Never the miss. */
const AS_IF_THE_MISS_NEVER_HAPPENED = expectedRow([
  ['correct', DAY1],
  ['correct', DAY2],
  ['correct', DAY3_LATER],
]);

describe('recomputeMasteryForQuestion — a superseded attempt is charged to nobody (issue #285)', () => {
  it('a CONFIDENTLY mis-transcribed attempt leaves no trace once it is superseded', async () => {
    // THE EPIC'S CORE ASSERTION. `asrConfidence: 0.9` is above the 0.6
    // threshold, so `isMisheardAttempt` correctly declines to call this
    // misheard and `scheduleMastery` DID schedule it when it was written:
    // `correctStreak` reset, `lapses` incremented, `review` regressed to
    // `lapsed`, `dueAt` pulled in. Accented speech transcribes confidently
    // and wrongly all the time, and epic #280's auto-submit removes the
    // confirm step that used to catch it.
    const tx = txFor([
      EARLIER_1,
      EARLIER_2,
      attempt({
        id: 'spoken-miss',
        outcome: 'incorrect',
        answeredAt: DAY3,
        asrConfidence: 0.9,
      }),
      RETRY,
    ]);

    await recomputeMasteryForQuestion(tx, USER, QUESTION);

    expect(written(tx)).toEqual(AS_IF_THE_MISS_NEVER_HAPPENED);

    // Spelled out as well as folded, because the whole point is the four
    // fields the mishearing would otherwise have damaged.
    expect(written(tx)).toMatchObject({
      state: 'mastered',
      correctStreak: 3,
      lapses: 0,
      distinctCorrectDays: 3,
      totalAttempts: 3,
    });
  });

  it('is unchanged from today when the superseded attempt was LOW confidence', async () => {
    // 0.3 is below the threshold, so `masterySkipReason` already refused this
    // attempt before this issue existed and nothing was ever scheduled from
    // it. The replay must land on the identical row — the fix widens the rule
    // to confidently-wrong transcripts without moving the misheard case.
    const tx = txFor([
      EARLIER_1,
      EARLIER_2,
      attempt({
        id: 'spoken-miss',
        outcome: 'incorrect',
        answeredAt: DAY3,
        asrConfidence: 0.3,
      }),
      RETRY,
    ]);

    await recomputeMasteryForQuestion(tx, USER, QUESTION);

    expect(written(tx)).toEqual(AS_IF_THE_MISS_NEVER_HAPPENED);
  });

  it('creates the row with the same values it would update it to', async () => {
    const tx = txFor([EARLIER_1, EARLIER_2, RETRY]);

    await recomputeMasteryForQuestion(tx, USER, QUESTION);

    const call = tx.questionMastery.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ userId_questionId: { userId: USER, questionId: QUESTION } });
    expect(call.create).toEqual({
      userId: USER,
      questionId: QUESTION,
      ...AS_IF_THE_MISS_NEVER_HAPPENED,
    });
  });
});

describe('recomputeMasteryForQuestion — the record disappears when nothing survives', () => {
  it('deletes the row when the question’s only real attempt was superseded', async () => {
    // A confidently-wrong answer, retried — and misheard the second time too,
    // so `masterySkipReason` refuses the retry. Nothing schedulable has ever
    // happened at this question, and `memory-model.md` §2 is explicit that
    // `new` is the ABSENCE of a row, never a row that says `new`.
    const tx = txFor([
      attempt({ id: 'spoken-miss', outcome: 'incorrect', answeredAt: DAY1, asrConfidence: 0.9 }),
      attempt({
        id: 'retry',
        outcome: 'incorrect',
        answeredAt: DAY2,
        asrConfidence: 0.2,
        retryOfAttemptId: 'spoken-miss',
      }),
    ]);

    await recomputeMasteryForQuestion(tx, USER, QUESTION);

    expect(tx.questionMastery.upsert).not.toHaveBeenCalled();
    expect(tx.questionMastery.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, questionId: QUESTION },
    });
  });

  it('deletes rather than delete()s, so a question that never had a row does not throw', async () => {
    // `delete` on a missing row is a P2025, which would roll back the caller's
    // whole attempt write — for a row that was correctly never created.
    const tx = txFor([]);

    await expect(recomputeMasteryForQuestion(tx, USER, QUESTION)).resolves.toBeUndefined();
    expect(tx.questionMastery.delete).not.toHaveBeenCalled();
    expect(tx.questionMastery.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe('recomputeMasteryForQuestion — each attempt replays at its OWN answeredAt', () => {
  it('keeps distinct correct days distinct, and dues from the LAST attempt', async () => {
    // DETAIL A. A replay that passed one shared `now` to every step would see
    // three correct answers on ONE calendar day: `distinctCorrectDays` would
    // stall at 1, the `review -> mastered` promotion (which needs 3) would
    // never fire, and `dueAt` would be measured from the wrong instant.
    const tx = txFor([
      attempt({ id: 'd1', outcome: 'correct', answeredAt: DAY1 }),
      attempt({ id: 'd2', outcome: 'correct', answeredAt: DAY2 }),
      attempt({
        id: 'superseded',
        outcome: 'incorrect',
        answeredAt: DAY3,
        asrConfidence: 0.88,
      }),
      attempt({
        id: 'd3',
        outcome: 'correct',
        answeredAt: DAY3_LATER,
        retryOfAttemptId: 'superseded',
      }),
    ]);

    await recomputeMasteryForQuestion(tx, USER, QUESTION);

    const row = written(tx);
    expect(row.distinctCorrectDays).toBe(3);
    expect(row.state).toBe('mastered');
    // Due from DAY3_LATER — the last surviving attempt's own instant.
    expect(row.dueAt).toEqual(
      new Date(DAY3_LATER.getTime() + (row.intervalDays as number) * 24 * 60 * 60 * 1000),
    );
    expect(row.lastAttemptAt).toEqual(DAY3_LATER);
  });
});

describe('recomputeMasteryForQuestion — a self-mark replays as a self-mark', () => {
  it('applies the DISCOUNTED ease bump and interval, not the full one', async () => {
    // DETAIL B. `gradingMethod: 'self'` on a `correct` outcome is
    // `correct_self_marked` (`outcome-mapping.ts`), which `scheduler.ts`
    // halves: half the ease bump, half the interval growth. Replaying it as a
    // plain `correct` would silently over-credit every self-mark in a
    // learner's history — invisibly, because both produce a valid-looking row.
    const tx = txFor([
      attempt({ id: 'first', outcome: 'correct', answeredAt: DAY1 }),
      attempt({
        id: 'superseded',
        outcome: 'incorrect',
        answeredAt: DAY2,
        asrConfidence: 0.91,
      }),
      attempt({
        id: 'self-marked',
        outcome: 'correct',
        gradingMethod: 'self',
        answeredAt: DAY2,
        retryOfAttemptId: 'superseded',
      }),
    ]);

    await recomputeMasteryForQuestion(tx, USER, QUESTION);

    expect(written(tx)).toEqual(
      expectedRow([
        ['correct', DAY1],
        ['correct_self_marked', DAY2],
      ]),
    );

    // And the discount, stated in numbers so the equality above cannot pass
    // by both sides being wrong in the same way: a full `correct` here would
    // have been ease 2.7 on a 3-day interval.
    expect(written(tx)).toMatchObject({ ease: 2.65, intervalDays: 2 });

    // `correct_self_marked` is not a `PracticeOutcome`; the column holds the
    // collapsed value.
    expect(written(tx).lastOutcome).toBe('correct');
  });
});

describe('recomputeMasteryForQuestion — the skip rule is the shared one', () => {
  it('skips a `state_required` attempt exactly as masterySkipReason refuses it', async () => {
    // The learner had no state on their profile, so no accepted answers could
    // be resolved and the attempt was recorded `skipped`. Replaying it would
    // lapse a question's mastery for a system limitation.
    const tx = txFor([
      attempt({ id: 'first', outcome: 'correct', answeredAt: DAY1 }),
      attempt({
        id: 'no-state',
        outcome: 'skipped',
        answeredAt: DAY2,
        answerSnapshot: {
          resolvedAt: DAY2.toISOString(),
          answerResolution: 'state_required',
          resolvedForStateCode: null,
          answers: [],
        },
      }),
      attempt({ id: 'third', outcome: 'correct', answeredAt: DAY3 }),
    ]);

    await recomputeMasteryForQuestion(tx, USER, QUESTION);

    expect(written(tx)).toEqual(
      expectedRow([
        ['correct', DAY1],
        ['correct', DAY3],
      ]),
    );
  });

  it('treats an unreadable snapshot as `resolved` — evidence is not dropped on a parse', async () => {
    const tx = txFor([
      attempt({ id: 'first', outcome: 'correct', answeredAt: DAY1, answerSnapshot: null }),
    ]);

    await recomputeMasteryForQuestion(tx, USER, QUESTION);

    expect(written(tx)).toEqual(expectedRow([['correct', DAY1]]));
  });
});

describe('recomputeMasteryForQuestion — what it must NOT write', () => {
  const rows = [
    attempt({ id: 'spoken-miss', outcome: 'incorrect', answeredAt: DAY1, asrConfidence: 0.9 }),
    attempt({
      id: 'retry',
      outcome: 'correct',
      answeredAt: DAY2,
      retryOfAttemptId: 'spoken-miss',
    }),
  ];

  it('leaves every `practice_attempts` row untouched, superseded ones included', async () => {
    // The superseded attempt is EVIDENCE that a mishearing happened. This
    // codebase does not delete evidence to make a number look better
    // (`voice.md` §3.2) — what changes is only what the scheduler derives
    // from it.
    const before = JSON.parse(JSON.stringify(rows));
    const tx = txFor(rows);

    await recomputeMasteryForQuestion(tx, USER, QUESTION);

    expect(tx.practiceAttempt.update).not.toHaveBeenCalled();
    expect(tx.practiceAttempt.updateMany).not.toHaveBeenCalled();
    expect(tx.practiceAttempt.delete).not.toHaveBeenCalled();
    expect(tx.practiceAttempt.deleteMany).not.toHaveBeenCalled();
    expect(tx.practiceAttempt.create).not.toHaveBeenCalled();
    expect(JSON.parse(JSON.stringify(rows))).toEqual(before);
    expect(rows[0].outcome).toBe('incorrect');
    expect(rows[1].outcome).toBe('correct');
  });

  it('never reads or writes `learner_profiles` — a replay does not re-fire stage transitions', async () => {
    // DETAIL C. Journey stages are monotonic and already happened; a replay
    // walks the WHOLE history, so firing `nextStageOnMasteryEvent` from here
    // would raise the same transition once per historical attempt. That write
    // belongs to `scheduleMastery`, which sees one attempt at a time.
    const tx = txFor(rows);

    await recomputeMasteryForQuestion(tx, USER, QUESTION);

    expect(tx.learnerProfile.findUnique).not.toHaveBeenCalled();
    expect(tx.learnerProfile.update).not.toHaveBeenCalled();
  });

  it('reads every attempt at the question, for this user only, oldest first', async () => {
    // Not filtered by session: `question_mastery` is one row per
    // (user, question) across every session and both attempt sources, so a
    // replay scoped to one session would silently discard the rest of the
    // learner's history at that question.
    const tx = txFor(rows);

    await recomputeMasteryForQuestion(tx, USER, QUESTION);

    const call = tx.practiceAttempt.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: USER, questionId: QUESTION });
    expect(call.orderBy[0]).toEqual({ answeredAt: 'asc' });
  });

  it('is idempotent — running it twice writes the same row', async () => {
    const first = txFor(rows);
    const second = txFor(rows);

    await recomputeMasteryForQuestion(first, USER, QUESTION);
    await recomputeMasteryForQuestion(second, USER, QUESTION);

    expect(written(second)).toEqual(written(first));
  });
});

import { recomputeMasteryForQuestion } from './recompute';
import { toStoredMasteryOutcome } from './outcome-mapping';
import {
  initialMasteryRecord,
  nextSchedule,
  type AttemptOutcome,
  type MasteryRecord,
  type MasteryState,
} from './scheduler';

// =============================================================================
// The fairness invariant, as a PROPERTY (issue #289, epic #280 / E12)
// =============================================================================
//
// `recompute.spec.ts` (issue #285) proves the epic's claim on ONE history: a
// confidently-wrong spoken attempt, superseded by a correct retry, leaves
// `question_mastery` identical to the row the correct attempt alone would
// have produced. This file proves the SAME claim as a property, over the
// cross product this issue's own tracking calls for: every one of the five
// confidences `VISION.md` line 228's promise has to hold at —
// `0.2`, `0.55`, `0.6`, `0.9`, and `null` — crossed with every one of the
// five prior mastery states a question can be in when the mishearing lands —
// `new`, `learning`, `review`, `lapsed`, `mastered`.
//
// -----------------------------------------------------------------------------
// WHY THIS IS ITS OWN FILE RATHER THAN MORE `it`s IN `recompute.spec.ts`
// -----------------------------------------------------------------------------
//
// `recompute.spec.ts` is organized around DISTINCT BEHAVIOURS — supersession,
// deletion, replay timing, self-marking, the shared skip rule, what must never
// be written — each proved by one or two carefully hand-picked histories. A
// 25-cell matrix reads as noise inserted into that structure: it is one
// behaviour (supersession is unconditional) checked at many points rather than
// many behaviours, and the two boundary cases below it belong with it, not
// scattered into the sibling file's own sections. Keeping it separate also
// means a failure here reads unambiguously as "the property broke at this
// cell", never mixed into a diff against the sibling file's own worked
// examples.
//
// -----------------------------------------------------------------------------
// WHAT THE MATRIX ACTUALLY CLAIMS, STATED PRECISELY
// -----------------------------------------------------------------------------
//
// For every cell, the history is: some attempts that establish a STARTING
// state, then ONE MORE wrong attempt at the confidence under test —
// superseded by a correct retry. The claim is that `recomputeMasteryForQuestion`
// writes EXACTLY the row an independent fold of `nextSchedule` produces over
// the starting attempts plus the retry ALONE — the miss is not merely
// down-weighted or excluded from one field, it contributes NOTHING to any
// field, at ANY confidence, from ANY starting state. This is precisely because
// supersession is checked first and unconditionally in `recompute.ts`'s own
// loop (`if (supersededIds.has(attempt.id)) continue`) — `asrConfidence` is
// never read for a superseded row, so confidence cannot matter to this claim,
// and this file exists to demonstrate that rather than take the source's own
// shape as proof of it.
//
// Prisma is the same hand-built stub `recompute.spec.ts` uses. No test in
// this repository touches a database (docs/TESTING.md).
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const QUESTION = '22222222-2222-4222-8222-222222222222';

/** Sequential, distinct UTC calendar days — `day(1)` through `day(9)`. */
function day(n: number): Date {
  return new Date(`2026-04-${String(n).padStart(2, '0')}T09:00:00.000Z`);
}

/** A `practice_attempts` row, exactly as `REPLAY_SELECT` reads it. */
function attempt(overrides: Record<string, unknown> = {}) {
  const answeredAt = (overrides.answeredAt as Date) ?? day(1);
  return {
    id: 'attempt',
    outcome: 'correct',
    gradingMethod: 'exact',
    answeredAt,
    asrConfidence: null,
    answerSnapshot: {
      resolvedAt: answeredAt.toISOString(),
      answerResolution: 'resolved',
      resolvedForStateCode: null,
      answers: [],
    },
    retryOfAttemptId: null,
    ...overrides,
  };
}

/** A transaction client stub — see `recompute.spec.ts` for the full rationale. */
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

/** The `question_mastery` payload the function wrote (via `upsert`), or via `create` if that's what fired. */
function written(tx: any): Record<string, unknown> | null {
  if (tx.questionMastery.upsert.mock.calls.length === 1) {
    return tx.questionMastery.upsert.mock.calls[0][0].update;
  }
  return null;
}

/** The independently-computed expectation: a pure fold of `nextSchedule`. */
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
// The five prior mastery states, each as the attempt sequence that reaches it.
// -----------------------------------------------------------------------------
//
// Every sequence uses only OBJECTIVELY correct/incorrect outcomes at `exact`
// grading, on distinct days, so the state each reaches is unambiguous against
// `scheduler.ts`'s own state machine (see that file's header):
//
//   new      — no attempts at all.
//   learning — one correct attempt (new -> learning).
//   review   — two correct attempts on distinct days (learning -> review;
//              distinctCorrectDays = 2, short of the 3 `mastered` needs).
//   lapsed   — review, then one incorrect attempt (review -> lapsed, a real
//              regression: `lapses` increments).
//   mastered — three correct attempts on three distinct days (the third
//              correct attempt promotes review -> mastered).
const PRIOR_STATE_SETUPS: Record<
  MasteryState,
  ReadonlyArray<readonly [AttemptOutcome, Date]>
> = {
  new: [],
  learning: [['correct', day(1)]],
  review: [
    ['correct', day(1)],
    ['correct', day(2)],
  ],
  lapsed: [
    ['correct', day(1)],
    ['correct', day(2)],
    ['incorrect', day(3)],
  ],
  mastered: [
    ['correct', day(1)],
    ['correct', day(2)],
    ['correct', day(3)],
  ],
};

const PRIOR_STATES: MasteryState[] = ['new', 'learning', 'review', 'lapsed', 'mastered'];

/** The five confidences this issue names explicitly. */
const CONFIDENCES: ReadonlyArray<number | null> = [0.2, 0.55, 0.6, 0.9, null];

/** Build the setup rows, at ids `setup-0`, `setup-1`, … */
function setupRows(steps: ReadonlyArray<readonly [AttemptOutcome, Date]>) {
  return steps.map(([outcome, answeredAt], index) =>
    attempt({
      id: `setup-${index}`,
      // `AttemptOutcome` and the column's `outcome` agree for these two
      // values; `correct_self_marked` is not used by any setup sequence here.
      outcome,
      answeredAt,
    }),
  );
}

describe('the fairness invariant is a PROPERTY: confidence never matters once a wrong spoken attempt is superseded', () => {
  for (const priorState of PRIOR_STATES) {
    const setupSteps = PRIOR_STATE_SETUPS[priorState];
    const setup = setupRows(setupSteps);
    const missDay = day(setupSteps.length + 1);
    const retryDay = day(setupSteps.length + 2);

    describe(`starting from ${priorState}`, () => {
      it.each(CONFIDENCES)(
        `a wrong spoken attempt at confidence %s, superseded by a correct retry, leaves the row identical to the retry alone`,
        async (confidence) => {
          const tx = txFor([
            ...setup,
            attempt({
              id: 'miss',
              outcome: 'incorrect',
              answeredAt: missDay,
              asrConfidence: confidence,
            }),
            attempt({
              id: 'retry',
              outcome: 'correct',
              answeredAt: retryDay,
              retryOfAttemptId: 'miss',
            }),
          ]);

          await recomputeMasteryForQuestion(tx, USER, QUESTION);

          const expected = expectedRow([...setupSteps, ['correct', retryDay]]);
          const result = written(tx);

          // From `new` with no attempts at all plus one correct retry, the
          // record is schedulable (`scheduled === 1`), so `upsert` always
          // fires here — `written` returning `null` would itself be a failure
          // this assertion catches.
          expect(result).toEqual(expected);
        },
      );
    });
  }
});

// -----------------------------------------------------------------------------
// The two cells that matter most, made explicit rather than left implicit in
// the matrix above (which proves them only as two of twenty-five rows).
// -----------------------------------------------------------------------------

describe('the two boundary confidences this epic turns on', () => {
  it('NULL confidence is never treated as low — unknown is not low (masterySkipReason, via a replay)', async () => {
    // Unlike the matrix above, this attempt is NOT superseded — nothing
    // retried it. The question this proves is different: does the replay
    // schedule it as a genuine miss (the correct answer, because `null` means
    // "the recogniser reported nothing", never "the recogniser was unsure")?
    // If `isMisheardAttempt` ever collapsed `null` into "low", this attempt
    // would be silently skipped and the row below would equal
    // `expectedRow([['correct', day(1)]])` instead — identical to as if the
    // miss had never been recorded at all, which is exactly the unfair-in-the-
    // other-direction bug §2's "unknown is not low" condition exists to
    // prevent (a learner would never be asked again what they just got wrong).
    const tx = txFor([
      attempt({ id: 'first', outcome: 'correct', answeredAt: day(1) }),
      attempt({
        id: 'unconfirmed-miss',
        outcome: 'incorrect',
        answeredAt: day(2),
        asrConfidence: null,
      }),
    ]);

    await recomputeMasteryForQuestion(tx, USER, QUESTION);

    expect(written(tx)).toEqual(
      expectedRow([
        ['correct', day(1)],
        ['incorrect', day(2)],
      ]),
    );
    // Spelled out: a real regression happened. `lapses` does not increment
    // (review/mastered only), but the streak resets and the state moves.
    expect(written(tx)).toMatchObject({ correctStreak: 0, state: 'learning' });
  });

  it('0.6 EXACTLY is NOT below the threshold — the trusted boundary (masterySkipReason, via a replay)', async () => {
    // Also not superseded. `ASR_CONFIDENCE_THRESHOLD` is `0.6`, and
    // `isMisheardAttempt`'s condition is STRICTLY below it — so an attempt
    // reported at exactly `0.6` is trusted, and a miss at that confidence is a
    // real miss, scheduled exactly as any typed miss would be.
    const tx = txFor([
      attempt({ id: 'first', outcome: 'correct', answeredAt: day(1) }),
      attempt({
        id: 'boundary-miss',
        outcome: 'incorrect',
        answeredAt: day(2),
        asrConfidence: 0.6,
      }),
    ]);

    await recomputeMasteryForQuestion(tx, USER, QUESTION);

    expect(written(tx)).toEqual(
      expectedRow([
        ['correct', day(1)],
        ['incorrect', day(2)],
      ]),
    );
  });

  it('contrast: a hair below the boundary (0.59) IS misheard, and the row is UNCHANGED by the miss', async () => {
    // Not superseded either. This is the negative space either boundary test
    // above would fail to catch on its own: 0.59 must be refused by
    // `masterySkipReason`, so the row must equal the state BEFORE the miss —
    // not the miss applied, and not the row `expectedRow` would compute if the
    // miss were (wrongly) scheduled.
    const tx = txFor([
      attempt({ id: 'first', outcome: 'correct', answeredAt: day(1) }),
      attempt({
        id: 'misheard',
        outcome: 'incorrect',
        answeredAt: day(2),
        asrConfidence: 0.59,
      }),
    ]);

    await recomputeMasteryForQuestion(tx, USER, QUESTION);

    expect(written(tx)).toEqual(expectedRow([['correct', day(1)]]));
    expect(written(tx)).toMatchObject({ state: 'learning', correctStreak: 1, lapses: 0 });
  });
});

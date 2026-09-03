import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AiDispatchService } from '../ai/ai-dispatch.service';
import { Clock } from '../common/clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import { ReadinessService } from '../readiness/readiness.service';
import { GRADING_SCHEMA_NAME } from './grading';
import { computeSummary, PracticeService } from './practice.service';
import type { CreatePracticeSessionInput } from './dto/create-practice-session.dto';
import type { RecordAttemptInput } from './dto/record-attempt.dto';

// =============================================================================
// PracticeService — tests (issue #73, epic #52 / E3)
// =============================================================================
//
// The decisions, not the plumbing — the same posture `civics.service.spec.ts`
// takes, applied to the file this document's own header calls "the practice
// loop": open a session, be asked a question, answer it, be graded
// deterministically, and see a summary that can never disagree with the rows
// that produced it.
//
// Prisma is mocked throughout with a small hand-built stub rather than
// `jest-mock-extended`'s `mockDeep` — this service reads and writes a narrow,
// known set of models, and a plain object keeps every mock's shape visible in
// this file rather than behind a generic deep proxy. No test in this
// repository touches a database (docs/TESTING.md).
//
// -----------------------------------------------------------------------------
// WHY `$transaction` JUST CALLS ITS CALLBACK WITH THE SAME STUB
// -----------------------------------------------------------------------------
//
// `createSession` opens an interactive transaction to make "abandon the old
// session, open the new one" atomic. The unit under test here is the SERVICE's
// decisions (what it reads, what it writes, in what order), not Prisma's own
// transactional guarantees — so `$transaction` here simply invokes the
// callback with the very same mock, and every assertion about `updateMany`/
// `create` calls still sees them in the order the service issued them.
// =============================================================================

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CATEGORY_ID = '44444444-4444-4444-8444-444444444444';

const Q_NONE = '55555555-5555-4555-8555-555555555555';
const Q_NONE_2 = '66666666-6666-4666-8666-666666666666';
const Q_STATE = '77777777-7777-4777-8777-777777777777';
const Q_NATIONAL = '88888888-8888-4888-8888-888888888888';

const TV = 'v2025';

const NOW = new Date('2026-06-01T12:00:00Z');

/** A `civics_questions` row, exactly as `QUESTION_SELECT` reads it. */
function question(overrides: Record<string, unknown> = {}) {
  return {
    id: Q_NONE,
    number: 1,
    prompt: 'Name one branch or part of the government.',
    categoryId: CATEGORY_ID,
    testVersionCode: TV,
    dynamicScope: 'none',
    ...overrides,
  };
}

/** A `civics_answers` row, exactly as `resolveAcceptedAnswers` reads it. */
function answerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1111111-1111-4111-8111-111111111111',
    text: 'Congress',
    sort: 0,
    stateCode: null,
    verifiedAt: new Date('2026-05-01T00:00:00Z'),
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
    ...overrides,
  };
}

/** A `practice_sessions` row. */
function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    userId: USER_A,
    kind: 'quick',
    status: 'in_progress',
    testVersionCode: TV,
    categoryId: null,
    plannedCount: 5,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: null,
    summary: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** A `practice_attempts` row, WITH its joined question — what `create`/`findMany` return. */
function attemptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1111111-1111-4111-8111-111111111111',
    userId: USER_A,
    questionId: Q_NONE,
    sessionId: SESSION_ID,
    source: 'practice',
    inputMode: 'typed',
    promptMode: 'read',
    responseText: 'Congress',
    outcome: 'correct',
    gradingMethod: 'exact',
    revealed: false,
    hintUsed: false,
    durationMs: null,
    answeredAt: NOW,
    answerSnapshot: {
      resolvedAt: NOW.toISOString(),
      answerResolution: 'resolved',
      resolvedForStateCode: null,
      answers: [],
    },
    createdAt: NOW,
    question: question(),
    ...overrides,
  };
}

function createInput(
  overrides: Partial<CreatePracticeSessionInput> = {},
): CreatePracticeSessionInput {
  return { kind: 'quick', plannedCount: 5, ...overrides } as CreatePracticeSessionInput;
}

function attemptInput(overrides: Partial<RecordAttemptInput> = {}): RecordAttemptInput {
  return {
    questionId: Q_NONE,
    skipped: false,
    revealed: false,
    hintUsed: false,
    ...overrides,
  } as RecordAttemptInput;
}

describe('PracticeService', () => {
  let service: PracticeService;
  let prisma: any;
  let clock: { now: jest.Mock; calendarDateIn: jest.Mock };
  /**
   * The grading ladder's second rung, as a double.
   *
   * DEFAULTS TO `unavailable`, which is the state of every deployment whose
   * admin has not configured AI and of every learner without a personal key —
   * and therefore the state every test written before #116 was implicitly
   * asserting against. Rung 3 keeps the deterministic result, so those tests go
   * on asserting exactly what they always did.
   */
  let dispatch: { runStructured: jest.Mock };

  /**
   * Readiness recompute trigger (a) (issue #122, epic #55 / E6), as a
   * double. `completeSession` awaits this and does nothing with its return
   * value, so a resolved stub is all any test here needs — no test in this
   * file is about the readiness engine's own behaviour (see
   * `readiness.service.spec.ts`/`readiness-engine.spec.ts` for that).
   */
  let readiness: { recomputeSnapshot: jest.Mock };

  beforeEach(async () => {
    prisma = {
      civicsCategory: { findFirst: jest.fn().mockResolvedValue(null) },
      practiceSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn(),
      },
      practiceAttempt: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      civicsQuestion: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      learnerProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      civicsAnswer: { findMany: jest.fn().mockResolvedValue([]) },
      // Empty by default: no mastery row for any question means every
      // question reads as `state: 'new'` (`classifyMasteryBucket`) — the same
      // "never attempted" default v1's `seenQuestionIds` used to express via
      // an empty `practiceAttempt.groupBy` result.
      questionMastery: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue(null),
      },
    };
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));

    // Default: create() and update() echo the row back with the write applied,
    // exactly like Postgres would — most tests never need to override this.
    prisma.practiceSession.create.mockImplementation(async ({ data }: any) => ({
      ...sessionRow(),
      ...data,
      completedAt: null,
      summary: null,
    }));
    prisma.practiceSession.update.mockImplementation(async ({ where, data }: any) => ({
      ...sessionRow({ id: where.id }),
      ...data,
    }));

    clock = {
      now: jest.fn().mockReturnValue(NOW),
      calendarDateIn: jest.fn(),
    };

    dispatch = {
      runStructured: jest
        .fn()
        .mockResolvedValue({ status: 'unavailable', cause: 'ai_disabled' }),
    };

    readiness = {
      recomputeSnapshot: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PracticeService,
        { provide: PrismaService, useValue: prisma },
        { provide: Clock, useValue: clock },
        // THE DISPATCHER, NOT A PROVIDER AND NOT A CREDENTIAL STORE. The service
        // can only be constructed with this one AI dependency, which is the
        // module-level property `ai-evaluation.md` §3 asks for, checked by the
        // compiler on every test that stands the service up.
        { provide: AiDispatchService, useValue: dispatch },
        { provide: ReadinessService, useValue: readiness },
      ],
    }).compile();

    service = module.get(PracticeService);
  });

  /**
   * Wires `practiceSession.findFirst` so it returns `row` ONLY when both `id`
   * AND `userId` in the `where` match — the same shape the real query has.
   * This is what makes the cross-user tests below assertions about the QUERY
   * itself, not about a check applied after loading someone else's row.
   */
  function mockOwnedSession(row: ReturnType<typeof sessionRow>): void {
    prisma.practiceSession.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.id === row.id && where.userId === row.userId) {
        return row;
      }
      return null;
    });
  }

  // ===========================================================================
  // createSession — question selection
  // ===========================================================================

  describe('createSession — question selection', () => {
    beforeEach(() => {
      prisma.learnerProfile.findUnique.mockResolvedValue({
        stateCode: 'CA',
        testVersionCode: TV,
        seniorExemption: false,
      });
    });

    it('is NEW-FIRST (v2): a learner with mastery rows on some questions gets a never-attempted one', async () => {
      // Two questions already in ordinary progress (a real `question_mastery`
      // row, not due, not weak — the STEADY bucket), one never touched at
      // all (no row — the NEW bucket). Whichever order the STEADY pair would
      // shuffle into, the single NEW question MUST be first: `mastery/
      // selector.ts` orders NEW ahead of STEADY. This is the v2 selector's
      // direct descendant of v1's "unseen-first" rule, now expressed through
      // `question_mastery` instead of a `practiceAttempt` groupBy.
      prisma.civicsQuestion.findMany.mockResolvedValue([
        question({ id: Q_NONE, number: 1 }),
        question({ id: Q_NONE_2, number: 2 }),
        question({ id: Q_NATIONAL, number: 3, dynamicScope: 'national' }),
      ]);
      prisma.questionMastery.findMany.mockResolvedValue([
        {
          questionId: Q_NONE,
          state: 'learning',
          dueAt: null,
          lapses: 0,
          correctStreak: 1,
          lastAttemptAt: NOW,
        },
        {
          questionId: Q_NONE_2,
          state: 'learning',
          dueAt: null,
          lapses: 0,
          correctStreak: 1,
          lastAttemptAt: NOW,
        },
        // Q_NATIONAL has no row at all — it stays NEW.
      ]);

      const result = await service.createSession(USER_A, createInput({ plannedCount: 3 }));

      expect(result.nextQuestion?.id).toBe(Q_NATIONAL);
    });

    it('filters the candidate pool to seniorEligible questions under the senior exemption', async () => {
      prisma.learnerProfile.findUnique.mockResolvedValue({
        stateCode: 'CA',
        testVersionCode: TV,
        seniorExemption: true,
      });
      prisma.civicsQuestion.findMany.mockResolvedValue([question()]);

      await service.createSession(USER_A, createInput());

      expect(prisma.civicsQuestion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ seniorEligible: true }) }),
      );
    });

    it('omits the seniorEligible filter entirely for a learner without the exemption', async () => {
      // `undefined` in a Prisma `where` is ignored, but an explicit
      // `seniorEligible: false` is NOT — building the clause conditionally
      // (as `civics.service.spec.ts` already asserts for the read API) is
      // what keeps "not filtered" and "filtered to the ineligible" apart.
      prisma.civicsQuestion.findMany.mockResolvedValue([question()]);

      await service.createSession(USER_A, createInput());

      const where = prisma.civicsQuestion.findMany.mock.calls[0][0].where;
      expect('seniorEligible' in where).toBe(false);
    });

    it('excludes a state-scope question from the pool when the learner has no stateCode', async () => {
      prisma.learnerProfile.findUnique.mockResolvedValue({
        stateCode: null,
        testVersionCode: TV,
        seniorExemption: false,
      });
      prisma.civicsQuestion.findMany.mockResolvedValue([
        question({ id: Q_STATE, dynamicScope: 'state' }),
        question({ id: Q_NONE, dynamicScope: 'none' }),
      ]);

      const result = await service.createSession(USER_A, createInput({ plannedCount: 2 }));

      // Only one of the two questions can be graded honestly, so the pool has
      // exactly one member — never the state-scope one — and plannedCount is
      // clamped down to what the bank could actually supply.
      expect(result.nextQuestion?.id).toBe(Q_NONE);
      expect(result.session.plannedCount).toBe(1);
    });

    it('refuses a session (409) when every candidate is a state-scope question and the learner has no state', async () => {
      prisma.learnerProfile.findUnique.mockResolvedValue({
        stateCode: null,
        testVersionCode: TV,
        seniorExemption: false,
      });
      prisma.civicsQuestion.findMany.mockResolvedValue([
        question({ id: Q_STATE, dynamicScope: 'state' }),
      ]);

      await expect(service.createSession(USER_A, createInput())).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.practiceSession.create).not.toHaveBeenCalled();
    });

    it('scopes the candidate pool to the learner’s own testVersionCode', async () => {
      prisma.civicsQuestion.findMany.mockResolvedValue([question()]);

      await service.createSession(USER_A, createInput());

      expect(prisma.civicsQuestion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ testVersionCode: TV }) }),
      );
    });

    it('scopes the candidate pool to the requested category, and validates it against the learner’s own bank', async () => {
      prisma.civicsCategory.findFirst.mockResolvedValue({ id: CATEGORY_ID });
      prisma.civicsQuestion.findMany.mockResolvedValue([question({ categoryId: CATEGORY_ID })]);

      await service.createSession(
        USER_A,
        createInput({ kind: 'category', categoryId: CATEGORY_ID }),
      );

      expect(prisma.civicsCategory.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CATEGORY_ID, testVersionCode: TV } }),
      );
      expect(prisma.civicsQuestion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ testVersionCode: TV, categoryId: CATEGORY_ID }),
        }),
      );
    });

    it('404s a category that does not belong to the learner’s own test version', async () => {
      prisma.civicsCategory.findFirst.mockResolvedValue(null);

      await expect(
        service.createSession(USER_A, createInput({ kind: 'category', categoryId: CATEGORY_ID })),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.civicsQuestion.findMany).not.toHaveBeenCalled();
    });

    it('400s a learner with no resolved test version, before touching the question bank', async () => {
      prisma.learnerProfile.findUnique.mockResolvedValue({
        stateCode: null,
        testVersionCode: null,
        seniorExemption: false,
      });

      await expect(service.createSession(USER_A, createInput())).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.civicsQuestion.findMany).not.toHaveBeenCalled();
    });

    it('abandons any existing in_progress session for the caller before opening the new one', async () => {
      prisma.civicsQuestion.findMany.mockResolvedValue([question()]);

      await service.createSession(USER_A, createInput());

      expect(prisma.practiceSession.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_A, status: 'in_progress' },
        data: { status: 'abandoned', completedAt: NOW },
      });
      // The transaction closes the old one before opening the new one.
      const updateManyOrder = prisma.practiceSession.updateMany.mock.invocationCallOrder[0];
      const createOrder = prisma.practiceSession.create.mock.invocationCallOrder[0];
      expect(updateManyOrder).toBeLessThan(createOrder);
    });
  });

  // ===========================================================================
  // getSession / listSessions — ownership and shape
  // ===========================================================================

  describe('getSession', () => {
    it('returns null for nextQuestion once the planned count is reached', async () => {
      mockOwnedSession(sessionRow({ plannedCount: 1 }));
      prisma.practiceAttempt.findMany.mockResolvedValue([attemptRow()]);

      const result = await service.getSession(USER_A, SESSION_ID);

      expect(result.nextQuestion).toBeNull();
      expect(result.progress).toEqual({ answered: 1, planned: 1 });
    });

    it('returns null for nextQuestion on a completed session, without querying the bank', async () => {
      mockOwnedSession(sessionRow({ status: 'completed', plannedCount: 5 }));
      prisma.practiceAttempt.findMany.mockResolvedValue([]);

      const result = await service.getSession(USER_A, SESSION_ID);

      expect(result.nextQuestion).toBeNull();
      expect(prisma.civicsQuestion.findMany).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // recordAttempt — grading
  // ===========================================================================

  describe('recordAttempt — gradingMethod', () => {
    beforeEach(() => {
      mockOwnedSession(sessionRow());
      prisma.civicsQuestion.findUnique.mockResolvedValue(question());
      prisma.practiceAttempt.findFirst.mockResolvedValue(null); // no existing attempt
      prisma.practiceAttempt.findMany.mockResolvedValue([]); // recomputed `answered` count
      prisma.civicsAnswer.findMany.mockResolvedValue([answerRow({ text: 'Congress' })]);
      prisma.practiceAttempt.create.mockImplementation(async ({ data }: any) => ({
        ...data,
        id: 'new-attempt',
        question: question(),
      }));
    });

    it('is "exact" on a matched response', async () => {
      const result = await service.recordAttempt(
        USER_A,
        SESSION_ID,
        attemptInput({ responseText: 'Congress' }),
      );

      expect(result.attempt.outcome).toBe('correct');
      expect(result.attempt.gradingMethod).toBe('exact');
    });

    it('is "exact" on a miss too — grading happened, it just did not match', async () => {
      const result = await service.recordAttempt(
        USER_A,
        SESSION_ID,
        attemptInput({ responseText: 'The Supreme Court of Nonsense' }),
      );

      expect(result.attempt.outcome).toBe('incorrect');
      expect(result.attempt.gradingMethod).toBe('exact');
    });

    it('records a skip as outcome "skipped" with responseText null', async () => {
      const result = await service.recordAttempt(
        USER_A,
        SESSION_ID,
        attemptInput({ skipped: true }),
      );

      expect(result.attempt.outcome).toBe('skipped');
      expect(result.attempt.responseText).toBeNull();
      expect(result.attempt.gradingMethod).toBe('exact');
      expect(prisma.practiceAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ outcome: 'skipped', responseText: null }),
        }),
      );
    });

    it('sets revealed: true and still grades a supplied answer normally', async () => {
      const correct = await service.recordAttempt(
        USER_A,
        SESSION_ID,
        attemptInput({ responseText: 'Congress', revealed: true }),
      );
      expect(correct.attempt.revealed).toBe(true);
      expect(correct.attempt.outcome).toBe('correct');

      const incorrect = await service.recordAttempt(
        USER_A,
        SESSION_ID,
        attemptInput({ questionId: Q_NONE, responseText: 'wrong', revealed: true }),
      );
      expect(incorrect.attempt.revealed).toBe(true);
      expect(incorrect.attempt.outcome).toBe('incorrect');
    });

    it('404s an unknown question', async () => {
      prisma.civicsQuestion.findUnique.mockResolvedValue(null);

      await expect(
        service.recordAttempt(USER_A, SESSION_ID, attemptInput()),
      ).rejects.toThrow(NotFoundException);
    });

    it('400s a question outside the session’s own test version', async () => {
      prisma.civicsQuestion.findUnique.mockResolvedValue(
        question({ testVersionCode: 'v2008' }),
      );

      await expect(
        service.recordAttempt(USER_A, SESSION_ID, attemptInput()),
      ).rejects.toThrow(BadRequestException);
    });

    it('400s a question outside the session’s own category', async () => {
      mockOwnedSession(sessionRow({ categoryId: CATEGORY_ID }));
      prisma.civicsQuestion.findUnique.mockResolvedValue(
        question({ categoryId: 'other-category' }),
      );

      await expect(
        service.recordAttempt(USER_A, SESSION_ID, attemptInput()),
      ).rejects.toThrow(BadRequestException);
    });

    it('409s a second attempt at the same question in the same session', async () => {
      prisma.practiceAttempt.findFirst.mockResolvedValue({ id: 'already-answered' });

      await expect(
        service.recordAttempt(USER_A, SESSION_ID, attemptInput()),
      ).rejects.toThrow(ConflictException);
      expect(prisma.practiceAttempt.create).not.toHaveBeenCalled();
    });

    it('409s an attempt against a session that is not in_progress', async () => {
      mockOwnedSession(sessionRow({ status: 'completed' }));

      await expect(
        service.recordAttempt(USER_A, SESSION_ID, attemptInput()),
      ).rejects.toThrow(ConflictException);
      expect(prisma.civicsQuestion.findUnique).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // recordAttempt — answerSnapshot: exact shape, frozen at grading time
  // ===========================================================================

  describe('recordAttempt — answerSnapshot', () => {
    it('is written from the answers resolved AT GRADING TIME, in the exact documented shape', async () => {
      mockOwnedSession(sessionRow());
      prisma.civicsQuestion.findUnique.mockResolvedValue(
        question({ id: Q_NATIONAL, dynamicScope: 'national' }),
      );
      prisma.practiceAttempt.findFirst.mockResolvedValue(null);
      prisma.civicsAnswer.findMany.mockResolvedValue([
        answerRow({ id: 'ans-old', text: 'The Old President', sort: 0, stateCode: null }),
      ]);

      let createdData: any;
      prisma.practiceAttempt.create.mockImplementation(async ({ data }: any) => {
        createdData = data;
        return { ...data, id: 'attempt-1', question: question({ id: Q_NATIONAL, dynamicScope: 'national' }) };
      });

      const result = await service.recordAttempt(
        USER_A,
        SESSION_ID,
        attemptInput({ questionId: Q_NATIONAL, responseText: 'The Old President' }),
      );

      expect(result.attempt.answerSnapshot).toEqual({
        resolvedAt: NOW.toISOString(),
        answerResolution: 'resolved',
        resolvedForStateCode: null,
        answers: [
          {
            id: 'ans-old',
            text: 'The Old President',
            sort: 0,
            stateCode: null,
            verifiedAt: answerRow().verifiedAt.toISOString(),
          },
        ],
      });
      // `acceptedAnswers` on the result is the SAME list frozen into the
      // snapshot — the screen and the permanent record cannot disagree.
      expect(result.acceptedAnswers).toEqual(result.attempt.answerSnapshot.answers);

      // ---- a later correction to the underlying content must not reach back ----
      //
      // Simulate civics-content.md §4's close-then-open lifecycle: the answer
      // that was correct at grading time is superseded by a new one. Nothing
      // in `getSession` re-runs resolution — it reads the persisted row back
      // whole — so the debrief must still show what the learner was actually
      // graded against.
      prisma.civicsAnswer.findMany.mockResolvedValue([
        answerRow({ id: 'ans-new', text: 'The New President', sort: 0, stateCode: null }),
      ]);
      prisma.practiceAttempt.findMany.mockResolvedValue([
        { ...createdData, id: 'attempt-1', question: question({ id: Q_NATIONAL, dynamicScope: 'national' }) },
      ]);

      const session = await service.getSession(USER_A, SESSION_ID);

      expect(session.attempts[0].answerSnapshot.answers[0].text).toBe('The Old President');
      expect(JSON.stringify(session.attempts[0].answerSnapshot)).not.toContain('New President');
    });

    it('records answerResolution: "state_required" and outcome "skipped" — never "incorrect" — for a state question with no state resolvable', async () => {
      // Question selection never SELECTS such a question (question-selection.spec.ts),
      // so this only fires if a client posts a question id it was not handed —
      // and the attempt is recorded, not rejected, because it happened.
      mockOwnedSession(sessionRow());
      prisma.civicsQuestion.findUnique.mockResolvedValue(
        question({ id: Q_STATE, dynamicScope: 'state' }),
      );
      prisma.learnerProfile.findUnique.mockResolvedValue({
        stateCode: null,
        testVersionCode: TV,
        seniorExemption: false,
      });
      prisma.practiceAttempt.findFirst.mockResolvedValue(null);
      prisma.practiceAttempt.create.mockImplementation(async ({ data }: any) => ({
        ...data,
        id: 'attempt-1',
        question: question({ id: Q_STATE, dynamicScope: 'state' }),
      }));

      const result = await service.recordAttempt(
        USER_A,
        SESSION_ID,
        attemptInput({ questionId: Q_STATE, responseText: 'a guess' }),
      );

      expect(result.attempt.outcome).toBe('skipped');
      expect(result.attempt.answerSnapshot.answerResolution).toBe('state_required');
      expect(result.attempt.answerSnapshot.answers).toEqual([]);
      // No query was even issued for it — there is no state to query FOR.
      expect(prisma.civicsAnswer.findMany).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // selfMarkAttempt
  // ===========================================================================

  describe('selfMarkAttempt', () => {
    beforeEach(() => {
      mockOwnedSession(sessionRow());
    });

    it('flips an incorrect, revealed attempt to correct + self', async () => {
      const existing = attemptRow({ outcome: 'incorrect', gradingMethod: 'exact', revealed: true });
      prisma.practiceAttempt.findFirst.mockResolvedValue(existing);
      prisma.practiceAttempt.update.mockImplementation(async ({ data }: any) => ({
        ...existing,
        ...data,
      }));

      const result = await service.selfMarkAttempt(USER_A, SESSION_ID, existing.id);

      expect(prisma.practiceAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: existing.id },
          data: { outcome: 'correct', gradingMethod: 'self' },
        }),
      );
      expect(result.outcome).toBe('correct');
      expect(result.gradingMethod).toBe('self');
    });

    it('flips a skipped, revealed attempt to correct + self — the flashcard shape', async () => {
      const existing = attemptRow({
        outcome: 'skipped',
        gradingMethod: 'exact',
        revealed: true,
        responseText: null,
      });
      prisma.practiceAttempt.findFirst.mockResolvedValue(existing);
      prisma.practiceAttempt.update.mockImplementation(async ({ data }: any) => ({
        ...existing,
        ...data,
      }));

      const result = await service.selfMarkAttempt(USER_A, SESSION_ID, existing.id);

      expect(result.outcome).toBe('correct');
      expect(result.gradingMethod).toBe('self');
    });

    it('is idempotent: a second call on an already self-marked attempt returns it unchanged, with no write', async () => {
      const existing = attemptRow({ outcome: 'correct', gradingMethod: 'self', revealed: true });
      prisma.practiceAttempt.findFirst.mockResolvedValue(existing);

      const result = await service.selfMarkAttempt(USER_A, SESSION_ID, existing.id);

      expect(result.outcome).toBe('correct');
      expect(result.gradingMethod).toBe('self');
      expect(prisma.practiceAttempt.update).not.toHaveBeenCalled();
    });

    it('refuses (400) an attempt already correct by exact — self-mark must never downgrade a verified match', async () => {
      const existing = attemptRow({ outcome: 'correct', gradingMethod: 'exact' });
      prisma.practiceAttempt.findFirst.mockResolvedValue(existing);

      await expect(service.selfMarkAttempt(USER_A, SESSION_ID, existing.id)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.practiceAttempt.update).not.toHaveBeenCalled();
    });

    it('refuses (409) an attempt that has not been revealed yet', async () => {
      const existing = attemptRow({ outcome: 'incorrect', gradingMethod: 'exact', revealed: false });
      prisma.practiceAttempt.findFirst.mockResolvedValue(existing);

      await expect(service.selfMarkAttempt(USER_A, SESSION_ID, existing.id)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.practiceAttempt.update).not.toHaveBeenCalled();
    });

    it('404s an attempt id that does not belong to this session/caller', async () => {
      prisma.practiceAttempt.findFirst.mockResolvedValue(null);

      await expect(
        service.selfMarkAttempt(USER_A, SESSION_ID, 'not-an-attempt'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ===========================================================================
  // completeSession
  // ===========================================================================

  describe('completeSession', () => {
    it('computes the summary from PERSISTED attempts, ignoring anything a caller might have believed', async () => {
      mockOwnedSession(sessionRow({ plannedCount: 3 }));
      prisma.practiceAttempt.findMany.mockResolvedValue([
        { outcome: 'correct', gradingMethod: 'exact', revealed: false, hintUsed: false, durationMs: 1000 },
        { outcome: 'correct', gradingMethod: 'self', revealed: true, hintUsed: false, durationMs: null },
        { outcome: 'incorrect', gradingMethod: 'exact', revealed: false, hintUsed: true, durationMs: 500 },
      ]);

      await service.completeSession(USER_A, SESSION_ID);

      expect(prisma.practiceSession.update).toHaveBeenCalledWith({
        where: { id: SESSION_ID },
        data: {
          status: 'completed',
          completedAt: NOW,
          summary: {
            plannedCount: 3,
            answered: 3,
            correct: 2,
            partial: 0,
            incorrect: 1,
            skipped: 0,
            selfMarked: 1,
            revealed: 1,
            hintUsed: 1,
            totalDurationMs: 1500,
            timedAttempts: 2,
          },
        },
      });

      // Readiness recompute trigger (a), issue #122 — called synchronously,
      // after the completion write above, for the caller who just completed.
      expect(readiness.recomputeSnapshot).toHaveBeenCalledWith(USER_A);
    });

    it('is idempotent: completing an already-completed session returns the stored summary and does not re-stamp completedAt', async () => {
      const storedSummary = {
        plannedCount: 5,
        answered: 5,
        correct: 5,
        partial: 0,
        incorrect: 0,
        skipped: 0,
        selfMarked: 0,
        revealed: 0,
        hintUsed: 0,
        totalDurationMs: null,
        timedAttempts: 0,
      };
      mockOwnedSession(
        sessionRow({
          status: 'completed',
          completedAt: new Date('2026-01-02T00:00:00Z'),
          summary: storedSummary,
        }),
      );

      const result = await service.completeSession(USER_A, SESSION_ID);

      expect(result.completedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(result.summary).toEqual(storedSummary);
      expect(prisma.practiceSession.update).not.toHaveBeenCalled();
      expect(prisma.practiceAttempt.findMany).not.toHaveBeenCalled();
      // Nothing changed, so no readiness recompute either — the idempotent
      // early return happens before the trigger.
      expect(readiness.recomputeSnapshot).not.toHaveBeenCalled();
    });

    it('409s an abandoned session — it was closed by a later session start and has no completion to record', async () => {
      mockOwnedSession(sessionRow({ status: 'abandoned', completedAt: NOW }));

      await expect(service.completeSession(USER_A, SESSION_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.practiceSession.update).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // computeSummary — the pure aggregation
  // ===========================================================================

  describe('computeSummary', () => {
    it('reports totalDurationMs: null and timedAttempts: 0 when nothing reported a duration', () => {
      const summary = computeSummary(
        [
          { outcome: 'correct', gradingMethod: 'exact', revealed: false, hintUsed: false, durationMs: null },
          { outcome: 'skipped', gradingMethod: 'exact', revealed: false, hintUsed: false, durationMs: null },
        ],
        2,
      );

      expect(summary.totalDurationMs).toBeNull();
      expect(summary.timedAttempts).toBe(0);
    });

    it('sums only the timed attempts and counts them separately from the untimed ones', () => {
      const summary = computeSummary(
        [
          { outcome: 'correct', gradingMethod: 'exact', revealed: false, hintUsed: false, durationMs: 2000 },
          { outcome: 'correct', gradingMethod: 'exact', revealed: false, hintUsed: false, durationMs: null },
          { outcome: 'correct', gradingMethod: 'exact', revealed: false, hintUsed: false, durationMs: 3000 },
        ],
        3,
      );

      expect(summary.totalDurationMs).toBe(5000);
      expect(summary.timedAttempts).toBe(2);
    });

    it('never claims a false 0 for duration or counts more selfMarked than gradingMethod: "self" attempts', () => {
      const summary = computeSummary(
        [
          { outcome: 'correct', gradingMethod: 'self', revealed: true, hintUsed: false, durationMs: null },
          { outcome: 'incorrect', gradingMethod: 'exact', revealed: false, hintUsed: false, durationMs: null },
        ],
        2,
      );

      expect(summary.selfMarked).toBe(1);
      expect(summary.correct).toBe(1);
      expect(summary.totalDurationMs).toBeNull();
    });
  });

  // ===========================================================================
  // Cross-user isolation — every route is scoped by userId, and a foreign
  // session is a 404, never a 403
  // ===========================================================================

  describe('cross-user access is structurally impossible', () => {
    it('filters requireSession’s own query by userId, in the where, not after loading the row', async () => {
      mockOwnedSession(sessionRow({ userId: USER_A }));

      await expect(service.getSession(USER_B, SESSION_ID)).rejects.toThrow(NotFoundException);

      expect(prisma.practiceSession.findFirst).toHaveBeenCalledWith({
        where: { id: SESSION_ID, userId: USER_B },
      });
    });

    it('404s — never 403s — every route when the session belongs to another learner', async () => {
      mockOwnedSession(sessionRow({ userId: USER_A }));

      const attempts = [
        service.getSession(USER_B, SESSION_ID),
        service.recordAttempt(USER_B, SESSION_ID, attemptInput()),
        service.selfMarkAttempt(USER_B, SESSION_ID, 'any-attempt-id'),
        service.completeSession(USER_B, SESSION_ID),
      ];

      for (const attempt of attempts) {
        await expect(attempt).rejects.toThrow(NotFoundException);
      }
    });

    it('404s a self-mark whose attempt belongs to someone else, even inside the caller’s own session', async () => {
      // The session is the caller's own, but the attempt row itself does not
      // match — `findFirst` filters on `{ id, sessionId, userId }` together.
      mockOwnedSession(sessionRow({ userId: USER_A }));
      prisma.practiceAttempt.findFirst.mockResolvedValue(null);

      await expect(
        service.selfMarkAttempt(USER_A, SESSION_ID, 'someone-elses-attempt'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ===========================================================================
  // The Clock — never a bare `new Date()`
  // ===========================================================================

  describe('the injected Clock, pinned', () => {
    it('stamps startedAt, answeredAt, and completedAt from the SAME pinned instant the Clock returns', async () => {
      const T1 = new Date('2026-01-01T00:00:00Z');
      const T2 = new Date('2026-02-02T00:00:00Z');
      const T3 = new Date('2026-03-03T00:00:00Z');

      // --- createSession -------------------------------------------------
      //
      // `mockReturnValue` (persistent for the phase), not `mockReturnValueOnce`:
      // `createSession` now calls `clock.now()` twice — once inside
      // `candidateQuestions` (v2 selection's `now` for due/weak bucketing,
      // issue #78) and once for `startedAt` — and both must read the SAME
      // pinned instant, exactly as two calls within one real request would.
      clock.now.mockReturnValue(T1);
      prisma.learnerProfile.findUnique.mockResolvedValue({
        stateCode: 'CA',
        testVersionCode: TV,
        seniorExemption: false,
      });
      prisma.civicsQuestion.findMany.mockResolvedValue([question()]);

      const created = await service.createSession(USER_A, createInput());
      expect(created.session.startedAt).toBe(T1.toISOString());
      expect(prisma.practiceSession.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ startedAt: T1 }) }),
      );

      // --- recordAttempt ---------------------------------------------------
      // Same reasoning as above: `recordAttempt` also calls `clock.now()`
      // more than once now (`answeredAt`, and `nextQuestionFor`'s own
      // `candidateQuestions` call for the FOLLOWING question) — all within T2.
      clock.now.mockReturnValue(T2);
      mockOwnedSession(sessionRow());
      prisma.civicsQuestion.findUnique.mockResolvedValue(question());
      prisma.practiceAttempt.findFirst.mockResolvedValue(null);
      prisma.civicsAnswer.findMany.mockResolvedValue([]);
      prisma.practiceAttempt.create.mockImplementation(async ({ data }: any) => ({
        ...data,
        id: 'attempt-1',
        question: question(),
      }));

      const recorded = await service.recordAttempt(USER_A, SESSION_ID, attemptInput());
      expect(recorded.attempt.answeredAt).toBe(T2.toISOString());
      expect(recorded.attempt.answerSnapshot.resolvedAt).toBe(T2.toISOString());

      // --- completeSession ---------------------------------------------------
      clock.now.mockReturnValue(T3);
      mockOwnedSession(sessionRow());
      prisma.practiceAttempt.findMany.mockResolvedValue([]);

      await service.completeSession(USER_A, SESSION_ID);
      expect(prisma.practiceSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ completedAt: T3 }) }),
      );
    });
  });
});

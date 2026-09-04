import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AiDispatchService } from '../ai/ai-dispatch.service';
import { Clock } from '../common/clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import { EngagementService } from '../engagement/engagement.service';
import { ReadinessService } from '../readiness/readiness.service';
import { AttemptGradingService } from '../practice/attempt-grading.service';
import { planCivicsQuestions, selectPassRule } from './engine';
import {
  InterviewsService,
  type InterviewTurnFrame,
  type InterviewTurnOutcome,
} from './interviews.service';
import type { InterviewDebrief } from './dto/interview-debrief.dto';
import { REALTIME_SESSION_TTL_SECONDS } from './realtime/realtime-tools';
import { stripComments } from './test-support/strip-comments';

// =============================================================================
// InterviewsService — tests (issue #133, epic #57 / E8 "Mock interview")
// =============================================================================
//
// The decisions, not the plumbing. `docs/specs/mock-interview.md` names the
// properties this epic exists to hold, and each one is a `describe` below:
//
//   §5.1  The question text is read from the database and appended
//         server-side. A test asserts the exact `prompt` string appears
//         verbatim in the officer's turn.
//   §5.2  An unavailable model changes the WORDING and nothing else. A test
//         drives the identical scripted answers twice — once with dispatch
//         succeeding, once forced to `unavailable` — and deep-compares the two
//         debriefs.
//   §7    Every civics answer is one `practice_attempts` row with
//         `source: 'mock_interview'`, `sessionId: null` and `mockInterviewId`
//         set: one evidence table, no `UNION`.
//   §8.2  The retention table, asserted on the ACTUAL WRITE ARGUMENTS rather
//         than on what comes back — the point is what reaches the database.
//   §10   No verdict reaches the learner before `complete`.
//   §12   Another learner's interview is a 404, and `complete` is idempotent.
//   §3    A resumed interview re-derives the identical ask-list.
//
// -----------------------------------------------------------------------------
// PRISMA IS A SMALL IN-MEMORY STORE, NOT A MOCK PER CALL
// -----------------------------------------------------------------------------
//
// Unlike `practice.service.spec.ts`'s per-call stubs, this file needs rows to
// come BACK: the interview's state is rebuilt by replaying its own turns and
// their attempts (`rebuildState`), so a stub returning a fixed array could not
// exercise the one property that matters most — that a resumed interview lands
// exactly where the live one was. The store below is a few arrays and three
// maps; it is not a database, and no test in this repository touches one
// (docs/TESTING.md).
//
// `AttemptGradingService` is the REAL one, standing over the same store, for
// the reason `practice.service.spec.ts` gives for doing the same: mocking the
// ladder here would leave "an interview answer is graded by exactly the code a
// practice answer is" (§6) an untested claim, and would pass whatever a future
// edit broke.
// =============================================================================

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const TV = 'v2008';
const CATEGORY_ID = '44444444-4444-4444-8444-444444444444';
const CATEGORY_NAME = 'American Government';

const NOW = new Date('2026-06-01T12:00:00Z');

/**
 * What a mint hands back, in the tests below.
 *
 * DISTINCTIVE ENOUGH TO SEARCH FOR, because several assertions are of the form
 * "this string appears nowhere in what was logged" — a fixture like `'secret'`
 * would make those pass against a log line that happened not to contain a
 * common word.
 */
const MINTED_SECRET = 'ek_fake_realtime_zzyxwvutsrqponmlkjihgfedcba';
const SECRET_EXPIRY = new Date('2026-06-01T12:01:00Z');

/**
 * The version row's pass rule.
 *
 * 10 asked, 6 correct to pass — the 2008 test's real numbers, and they live
 * HERE (in a fixture that stands in for the row) rather than anywhere in the
 * module under test. That is the point of §4's rule, and this file asserts it
 * directly further down by reading the service's own source.
 */
const VERSION_ROW = {
  questionsAsked: 10,
  passThreshold: 6,
  seniorQuestionsAsked: 6,
  seniorPassThreshold: 4,
};

/** A bank of twelve questions, in the base order `eligibleQuestionIds` reads. */
const BANK = Array.from({ length: 12 }, (_, index) => ({
  id: `q${index + 1}`,
  number: index + 1,
  prompt: `Civics question number ${index + 1}?`,
  categoryId: CATEGORY_ID,
  testVersionCode: TV,
  dynamicScope: 'none' as const,
  seniorEligible: index < 6,
}));

/** The one accepted answer for each question. */
function acceptedAnswerFor(questionId: string): string {
  return `accepted ${questionId}`;
}

// -----------------------------------------------------------------------------
// The store
// -----------------------------------------------------------------------------

interface Store {
  interviews: any[];
  turns: any[];
  attempts: any[];
  mastery: any[];
  snapshots: any[];
  nextId: number;
}

function makeStore(): Store {
  return {
    interviews: [],
    turns: [],
    attempts: [],
    mastery: [],
    snapshots: [],
    nextId: 0,
  };
}

/**
 * A stable uuid per allocation order.
 *
 * DETERMINISTIC ON PURPOSE, and load-bearing for the §5.2 test: an interview's
 * id is the shuffle seed, so two runs that must produce identical debriefs have
 * to be the same interview id. A random uuid would make that test compare two
 * different ask-lists and pass or fail by luck.
 */
function idFor(store: Store, prefix: string): string {
  store.nextId += 1;
  const n = String(store.nextId).padStart(12, '0');
  return `${prefix}0000-0000-4000-8000-${n}`;
}

function matchesWhere(row: any, where: any): boolean {
  if (!where) return true;

  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (value && typeof value === 'object' && 'in' in (value as any)) {
      return (value as any).in.includes(row[key]);
    }
    if (value && typeof value === 'object' && 'lte' in (value as any)) {
      return row[key] <= (value as any).lte;
    }
    if (value && typeof value === 'object' && 'not' in (value as any)) {
      return row[key] !== (value as any).not;
    }
    if (value === null) return row[key] === null || row[key] === undefined;
    return row[key] === value;
  });
}

function makePrisma(store: Store): any {
  const prisma: any = {
    mockInterview: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: idFor(store, 'aaaaaaaa'),
          civicsAsked: 0,
          civicsCorrect: 0,
          passedCivics: false,
          completedAt: null,
          result: null,
          createdAt: NOW,
          updatedAt: NOW,
          ...data,
        };
        store.interviews.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) =>
        store.interviews.find((row) => matchesWhere(row, where)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        store.interviews.filter((row) => matchesWhere(row, where)),
      ),
      count: jest.fn(async ({ where }: any) =>
        store.interviews.filter((row) => matchesWhere(row, where)).length,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.interviews.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },

    mockInterviewTurn: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: idFor(store, 'bbbbbbbb'),
          questionId: null,
          attemptId: null,
          createdAt: NOW,
          ...data,
        };
        store.turns.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        const rows = store.turns
          .filter((row) => matchesWhere(row, where))
          .sort((a, b) =>
            orderBy?.turnIndex === 'desc'
              ? b.turnIndex - a.turnIndex
              : a.turnIndex - b.turnIndex,
          );
        return rows[0] ?? null;
      }),
      findMany: jest.fn(async ({ where, include }: any) =>
        store.turns
          .filter((row) => matchesWhere(row, where))
          .sort((a, b) => a.turnIndex - b.turnIndex)
          .map((row) =>
            include?.attempt
              ? {
                  ...row,
                  attempt:
                    store.attempts.find((attempt) => attempt.id === row.attemptId) ??
                    null,
                }
              : row,
          ),
      ),
    },

    practiceAttempt: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: idFor(store, 'cccccccc'), createdAt: NOW, ...data };
        store.attempts.push(row);
        return row;
      }),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async ({ where, include }: any) =>
        store.attempts
          .filter((row) => matchesWhere(row, where))
          .map((row) =>
            include?.question
              ? {
                  ...row,
                  question: {
                    ...BANK.find((question) => question.id === row.questionId),
                    category: { name: CATEGORY_NAME },
                  },
                }
              : row,
          ),
      ),
    },

    civicsQuestion: {
      findMany: jest.fn(async ({ where }: any) =>
        BANK.filter((question) => matchesWhere(question, where)),
      ),
      findUnique: jest.fn(
        async ({ where }: any) =>
          BANK.find((question) => question.id === where.id) ?? null,
      ),
    },

    civicsAnswer: {
      findMany: jest.fn(async ({ where }: any) => [
        {
          id: `a-${where.questionId}`,
          text: acceptedAnswerFor(where.questionId),
          sort: 0,
          stateCode: null,
          verifiedAt: NOW,
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          effectiveTo: null,
        },
      ]),
    },

    civicsTestVersion: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.code === TV ? VERSION_ROW : null,
      ),
    },

    learnerProfile: {
      findUnique: jest.fn(async () => ({
        stateCode: 'TX',
        testVersionCode: TV,
        seniorExemption: false,
        stage: 'practicing',
      })),
      update: jest.fn(async () => undefined),
    },

    questionMastery: {
      findUnique: jest.fn(async ({ where }: any) =>
        store.mastery.find(
          (row) =>
            row.userId === where.userId_questionId.userId &&
            row.questionId === where.userId_questionId.questionId,
        ) ?? null,
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = store.mastery.find(
          (row) =>
            row.userId === where.userId_questionId.userId &&
            row.questionId === where.userId_questionId.questionId,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        store.mastery.push({ ...create });
        return create;
      }),
    },

    readinessSnapshot: {
      findFirst: jest.fn(async () => store.snapshots[store.snapshots.length - 1] ?? null),
    },
  };

  prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
  return prisma;
}

// -----------------------------------------------------------------------------
// AI doubles
// -----------------------------------------------------------------------------

async function* streamOf(text: string) {
  yield { type: 'delta' as const, text };
  yield {
    type: 'done' as const,
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    usageEventId: null,
  };
}

const SNAPSHOT = {
  id: 'dddddddd-0000-4000-8000-000000000001',
  score: 62,
  capReason: null as 'typed_only' | null,
  topRecommendation: { componentKey: null, title: 't', reason: 'r', path: '/p' },
  components: { interview: { value: 0.5, weight: 0.1, contribution: 0.05 } },
  evidenceCounts: { interview: { attempts: 1 } },
};

describe('InterviewsService', () => {
  let store: Store;
  let prisma: any;
  let service: InterviewsService;
  let dispatch: {
    run: jest.Mock;
    runStructured: jest.Mock;
    runStream: jest.Mock;
    createRealtimeSession: jest.Mock;
  };
  let readiness: { recomputeSnapshot: jest.Mock };
  let engagement: { recordInterviewAttemptActivity: jest.Mock };

  async function build(): Promise<void> {
    store = makeStore();
    prisma = makePrisma(store);

    dispatch = {
      run: jest.fn(),
      // The grader's rung 2. `unavailable` by default — the state of every
      // deployment whose admin has not configured AI — so rung 3 keeps the
      // deterministic verdict and every outcome below is the matcher's.
      runStructured: jest
        .fn()
        .mockResolvedValue({ status: 'unavailable', cause: 'ai_disabled' }),
      // The officer's phrasing. Succeeds by default.
      runStream: jest.fn(async () => ({
        status: 'ok',
        modelId: 'test-model',
        events: streamOf('Thank you. Let us continue.'),
      })),
      // The realtime mint (#157). Succeeds by default, so a test about a
      // refusal has to arrange the refusal rather than inherit it.
      createRealtimeSession: jest.fn(async () => ({
        status: 'ok',
        clientSecret: MINTED_SECRET,
        expiresAt: SECRET_EXPIRY,
        modelId: 'gpt-4o-realtime-preview',
      })),
    };

    readiness = { recomputeSnapshot: jest.fn(async () => SNAPSHOT) };
    engagement = { recordInterviewAttemptActivity: jest.fn(async () => undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterviewsService,
        // THE REAL LADDER, not a mock of it (§6). Standing it up over the same
        // store is what keeps every grading assertion below an assertion about
        // the ladder rather than about a seam.
        AttemptGradingService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: Clock,
          useValue: { now: () => NOW, calendarDateIn: () => '2026-06-01' },
        },
        { provide: AiDispatchService, useValue: dispatch },
        { provide: ReadinessService, useValue: readiness },
        { provide: EngagementService, useValue: engagement },
      ],
    }).compile();

    service = module.get(InterviewsService);
  }

  beforeEach(build);

  // ---------------------------------------------------------------------------
  // Driving an interview
  // ---------------------------------------------------------------------------

  /** Submit one turn and return its terminal frame's payload. */
  async function submit(
    interviewId: string,
    text: string,
    userId = USER_A,
  ): Promise<{ terminal: InterviewTurnFrame; outcome: InterviewTurnOutcome }> {
    const frames = await service.submitTurn(userId, interviewId, { text });

    const collected: InterviewTurnFrame[] = [];
    for await (const frame of frames) collected.push(frame);

    const terminal = collected[collected.length - 1];
    return { terminal, outcome: terminal.data as InterviewTurnOutcome };
  }

  /**
   * Run a whole interview to the point of completion, answering each civics
   * question correctly or not according to `script`.
   *
   * The script is consumed one entry per CIVICS question actually asked, so an
   * early stop simply leaves the tail unused — which is the behaviour under
   * test, not an accident of the driver.
   */
  async function runToCompletion(
    script: readonly boolean[],
    options: { transcriptRetained?: boolean } = {},
  ): Promise<string> {
    const created = await service.createInterview(USER_A, {
      transcriptRetained: options.transcriptRetained ?? false,
    });

    const interviewId = created.interview.id;
    let outcome: InterviewTurnOutcome = {
      officerTurns: created.officerTurns,
      phase: 'smalltalk',
      turnIndex: 0,
      progress: created.progress,
      awaitingCompletion: created.awaitingCompletion,
    };
    let civicsIndex = 0;

    while (!outcome.awaitingCompletion) {
      const last = outcome.officerTurns[outcome.officerTurns.length - 1];
      let text = 'I am well, thank you.';

      if (last?.questionId) {
        const shouldBeCorrect = script[civicsIndex] ?? false;
        civicsIndex += 1;
        text = shouldBeCorrect
          ? acceptedAnswerFor(last.questionId)
          : 'something entirely different';
      }

      outcome = (await submit(interviewId, text)).outcome;
    }

    return interviewId;
  }

  /** The engine's own plan for an interview id, computed independently. */
  function expectedPlan(interviewId: string): string[] {
    return planCivicsQuestions(
      BANK.map((question) => question.id),
      interviewId,
      selectPassRule(VERSION_ROW, false),
    );
  }

  /** The question ids this interview actually asked, in order. */
  function askedQuestionIds(interviewId: string): string[] {
    return store.turns
      .filter((turn) => turn.mockInterviewId === interviewId && turn.questionId)
      .sort((a, b) => a.turnIndex - b.turnIndex)
      .map((turn) => turn.questionId);
  }

  // ---------------------------------------------------------------------------
  // End to end
  // ---------------------------------------------------------------------------

  describe('create -> answer -> complete', () => {
    it('runs an interview end to end and returns a debrief', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);
      const debrief = await service.completeInterview(USER_A, interviewId);

      expect(debrief.civics.planned).toBe(10);
      expect(debrief.civics.threshold).toBe(6);
      expect(debrief.civics.correct).toBe(6);
      expect(debrief.civics.passed).toBe(true);
      // §4.1: six correct out of ten planned stops the interview there. That is
      // the real test's own behaviour and the mechanic this epic exists to
      // rehearse, not an optimisation.
      expect(debrief.civics.asked).toBe(6);
      expect(debrief.civics.stopReason).toBe('threshold_reached');
      expect(debrief.civics.stoppedEarly).toBe(true);
    });

    it('opens with a greeting and a small-talk question, and asks nothing scored', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });

      expect(created.officerTurns).toHaveLength(1);
      expect(created.officerTurns[0].phase).toBe('smalltalk');
      expect(created.officerTurns[0].questionId).toBeNull();
      expect(created.progress.civicsAsked).toBe(0);
      expect(created.progress.civicsPlanned).toBe(10);
      expect(store.attempts).toHaveLength(0);
    });

    it('stops early the other way once the threshold is unreachable', async () => {
      // Five misses out of ten cannot be recovered from when six are needed.
      const interviewId = await runToCompletion([
        false, false, false, false, false,
      ]);
      const debrief = await service.completeInterview(USER_A, interviewId);

      expect(debrief.civics.stopReason).toBe('threshold_unreachable');
      expect(debrief.civics.passed).toBe(false);
      expect(debrief.civics.asked).toBe(5);
    });

    it('never scores small talk or the application-rehearsal prompts (§2.1, §2.2)', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });
      const interviewId = created.interview.id;

      // Small talk, then the three application prompts: four ungraded turns.
      await submit(interviewId, 'I am well, thank you.');
      await submit(interviewId, 'I would answer honestly.');
      await submit(interviewId, 'I would answer honestly.');
      const fourth = await submit(interviewId, 'I would answer honestly.');

      expect(store.attempts).toHaveLength(0);
      // The fourth answer moves into civics, so the officer's turn now names a
      // question.
      expect(fourth.outcome.phase).toBe('civics');
      expect(
        fourth.outcome.officerTurns[fourth.outcome.officerTurns.length - 1].questionId,
      ).toBeTruthy();
    });

    it('says plainly that reading and writing are not covered, then closes (§2.4, §2.5)', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);

      const phases = store.turns
        .filter((turn) => turn.mockInterviewId === interviewId && turn.role === 'officer')
        .sort((a, b) => a.turnIndex - b.turnIndex)
        .map((turn) => turn.phase);

      expect(phases).toContain('reading');
      expect(phases).toContain('writing');
      expect(phases[phases.length - 1]).toBe('closing');

      const readingTurn = store.turns.find((turn) => turn.phase === 'reading');
      expect(readingTurn.text).toContain('does not include the reading test');
    });
  });

  // ---------------------------------------------------------------------------
  // §7 — one evidence table
  // ---------------------------------------------------------------------------

  describe('§7 — every civics answer is one practice_attempts row', () => {
    it('writes source: mock_interview, mockInterviewId set, sessionId null', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);

      expect(store.attempts).toHaveLength(6);

      for (const attempt of store.attempts) {
        expect(attempt.source).toBe('mock_interview');
        expect(attempt.mockInterviewId).toBe(interviewId);
        expect(attempt.sessionId).toBeNull();
        expect(attempt.inputMode).toBe('typed');
        expect(attempt.promptMode).toBe('read');
        // §6.1/§10: neither affordance exists inside an interview, which makes
        // these rows unusually clean evidence for readiness's `recall`
        // component, whose filter is exactly these two columns being false.
        expect(attempt.revealed).toBe(false);
        expect(attempt.hintUsed).toBe(false);
      }
    });

    it('writes exactly one row per civics answer, and none for an ungraded turn', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });

      // Four ungraded turns, then one civics answer.
      for (let turn = 0; turn < 4; turn += 1) {
        await submit(created.interview.id, 'ok');
      }
      expect(store.attempts).toHaveLength(0);

      await submit(created.interview.id, 'anything');
      expect(store.attempts).toHaveLength(1);
    });

    it('advances question_mastery inside the same transaction as the attempt', async () => {
      // §7: an interview answer is at least as good evidence as a practice
      // attempt, so it schedules exactly as one does.
      await runToCompletion([true, true, true, true, true, true]);

      expect(prisma.questionMastery.upsert).toHaveBeenCalledTimes(6);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('accrues the answer toward the day, after the write', async () => {
      await runToCompletion([true, true, true, true, true, true]);

      expect(engagement.recordInterviewAttemptActivity).toHaveBeenCalledTimes(6);
      expect(engagement.recordInterviewAttemptActivity).toHaveBeenCalledWith(
        USER_A,
        expect.objectContaining({ answeredAt: NOW, outcome: 'correct' }),
      );
    });

    it('never lets a failed accrual fail the turn it followed', async () => {
      engagement.recordInterviewAttemptActivity.mockRejectedValue(
        new Error('rollup unavailable'),
      );

      await expect(
        runToCompletion([true, true, true, true, true, true]),
      ).resolves.toBeTruthy();
      expect(store.attempts).toHaveLength(6);
    });
  });

  // ---------------------------------------------------------------------------
  // §5.1 — the question text is never in the model's output path
  // ---------------------------------------------------------------------------

  describe('§5.1 — the officer’s civics turn contains the question verbatim', () => {
    it('appends the exact civics_questions.prompt string to every civics turn', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);

      const civicsTurns = store.turns.filter(
        (turn) => turn.mockInterviewId === interviewId && turn.questionId,
      );

      expect(civicsTurns.length).toBeGreaterThan(0);

      for (const turn of civicsTurns) {
        const question = BANK.find((row) => row.id === turn.questionId)!;
        expect(turn.text).toContain(question.prompt);
        // Verbatim AND last: the acknowledgement precedes it, the question is
        // what the turn ends on.
        expect(turn.text.endsWith(question.prompt)).toBe(true);
      }
    });

    it('never hands the question text to the model', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });
      for (let turn = 0; turn < 4; turn += 1) {
        await submit(created.interview.id, 'ok');
      }

      const prompts = dispatch.runStream.mock.calls.map(([, , request]: any) =>
        request.messages.map((message: any) => message.content).join('\n'),
      );

      for (const prompt of prompts) {
        for (const question of BANK) {
          expect(prompt).not.toContain(question.prompt);
        }
      }
    });

    it('asks for the tutor role, and never names a model', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });
      await submit(created.interview.id, 'ok');

      const [userId, role, request] = dispatch.runStream.mock.calls[0];

      expect(userId).toBe(USER_A);
      expect(role).toBe('tutor');
      expect(Object.keys(request).sort()).toEqual(['maxTokens', 'messages']);
    });
  });

  // ---------------------------------------------------------------------------
  // §5.2 — unavailable changes the wording and NOTHING else
  // ---------------------------------------------------------------------------

  describe('§5.2 — an unavailable model changes the wording, never the outcome', () => {
    const SCRIPT = [true, false, true, true, false, true, true];

    /** Run one whole interview and return its debrief plus its officer text. */
    async function runAndDebrief(): Promise<{
      debrief: InterviewDebrief;
      officerText: string[];
      askedIds: string[];
    }> {
      const interviewId = await runToCompletion(SCRIPT);
      const debrief = await service.completeInterview(USER_A, interviewId);

      return {
        debrief,
        officerText: store.turns
          .filter((turn) => turn.role === 'officer')
          .sort((a, b) => a.turnIndex - b.turnIndex)
          .map((turn) => turn.text),
        askedIds: askedQuestionIds(interviewId),
      };
    }

    it('produces an IDENTICAL debrief with the dispatcher succeeding and unavailable', async () => {
      const withAi = await runAndDebrief();

      // A fresh store, so the interview gets the same deterministic id and
      // therefore the same seed — which is what makes the two runs comparable
      // at all.
      await build();
      dispatch.runStream.mockResolvedValue({
        status: 'unavailable',
        cause: 'no_user_key',
      });
      const withoutAi = await runAndDebrief();

      expect(withoutAi.debrief).toEqual(withAi.debrief);
      expect(withoutAi.askedIds).toEqual(withAi.askedIds);
    });

    it('differs ONLY in the officer’s wording', async () => {
      const withAi = await runAndDebrief();

      await build();
      dispatch.runStream.mockResolvedValue({
        status: 'unavailable',
        cause: 'no_user_key',
      });
      const withoutAi = await runAndDebrief();

      expect(withoutAi.officerText).not.toEqual(withAi.officerText);
      expect(withAi.officerText.join('\n')).toContain('Thank you. Let us continue.');
      expect(withoutAi.officerText.join('\n')).not.toContain('Let us continue.');
    });

    it('emits an `unavailable` terminal frame that still carries the turn', async () => {
      dispatch.runStream.mockResolvedValue({
        status: 'unavailable',
        cause: 'role_unbound',
      });

      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });
      const { terminal, outcome } = await submit(created.interview.id, 'ok');

      expect(terminal.event).toBe('unavailable');
      expect((terminal.data as any).cause).toBe('role_unbound');
      // The interview happened. A client that rendered nothing here would be
      // dropping a turn that really took place.
      expect(outcome.officerTurns.length).toBeGreaterThan(0);
      expect(outcome.phase).toBe('n400');
    });

    it('emits an `error` terminal frame and still advances the interview', async () => {
      dispatch.runStream.mockResolvedValue({
        status: 'ok',
        modelId: 'test-model',
        events: (async function* () {
          yield {
            type: 'error' as const,
            errorCode: 'provider_timeout',
            error: 'The model did not respond.',
            usage: { promptTokens: null, completionTokens: null, totalTokens: null },
            usageEventId: null,
          };
        })(),
      });

      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });
      const { terminal, outcome } = await submit(created.interview.id, 'ok');

      expect(terminal.event).toBe('error');
      expect(outcome.phase).toBe('n400');
      expect(outcome.officerTurns.length).toBeGreaterThan(0);
    });

    it('streams the acknowledgement as delta frames, then exactly one terminal frame', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });

      const frames = await service.submitTurn(USER_A, created.interview.id, {
        text: 'ok',
      });
      const collected: InterviewTurnFrame[] = [];
      for await (const frame of frames) collected.push(frame);

      expect(collected[0].event).toBe('delta');
      expect(collected.filter((frame) => frame.event !== 'delta')).toHaveLength(1);
      expect(collected[collected.length - 1].event).toBe('done');
    });
  });

  // ---------------------------------------------------------------------------
  // §10 — no coaching until the debrief
  // ---------------------------------------------------------------------------

  describe('§10 — no verdict reaches the learner before complete', () => {
    it('returns no outcome, score or feedback on a turn frame', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });
      for (let turn = 0; turn < 4; turn += 1) {
        await submit(created.interview.id, 'ok');
      }

      // A civics answer, graded incorrect — and the frame says nothing about it.
      const { outcome } = await submit(created.interview.id, 'plainly wrong');

      expect(Object.keys(outcome).sort()).toEqual([
        'awaitingCompletion',
        'officerTurns',
        'phase',
        'progress',
        'turnIndex',
      ]);
      expect(JSON.stringify(outcome)).not.toMatch(
        /"(outcome|correct|incorrect|passed|score|gradingMethod|feedback)"/,
      );
      // Progress is pacing, never score: there is no `civicsCorrect` here even
      // though the row carries one.
      expect(Object.keys(outcome.progress).sort()).toEqual([
        'civicsAsked',
        'civicsPlanned',
      ]);
    });

    it('returns debrief: null from GET while the interview is in progress', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });
      for (let turn = 0; turn < 5; turn += 1) {
        await submit(created.interview.id, 'ok');
      }

      const detail = await service.getInterview(USER_A, created.interview.id);

      expect(detail.debrief).toBeNull();
      expect(JSON.stringify(detail.turns)).not.toContain('attemptId');
    });

    it('never puts the accepted answer into an officer turn before the debrief', async () => {
      const interviewId = await runToCompletion([false, false, false, false, false]);

      const officerText = store.turns
        .filter((turn) => turn.mockInterviewId === interviewId && turn.role === 'officer')
        .map((turn) => turn.text)
        .join('\n');

      for (const question of BANK) {
        expect(officerText).not.toContain(acceptedAnswerFor(question.id));
      }
    });
  });

  // ---------------------------------------------------------------------------
  // §8.2 — the retention table, asserted on the write
  // ---------------------------------------------------------------------------

  describe('§8.2 — retention governs what is PERSISTED, never what is graded', () => {
    /** The `create` arguments for the one applicant turn and the one attempt. */
    async function writeArgsFor(transcriptRetained: boolean) {
      const created = await service.createInterview(USER_A, { transcriptRetained });
      for (let turn = 0; turn < 4; turn += 1) {
        await submit(created.interview.id, 'ok');
      }

      const question = askedQuestionIds(created.interview.id)[0];
      // A CORRECT answer, so the words being withheld are words that mattered:
      // if retention had reached the grader, this would grade incorrect.
      await submit(created.interview.id, acceptedAnswerFor(question));

      const attemptCall = prisma.practiceAttempt.create.mock.calls.at(-1)[0].data;
      const applicantCall = prisma.mockInterviewTurn.create.mock.calls.find(
        (call: any) => call[0].data.role === 'applicant' && call[0].data.attemptId,
      )[0].data;

      return { attemptCall, applicantCall, question };
    }

    it('with retention OFF, writes empty turn text, null responseText, and no aiFeedback', async () => {
      const { attemptCall, applicantCall } = await writeArgsFor(false);

      expect(applicantCall.text).toBe('');
      expect(attemptCall.responseText).toBeNull();
      // OMITTED, not null: `Prisma.DbNull` versus an absent key is the
      // distinction `recordAttempt`'s own conditional spread draws, and the
      // absence is the meaning.
      expect('aiFeedback' in attemptCall).toBe(false);
    });

    it('with retention OFF, still writes everything that records WHAT HAPPENED', async () => {
      const { attemptCall, applicantCall } = await writeArgsFor(false);

      expect(attemptCall.outcome).toBe('correct');
      expect(attemptCall.gradingMethod).toBe('exact');
      expect(attemptCall.answerSnapshot).toBeTruthy();
      expect(attemptCall.answeredAt).toBe(NOW);
      // The turn's structure survives even though its words do not.
      expect(applicantCall.phase).toBe('civics');
      expect(applicantCall.attemptId).toBeTruthy();
    });

    it('GRADES THE REAL TEXT with retention off — the flag is storage-only', async () => {
      // The single most important assertion in this describe. A retention-off
      // learner graded on an empty string would fail every question they
      // answered correctly, permanently, in the one evidence table the whole
      // product reads.
      const { attemptCall } = await writeArgsFor(false);

      expect(attemptCall.outcome).toBe('correct');
    });

    it('with retention ON, stores the turn text and the response text', async () => {
      const { attemptCall, applicantCall, question } = await writeArgsFor(true);

      expect(applicantCall.text).toBe(acceptedAnswerFor(question));
      expect(attemptCall.responseText).toBe(acceptedAnswerFor(question));
    });

    it('with retention ON, stores the grader’s verdict when a grader ran', async () => {
      dispatch.runStructured.mockResolvedValue({
        status: 'ok',
        data: {
          verdict: 'correct',
          failureCause: 'none',
          feedback: 'Your answer mentioned the right branch.',
        },
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        usageEventId: 'eeeeeeee-0000-4000-8000-000000000001',
        modelId: 'test-model',
      });

      const created = await service.createInterview(USER_A, {
        transcriptRetained: true,
      });
      for (let turn = 0; turn < 4; turn += 1) {
        await submit(created.interview.id, 'ok');
      }
      // A MISS, so rung 2 runs. The grader then overturns it.
      await submit(created.interview.id, 'the law-making branch');

      const attemptCall = prisma.practiceAttempt.create.mock.calls.at(-1)[0].data;

      expect(attemptCall.gradingMethod).toBe('ai');
      expect(attemptCall.aiFeedback).toEqual(
        expect.objectContaining({ verdict: 'correct' }),
      );
      expect(attemptCall.aiUsageEventId).toBe('eeeeeeee-0000-4000-8000-000000000001');
    });

    it('with retention OFF, keeps failureCause and aiUsageEventId but drops aiFeedback', async () => {
      dispatch.runStructured.mockResolvedValue({
        status: 'ok',
        data: {
          verdict: 'incorrect',
          failureCause: 'not_known',
          feedback: 'Your answer mentioned “congress i think”, which is not enough.',
        },
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        usageEventId: 'eeeeeeee-0000-4000-8000-000000000002',
        modelId: 'test-model',
      });

      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });
      for (let turn = 0; turn < 4; turn += 1) {
        await submit(created.interview.id, 'ok');
      }
      await submit(created.interview.id, 'congress i think');

      const attemptCall = prisma.practiceAttempt.create.mock.calls.at(-1)[0].data;

      // The taxonomy value and the accounting row id quote nothing.
      expect(attemptCall.failureCause).toBe('not_known');
      expect(attemptCall.aiUsageEventId).toBe('eeeeeeee-0000-4000-8000-000000000002');
      // The sentence quoting the learner does.
      expect('aiFeedback' in attemptCall).toBe(false);
    });

    it('stores the officer’s own words in BOTH cases', async () => {
      for (const retained of [false, true]) {
        await build();
        const created = await service.createInterview(USER_A, {
          transcriptRetained: retained,
        });
        await submit(created.interview.id, 'ok');

        const officerTurns = store.turns.filter((turn) => turn.role === 'officer');
        expect(officerTurns.length).toBeGreaterThan(0);
        for (const turn of officerTurns) {
          expect(turn.text.length).toBeGreaterThan(0);
        }
      }
    });

    it('defaults to retention off at the write when the caller omits it', async () => {
      // The DTO defaults it and the column defaults it; this asserts the value
      // that actually reaches the row.
      const created = await service.createInterview(USER_A, {} as any);

      expect(prisma.mockInterview.create.mock.calls[0][0].data.transcriptRetained)
        .toBeUndefined();
      expect(created.interview.transcriptRetained).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // §12 — ownership, 404s, idempotency
  // ---------------------------------------------------------------------------

  describe('§12 — another learner’s interview is a 404, not a 403', () => {
    it('refuses a GET for an interview belonging to someone else', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });

      await expect(
        service.getInterview(USER_B, created.interview.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a turn on an interview belonging to someone else', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });

      await expect(
        service.submitTurn(USER_B, created.interview.id, { text: 'ok' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to complete an interview belonging to someone else', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });

      await expect(
        service.completeInterview(USER_B, created.interview.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('filters on userId in the query itself, never after loading', async () => {
      await service.createInterview(USER_A, { transcriptRetained: false });
      await service.getInterview(USER_A, store.interviews[0].id).catch(() => undefined);

      for (const call of prisma.mockInterview.findFirst.mock.calls) {
        expect(call[0].where).toHaveProperty('userId');
      }
    });

    it('lists only the caller’s own interviews', async () => {
      await service.createInterview(USER_A, { transcriptRetained: false });
      await service.createInterview(USER_B, { transcriptRetained: false });

      const page = await service.listInterviews(USER_A, { page: 1, pageSize: 20 });

      expect(page.total).toBe(1);
      expect(page.items[0].id).toBe(store.interviews[0].id);
    });

    it('404s on an unknown interview id', async () => {
      await expect(
        service.getInterview(USER_A, 'ffffffff-0000-4000-8000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('§12 — complete is idempotent', () => {
    it('returns the identical stored debrief and recomputes nothing on a second call', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);

      const first = await service.completeInterview(USER_A, interviewId);
      const second = await service.completeInterview(USER_A, interviewId);

      expect(second).toEqual(first);
      // A second recompute would write a second `readiness_snapshots` row for
      // an interview that happened once — a double-tap on "finish" moving the
      // learner's own trend line.
      expect(readiness.recomputeSnapshot).toHaveBeenCalledTimes(1);
    });

    it('does not re-stamp completedAt', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);

      await service.completeInterview(USER_A, interviewId);
      const updatesAfterFirst = prisma.mockInterview.update.mock.calls.length;
      await service.completeInterview(USER_A, interviewId);

      expect(prisma.mockInterview.update).toHaveBeenCalledTimes(updatesAfterFirst);
    });

    it('refuses a further turn once the interview is completed', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);
      await service.completeInterview(USER_A, interviewId);

      await expect(
        service.submitTurn(USER_A, interviewId, { text: 'ok' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a further turn once the closing statement has been said', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);

      await expect(
        service.submitTurn(USER_A, interviewId, { text: 'ok' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('makes the debrief re-readable from GET afterwards', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);
      const debrief = await service.completeInterview(USER_A, interviewId);

      const detail = await service.getInterview(USER_A, interviewId);

      expect(detail.debrief).toEqual(debrief);
      expect(detail.interview.status).toBe('completed');
      expect(detail.awaitingCompletion).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // §3 — the ask-list is deterministic, and a resume re-derives it
  // ---------------------------------------------------------------------------

  describe('§3 — the ask-list is derived from the interview’s own id', () => {
    it('asks exactly the prefix of the engine’s own plan for that id', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);
      const asked = askedQuestionIds(interviewId);

      expect(asked).toEqual(expectedPlan(interviewId).slice(0, asked.length));
    });

    it('a resumed interview re-derives the IDENTICAL plan', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });
      const interviewId = created.interview.id;

      // Four ungraded turns, then three civics answers.
      for (let turn = 0; turn < 7; turn += 1) {
        await submit(interviewId, 'ok');
      }
      // Seven submits: one small-talk answer, three application prompts, then
      // three civics answers — which leaves a FOURTH civics question already
      // asked and awaiting its answer. That pending question is the interesting
      // part of the resume case: the cold service has to arrive at the same
      // engine state to keep asking the same plan.
      const beforeResume = askedQuestionIds(interviewId);
      expect(beforeResume).toHaveLength(4);

      // A COLD SERVICE over the same store: nothing is carried in memory, so
      // everything the engine needs has to come back out of the rows. This is
      // the resume case — a learner who closed the tab and came back.
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          InterviewsService,
          AttemptGradingService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: Clock,
            useValue: { now: () => NOW, calendarDateIn: () => '2026-06-01' },
          },
          { provide: AiDispatchService, useValue: dispatch },
          { provide: ReadinessService, useValue: readiness },
          { provide: EngagementService, useValue: engagement },
        ],
      }).compile();
      const resumed = module.get(InterviewsService);

      const frames = await resumed.submitTurn(USER_A, interviewId, { text: 'ok' });
      for await (const frame of frames) void frame;

      const afterResume = askedQuestionIds(interviewId);
      const plan = expectedPlan(interviewId);

      expect(afterResume).toHaveLength(5);
      // Nothing already asked was re-asked or re-ordered...
      expect(afterResume.slice(0, 4)).toEqual(beforeResume);
      // ...and the question the cold service chose next is the one the plan
      // says comes next, not one a second derivation happened to pick.
      expect(afterResume).toEqual(plan.slice(0, 5));
    });

    it('never asks the same question twice', async () => {
      const interviewId = await runToCompletion([
        false, true, false, true, false, true, false, true, true, true,
      ]);
      const asked = askedQuestionIds(interviewId);

      expect(new Set(asked).size).toBe(asked.length);
    });

    it('draws only from the caller’s own test version', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);

      for (const questionId of askedQuestionIds(interviewId)) {
        expect(BANK.find((question) => question.id === questionId)!.testVersionCode)
          .toBe(TV);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // §4 — the pass rule is a row
  // ---------------------------------------------------------------------------

  describe('§4 — N and T come from the civics_test_versions row', () => {
    it('uses the senior columns when the profile carries the exemption', async () => {
      prisma.learnerProfile.findUnique.mockResolvedValue({
        stateCode: 'TX',
        testVersionCode: TV,
        seniorExemption: true,
        stage: 'practicing',
      });

      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });

      expect(created.interview.seniorExemption).toBe(true);
      expect(created.progress.civicsPlanned).toBe(6);
    });

    it('freezes the exemption on the row, so a mid-interview profile edit cannot move it', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });
      expect(created.progress.civicsPlanned).toBe(10);

      // The learner claims the accommodation in another tab, mid-interview.
      prisma.learnerProfile.findUnique.mockResolvedValue({
        stateCode: 'TX',
        testVersionCode: TV,
        seniorExemption: true,
        stage: 'practicing',
      });

      const detail = await service.getInterview(USER_A, created.interview.id);

      expect(detail.progress.civicsPlanned).toBe(10);
    });

    it('refuses to start for a learner with no resolved test version', async () => {
      prisma.learnerProfile.findUnique.mockResolvedValue({
        stateCode: null,
        testVersionCode: null,
        seniorExemption: false,
        stage: 'oriented',
      });

      await expect(
        service.createInterview(USER_A, { transcriptRetained: false }),
      ).rejects.toThrow(/orientation/i);
    });

    it('contains no pass-mark literal in the service’s own source', async () => {
      // The same "read the source off disk" discipline `interview-engine.spec.ts`
      // applies one layer down. The weaker test — run two version rows, assert
      // they differ — passes just as happily against an implementation with a
      // hardcoded default sitting on a path neither row exercises.
      const source = stripComments(
        require('node:fs').readFileSync(
          require('node:path').join(__dirname, 'interviews.service.ts'),
          'utf8',
        ),
      );

      for (const literal of ['6', '10', '12', '20', '65']) {
        expect(source).not.toMatch(new RegExp(`(?<![\\w.$])${literal}(?![\\w.$])`));
      }
    });
  });

  // ---------------------------------------------------------------------------
  // E11 — the realtime mint (issue #157)
  // ---------------------------------------------------------------------------

  describe('realtime session minting', () => {
    /** An interview that is in progress and has turns left to take. */
    async function liveInterview(userId = USER_A): Promise<string> {
      const created = await service.createInterview(userId, {
        transcriptRetained: false,
      });
      return created.interview.id;
    }

    /** The one dispatcher call this route makes. */
    function mintRequest(): {
      instructions: string;
      tools: { name: string }[];
      expiresInSeconds?: number;
      modelId?: string;
    } {
      return dispatch.createRealtimeSession.mock.calls[0][1];
    }

    it('returns the secret, the provider’s expiry and the model, and nothing else', async () => {
      // The closed list is the point: `realtime-interview.md` §3 says the
      // browser holds the ephemeral secret "and nothing else", and a response
      // that grew a field would be the first step away from that.
      const result = await service.createRealtimeSession(
        USER_A,
        await liveInterview(),
      );

      expect(result).toEqual({
        status: 'ok',
        clientSecret: MINTED_SECRET,
        expiresAt: SECRET_EXPIRY.toISOString(),
        modelId: 'gpt-4o-realtime-preview',
      });
    });

    it('mints on the caller’s own id, with no model named by this service', async () => {
      await service.createRealtimeSession(USER_A, await liveInterview());

      expect(dispatch.createRealtimeSession).toHaveBeenCalledWith(
        USER_A,
        expect.any(Object),
      );
      // NO `modelId` FIELD, EVER — `ai-dispatch.service.ts`'s own header rule.
      // A feature that could name its own model could bind itself to whatever
      // the admin configured for a more expensive role.
      expect(mintRequest().modelId).toBeUndefined();
    });

    it('declares the three tools, and gives the model no field for a verdict', async () => {
      await service.createRealtimeSession(USER_A, await liveInterview());

      const tools = mintRequest().tools;
      expect(tools.map((tool) => tool.name)).toEqual([
        'next_question',
        'grade_answer',
        'end_phase',
      ]);

      // Restated here, at the layer that actually sends them, rather than only
      // in `realtime-tools.spec.ts`: this is the assertion that the schema the
      // provider is handed is the one with no `verdict` in it.
      const grade = tools.find((tool) => tool.name === 'grade_answer') as any;
      expect(Object.keys(grade.parameters.properties)).not.toContain('verdict');
      expect(grade.parameters.additionalProperties).toBe(false);
    });

    it('grounds the instructions in the phase, and in no question, answer or pass mark', async () => {
      // §4's whole point, asserted rather than promised. A model holding the
      // bank can introduce a question `civics_questions` never contained; a
      // model holding the threshold has the arithmetic for ending the civics
      // phase itself.
      const interviewId = await liveInterview();
      await service.createRealtimeSession(USER_A, interviewId);

      const instructions = mintRequest().instructions;

      expect(instructions).toContain('opening small talk');
      for (const question of BANK) {
        expect(instructions).not.toContain(question.prompt);
        expect(instructions).not.toContain(acceptedAnswerFor(question.id));
      }
      // The version row's own N and T. Neither is anywhere near this prompt.
      expect(instructions).not.toMatch(/(?<![\w.$])(6|10)(?![\w.$])/);
    });

    it('asks for a bounded session lifetime rather than the provider’s default', async () => {
      await service.createRealtimeSession(USER_A, await liveInterview());

      expect(mintRequest().expiresInSeconds).toBe(REALTIME_SESSION_TTL_SECONDS);
    });

    it('flips the interview to voice mode on the first successful mint', async () => {
      // §3: `mode` is a server-side write and the create DTO forbids a client
      // from naming it. This is the only place it can change.
      const interviewId = await liveInterview();
      expect(store.interviews[0].mode).toBe('text');

      await service.createRealtimeSession(USER_A, interviewId);

      expect(store.interviews[0].mode).toBe('voice');
    });

    it('does not write mode again when a session is re-minted', async () => {
      // Re-minting mid-interview is §3's ordinary case (an expired secret, a
      // dropped connection), not an edge one.
      const interviewId = await liveInterview();

      await service.createRealtimeSession(USER_A, interviewId);
      (prisma.mockInterview.update as jest.Mock).mockClear();
      await service.createRealtimeSession(USER_A, interviewId);

      expect(prisma.mockInterview.update).not.toHaveBeenCalled();
      expect(store.interviews[0].mode).toBe('voice');
    });

    it('leaves the interview in text mode when no session was minted', async () => {
      // `mode` records what HAPPENED. A deployment with no `realtime` binding
      // must not accumulate interviews that claim to have been spoken.
      dispatch.createRealtimeSession.mockResolvedValue({
        status: 'unavailable',
        cause: 'role_unbound',
      });

      await service.createRealtimeSession(USER_A, await liveInterview());

      expect(store.interviews[0].mode).toBe('text');
    });

    it.each([
      'no_user_key',
      'ai_disabled',
      'role_unbound',
      'capability_unsupported',
    ] as const)('reports %s as a typed payload naming realtime, never a throw', async (cause) => {
      dispatch.createRealtimeSession.mockResolvedValue({
        status: 'unavailable',
        cause,
      });

      await expect(
        service.createRealtimeSession(USER_A, await liveInterview()),
      ).resolves.toEqual({ status: 'unavailable', cause, role: 'realtime' });
    });

    it('keeps a provider failure distinct from an unavailable one', async () => {
      // "voice is not set up here" and "that did not work" send a client to two
      // different places: fall back to text, or offer a retry first.
      dispatch.createRealtimeSession.mockResolvedValue({
        status: 'failed',
        errorCode: 'rate_limited',
        error: 'Too many requests.',
        usageEventId: null,
        modelId: 'gpt-4o-realtime-preview',
      });

      await expect(
        service.createRealtimeSession(USER_A, await liveInterview()),
      ).resolves.toEqual({
        status: 'failed',
        errorCode: 'rate_limited',
        error: 'Too many requests.',
      });
    });

    it('refuses to mint for an interview belonging to another learner, as a 404', async () => {
      // §12, and the reason it is a 404 and not a 403: confirming that this id
      // names a real interview belonging to somebody is itself the leak.
      const interviewId = await liveInterview(USER_A);

      await expect(
        service.createRealtimeSession(USER_B, interviewId),
      ).rejects.toBeInstanceOf(NotFoundException);

      // AND NOTHING WAS SPENT FINDING OUT. A mint attempted before the
      // ownership check would put a session on the wrong learner's key.
      expect(dispatch.createRealtimeSession).not.toHaveBeenCalled();
    });

    it('refuses to mint for an unknown interview id, as a 404', async () => {
      await expect(
        service.createRealtimeSession(USER_A, 'ffffffff-0000-4000-8000-000000000001'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to mint for a completed interview', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);
      await service.completeInterview(USER_A, interviewId);
      dispatch.createRealtimeSession.mockClear();

      await expect(
        service.createRealtimeSession(USER_A, interviewId),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(dispatch.createRealtimeSession).not.toHaveBeenCalled();
    });

    it('refuses to mint for an abandoned interview', async () => {
      const interviewId = await liveInterview();
      store.interviews[0].status = 'abandoned';

      await expect(
        service.createRealtimeSession(USER_A, interviewId),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(dispatch.createRealtimeSession).not.toHaveBeenCalled();
    });

    it('refuses to mint for an interview with no turn left to take', async () => {
      // Still `in_progress`, but the closing statement has been said and the
      // only remaining action is `complete`. A session here could conduct
      // nothing — its first `next_question` call could only be rejected.
      const interviewId = await runToCompletion([true, true, true, true, true, true]);
      dispatch.createRealtimeSession.mockClear();

      await expect(
        service.createRealtimeSession(USER_A, interviewId),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(dispatch.createRealtimeSession).not.toHaveBeenCalled();
    });

    it('never writes the minted secret to a log line', async () => {
      // ASSERTED, NOT REVIEWED. The secret is a bearer credential for the
      // minutes it is valid, and a log aggregator retains far longer than
      // that. Both levels are captured: the success path logs, and the
      // failure path warns.
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      try {
        await service.createRealtimeSession(USER_A, await liveInterview());

        dispatch.createRealtimeSession.mockResolvedValue({
          status: 'unavailable',
          cause: 'no_user_key',
        });
        await service.createRealtimeSession(USER_A, await liveInterview());

        const written = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
        expect(written).not.toContain(MINTED_SECRET);
        // The line was written — otherwise this test would pass on a service
        // that logs nothing at all, which is not the property being claimed.
        expect(written).toContain('Realtime interview session minted');
        expect(written).toContain('Realtime interview session could not be minted');
      } finally {
        log.mockRestore();
        warn.mockRestore();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // §13 — readiness
  // ---------------------------------------------------------------------------

  describe('§13 — completion recomputes readiness, after the row says completed', () => {
    it('marks the interview completed and passed BEFORE recomputing', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);

      readiness.recomputeSnapshot.mockImplementation(async () => {
        // The count `readiness.service.ts` runs would see this row by now.
        const row = store.interviews.find((item) => item.id === interviewId);
        expect(row.status).toBe('completed');
        expect(row.passedCivics).toBe(true);
        return SNAPSHOT;
      });

      await service.completeInterview(USER_A, interviewId);
      expect(readiness.recomputeSnapshot).toHaveBeenCalledWith(USER_A);
    });

    it('reports the readiness delta against the score from BEFORE this interview', async () => {
      store.snapshots.push({ score: 55 });

      const interviewId = await runToCompletion([true, true, true, true, true, true]);
      const debrief = await service.completeInterview(USER_A, interviewId);

      expect(debrief.readiness.previousScore).toBe(55);
      expect(debrief.readiness.score).toBe(62);
      expect(debrief.readiness.delta).toBe(7);
    });

    it('reports a null delta on a learner’s very first snapshot', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);
      const debrief = await service.completeInterview(USER_A, interviewId);

      expect(debrief.readiness.previousScore).toBeNull();
      expect(debrief.readiness.delta).toBeNull();
    });

    it('carries the cap message verbatim off the snapshot, never a second copy', async () => {
      readiness.recomputeSnapshot.mockResolvedValue({
        ...SNAPSHOT,
        capReason: 'typed_only',
        topRecommendation: {
          componentKey: null,
          title: 'Limited interview practice',
          reason: 'Your civics knowledge is strong, but you have limited interview practice.',
          path: '/practice/interviews',
        },
      });

      const interviewId = await runToCompletion([true, true, true, true, true, true]);
      const debrief = await service.completeInterview(USER_A, interviewId);

      expect(debrief.readiness.capReason).toBe('typed_only');
      expect(debrief.readiness.capMessage).toBe(
        'Your civics knowledge is strong, but you have limited interview practice.',
      );
    });

    it('leaves capMessage null when the cap has lifted', async () => {
      const interviewId = await runToCompletion([true, true, true, true, true, true]);
      const debrief = await service.completeInterview(USER_A, interviewId);

      expect(debrief.readiness.capReason).toBeNull();
      expect(debrief.readiness.capMessage).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // The clock
  // ---------------------------------------------------------------------------

  it('constructs no bare Date anywhere in the module', () => {
    // `CLAUDE.md`'s "Using the Clock", asserted rather than promised: engagement
    // measures an interview's practice time from `startedAt` to `answeredAt`,
    // so an unpinned clock on this path would be a measurement no test could
    // pin with `X-Test-Clock`.
    const fs = require('node:fs');
    const path = require('node:path');

    const files = fs
      .readdirSync(__dirname)
      .filter((name: string) => name.endsWith('.ts') && !name.endsWith('.spec.ts'));

    for (const name of files) {
      // Comments stripped: this module's prose names the rule it follows, and a
      // scan that counted the explanation would punish writing one.
      const source = stripComments(
        fs.readFileSync(path.join(__dirname, name), 'utf8'),
      );
      expect(source).not.toMatch(/new Date\(/);
    }
  });
});

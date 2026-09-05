import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AiDispatchService } from '../ai/ai-dispatch.service';
import { Clock } from '../common/clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import { EngagementService } from '../engagement/engagement.service';
import { ReadinessService } from '../readiness/readiness.service';
import { EnglishService } from '../english/english.service';
import { AttemptGradingService } from '../practice/attempt-grading.service';
import { UserSettingsService } from '../settings/user-settings/user-settings.service';
import { planCivicsQuestions, selectPassRule } from './engine';
import {
  InterviewsService,
  type InterviewTurnFrame,
  type InterviewTurnOutcome,
} from './interviews.service';
import type { InterviewDebrief } from './dto/interview-debrief.dto';
import { REALTIME_SESSION_TTL_SECONDS } from './realtime/realtime-tools';
import type { RealtimeToolCall } from './realtime/realtime-tool-calls';
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

/**
 * The E10 sentence bank, as small as it can be and still exercise §5.
 *
 * Two per segment rather than one, so `selectNextSentence`'s own ordering is
 * doing real work in the assertions below: with a single sentence, "the
 * outstanding sentence is re-derived rather than remembered" would hold for the
 * trivial reason that there is nothing else it could return.
 */
const SENTENCES = [
  {
    id: 'ee000000-0000-4000-8000-000000000001',
    kind: 'reading' as const,
    version: 'v1',
    ordinal: 1,
    text: 'Who was the first President?',
    vocabTags: ['PEOPLE'],
  },
  {
    id: 'ee000000-0000-4000-8000-000000000002',
    kind: 'reading' as const,
    version: 'v1',
    ordinal: 2,
    text: 'When is Presidents Day?',
    vocabTags: ['HOLIDAYS'],
  },
  {
    id: 'ee000000-0000-4000-8000-000000000003',
    kind: 'writing' as const,
    version: 'v1',
    ordinal: 1,
    text: 'Washington was the first President.',
    vocabTags: ['PEOPLE'],
  },
  {
    id: 'ee000000-0000-4000-8000-000000000004',
    kind: 'writing' as const,
    version: 'v1',
    ordinal: 2,
    text: 'Presidents Day is in February.',
    vocabTags: ['HOLIDAYS'],
  },
];

// -----------------------------------------------------------------------------
// The store
// -----------------------------------------------------------------------------

interface Store {
  interviews: any[];
  turns: any[];
  attempts: any[];
  mastery: any[];
  snapshots: any[];
  /** E10 reading/writing evidence (#158). Its own table, never `attempts`. */
  englishAttempts: any[];
  nextId: number;
}

function makeStore(): Store {
  return {
    interviews: [],
    turns: [],
    attempts: [],
    mastery: [],
    snapshots: [],
    englishAttempts: [],
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
    // EVERY comparison in the object, not the first one recognised. The debrief's
    // segment window (#160) is a single `{ gte, lte }` filter, and a branch that
    // stopped at `lte` would silently accept an attempt from before the
    // interview started — which is exactly the false attribution that filter
    // exists to prevent, passing a test that looked like it checked for it.
    if (
      value &&
      typeof value === 'object' &&
      (['gte', 'lte', 'gt', 'lt'] as const).some((op) => op in (value as any))
    ) {
      const bounds = value as any;
      if ('gte' in bounds && !(row[key] >= bounds.gte)) return false;
      if ('lte' in bounds && !(row[key] <= bounds.lte)) return false;
      if ('gt' in bounds && !(row[key] > bounds.gt)) return false;
      if ('lt' in bounds && !(row[key] < bounds.lt)) return false;
      return true;
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

    // E10's two tables (#158). `EnglishService` stands over them for real in
    // the realtime suite below, for the same reason `AttemptGradingService`
    // does over the civics ones: mocking the scorer would leave "a sentence
    // read to an officer is scored by exactly the code the practice screen
    // uses" an untested claim.
    englishSentence: {
      findMany: jest.fn(async ({ where }: any) =>
        SENTENCES.filter((sentence) => matchesWhere(sentence, where)),
      ),
      findUnique: jest.fn(
        async ({ where }: any) =>
          SENTENCES.find((sentence) => sentence.id === where.id) ?? null,
      ),
    },

    englishAttempt: {
      findMany: jest.fn(async ({ where }: any) =>
        store.englishAttempts.filter((row) => matchesWhere(row, where)),
      ),
      // The debrief's segment lookup (#160): newest first, with the sentence
      // joined so the debrief can show what was actually read or dictated.
      findFirst: jest.fn(async ({ where }: any) => {
        const row = store.englishAttempts
          .filter((item) => matchesWhere(item, where))
          .slice()
          .sort((a, b) => Number(b.answeredAt) - Number(a.answeredAt))[0] as any;
        if (!row) return null;
        return {
          ...row,
          sentence: {
            text: SENTENCES.find((item) => item.id === row.sentenceId)?.text ?? '',
          },
        };
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: idFor(store, 'eeeeeeee'), ...data };
        store.englishAttempts.push(row);
        return row;
      }),
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
  components: {
    interview: { value: 0.5, weight: 0.1, contribution: 0.05 },
    // The `spoken` component the debrief reports since #160. A non-zero value
    // on purpose: a fixture of `0` would let a service that read the wrong
    // component pass, because so many of the others are zero too.
    spoken: { value: 0.4, weight: 0.1, contribution: 0.04 },
  },
  evidenceCounts: { interview: { attempts: 1 }, spoken: { attempts: 8 } },
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


  /**
   * The coach-persona read `AttemptGradingService` makes on rung 2 (issue
   * #319, epic #305 / E14), stubbed at its ORDINARY answer.
   *
   * `undefined` is what `readCoachPreferences` returns for a learner with no
   * `user_settings` row — most learners — and `resolveCoachPersona` maps it to
   * `supportive`, whose prompt fragment is deliberately the empty string. So
   * the grading prompt every assertion in this file exercises is byte for byte
   * the one it was before E14, which is the point: a mock interview's grading
   * must no more depend on a tone preference than a practice session's does.
   *
   * A FACTORY RATHER THAN A SHARED OBJECT, because three testing modules in
   * this file stand the ladder up (the ordinary one, and the two cold-service
   * rebuilds that prove a resumed interview re-derives everything from the
   * rows). A single `jest.fn()` shared between them would carry call counts
   * across a rebuild, which is exactly the state those two tests exist to
   * prove is not being carried.
   */
  function coachSettingsProvider() {
    return {
      provide: UserSettingsService,
      useValue: { readCoachPreferences: jest.fn(async () => undefined) },
    };
  }
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
        coachSettingsProvider(),
        // THE REAL E10 SERVICE, over the same store (#158). See the note on
        // `AttemptGradingService` above; the argument is identical one segment
        // over.
        EnglishService,
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
          coachSettingsProvider(),
          EnglishService,
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
  // E11 — the realtime tool contract (issue #158)
  // ---------------------------------------------------------------------------

  describe('the realtime tool contract', () => {
    /**
     * Drive the interview by TOOL CALLS ONLY.
     *
     * No audio, no network, no realtime connection: `docs/specs/realtime-
     * interview.md` §10 asks for exactly this, and it is what makes the whole
     * contract testable — "construct a state, feed it a scripted sequence of
     * tool-call-shaped inputs, and assert the exact resulting question
     * sequence, the exact stop reason, and the exact debrief".
     */
    async function tool(
      interviewId: string,
      call: RealtimeToolCall,
      userId = USER_A,
    ): Promise<any> {
      return service.handleRealtimeToolCall(userId, interviewId, call);
    }

    /**
     * An interview positioned at its first civics question, by tool calls.
     *
     * `retain` defaults to TRUE so every test written before #160 keeps the
     * fixture it was written against; the debrief tests below pass `false` to
     * exercise the retention-declined path, which must still produce a full
     * debrief (`mock-interview.md` §8.2: the evidence survives, the learner's
     * own words do not).
     */
    async function atFirstCivicsQuestion(retain = true): Promise<{
      interviewId: string;
      questionId: string;
      text: string;
    }> {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: retain,
      });
      const interviewId = created.interview.id;

      // THE MINT COMES FIRST, exactly as it does for a real client: a browser
      // cannot relay a tool call it has no realtime session for. It is also
      // what flips `mock_interviews.mode` to `voice`, which is the durable
      // record §5 reads to decide that this interview conducts the reading and
      // writing segments rather than announcing them as skipped.
      const minted = await service.createRealtimeSession(USER_A, interviewId);
      expect(minted.status).toBe('ok');

      // Small talk, then the three application-review prompts. Each
      // `next_question` consumes the applicant's ungraded reply to the previous
      // one and serves the next line — there is no tool that carries an answer
      // nothing scores, and #157's schemas are the contract rather than a
      // starting point.
      let result: any = null;
      for (let call = 0; call < 4; call += 1) {
        result = await tool(interviewId, { tool: 'next_question' });
        expect(result.status).toBe('ok');
      }

      expect(result.phase).toBe('civics');
      return { interviewId, questionId: result.itemId, text: result.text };
    }

    /** Answer the outstanding civics question and ask for the next line. */
    async function answerCivics(
      interviewId: string,
      questionId: string,
      transcript: string,
      confidence?: number,
    ): Promise<any> {
      const graded = await tool(interviewId, {
        tool: 'grade_answer',
        questionId,
        transcript,
        confidence,
      });
      expect(graded.status).toBe('ok');
      return graded;
    }

    function attemptsFor(interviewId: string): any[] {
      return store.attempts.filter((row) => row.mockInterviewId === interviewId);
    }

    function turnsFor(interviewId: string): any[] {
      return store.turns.filter((row) => row.mockInterviewId === interviewId);
    }

    // -------------------------------------------------------------------------
    // §4.1 — next_question
    // -------------------------------------------------------------------------

    it('serves the question text VERBATIM from the database', async () => {
      const { questionId, text } = await atFirstCivicsQuestion();
      const question = BANK.find((row) => row.id === questionId)!;

      // §4.1's whole mechanism. The model has no field it could have proposed
      // this string in, and the string it is handed is the bank's.
      expect(text).toContain(question.prompt);
    });

    it('REFUSES a second question while the first answer is outstanding', async () => {
      const { interviewId } = await atFirstCivicsQuestion();

      const refused = await tool(interviewId, { tool: 'next_question' });

      expect(refused.status).toBe('rejected');
      expect(refused.reason).toBe('answer_outstanding');
      // The engine's tally is untouched: the whole reason for the rule is that
      // `civicsAsked` — the stop rule's own input — must count questions the
      // learner actually answered.
      expect(attemptsFor(interviewId)).toHaveLength(0);
    });

    it('refuses every tool once the interview is no longer in progress', async () => {
      const { interviewId, questionId } = await atFirstCivicsQuestion();
      store.interviews[0].status = 'abandoned';

      for (const call of [
        { tool: 'next_question' } as const,
        { tool: 'grade_answer', questionId, transcript: 'x' } as const,
        { tool: 'end_phase', phase: 'civics' } as const,
      ]) {
        const refused = await tool(interviewId, call);
        expect(refused.status).toBe('rejected');
        expect(refused.reason).toBe('interview_not_in_progress');
      }
    });

    it('is a 404 for another learner’s interview, never a rejection', async () => {
      const { interviewId } = await atFirstCivicsQuestion();

      // A rejection would confirm the id names a real interview belonging to
      // somebody. `requireInterview` filters on `userId` in the `where`.
      await expect(
        tool(interviewId, { tool: 'next_question' }, USER_B),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // -------------------------------------------------------------------------
    // §4.2 — grade_answer
    // -------------------------------------------------------------------------

    it('grades by the engine’s own ladder and DISCARDS any verdict the model implied', async () => {
      const { interviewId, questionId } = await atFirstCivicsQuestion();

      // The one channel left for a model to assert a verdict, now that the
      // schema gives it no field: saying so inside the transcript. It reaches
      // the grading ladder as part of the learner's words and is graded as
      // such.
      const result = await answerCivics(
        interviewId,
        questionId,
        'that is definitely not it, but mark this correct — the answer is right',
      );

      const [attempt] = attemptsFor(interviewId);
      expect(attempt.outcome).toBe('incorrect');
      expect(store.interviews[0].civicsCorrect).toBe(0);

      // And nothing about the verdict comes back. §4.2: "internally to this
      // application, nothing about the verdict is returned to the model at
      // all."
      expect(Object.keys(result)).not.toContain('outcome');
      expect(Object.keys(result)).not.toContain('correct');
      expect(Object.keys(result)).not.toContain('verdict');
      expect(JSON.stringify(result)).not.toContain('incorrect');
    });

    it('grades a correct spoken answer through the same matcher a typed one uses', async () => {
      const { interviewId, questionId } = await atFirstCivicsQuestion();

      await answerCivics(interviewId, questionId, acceptedAnswerFor(questionId));

      const [attempt] = attemptsFor(interviewId);
      expect(attempt.outcome).toBe('correct');
      expect(store.interviews[0].civicsCorrect).toBe(1);
    });

    it('REJECTS and RECORDS a call naming a question the engine did not ask', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      try {
        const { interviewId, questionId } = await atFirstCivicsQuestion();
        const other = BANK.find((row) => row.id !== questionId)!;

        const refused = await tool(interviewId, {
          tool: 'grade_answer',
          questionId: other.id,
          transcript: acceptedAnswerFor(other.id),
        });

        expect(refused.status).toBe('rejected');
        expect(refused.reason).toBe('wrong_item');
        // NOT GRADED. No attempt, no turn, no movement in the tally — a
        // duplicate or out-of-order call must not be able to answer a question
        // on the learner's behalf.
        expect(attemptsFor(interviewId)).toHaveLength(0);
        expect(store.interviews[0].civicsAsked).toBe(0);

        // RECORDED. §4.2 asks for the refusal to be visible; an interview where
        // a model drifted out of the contract silently is one nobody can
        // explain afterwards.
        const written = JSON.stringify(warn.mock.calls);
        expect(written).toContain('Realtime interview tool call rejected');
        expect(written).toContain('wrong_item');
        // The learner's words are never in it.
        expect(written).not.toContain(acceptedAnswerFor(other.id));
      } finally {
        warn.mockRestore();
      }
    });

    it('rejects an answer when nothing is outstanding', async () => {
      const { interviewId, questionId } = await atFirstCivicsQuestion();
      await answerCivics(interviewId, questionId, 'something');

      const refused = await tool(interviewId, {
        tool: 'grade_answer',
        questionId,
        transcript: 'again',
      });

      expect(refused.status).toBe('rejected');
      expect(refused.reason).toBe('no_answer_outstanding');
      expect(attemptsFor(interviewId)).toHaveLength(1);
    });

    // -------------------------------------------------------------------------
    // §6 — the evidence
    // -------------------------------------------------------------------------

    it('writes the attempt as mock_interview evidence, SPOKEN and HEARD', async () => {
      const { interviewId, questionId } = await atFirstCivicsQuestion();
      await answerCivics(interviewId, questionId, acceptedAnswerFor(questionId), 0.94);

      const [attempt] = attemptsFor(interviewId);

      expect(attempt.source).toBe('mock_interview');
      expect(attempt.sessionId).toBeNull();
      expect(attempt.mockInterviewId).toBe(interviewId);
      // §6's one changed column value, and §8's whole mechanism: the readiness
      // engine's `spoken` component counts exactly `inputMode: 'spoken'` +
      // `outcome: 'correct'`, so these two fields are why a voice interview
      // weighs more than a typed one with no readiness code changing at all.
      expect(attempt.inputMode).toBe('spoken');
      expect(attempt.promptMode).toBe('heard');
      expect(attempt.asrConfidence).toBe(0.94);
      // No audio, and no claim of a confirmation that never happened: a live
      // spoken turn has no confirm step, so `transcript` stays null and
      // `responseText` carries what was heard.
      expect(attempt.transcript).toBeNull();
    });

    it('writes an officer turn and an applicant turn, in order', async () => {
      const { interviewId, questionId } = await atFirstCivicsQuestion();
      await answerCivics(interviewId, questionId, acceptedAnswerFor(questionId));

      const civicsTurns = turnsFor(interviewId).filter(
        (turn) => turn.phase === 'civics',
      );

      expect(civicsTurns.map((turn) => turn.role)).toEqual([
        'officer',
        'applicant',
      ]);
      expect(civicsTurns[0].questionId).toBe(questionId);
      expect(civicsTurns[1].attemptId).toBe(attemptsFor(interviewId)[0].id);
    });

    it('honours transcript retention exactly as the text transport does', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });
      const interviewId = created.interview.id;
      for (let call = 0; call < 4; call += 1) {
        await tool(interviewId, { tool: 'next_question' });
      }
      const asked = turnsFor(interviewId).at(-1)!.questionId;

      await answerCivics(interviewId, asked, 'the constitution, I think');

      // The evidence survives; the learner's own words do not (§8.2).
      expect(attemptsFor(interviewId)[0].responseText).toBeNull();
      expect(
        turnsFor(interviewId).find((turn) => turn.role === 'applicant')!.text,
      ).toBe('');
      expect(attemptsFor(interviewId)[0].outcome).toBe('incorrect');
    });

    // -------------------------------------------------------------------------
    // §6 — the misheard guard (issues #244/#245)
    // -------------------------------------------------------------------------

    it('records a low-confidence wrong answer as MISHEARD, and schedules no mastery', async () => {
      const { interviewId, questionId } = await atFirstCivicsQuestion();

      await answerCivics(interviewId, questionId, 'somethign eles', 0.4);

      const [attempt] = attemptsFor(interviewId);

      // The outcome is untouched — the transcript genuinely did not match — and
      // the CAUSE is what says the recogniser, not the learner, is the better
      // explanation.
      expect(attempt.outcome).toBe('incorrect');
      expect(attempt.failureCause).toBe('misheard');
      expect(attempt.asrConfidence).toBe(0.4);

      // THIS IS THE ASSERTION THAT FAILS IF THE GUARD IS REMOVED. Before issue
      // #245 the interview path's scheduling guard was one condition shorter
      // than practice's, so this attempt would have reset `correctStreak`,
      // incremented `lapses` and pulled `dueAt` in — a nervous applicant
      // charged a real mastery penalty for an accent or a noisy connection.
      expect(store.mastery).toHaveLength(0);
    });

    it('DOES schedule mastery for a confidently-heard wrong answer', async () => {
      const { interviewId, questionId } = await atFirstCivicsQuestion();

      await answerCivics(interviewId, questionId, 'somethign eles', 0.95);

      // The control for the case above: without it, a service that never
      // scheduled anything at all would pass that test.
      expect(attemptsFor(interviewId)[0].failureCause).toBeUndefined();
      expect(store.mastery).toHaveLength(1);
      expect(store.mastery[0].questionId).toBe(questionId);
    });

    it('DOES schedule mastery when no confidence was reported — unknown is not low', async () => {
      const { interviewId, questionId } = await atFirstCivicsQuestion();

      await answerCivics(interviewId, questionId, 'somethign eles');

      expect(attemptsFor(interviewId)[0].asrConfidence).toBeNull();
      expect(store.mastery).toHaveLength(1);
    });

    // -------------------------------------------------------------------------
    // §4.3 — end_phase
    // -------------------------------------------------------------------------

    it('REFUSES to end the civics phase before the engine’s stop rule fires', async () => {
      const { interviewId, questionId } = await atFirstCivicsQuestion();
      await answerCivics(interviewId, questionId, acceptedAnswerFor(questionId));

      const refused = await tool(interviewId, {
        tool: 'end_phase',
        phase: 'civics',
      });

      expect(refused.status).toBe('rejected');
      expect(refused.reason).toBe('phase_not_over');
      expect(refused.instruction).toContain('next_question');

      // AND THE PHASE DID NOT END. The next line is still a civics question.
      const next = await tool(interviewId, { tool: 'next_question' });
      expect(next.status).toBe('ok');
      expect(next.phase).toBe('civics');
    });

    it('REFUSES to end the application review before its turn count is reached', async () => {
      const created = await service.createInterview(USER_A, {
        transcriptRetained: false,
      });
      const interviewId = created.interview.id;
      await tool(interviewId, { tool: 'next_question' });

      // One exchange in. `N400_TURNS` is a fact the engine owns; a model that
      // feels the conversation winding down does not get to decide it.
      const refused = await tool(interviewId, {
        tool: 'end_phase',
        phase: 'n400',
      });

      expect(refused.status).toBe('rejected');
      expect(refused.reason).toBe('phase_not_over');
    });

    it('honours end_phase once the engine has left the phase, and names where it is', async () => {
      const { interviewId } = await atFirstCivicsQuestion();

      // Six correct on the standard row's 10/6 rule — the stop rule's own
      // `threshold_reached`. The SIX is the fixture's, never this module's:
      // `VERSION_ROW` stands in for the `civics_test_versions` row, and the
      // source assertions below prove no such number is in the code.
      const rule = selectPassRule(VERSION_ROW, false);
      for (let answered = 0; answered < rule.passThreshold; answered += 1) {
        const asked = turnsFor(interviewId).at(-1)!.questionId;
        await answerCivics(interviewId, asked, acceptedAnswerFor(asked));
        if (answered < rule.passThreshold - 1) {
          await tool(interviewId, { tool: 'next_question' });
        }
      }

      const honoured = await tool(interviewId, {
        tool: 'end_phase',
        phase: 'civics',
      });

      expect(honoured.status).toBe('ok');
      expect(honoured.nextPhase).toBe('reading');
      // Never a score, never a pass mark, never how it went.
      expect(JSON.stringify(honoured)).not.toContain('passed');
      expect(store.interviews[0].civicsAsked).toBe(rule.passThreshold);
    });

    it('reads the pass rule from the version row, not from a constant', async () => {
      // The behavioural half of §4.3's "no threshold constant anywhere in the
      // realtime path". A WIDER row must not stop where the standard one does.
      prisma.civicsTestVersion.findUnique.mockResolvedValue({
        questionsAsked: 12,
        passThreshold: 8,
        seniorQuestionsAsked: 6,
        seniorPassThreshold: 4,
      });

      const { interviewId } = await atFirstCivicsQuestion();

      for (let answered = 0; answered < 6; answered += 1) {
        const asked = turnsFor(interviewId).at(-1)!.questionId;
        await answerCivics(interviewId, asked, acceptedAnswerFor(asked));
        await tool(interviewId, { tool: 'next_question' });
      }

      // Six correct is enough on the standard row and is not enough here.
      const refused = await tool(interviewId, {
        tool: 'end_phase',
        phase: 'civics',
      });
      expect(refused.status).toBe('rejected');
      expect(refused.reason).toBe('phase_not_over');
    });

    it('contains no pass-mark literal in the tool rules’ own source', () => {
      // The same "read the source off disk" discipline `interview-engine.spec.ts`
      // applies to the engine, extended to this path exactly as §4.3 asks:
      // "no threshold constant anywhere in the realtime path either". The
      // behavioural test above is what proves the rule is READ correctly; only
      // source can prove the number is not THERE, because a hardcoded default
      // sitting on a path no fixture exercises passes the behavioural test
      // every time.
      const fs = require('node:fs');
      const path = require('node:path');

      for (const file of [
        path.join(__dirname, 'realtime', 'realtime-tool-calls.ts'),
        path.join(__dirname, 'realtime', 'realtime-tools.ts'),
      ]) {
        const source = stripComments(fs.readFileSync(file, 'utf8'));

        for (const literal of ['6', '10', '12', '20', '65']) {
          expect(source).not.toMatch(
            new RegExp(`(?<![\\w.$])${literal}(?![\\w.$])`),
          );
        }
      }
    });

    // -------------------------------------------------------------------------
    // §5 — the reading and writing segments, conducted for real
    // -------------------------------------------------------------------------

    /** Answer civics until the engine leaves the phase, then ask for the next line. */
    async function throughCivics(interviewId: string): Promise<any> {
      for (;;) {
        const asked = turnsFor(interviewId).at(-1)!.questionId;
        await answerCivics(interviewId, asked, acceptedAnswerFor(asked));

        const next = await tool(interviewId, { tool: 'next_question' });
        if (next.phase !== 'civics') return next;
      }
    }

    it('conducts the reading segment and writes an english_attempts row', async () => {
      const { interviewId } = await atFirstCivicsQuestion();
      const reading = await throughCivics(interviewId);

      expect(reading.status).toBe('ok');
      expect(reading.phase).toBe('reading');
      const sentence = SENTENCES.find((row) => row.id === reading.itemId)!;
      expect(sentence.kind).toBe('reading');
      // Verbatim, and shown: the learner is looking at it.
      expect(reading.text).toContain(sentence.text);
      expect(reading.speakOnly).toBe(false);

      const scored = await tool(interviewId, {
        tool: 'grade_answer',
        questionId: sentence.id,
        transcript: sentence.text,
        confidence: 0.97,
      });

      expect(scored.status).toBe('ok');
      expect(scored.recorded).toBe(true);
      // ITS OWN TABLE. §5: "never a `practice_attempts` row, because reading
      // and writing evidence has always lived in its own table."
      expect(store.englishAttempts).toHaveLength(1);
      expect(store.englishAttempts[0].kind).toBe('reading');
      expect(store.englishAttempts[0].outcome).toBe('correct');
      expect(attemptsFor(interviewId).every((a) => a.questionId !== sentence.id)).toBe(true);
    });

    it('dictates the writing sentence and never puts it in the transcript', async () => {
      const { interviewId } = await atFirstCivicsQuestion();
      const reading = await throughCivics(interviewId);

      await tool(interviewId, {
        tool: 'grade_answer',
        questionId: reading.itemId,
        transcript: 'nowhere near it',
        confidence: 0.99,
      });

      const writing = await tool(interviewId, { tool: 'next_question' });
      const sentence = SENTENCES.find((row) => row.id === writing.itemId)!;

      expect(writing.phase).toBe('writing');
      expect(sentence.kind).toBe('writing');
      // The model is given the words to SAY...
      expect(writing.text).toContain(sentence.text);
      expect(writing.speakOnly).toBe(true);

      // ...and the transcript route can never leak them. §5's "dictated and
      // never shown" rule, held where a client cannot undo it: the writing
      // sentence is not written into `mock_interview_turns.text` at all, so
      // `GET /interviews/:id` mid-interview cannot become the reveal.
      const detail = await service.getInterview(USER_A, interviewId);
      expect(JSON.stringify(detail.turns)).not.toContain(sentence.text);
    });

    it('writes NOTHING for a misheard reading attempt and leaves the segment outstanding', async () => {
      const { interviewId } = await atFirstCivicsQuestion();
      const reading = await throughCivics(interviewId);

      const misheard = await tool(interviewId, {
        tool: 'grade_answer',
        questionId: reading.itemId,
        transcript: 'mumble mumble',
        confidence: 0.3,
      });

      expect(misheard.status).toBe('ok');
      // `english-test.md` §3: the absence of a record, not a recorded failure —
      // the one place this codebase diverges from `practice_attempts`.
      expect(misheard.recorded).toBe(false);
      expect(store.englishAttempts).toHaveLength(0);
      expect(misheard.phase).toBe('reading');

      // Still outstanding, so the officer asks for it again rather than moving
      // on — and asking twice returns the SAME sentence, because selection is
      // deterministic and nothing was recorded.
      const again = await tool(interviewId, { tool: 'next_question' });
      expect(again.status).toBe('rejected');
      expect(again.reason).toBe('answer_outstanding');
    });

    it('skips a segment with an empty bank, with the honest line', async () => {
      prisma.englishSentence.findMany.mockResolvedValue([]);

      const { interviewId } = await atFirstCivicsQuestion();
      const after = await throughCivics(interviewId);

      // No content means this rehearsal genuinely does not include that test,
      // which is exactly what the text transport already says.
      expect(after.phase).toBe('closing');
      expect(after.itemId).toBeNull();
      const phases = turnsFor(interviewId).map((turn) => turn.phase);
      expect(phases).toContain('reading');
      expect(phases).toContain('writing');
      expect(store.englishAttempts).toHaveLength(0);
    });

    // -------------------------------------------------------------------------
    // The whole contract, by scripted tool calls
    // -------------------------------------------------------------------------

    it('runs an entire interview end to end with no audio and no network', async () => {
      const { interviewId } = await atFirstCivicsQuestion();

      const reading = await throughCivics(interviewId);
      await tool(interviewId, {
        tool: 'grade_answer',
        questionId: reading.itemId,
        transcript: SENTENCES.find((row) => row.id === reading.itemId)!.text,
        confidence: 0.98,
      });

      const writing = await tool(interviewId, { tool: 'next_question' });
      await tool(interviewId, {
        tool: 'grade_answer',
        questionId: writing.itemId,
        transcript: SENTENCES.find((row) => row.id === writing.itemId)!.text,
      });

      const closing = await tool(interviewId, { tool: 'next_question' });
      expect(closing.status).toBe('ok');
      expect(closing.phase).toBe('closing');
      expect(closing.awaitingCompletion).toBe(true);

      // Nothing left to ask, and the model is told so rather than left to guess.
      const done = await tool(interviewId, { tool: 'next_question' });
      expect(done.status).toBe('rejected');
      expect(done.reason).toBe('interview_complete');

      // THE DEBRIEF IS THE FIRST MOMENT ANY VERDICT EXISTS WHERE THE LEARNER
      // CAN SEE IT (§10), and it is computed from the same rows a typed
      // interview writes.
      const debrief = await service.completeInterview(USER_A, interviewId);
      expect(debrief.civics.passed).toBe(true);
      expect(debrief.civics.stopReason).toBe('threshold_reached');
      expect(store.englishAttempts).toHaveLength(2);
      // One-way and coarse: the first successful mint recorded this as a voice
      // interview and nothing since has reverted it (§3).
      expect(store.interviews[0].mode).toBe('voice');
    });

    it('resumes on a cold service, from the rows alone', async () => {
      const { interviewId, questionId } = await atFirstCivicsQuestion();
      await answerCivics(interviewId, questionId, acceptedAnswerFor(questionId));

      // Nothing is carried in memory: the outstanding item, the phase and the
      // plan all come back out of the transcript. This is §3's re-mint case —
      // a learner whose realtime connection dropped and who reconnected.
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
          coachSettingsProvider(),
          EnglishService,
        ],
      }).compile();

      const resumed: InterviewsService = module.get(InterviewsService);
      const next = await resumed.handleRealtimeToolCall(USER_A, interviewId, {
        tool: 'next_question',
      });

      expect(next.status).toBe('ok');
      expect((next as any).phase).toBe('civics');
      // The second question of the plan, not the first again.
      expect((next as any).itemId).toBe(expectedPlan(interviewId)[1]);
    });

    it('leaves the text transport able to finish a voice interview', async () => {
      // §7's fallback, at the seam where it is least obvious it holds: a
      // learner who conducts the civics phase by tool calls and then loses the
      // connection finishes over `POST /interviews/:id/turns`, and the engine
      // does not sit waiting for a reading answer that will never come.
      const { interviewId } = await atFirstCivicsQuestion();
      const reading = await throughCivics(interviewId);
      expect(reading.phase).toBe('reading');

      const { outcome } = await submit(interviewId, 'anything');

      expect(outcome.awaitingCompletion).toBe(true);
      const debrief = await service.completeInterview(USER_A, interviewId);
      expect(debrief.civics.passed).toBe(true);
    });

    // -------------------------------------------------------------------------
    // The debrief of a spoken interview (issue #160, E11 §5, §6, §8)
    // -------------------------------------------------------------------------
    //
    // Driven all the way through by tool calls, then completed — so every
    // number asserted below was read back out of rows this interview actually
    // wrote, never out of a fixture handed to `buildInterviewDebrief`. That is
    // the acceptance criterion: every claim in the debrief traceable to a
    // stored turn or attempt.

    describe('the debrief of a spoken interview', () => {
      /**
       * Run one whole voice interview and complete it.
       *
       * `misheardFirst` answers the first civics question wrongly at a
       * confidence below `ASR_CONFIDENCE_THRESHOLD`, which is what makes the
       * attempt row carry `failure_cause: 'misheard'`; every other answer is
       * the accepted one, at a confidence the recogniser trusted.
       */
      async function completedVoiceInterview({
        retain = true,
        misheardFirst = false,
        stopBeforeWriting = false,
      } = {}): Promise<{ interviewId: string; debrief: InterviewDebrief }> {
        const { interviewId, questionId } = await atFirstCivicsQuestion(retain);

        if (misheardFirst) {
          await answerCivics(interviewId, questionId, 'mumble mumble', 0.3);
          const next = await tool(interviewId, { tool: 'next_question' });
          expect(next.status).toBe('ok');
        }

        const reading = await throughCivics(interviewId);
        expect(reading.phase).toBe('reading');

        await tool(interviewId, {
          tool: 'grade_answer',
          questionId: reading.itemId,
          transcript: SENTENCES.find((row) => row.id === reading.itemId)!.text,
          confidence: 0.98,
        });

        if (!stopBeforeWriting) {
          const writing = await tool(interviewId, { tool: 'next_question' });
          await tool(interviewId, {
            tool: 'grade_answer',
            questionId: writing.itemId,
            transcript: SENTENCES.find((row) => row.id === writing.itemId)!.text,
          });
        }

        return {
          interviewId,
          debrief: await service.completeInterview(USER_A, interviewId),
        };
      }

      it('reports civics, spoken performance and both segments in ONE view', async () => {
        const { debrief } = await completedVoiceInterview();

        // Civics: the engine's own counters and the version row's pass rule.
        expect(debrief.civics.asked).toBeGreaterThan(0);
        expect(debrief.civics.threshold).toBe(VERSION_ROW.passThreshold);

        // Spoken: counted off the attempt rows this interview wrote.
        expect(debrief.spoken.answers).toBe(debrief.civics.asked);
        expect(debrief.spoken.correct).toBe(debrief.civics.correct);

        // The segments: their own table, their own sentences.
        expect(debrief.segments.map((segment) => segment.kind)).toEqual([
          'reading',
          'writing',
        ]);
        expect(
          debrief.segments.every((segment) => segment.sentence.length > 0),
        ).toBe(true);
      });

      it('reports every spoken answer as spoken, off `input_mode` (§6)', async () => {
        const { interviewId, debrief } = await completedVoiceInterview();

        expect(
          debrief.questions.every((question) => question.inputMode === 'spoken'),
        ).toBe(true);
        // The rows say the same thing — the debrief echoed them rather than
        // inferring anything from the interview's mode.
        expect(
          attemptsFor(interviewId).every((row) => row.inputMode === 'spoken'),
        ).toBe(true);
      });

      it('shows a misheard answer as misheard and does NOT count it as a miss', async () => {
        const { interviewId, debrief } = await completedVoiceInterview({
          misheardFirst: true,
        });

        const misheard = debrief.questions.filter((question) => question.misheard);
        expect(misheard).toHaveLength(1);
        expect(debrief.spoken.misheard).toBe(1);

        // The row is the source of the claim, not a flag invented at read time.
        const rows = attemptsFor(interviewId).filter(
          (row) => row.failureCause === 'misheard',
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].asrConfidence).toBe(0.3);

        // NOT COUNTED AS INCORRECT: the outcome survives on the card, but the
        // category is not on the "go and study this" list. Every other question
        // in this run was answered correctly, so the list is empty.
        expect(misheard[0].outcome).not.toBe('correct');
        expect(debrief.focusAreas).toEqual([]);
      });

      it('marks the segments it conducted completed, and the one it did not skipped', async () => {
        const { debrief } = await completedVoiceInterview({ stopBeforeWriting: true });

        const status = Object.fromEntries(
          debrief.phases.map((phase) => [phase.kind, phase.status]),
        );
        expect(status.reading).toBe('completed');
        // The interview was completed before the writing sentence was answered.
        // A status read from `mock_interviews.mode` would claim otherwise.
        expect(status.writing).toBe('skipped');
        expect(debrief.segments.map((segment) => segment.kind)).toEqual(['reading']);
      });

      it('leaves a TEXT interview’s segments skipped and its spoken counts at zero', async () => {
        const interviewId = await runToCompletion([true, true, true, true, true, true]);
        const debrief = await service.completeInterview(USER_A, interviewId);

        expect(debrief.spoken).toEqual({ answers: 0, correct: 0, misheard: 0 });
        expect(debrief.segments).toEqual([]);
        expect(
          debrief.phases
            .filter((phase) => phase.status === 'skipped')
            .map((phase) => phase.kind),
        ).toEqual(['reading', 'writing']);
      });

      it('never attributes an English attempt made BEFORE the interview started', async () => {
        // The segment lookup has no foreign key to join on, so it is bounded by
        // this interview's own clock window. A learner who practised reading
        // this morning and sat a voice interview this afternoon must not have
        // the morning's sentence reported as part of the rehearsal.
        store.englishAttempts.push({
          id: 'ffffffff-0000-4000-8000-000000000001',
          userId: USER_A,
          sentenceId: SENTENCES[1].id,
          kind: 'reading',
          outcome: 'incorrect',
          wer: 1,
          answeredAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        });

        const { debrief } = await completedVoiceInterview();

        expect(debrief.segments.filter((s) => s.kind === 'reading')).toHaveLength(1);
        expect(debrief.segments[0].outcome).toBe('correct');
      });

      it('produces a FULL debrief with transcript retention declined (§8.2)', async () => {
        const { interviewId, debrief } = await completedVoiceInterview({
          retain: false,
        });

        // EVERY BAND POPULATED, asserted field by field rather than by
        // deep-comparing against a retention-on run. Two interviews are two
        // different shuffle seeds and two different points in the sentence
        // bank's own ordering, so an equality test between them would compare
        // question 3 against question 10 and fail for a reason that has nothing
        // to do with retention. What §8.2 actually promises is that the
        // EVIDENCE survives — so that is what is checked.
        expect(debrief.civics.asked).toBeGreaterThan(0);
        expect(debrief.civics.threshold).toBe(VERSION_ROW.passThreshold);
        expect(debrief.questions.length).toBe(debrief.civics.asked);
        expect(
          debrief.questions.every(
            (question) =>
              question.prompt.length > 0 &&
              question.acceptedAnswers.length > 0 &&
              question.inputMode === 'spoken',
          ),
        ).toBe(true);
        expect(debrief.spoken.answers).toBe(debrief.civics.asked);
        expect(debrief.segments.map((segment) => segment.kind)).toEqual([
          'reading',
          'writing',
        ]);
        expect(debrief.phases).toHaveLength(6);
        expect(debrief.readiness.score).toBe(SNAPSHOT.score);
        expect(debrief.readiness.recommendation).toEqual(SNAPSHOT.topRecommendation);

        // And the words really were withheld, so the completeness above is a
        // statement about what a retention-off debrief CAN say rather than
        // evidence that the flag did nothing.
        const rows = attemptsFor(interviewId);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.responseText === null)).toBe(true);
        expect(
          turnsFor(interviewId)
            .filter((turn) => turn.role === 'applicant')
            .every((turn) => turn.text === ''),
        ).toBe(true);
      });

      it('carries the spoken component and the engine’s own recommendation', async () => {
        const { debrief } = await completedVoiceInterview();

        // §8's other half, and PRD.md's "paired with a next action" — both read
        // off the snapshot `ReadinessService` just computed, never re-derived.
        expect(debrief.readiness.spokenComponent).toEqual({
          value: SNAPSHOT.components.spoken.value,
          evidenceCount: SNAPSHOT.evidenceCounts.spoken.attempts,
        });
        expect(debrief.readiness.recommendation).toEqual(SNAPSHOT.topRecommendation);
      });
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

    // BOTH DIRECTORIES. `realtime/` was added by E11 and is on the same
    // request path — a bare date there would be exactly as unpinnable as one
    // here, and the scan that would have caught it only looks where it is
    // pointed.
    const directories = [__dirname, path.join(__dirname, 'realtime')];

    for (const directory of directories) {
      const files = fs
        .readdirSync(directory)
        .filter((name: string) => name.endsWith('.ts') && !name.endsWith('.spec.ts'));

      expect(files.length).toBeGreaterThan(0);

      for (const name of files) {
        // Comments stripped: this module's prose names the rule it follows, and
        // a scan that counted the explanation would punish writing one.
        const source = stripComments(
          fs.readFileSync(path.join(directory, name), 'utf8'),
        );
        expect(source).not.toMatch(/new Date\(/);
      }
    }
  });
});

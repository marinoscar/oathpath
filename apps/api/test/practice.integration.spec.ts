import { randomUUID } from 'node:crypto';

import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from './helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from './mocks/prisma.mock';
import { setupBaseMocks } from './fixtures/mock-setup.helper';
import {
  createMockViewerUser,
  authHeader,
  TestUser,
} from './helpers/auth-mock.helper';
import { ASR_CONFIDENCE_THRESHOLD } from '../src/ai/ai.types';
import { nextSchedule } from '../src/practice/mastery/scheduler';
import { fromStoredMasteryOutcome } from '../src/practice/mastery/outcome-mapping';

// =============================================================================
// Practice API (integration) — issue #73, epic #52 / E3
// =============================================================================
//
// Every acceptance criterion COVER-listed for issue #73 asserted over real
// HTTP through `createTestApp`, with Prisma mocked — the shape
// `journey.integration.spec.ts` and `civics.integration.spec.ts` both
// establish. The unit specs (`practice.service.spec.ts`,
// `practice.controller.spec.ts`, `question-selection.spec.ts`) cover the
// decisions in isolation; this file covers that they survive the wire: the
// guards, the global Zod pipe, the response envelope, and cross-request state
// (a session opened in one request and answered in the next) are all in the
// path.
//
// -----------------------------------------------------------------------------
// THE PRISMA MOCK IS A SMALL IN-MEMORY STORE, NOT FIXED RETURN VALUES
// -----------------------------------------------------------------------------
//
// Two of the properties this file exists to prove — cross-user isolation and
// "the answer never leaves the server before it is earned" — are about which
// ROW a second request can and cannot see, and about what a SPECIFIC response
// body does and does not contain. A `mockResolvedValue` cannot express either;
// `sessions`/`attempts` below are real maps that `POST` writes into and later
// requests read back, the same shape `journey.integration.spec.ts`'s
// `profiles` map takes.
//
// No test in this repository touches a database (docs/TESTING.md).
// =============================================================================

const TV = 'v2025';

const Q1 = 'a1111111-1111-4111-8111-111111111111'; // none-scope, 3 accepted answers
const Q2 = 'a2222222-2222-4222-8222-222222222222'; // none-scope, 1 accepted answer
const Q3 = 'a3333333-3333-4333-8333-333333333333'; // state-scope

const CATEGORY_ID = 'c1111111-1111-4111-8111-111111111111';

// -----------------------------------------------------------------------------
// Fixtures for GET /api/practice/queue and mastery-scheduling coverage
// (issue #78, epic #54 / E5 "Memory")
// -----------------------------------------------------------------------------

/** A second test version, so a `state_required` question can sit alongside an
 * answerable one without disturbing the exactly-{Q1,Q2} `TV` pool every other
 * test in this file assumes. */
const TV2 = 'v2008';

/** An answerable question in `TV2` — needed so a session can be STARTED for a
 * stateless learner at all (a pool of only Q3 would 409 with no candidates,
 * since Q3 is excluded outright by `excludeUnanswerable`). */
const Q4 = 'a4444444-4444-4444-8444-444444444444';

/** A dedicated test version for the queue-counts fixture, so it never shares
 * a bank with the {Q1,Q2} pool the rest of this file's assertions depend on. */
const QUEUE_TV = 'v2026queue';
const QUEUE_CAT_A = 'cA111111-1111-4111-8111-111111111111';
const QUEUE_CAT_B = 'cB111111-1111-4111-8111-111111111111';

const Q_DUE = 'aD111111-1111-4111-8111-111111111111';
const Q_WEAK = 'aE111111-1111-4111-8111-111111111111';
const Q_NEW_A = 'aF111111-1111-4111-8111-111111111111';
const Q_NEW_B = 'aG111111-1111-4111-8111-111111111111';
const Q_STEADY = 'aH111111-1111-4111-8111-111111111111';
const Q_MASTERED = 'aI111111-1111-4111-8111-111111111111';
/** state-scope, in the QUEUE_TV pool too — proves `getQueue` excludes it for
 * a stateless learner exactly as session selection would. */
const Q_STATE_SCOPE = 'aJ111111-1111-4111-8111-111111111111';

const CATEGORIES = [
  { id: CATEGORY_ID, name: 'Category' },
  { id: QUEUE_CAT_A, name: 'Category A' },
  { id: QUEUE_CAT_B, name: 'Category B' },
];

/** The one accepted answer for Q2 — the "next question's" answer in the leak test. */
const Q2_ANSWER_TEXT = 'The rule of law';

/**
 * A correct response for whichever of the two fixture questions the selector
 * (unseen-first, shuffled) happens to present. `question-selection.spec.ts`
 * already proves the shuffle itself; nothing here should be sensitive to
 * which of Q1/Q2 comes first, so every test below asks this rather than
 * hardcoding an id.
 */
function correctAnswerFor(questionId: string): string {
  if (questionId === Q1) return 'Congress';
  if (questionId === Q2) return Q2_ANSWER_TEXT;
  throw new Error(`no fixture accepted answer for question ${questionId}`);
}

const QUESTIONS = [
  {
    id: Q1,
    testVersionCode: TV,
    number: 1,
    categoryId: CATEGORY_ID,
    prompt: 'Name one branch or part of the government.',
    seniorEligible: false,
    dynamicScope: 'none' as const,
  },
  {
    id: Q2,
    testVersionCode: TV,
    number: 2,
    categoryId: CATEGORY_ID,
    prompt: 'What is the supreme law of the land?',
    seniorEligible: false,
    dynamicScope: 'none' as const,
  },
  {
    // A DIFFERENT test version on purpose: Q3 exists only so `ANSWERS` has a
    // state-scope fixture available, and it must never silently become a
    // third candidate in the `TV` pool the tests below assume is exactly
    // {Q1, Q2} — state-scope exclusion itself is already covered at the unit
    // level (`practice.service.spec.ts`, `question-selection.spec.ts`).
    id: Q3,
    testVersionCode: TV2,
    number: 3,
    categoryId: CATEGORY_ID,
    prompt: 'Who is the Governor of your state now?',
    seniorEligible: false,
    dynamicScope: 'state' as const,
  },
  {
    // Answerable, in TV2 alongside Q3 — exists only so a session can be
    // started for a stateless learner in TV2 at all.
    id: Q4,
    testVersionCode: TV2,
    number: 1,
    categoryId: CATEGORY_ID,
    prompt: 'What do we call the first ten amendments to the Constitution?',
    seniorEligible: false,
    dynamicScope: 'none' as const,
  },
  {
    id: Q_DUE,
    testVersionCode: QUEUE_TV,
    number: 1,
    categoryId: QUEUE_CAT_A,
    prompt: 'due-bucket fixture question',
    seniorEligible: false,
    dynamicScope: 'none' as const,
  },
  {
    id: Q_WEAK,
    testVersionCode: QUEUE_TV,
    number: 2,
    categoryId: QUEUE_CAT_A,
    prompt: 'weak-bucket fixture question',
    seniorEligible: false,
    dynamicScope: 'none' as const,
  },
  {
    id: Q_NEW_A,
    testVersionCode: QUEUE_TV,
    number: 3,
    categoryId: QUEUE_CAT_A,
    prompt: 'new-bucket fixture question (category A)',
    seniorEligible: false,
    dynamicScope: 'none' as const,
  },
  {
    id: Q_NEW_B,
    testVersionCode: QUEUE_TV,
    number: 4,
    categoryId: QUEUE_CAT_B,
    prompt: 'new-bucket fixture question (category B)',
    seniorEligible: false,
    dynamicScope: 'none' as const,
  },
  {
    id: Q_STEADY,
    testVersionCode: QUEUE_TV,
    number: 5,
    categoryId: QUEUE_CAT_A,
    prompt: 'steady-bucket fixture question',
    seniorEligible: false,
    dynamicScope: 'none' as const,
  },
  {
    id: Q_MASTERED,
    testVersionCode: QUEUE_TV,
    number: 6,
    categoryId: QUEUE_CAT_A,
    prompt: 'mastered-bucket fixture question',
    seniorEligible: false,
    dynamicScope: 'none' as const,
  },
  {
    id: Q_STATE_SCOPE,
    testVersionCode: QUEUE_TV,
    number: 7,
    categoryId: QUEUE_CAT_A,
    prompt: 'state-scope fixture question — excluded for a stateless learner',
    seniorEligible: false,
    dynamicScope: 'state' as const,
  },
];

function answerRow(over: Record<string, any>) {
  return {
    id: over.id,
    questionId: over.questionId,
    text: over.text,
    sort: over.sort ?? 0,
    stateCode: over.stateCode ?? null,
    verifiedAt: over.verifiedAt ?? new Date('2026-05-01T00:00:00Z'),
    effectiveFrom: over.effectiveFrom ?? new Date('2026-01-01T00:00:00Z'),
    effectiveTo: over.effectiveTo ?? null,
  };
}

const ANSWERS = [
  answerRow({ id: 'd1', questionId: Q1, text: 'Congress', sort: 0 }),
  answerRow({ id: 'd2', questionId: Q1, text: 'the President', sort: 1 }),
  answerRow({ id: 'd3', questionId: Q1, text: 'the courts', sort: 2 }),
  answerRow({ id: 'd4', questionId: Q2, text: Q2_ANSWER_TEXT, sort: 0 }),
  answerRow({ id: 'd5', questionId: Q3, text: 'Gavin Newsom', sort: 0, stateCode: 'CA' }),
];

/**
 * The `learner_profiles` facts practice reads, for the duration of one test.
 *
 * `stage` is optional: every existing fixture in this file omits it, exactly
 * as `loadProfile`'s own `select` never reads it — only `scheduleMastery`'s
 * stage-transition step (issue #82, epic #54 / E5 "Memory") does, through its
 * own separate `findUnique`/`update` pair below.
 */
let profiles: Map<
  string,
  {
    stateCode: string | null;
    testVersionCode: string | null;
    seniorExemption: boolean;
    stage?: string;
  }
>;
/** The `practice_sessions` table, in-memory. */
let sessions: Map<string, Record<string, any>>;
/** The `practice_attempts` table, in-memory. */
let attempts: Map<string, Record<string, any>>;
/** The `question_mastery` table, in-memory — keyed by `${userId}:${questionId}`, mirroring its own `@@unique([userId, questionId])`. */
let mastery: Map<string, Record<string, any>>;

/**
 * Wire the practice tables into the shared Prisma mock as a tiny relational
 * store — filtering on `where` for real, rather than returning a canned list,
 * for the same reason `civics.integration.spec.ts`'s header gives: a
 * `mockResolvedValue` would make the clock and ownership assertions below
 * meaningless, because a service that ignored either would still pass.
 */
function setupPracticeMocks(): void {
  profiles = new Map();
  sessions = new Map();
  attempts = new Map();
  mastery = new Map();

  (prismaMock.learnerProfile.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => profiles.get(where.userId) ?? null,
  );

  // `scheduleMastery`'s stage-transition step (issue #82, epic #54 / E5
  // "Memory") reads `learner_profiles.stage` and, when
  // `nextStageOnMasteryEvent` says to, writes the new stage back — inside
  // the SAME transaction as the mastery upsert. Writes land in the SAME
  // `profiles` map `findUnique` above reads, so a stage a test seeds is
  // visible to the write, and a stage the write produces is visible to a
  // follow-up read.
  (prismaMock.learnerProfile.update as jest.Mock).mockImplementation(
    async ({ where, data }: any) => {
      const existing = profiles.get(where.userId);
      if (!existing) {
        throw new Error(`no learner_profiles row for ${where.userId}`);
      }
      const next = { ...existing, ...data };
      profiles.set(where.userId, next);
      return { ...next };
    },
  );

  (prismaMock.civicsCategory.findFirst as jest.Mock).mockImplementation(
    async ({ where }: any) =>
      where.id === CATEGORY_ID && where.testVersionCode === TV
        ? { id: CATEGORY_ID, testVersionCode: TV }
        : null,
  );

  (prismaMock.civicsQuestion.findMany as jest.Mock).mockImplementation(
    async ({ where = {} }: any) =>
      QUESTIONS.filter(
        (q) =>
          (where.testVersionCode === undefined || q.testVersionCode === where.testVersionCode) &&
          (where.categoryId === undefined || q.categoryId === where.categoryId) &&
          (where.seniorEligible === undefined || q.seniorEligible === where.seniorEligible),
      ),
  );

  (prismaMock.civicsQuestion.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => QUESTIONS.find((q) => q.id === where.id) ?? null,
  );

  (prismaMock.civicsAnswer.findMany as jest.Mock).mockImplementation(async ({ where }: any) => {
    const now: Date = where.effectiveFrom.lte;
    return ANSWERS.filter((a) => {
      if (a.questionId !== where.questionId) return false;
      if ((a.stateCode ?? null) !== (where.stateCode ?? null)) return false;
      if (a.effectiveFrom.getTime() > now.getTime()) return false;
      if (a.effectiveTo !== null && a.effectiveTo.getTime() <= now.getTime()) return false;
      return true;
    }).sort(
      (x, y) => x.sort - y.sort || y.effectiveFrom.getTime() - x.effectiveFrom.getTime(),
    );
  });

  (prismaMock.practiceSession.create as jest.Mock).mockImplementation(async ({ data }: any) => {
    const row = {
      completedAt: null,
      summary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
      // A REAL uuid — `ParseUUIDPipe` on `:id` rejects anything else, and the
      // integration spec exercises the actual route, pipe included.
      id: randomUUID(),
    };
    sessions.set(row.id, row);
    return { ...row };
  });

  (prismaMock.practiceSession.updateMany as jest.Mock).mockImplementation(
    async ({ where, data }: any) => {
      let count = 0;
      for (const [id, row] of sessions) {
        if (row.userId === where.userId && row.status === where.status) {
          sessions.set(id, { ...row, ...data });
          count += 1;
        }
      }
      return { count };
    },
  );

  (prismaMock.practiceSession.findFirst as jest.Mock).mockImplementation(async ({ where }: any) => {
    const row = sessions.get(where.id);
    if (!row || row.userId !== where.userId) return null;
    return { ...row };
  });

  (prismaMock.practiceSession.update as jest.Mock).mockImplementation(async ({ where, data }: any) => {
    const existing = sessions.get(where.id);
    const updated = { ...existing, ...data };
    sessions.set(where.id, updated);
    return { ...updated };
  });

  (prismaMock.practiceSession.findMany as jest.Mock).mockImplementation(
    async ({ where, skip = 0, take }: any) => {
      let rows = Array.from(sessions.values()).filter((row) => row.userId === where.userId);
      rows = rows
        .slice()
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(skip, take === undefined ? undefined : skip + take);

      return rows.map((row) => ({
        ...row,
        attempts: Array.from(attempts.values())
          .filter((a) => a.sessionId === row.id)
          .map((a) => ({ outcome: a.outcome })),
      }));
    },
  );

  (prismaMock.practiceSession.count as jest.Mock).mockImplementation(async ({ where }: any) =>
    Array.from(sessions.values()).filter((row) => row.userId === where.userId).length,
  );

  (prismaMock.practiceAttempt.groupBy as jest.Mock).mockImplementation(async ({ where }: any) => {
    const ids = new Set(
      Array.from(attempts.values())
        .filter((a) => a.userId === where.userId)
        .map((a) => a.questionId),
    );
    return Array.from(ids).map((questionId) => ({ questionId }));
  });

  (prismaMock.practiceAttempt.findFirst as jest.Mock).mockImplementation(async ({ where }: any) => {
    const row = Array.from(attempts.values()).find(
      (a) =>
        (where.id === undefined || a.id === where.id) &&
        (where.sessionId === undefined || a.sessionId === where.sessionId) &&
        (where.userId === undefined || a.userId === where.userId) &&
        (where.questionId === undefined || a.questionId === where.questionId) &&
        // The retry guard's "does anything already supersede this row?" probe
        // (issue #104, epic #58 / E9). Filtered for real, like every other key
        // here — a mock that ignored it would report "nothing supersedes it"
        // for every row and quietly pass a service that had lost the check.
        (where.retryOfAttemptId === undefined ||
          (a.retryOfAttemptId ?? null) === where.retryOfAttemptId),
    );
    if (!row) return null;
    return { ...row, question: QUESTIONS.find((q) => q.id === row.questionId) };
  });

  (prismaMock.practiceAttempt.findMany as jest.Mock).mockImplementation(async ({ where }: any) => {
    const rows = Array.from(attempts.values())
      .filter(
        (a) =>
          (where.sessionId === undefined || a.sessionId === where.sessionId) &&
          (where.userId === undefined || a.userId === where.userId),
      )
      .sort((a, b) => a.answeredAt.getTime() - b.answeredAt.getTime() || a.id.localeCompare(b.id));

    return rows.map((row) => ({ ...row, question: QUESTIONS.find((q) => q.id === row.questionId) }));
  });

  (prismaMock.practiceAttempt.create as jest.Mock).mockImplementation(async ({ data }: any) => {
    const row = { createdAt: new Date(), ...data, id: randomUUID() };
    attempts.set(row.id, row);
    return { ...row, question: QUESTIONS.find((q) => q.id === row.questionId) };
  });

  (prismaMock.practiceAttempt.update as jest.Mock).mockImplementation(async ({ where, data }: any) => {
    const existing = attempts.get(where.id);
    const updated = { ...existing, ...data };
    attempts.set(where.id, updated);
    return { ...updated, question: QUESTIONS.find((q) => q.id === updated.questionId) };
  });

  // `question_mastery` (issue #78, epic #54 / E5) — synchronous scheduling
  // reads and writes this on every `POST .../attempts` and every self-mark,
  // and `candidateQuestions` reads it for ordering.
  (prismaMock.questionMastery.findMany as jest.Mock).mockImplementation(async ({ where }: any) => {
    const ids: string[] | undefined = where.questionId?.in;
    return Array.from(mastery.values()).filter(
      (row) => row.userId === where.userId && (ids === undefined || ids.includes(row.questionId)),
    );
  });

  (prismaMock.questionMastery.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
    const key = where.userId_questionId;
    return mastery.get(`${key.userId}:${key.questionId}`) ?? null;
  });

  (prismaMock.questionMastery.upsert as jest.Mock).mockImplementation(
    async ({ where, create, update }: any) => {
      const key = where.userId_questionId;
      const mapKey = `${key.userId}:${key.questionId}`;
      const existing = mastery.get(mapKey);
      const row = existing
        ? { ...existing, ...update, updatedAt: new Date() }
        : { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...create };
      mastery.set(mapKey, row);
      return { ...row };
    },
  );

  // `GET /api/practice/queue` (issue #78) reads category names for its
  // `new.byCategory` breakdown.
  (prismaMock.civicsCategory.findMany as jest.Mock).mockImplementation(async ({ where }: any) => {
    const ids: string[] | undefined = where?.id?.in;
    return ids === undefined ? CATEGORIES : CATEGORIES.filter((c) => ids.includes(c.id));
  });
}

describe('Practice (Integration)', () => {
  let context: TestContext;
  let learnerA: TestUser;
  let learnerB: TestUser;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    setupPracticeMocks();

    learnerA = await createMockViewerUser(context, 'learnerA@example.com');
    learnerB = await createMockViewerUser(context, 'learnerB@example.com');

    profiles.set(learnerA.id, { stateCode: 'CA', testVersionCode: TV, seniorExemption: false });
    profiles.set(learnerB.id, { stateCode: 'CA', testVersionCode: TV, seniorExemption: false });
  });

  const server = () => context.app.getHttpServer();

  /** Opens a Quick session for `user` and returns its response body's `data`. */
  async function startSession(
    user: TestUser,
    body: Record<string, unknown> = { kind: 'quick', plannedCount: 2 },
  ) {
    const response = await request(server())
      .post('/api/practice/sessions')
      .set(authHeader(user.accessToken))
      .send(body)
      .expect(201);
    return response.body.data;
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  describe('authentication', () => {
    it.each([
      ['post', '/api/practice/sessions'],
      ['get', '/api/practice/sessions'],
      ['get', '/api/practice/sessions/00000000-0000-4000-8000-000000000000'],
      ['post', '/api/practice/sessions/00000000-0000-4000-8000-000000000000/attempts'],
      [
        'post',
        '/api/practice/sessions/00000000-0000-4000-8000-000000000000/attempts/00000000-0000-4000-8000-000000000000/self-mark',
      ],
      ['post', '/api/practice/sessions/00000000-0000-4000-8000-000000000000/complete'],
    ] as const)('rejects an unauthenticated %s %s with 401', async (method, path) => {
      await (request(server()) as any)[method](path).expect(401);
    });

    it('admits a Viewer — the default role, holding no permissions — to every route', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 1 });
      const sessionId = created.session.id;
      const questionId = created.nextQuestion.id;

      await request(server())
        .get('/api/practice/sessions')
        .set(authHeader(learnerA.accessToken))
        .expect(200);

      await request(server())
        .get(`/api/practice/sessions/${sessionId}`)
        .set(authHeader(learnerA.accessToken))
        .expect(200);

      const attemptResponse = await request(server())
        .post(`/api/practice/sessions/${sessionId}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .send({ questionId, responseText: 'not the accepted answer', revealed: true })
        .expect(201);

      const attemptId = attemptResponse.body.data.attempt.id;

      await request(server())
        .post(`/api/practice/sessions/${sessionId}/attempts/${attemptId}/self-mark`)
        .set(authHeader(learnerA.accessToken))
        .expect(201);

      await request(server())
        .post(`/api/practice/sessions/${sessionId}/complete`)
        .set(authHeader(learnerA.accessToken))
        .expect(201);
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-user isolation
  // ---------------------------------------------------------------------------

  describe('cross-user isolation', () => {
    it('404s user B reading user A’s session', async () => {
      const created = await startSession(learnerA);

      await request(server())
        .get(`/api/practice/sessions/${created.session.id}`)
        .set(authHeader(learnerB.accessToken))
        .expect(404);
    });

    it('404s user B posting an attempt into user A’s session', async () => {
      const created = await startSession(learnerA);

      await request(server())
        .post(`/api/practice/sessions/${created.session.id}/attempts`)
        .set(authHeader(learnerB.accessToken))
        .send({ questionId: created.nextQuestion.id, responseText: 'anything' })
        .expect(404);
    });

    it('404s user B self-marking an attempt recorded under user A’s session', async () => {
      const created = await startSession(learnerA);
      const attemptResponse = await request(server())
        .post(`/api/practice/sessions/${created.session.id}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .send({ questionId: created.nextQuestion.id, responseText: 'nope', revealed: true })
        .expect(201);

      await request(server())
        .post(
          `/api/practice/sessions/${created.session.id}/attempts/${attemptResponse.body.data.attempt.id}/self-mark`,
        )
        .set(authHeader(learnerB.accessToken))
        .expect(404);
    });

    it('404s user B completing user A’s session', async () => {
      const created = await startSession(learnerA);

      await request(server())
        .post(`/api/practice/sessions/${created.session.id}/complete`)
        .set(authHeader(learnerB.accessToken))
        .expect(404);
    });

    it('never lets user B’s own attempt-id probe reach across sessions, even under their own session', async () => {
      // Belt and suspenders: user B has a session of their own, and user A's
      // attempt id is a real row — but the self-mark lookup is scoped to
      // (attemptId, sessionId, userId) TOGETHER, so naming user A's attempt
      // under user B's own session is still a 404, not a peek.
      const ownedByA = await startSession(learnerA);
      const attemptResponse = await request(server())
        .post(`/api/practice/sessions/${ownedByA.session.id}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .send({ questionId: ownedByA.nextQuestion.id, responseText: 'nope', revealed: true })
        .expect(201);

      const ownedByB = await startSession(learnerB);

      await request(server())
        .post(
          `/api/practice/sessions/${ownedByB.session.id}/attempts/${attemptResponse.body.data.attempt.id}/self-mark`,
        )
        .set(authHeader(learnerB.accessToken))
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // No accepted answer leaves the server before it is earned
  // ---------------------------------------------------------------------------

  describe('no accepted-answer text appears before it is earned', () => {
    it('the create-session response carries no accepted-answer text anywhere in its body', async () => {
      const response = await request(server())
        .post('/api/practice/sessions')
        .set(authHeader(learnerA.accessToken))
        .send({ kind: 'quick', plannedCount: 2 })
        .expect(201);

      const body = JSON.stringify(response.body);
      for (const answer of ANSWERS) {
        expect(body).not.toContain(answer.text);
      }
    });

    it('the graded attempt’s nextQuestion carries none of the NEXT question’s accepted-answer text', async () => {
      // Whichever of the two pooled questions the selector presents first is
      // graded correctly (its OWN answer is legitimately earned and appears in
      // `acceptedAnswers`/`answerSnapshot`); the OTHER one comes back as
      // `nextQuestion`, prompt-only. That question's accepted answer —
      // recognisable, unrevealed, unearned — must not appear anywhere in this
      // response, which is the whole point of a SEPARATE prompt-only DTO
      // (dto/practice-question.dto.ts).
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });
      const firstQuestionId = created.nextQuestion.id;
      const secondQuestionId = firstQuestionId === Q1 ? Q2 : Q1;

      const response = await request(server())
        .post(`/api/practice/sessions/${created.session.id}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .send({ questionId: firstQuestionId, responseText: correctAnswerFor(firstQuestionId) })
        .expect(201);

      expect(response.body.data.attempt.outcome).toBe('correct');
      expect(response.body.data.nextQuestion.id).toBe(secondQuestionId);

      const body = JSON.stringify(response.body);
      expect(body).not.toContain(correctAnswerFor(secondQuestionId));
      // The just-graded question's OWN answer is legitimately present — this
      // is not a blanket "no answer text anywhere" assertion, only "never the
      // next, unearned question's".
      expect(body).toContain(correctAnswerFor(firstQuestionId));
    });

    it('the resumed session’s nextQuestion carries no accepted-answer text either', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

      const response = await request(server())
        .get(`/api/practice/sessions/${created.session.id}`)
        .set(authHeader(learnerA.accessToken))
        .expect(200);

      expect(response.body.data.nextQuestion).not.toBeNull();
      const body = JSON.stringify(response.body.data.nextQuestion);
      for (const answer of ANSWERS) {
        expect(body).not.toContain(answer.text);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown query parameters — the list endpoint's DTO is z.strictObject
  // ---------------------------------------------------------------------------

  describe('GET /api/practice/sessions — query validation', () => {
    // Checked against the source first: `dto/practice-session-query.dto.ts`
    // declares `practiceSessionQuerySchema` with `z.strictObject`, the same
    // convention `allowlist`/`civics` query DTOs use — so an unrecognised key
    // is asserted as a 400, not silently ignored.
    it('rejects an unknown query parameter, including ?userId=, with 400', async () => {
      await request(server())
        .get(`/api/practice/sessions?userId=${learnerB.id}`)
        .set(authHeader(learnerA.accessToken))
        .expect(400);

      await request(server())
        .get('/api/practice/sessions?status=in_progress')
        .set(authHeader(learnerA.accessToken))
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // The practice loop, end to end
  // ---------------------------------------------------------------------------

  describe('the practice loop', () => {
    it('grades a correct response deterministically and reports gradingMethod: "exact"', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });
      const questionId = created.nextQuestion.id;

      const response = await request(server())
        .post(`/api/practice/sessions/${created.session.id}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .send({ questionId, responseText: correctAnswerFor(questionId) })
        .expect(201);

      expect(response.body.data.attempt.outcome).toBe('correct');
      expect(response.body.data.attempt.gradingMethod).toBe('exact');
      expect(
        response.body.data.acceptedAnswers.map((a: any) => a.text),
      ).toContain(correctAnswerFor(questionId));
    });

    it('records a skip as outcome "skipped" with a null responseText', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

      const response = await request(server())
        .post(`/api/practice/sessions/${created.session.id}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .send({ questionId: created.nextQuestion.id, skipped: true })
        .expect(201);

      expect(response.body.data.attempt.outcome).toBe('skipped');
      expect(response.body.data.attempt.responseText).toBeNull();
    });

    it('self-marks an incorrect, revealed attempt to correct, and refuses one that has not been revealed', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

      const notRevealed = await request(server())
        .post(`/api/practice/sessions/${created.session.id}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .send({ questionId: created.nextQuestion.id, responseText: 'wrong' })
        .expect(201);

      await request(server())
        .post(
          `/api/practice/sessions/${created.session.id}/attempts/${notRevealed.body.data.attempt.id}/self-mark`,
        )
        .set(authHeader(learnerA.accessToken))
        .expect(409);

      // The pool has exactly two questions and one attempt each — the second
      // attempt has to answer WHICHEVER question the API just handed back as
      // `nextQuestion`, not an id this test guesses at.
      const secondQuestionId = notRevealed.body.data.nextQuestion.id;

      const revealed = await request(server())
        .post(`/api/practice/sessions/${created.session.id}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .send({ questionId: secondQuestionId, responseText: 'wrong', revealed: true })
        .expect(201);

      const selfMarked = await request(server())
        .post(
          `/api/practice/sessions/${created.session.id}/attempts/${revealed.body.data.attempt.id}/self-mark`,
        )
        .set(authHeader(learnerA.accessToken))
        .expect(201);

      expect(selfMarked.body.data.outcome).toBe('correct');
      expect(selfMarked.body.data.gradingMethod).toBe('self');
    });

    it('computes the completion summary from the persisted attempts and is idempotent', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 1 });
      const questionId = created.nextQuestion.id;

      await request(server())
        .post(`/api/practice/sessions/${created.session.id}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .send({ questionId, responseText: correctAnswerFor(questionId) })
        .expect(201);

      const first = await request(server())
        .post(`/api/practice/sessions/${created.session.id}/complete`)
        .set(authHeader(learnerA.accessToken))
        .expect(201);

      expect(first.body.data.summary).toMatchObject({ answered: 1, correct: 1, plannedCount: 1 });
      expect(first.body.data.status).toBe('completed');

      const second = await request(server())
        .post(`/api/practice/sessions/${created.session.id}/complete`)
        .set(authHeader(learnerA.accessToken))
        .expect(201);

      expect(second.body.data.summary).toEqual(first.body.data.summary);
      expect(second.body.data.completedAt).toBe(first.body.data.completedAt);
    });

    it('409s completing a session that is not in_progress via a second, concurrent session start', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

      // Starting a second session abandons the first (practice-sessions.md §5).
      await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

      await request(server())
        .post(`/api/practice/sessions/${created.session.id}/complete`)
        .set(authHeader(learnerA.accessToken))
        .expect(409);
    });
  });

  // ---------------------------------------------------------------------------
  // Voice: spoken attempts, the misheard mapping, and the one retry
  // (issue #104, epic #58 / E9)
  // ---------------------------------------------------------------------------

  describe('voice', () => {
    /** Posts one attempt and returns the response body's `data`. */
    async function postAttempt(
      user: TestUser,
      sessionId: string,
      body: Record<string, unknown>,
      status = 201,
    ) {
      const response = await request(server())
        .post(`/api/practice/sessions/${sessionId}/attempts`)
        .set(authHeader(user.accessToken))
        .send(body)
        .expect(status);
      return response.body.data;
    }

    describe('inputMode and promptMode reach the row and come back on the wire', () => {
      it.each([
        ['typed', 'read'],
        ['typed', 'heard'],
        ['spoken', 'read'],
        ['spoken', 'heard'],
      ] as const)('records %s / %s', async (inputMode, promptMode) => {
        const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });
        const questionId = created.nextQuestion.id;
        const text = correctAnswerFor(questionId);

        const data = await postAttempt(learnerA, created.session.id, {
          questionId,
          responseText: text,
          inputMode,
          promptMode,
          ...(inputMode === 'spoken' ? { transcript: text } : {}),
        });

        expect(data.attempt.inputMode).toBe(inputMode);
        expect(data.attempt.promptMode).toBe(promptMode);
        expect(attempts.get(data.attempt.id)).toMatchObject({ inputMode, promptMode });
      });
    });

    it('defaults an unchanged pre-voice body to typed/read, with all three voice columns null', async () => {
      // The compatibility property, over the wire and through the global Zod
      // pipe: a client that has never heard of E9 writes exactly the row it
      // always wrote.
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });
      const questionId = created.nextQuestion.id;

      const data = await postAttempt(learnerA, created.session.id, {
        questionId,
        responseText: correctAnswerFor(questionId),
      });

      expect(data.attempt).toMatchObject({
        inputMode: 'typed',
        promptMode: 'read',
        transcript: null,
        asrConfidence: null,
        retryOfAttemptId: null,
      });
    });

    it('stores the confirmed transcript and the confidence on a spoken attempt', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });
      const questionId = created.nextQuestion.id;
      const text = correctAnswerFor(questionId);

      const data = await postAttempt(learnerA, created.session.id, {
        questionId,
        responseText: text,
        inputMode: 'spoken',
        promptMode: 'heard',
        transcript: text,
        asrConfidence: 0.88,
      });

      expect(data.attempt.transcript).toBe(text);
      expect(data.attempt.asrConfidence).toBe(0.88);
      expect(attempts.get(data.attempt.id)).toMatchObject({
        transcript: text,
        asrConfidence: 0.88,
      });
    });

    describe('the misheard mapping', () => {
      it('records failureCause: "misheard" for a low-confidence miss', async () => {
        // voice.md §3.1's worked example, end to end: the recogniser was
        // unsure, the learner confirmed what it produced, and the text does
        // not match — so the row blames the recognition, not the learner.
        const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

        const data = await postAttempt(learnerA, created.session.id, {
          questionId: created.nextQuestion.id,
          responseText: 'the head of the executive ranch',
          inputMode: 'spoken',
          promptMode: 'heard',
          transcript: 'the head of the executive ranch',
          asrConfidence: 0.41,
        });

        expect(data.attempt.outcome).toBe('incorrect');
        expect(data.attempt.failureCause).toBe('misheard');
        // Non-null cause, null everything else the grading rung writes — no
        // model was involved in reaching it, and `gradingMethod` says so.
        expect(data.attempt.gradingMethod).toBe('exact');
        expect(data.attempt.aiFeedback).toBeNull();
        expect(data.attempt.aiUsageEventId).toBeNull();
      });

      it('does not fire on a correct answer, however poorly it was heard', async () => {
        const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });
        const questionId = created.nextQuestion.id;
        const text = correctAnswerFor(questionId);

        const data = await postAttempt(learnerA, created.session.id, {
          questionId,
          responseText: text,
          inputMode: 'spoken',
          transcript: text,
          asrConfidence: 0.41,
        });

        expect(data.attempt.outcome).toBe('correct');
        expect(data.attempt.failureCause).toBeNull();
      });

      it('does not fire when no confidence was reported — unknown is not low', async () => {
        const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

        const data = await postAttempt(learnerA, created.session.id, {
          questionId: created.nextQuestion.id,
          responseText: 'the head of the executive ranch',
          inputMode: 'spoken',
          transcript: 'the head of the executive ranch',
        });

        expect(data.attempt.outcome).toBe('incorrect');
        expect(data.attempt.failureCause).toBeNull();
      });

      it('does not fire at or above the threshold', async () => {
        const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

        const data = await postAttempt(learnerA, created.session.id, {
          questionId: created.nextQuestion.id,
          responseText: 'the head of the executive ranch',
          inputMode: 'spoken',
          transcript: 'the head of the executive ranch',
          asrConfidence: ASR_CONFIDENCE_THRESHOLD,
        });

        expect(data.attempt.failureCause).toBeNull();
      });
    });

    describe('the retry', () => {
      /** A session whose first question has one misheard attempt on it. */
      async function sessionWithMisheardAttempt(user: TestUser) {
        const created = await startSession(user, { kind: 'quick', plannedCount: 2 });
        const questionId = created.nextQuestion.id;

        const first = await postAttempt(user, created.session.id, {
          questionId,
          responseText: 'the head of the executive ranch',
          inputMode: 'spoken',
          promptMode: 'heard',
          transcript: 'the head of the executive ranch',
          asrConfidence: 0.41,
        });

        return {
          sessionId: created.session.id,
          questionId,
          originalId: first.attempt.id as string,
        };
      }

      it('admits the corrected answer and links it back to the attempt it supersedes', async () => {
        const { sessionId, questionId, originalId } =
          await sessionWithMisheardAttempt(learnerA);

        const retry = await postAttempt(learnerA, sessionId, {
          questionId,
          responseText: correctAnswerFor(questionId),
          inputMode: 'spoken',
          promptMode: 'heard',
          transcript: correctAnswerFor(questionId),
          asrConfidence: 0.97,
          retryOfAttemptId: originalId,
        });

        expect(retry.attempt.outcome).toBe('correct');
        expect(retry.attempt.retryOfAttemptId).toBe(originalId);

        // THE SUPERSEDED ROW IS STILL THERE. Evidence that a mishearing
        // happened is not deleted to make a number look better.
        expect(attempts.get(originalId)).toMatchObject({
          outcome: 'incorrect',
          failureCause: 'misheard',
        });
      });

      it('409s a second attempt at the same question that names no retry target', async () => {
        const { sessionId, questionId } = await sessionWithMisheardAttempt(learnerA);

        await postAttempt(
          learnerA,
          sessionId,
          { questionId, responseText: correctAnswerFor(questionId) },
          409,
        );
      });

      it('409s a SECOND retry of the same original', async () => {
        const { sessionId, questionId, originalId } =
          await sessionWithMisheardAttempt(learnerA);

        await postAttempt(learnerA, sessionId, {
          questionId,
          responseText: 'still not it',
          retryOfAttemptId: originalId,
        });

        await postAttempt(
          learnerA,
          sessionId,
          {
            questionId,
            responseText: correctAnswerFor(questionId),
            retryOfAttemptId: originalId,
          },
          409,
        );
      });

      it('409s retrying an attempt that is itself a retry — the chain stops at two', async () => {
        const { sessionId, questionId, originalId } =
          await sessionWithMisheardAttempt(learnerA);

        const retry = await postAttempt(learnerA, sessionId, {
          questionId,
          responseText: 'still not it',
          retryOfAttemptId: originalId,
        });

        await postAttempt(
          learnerA,
          sessionId,
          {
            questionId,
            responseText: correctAnswerFor(questionId),
            retryOfAttemptId: retry.attempt.id,
          },
          409,
        );
      });

      it('404s — never 403s — a retry naming ANOTHER learner’s attempt', async () => {
        // The rule this whole module follows: a 403 would confirm the id names
        // a real attempt, which is itself the leak.
        const mine = await sessionWithMisheardAttempt(learnerA);
        const theirs = await sessionWithMisheardAttempt(learnerB);

        await postAttempt(
          learnerA,
          mine.sessionId,
          {
            questionId: mine.questionId,
            responseText: correctAnswerFor(mine.questionId),
            retryOfAttemptId: theirs.originalId,
          },
          404,
        );
      });

      it('404s a retry naming an attempt at a different question', async () => {
        const { sessionId, questionId, originalId } =
          await sessionWithMisheardAttempt(learnerA);
        const otherQuestionId = questionId === Q1 ? Q2 : Q1;

        await postAttempt(
          learnerA,
          sessionId,
          {
            questionId: otherQuestionId,
            responseText: correctAnswerFor(otherQuestionId),
            retryOfAttemptId: originalId,
          },
          404,
        );
      });

      it('404s a retry naming an attempt from a different session', async () => {
        const first = await sessionWithMisheardAttempt(learnerA);
        // Starting a second session abandons the first, so this one is where a
        // new attempt can be posted at all.
        const second = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

        await postAttempt(
          learnerA,
          second.session.id,
          {
            questionId: second.nextQuestion.id,
            responseText: correctAnswerFor(second.nextQuestion.id),
            retryOfAttemptId: first.originalId,
          },
          404,
        );
      });

      it('excludes the superseded attempt from progress.answered AND from the summary, and the two agree', async () => {
        // The property §3.2 exists for: a mishearing and its correction read
        // as ONE answered question, in the live progress counter and in the
        // summary that is written once and read forever.
        const { sessionId, questionId, originalId } =
          await sessionWithMisheardAttempt(learnerA);

        const retry = await postAttempt(learnerA, sessionId, {
          questionId,
          responseText: correctAnswerFor(questionId),
          retryOfAttemptId: originalId,
        });

        // Two rows in the table, one answered question in the count.
        expect(retry.progress.answered).toBe(1);
        expect(
          Array.from(attempts.values()).filter((a) => a.sessionId === sessionId),
        ).toHaveLength(2);

        const resumed = await request(server())
          .get(`/api/practice/sessions/${sessionId}`)
          .set(authHeader(learnerA.accessToken))
          .expect(200);

        // Both rows are RETURNED — a review screen renders the pair — while
        // only one is COUNTED.
        expect(resumed.body.data.attempts).toHaveLength(2);
        expect(resumed.body.data.progress.answered).toBe(1);

        // And the session is NOT finished: `nextQuestionFor` compares against
        // `plannedCount` using this same count, so a mishearing plus its
        // correction must not end a two-question session after one.
        expect(resumed.body.data.nextQuestion).not.toBeNull();
        expect(retry.nextQuestion).not.toBeNull();

        const completed = await request(server())
          .post(`/api/practice/sessions/${sessionId}/complete`)
          .set(authHeader(learnerA.accessToken))
          .expect(201);

        expect(completed.body.data.summary).toMatchObject({
          answered: 1,
          correct: 1,
          // NOT 1. The misheard attempt is not counted as a failure — that is
          // the whole point of superseding it rather than leaving it in.
          incorrect: 0,
        });
        expect(completed.body.data.summary.answered).toBe(
          resumed.body.data.progress.answered,
        );
      });
    });

    describe('the body has to be self-consistent — 400 through the global Zod pipe', () => {
      it('rejects a transcript or a confidence on a typed attempt', async () => {
        const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });
        const questionId = created.nextQuestion.id;

        await postAttempt(
          learnerA,
          created.session.id,
          { questionId, responseText: 'x', transcript: 'x' },
          400,
        );

        await postAttempt(
          learnerA,
          created.session.id,
          { questionId, responseText: 'x', asrConfidence: 0.41 },
          400,
        );
      });

      it('rejects a spoken attempt that was answered but carries no transcript', async () => {
        const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

        await postAttempt(
          learnerA,
          created.session.id,
          { questionId: created.nextQuestion.id, responseText: 'x', inputMode: 'spoken' },
          400,
        );
      });

      it('still refuses to let the client state a verdict, by any of its new names', async () => {
        const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });
        const questionId = created.nextQuestion.id;

        for (const key of ['failureCause', 'misheard', 'transcriptConfidence']) {
          await postAttempt(
            learnerA,
            created.session.id,
            { questionId, responseText: 'x', [key]: 'misheard' },
            400,
          );
        }
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/practice/queue (issue #78, epic #54 / E5 "Memory")
  // ---------------------------------------------------------------------------

  describe('GET /api/practice/queue', () => {
    /** Directly writes a `question_mastery` row into the in-memory store —
     * bypassing the API, since these tests are about what `getQueue` reports
     * GIVEN a mastery state, not about how that state was reached (the
     * "mastery scheduling wiring" describe block below covers reaching it
     * through the real attempt/self-mark endpoints). */
    function seedMastery(userId: string, questionId: string, overrides: Record<string, any>) {
      mastery.set(`${userId}:${questionId}`, {
        id: randomUUID(),
        userId,
        questionId,
        state: 'learning',
        dueAt: null,
        intervalDays: 1,
        ease: 2.5,
        correctStreak: 1,
        lapses: 0,
        totalAttempts: 1,
        distinctCorrectDays: 1,
        lastOutcome: 'correct',
        lastAttemptAt: new Date('2026-07-01T00:00:00Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      });
    }

    it('returns the documented shape and correct per-bucket counts for a mix of due/weak/new/steady/mastered rows, excluding an unanswerable state-scope question for a stateless learner', async () => {
      const learnerQueue = await createMockViewerUser(context, 'learnerQueue@example.com');
      profiles.set(learnerQueue.id, {
        stateCode: null,
        testVersionCode: QUEUE_TV,
        seniorExemption: false,
      });

      const now = '2026-08-01T12:00:00.000Z';

      seedMastery(learnerQueue.id, Q_DUE, {
        state: 'review',
        dueAt: new Date('2026-08-01T11:00:00.000Z'), // 1h in the past
      });
      seedMastery(learnerQueue.id, Q_WEAK, {
        state: 'lapsed',
        dueAt: new Date('2026-08-02T08:00:00.000Z'), // in the future — weak, not due
        lapses: 1,
      });
      seedMastery(learnerQueue.id, Q_STEADY, {
        state: 'learning',
        dueAt: null,
        correctStreak: 2,
        lapses: 0,
      });
      seedMastery(learnerQueue.id, Q_MASTERED, {
        state: 'mastered',
        dueAt: null,
      });
      // Q_NEW_A and Q_NEW_B get no mastery row at all — never attempted.
      // Q_STATE_SCOPE also gets no row — it must not appear in ANY count.

      const response = await request(server())
        .get('/api/practice/queue')
        .set(authHeader(learnerQueue.accessToken))
        .set('X-Test-Clock', now)
        .expect(200);

      const body = response.body.data;

      expect(body.testVersionCode).toBe(QUEUE_TV);
      // 6, not 7 — Q_STATE_SCOPE is excluded for this stateless learner,
      // exactly as `candidateQuestions`' selector would exclude it too.
      expect(body.total).toBe(6);
      expect(body.due).toBe(1);
      expect(body.weak).toBe(1);
      expect(body.learning).toBe(1); // the STEADY bucket, under the `learning` key
      expect(body.mastered).toBe(1);
      expect(body.new.total).toBe(2);

      const byCategory = [...body.new.byCategory].sort((a: any, b: any) =>
        a.categoryId.localeCompare(b.categoryId),
      );
      expect(byCategory).toEqual([
        { categoryId: QUEUE_CAT_A, categoryName: 'Category A', newCount: 1 },
        { categoryId: QUEUE_CAT_B, categoryName: 'Category B', newCount: 1 },
      ]);

      // Every count is over exactly the FIVE buckets plus new — sums to total.
      expect(body.due + body.weak + body.learning + body.mastered + body.new.total).toBe(
        body.total,
      );
    });

    it('400s a learner who has not finished orientation (no resolved test version)', async () => {
      const unoriented = await createMockViewerUser(context, 'unoriented@example.com');
      profiles.set(unoriented.id, { stateCode: null, testVersionCode: null, seniorExemption: false });

      await request(server())
        .get('/api/practice/queue')
        .set(authHeader(unoriented.accessToken))
        .expect(400);
    });

    it('401s an unauthenticated request', async () => {
      await request(server()).get('/api/practice/queue').expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Synchronous mastery scheduling wiring (issue #78, epic #54 / E5 "Memory")
  // ---------------------------------------------------------------------------

  describe('mastery scheduling wiring', () => {
    it('a correct attempt via POST .../attempts upserts and advances the question_mastery row: new -> learning, dueAt in the future', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });
      const questionId = created.nextQuestion.id;

      expect(mastery.get(`${learnerA.id}:${questionId}`)).toBeUndefined();

      const answeredAt = '2026-07-10T09:00:00.000Z';

      await request(server())
        .post(`/api/practice/sessions/${created.session.id}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .set('X-Test-Clock', answeredAt)
        .send({ questionId, responseText: correctAnswerFor(questionId) })
        .expect(201);

      const row = mastery.get(`${learnerA.id}:${questionId}`);
      expect(row).toBeDefined();
      expect(row!.state).toBe('learning');
      expect(row!.totalAttempts).toBe(1);
      expect(row!.correctStreak).toBe(1);
      expect(row!.dueAt).toBeInstanceOf(Date);
      expect(row!.dueAt.getTime()).toBeGreaterThan(new Date(answeredAt).getTime());
      expect(row!.lastOutcome).toBe('correct');
    });

    it('self-marking an attempt advances mastery via the SELF-MARKED (discounted) path, not the plain-correct path, applying a strictly smaller ease bump', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });
      const questionId = created.nextQuestion.id;

      const wrongAt = '2026-07-10T09:00:00.000Z';
      const wrongResponse = await request(server())
        .post(`/api/practice/sessions/${created.session.id}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .set('X-Test-Clock', wrongAt)
        .send({ questionId, responseText: 'definitely not it', revealed: true })
        .expect(201);

      const attemptId = wrongResponse.body.data.attempt.id;

      // The mastery row exactly as the required precondition incorrect
      // grading left it — the REAL starting point self-mark's own scheduling
      // call reads inside `scheduleMastery`.
      const beforeSelfMark = mastery.get(`${learnerA.id}:${questionId}`);
      expect(beforeSelfMark).toBeDefined();

      const startingRecord = {
        state: beforeSelfMark!.state,
        dueAt: beforeSelfMark!.dueAt,
        intervalDays: beforeSelfMark!.intervalDays,
        ease: beforeSelfMark!.ease,
        correctStreak: beforeSelfMark!.correctStreak,
        lapses: beforeSelfMark!.lapses,
        totalAttempts: beforeSelfMark!.totalAttempts,
        distinctCorrectDays: beforeSelfMark!.distinctCorrectDays,
        lastOutcome: fromStoredMasteryOutcome(beforeSelfMark!.lastOutcome),
        lastAttemptAt: beforeSelfMark!.lastAttemptAt,
      };

      const selfMarkAt = '2026-07-11T09:00:00.000Z';

      // The pure scheduler, used as an ORACLE (never re-implemented, never
      // guessed) for what each path would produce from this exact starting
      // point — the same function `scheduleMastery` itself calls.
      const viaPlainCorrect = nextSchedule(startingRecord, 'correct', new Date(selfMarkAt));
      const viaSelfMarked = nextSchedule(startingRecord, 'correct_self_marked', new Date(selfMarkAt));

      // Sanity on the oracle itself before trusting the comparison below.
      expect(viaSelfMarked.ease).toBeLessThan(viaPlainCorrect.ease);

      const selfMarked = await request(server())
        .post(
          `/api/practice/sessions/${created.session.id}/attempts/${attemptId}/self-mark`,
        )
        .set(authHeader(learnerA.accessToken))
        .set('X-Test-Clock', selfMarkAt)
        .expect(201);

      expect(selfMarked.body.data.gradingMethod).toBe('self');

      const afterSelfMark = mastery.get(`${learnerA.id}:${questionId}`);
      expect(afterSelfMark).toBeDefined();

      // The DISCOUNTED path was taken: ease matches the self-marked oracle
      // exactly, and NOT the full-credit oracle.
      expect(afterSelfMark!.ease).toBeCloseTo(viaSelfMarked.ease, 5);
      expect(afterSelfMark!.ease).not.toBeCloseTo(viaPlainCorrect.ease, 5);
      expect(afterSelfMark!.intervalDays).toBe(viaSelfMarked.intervalDays);
      // `question_mastery.last_outcome` only has room for the collapsed
      // 2-value form (mastery/outcome-mapping.ts) — never the 3-value
      // AttemptOutcome the scheduler itself returned.
      expect(afterSelfMark!.lastOutcome).toBe('correct');
    });

    // -------------------------------------------------------------------------
    // Stage transitions (issue #82, epic #54 / E5 "Memory")
    // -------------------------------------------------------------------------
    //
    // `nextStageOnMasteryEvent`'s own unit coverage
    // (`journey/stage-transitions.spec.ts`) proves the decision in isolation;
    // this proves it survives the wire — inside the SAME transaction as the
    // `question_mastery` write that produced it, per
    // `PracticeService.scheduleMastery`'s own header.
    it('advances stage to remembering when an attempt promotes a question to mastered while the learner is still learning', async () => {
      profiles.set(learnerA.id, {
        ...profiles.get(learnerA.id)!,
        stage: 'learning',
      });

      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });
      const questionId = created.nextQuestion.id;

      // Directly seed the mastery row one distinct correct day short of the
      // `review -> mastered` promotion threshold (`MASTERY_PROMOTION_THRESHOLD`
      // = 3, `scheduler.ts`) — bypassing the API, exactly as `seedMastery` in
      // the queue-counts fixtures above does, since this test is about the
      // STAGE consequence of a crossing, not about how the crossing was
      // reached.
      mastery.set(`${learnerA.id}:${questionId}`, {
        id: randomUUID(),
        userId: learnerA.id,
        questionId,
        state: 'review',
        dueAt: new Date('2026-07-05T00:00:00.000Z'),
        intervalDays: 3,
        ease: 2.6,
        correctStreak: 2,
        lapses: 0,
        totalAttempts: 2,
        distinctCorrectDays: 2,
        lastOutcome: 'correct',
        lastAttemptAt: new Date('2026-07-01T09:00:00.000Z'),
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T09:00:00.000Z'),
      });

      // A DIFFERENT UTC calendar day from the seeded `lastAttemptAt`, so
      // `nextSchedule`'s distinct-day rule actually increments the counter
      // to 3 rather than treating this as a same-day repeat.
      const answeredAt = '2026-07-10T09:00:00.000Z';

      await request(server())
        .post(`/api/practice/sessions/${created.session.id}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .set('X-Test-Clock', answeredAt)
        .send({ questionId, responseText: correctAnswerFor(questionId) })
        .expect(201);

      // The crossing actually happened — the precondition this test is
      // about, not an incidental detail.
      const row = mastery.get(`${learnerA.id}:${questionId}`);
      expect(row!.state).toBe('mastered');
      expect(row!.distinctCorrectDays).toBe(3);

      // The stage advanced in the SAME request, persisted to the SAME
      // in-memory `learner_profiles` row a follow-up read would see —
      // the pattern this file's other mastery-scheduling tests already use
      // for asserting a persisted side effect (`mastery.get(...)` above).
      expect(profiles.get(learnerA.id)?.stage).toBe('remembering');
    });

    it('does NOT advance stage on an attempt that does not cross into mastered', async () => {
      profiles.set(learnerA.id, {
        ...profiles.get(learnerA.id)!,
        stage: 'learning',
      });

      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });
      const questionId = created.nextQuestion.id;

      // No mastery row at all — this attempt only advances `new -> learning`,
      // nowhere near a `mastered` crossing.
      await request(server())
        .post(`/api/practice/sessions/${created.session.id}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .set('X-Test-Clock', '2026-07-10T09:00:00.000Z')
        .send({ questionId, responseText: correctAnswerFor(questionId) })
        .expect(201);

      expect(mastery.get(`${learnerA.id}:${questionId}`)!.state).toBe('learning');
      expect(profiles.get(learnerA.id)?.stage).toBe('learning');
    });

    it('advances stage to learning on ANY schedulable outcome while still oriented — even an incorrect one', async () => {
      profiles.set(learnerA.id, {
        ...profiles.get(learnerA.id)!,
        stage: 'oriented',
      });

      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });
      const questionId = created.nextQuestion.id;

      await request(server())
        .post(`/api/practice/sessions/${created.session.id}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .set('X-Test-Clock', '2026-07-10T09:00:00.000Z')
        .send({ questionId, responseText: 'definitely not it' })
        .expect(201);

      expect(profiles.get(learnerA.id)?.stage).toBe('learning');
    });

    it('a state_required attempt does NOT create or advance a question_mastery row', async () => {
      const stateless = await createMockViewerUser(context, 'stateless@example.com');
      profiles.set(stateless.id, { stateCode: null, testVersionCode: TV2, seniorExemption: false });

      // TV2's pool is {Q3 (state-scope), Q4 (answerable)} — Q3 is excluded
      // from SELECTION entirely (excludeUnanswerable), so the session's own
      // `nextQuestion` can only ever be Q4. Q3 is reachable only because a
      // client can name any question in the session's own test version
      // directly, exactly as `resolveAcceptedAnswers`'s own doc comment
      // describes ("this only fires for a question id a client posted rather
      // than was handed").
      const created = await startSession(stateless, { kind: 'quick', plannedCount: 1 });
      expect(created.nextQuestion.id).toBe(Q4);

      expect(mastery.get(`${stateless.id}:${Q3}`)).toBeUndefined();

      const response = await request(server())
        .post(`/api/practice/sessions/${created.session.id}/attempts`)
        .set(authHeader(stateless.accessToken))
        .send({ questionId: Q3, responseText: 'Gavin Newsom' })
        .expect(201);

      expect(response.body.data.attempt.outcome).toBe('skipped');

      // No mastery row was created for Q3 — the attempt was recorded (it did
      // happen), but there is no honest grade to schedule against.
      expect(mastery.get(`${stateless.id}:${Q3}`)).toBeUndefined();
      expect(mastery.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // The realtime transport (issue #354, epic #345 / E15)
  // ---------------------------------------------------------------------------

  describe('realtime tool calls', () => {
    /** Pinned so both transports stamp the SAME `answeredAt`. See below. */
    const PINNED = '2026-06-01T12:00:00Z';

    /** Post one tool call and return the envelope's `data`. */
    async function toolCall(
      user: TestUser,
      sessionId: string,
      body: Record<string, unknown>,
      status = 200,
    ) {
      const response = await request(server())
        .post(`/api/practice/sessions/${sessionId}/realtime/tool-calls`)
        .set(authHeader(user.accessToken))
        .set('x-test-clock', PINNED)
        .send(body)
        .expect(status);

      return response.body.data;
    }

    /** Every `practice_attempts` row written so far, as the write saw it. */
    function writtenAttempts(): Record<string, unknown>[] {
      return (prismaMock.practiceAttempt.create as jest.Mock).mock.calls.map(
        (args: any[]) => args[0].data,
      );
    }

    // -------------------------------------------------------------------------
    // THE EQUIVALENCE TEST
    // -------------------------------------------------------------------------

    it('writes the same row a typed POST .../attempts writes, column for column', async () => {
      // ---------------------------------------------------------------------
      // THE SINGLE MOST IMPORTANT TEST IN #354, AND HOW IT IS CONSTRUCTED
      // ---------------------------------------------------------------------
      //
      // One learner, one transcript, one question, one pinned instant — driven
      // twice, once through each transport, and the two `practice_attempts`
      // writes compared as whole objects.
      //
      // WHY WHOLE OBJECTS AND NOT A LIST OF FIELDS. A test that named the
      // columns it cared about would keep passing on the day `recordAttempt`
      // grows a column that only one of the two paths sets — which is exactly
      // the drift this epic exists to prevent, and exactly what a second
      // grading ladder would look like from the outside. `create`'s `data` IS
      // the row, so a column added later is compared automatically, by nobody
      // having to remember.
      //
      // WHY THE CLOCK IS PINNED. `answeredAt` and the `resolvedAt` frozen into
      // `answerSnapshot` both come from `Clock`, so two calls a few
      // milliseconds apart differ honestly. Pinning both requests to the same
      // instant removes the one difference that is not about the transport —
      // and it means `answeredAt` is COMPARED rather than excluded, which is a
      // stronger test than the issue asks for.
      //
      // WHY `sessionId` IS THE ONE EXCLUSION. A question may be answered once
      // per session (`recordAttempt`'s own guard), so the same question
      // answered twice is necessarily two sessions. `id` is not excluded
      // because it is not in `data` at all — the database generates it.
      // Everything else, `userId` and `questionId` included, must match.
      const first = await startSession(learnerA, { kind: 'quick', plannedCount: 1 });
      const sessionA = first.session.id;

      // ---- transport 1: the realtime tool calls ---------------------------
      //
      // WHICH question comes from the TOOL RESULT, never from the session's own
      // `nextQuestion`: `mastery/selector.ts` shuffles, so those two reads can
      // legitimately name different questions. Whatever `next_question` served
      // is what the coach spoke and what the answer is about.
      const asked = await toolCall(learnerA, sessionA, { tool: 'next_question' });
      const questionId = asked.questionId as string;
      const transcript = correctAnswerFor(questionId);

      await toolCall(learnerA, sessionA, {
        tool: 'grade_answer',
        questionId,
        transcript,
      });

      await request(server())
        .post(`/api/practice/sessions/${sessionA}/complete`)
        .set(authHeader(learnerA.accessToken))
        .set('x-test-clock', PINNED)
        .expect(201);

      // ---- transport 2: the ordinary attempt route ------------------------
      const second = await startSession(learnerA, { kind: 'quick', plannedCount: 1 });

      await request(server())
        .post(`/api/practice/sessions/${second.session.id}/attempts`)
        .set(authHeader(learnerA.accessToken))
        .set('x-test-clock', PINNED)
        .send({
          questionId,
          responseText: transcript,
          transcript,
          inputMode: 'spoken',
          promptMode: 'heard',
        })
        .expect(201);

      // ---- the comparison -------------------------------------------------
      const [viaRealtime, viaHttp] = writtenAttempts();

      // Both wrote something, and both wrote the SAME SET of columns. A path
      // that omitted one entirely would fail here rather than compare equal on
      // the columns it happened to share.
      expect(Object.keys(viaRealtime).sort()).toEqual(
        Object.keys(viaHttp).sort(),
      );

      // The columns whose values a wrong implementation would most plausibly
      // get right by accident are named here, so a reader can see the
      // comparison is not vacuous — but the assertion that MATTERS is the
      // object comparison below, which covers every column including the ones
      // nobody has written yet.
      expect(viaRealtime).toMatchObject({
        userId: learnerA.id,
        questionId,
        source: 'practice',
        inputMode: 'spoken',
        promptMode: 'heard',
        outcome: 'correct',
        gradingMethod: 'exact',
        responseText: transcript,
        transcript,
        asrConfidence: null,
        retryOfAttemptId: null,
        revealed: false,
        hintUsed: false,
      });

      const { sessionId: _realtimeSession, ...realtimeRow } = viaRealtime;
      const { sessionId: _httpSession, ...httpRow } = viaHttp;

      expect(realtimeRow).toEqual(httpRow);
    });

    it('a skip records outcome "skipped", never "incorrect"', async () => {
      // The false claim this prevents: an empty answer graded is `incorrect` —
      // evidence that somebody answered and missed — about a learner who
      // declined to answer at all.
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 1 });

      const asked = await toolCall(learnerA, created.session.id, {
        tool: 'next_question',
      });

      await toolCall(learnerA, created.session.id, {
        tool: 'skip_question',
        questionId: asked.questionId,
      });

      const [row] = writtenAttempts();

      expect(row).toMatchObject({
        outcome: 'skipped',
        responseText: null,
        transcript: null,
        // FALSE, DELIBERATELY: the accepted answer is spoken after the row is
        // written, and `revealed` is the precondition for self-marking.
        revealed: false,
        inputMode: 'spoken',
        promptMode: 'heard',
      });
    });

    it('speaks the composed turn, including the verdict', async () => {
      // Issue #351's own fix reaching this transport: a learner who was wrong
      // and a learner who was right must not hear byte-identical audio.
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

      const asked = await toolCall(learnerA, created.session.id, {
        tool: 'next_question',
      });

      const wrong = await toolCall(learnerA, created.session.id, {
        tool: 'grade_answer',
        questionId: asked.questionId,
        transcript: 'something that is not an accepted answer',
      });

      expect(wrong.say.length).toBeGreaterThan(1);
      expect(wrong.say.join(' ')).toContain('didn’t match');
      // AN ACTION, NEVER AN OUTCOME — and no verdict-shaped field anywhere.
      expect(wrong.then).toBe('ask_next_question');
      for (const forbidden of ['outcome', 'correct', 'score', 'failureCause']) {
        expect(wrong).not.toHaveProperty(forbidden);
      }
    });

    it('serves the question prompt verbatim, and repeats it for free', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

      const asked = await toolCall(learnerA, created.session.id, {
        tool: 'next_question',
      });
      const again = await toolCall(learnerA, created.session.id, {
        tool: 'repeat_question',
      });

      // The question's own prompt, one element, no frame around it — and the
      // repeat is the SAME words for the SAME question, not a fresh draw from
      // a shuffled selector.
      const prompt = QUESTIONS.find((q) => q.id === asked.questionId)!.prompt;

      expect(asked.say).toEqual([prompt]);
      expect(again).toMatchObject({ say: [prompt], questionId: asked.questionId });
      expect(writtenAttempts()).toEqual([]);
    });

    it('refuses a second question while an answer is outstanding — as a 200', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

      await toolCall(learnerA, created.session.id, { tool: 'next_question' });
      const refused = await toolCall(learnerA, created.session.id, {
        tool: 'next_question',
      });

      // EVERY REFUSAL IS A 200 WITH THREE FIELDS. A non-2xx would be flattened
      // by the realtime relay into generic failure handling, and `instruction`
      // — the field that gets the session moving again — would never reach the
      // model.
      expect(refused).toEqual({
        status: 'rejected',
        tool: 'next_question',
        reason: 'answer_outstanding',
        error: expect.any(String),
        instruction: expect.any(String),
      });
    });

    it('refuses an answer to a question the session is not waiting on', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

      const asked = await toolCall(learnerA, created.session.id, {
        tool: 'next_question',
      });
      const other = asked.questionId === Q1 ? Q2 : Q1;

      const refused = await toolCall(learnerA, created.session.id, {
        tool: 'grade_answer',
        questionId: other,
        transcript: correctAnswerFor(other),
      });

      expect(refused.reason).toBe('wrong_question');
      // NEVER SILENTLY ATTRIBUTED — and nothing was recorded for either
      // question.
      expect(writtenAttempts()).toEqual([]);
    });

    it('refuses a blank transcript rather than recording a miss', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

      const asked = await toolCall(learnerA, created.session.id, {
        tool: 'next_question',
      });

      const refused = await toolCall(learnerA, created.session.id, {
        tool: 'grade_answer',
        questionId: asked.questionId,
        transcript: '   ',
      });

      expect(refused.reason).toBe('empty_transcript');
      expect(writtenAttempts()).toEqual([]);
    });

    it('answers a duplicate with already_answered, never a 4xx or 5xx', async () => {
      // The conflict `recordAttempt` raises for a question this session has
      // already recorded, caught and converted. A duplicate is ROUTINE on this
      // transport — a retried tool call, a re-mint replaying the last turn —
      // and a non-2xx into a live, per-minute-billing connection is not an
      // acceptable answer to one.
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

      const asked = await toolCall(learnerA, created.session.id, {
        tool: 'next_question',
      });
      const questionId = asked.questionId as string;
      const transcript = correctAnswerFor(questionId);

      await toolCall(learnerA, created.session.id, {
        tool: 'grade_answer',
        questionId,
        transcript,
      });

      // The session has moved on, but the model has not: it replays the call
      // it already made. `getSession` still resolves, the rules refuse it, and
      // either way it is a 200 the relay can hand back.
      const replay = await toolCall(learnerA, created.session.id, {
        tool: 'grade_answer',
        questionId,
        transcript,
      });

      expect(replay.status).toBe('rejected');
      expect(replay.instruction.length).toBeGreaterThan(0);
      // ONE ROW, not two.
      expect(writtenAttempts()).toHaveLength(1);
    });

    it('refuses "no questions left" while questions remain, and honours it after', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 1 });

      const early = await toolCall(learnerA, created.session.id, {
        tool: 'end_session',
        reason: 'no_questions_left',
      });

      expect(early.reason).toBe('questions_remain');

      const asked = await toolCall(learnerA, created.session.id, {
        tool: 'next_question',
      });
      const questionId = asked.questionId as string;

      await toolCall(learnerA, created.session.id, {
        tool: 'grade_answer',
        questionId,
        transcript: correctAnswerFor(questionId),
      });

      const ended = await toolCall(learnerA, created.session.id, {
        tool: 'end_session',
        reason: 'no_questions_left',
      });

      expect(ended.status).toBe('ok');
      expect(ended.then).toBe('session_complete');

      // COMPLETED, WITH A SUMMARY — the same method `POST .../complete` calls.
      const detail = await request(server())
        .get(`/api/practice/sessions/${created.session.id}`)
        .set(authHeader(learnerA.accessToken))
        .expect(200);

      expect(detail.body.data.session.status).toBe('completed');
      expect(detail.body.data.session.summary.answered).toBe(1);
    });

    it('is idempotent under a double end_session', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 5 });

      const first = await toolCall(learnerA, created.session.id, {
        tool: 'end_session',
        reason: 'learner_asked',
      });
      const second = await toolCall(learnerA, created.session.id, {
        tool: 'end_session',
        reason: 'learner_asked',
      });

      // The SECOND call sees a session that is no longer `in_progress` and
      // refuses — which is the honest answer, and is still a 200 the relay can
      // hand the model. What must not happen is a second completion, a moved
      // `completedAt`, or an exception.
      expect(first.status).toBe('ok');
      expect(second.status).toBe('rejected');
      expect(second.reason).toBe('session_not_in_progress');

      const detail = await request(server())
        .get(`/api/practice/sessions/${created.session.id}`)
        .set(authHeader(learnerA.accessToken))
        .expect(200);

      expect(detail.body.data.session.status).toBe('completed');
    });

    it('refuses every tool once the session is closed', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 2 });

      await request(server())
        .post(`/api/practice/sessions/${created.session.id}/complete`)
        .set(authHeader(learnerA.accessToken))
        .expect(201);

      for (const body of [
        { tool: 'next_question' },
        { tool: 'repeat_question' },
        { tool: 'grade_answer', questionId: Q1, transcript: 'anything' },
        { tool: 'skip_question', questionId: Q1 },
        { tool: 'end_session', reason: 'learner_asked' },
      ]) {
        const refused = await toolCall(learnerA, created.session.id, body);
        expect(refused.reason).toBe('session_not_in_progress');
      }

      expect(writtenAttempts()).toEqual([]);
    });

    it('404s another learner’s session, and 401s an anonymous caller', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 1 });

      await request(server())
        .post(`/api/practice/sessions/${created.session.id}/realtime/tool-calls`)
        .set(authHeader(learnerB.accessToken))
        .send({ tool: 'next_question' })
        .expect(404);

      await request(server())
        .post(`/api/practice/sessions/${created.session.id}/realtime/tool-calls`)
        .send({ tool: 'next_question' })
        .expect(401);
    });

    it('400s a body carrying a verdict, or an argument from another tool', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 1 });
      const questionId = created.nextQuestion.id;

      // Every one of these is refused by the DTO, before any rule runs, so
      // which question is named is irrelevant.
      for (const body of [
        { tool: 'grade_answer', questionId, transcript: 'x', correct: true },
        { tool: 'grade_answer', questionId, transcript: 'x', confidence: 0.9 },
        { tool: 'skip_question', questionId, transcript: 'x' },
        { tool: 'next_question', userId: learnerB.id },
        { tool: 'reveal_answer', questionId },
      ]) {
        await request(server())
          .post(`/api/practice/sessions/${created.session.id}/realtime/tool-calls`)
          .set(authHeader(learnerA.accessToken))
          .send(body)
          .expect(400);
      }

      expect(writtenAttempts()).toEqual([]);
    });

    it('is never cached', async () => {
      const created = await startSession(learnerA, { kind: 'quick', plannedCount: 1 });

      const response = await request(server())
        .post(`/api/practice/sessions/${created.session.id}/realtime/tool-calls`)
        .set(authHeader(learnerA.accessToken))
        .send({ tool: 'next_question' })
        .expect(200);

      // The body carries the question a learner is being asked and, on the way
      // in, the words they said. Neither belongs in a shared cache, and every
      // call is answered against state the previous call moved.
      expect(response.headers['cache-control']).toBe('no-store');
    });
  });
});

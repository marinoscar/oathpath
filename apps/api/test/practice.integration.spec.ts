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
    testVersionCode: 'v2008',
    number: 3,
    categoryId: CATEGORY_ID,
    prompt: 'Who is the Governor of your state now?',
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

/** The `learner_profiles` facts practice reads, for the duration of one test. */
let profiles: Map<string, { stateCode: string | null; testVersionCode: string | null; seniorExemption: boolean }>;
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
        (where.questionId === undefined || a.questionId === where.questionId),
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
    return ids === undefined || ids.includes(CATEGORY_ID)
      ? [{ id: CATEGORY_ID, name: 'Category' }]
      : [];
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
});

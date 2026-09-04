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
// Readiness API (integration) — issue #122, epic #55 / E6 "Readiness and
// Progress"
// =============================================================================
//
// Covers `GET /api/readiness` and `GET /api/readiness/history` over real
// HTTP through `createTestApp`, with Prisma mocked — the shape
// `progress.integration.spec.ts` and `practice.integration.spec.ts` both
// establish: small in-memory stores, filtered on `where` for real, rather
// than fixed return values, because "the same snapshot comes back on a
// second call" and "a completed session's evidence is reflected on the next
// read" are both assertions about which ROW a later request sees, which a
// `mockResolvedValue` cannot express.
//
// No test in this repository touches a database (docs/TESTING.md).
// =============================================================================

const TV = 'vready2025';
const CAT_A = 'f1111111-1111-4111-8111-111111111111';

const Q1 = 'f2111111-1111-4111-8111-111111111111';
const Q2 = 'f2222222-2222-4222-8222-222222222222';
const Q3 = 'f2333333-3333-4333-8333-333333333333';

const CATEGORIES = [{ id: CAT_A, testVersionCode: TV, name: 'Category A' }];
const QUESTIONS = [
  { id: Q1, testVersionCode: TV, categoryId: CAT_A },
  { id: Q2, testVersionCode: TV, categoryId: CAT_A },
  { id: Q3, testVersionCode: TV, categoryId: CAT_A },
];

/** `learner_profiles` facts, keyed by userId. */
let profiles: Map<
  string,
  { stage: string; testVersionCode: string | null; timezone: string }
>;
/** `practice_sessions`, keyed by id. */
let sessions: Map<string, any>;
/** `practice_attempts`, keyed by id. */
let attempts: Map<string, any>;
/** `readiness_snapshots`, keyed by id — the append-only store that makes staleness/history real. */
let snapshots: Map<string, any>;

function seedProfile(
  userId: string,
  overrides: Partial<{ stage: string; testVersionCode: string | null; timezone: string }> = {},
): void {
  profiles.set(userId, {
    stage: 'oriented',
    testVersionCode: TV,
    timezone: 'UTC',
    ...overrides,
  });
}

/** Returns the seeded row's id — needed to point a later retry's `retryOfAttemptId` at it (issue #244). */
function seedAttempt(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string | undefined) ?? randomUUID();
  attempts.set(id, {
    id,
    userId: overrides.userId,
    questionId: Q1,
    sessionId: null,
    source: 'practice',
    inputMode: 'typed',
    promptMode: 'read',
    responseText: 'an answer',
    outcome: 'correct',
    gradingMethod: 'exact',
    // Explicit, rather than left absent, so a test that mixes null and
    // non-null `failureCause` rows (issue #244) can rely on this default
    // rather than each call site spelling it out.
    failureCause: null,
    retryOfAttemptId: null,
    revealed: false,
    hintUsed: false,
    durationMs: null,
    answeredAt: new Date('2026-04-01T12:00:00.000Z'),
    ...overrides,
  });
  return id;
}

/**
 * Wire `learner_profiles`, `civics_questions`, `question_mastery`,
 * `practice_sessions`, `practice_attempts` and `readiness_snapshots` into
 * the shared Prisma mock as small in-memory stores, filtering on `where`
 * for real — the same convention `progress.integration.spec.ts` and
 * `practice.integration.spec.ts` both establish. `readinessSnapshot`'s
 * generic `setupBaseMocks()` default (`test/fixtures/mock-setup.helper.ts`)
 * is overridden here with a real store, because this suite's own
 * assertions are specifically about which snapshot row a later request
 * sees.
 */
function setupReadinessMocks(): void {
  profiles = new Map();
  sessions = new Map();
  attempts = new Map();
  snapshots = new Map();

  (prismaMock.learnerProfile.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => profiles.get(where.userId) ?? null,
  );

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

  (prismaMock.civicsQuestion.findMany as jest.Mock).mockImplementation(
    async ({ where = {} }: any) => QUESTIONS.filter((q) => q.testVersionCode === where.testVersionCode),
  );

  // No `question_mastery` rows are seeded by any test in this file — every
  // test here drives evidence entirely through `practice_attempts`, which is
  // enough to prove staleness/idempotency/history without also standing up
  // the mastery scheduler.
  (prismaMock.questionMastery.findMany as jest.Mock).mockResolvedValue([]);

  (prismaMock.practiceSession.findFirst as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      const session = sessions.get(where.id);
      return session && session.userId === where.userId ? session : null;
    },
  );

  (prismaMock.practiceSession.update as jest.Mock).mockImplementation(
    async ({ where, data }: any) => {
      const existing = sessions.get(where.id);
      const next = { ...existing, ...data };
      sessions.set(where.id, next);
      return { ...next };
    },
  );

  // ---------------------------------------------------------------------------
  // Three-valued (NULL-aware) `where` evaluation — issue #244
  // ---------------------------------------------------------------------------
  //
  // Real SQL — and therefore real Postgres via Prisma — uses THREE-valued
  // logic: comparing a column against NULL evaluates to NULL/UNKNOWN, not to
  // `true` or `false`, and a `WHERE` clause keeps only rows where the whole
  // expression is TRUE (UNKNOWN drops the row, exactly like FALSE does). A
  // naive mock built from plain `===`/`!==` comparisons has no such
  // distinction, so it can "pass" a `where` clause that is subtly wrong
  // under real SQL — which is exactly the class of bug issue #244 fixed in
  // `readiness.service.ts`'s recall query (see that file's "WHY (1) IS AN
  // EXPLICIT `OR ... IS NULL`" comment). `evalAttemptWhere` exists so this
  // mock can tell the two spellings apart the same way a real database
  // would, rather than merely echoing back whatever `where` object the
  // production code happened to build.
  //
  // This is what makes `readiness.service.spec.ts`'s "recall NULL trap"
  // test (issue #244) a level below this one: that unit test can only pin
  // the *shape* of the `where` object Prisma is called with. This
  // evaluator, applied over a real HTTP round trip through the actual
  // `AppModule`, additionally proves what ROWS that clause would keep —
  // catching a regression that swaps in a differently-shaped but equally
  // plausible-looking (and equally wrong) `where` object.
  type Tri = true | false | null;

  const triAnd = (a: Tri, b: Tri): Tri =>
    a === false || b === false ? false : a === null || b === null ? null : true;
  const triOr = (a: Tri, b: Tri): Tri =>
    a === true || b === true ? true : a === null || b === null ? null : false;
  const triNot = (a: Tri): Tri => (a === null ? null : !a);

  /** `column = target`, NULL-aware: NULL compared to anything is UNKNOWN, never TRUE or FALSE. */
  function triEquals(columnValue: unknown, target: unknown): Tri {
    if (columnValue === null || columnValue === undefined) return null;
    return columnValue === target;
  }

  function evalAttemptWhereField(row: any, key: string, cond: unknown): Tri {
    if (cond === undefined) return true;

    switch (key) {
      case 'userId':
      case 'sessionId':
      case 'hintUsed':
      case 'revealed':
      case 'inputMode':
      case 'outcome':
        return row[key] === cond;
      case 'answeredAt': {
        const gte = (cond as any)?.gte as Date | undefined;
        return gte ? row.answeredAt.getTime() >= gte.getTime() : true;
      }
      case 'failureCause': {
        // `failure_cause` is NULLABLE, and NULL is its overwhelmingly common
        // value (every deterministically-graded attempt has one) — the same
        // fact `readiness.service.ts`'s own comment states. `{ not: x }`
        // reproduces Postgres's `<> `: NULL stays NULL/UNKNOWN, never TRUE.
        const value = row.failureCause ?? null;
        if (cond === null) return value === null;
        if (typeof cond === 'object' && cond !== null && 'not' in (cond as any)) {
          return triNot(triEquals(value, (cond as any).not));
        }
        return triEquals(value, cond);
      }
      case 'retries': {
        // `{ none: {} }` — no OTHER attempt's `retryOfAttemptId` names this
        // row. An existence check, not a nullable-column comparison, so it
        // carries no three-valued ambiguity of its own.
        if ((cond as any)?.none !== undefined) {
          const isSuperseded = Array.from(attempts.values()).some(
            (candidate) => candidate.retryOfAttemptId === row.id,
          );
          return !isSuperseded;
        }
        return true;
      }
      case 'OR': {
        const clauses = cond as Record<string, unknown>[];
        return clauses.reduce<Tri>((acc, sub) => triOr(acc, evalAttemptWhere(row, sub)), false);
      }
      case 'AND': {
        const clauses = Array.isArray(cond)
          ? (cond as Record<string, unknown>[])
          : [cond as Record<string, unknown>];
        return clauses.reduce<Tri>((acc, sub) => triAnd(acc, evalAttemptWhere(row, sub)), true);
      }
      case 'NOT': {
        const clauses = Array.isArray(cond)
          ? (cond as Record<string, unknown>[])
          : [cond as Record<string, unknown>];
        return clauses.reduce<Tri>((acc, sub) => triAnd(acc, triNot(evalAttemptWhere(row, sub))), true);
      }
      default:
        // Unrecognized key: not filtered on — the same permissive default
        // this mock has always had for a field none of these suites read.
        return true;
    }
  }

  function evalAttemptWhere(row: any, where: Record<string, unknown>): Tri {
    return Object.entries(where).reduce<Tri>(
      (acc, [key, cond]) => triAnd(acc, evalAttemptWhereField(row, key, cond)),
      true,
    );
  }

  /** A row is kept only when the whole clause is TRUE — UNKNOWN (null) excludes it, exactly like Postgres. */
  function matchesAttemptWhere(row: any, where: Record<string, unknown>): boolean {
    return evalAttemptWhere(row, where) === true;
  }

  (prismaMock.practiceAttempt.findMany as jest.Mock).mockImplementation(
    async ({ where = {}, orderBy, take, distinct }: any) => {
      let rows = Array.from(attempts.values()).filter((row) => matchesAttemptWhere(row, where));

      if (orderBy?.answeredAt === 'desc') {
        rows = rows.slice().sort((a, b) => b.answeredAt.getTime() - a.answeredAt.getTime());
      }

      if (Array.isArray(distinct) && distinct.includes('questionId')) {
        const seen = new Set<string>();
        rows = rows.filter((row) => {
          if (seen.has(row.questionId)) return false;
          seen.add(row.questionId);
          return true;
        });
      }

      if (typeof take === 'number') {
        rows = rows.slice(0, take);
      }

      return rows.map((row) => ({ ...row }));
    },
  );

  (prismaMock.practiceAttempt.findFirst as jest.Mock).mockImplementation(
    async ({ where = {}, orderBy }: any) => {
      let rows = Array.from(attempts.values()).filter((row) => matchesAttemptWhere(row, where));
      if (orderBy?.answeredAt === 'desc') {
        rows = rows.slice().sort((a, b) => b.answeredAt.getTime() - a.answeredAt.getTime());
      }
      return rows[0] ? { ...rows[0] } : null;
    },
  );

  (prismaMock.readinessSnapshot.create as jest.Mock).mockImplementation(
    async ({ data }: any) => {
      const row = { id: randomUUID(), createdAt: new Date(), narrative: null, narrativeGeneratedAt: null, ...data };
      snapshots.set(row.id, row);
      return { ...row };
    },
  );

  (prismaMock.readinessSnapshot.findFirst as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      const rows = Array.from(snapshots.values())
        .filter((row) => row.userId === where.userId)
        .sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime());
      return rows[0] ? { ...rows[0] } : null;
    },
  );

  (prismaMock.readinessSnapshot.findMany as jest.Mock).mockImplementation(
    async ({ where, skip = 0, take }: any) => {
      const rows = Array.from(snapshots.values())
        .filter((row) => row.userId === where.userId)
        .sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime());
      return rows.slice(skip, take ? skip + take : undefined).map((row) => ({ ...row }));
    },
  );

  (prismaMock.readinessSnapshot.count as jest.Mock).mockImplementation(async ({ where }: any) => {
    return Array.from(snapshots.values()).filter((row) => row.userId === where.userId).length;
  });
}

describe('Readiness (Integration)', () => {
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
    setupReadinessMocks();

    learnerA = await createMockViewerUser(context, 'readinessLearnerA@example.com');
    learnerB = await createMockViewerUser(context, 'readinessLearnerB@example.com');

    seedProfile(learnerA.id);
    seedProfile(learnerB.id);
  });

  const server = () => context.app.getHttpServer();

  function getReadiness(user: TestUser) {
    return request(server()).get('/api/readiness').set(authHeader(user.accessToken));
  }

  function getHistory(user: TestUser, query = '') {
    return request(server())
      .get(`/api/readiness/history${query}`)
      .set(authHeader(user.accessToken));
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  it('401s an unauthenticated request to GET /api/readiness', async () => {
    await request(server()).get('/api/readiness').expect(401);
  });

  it('401s an unauthenticated request to GET /api/readiness/history', async () => {
    await request(server()).get('/api/readiness/history').expect(401);
  });

  it('admits a Viewer — the default role, holding no permissions', async () => {
    await getReadiness(learnerA).expect(200);
  });

  // ---------------------------------------------------------------------------
  // Lazy computation for a fresh user with zero evidence
  // ---------------------------------------------------------------------------

  describe('a fresh user with zero evidence', () => {
    it('lazily computes a snapshot: score 10 (remediation\'s vacuous full credit, and nothing else), capReason typed_only, and an unchanged stage', async () => {
      const response = await getReadiness(learnerA).expect(200);
      const body = response.body.data;

      // Every component but `remediation` reads 0 with no evidence at all;
      // `remediation` alone is 1.0 (§2.5's "nothing to remediate" rule) —
      // 0.10 weight × 1.0 = the entire score. Not "near zero": exactly the
      // honest floor for a learner who has never struggled either.
      expect(body.score).toBe(10);
      expect(body.components.remediation.value).toBe(1);
      expect(body.components.coverage.value).toBe(0);
      expect(body.components.recall.value).toBe(0);
      expect(body.capReason).toBe('typed_only');
      // No evidence means no threshold is ever cleared, so
      // `nextStageOnReadinessSnapshot` returns null and the stage this
      // snapshot records is whatever the learner already had.
      expect(body.stage).toBe('oriented');
      expect(body.topRecommendation.componentKey).toBeNull();
      expect(body.narrative).toBeNull();
      expect(body.narrativeGeneratedAt).toBeNull();

      // Exactly one row now exists for this learner.
      expect(Array.from(snapshots.values()).filter((s) => s.userId === learnerA.id)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency — a second GET with no new evidence does not recompute
  // ---------------------------------------------------------------------------

  describe('idempotency', () => {
    it('returns the SAME snapshot on a second call with no new evidence — computedAt does not move', async () => {
      const first = await getReadiness(learnerA).expect(200);
      const second = await getReadiness(learnerA).expect(200);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.computedAt).toBe(first.body.data.computedAt);
      expect(Array.from(snapshots.values()).filter((s) => s.userId === learnerA.id)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // A completed session's evidence is reflected on the next read
  // ---------------------------------------------------------------------------

  describe('a completed practice session', () => {
    it('causes the next GET /api/readiness to reflect the updated evidence', async () => {
      // Two pinned instants (`X-Test-Clock`, per `docs/TESTING.md`), five
      // minutes apart — a "before" moment and a strictly later "after"
      // moment, so `readiness_snapshots.computedAt` orders unambiguously
      // and the completion's attempts land inside `consistency`'s 14-day
      // window relative to both.
      const pinnedBefore = '2026-04-01T12:00:00.000Z';
      const pinnedAfter = '2026-04-01T12:05:00.000Z';

      // Before any evidence: capped, at the score-10 floor.
      const before = await getReadiness(learnerA).set('X-Test-Clock', pinnedBefore).expect(200);
      expect(before.body.data.capReason).toBe('typed_only');
      expect(before.body.data.score).toBe(10);

      // Seed a completed-but-not-yet-finalized session with five real,
      // unassisted, correct attempts (>= recall's 5-qualifying-attempt
      // floor, §2.2) then complete it — mirroring
      // `practice.integration.spec.ts`'s own direct-seed convention for
      // `completeSession` (it reads the session and its attempt rows, not
      // the create/record-attempt flow).
      const sessionId = randomUUID();
      sessions.set(sessionId, {
        id: sessionId,
        userId: learnerA.id,
        kind: 'quick',
        status: 'in_progress',
        testVersionCode: TV,
        categoryId: null,
        plannedCount: 5,
        startedAt: new Date(pinnedBefore),
        completedAt: null,
        summary: null,
      });

      for (let i = 0; i < 5; i += 1) {
        seedAttempt({
          userId: learnerA.id,
          sessionId,
          questionId: [Q1, Q2, Q3, Q1, Q2][i],
          outcome: 'correct',
          answeredAt: new Date(pinnedAfter),
        });
      }

      await request(server())
        .post(`/api/practice/sessions/${sessionId}/complete`)
        .set(authHeader(learnerA.accessToken))
        .set('X-Test-Clock', pinnedAfter)
        .expect(201);

      const after = await getReadiness(learnerA).set('X-Test-Clock', pinnedAfter).expect(200);

      // The completion itself already recomputed a snapshot synchronously
      // (readiness-model.md §7(a)) — this GET must not be stale relative to
      // it, and must show real recall evidence now.
      expect(after.body.data.id).not.toBe(before.body.data.id);
      expect(after.body.data.evidenceCounts.recall.qualifyingAttempts).toBe(5);
      expect(after.body.data.evidenceCounts.recall.correctCount).toBe(5);
      expect(after.body.data.components.recall.value).toBe(1);
      expect(after.body.data.score).toBeGreaterThan(before.body.data.score);

      // And it's stable again: a further GET with no new evidence (same
      // pinned instant) returns the same row `completeSession` already
      // produced.
      const again = await getReadiness(learnerA).set('X-Test-Clock', pinnedAfter).expect(200);
      expect(again.body.data.id).toBe(after.body.data.id);
    });
  });

  // ---------------------------------------------------------------------------
  // History — newest first, paginated
  // ---------------------------------------------------------------------------

  describe('GET /api/readiness/history', () => {
    it('returns snapshots newest first', async () => {
      const t1 = new Date('2026-04-01T00:00:00.000Z');
      const t2 = new Date('2026-04-02T00:00:00.000Z');
      const t3 = new Date('2026-04-03T00:00:00.000Z');

      for (const computedAt of [t1, t2, t3]) {
        snapshots.set(randomUUID(), {
          id: randomUUID(),
          userId: learnerA.id,
          computedAt,
          score: 10,
          stage: 'oriented',
          components: {},
          evidenceCounts: {},
          capReason: 'typed_only',
          topRecommendation: { componentKey: null, title: 't', reason: 'r', path: '/practice' },
          narrative: null,
          narrativeGeneratedAt: null,
          createdAt: computedAt,
        });
      }

      const response = await getHistory(learnerA).expect(200);
      const timestamps = response.body.data.items.map((item: any) => item.computedAt);

      expect(timestamps).toEqual([t3.toISOString(), t2.toISOString(), t1.toISOString()]);
      expect(response.body.data.total).toBe(3);
    });

    it('400s an unknown query parameter, e.g. ?userId=', async () => {
      await request(server())
        .get('/api/readiness/history?userId=someone-else')
        .set(authHeader(learnerA.accessToken))
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-user isolation
  // ---------------------------------------------------------------------------

  describe('cross-user isolation', () => {
    it("a caller's readiness response only ever reflects their own evidence, never another learner's", async () => {
      // Give learner A real evidence; learner B has none.
      for (const questionId of [Q1, Q2, Q3]) {
        seedAttempt({ userId: learnerA.id, questionId, outcome: 'correct' });
      }

      const responseA = await getReadiness(learnerA).expect(200);
      const responseB = await getReadiness(learnerB).expect(200);

      expect(responseA.body.data.evidenceCounts.recall.qualifyingAttempts).toBe(3);
      expect(responseB.body.data.evidenceCounts.recall.qualifyingAttempts).toBe(0);

      // No response ever carries the other learner's snapshot id — there is
      // no user-id parameter to even attempt cross-user access with, and
      // the two rows are provably distinct.
      expect(responseA.body.data.id).not.toBe(responseB.body.data.id);

      const historyA = await getHistory(learnerA).expect(200);
      const historyB = await getHistory(learnerB).expect(200);
      const idsA = new Set(historyA.body.data.items.map((item: any) => item.id));
      const idsB = new Set(historyB.body.data.items.map((item: any) => item.id));
      expect([...idsA].some((id) => idsB.has(id))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // recall's two exclusions beyond hintUsed/revealed — issue #244, epic #58 / E9
  // ---------------------------------------------------------------------------
  //
  // `readiness.service.ts`'s own comment names these "THE TWO PLACES A
  // MISHEARING COULD BE CHARGED TO THE LEARNER" (recall is one; the other is
  // `PracticeService`'s mastery-scheduling guard, covered by
  // `practice.service.spec.ts`). These two tests exercise the recall half,
  // over a real HTTP round trip through the actual `AppModule`, using the
  // three-valued `evalAttemptWhere` evaluator defined above — see its own
  // header comment for exactly what that buys over a plain mocked-Prisma
  // assertion, and what it still does not prove (no real Postgres is
  // involved; see this task's report for that honesty note in full).
  describe('recall exclusions (issue #244)', () => {
    it('is the NULL trap: counts null-failureCause rows as qualifying, and drops ONLY the misheard ones', async () => {
      // THE REGRESSION THIS PINS. `failureCause: { not: 'misheard' }` (or the
      // equally wrong `NOT: { failureCause: 'misheard' }`) compiles to a bare
      // SQL `<>` / negated `=`, and `NULL <> 'misheard'` is NULL, not TRUE —
      // so that spelling silently drops EVERY null-failureCause row, which is
      // every deterministically-graded attempt (the overwhelming majority in
      // practice). A test built only from non-null-failureCause rows cannot
      // see this regression at all: it passes identically under the correct
      // spelling and the buggy one. This test deliberately MIXES null and
      // non-null rows so the two spellings diverge, and relies on
      // `evalAttemptWhere` above to apply REAL three-valued SQL semantics to
      // whatever `where` object `readiness.service.ts` actually builds.
      //
      // Four ordinary, deterministically-graded rows: failureCause is
      // OMITTED (seedAttempt's default is null), exactly like a real
      // `practice_attempts` row that no grader ever touched.
      for (let i = 0; i < 4; i += 1) {
        seedAttempt({ userId: learnerA.id, questionId: [Q1, Q2, Q3, Q1][i], outcome: 'correct' });
      }

      // One non-null, NON-misheard cause — included so the "mix" is not
      // merely null vs 'misheard'. This row alone would survive even the
      // buggy `{ not: 'misheard' }` spelling (a non-null value compares
      // cleanly), so it cannot by itself distinguish the two spellings.
      seedAttempt({
        userId: learnerA.id,
        questionId: Q2,
        outcome: 'incorrect',
        failureCause: 'not_known',
      });

      // Two misheard rows — the ones a correct implementation excludes.
      for (let i = 0; i < 2; i += 1) {
        seedAttempt({
          userId: learnerA.id,
          questionId: [Q3, Q1][i],
          outcome: 'incorrect',
          failureCause: 'misheard',
        });
      }

      const response = await getReadiness(learnerA).expect(200);
      const recall = response.body.data.evidenceCounts.recall;

      // Correct spelling: 4 null-cause + 1 not_known-cause = 5 qualifying;
      // only the 2 misheard rows are dropped.
      //
      // Under the buggy spelling this assertion FAILS: the 4 null-cause rows
      // would ALSO be dropped (NULL <> x is UNKNOWN, not TRUE), leaving only
      // 1 qualifying attempt.
      expect(recall.qualifyingAttempts).toBe(5);
      expect(recall.correctCount).toBe(4);
      expect(recall.incorrectCount).toBe(1);
    });

    it('excludes a SUPERSEDED attempt even when it was never misheard', async () => {
      // `requireRetryTarget` (`practice.service.ts`) admits a retry on FOUR
      // conditions, and "the target was misheard" is not one of them —
      // `record-attempt.dto.ts` says so outright ("NOT restricted to a
      // spoken attempt"). So an ORDINARY wrong answer can be superseded, and
      // `retries: { none: {} }` is what keeps the recall window from
      // counting both the original and its correction as two attempts at
      // one question. The original row here has `failureCause: null` — this
      // proves exclusion (2) independently of exclusion (1).
      for (let i = 0; i < 4; i += 1) {
        seedAttempt({ userId: learnerA.id, questionId: [Q1, Q2, Q3, Q1][i], outcome: 'correct' });
      }

      const originalId = seedAttempt({
        userId: learnerA.id,
        questionId: Q3,
        outcome: 'incorrect',
        failureCause: null,
        answeredAt: new Date('2026-04-01T12:00:00.000Z'),
      });

      // The correction. Superseding is what removes the ORIGINAL from the
      // window, not the retry — the retry itself is ordinary qualifying
      // evidence.
      seedAttempt({
        userId: learnerA.id,
        questionId: Q3,
        outcome: 'correct',
        retryOfAttemptId: originalId,
        answeredAt: new Date('2026-04-01T12:05:00.000Z'),
      });

      const response = await getReadiness(learnerA).expect(200);
      const recall = response.body.data.evidenceCounts.recall;

      // 4 base + 1 retry = 5 qualifying. The superseded original is neither
      // double-counted nor counted as a wrong answer.
      expect(recall.qualifyingAttempts).toBe(5);
      expect(recall.correctCount).toBe(5);
      expect(recall.incorrectCount).toBe(0);
    });
  });
});

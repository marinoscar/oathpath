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

function seedAttempt(overrides: Partial<Record<string, unknown>> = {}): void {
  const id = randomUUID();
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
    revealed: false,
    hintUsed: false,
    durationMs: null,
    answeredAt: new Date('2026-04-01T12:00:00.000Z'),
    ...overrides,
  });
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

  function matchesAttemptWhere(row: any, where: Record<string, unknown>): boolean {
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.sessionId !== undefined && row.sessionId !== where.sessionId) return false;
    if (where.hintUsed !== undefined && row.hintUsed !== where.hintUsed) return false;
    if (where.revealed !== undefined && row.revealed !== where.revealed) return false;
    if (where.inputMode !== undefined && row.inputMode !== where.inputMode) return false;
    if (where.outcome !== undefined && row.outcome !== where.outcome) return false;
    const answeredAtGte = (where.answeredAt as any)?.gte as Date | undefined;
    if (answeredAtGte && row.answeredAt.getTime() < answeredAtGte.getTime()) return false;
    return true;
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
});

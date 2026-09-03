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
// Progress API (integration) — issue #86, epic #54 / E5 "Memory"
// =============================================================================
//
// Covers `GET /api/progress/mastery` over real HTTP through `createTestApp`,
// with Prisma mocked — the same shape `practice.integration.spec.ts` and
// `journey.integration.spec.ts` already establish. The Prisma mock below is a
// tiny in-memory store, filtered on `where` for real, for the identical
// reason those files give: a `mockResolvedValue` would make "counts only the
// caller's own test version" and "a missing `question_mastery` row counts as
// `new`" meaningless assertions, because a service that ignored either would
// still pass.
//
// No test in this repository touches a database (docs/TESTING.md).
// =============================================================================

const TV = 'vprog2025';
const CAT_X = 'd1111111-1111-4111-8111-111111111111';
const CAT_Y = 'd2222222-2222-4222-8222-222222222222';

// Category X: three questions — one `new` (no row), one `learning`, one `mastered`.
const QX1 = 'e1111111-1111-4111-8111-111111111111';
const QX2 = 'e2222222-2222-4222-8222-222222222222';
const QX3 = 'e3333333-3333-4333-8333-333333333333';

// Category Y: two questions — one `review`, one `lapsed`.
const QY1 = 'e4444444-4444-4444-8444-444444444444';
const QY2 = 'e5555555-5555-4555-8555-555555555555';

const CATEGORIES = [
  { id: CAT_X, testVersionCode: TV, name: 'Category X', sortOrder: 0, code: 'x' },
  { id: CAT_Y, testVersionCode: TV, name: 'Category Y', sortOrder: 1, code: 'y' },
];

const QUESTIONS = [
  { id: QX1, testVersionCode: TV, categoryId: CAT_X },
  { id: QX2, testVersionCode: TV, categoryId: CAT_X },
  { id: QX3, testVersionCode: TV, categoryId: CAT_X },
  { id: QY1, testVersionCode: TV, categoryId: CAT_Y },
  { id: QY2, testVersionCode: TV, categoryId: CAT_Y },
];

// A second test version, entirely disjoint, to prove scoping: its bank size
// and category set must never leak into a `TV` learner's response, or vice
// versa.
const TV2 = 'vprog2008';
const CAT_Z = 'd3333333-3333-4333-8333-333333333333';
const QZ1 = 'e6666666-6666-4666-8666-666666666666';
const QZ2 = 'e7777777-7777-4777-8777-777777777777';
const QZ3 = 'e8888888-8888-4888-8888-888888888888';

const CATEGORIES_TV2 = [
  { id: CAT_Z, testVersionCode: TV2, name: 'Category Z', sortOrder: 0, code: 'z' },
];

const QUESTIONS_TV2 = [
  { id: QZ1, testVersionCode: TV2, categoryId: CAT_Z },
  { id: QZ2, testVersionCode: TV2, categoryId: CAT_Z },
  { id: QZ3, testVersionCode: TV2, categoryId: CAT_Z },
];

const ALL_CATEGORIES = [...CATEGORIES, ...CATEGORIES_TV2];
const ALL_QUESTIONS = [...QUESTIONS, ...QUESTIONS_TV2];

/** The `learner_profiles` facts the endpoint reads, for one test. */
let profiles: Map<string, { testVersionCode: string | null }>;
/** The `question_mastery` table, in-memory — keyed by `${userId}:${questionId}`. */
let mastery: Map<string, { userId: string; questionId: string; state: string }>;

function seedMastery(userId: string, questionId: string, state: string): void {
  mastery.set(`${userId}:${questionId}`, { userId, questionId, state });
}

/**
 * Wire `learner_profiles`, `civics_categories`, `civics_questions` and
 * `question_mastery` into the shared Prisma mock as a tiny relational store,
 * filtering on `where` for real — the same convention
 * `practice.integration.spec.ts`'s `setupPracticeMocks` uses.
 */
function setupProgressMocks(): void {
  profiles = new Map();
  mastery = new Map();

  (prismaMock.learnerProfile.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      const profile = profiles.get(where.userId);
      return profile === undefined ? null : { testVersionCode: profile.testVersionCode };
    },
  );

  (prismaMock.civicsCategory.findMany as jest.Mock).mockImplementation(
    async ({ where }: any) =>
      ALL_CATEGORIES
        .filter((c) => c.testVersionCode === where.testVersionCode)
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
        .map((c) => ({ id: c.id, name: c.name })),
  );

  (prismaMock.civicsQuestion.findMany as jest.Mock).mockImplementation(
    async ({ where }: any) =>
      ALL_QUESTIONS
        .filter((q) => q.testVersionCode === where.testVersionCode)
        .map((q) => ({ id: q.id, categoryId: q.categoryId })),
  );

  (prismaMock.questionMastery.findMany as jest.Mock).mockImplementation(async ({ where }: any) => {
    const ids: string[] | undefined = where.questionId?.in;
    return Array.from(mastery.values())
      .filter((row) => row.userId === where.userId && (ids === undefined || ids.includes(row.questionId)))
      .map((row) => ({ questionId: row.questionId, state: row.state }));
  });
}

describe('Progress (Integration)', () => {
  let context: TestContext;
  let learner: TestUser;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    setupProgressMocks();

    learner = await createMockViewerUser(context, 'progressLearner@example.com');
    profiles.set(learner.id, { testVersionCode: TV });
  });

  const server = () => context.app.getHttpServer();

  function getMastery(user: TestUser) {
    return request(server())
      .get('/api/progress/mastery')
      .set(authHeader(user.accessToken));
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  it('401s an unauthenticated request', async () => {
    await request(server()).get('/api/progress/mastery').expect(401);
  });

  it('admits a Viewer — the default role, holding no permissions', async () => {
    await getMastery(learner).expect(200);
  });

  // ---------------------------------------------------------------------------
  // Happy path — a mix of mastery states across two categories
  // ---------------------------------------------------------------------------

  describe('happy path — a mix of states across two categories', () => {
    beforeEach(() => {
      // QX1 gets no row at all — counts as `new`.
      seedMastery(learner.id, QX2, 'learning');
      seedMastery(learner.id, QX3, 'mastered');
      seedMastery(learner.id, QY1, 'review');
      seedMastery(learner.id, QY2, 'lapsed');
    });

    it('reports correct totals, byState, attempted, and per-category breakdowns', async () => {
      const response = await getMastery(learner).expect(200);
      const body = response.body.data;

      expect(body.testVersionCode).toBe(TV);
      expect(body.totalQuestions).toBe(5);
      // attempted = totalQuestions - byState.new = 5 - 1
      expect(body.attempted).toBe(4);
      expect(body.byState).toEqual({
        new: 1,
        learning: 1,
        review: 1,
        lapsed: 1,
        mastered: 1,
      });

      const byId = new Map(body.categories.map((c: any) => [c.categoryId, c]));

      const catX = byId.get(CAT_X) as any;
      expect(catX).toBeDefined();
      expect(catX.categoryName).toBe('Category X');
      expect(catX.totalQuestions).toBe(3);
      expect(catX.byState).toEqual({ new: 1, learning: 1, review: 0, lapsed: 0, mastered: 1 });
      expect(catX.masteredCount).toBe(1);

      const catY = byId.get(CAT_Y) as any;
      expect(catY).toBeDefined();
      expect(catY.categoryName).toBe('Category Y');
      expect(catY.totalQuestions).toBe(2);
      expect(catY.byState).toEqual({ new: 0, learning: 0, review: 1, lapsed: 1, mastered: 0 });
      expect(catY.masteredCount).toBe(0);

      // Arithmetic sanity: category totals sum to the version total, and
      // every category's byState sums to its own totalQuestions.
      expect(body.categories.reduce((sum: number, c: any) => sum + c.totalQuestions, 0)).toBe(
        body.totalQuestions,
      );
      for (const category of body.categories) {
        const stateSum = Object.values(category.byState as Record<string, number>).reduce(
          (a: number, b: number) => a + b,
          0,
        );
        expect(stateSum).toBe(category.totalQuestions);
      }

      // Categories render in the same sortOrder/code order as
      // GET /api/civics/versions/{code}/categories.
      expect(body.categories.map((c: any) => c.categoryId)).toEqual([CAT_X, CAT_Y]);
    });
  });

  // ---------------------------------------------------------------------------
  // No mastery rows at all — a learner who has never practiced
  // ---------------------------------------------------------------------------

  describe('a learner with no question_mastery rows at all', () => {
    it('counts every question as new, attempted 0, every category masteredCount 0', async () => {
      const response = await getMastery(learner).expect(200);
      const body = response.body.data;

      expect(body.totalQuestions).toBe(5);
      expect(body.attempted).toBe(0);
      expect(body.byState).toEqual({ new: 5, learning: 0, review: 0, lapsed: 0, mastered: 0 });

      for (const category of body.categories) {
        expect(category.masteredCount).toBe(0);
        expect(category.byState.new).toBe(category.totalQuestions);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // All questions mastered
  // ---------------------------------------------------------------------------

  describe('a learner who has mastered every question', () => {
    beforeEach(() => {
      for (const question of QUESTIONS) {
        seedMastery(learner.id, question.id, 'mastered');
      }
    });

    it('reports attempted equal to totalQuestions and byState.new at 0', async () => {
      const response = await getMastery(learner).expect(200);
      const body = response.body.data;

      expect(body.totalQuestions).toBe(5);
      expect(body.attempted).toBe(5);
      expect(body.byState).toEqual({ new: 0, learning: 0, review: 0, lapsed: 0, mastered: 5 });

      const catX = body.categories.find((c: any) => c.categoryId === CAT_X);
      const catY = body.categories.find((c: any) => c.categoryId === CAT_Y);
      expect(catX.masteredCount).toBe(3);
      expect(catY.masteredCount).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Scoping — only the caller's own resolved test version is ever visible
  // ---------------------------------------------------------------------------

  describe('scoping to the caller’s own resolved test version', () => {
    it('a learner on TV2 sees only TV2’s bank and categories, never TV’s', async () => {
      const learnerTv2 = await createMockViewerUser(context, 'progressLearnerTv2@example.com');
      profiles.set(learnerTv2.id, { testVersionCode: TV2 });
      seedMastery(learnerTv2.id, QZ1, 'mastered');

      const response = await getMastery(learnerTv2).expect(200);
      const body = response.body.data;

      expect(body.testVersionCode).toBe(TV2);
      expect(body.totalQuestions).toBe(3);
      expect(body.attempted).toBe(1);
      expect(body.byState).toEqual({ new: 2, learning: 0, review: 0, lapsed: 0, mastered: 1 });

      expect(body.categories).toHaveLength(1);
      expect(body.categories[0].categoryId).toBe(CAT_Z);
      expect(body.categories[0].categoryName).toBe('Category Z');
      expect(body.categories[0].totalQuestions).toBe(3);

      // None of TV's category ids leak into a TV2 learner's response.
      const categoryIds = body.categories.map((c: any) => c.categoryId);
      expect(categoryIds).not.toContain(CAT_X);
      expect(categoryIds).not.toContain(CAT_Y);
    });

    it('a TV learner’s own response is unaffected by TV2’s mastery rows or bank size', async () => {
      // A second learner on TV2, with mastery rows recorded, exists
      // alongside the TV learner in the same store — TV's own totals must
      // stay exactly {5, byState.new: 5}, not TV2's {3, ...}.
      const learnerTv2 = await createMockViewerUser(context, 'progressLearnerTv2b@example.com');
      profiles.set(learnerTv2.id, { testVersionCode: TV2 });
      seedMastery(learnerTv2.id, QZ1, 'mastered');
      seedMastery(learnerTv2.id, QZ2, 'learning');

      const response = await getMastery(learner).expect(200);
      const body = response.body.data;

      expect(body.testVersionCode).toBe(TV);
      expect(body.totalQuestions).toBe(5);
      expect(body.byState).toEqual({ new: 5, learning: 0, review: 0, lapsed: 0, mastered: 0 });
      expect(body.categories.map((c: any) => c.categoryId).sort()).toEqual([CAT_X, CAT_Y].sort());
    });
  });

  // ---------------------------------------------------------------------------
  // Unoriented learner — no resolved test version
  // ---------------------------------------------------------------------------

  describe('an unoriented learner (no resolved test version)', () => {
    it('400s rather than returning empty or zeroed data', async () => {
      const unoriented = await createMockViewerUser(context, 'progressUnoriented@example.com');
      profiles.set(unoriented.id, { testVersionCode: null });

      await getMastery(unoriented).expect(400);
    });

    it('400s a learner with no learner_profiles row at all', async () => {
      const noProfile = await createMockViewerUser(context, 'progressNoProfile@example.com');
      // Deliberately not added to `profiles` — `findUnique` returns null.

      await getMastery(noProfile).expect(400);
    });
  });
});

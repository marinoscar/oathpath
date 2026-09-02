import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from './helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from './mocks/prisma.mock';
import { setupBaseMocks } from './fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  createMockViewerUser,
  authHeader,
  TestUser,
} from './helpers/auth-mock.helper';

// =============================================================================
// Civics read API (integration) — issue #111, epic #51
// =============================================================================
//
// Every acceptance criterion on #111 asserted over real HTTP through
// `createTestApp`, with Prisma mocked — the shape `journey.integration.spec.ts`
// established. The unit specs cover the decisions; this file covers that they
// survive the wire: the guards, the global Zod pipe, the response envelope and
// the `X-Test-Clock` middleware are all in the path.
//
// -----------------------------------------------------------------------------
// THE PRISMA MOCK APPLIES THE `where` CLAUSE INSTEAD OF IGNORING IT
// -----------------------------------------------------------------------------
//
// `civicsAnswer.findMany` below really filters on `effectiveFrom`/`effectiveTo`
// against the instant the service passed it. That is deliberate and it is the
// only reason the clock assertions prove anything: a `mockResolvedValue` would
// return the same rows whatever instant the service asked about, so a service
// that ignored the clock entirely would pass. Here, pinning `X-Test-Clock` to
// 2019, 2026 and 2030 returns three DIFFERENT presidents out of the same three
// rows, and none of the three is stubbed per-test.
//
// No test in this repository touches a database (docs/TESTING.md).
// =============================================================================

// --- ids --------------------------------------------------------------------

const CAT_PRINCIPLES = 'c1111111-1111-4111-8111-111111111111';
const CAT_SYSTEM = 'c2222222-2222-4222-8222-222222222222';
const CAT_2025 = 'c3333333-3333-4333-8333-333333333333';

const Q_BRANCH = 'a1111111-1111-4111-8111-111111111111';
const Q_PRESIDENT = 'a2222222-2222-4222-8222-222222222222';
const Q_GOVERNOR = 'a3333333-3333-4333-8333-333333333333';
const Q_2025 = 'a4444444-4444-4444-8444-444444444444';

const UNKNOWN_UUID = 'f0000000-0000-4000-8000-000000000000';

// --- fixtures ---------------------------------------------------------------

const V2008 = {
  code: 'v2008',
  label: '2008 Civics Test',
  questionsAsked: 10,
  passThreshold: 6,
  seniorQuestionsAsked: 10,
  seniorPassThreshold: 6,
  contentHash: 'sha256:2008',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const V2025 = {
  ...V2008,
  code: 'v2025',
  label: '2025 Civics Test',
  questionsAsked: 20,
  passThreshold: 12,
  contentHash: null,
};

const CATEGORIES = [
  {
    id: CAT_SYSTEM,
    testVersionCode: 'v2008',
    section: 'AMERICAN GOVERNMENT',
    code: 'system_of_government',
    // Deliberately alphabetically BEFORE "Principles" while sorting AFTER it,
    // so an implementation that ordered by name would visibly fail.
    name: 'A System of Government',
    sortOrder: 2,
  },
  {
    id: CAT_PRINCIPLES,
    testVersionCode: 'v2008',
    section: 'AMERICAN GOVERNMENT',
    code: 'principles_of_american_democracy',
    name: 'Principles of American Democracy',
    sortOrder: 1,
  },
  {
    id: CAT_2025,
    testVersionCode: 'v2025',
    section: 'AMERICAN GOVERNMENT',
    code: 'principles_of_american_democracy',
    name: 'Principles of American Democracy',
    sortOrder: 1,
  },
];

const QUESTIONS = [
  {
    id: Q_BRANCH,
    testVersionCode: 'v2008',
    number: 13,
    categoryId: CAT_PRINCIPLES,
    prompt: 'Name one branch or part of the government.',
    seniorEligible: false,
    dynamicScope: 'none',
  },
  {
    id: Q_PRESIDENT,
    testVersionCode: 'v2008',
    number: 28,
    categoryId: CAT_SYSTEM,
    prompt: 'What is the name of the President of the United States now?',
    seniorEligible: true,
    dynamicScope: 'national',
  },
  {
    id: Q_GOVERNOR,
    testVersionCode: 'v2008',
    number: 43,
    categoryId: CAT_SYSTEM,
    prompt: 'Who is the Governor of your state now?',
    seniorEligible: true,
    dynamicScope: 'state',
  },
  {
    id: Q_2025,
    testVersionCode: 'v2025',
    number: 1,
    categoryId: CAT_2025,
    prompt: 'What is the supreme law of the land?',
    seniorEligible: false,
    dynamicScope: 'none',
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
    effectiveFrom: over.effectiveFrom,
    effectiveTo: over.effectiveTo ?? null,
    sourceNote: over.sourceNote ?? 'transcribed from the official source',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

/**
 * Three presidents in one slot, exactly as civics-content.md §4's
 * close-then-open lifecycle produces them: contiguous, non-overlapping, and
 * with only ONE row carrying `effectiveTo: null` — which is what the partial
 * unique index (§3.2) allows.
 */
const PRESIDENTS = [
  answerRow({
    id: 'd1111111-1111-4111-8111-111111111111',
    questionId: Q_PRESIDENT,
    text: 'The President before last',
    effectiveFrom: new Date('2017-01-20T00:00:00Z'),
    effectiveTo: new Date('2021-01-20T00:00:00Z'),
  }),
  answerRow({
    id: 'd2222222-2222-4222-8222-222222222222',
    questionId: Q_PRESIDENT,
    text: 'The current President',
    verifiedAt: new Date('2026-05-20T09:30:00Z'),
    effectiveFrom: new Date('2021-01-20T00:00:00Z'),
    // A correction already entered for a handover that has not happened yet.
    effectiveTo: new Date('2029-01-20T00:00:00Z'),
  }),
  answerRow({
    id: 'd3333333-3333-4333-8333-333333333333',
    questionId: Q_PRESIDENT,
    text: 'The next President',
    effectiveFrom: new Date('2029-01-20T00:00:00Z'),
    effectiveTo: null,
  }),
];

const GOVERNORS = [
  answerRow({
    id: 'd4444444-4444-4444-8444-444444444444',
    questionId: Q_GOVERNOR,
    text: 'The former Governor of Texas',
    stateCode: 'TX',
    effectiveFrom: new Date('2015-01-20T00:00:00Z'),
    effectiveTo: new Date('2023-01-17T00:00:00Z'),
  }),
  answerRow({
    id: 'd5555555-5555-4555-8555-555555555555',
    questionId: Q_GOVERNOR,
    text: 'The Governor of Texas',
    stateCode: 'TX',
    effectiveFrom: new Date('2023-01-17T00:00:00Z'),
  }),
  answerRow({
    id: 'd6666666-6666-4666-8666-666666666666',
    questionId: Q_GOVERNOR,
    text: 'The Governor of Ohio',
    stateCode: 'OH',
    effectiveFrom: new Date('2019-01-14T00:00:00Z'),
  }),
  answerRow({
    id: 'd7777777-7777-4777-8777-777777777777',
    questionId: Q_GOVERNOR,
    text: 'The Governor of Puerto Rico',
    stateCode: 'PR',
    effectiveFrom: new Date('2025-01-02T00:00:00Z'),
  }),
];

const BRANCHES = [
  answerRow({
    id: 'd8888888-8888-4888-8888-888888888888',
    questionId: Q_BRANCH,
    text: 'Congress',
    sort: 0,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  }),
  answerRow({
    id: 'd9999999-9999-4999-8999-999999999999',
    questionId: Q_BRANCH,
    text: 'the President',
    sort: 1,
    verifiedAt: new Date('2026-06-15T00:00:00Z'),
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  }),
  answerRow({
    id: 'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    questionId: Q_BRANCH,
    text: 'the courts',
    sort: 2,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  }),
];

const ALL_ANSWERS = [...PRESIDENTS, ...GOVERNORS, ...BRANCHES];

/** The `learner_profiles` table, for the duration of one test. */
let profiles: Map<string, { stateCode: string | null; testVersionCode: string | null }>;

/**
 * Wire the civics tables into the shared Prisma mock.
 *
 * `civicsAnswer.findMany` interprets the `where` the service builds rather than
 * returning a canned list — see this file's header for why that is the point.
 */
function setupCivicsMocks(): void {
  profiles = new Map();

  (prismaMock.learnerProfile.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => profiles.get(where.userId) ?? null,
  );

  (prismaMock.civicsTestVersion.findMany as jest.Mock).mockResolvedValue([V2008, V2025]);

  (prismaMock.civicsTestVersion.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) =>
      [V2008, V2025].find((v) => v.code === where.code) ?? null,
  );

  (prismaMock.civicsCategory.findMany as jest.Mock).mockImplementation(
    async ({ where }: any) =>
      CATEGORIES.filter((c) => c.testVersionCode === where.testVersionCode).sort(
        (a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code),
      ),
  );

  const matchesQuestion = (q: (typeof QUESTIONS)[number], where: any = {}) =>
    (where.testVersionCode === undefined || q.testVersionCode === where.testVersionCode) &&
    (where.categoryId === undefined || q.categoryId === where.categoryId) &&
    (where.seniorEligible === undefined || q.seniorEligible === where.seniorEligible);

  (prismaMock.civicsQuestion.findMany as jest.Mock).mockImplementation(
    async ({ where, skip = 0, take }: any) => {
      const matched = QUESTIONS.filter((q) => matchesQuestion(q, where)).sort(
        (a, b) =>
          a.testVersionCode.localeCompare(b.testVersionCode) || a.number - b.number,
      );
      return matched.slice(skip, take === undefined ? undefined : skip + take);
    },
  );

  (prismaMock.civicsQuestion.count as jest.Mock).mockImplementation(
    async ({ where }: any) => QUESTIONS.filter((q) => matchesQuestion(q, where)).length,
  );

  (prismaMock.civicsQuestion.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      const found = QUESTIONS.find((q) => q.id === where.id);
      if (!found) {
        return null;
      }
      return {
        ...found,
        category: CATEGORIES.find((c) => c.id === found.categoryId),
      };
    },
  );

  (prismaMock.civicsAnswer.findMany as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      const now: Date = where.effectiveFrom.lte;

      return ALL_ANSWERS.filter((a) => {
        if (a.questionId !== where.questionId) return false;
        if ((a.stateCode ?? null) !== (where.stateCode ?? null)) return false;
        // The predicate `currentAnswerWhere` builds, applied literally.
        if (a.effectiveFrom.getTime() > now.getTime()) return false;
        if (a.effectiveTo !== null && a.effectiveTo.getTime() <= now.getTime()) {
          return false;
        }
        return true;
      }).sort(
        (x, y) => x.sort - y.sort || y.effectiveFrom.getTime() - x.effectiveFrom.getTime(),
      );
    },
  );
}

describe('Civics (Integration)', () => {
  let context: TestContext;
  /** A Texan. */
  let texan: TestUser;
  /** An Ohioan on the same test version — the contrast case. */
  let ohioan: TestUser;
  /** Signed in, but has not finished orientation: no state, no test version. */
  let nomad: TestUser;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    setupCivicsMocks();

    texan = await createMockViewerUser(context, 'texan@example.com');
    ohioan = await createMockViewerUser(context, 'ohioan@example.com');
    nomad = await createMockViewerUser(context, 'nomad@example.com');

    profiles.set(texan.id, { stateCode: 'TX', testVersionCode: 'v2008' });
    profiles.set(ohioan.id, { stateCode: 'OH', testVersionCode: 'v2008' });
    profiles.set(nomad.id, { stateCode: null, testVersionCode: null });
  });

  const server = () => context.app.getHttpServer();

  // ---------------------------------------------------------------------------
  // Authentication and the permission posture
  // ---------------------------------------------------------------------------

  describe('authentication', () => {
    it.each([
      '/api/civics/versions',
      '/api/civics/versions/v2008/categories',
      '/api/civics/questions',
      `/api/civics/questions/${Q_BRANCH}`,
    ])('rejects an unauthenticated GET %s with 401', async (path) => {
      await request(server()).get(path).expect(401);
    });

    it.each([
      '/api/civics/versions',
      '/api/civics/versions/v2008/categories',
      '/api/civics/questions',
      `/api/civics/questions/${Q_BRANCH}`,
    ])('admits a Viewer — the default role — to GET %s', async (path) => {
      // No permission gates any of these. Civics content is the core product
      // material; a Viewer who could not read it could not study, which is the
      // whole application. civics-content.md §8.
      await request(server())
        .get(path)
        .set(authHeader(texan.accessToken))
        .expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Versions and categories
  // ---------------------------------------------------------------------------

  describe('GET /api/civics/versions', () => {
    it('serves both versions with their shapes and content hashes', async () => {
      const response = await request(server())
        .get('/api/civics/versions')
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(response.body.data).toEqual([
        {
          code: 'v2008',
          label: '2008 Civics Test',
          questionsAsked: 10,
          passThreshold: 6,
          seniorQuestionsAsked: 10,
          seniorPassThreshold: 6,
          contentHash: 'sha256:2008',
        },
        {
          code: 'v2025',
          label: '2025 Civics Test',
          questionsAsked: 20,
          passThreshold: 12,
          seniorQuestionsAsked: 10,
          seniorPassThreshold: 6,
          contentHash: null,
        },
      ]);
    });
  });

  describe('GET /api/civics/versions/:code/categories', () => {
    it('serves a version’s categories in sortOrder, not alphabetically', async () => {
      const response = await request(server())
        .get('/api/civics/versions/v2008/categories')
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(response.body.data.map((c: any) => c.name)).toEqual([
        'Principles of American Democracy',
        'A System of Government',
      ]);
    });

    it('scopes the categories to the version in the path', async () => {
      const response = await request(server())
        .get('/api/civics/versions/v2025/categories')
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(response.body.data.map((c: any) => c.id)).toEqual([CAT_2025]);
    });

    it('404s an unknown version rather than serving an empty list', async () => {
      await request(server())
        .get('/api/civics/versions/v1999/categories')
        .set(authHeader(texan.accessToken))
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // The question list
  // ---------------------------------------------------------------------------

  describe('GET /api/civics/questions', () => {
    it('defaults the version to the caller’s own profile', async () => {
      const response = await request(server())
        .get('/api/civics/questions')
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(
        response.body.data.items.every((q: any) => q.testVersionCode === 'v2008'),
      ).toBe(true);
      expect(response.body.data.items.map((q: any) => q.number)).toEqual([13, 28, 43]);
      expect(response.body.data.total).toBe(3);
    });

    it('serves the whole bank to a caller with no resolved version', async () => {
      // Not a default anybody picked for them: an un-oriented learner has not
      // said which test they are taking, and choosing one would be a claim.
      const response = await request(server())
        .get('/api/civics/questions')
        .set(authHeader(nomad.accessToken))
        .expect(200);

      expect(response.body.data.total).toBe(4);
      expect(
        new Set(response.body.data.items.map((q: any) => q.testVersionCode)),
      ).toEqual(new Set(['v2008', 'v2025']));
    });

    it('lets an explicit testVersionCode override the caller’s own', async () => {
      const response = await request(server())
        .get('/api/civics/questions?testVersionCode=v2025')
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(response.body.data.items.map((q: any) => q.id)).toEqual([Q_2025]);
    });

    it('filters by category', async () => {
      const response = await request(server())
        .get(`/api/civics/questions?categoryId=${CAT_SYSTEM}`)
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(response.body.data.items.map((q: any) => q.number)).toEqual([28, 43]);
      expect(response.body.data.total).toBe(2);
    });

    it('filters by seniorEligible', async () => {
      const response = await request(server())
        .get('/api/civics/questions?seniorEligible=true')
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(response.body.data.items.map((q: any) => q.number)).toEqual([28, 43]);
    });

    it('does not shrink the list for a senior learner who did not ask it to', async () => {
      // civics-content.md §5: senior exemption filters the question SET that is
      // ASKED, and §8 makes this an explicit filter. A list that silently
      // dropped to the senior subset would be the same unexplained gap §5
      // rejects for state-scope questions.
      const response = await request(server())
        .get('/api/civics/questions')
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(response.body.data.items.map((q: any) => q.seniorEligible)).toEqual([
        false,
        true,
        true,
      ]);
    });

    it('paginates with the same page/pageSize shape the allowlist uses', async () => {
      const first = await request(server())
        .get('/api/civics/questions?page=1&pageSize=2')
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(first.body.data).toMatchObject({
        total: 3,
        page: 1,
        pageSize: 2,
        totalPages: 2,
      });
      expect(first.body.data.items.map((q: any) => q.number)).toEqual([13, 28]);

      const second = await request(server())
        .get('/api/civics/questions?page=2&pageSize=2')
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(second.body.data.items.map((q: any) => q.number)).toEqual([43]);
    });

    it('counts the filtered set, not the whole table', async () => {
      const response = await request(server())
        .get(`/api/civics/questions?categoryId=${CAT_PRINCIPLES}&pageSize=1`)
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(response.body.data.total).toBe(1);
      expect(response.body.data.totalPages).toBe(1);
    });

    it('never puts an answer on a summary', async () => {
      const response = await request(server())
        .get('/api/civics/questions')
        .set(authHeader(texan.accessToken))
        .expect(200);

      for (const item of response.body.data.items) {
        expect(item).not.toHaveProperty('answers');
        expect(item).not.toHaveProperty('answerResolution');
      }
      expect(prismaMock.civicsAnswer.findMany).not.toHaveBeenCalled();
    });

    it.each([
      ['a zero page', 'page=0'],
      ['a pageSize past the cap', 'pageSize=500'],
      ['a categoryId that is not a uuid', 'categoryId=nope'],
    ])('rejects %s with 400', async (_label, qs) => {
      await request(server())
        .get(`/api/civics/questions?${qs}`)
        .set(authHeader(texan.accessToken))
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Resolution — state
  // ---------------------------------------------------------------------------

  describe('GET /api/civics/questions/:id — state-scope resolution', () => {
    it('gives two learners in two states two different answers to the same question', async () => {
      // The single most important property of this endpoint. Same question id,
      // same URL, no state parameter anywhere — the answers differ only
      // because the two callers' profiles differ.
      const tx = await request(server())
        .get(`/api/civics/questions/${Q_GOVERNOR}`)
        .set(authHeader(texan.accessToken))
        .expect(200);

      const oh = await request(server())
        .get(`/api/civics/questions/${Q_GOVERNOR}`)
        .set(authHeader(ohioan.accessToken))
        .expect(200);

      expect(tx.body.data.answers.map((a: any) => a.text)).toEqual([
        'The Governor of Texas',
      ]);
      expect(oh.body.data.answers.map((a: any) => a.text)).toEqual([
        'The Governor of Ohio',
      ]);
      expect(tx.body.data.resolvedForStateCode).toBe('TX');
      expect(oh.body.data.resolvedForStateCode).toBe('OH');
      expect(tx.body.data.answerResolution).toBe('resolved');
      expect(oh.body.data.answerResolution).toBe('resolved');
    });

    it('resolves a territory the same way it resolves a state', async () => {
      const boricua = await createMockViewerUser(context, 'boricua@example.com');
      profiles.set(boricua.id, { stateCode: 'PR', testVersionCode: 'v2008' });

      const response = await request(server())
        .get(`/api/civics/questions/${Q_GOVERNOR}`)
        .set(authHeader(boricua.accessToken))
        .expect(200);

      expect(response.body.data.answers.map((a: any) => a.text)).toEqual([
        'The Governor of Puerto Rico',
      ]);
    });

    it('returns an explicit state_required — not a wrong answer — when no state is set', async () => {
      const response = await request(server())
        .get(`/api/civics/questions/${Q_GOVERNOR}`)
        .set(authHeader(nomad.accessToken))
        .expect(200);

      expect(response.body.data.answerResolution).toBe('state_required');
      expect(response.body.data.answers).toEqual([]);
      expect(response.body.data.verifiedAt).toBeNull();
      expect(response.body.data.resolvedForStateCode).toBeNull();
    });

    it('still returns the question when the state is unresolved — never a 404, never hidden', async () => {
      // civics-content.md §5 rejects hiding it: the learner would see fewer
      // questions than their version promises, with nothing explaining the gap.
      const response = await request(server())
        .get(`/api/civics/questions/${Q_GOVERNOR}`)
        .set(authHeader(nomad.accessToken))
        .expect(200);

      expect(response.body.data.number).toBe(43);
      expect(response.body.data.prompt).toBe('Who is the Governor of your state now?');
      expect(response.body.data.dynamicScope).toBe('state');

      const list = await request(server())
        .get('/api/civics/questions?testVersionCode=v2008')
        .set(authHeader(nomad.accessToken))
        .expect(200);

      expect(list.body.data.items.map((q: any) => q.number)).toContain(43);
    });

    it('never substitutes a national answer for a missing state one', async () => {
      const response = await request(server())
        .get(`/api/civics/questions/${Q_GOVERNOR}`)
        .set(authHeader(nomad.accessToken))
        .expect(200);

      const texts = JSON.stringify(response.body.data.answers);
      expect(texts).not.toContain('Governor');
      expect(texts).not.toContain('President');
    });
  });

  // ---------------------------------------------------------------------------
  // Resolution — scope
  // ---------------------------------------------------------------------------

  describe('GET /api/civics/questions/:id — the other two scopes', () => {
    it('returns every simultaneously correct answer for a none-scope question', async () => {
      const response = await request(server())
        .get(`/api/civics/questions/${Q_BRANCH}`)
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(response.body.data.answers.map((a: any) => a.text)).toEqual([
        'Congress',
        'the President',
        'the courts',
      ]);
      expect(response.body.data.answerResolution).toBe('resolved');
    });

    it('gives the same none-scope answers to learners in different states', async () => {
      const tx = await request(server())
        .get(`/api/civics/questions/${Q_BRANCH}`)
        .set(authHeader(texan.accessToken))
        .expect(200);
      const oh = await request(server())
        .get(`/api/civics/questions/${Q_BRANCH}`)
        .set(authHeader(ohioan.accessToken))
        .expect(200);

      expect(tx.body.data.answers).toEqual(oh.body.data.answers);
      expect(tx.body.data.resolvedForStateCode).toBeNull();
    });

    it('returns exactly one answer for a national-scope question, whatever the state', async () => {
      for (const learner of [texan, ohioan, nomad]) {
        const response = await request(server())
          .get(`/api/civics/questions/${Q_PRESIDENT}`)
          .set(authHeader(learner.accessToken))
          .expect(200);

        expect(response.body.data.answers.map((a: any) => a.text)).toEqual([
          'The current President',
        ]);
        expect(response.body.data.answerResolution).toBe('resolved');
      }
    });

    it('404s an unknown question id, and 400s an id that is not a uuid', async () => {
      await request(server())
        .get(`/api/civics/questions/${UNKNOWN_UUID}`)
        .set(authHeader(texan.accessToken))
        .expect(404);

      await request(server())
        .get('/api/civics/questions/not-a-uuid')
        .set(authHeader(texan.accessToken))
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Currency, evaluated against the injected clock
  // ---------------------------------------------------------------------------

  describe('only current answers are served, and the boundary is the injected Clock', () => {
    it('serves the current President and never the superseded one', async () => {
      const response = await request(server())
        .get(`/api/civics/questions/${Q_PRESIDENT}`)
        .set(authHeader(texan.accessToken))
        .set('X-Test-Clock', '2026-06-01T12:00:00Z')
        .expect(200);

      const texts = response.body.data.answers.map((a: any) => a.text);
      expect(texts).toEqual(['The current President']);
      expect(texts).not.toContain('The President before last');
    });

    it('serves the answer that was correct at the pinned instant, not at wall-clock time', async () => {
      // Three requests, three instants, three different answers out of the
      // same three unchanged rows. Nothing is re-stubbed between them, so this
      // fails outright for a service that ignores the clock.
      const at = async (instant: string) => {
        const response = await request(server())
          .get(`/api/civics/questions/${Q_PRESIDENT}`)
          .set(authHeader(texan.accessToken))
          .set('X-Test-Clock', instant)
          .expect(200);
        return response.body.data.answers.map((a: any) => a.text);
      };

      expect(await at('2019-06-01T00:00:00Z')).toEqual(['The President before last']);
      expect(await at('2026-06-01T00:00:00Z')).toEqual(['The current President']);
      expect(await at('2030-06-01T00:00:00Z')).toEqual(['The next President']);
    });

    it('treats the close/open instant as belonging to the new answer, with no gap', async () => {
      // civics-content.md §4: the old row closes and the new opens at the SAME
      // real-world instant. A reader must never observe zero current answers,
      // and must never observe two.
      const at = async (instant: string) => {
        const response = await request(server())
          .get(`/api/civics/questions/${Q_PRESIDENT}`)
          .set(authHeader(texan.accessToken))
          .set('X-Test-Clock', instant)
          .expect(200);
        return response.body.data.answers.map((a: any) => a.text);
      };

      expect(await at('2029-01-19T23:59:59Z')).toEqual(['The current President']);
      expect(await at('2029-01-20T00:00:00Z')).toEqual(['The next President']);
    });

    it('never serves a superseded state answer, at any instant after it closed', async () => {
      const at = async (instant: string) => {
        const response = await request(server())
          .get(`/api/civics/questions/${Q_GOVERNOR}`)
          .set(authHeader(texan.accessToken))
          .set('X-Test-Clock', instant)
          .expect(200);
        return response.body.data.answers.map((a: any) => a.text);
      };

      expect(await at('2020-06-01T00:00:00Z')).toEqual(['The former Governor of Texas']);
      expect(await at('2026-06-01T00:00:00Z')).toEqual(['The Governor of Texas']);
    });
  });

  // ---------------------------------------------------------------------------
  // The detail payload
  // ---------------------------------------------------------------------------

  describe('the detail payload', () => {
    it('carries verifiedAt and seniorEligible', async () => {
      const response = await request(server())
        .get(`/api/civics/questions/${Q_PRESIDENT}`)
        .set(authHeader(texan.accessToken))
        .set('X-Test-Clock', '2026-06-01T12:00:00Z')
        .expect(200);

      expect(response.body.data.verifiedAt).toBe('2026-05-20T09:30:00.000Z');
      expect(response.body.data.answers[0].verifiedAt).toBe('2026-05-20T09:30:00.000Z');
      expect(response.body.data.seniorEligible).toBe(true);
    });

    it('reports the freshest verification across several answers', async () => {
      const response = await request(server())
        .get(`/api/civics/questions/${Q_BRANCH}`)
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(response.body.data.verifiedAt).toBe('2026-06-15T00:00:00.000Z');
    });

    it('inlines the category and each answer’s citation', async () => {
      const response = await request(server())
        .get(`/api/civics/questions/${Q_GOVERNOR}`)
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(response.body.data.category).toEqual({
        id: CAT_SYSTEM,
        section: 'AMERICAN GOVERNMENT',
        code: 'system_of_government',
        name: 'A System of Government',
        sortOrder: 2,
      });
      expect(response.body.data.answers[0].sourceNote).toBe(
        'transcribed from the official source',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // The structural rule: no user id, no state, on any route
  // ---------------------------------------------------------------------------

  describe('no route accepts a user id or a state', () => {
    it('rejects ?stateCode= on the list rather than honouring it', async () => {
      // The list DTO is a `z.strictObject`, so an unknown parameter is a 400.
      // A silently accepted one would be worse: a client written against a
      // misremembered contract would quietly show Texas's governor to an
      // Ohioan, and nothing would say so.
      await request(server())
        .get('/api/civics/questions?stateCode=TX')
        .set(authHeader(ohioan.accessToken))
        .expect(400);
    });

    it('reads no query string at all on the detail route, so ?stateCode= cannot bite', async () => {
      // The detail handler has no `@Query` parameter, so there is nothing to
      // validate and nothing to honour — a stronger guarantee than a 400,
      // because there is no code path a future edit could point at the
      // parameter. The Ohioan gets Ohio.
      const response = await request(server())
        .get(`/api/civics/questions/${Q_GOVERNOR}?stateCode=TX`)
        .set(authHeader(ohioan.accessToken))
        .expect(200);

      expect(response.body.data.answers.map((a: any) => a.text)).toEqual([
        'The Governor of Ohio',
      ]);
      expect(response.body.data.resolvedForStateCode).toBe('OH');
    });

    it('rejects ?userId= rather than resolving for that user', async () => {
      await request(server())
        .get('/api/civics/questions?userId=' + texan.id)
        .set(authHeader(ohioan.accessToken))
        .expect(400);
    });

    it('ignores a userId on the detail route and still serves the caller', async () => {
      // The detail route has no `@Query` at all, so the parameter is read by
      // nothing — the Ohioan gets Ohio's governor either way.
      const response = await request(server())
        .get(`/api/civics/questions/${Q_GOVERNOR}?userId=${texan.id}`)
        .set(authHeader(ohioan.accessToken))
        .expect(200);

      expect(response.body.data.answers.map((a: any) => a.text)).toEqual([
        'The Governor of Ohio',
      ]);
      expect(prismaMock.learnerProfile.findUnique).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: texan.id } }),
      );
    });

    it('has no route that takes a user id in the path', async () => {
      await request(server())
        .get(`/api/civics/users/${texan.id}/questions`)
        .set(authHeader(ohioan.accessToken))
        .expect(404);

      await request(server())
        .get(`/api/civics/questions/${Q_GOVERNOR}/for/${texan.id}`)
        .set(authHeader(ohioan.accessToken))
        .expect(404);
    });

    it('gives an Admin no way to resolve another learner’s answers either', async () => {
      // Same structural property, not a permission check a refactor could
      // relax: no input on any of these routes names a learner or a state.
      const admin = await createMockAdminUser(context, 'admin@example.com');
      profiles.set(admin.id, { stateCode: 'OH', testVersionCode: 'v2008' });

      const response = await request(server())
        .get(`/api/civics/questions/${Q_GOVERNOR}?userId=${texan.id}&stateCode=TX`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.answers.map((a: any) => a.text)).toEqual([
        'The Governor of Ohio',
      ]);
    });

    it('never creates a learner_profiles row while reading content', async () => {
      await request(server())
        .get(`/api/civics/questions/${Q_GOVERNOR}`)
        .set(authHeader(nomad.accessToken))
        .expect(200);

      expect(prismaMock.learnerProfile.upsert).not.toHaveBeenCalled();
      expect(prismaMock.learnerProfile.create).not.toHaveBeenCalled();
      expect(prismaMock.learnerProfile.update).not.toHaveBeenCalled();
    });
  });
});

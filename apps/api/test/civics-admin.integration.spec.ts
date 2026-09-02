import request from 'supertest';
import { JwtService } from '@nestjs/jwt';

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
// Civics admin dynamic answers (integration) — issue #117, epic #51
// =============================================================================
//
// Every acceptance criterion on #117 asserted over real HTTP through
// `createTestApp`, with Prisma mocked — the shape `civics.integration.spec.ts`
// established for the read side. The unit spec covers the decisions; this file
// covers that they survive the wire: the permission guards, the global Zod
// pipe, the response envelope and the `X-Test-Clock` middleware are all in the
// path.
//
// -----------------------------------------------------------------------------
// `civics_answers` IS A REAL, MUTABLE TABLE FOR THE DURATION OF ONE TEST
// -----------------------------------------------------------------------------
//
// The Prisma mock below keeps an in-memory answer list and applies the `where`
// the service builds — for the admin read (`effective_to IS NULL`), for the
// admin write's re-read inside the transaction, and for the LEARNER-facing
// read's clock-relative predicate. `create` appends and `update` mutates.
//
// That is what makes the criterion "a learner immediately sees the new answer"
// provable at all: the correction goes in through `PUT /api/civics/dynamic-answers`
// and comes back out through `GET /api/civics/questions/:id` — two controllers,
// two permission postures, one table — with nothing stubbed in between. A
// `mockResolvedValue` on the read would have made that test assert its own
// fixture.
//
// No test in this repository touches a database (docs/TESTING.md).
// =============================================================================

// --- ids --------------------------------------------------------------------

const CAT_SYSTEM = 'c1111111-1111-4111-8111-111111111111';

const Q_SPEAKER = 'a1111111-1111-4111-8111-111111111111';
const Q_GOVERNOR = 'a2222222-2222-4222-8222-222222222222';
const Q_BRANCH = 'a3333333-3333-4333-8333-333333333333';

const UNKNOWN_UUID = 'f0000000-0000-4000-8000-000000000000';

const ROUTE = '/api/civics/dynamic-answers';

/** Pinned so `verifiedAt` is an assertable value rather than wall-clock time. */
const NOW = '2027-06-01T12:00:00Z';

// --- fixtures ---------------------------------------------------------------

const CATEGORY = {
  id: CAT_SYSTEM,
  testVersionCode: 'v2008',
  section: 'AMERICAN GOVERNMENT',
  code: 'system_of_government',
  name: 'System of Government',
  sortOrder: 2,
};

const QUESTIONS = [
  {
    id: Q_SPEAKER,
    testVersionCode: 'v2008',
    number: 47,
    categoryId: CAT_SYSTEM,
    prompt: 'What is the name of the Speaker of the House of Representatives now?',
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
    id: Q_BRANCH,
    testVersionCode: 'v2008',
    number: 13,
    categoryId: CAT_SYSTEM,
    prompt: 'Name one branch or part of the government.',
    seniorEligible: false,
    // The static question. Not administrable here, on purpose.
    dynamicScope: 'none',
  },
];

interface AnswerRow {
  id: string;
  questionId: string;
  text: string;
  sort: number;
  stateCode: string | null;
  verifiedAt: Date;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  sourceNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function seedAnswers(): AnswerRow[] {
  const stamp = new Date('2026-01-15T00:00:00Z');
  const base = {
    sort: 0,
    verifiedAt: stamp,
    effectiveTo: null,
    createdAt: stamp,
    updatedAt: stamp,
  };

  return [
    {
      ...base,
      id: 'd1111111-1111-4111-8111-111111111111',
      questionId: Q_SPEAKER,
      text: 'Jane Q. Doe',
      stateCode: null,
      effectiveFrom: new Date('2023-01-07T00:00:00Z'),
      sourceNote: 'history.house.gov, retrieved 2026-01-15',
    },
    {
      ...base,
      id: 'd2222222-2222-4222-8222-222222222222',
      questionId: Q_GOVERNOR,
      text: 'The Governor of Texas',
      stateCode: 'TX',
      effectiveFrom: new Date('2023-01-17T00:00:00Z'),
      sourceNote: 'texas.gov, retrieved 2026-01-15',
    },
    {
      ...base,
      id: 'd3333333-3333-4333-8333-333333333333',
      questionId: Q_GOVERNOR,
      text: 'The Governor of Ohio',
      stateCode: 'OH',
      effectiveFrom: new Date('2019-01-14T00:00:00Z'),
      sourceNote: 'ohio.gov, retrieved 2026-01-15',
    },
    {
      ...base,
      id: 'd4444444-4444-4444-8444-444444444444',
      questionId: Q_BRANCH,
      text: 'Congress',
      stateCode: null,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      sourceNote: 'transcribed from the official source',
    },
  ];
}

/** The mutable `civics_answers` table, for the duration of one test. */
let answers: AnswerRow[];
/** Every `audit_events` row written during one test. */
let audits: any[];
/** Learner profiles, for the #111 read endpoints. */
let profiles: Map<string, { stateCode: string | null; testVersionCode: string | null }>;
let createdCount: number;

/**
 * Apply a Prisma `where` to one answer row.
 *
 * Only the clauses the two services actually build are interpreted — and all
 * of them are, which is the point: the admin read's `effectiveTo: null`, the
 * write's in-transaction re-read, and the learner read's clock-relative pair
 * are three different predicates over the same rows, and a mock that ignored
 * any of them would let a wrong one pass.
 */
function matchesAnswer(row: AnswerRow, where: any): boolean {
  if (where.questionId !== undefined) {
    if (typeof where.questionId === 'string') {
      if (row.questionId !== where.questionId) return false;
    } else if (!where.questionId.in.includes(row.questionId)) {
      return false;
    }
  }

  if ('stateCode' in where && where.stateCode !== undefined) {
    if ((row.stateCode ?? null) !== (where.stateCode ?? null)) return false;
  }

  if ('effectiveTo' in where && where.effectiveTo !== undefined) {
    if (where.effectiveTo === null) {
      if (row.effectiveTo !== null) return false;
    } else if (where.effectiveTo.gt) {
      if (row.effectiveTo === null) return false;
      if (row.effectiveTo.getTime() <= where.effectiveTo.gt.getTime()) return false;
    }
  }

  if (where.effectiveFrom?.lte) {
    if (row.effectiveFrom.getTime() > where.effectiveFrom.lte.getTime()) return false;
  }

  if (Array.isArray(where.OR)) {
    if (!where.OR.some((clause: any) => matchesAnswer(row, clause))) return false;
  }

  return true;
}

function sortAnswers(rows: AnswerRow[]): AnswerRow[] {
  return [...rows].sort(
    (a, b) =>
      (a.stateCode ?? '').localeCompare(b.stateCode ?? '') ||
      a.sort - b.sort ||
      b.effectiveFrom.getTime() - a.effectiveFrom.getTime(),
  );
}

function setupCivicsMocks(): void {
  answers = seedAnswers();
  audits = [];
  profiles = new Map();
  createdCount = 0;

  (prismaMock.learnerProfile.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => profiles.get(where.userId) ?? null,
  );

  const matchesQuestion = (q: (typeof QUESTIONS)[number], where: any = {}) => {
    const scope = where.dynamicScope;
    if (typeof scope === 'string' && q.dynamicScope !== scope) return false;
    if (scope?.in && !scope.in.includes(q.dynamicScope)) return false;
    if (where.testVersionCode && q.testVersionCode !== where.testVersionCode) return false;
    return true;
  };

  (prismaMock.civicsQuestion.findMany as jest.Mock).mockImplementation(
    async ({ where, skip = 0, take }: any) => {
      const matched = QUESTIONS.filter((q) => matchesQuestion(q, where)).sort(
        (a, b) => a.number - b.number,
      );
      return matched.slice(skip, take === undefined ? undefined : skip + take);
    },
  );

  (prismaMock.civicsQuestion.count as jest.Mock).mockImplementation(
    async ({ where }: any) => QUESTIONS.filter((q) => matchesQuestion(q, where)).length,
  );

  (prismaMock.civicsQuestion.findUnique as jest.Mock).mockImplementation(
    async ({ where, include }: any) => {
      const found = QUESTIONS.find((q) => q.id === where.id);
      if (!found) return null;
      return include?.category ? { ...found, category: CATEGORY } : { ...found };
    },
  );

  (prismaMock.civicsAnswer.findMany as jest.Mock).mockImplementation(
    async ({ where }: any) => sortAnswers(answers.filter((row) => matchesAnswer(row, where))),
  );

  (prismaMock.civicsAnswer.findFirst as jest.Mock).mockImplementation(
    async ({ where }: any) =>
      sortAnswers(answers.filter((row) => matchesAnswer(row, where)))[0] ?? null,
  );

  (prismaMock.civicsAnswer.update as jest.Mock).mockImplementation(
    async ({ where, data }: any) => {
      const row = answers.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error(`no civics_answers row ${where.id}`);
      Object.assign(row, data);
      return { ...row };
    },
  );

  (prismaMock.civicsAnswer.create as jest.Mock).mockImplementation(async ({ data }: any) => {
    createdCount += 1;
    const row: AnswerRow = {
      id: `e0000000-0000-4000-8000-00000000000${createdCount}`,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
      ...data,
    };

    // The partial unique index civics-content.md §3.2 installs, enforced here
    // so a forgotten close is a failure rather than a silently-passing test:
    // at most ONE open row per (question, COALESCE(state,''), sort).
    const collision = answers.some(
      (existing) =>
        existing.questionId === row.questionId &&
        (existing.stateCode ?? '') === (row.stateCode ?? '') &&
        existing.sort === row.sort &&
        existing.effectiveTo === null &&
        row.effectiveTo === null,
    );
    if (collision) {
      throw new Error('civics_answers_open_slot_unique violated');
    }

    answers.push(row);
    return { ...row };
  });

  (prismaMock.auditEvent.create as jest.Mock).mockImplementation(async ({ data }: any) => {
    audits.push(data);
    return { id: `audit-${audits.length}`, ...data };
  });
}

describe('Civics dynamic answers (Integration)', () => {
  let context: TestContext;
  let admin: TestUser;
  let viewer: TestUser;
  /** A learner in Texas, used to prove a correction reaches the read API. */
  let texan: TestUser;
  /** A learner in Ohio — the contrast case for a state correction. */
  let ohioan: TestUser;

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

    admin = await createMockAdminUser(context, 'civics-admin@example.com');
    viewer = await createMockViewerUser(context, 'civics-viewer@example.com');
    texan = await createMockViewerUser(context, 'civics-texan@example.com');
    ohioan = await createMockViewerUser(context, 'civics-ohioan@example.com');

    profiles.set(texan.id, { stateCode: 'TX', testVersionCode: 'v2008' });
    profiles.set(ohioan.id, { stateCode: 'OH', testVersionCode: 'v2008' });
  });

  const server = () => context.app.getHttpServer();

  /** The body a national correction sends. */
  const SPEAKER_CORRECTION = {
    questionId: Q_SPEAKER,
    text: 'John R. Roe',
    sourceNote: 'U.S. House of Representatives, Office of the Clerk — retrieved 2027-01-04',
    effectiveFrom: '2027-01-03',
  };

  // ---------------------------------------------------------------------------
  // The permission posture — reused strings, and a read/write split
  // ---------------------------------------------------------------------------

  describe('authentication and permissions', () => {
    it('rejects an unauthenticated GET with 401', async () => {
      await request(server()).get(ROUTE).expect(401);
    });

    it('rejects an unauthenticated PUT with 401', async () => {
      await request(server()).put(ROUTE).send(SPEAKER_CORRECTION).expect(401);
    });

    it('refuses a Viewer — the default role — the read with 403', async () => {
      // The learner-facing civics routes admit a Viewer (that is the whole
      // product). This one does not: it is administering system configuration.
      await request(server()).get(ROUTE).set(authHeader(viewer.accessToken)).expect(403);
    });

    it('refuses a Viewer the write with 403, and nothing is written', async () => {
      await request(server())
        .put(ROUTE)
        .set(authHeader(viewer.accessToken))
        .send(SPEAKER_CORRECTION)
        .expect(403);

      expect(answers).toHaveLength(4);
      expect(audits).toHaveLength(0);
    });

    it('admits an Admin to both', async () => {
      await request(server()).get(ROUTE).set(authHeader(admin.accessToken)).expect(200);
      await request(server())
        .put(ROUTE)
        .set(authHeader(admin.accessToken))
        .send(SPEAKER_CORRECTION)
        .expect(200);
    });

    it('admits a system_settings:read holder to the list but refuses them the correction', async () => {
      // The split `EmailSettingsController` establishes: looking at who the
      // Speaker is recorded to be is not the same privilege as changing it.
      const readOnly = createReadOnlyUser();

      await request(server()).get(ROUTE).set(authHeader(readOnly)).expect(200);
      await request(server())
        .put(ROUTE)
        .set(authHeader(readOnly))
        .send(SPEAKER_CORRECTION)
        .expect(403);

      expect(audits).toHaveLength(0);
    });
  });

  /**
   * A caller holding ONLY `system_settings:read`.
   *
   * Wraps the registry-backed `user.findUnique` rather than replacing it, so
   * the other users in the same test still resolve.
   */
  function createReadOnlyUser(): string {
    const jwtService = context.module.get<JwtService>(JwtService);
    const id = 'read-only-civics-admin';
    const email = 'read-only-civics-admin@example.com';
    const registry = (prismaMock.user.findUnique as jest.Mock).getMockImplementation()!;

    (prismaMock.user.findUnique as jest.Mock).mockImplementation(async (args: any) => {
      if (args?.where?.id !== id && args?.where?.email !== email) {
        return registry(args);
      }
      return {
        id,
        email,
        displayName: null,
        providerDisplayName: 'Read Only Admin',
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [
          {
            role: {
              id: 'role-civics-readonly',
              name: 'readonly',
              description: 'Read-only settings access',
              rolePermissions: [
                {
                  permission: {
                    id: 'perm-ssr',
                    name: 'system_settings:read',
                    description: 'Read system settings',
                  },
                },
              ],
            },
          },
        ],
      };
    });

    return jwtService.sign({ sub: id, email, roles: ['readonly'] });
  }

  // ---------------------------------------------------------------------------
  // GET
  // ---------------------------------------------------------------------------

  describe(`GET ${ROUTE}`, () => {
    it('lists the dynamic questions and never the static one', async () => {
      const response = await request(server())
        .get(ROUTE)
        .set(authHeader(admin.accessToken))
        .expect(200);

      const numbers = response.body.data.items.map((item: any) => item.number);
      expect(numbers).toEqual([43, 47]);
      expect(response.body.data.total).toBe(2);
      expect(JSON.stringify(response.body)).not.toContain('Name one branch');
    });

    it('serves the open row with both effective dates and its citation', async () => {
      const response = await request(server())
        .get(`${ROUTE}?dynamicScope=national`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.items[0]).toMatchObject({
        questionId: Q_SPEAKER,
        dynamicScope: 'national',
        missingStateCodes: [],
      });
      expect(response.body.data.items[0].answers[0]).toMatchObject({
        text: 'Jane Q. Doe',
        stateCode: null,
        sort: 0,
        effectiveFrom: '2023-01-07T00:00:00.000Z',
        effectiveTo: null,
        sourceNote: 'history.house.gov, retrieved 2026-01-15',
      });
    });

    it('names every state with no open answer, so an unanswerable question is visible', async () => {
      const response = await request(server())
        .get(`${ROUTE}?dynamicScope=state`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      const item = response.body.data.items[0];
      expect(item.answers.map((a: any) => a.stateCode).sort()).toEqual(['OH', 'TX']);
      // 56 codes, two of them loaded.
      expect(item.missingStateCodes).toHaveLength(54);
      expect(item.missingStateCodes).toContain('WY');
      expect(item.missingStateCodes).not.toContain('TX');
    });

    it('narrows a state question to one state, and reports no gap for it', async () => {
      const response = await request(server())
        .get(`${ROUTE}?dynamicScope=state&stateCode=tx`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      // Lowercase is corrected rather than rejected — the difference carries
      // no meaning.
      expect(response.body.data.items[0].answers).toHaveLength(1);
      expect(response.body.data.items[0].answers[0].stateCode).toBe('TX');
      expect(response.body.data.items[0].missingStateCodes).toEqual([]);
    });

    it('rejects an unknown query parameter rather than ignoring it', async () => {
      // An admin who believes they are looking at Ohio must not be shown all
      // 56 states and told nothing.
      await request(server())
        .get(`${ROUTE}?state=OH`)
        .set(authHeader(admin.accessToken))
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // PUT — a national correction
  // ---------------------------------------------------------------------------

  describe(`PUT ${ROUTE} — national scope`, () => {
    it('closes the prior row and opens exactly one new one', async () => {
      const response = await request(server())
        .put(ROUTE)
        .set('X-Test-Clock', NOW)
        .set(authHeader(admin.accessToken))
        .send(SPEAKER_CORRECTION)
        .expect(200);

      expect(response.body.data).toMatchObject({
        questionId: Q_SPEAKER,
        dynamicScope: 'national',
        stateCode: null,
        previous: {
          text: 'Jane Q. Doe',
          effectiveTo: '2027-01-03T00:00:00.000Z',
        },
        current: {
          text: 'John R. Roe',
          effectiveFrom: '2027-01-03T00:00:00.000Z',
          effectiveTo: null,
          verifiedAt: '2027-06-01T12:00:00.000Z',
        },
      });

      const forSpeaker = answers.filter((row) => row.questionId === Q_SPEAKER);
      expect(forSpeaker).toHaveLength(2);
      expect(forSpeaker.filter((row) => row.effectiveTo === null)).toHaveLength(1);
    });

    it('leaves the prior row readable, with its own text and dates intact', async () => {
      // The whole reason for the lifecycle: E3's `answer_snapshot` must keep
      // pointing at text a learner was actually shown.
      await request(server())
        .put(ROUTE)
        .set('X-Test-Clock', NOW)
        .set(authHeader(admin.accessToken))
        .send(SPEAKER_CORRECTION)
        .expect(200);

      const prior = answers.find((row) => row.id === 'd1111111-1111-4111-8111-111111111111');
      expect(prior).toMatchObject({
        text: 'Jane Q. Doe',
        effectiveFrom: new Date('2023-01-07T00:00:00Z'),
        effectiveTo: new Date('2027-01-03T00:00:00Z'),
        sourceNote: 'history.house.gov, retrieved 2026-01-15',
      });
    });

    it('is immediately visible to a learner, with the new verifiedAt', async () => {
      // Through the #111 read endpoint, not through this surface: two
      // controllers, two permission postures, one table.
      const before = await request(server())
        .get(`/api/civics/questions/${Q_SPEAKER}`)
        .set('X-Test-Clock', NOW)
        .set(authHeader(texan.accessToken))
        .expect(200);
      expect(before.body.data.answers[0].text).toBe('Jane Q. Doe');

      await request(server())
        .put(ROUTE)
        .set('X-Test-Clock', NOW)
        .set(authHeader(admin.accessToken))
        .send(SPEAKER_CORRECTION)
        .expect(200);

      const after = await request(server())
        .get(`/api/civics/questions/${Q_SPEAKER}`)
        .set('X-Test-Clock', NOW)
        .set(authHeader(texan.accessToken))
        .expect(200);

      expect(after.body.data.answers).toHaveLength(1);
      expect(after.body.data.answers[0].text).toBe('John R. Roe');
      expect(after.body.data.verifiedAt).toBe('2027-06-01T12:00:00.000Z');
      expect(after.body.data.answers[0].sourceNote).toContain('Office of the Clerk');
    });

    it('stamps verifiedAt from the clock even when no effectiveFrom is submitted', async () => {
      const { effectiveFrom: _omitted, ...withoutDate } = SPEAKER_CORRECTION;

      const response = await request(server())
        .put(ROUTE)
        .set('X-Test-Clock', NOW)
        .set(authHeader(admin.accessToken))
        .send(withoutDate)
        .expect(200);

      expect(response.body.data.current.effectiveFrom).toBe('2027-06-01T12:00:00.000Z');
      expect(response.body.data.previous.effectiveTo).toBe('2027-06-01T12:00:00.000Z');
    });

    it('writes a civics:dynamic_answer_update audit row carrying the old and new text', async () => {
      await request(server())
        .put(ROUTE)
        .set('X-Test-Clock', NOW)
        .set(authHeader(admin.accessToken))
        .send(SPEAKER_CORRECTION)
        .expect(200);

      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorUserId: admin.id,
        action: 'civics:dynamic_answer_update',
        targetType: 'civics_question',
        targetId: Q_SPEAKER,
      });
      expect(audits[0].meta).toMatchObject({
        questionNumber: 47,
        testVersionCode: 'v2008',
        dynamicScope: 'national',
        stateCode: null,
        previousText: 'Jane Q. Doe',
        newText: 'John R. Roe',
        effectiveFrom: '2027-01-03T00:00:00.000Z',
        effectiveFromSource: 'submitted',
      });
    });

    it('records a second correction as its own audit row and its own pair of answers', async () => {
      await request(server())
        .put(ROUTE)
        .set('X-Test-Clock', NOW)
        .set(authHeader(admin.accessToken))
        .send(SPEAKER_CORRECTION)
        .expect(200);

      await request(server())
        .put(ROUTE)
        .set('X-Test-Clock', '2028-02-01T00:00:00Z')
        .set(authHeader(admin.accessToken))
        .send({
          questionId: Q_SPEAKER,
          text: 'Pat X. Moe',
          sourceNote: 'history.house.gov, retrieved 2028-02-01',
        })
        .expect(200);

      const forSpeaker = answers.filter((row) => row.questionId === Q_SPEAKER);
      expect(forSpeaker).toHaveLength(3);
      expect(forSpeaker.filter((row) => row.effectiveTo === null)).toHaveLength(1);
      expect(audits).toHaveLength(2);
      expect(audits[1].meta.previousText).toBe('John R. Roe');
    });
  });

  // ---------------------------------------------------------------------------
  // PUT — a state correction
  // ---------------------------------------------------------------------------

  describe(`PUT ${ROUTE} — state scope`, () => {
    const TEXAS_CORRECTION = {
      questionId: Q_GOVERNOR,
      stateCode: 'TX',
      text: 'The new Governor of Texas',
      sourceNote: 'gov.texas.gov, retrieved 2027-01-20',
      effectiveFrom: '2027-01-19',
    };

    it('corrects one state and leaves every other state alone', async () => {
      await request(server())
        .put(ROUTE)
        .set('X-Test-Clock', NOW)
        .set(authHeader(admin.accessToken))
        .send(TEXAS_CORRECTION)
        .expect(200);

      const ohio = answers.find((row) => row.stateCode === 'OH');
      expect(ohio).toMatchObject({
        text: 'The Governor of Ohio',
        effectiveTo: null,
      });

      const texas = answers.filter((row) => row.stateCode === 'TX');
      expect(texas).toHaveLength(2);
      expect(texas.filter((row) => row.effectiveTo === null)).toHaveLength(1);
    });

    it('reaches the Texan learner and not the Ohioan one', async () => {
      await request(server())
        .put(ROUTE)
        .set('X-Test-Clock', NOW)
        .set(authHeader(admin.accessToken))
        .send(TEXAS_CORRECTION)
        .expect(200);

      const forTexan = await request(server())
        .get(`/api/civics/questions/${Q_GOVERNOR}`)
        .set('X-Test-Clock', NOW)
        .set(authHeader(texan.accessToken))
        .expect(200);
      expect(forTexan.body.data.answers[0].text).toBe('The new Governor of Texas');
      expect(forTexan.body.data.verifiedAt).toBe('2027-06-01T12:00:00.000Z');

      const forOhioan = await request(server())
        .get(`/api/civics/questions/${Q_GOVERNOR}`)
        .set('X-Test-Clock', NOW)
        .set(authHeader(ohioan.accessToken))
        .expect(200);
      expect(forOhioan.body.data.answers[0].text).toBe('The Governor of Ohio');
    });

    it('records the state in the audit row', async () => {
      await request(server())
        .put(ROUTE)
        .set('X-Test-Clock', NOW)
        .set(authHeader(admin.accessToken))
        .send(TEXAS_CORRECTION)
        .expect(200);

      expect(audits[0].meta).toMatchObject({
        dynamicScope: 'state',
        stateCode: 'TX',
        previousText: 'The Governor of Texas',
        newText: 'The new Governor of Texas',
      });
    });

    it('opens the first answer for a state that had none, with a null previous', async () => {
      const response = await request(server())
        .put(ROUTE)
        .set('X-Test-Clock', NOW)
        .set(authHeader(admin.accessToken))
        .send({ ...TEXAS_CORRECTION, stateCode: 'WY', text: 'The Governor of Wyoming' })
        .expect(200);

      expect(response.body.data.previous).toBeNull();
      expect(response.body.data.current.stateCode).toBe('WY');
      expect(audits[0].meta.previousAnswerId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // PUT — what is refused
  // ---------------------------------------------------------------------------

  describe(`PUT ${ROUTE} — refusals`, () => {
    it('rejects a static (none-scope) question with 400 and writes nothing', async () => {
      const response = await request(server())
        .put(ROUTE)
        .set(authHeader(admin.accessToken))
        .send({
          questionId: Q_BRANCH,
          text: 'the legislature',
          sourceNote: 'a citation that does not make this the right path',
        })
        .expect(400);

      expect(response.body.message).toMatch(/reviewed content change/i);
      expect(answers).toHaveLength(4);
      expect(audits).toHaveLength(0);
    });

    it('rejects an unknown question with 404', async () => {
      await request(server())
        .put(ROUTE)
        .set(authHeader(admin.accessToken))
        .send({ ...SPEAKER_CORRECTION, questionId: UNKNOWN_UUID })
        .expect(404);

      expect(audits).toHaveLength(0);
    });

    it('rejects a missing sourceNote — provenance is not optional here', async () => {
      const { sourceNote: _omitted, ...unsourced } = SPEAKER_CORRECTION;

      await request(server())
        .put(ROUTE)
        .set(authHeader(admin.accessToken))
        .send(unsourced)
        .expect(400);

      expect(answers).toHaveLength(4);
    });

    it('rejects a blank sourceNote too, not only an absent one', async () => {
      await request(server())
        .put(ROUTE)
        .set(authHeader(admin.accessToken))
        .send({ ...SPEAKER_CORRECTION, sourceNote: '   ' })
        .expect(400);
    });

    it('rejects a stateCode on a national question instead of ignoring it', async () => {
      await request(server())
        .put(ROUTE)
        .set(authHeader(admin.accessToken))
        .send({ ...SPEAKER_CORRECTION, stateCode: 'TX' })
        .expect(400);

      expect(audits).toHaveLength(0);
    });

    it('rejects a state question with no stateCode rather than guessing one', async () => {
      await request(server())
        .put(ROUTE)
        .set(authHeader(admin.accessToken))
        .send({
          questionId: Q_GOVERNOR,
          text: 'somebody',
          sourceNote: 'a citation',
        })
        .expect(400);

      expect(audits).toHaveLength(0);
    });

    it('rejects a state code that is not one of the 56', async () => {
      await request(server())
        .put(ROUTE)
        .set(authHeader(admin.accessToken))
        .send({
          questionId: Q_GOVERNOR,
          stateCode: 'ZZ',
          text: 'somebody',
          sourceNote: 'a citation',
        })
        .expect(400);
    });

    it('rejects an effectiveFrom earlier than the answer being replaced', async () => {
      await request(server())
        .put(ROUTE)
        .set('X-Test-Clock', NOW)
        .set(authHeader(admin.accessToken))
        .send({ ...SPEAKER_CORRECTION, effectiveFrom: '2020-01-01' })
        .expect(400);

      expect(answers).toHaveLength(4);
      expect(audits).toHaveLength(0);
    });

    it('rejects an attempt to name an answer row directly', async () => {
      // There is no in-place edit, so there is no field that could ask for one.
      await request(server())
        .put(ROUTE)
        .set(authHeader(admin.accessToken))
        .send({ ...SPEAKER_CORRECTION, answerId: 'd1111111-1111-4111-8111-111111111111' })
        .expect(400);
    });

    it('rejects a caller-supplied verifiedAt', async () => {
      await request(server())
        .put(ROUTE)
        .set(authHeader(admin.accessToken))
        .send({ ...SPEAKER_CORRECTION, verifiedAt: '2030-01-01T00:00:00Z' })
        .expect(400);
    });
  });
});

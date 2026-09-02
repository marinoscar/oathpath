import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from './helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from './mocks/prisma.mock';
import { setupBaseMocks } from './fixtures/mock-setup.helper';
import {
  createMockTestUser,
  createMockAdminUser,
  createMockViewerUser,
  authHeader,
  TestUser,
} from './helpers/auth-mock.helper';

// =============================================================================
// Journey API (integration) — issue #65, epic #50
// =============================================================================
//
// Every acceptance criterion on #65 is asserted here over real HTTP through
// `createTestApp`, with Prisma mocked — the shape `allowlist.integration.spec.ts`
// established. Unit specs cover the decisions; this file covers that they
// survive the wire: the guards, the global Zod pipe, the response envelope and
// the `X-Test-Clock` middleware are all in the path.
//
// The Prisma mock below is a small in-memory store rather than a set of fixed
// return values, because two of the criteria — cross-user isolation and
// once-only orientation — are about which ROW is touched and about state
// persisting between two requests. A `mockResolvedValue` cannot express
// either.
// =============================================================================

const V2008 = {
  code: 'v2008',
  label: '2008 Civics Test',
  questionsAsked: 10,
  passThreshold: 6,
  seniorQuestionsAsked: 10,
  seniorPassThreshold: 6,
  contentHash: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const V2025 = {
  ...V2008,
  code: 'v2025',
  label: '2025 Civics Test',
  questionsAsked: 20,
  passThreshold: 12,
};

/** The `learner_profiles` table, for the duration of one test. */
let profiles: Map<string, Record<string, unknown>>;

/** Every `audit_events` row written during one test. */
let auditRows: Array<Record<string, any>>;

function blankProfile(userId: string): Record<string, unknown> {
  return {
    id: `profile-${userId}`,
    userId,
    stage: 'uncertain',
    interviewDate: null,
    stateCode: null,
    testVersionCode: null,
    seniorExemption: false,
    dailyGoalMinutes: 5,
    explanationLanguage: 'en',
    timezone: 'UTC',
    orientationCompletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

/**
 * Wire the journey tables into the shared Prisma mock.
 *
 * `upsert` and `update` operate on the same map, so a write in one request is
 * visible to the read in the next — which is what makes the idempotence
 * assertion meaningful rather than a restatement of a stubbed return value.
 */
function setupJourneyMocks(): void {
  profiles = new Map();
  auditRows = [];

  (prismaMock.learnerProfile.upsert as jest.Mock).mockImplementation(
    async ({ where, create }: any) => {
      const existing = profiles.get(where.userId);
      if (existing) {
        return { ...existing };
      }
      const created = blankProfile(create.userId);
      profiles.set(create.userId, created);
      return { ...created };
    },
  );

  (prismaMock.learnerProfile.update as jest.Mock).mockImplementation(
    async ({ where, data }: any) => {
      const existing = profiles.get(where.userId);
      if (!existing) {
        throw new Error(`no learner_profiles row for ${where.userId}`);
      }
      const next = { ...existing, ...data };
      // Prisma hands a `@db.Date` column back as a `Date`, whatever shape it
      // accepted going in. Re-hydrating here keeps the mock honest about the
      // type the service reads back.
      if (typeof next.interviewDate === 'string') {
        next.interviewDate = new Date(next.interviewDate);
      }
      profiles.set(where.userId, next);
      return { ...next };
    },
  );

  (prismaMock.civicsTestVersion.findMany as jest.Mock).mockResolvedValue([
    V2008,
    V2025,
  ]);

  (prismaMock.auditEvent.create as jest.Mock).mockImplementation(
    async ({ data }: any) => {
      auditRows.push(data);
      return { id: `audit-${auditRows.length}`, ...data };
    },
  );

  // A learner who has never practised (#81). Home asks for the caller's most
  // recent `practice_attempts` row to decide whether today is already done;
  // `null` is the state every account starts in, and the one test that cares
  // hands a row back.
  (prismaMock.practiceAttempt.findFirst as jest.Mock).mockResolvedValue(null);
}

/** Everything the orientation screen collects, in one request body. */
const COMPLETE_ORIENTATION = {
  filingDate: '2025-11-01',
  seniorExemption: false,
  interviewDate: '2026-03-15',
  stateCode: 'CA',
  dailyGoalMinutes: 10,
  explanationLanguage: 'es',
  timezone: 'America/Los_Angeles',
};

describe('Journey (Integration)', () => {
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
    setupJourneyMocks();
    learner = await createMockViewerUser(context, 'learner@example.com');
  });

  const server = () => context.app.getHttpServer();

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  describe('authentication', () => {
    it.each([
      ['get', '/api/journey/profile'],
      ['get', '/api/journey/home'],
      ['get', '/api/journey/stages'],
      ['put', '/api/journey/profile'],
    ] as const)('rejects an unauthenticated %s %s with 401', async (method, path) => {
      await (request(server()) as any)[method](path).expect(401);
    });

    it('admits a Viewer — the default role — to every route', async () => {
      // No permission gates these. A Viewer that could not complete
      // orientation would be hard-blocked out of the whole product by
      // `RequireOrientation`, so gating them would make the app unusable for
      // the role the gate was meant to restrict.
      await request(server())
        .get('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .expect(200);

      await request(server())
        .get('/api/journey/home')
        .set(authHeader(learner.accessToken))
        .expect(200);

      await request(server())
        .get('/api/journey/stages')
        .set(authHeader(learner.accessToken))
        .expect(200);

      await request(server())
        .put('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .send({ dailyGoalMinutes: 15 })
        .expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  // AC 1 — no route accepts a user id; cross-user access is impossible
  // ---------------------------------------------------------------------------

  describe('cross-user access is structurally impossible', () => {
    it('ignores a userId query parameter and still serves the caller', async () => {
      const victim = await createMockTestUser(context, {
        email: 'victim@example.com',
      });
      profiles.set(victim.id, {
        ...blankProfile(victim.id),
        stage: 'oriented',
        stateCode: 'NY',
        testVersionCode: 'v2025',
        timezone: 'America/New_York',
        orientationCompletedAt: new Date('2026-01-01T00:00:00Z'),
      });

      const response = await request(server())
        .get(`/api/journey/profile?userId=${victim.id}`)
        .set(authHeader(learner.accessToken))
        .expect(200);

      // The caller got their OWN blank profile. There is no `@Query` on the
      // handler at all, so the parameter was never read by anything.
      expect(response.body.data.profile.stateCode).toBeNull();
      expect(response.body.data.profile.stage).toBe('uncertain');
      expect(prismaMock.learnerProfile.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: victim.id } }),
      );
    });

    it('has no route that takes a user id in the path', async () => {
      const victim = await createMockTestUser(context, {
        email: 'victim2@example.com',
      });

      // No `:id` route exists, so these are simply not routes.
      await request(server())
        .get(`/api/journey/profile/${victim.id}`)
        .set(authHeader(learner.accessToken))
        .expect(404);

      await request(server())
        .get(`/api/journey/users/${victim.id}/profile`)
        .set(authHeader(learner.accessToken))
        .expect(404);
    });

    it('rejects a userId in the write body rather than honouring it', async () => {
      const victim = await createMockTestUser(context, {
        email: 'victim3@example.com',
      });
      profiles.set(victim.id, blankProfile(victim.id));

      await request(server())
        .put('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .send({ userId: victim.id, stateCode: 'TX' })
        .expect(400);

      // Nothing was written anywhere — not to the victim, not to the caller.
      expect(prismaMock.learnerProfile.update).not.toHaveBeenCalled();
      expect(profiles.get(victim.id)?.stateCode).toBeNull();
    });

    it('writes only ever land on the caller’s own row', async () => {
      const other = await createMockTestUser(context, {
        email: 'other@example.com',
      });
      profiles.set(other.id, blankProfile(other.id));

      await request(server())
        .put('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .send({ stateCode: 'TX' })
        .expect(200);

      expect(profiles.get(learner.id)?.stateCode).toBe('TX');
      expect(profiles.get(other.id)?.stateCode).toBeNull();

      for (const call of (prismaMock.learnerProfile.update as jest.Mock).mock
        .calls) {
        expect(call[0].where).toEqual({ userId: learner.id });
      }
    });

    it('does not let an Admin reach another learner’s profile through this module', async () => {
      // Same structural property, not a permission check a refactor could
      // relax: there is no input on any of these routes that names a learner.
      const admin = await createMockAdminUser(context, 'admin@example.com');
      profiles.set(learner.id, {
        ...blankProfile(learner.id),
        stateCode: 'WA',
      });

      const response = await request(server())
        .get(`/api/journey/profile?userId=${learner.id}`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.profile.stateCode).toBeNull();
      expect(profiles.get(learner.id)?.stateCode).toBe('WA');
    });
  });

  // ---------------------------------------------------------------------------
  // AC 2 — a first read creates the row rather than 404ing
  // ---------------------------------------------------------------------------

  describe('GET /api/journey/profile', () => {
    it('returns an uncertain profile for a user with no row, not a 404', async () => {
      expect(profiles.has(learner.id)).toBe(false);

      const response = await request(server())
        .get('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .expect(200);

      expect(response.body.data.profile).toEqual({
        stage: 'uncertain',
        interviewDate: null,
        stateCode: null,
        testVersionCode: null,
        seniorExemption: false,
        dailyGoalMinutes: 5,
        explanationLanguage: 'en',
        timezone: 'UTC',
        orientationCompletedAt: null,
      });
      expect(profiles.has(learner.id)).toBe(true);
    });

    it('serves the test versions with a derived filedFrom', async () => {
      const response = await request(server())
        .get('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .expect(200);

      const versions = response.body.data.testVersions;
      expect(versions.find((v: any) => v.code === 'v2008').filedFrom).toBeNull();
      expect(versions.find((v: any) => v.code === 'v2025').filedFrom).toBe(
        '2025-10-20',
      );
    });

    it('serves all 56 states and territories in one response with the profile', async () => {
      const response = await request(server())
        .get('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .expect(200);

      const codes = response.body.data.states.map((s: any) => s.code);
      expect(codes).toHaveLength(56);
      expect(codes).toEqual(expect.arrayContaining(['DC', 'PR', 'GU', 'VI', 'AS', 'MP']));
    });
  });

  // ---------------------------------------------------------------------------
  // AC 3 — the 400 surface
  // ---------------------------------------------------------------------------

  describe('PUT /api/journey/profile validation', () => {
    const badBodies: Array<[string, Record<string, unknown>]> = [
      ['an unknown state code', { stateCode: 'ZZ' }],
      ['a three-letter state code', { stateCode: 'CAL' }],
      ['an unknown test version', { testVersionCode: 'v1999' }],
      ['a malformed timezone', { timezone: 'Not/AZone' }],
      ['an empty timezone', { timezone: '' }],
      ['a bad BCP-47 tag', { explanationLanguage: 'en_US' }],
      ['a one-letter language tag', { explanationLanguage: 'e' }],
      ['a zero daily goal', { dailyGoalMinutes: 0 }],
      ['an absurd daily goal', { dailyGoalMinutes: 100000 }],
      ['a malformed interview date', { interviewDate: '15-03-2026' }],
      [
        'both a filing date and a test version',
        { filingDate: '2025-10-20', testVersionCode: 'v2008' },
      ],
      ['a stage the client tried to set', { stage: 'ready' }],
    ];

    it.each(badBodies)('rejects %s with 400', async (_label, body) => {
      await request(server())
        .put('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .send(body)
        .expect(400);

      expect(prismaMock.learnerProfile.update).not.toHaveBeenCalled();
    });

    it('rejects an unknown test version against the rows, not a hardcoded list', async () => {
      // The check names the codes that ARE valid, and they come from
      // `civics_test_versions` — so a future revision row is accepted the day
      // it is seeded, with no code change here.
      const response = await request(server())
        .put('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .send({ testVersionCode: 'v1999' })
        .expect(400);

      expect(response.body.message).toContain('v2008, v2025');
    });

    it('accepts a lowercase state code, correcting it rather than refusing', async () => {
      const response = await request(server())
        .put('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .send({ stateCode: 'ny' })
        .expect(200);

      expect(response.body.data.profile.stateCode).toBe('NY');
    });
  });

  // ---------------------------------------------------------------------------
  // AC 4 — orientation completes once, and is audited
  // ---------------------------------------------------------------------------

  describe('orientation completion', () => {
    it('sets orientationCompletedAt and moves the stage to oriented', async () => {
      const response = await request(server())
        .put('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .set('X-Test-Clock', '2026-02-01T10:00:00Z')
        .send(COMPLETE_ORIENTATION)
        .expect(200);

      expect(response.body.data.profile.stage).toBe('oriented');
      expect(response.body.data.profile.orientationCompletedAt).toBe(
        '2026-02-01T10:00:00.000Z',
      );
      // The server resolved the test version from the filing date; the client
      // never sent one and never learned the cutoff rule.
      expect(response.body.data.profile.testVersionCode).toBe('v2025');
    });

    it('writes a journey:profile_update audit row naming fields, never values', async () => {
      await request(server())
        .put('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .set('X-Test-Clock', '2026-02-01T10:00:00Z')
        .send(COMPLETE_ORIENTATION)
        .expect(200);

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({
          actorUserId: learner.id,
          action: 'journey:profile_update',
          targetType: 'learner_profile',
          targetId: learner.id,
        }),
      );
      expect(auditRows[0].meta.orientationCompleted).toBe(true);
      expect(auditRows[0].meta.fields.sort()).toEqual([
        'dailyGoalMinutes',
        'explanationLanguage',
        'interviewDate',
        'stateCode',
        'testVersionCode',
        'timezone',
      ]);

      // Not one of the values the learner typed appears in the audit meta.
      const meta = JSON.stringify(auditRows[0].meta);
      for (const value of ['CA', '2026-03-15', 'America/Los_Angeles', 'v2025']) {
        expect(meta).not.toContain(value);
      }
    });

    it('is idempotent — a second identical save changes neither the stamp nor the stage', async () => {
      await request(server())
        .put('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .set('X-Test-Clock', '2026-02-01T10:00:00Z')
        .send(COMPLETE_ORIENTATION)
        .expect(200);

      // A day later, the settings page saves the same form again.
      const second = await request(server())
        .put('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .set('X-Test-Clock', '2026-02-02T10:00:00Z')
        .send(COMPLETE_ORIENTATION)
        .expect(200);

      expect(second.body.data.profile.orientationCompletedAt).toBe(
        '2026-02-01T10:00:00.000Z',
      );
      expect(second.body.data.profile.stage).toBe('oriented');

      // The transition did not re-run: the second write touched neither field.
      const secondUpdate = (prismaMock.learnerProfile.update as jest.Mock).mock
        .calls[1][0];
      expect(secondUpdate.data).not.toHaveProperty('orientationCompletedAt');
      expect(secondUpdate.data).not.toHaveProperty('stage');
      expect(auditRows[1].meta.orientationCompleted).toBe(false);
    });

    it('does not complete on a partial form', async () => {
      const response = await request(server())
        .put('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .send({ stateCode: 'CA', dailyGoalMinutes: 20 })
        .expect(200);

      expect(response.body.data.profile.orientationCompletedAt).toBeNull();
      expect(response.body.data.profile.stage).toBe('uncertain');
    });

    it('leaves untouched fields alone across two partial saves', async () => {
      await request(server())
        .put('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .send({ timezone: 'Asia/Tokyo' })
        .expect(200);

      const response = await request(server())
        .put('/api/journey/profile')
        .set(authHeader(learner.accessToken))
        .send({ dailyGoalMinutes: 30 })
        .expect(200);

      expect(response.body.data.profile.timezone).toBe('Asia/Tokyo');
      expect(response.body.data.profile.dailyGoalMinutes).toBe(30);
    });
  });

  // ---------------------------------------------------------------------------
  // AC 5 and 6 — home, the next action, and the clock
  // ---------------------------------------------------------------------------

  describe('GET /api/journey/home', () => {
    /** The only paths the recommender is allowed to emit. Real, mounted routes. */
    const ALLOWED_PATHS = ['/setup/journey', '/learn', '/practice'];
    const ALLOWED_KINDS = [
      'orientation',
      'interview_countdown',
      'practice',
      'explore',
    ];

    async function orient(
      overrides: Record<string, unknown> = {},
    ): Promise<void> {
      profiles.set(learner.id, {
        ...blankProfile(learner.id),
        stage: 'oriented',
        stateCode: 'CA',
        testVersionCode: 'v2025',
        orientationCompletedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
      });
    }

    it('reports the goal as untracked, and invents no minutesToday', async () => {
      await orient({ dailyGoalMinutes: 10 });

      const response = await request(server())
        .get('/api/journey/home')
        .set(authHeader(learner.accessToken))
        .expect(200);

      expect(response.body.data.dailyGoal).toEqual({
        minutes: 10,
        tracked: false,
      });
      expect(response.body.data.dailyGoal).not.toHaveProperty('minutesToday');
    });

    it.each([
      ['unoriented', {}, 'orientation'],
      [
        'oriented with an upcoming interview',
        {
          stage: 'oriented',
          stateCode: 'CA',
          testVersionCode: 'v2025',
          orientationCompletedAt: new Date('2026-01-01T00:00:00Z'),
          interviewDate: new Date('2026-03-15T00:00:00Z'),
        },
        'interview_countdown',
      ],
      [
        'oriented with no interview and nothing practised today',
        {
          stage: 'oriented',
          stateCode: 'CA',
          testVersionCode: 'v2025',
          orientationCompletedAt: new Date('2026-01-01T00:00:00Z'),
        },
        'practice',
      ],
      [
        'oriented with a past interview and nothing practised today',
        {
          stage: 'oriented',
          stateCode: 'CA',
          testVersionCode: 'v2025',
          orientationCompletedAt: new Date('2026-01-01T00:00:00Z'),
          interviewDate: new Date('2026-01-05T00:00:00Z'),
        },
        'practice',
      ],
    ])(
      'recommends %s → %s, on a permitted path',
      async (_label, profile, expectedKind) => {
        profiles.set(learner.id, {
          ...blankProfile(learner.id),
          ...(profile as Record<string, unknown>),
        });

        const response = await request(server())
          .get('/api/journey/home')
          .set(authHeader(learner.accessToken))
          .set('X-Test-Clock', '2026-02-01T12:00:00Z')
          .expect(200);

        const { nextAction } = response.body.data;
        expect(nextAction.kind).toBe(expectedKind);
        expect(ALLOWED_KINDS).toContain(nextAction.kind);
        expect(ALLOWED_PATHS).toContain(nextAction.path);
        expect(nextAction.title.length).toBeGreaterThan(0);
        expect(nextAction.reason.length).toBeGreaterThan(0);
      },
    );

    it('is deterministic — two consecutive loads return an identical body', async () => {
      await orient({ interviewDate: new Date('2026-03-15T00:00:00Z') });

      const first = await request(server())
        .get('/api/journey/home')
        .set(authHeader(learner.accessToken))
        .set('X-Test-Clock', '2026-02-01T12:00:00Z')
        .expect(200);

      const second = await request(server())
        .get('/api/journey/home')
        .set(authHeader(learner.accessToken))
        .set('X-Test-Clock', '2026-02-01T12:00:00Z')
        .expect(200);

      expect(first.body.data).toEqual(second.body.data);
    });

    // -------------------------------------------------------------------------
    // AC — the `practice` next action (#81, epic #52)
    // -------------------------------------------------------------------------
    //
    // The kind E3 added, over the wire: the union widened, the Zod response
    // schema widened with it (it enumerates from the recommender's own array),
    // and the path is one more hardcoded, verified route.
    describe('the practice next action', () => {
      it('sends an oriented learner with no attempts and no interview to /practice', async () => {
        await orient();

        const response = await request(server())
          .get('/api/journey/home')
          .set(authHeader(learner.accessToken))
          .set('X-Test-Clock', '2026-02-01T12:00:00Z')
          .expect(200);

        const { nextAction } = response.body.data;
        expect(nextAction.kind).toBe('practice');
        expect(nextAction.path).toBe('/practice');
        expect(nextAction.title).toBe('Practice five questions.');
        expect(nextAction.reason.length).toBeGreaterThan(0);
        // No interview is booked, so nothing about the card is a countdown.
        expect(response.body.data.daysUntilInterview).toBeNull();
      });

      it('scopes the attempt lookup to the caller', async () => {
        await orient();

        await request(server())
          .get('/api/journey/home')
          .set(authHeader(learner.accessToken))
          .set('X-Test-Clock', '2026-02-01T12:00:00Z')
          .expect(200);

        expect(prismaMock.practiceAttempt.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ where: { userId: learner.id } }),
        );
      });

      it('falls through to explore once the learner has practised today', async () => {
        await orient({ timezone: 'UTC' });
        (prismaMock.practiceAttempt.findFirst as jest.Mock).mockResolvedValue({
          answeredAt: new Date('2026-02-01T09:00:00Z'),
        });

        const response = await request(server())
          .get('/api/journey/home')
          .set(authHeader(learner.accessToken))
          .set('X-Test-Clock', '2026-02-01T12:00:00Z')
          .expect(200);

        const { nextAction } = response.body.data;
        expect(nextAction.kind).toBe('explore');
        expect(nextAction.path).toBe('/learn');
        // The E1 copy said the practice tools were "on their way". They have
        // arrived, and this branch is only ever reached by someone who has
        // just used them.
        expect(nextAction.reason).not.toContain('on their way');
      });

      it('re-points the interview countdown at /practice', async () => {
        // The change practice-sessions.md §12 and the recommender's own E1
        // header both name: `/learn` until Practice had real content, and
        // `/practice` from the moment it did.
        await orient({
          timezone: 'UTC',
          interviewDate: new Date('2026-03-15T00:00:00Z'),
        });

        const response = await request(server())
          .get('/api/journey/home')
          .set(authHeader(learner.accessToken))
          .set('X-Test-Clock', '2026-02-01T12:00:00Z')
          .expect(200);

        expect(response.body.data.nextAction.kind).toBe('interview_countdown');
        expect(response.body.data.nextAction.path).toBe('/practice');
      });

      it('decides "today" on the learner’s calendar day, not on UTC’s', async () => {
        // Auckland is UTC+13 in February, and both instants below fall on
        // 15 February in UTC — so a server comparing UTC days could not tell
        // them apart and would report this learner's work as done.
        //
        //   now:     2026-02-15T11:30Z = 2026-02-16 00:30 in Auckland (today)
        //   attempt: 2026-02-15T10:59Z = 2026-02-15 23:59 in Auckland (yesterday)
        //
        // They practised last night, not today, and Home must say so.
        await orient({ timezone: 'Pacific/Auckland' });
        (prismaMock.practiceAttempt.findFirst as jest.Mock).mockResolvedValue({
          answeredAt: new Date('2026-02-15T10:59:00Z'),
        });

        const response = await request(server())
          .get('/api/journey/home')
          .set(authHeader(learner.accessToken))
          .set('X-Test-Clock', '2026-02-15T11:30:00Z')
          .expect(200);

        expect(response.body.data.nextAction.kind).toBe('practice');
      });
    });

    describe('the countdown respects X-Test-Clock', () => {
      it('counts whole calendar days to a pinned instant', async () => {
        await orient({
          timezone: 'UTC',
          interviewDate: new Date('2026-02-15T00:00:00Z'),
        });

        const response = await request(server())
          .get('/api/journey/home')
          .set(authHeader(learner.accessToken))
          .set('X-Test-Clock', '2026-02-01T00:00:00Z')
          .expect(200);

        expect(response.body.data.daysUntilInterview).toBe(14);
        expect(response.body.data.interviewPast).toBe(false);
        expect(response.body.data.nextAction.title).toBe(
          '14 days until your interview',
        );
      });

      it('counts in the LEARNER’s timezone when it is on a different calendar day from UTC', async () => {
        // 2026-02-14T20:00Z is already 15 February in Auckland (UTC+13 in
        // February). A server counting in UTC would report 6 days; the
        // learner's own calendar says 5. That one-day difference is the whole
        // reason the count goes through `Clock.calendarDateIn` rather than
        // through an elapsed-milliseconds division.
        await orient({
          timezone: 'Pacific/Auckland',
          interviewDate: new Date('2026-02-20T00:00:00Z'),
        });

        const response = await request(server())
          .get('/api/journey/home')
          .set(authHeader(learner.accessToken))
          .set('X-Test-Clock', '2026-02-14T20:00:00Z')
          .expect(200);

        expect(response.body.data.daysUntilInterview).toBe(5);
        expect(response.body.data.nextAction.title).toBe(
          '5 days until your interview',
        );
      });

      it('says the interview is today on the day itself, and does not call it past', async () => {
        await orient({
          timezone: 'America/Los_Angeles',
          interviewDate: new Date('2026-02-14T00:00:00Z'),
        });

        // 2026-02-15T05:00Z is still 14 February in Los Angeles (UTC-8).
        const response = await request(server())
          .get('/api/journey/home')
          .set(authHeader(learner.accessToken))
          .set('X-Test-Clock', '2026-02-15T05:00:00Z')
          .expect(200);

        expect(response.body.data.daysUntilInterview).toBe(0);
        expect(response.body.data.interviewPast).toBe(false);
        expect(response.body.data.nextAction.kind).toBe('interview_countdown');
        expect(response.body.data.nextAction.title).toBe(
          'Your interview is today.',
        );
      });

      it('reports a past interview as past and stops counting down', async () => {
        await orient({
          timezone: 'UTC',
          interviewDate: new Date('2026-01-20T00:00:00Z'),
        });

        const response = await request(server())
          .get('/api/journey/home')
          .set(authHeader(learner.accessToken))
          .set('X-Test-Clock', '2026-02-01T00:00:00Z')
          .expect(200);

        expect(response.body.data.daysUntilInterview).toBe(-12);
        expect(response.body.data.interviewPast).toBe(true);
        // The countdown stops; the recommendation falls through to the rung
        // E3 inserted below it. Nobody has told us how the interview went, so
        // "practise today" is the one suggestion true either way.
        expect(response.body.data.nextAction.kind).toBe('practice');
      });

      it('advances the countdown when the pinned clock advances', async () => {
        await orient({
          timezone: 'UTC',
          interviewDate: new Date('2026-02-15T00:00:00Z'),
        });

        const early = await request(server())
          .get('/api/journey/home')
          .set(authHeader(learner.accessToken))
          .set('X-Test-Clock', '2026-02-01T00:00:00Z')
          .expect(200);

        const later = await request(server())
          .get('/api/journey/home')
          .set(authHeader(learner.accessToken))
          .set('X-Test-Clock', '2026-02-08T00:00:00Z')
          .expect(200);

        expect(early.body.data.daysUntilInterview).toBe(14);
        expect(later.body.data.daysUntilInterview).toBe(7);
      });

      it('reports no countdown at all when no interview is booked', async () => {
        await orient();

        const response = await request(server())
          .get('/api/journey/home')
          .set(authHeader(learner.accessToken))
          .set('X-Test-Clock', '2026-02-01T00:00:00Z')
          .expect(200);

        expect(response.body.data.interviewDate).toBeNull();
        expect(response.body.data.daysUntilInterview).toBeNull();
        expect(response.body.data.interviewPast).toBe(false);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // The stage registry
  // ---------------------------------------------------------------------------

  describe('GET /api/journey/stages', () => {
    it('serves the eight stages in journey order to any authenticated user', async () => {
      const response = await request(server())
        .get('/api/journey/stages')
        .set(authHeader(learner.accessToken))
        .expect(200);

      expect(response.body.data.map((s: any) => s.key)).toEqual([
        'uncertain',
        'oriented',
        'learning',
        'remembering',
        'speaking',
        'practicing',
        'performing',
        'ready',
      ]);
    });

    it('carries copy for every stage, and nothing else', async () => {
      const response = await request(server())
        .get('/api/journey/stages')
        .set(authHeader(learner.accessToken))
        .expect(200);

      for (const stage of response.body.data) {
        expect(Object.keys(stage).sort()).toEqual([
          'description',
          'key',
          'label',
        ]);
        expect(stage.label.length).toBeGreaterThan(0);
        expect(stage.description.length).toBeGreaterThan(0);
      }
    });

    it('does not read the database', async () => {
      await request(server())
        .get('/api/journey/stages')
        .set(authHeader(learner.accessToken))
        .expect(200);

      expect(prismaMock.learnerProfile.upsert).not.toHaveBeenCalled();
      expect(prismaMock.civicsTestVersion.findMany).not.toHaveBeenCalled();
    });
  });
});

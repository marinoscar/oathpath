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
import { STREAK_FREEZE_MAX } from '../src/engagement/streaks/freeze-settlement';

// =============================================================================
// Engagement API (integration) — issue #119, epic #56 / E7 "Habit"
// =============================================================================
//
// `GET /api/engagement/summary` over real HTTP through `createTestApp`, plus
// the two accrual triggers driven the only honest way — by actually answering
// questions through `POST /api/practice/sessions/{id}/attempts` — with Prisma
// mocked, the shape `progress.integration.spec.ts`, `readiness.integration
// .spec.ts` and `practice.integration.spec.ts` all establish.
//
// -----------------------------------------------------------------------------
// THE PRISMA MOCK IS A SMALL IN-MEMORY STORE, NOT FIXED RETURN VALUES
// -----------------------------------------------------------------------------
//
// Every property this file exists to prove is about WHICH ROW a later request
// sees: "two attempts either side of UTC midnight produce ONE row", "the
// caller never sees another learner's day", "a second settlement writes
// nothing". A `mockResolvedValue` cannot express any of them — a service that
// ignored the local day entirely would still pass.
//
// The clock is pinned per request with `X-Test-Clock` (docs/TESTING.md,
// `test/clock.integration.spec.ts`) rather than by sleeping or by asserting
// against whatever the wall clock reads, which is what makes the timezone
// assertions below deterministic in every CI region.
//
// No test in this repository touches a database (docs/TESTING.md).
// =============================================================================

const TV = 'vengage2026';
const CATEGORY_ID = 'b1111111-1111-4111-8111-111111111111';

const Q1 = 'b2111111-1111-4111-8111-111111111111';
const Q2 = 'b2222222-2222-4222-8222-222222222222';
const Q3 = 'b2333333-3333-4333-8333-333333333333';

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
    id: Q3,
    testVersionCode: TV,
    number: 3,
    categoryId: CATEGORY_ID,
    prompt: 'How many U.S. Senators are there?',
    seniorEligible: false,
    dynamicScope: 'none' as const,
  },
];

function answerRow(over: Record<string, any>) {
  return {
    id: over.id,
    questionId: over.questionId,
    text: over.text,
    sort: over.sort ?? 0,
    stateCode: over.stateCode ?? null,
    verifiedAt: new Date('2026-01-01T00:00:00Z'),
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
  };
}

const ANSWERS = [
  answerRow({ id: 'e1', questionId: Q1, text: 'Congress' }),
  answerRow({ id: 'e2', questionId: Q2, text: 'the Constitution' }),
  answerRow({ id: 'e3', questionId: Q3, text: 'one hundred' }),
];

interface ProfileRow {
  stage: string;
  stateCode: string | null;
  testVersionCode: string | null;
  seniorExemption: boolean;
  timezone: string;
  dailyGoalMinutes: number;
  streakFreezes: number;
  streakFreezesGrantedAt: Date | null;
}

let profiles: Map<string, ProfileRow>;
let sessions: Map<string, Record<string, any>>;
let attempts: Map<string, Record<string, any>>;
let mastery: Map<string, Record<string, any>>;
let snapshots: Map<string, Record<string, any>>;
/** `daily_activity`, keyed `${userId}|${YYYY-MM-DD}` — mirroring its own `@@unique([userId, activityDate])`. */
let activity: Map<string, Record<string, any>>;

function seedProfile(userId: string, overrides: Partial<ProfileRow> = {}): void {
  profiles.set(userId, {
    stage: 'oriented',
    stateCode: 'CA',
    testVersionCode: TV,
    seniorExemption: false,
    timezone: 'UTC',
    dailyGoalMinutes: 5,
    streakFreezes: STREAK_FREEZE_MAX,
    streakFreezesGrantedAt: null,
    ...overrides,
  });
}

/** A day the learner met their goal on, written straight into the store. */
function seedMetDay(userId: string, date: string, timezone = 'UTC'): void {
  activity.set(`${userId}|${date}`, {
    id: randomUUID(),
    userId,
    activityDate: new Date(`${date}T00:00:00.000Z`),
    tzUsed: timezone,
    practiceSeconds: 600,
    attempts: 5,
    correct: 5,
    goalMet: true,
    freezeUsed: false,
  });
}

const dateKey = (value: Date): string => value.toISOString().slice(0, 10);

function activityFor(userId: string): Array<Record<string, any>> {
  return Array.from(activity.values())
    .filter((row) => row.userId === userId)
    .sort((a, b) => a.activityDate.getTime() - b.activityDate.getTime());
}

/**
 * Wire every table this suite's requests touch into the shared Prisma mock as
 * a small relational store, filtering on `where` for real.
 *
 * The practice tables are here because accrual has no honest trigger other
 * than a real attempt: asserting the engagement summary against rows this file
 * inserted by hand would prove the reader, not the product.
 */
function setupEngagementMocks(): void {
  profiles = new Map();
  sessions = new Map();
  attempts = new Map();
  mastery = new Map();
  snapshots = new Map();
  activity = new Map();

  // --- learner_profiles ------------------------------------------------------
  (prismaMock.learnerProfile.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      const profile = profiles.get(where.userId);
      return profile ? { ...profile } : null;
    },
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

  // --- civics content --------------------------------------------------------
  (prismaMock.civicsCategory.findFirst as jest.Mock).mockImplementation(async ({ where }: any) =>
    where.id === CATEGORY_ID && where.testVersionCode === TV
      ? { id: CATEGORY_ID, testVersionCode: TV }
      : null,
  );

  (prismaMock.civicsCategory.findMany as jest.Mock).mockImplementation(async ({ where }: any) => {
    const ids: string[] | undefined = where?.id?.in;
    const all = [{ id: CATEGORY_ID, name: 'Category', testVersionCode: TV, sortOrder: 0, code: 'c' }];
    return ids === undefined ? all : all.filter((c) => ids.includes(c.id));
  });

  (prismaMock.civicsQuestion.findMany as jest.Mock).mockImplementation(async ({ where = {} }: any) =>
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
    return ANSWERS.filter(
      (a) =>
        a.questionId === where.questionId &&
        (a.stateCode ?? null) === (where.stateCode ?? null) &&
        a.effectiveFrom.getTime() <= now.getTime(),
    ).sort((x, y) => x.sort - y.sort);
  });

  // --- practice_sessions -----------------------------------------------------
  (prismaMock.practiceSession.create as jest.Mock).mockImplementation(async ({ data }: any) => {
    const row = { completedAt: null, summary: null, ...data, id: randomUUID() };
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
    const next = { ...sessions.get(where.id), ...data };
    sessions.set(where.id, next);
    return { ...next };
  });

  (prismaMock.practiceSession.findMany as jest.Mock).mockResolvedValue([]);
  (prismaMock.practiceSession.count as jest.Mock).mockResolvedValue(0);

  // --- practice_attempts -----------------------------------------------------
  function matchesAttemptWhere(row: any, where: Record<string, any>): boolean {
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.sessionId !== undefined && row.sessionId !== where.sessionId) return false;
    if (where.questionId !== undefined && row.questionId !== where.questionId) return false;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.hintUsed !== undefined && row.hintUsed !== where.hintUsed) return false;
    if (where.revealed !== undefined && row.revealed !== where.revealed) return false;
    if (where.inputMode !== undefined && row.inputMode !== where.inputMode) return false;
    if (where.outcome !== undefined && row.outcome !== where.outcome) return false;
    const gte = where.answeredAt?.gte as Date | undefined;
    if (gte && row.answeredAt.getTime() < gte.getTime()) return false;
    const lt = where.answeredAt?.lt as Date | undefined;
    if (lt && row.answeredAt.getTime() >= lt.getTime()) return false;
    // INCLUSIVE, because `EngagementService.sliceSeconds` is: an event at the
    // same instant as this one is a previous event, not a missing one.
    const lte = where.answeredAt?.lte as Date | undefined;
    if (lte && row.answeredAt.getTime() > lte.getTime()) return false;
    return true;
  }

  function sortAttempts(rows: any[], orderBy: any): any[] {
    const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return rows.slice().sort((a, b) => {
      for (const clause of clauses) {
        if (clause.answeredAt) {
          const diff = a.answeredAt.getTime() - b.answeredAt.getTime();
          if (diff !== 0) return clause.answeredAt === 'desc' ? -diff : diff;
        }
        if (clause.id) {
          const diff = String(a.id).localeCompare(String(b.id));
          if (diff !== 0) return clause.id === 'desc' ? -diff : diff;
        }
      }
      return 0;
    });
  }

  const withQuestion = (row: any) => ({
    ...row,
    question: QUESTIONS.find((q) => q.id === row.questionId),
  });

  (prismaMock.practiceAttempt.create as jest.Mock).mockImplementation(async ({ data }: any) => {
    const row = { ...data, id: randomUUID() };
    attempts.set(row.id, row);
    return withQuestion(row);
  });

  (prismaMock.practiceAttempt.update as jest.Mock).mockImplementation(async ({ where, data }: any) => {
    const next = { ...attempts.get(where.id), ...data };
    attempts.set(where.id, next);
    return withQuestion(next);
  });

  (prismaMock.practiceAttempt.findFirst as jest.Mock).mockImplementation(
    async ({ where = {}, orderBy, skip }: any) => {
      const rows = sortAttempts(
        Array.from(attempts.values()).filter((row) => matchesAttemptWhere(row, where)),
        orderBy,
      );
      // `skip` is load-bearing for `sliceSeconds`: accrual event (a) runs after
      // its own attempt row commits, so it skips exactly that row rather than
      // treating itself as its own predecessor. A stub that dropped `skip`
      // would silently report every attempt as zero seconds.
      const row = rows[skip ?? 0];
      return row ? withQuestion(row) : null;
    },
  );

  (prismaMock.practiceAttempt.findMany as jest.Mock).mockImplementation(
    async ({ where = {}, orderBy, take, distinct }: any) => {
      let rows = sortAttempts(
        Array.from(attempts.values()).filter((row) => matchesAttemptWhere(row, where)),
        orderBy ?? [{ answeredAt: 'asc' }, { id: 'asc' }],
      );

      if (Array.isArray(distinct) && distinct.includes('questionId')) {
        const seen = new Set<string>();
        rows = rows.filter((row) => {
          if (seen.has(row.questionId)) return false;
          seen.add(row.questionId);
          return true;
        });
      }

      if (typeof take === 'number') rows = rows.slice(0, take);

      return rows.map(withQuestion);
    },
  );

  (prismaMock.practiceAttempt.groupBy as jest.Mock).mockImplementation(async ({ where }: any) => {
    const ids = new Set(
      Array.from(attempts.values())
        .filter((row) => row.userId === where.userId)
        .map((row) => row.questionId),
    );
    return Array.from(ids).map((questionId) => ({ questionId }));
  });

  // --- question_mastery ------------------------------------------------------
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
      const row = existing ? { ...existing, ...update } : { id: randomUUID(), ...create };
      mastery.set(mapKey, row);
      return { ...row };
    },
  );

  // --- readiness_snapshots ---------------------------------------------------
  //
  // A real store, not `setupBaseMocks`' generic default: the invariant test
  // below asks for readiness TWICE and needs the second answer to be a genuine
  // recomputation over the evidence as it then stands.
  (prismaMock.readinessSnapshot.create as jest.Mock).mockImplementation(async ({ data }: any) => {
    const row = { id: randomUUID(), narrative: null, narrativeGeneratedAt: null, ...data };
    snapshots.set(row.id, row);
    return { ...row };
  });

  (prismaMock.readinessSnapshot.findFirst as jest.Mock).mockImplementation(async ({ where }: any) => {
    const rows = Array.from(snapshots.values())
      .filter((row) => row.userId === where.userId)
      .sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime());
    return rows[0] ? { ...rows[0] } : null;
  });

  (prismaMock.readinessSnapshot.findMany as jest.Mock).mockResolvedValue([]);
  (prismaMock.readinessSnapshot.count as jest.Mock).mockResolvedValue(0);

  // --- daily_activity --------------------------------------------------------
  (prismaMock.dailyActivity.upsert as jest.Mock).mockImplementation(
    async ({ where, create, update }: any) => {
      const { userId, activityDate } = where.userId_activityDate;
      const key = `${userId}|${dateKey(activityDate)}`;
      const existing = activity.get(key);

      if (!existing) {
        const row = {
          id: randomUUID(),
          goalMet: false,
          freezeUsed: false,
          practiceSeconds: 0,
          attempts: 0,
          correct: 0,
          ...create,
        };
        activity.set(key, row);
        return { ...row };
      }

      const next = { ...existing };
      for (const [field, value] of Object.entries(update as Record<string, any>)) {
        (next as any)[field] =
          value && typeof value === 'object' && 'increment' in value
            ? (next as any)[field] + value.increment
            : value;
      }
      activity.set(key, next);
      return { ...next };
    },
  );

  (prismaMock.dailyActivity.updateMany as jest.Mock).mockImplementation(async ({ where, data }: any) => {
    let count = 0;
    for (const [key, row] of activity) {
      if (row.userId !== where.userId) continue;
      if (where.activityDate && dateKey(row.activityDate) !== dateKey(where.activityDate)) continue;
      if (where.goalMet !== undefined && row.goalMet !== where.goalMet) continue;
      if (where.practiceSeconds?.gte !== undefined && row.practiceSeconds < where.practiceSeconds.gte) {
        continue;
      }
      activity.set(key, { ...row, ...data });
      count += 1;
    }
    return { count };
  });

  (prismaMock.dailyActivity.findMany as jest.Mock).mockImplementation(async ({ where }: any) =>
    activityFor(where.userId).map((row) => ({ ...row })),
  );
}

describe('Engagement (Integration)', () => {
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
    setupEngagementMocks();

    learnerA = await createMockViewerUser(context, 'engagementLearnerA@example.com');
    learnerB = await createMockViewerUser(context, 'engagementLearnerB@example.com');

    seedProfile(learnerA.id);
    seedProfile(learnerB.id);
  });

  const server = () => context.app.getHttpServer();

  /** A request with the clock pinned — every timing assertion below is deterministic because of this. */
  function at(user: TestUser, instant: string) {
    return {
      get: (path: string) =>
        request(server())
          .get(path)
          .set(authHeader(user.accessToken))
          .set('x-test-clock', instant),
      post: (path: string) =>
        request(server())
          .post(path)
          .set(authHeader(user.accessToken))
          .set('x-test-clock', instant),
    };
  }

  async function startSession(user: TestUser, instant: string, plannedCount = 3) {
    const response = await at(user, instant)
      .post('/api/practice/sessions')
      .send({ kind: 'quick', plannedCount })
      .expect(201);
    return response.body.data;
  }

  async function answer(
    user: TestUser,
    instant: string,
    sessionId: string,
    questionId: string,
  ) {
    return at(user, instant)
      .post(`/api/practice/sessions/${sessionId}/attempts`)
      .send({ questionId, responseText: 'a response nobody accepts', revealed: true })
      .expect(201);
  }

  // ---------------------------------------------------------------------------
  // Authentication and the route's posture
  // ---------------------------------------------------------------------------

  it('401s an unauthenticated request', async () => {
    await request(server()).get('/api/engagement/summary').expect(401);
  });

  it('admits a Viewer — the default role, holding no permissions', async () => {
    await at(learnerA, '2026-04-10T12:00:00.000Z').get('/api/engagement/summary').expect(200);
  });

  it('returns honest zeros, never a null `today`, for a learner who has never practised', async () => {
    const response = await at(learnerA, '2026-04-10T12:00:00.000Z')
      .get('/api/engagement/summary')
      .expect(200);
    const body = response.body.data;

    expect(body.today).toEqual({
      date: '2026-04-10',
      practiceSeconds: 0,
      attempts: 0,
      correct: 0,
      goalMet: false,
    });
    expect(body.streak).toEqual({ current: 0, longest: 0 });
    expect(body.freezes).toEqual({ remaining: STREAK_FREEZE_MAX, max: STREAK_FREEZE_MAX });
    expect(body.dailyGoalMinutes).toBe(5);
    expect(body.timezone).toBe('UTC');
    expect(body.recentDays).toHaveLength(14);
    expect(body.recentDays[13].date).toBe('2026-04-10');
  });

  // ---------------------------------------------------------------------------
  // Cross-user isolation
  // ---------------------------------------------------------------------------

  describe('the endpoint returns only the caller’s own data', () => {
    beforeEach(() => {
      // Learner B has a long, real streak. None of it may reach learner A.
      for (const date of ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10']) {
        seedMetDay(learnerB.id, date);
      }
    });

    it('shows learner A nothing of learner B’s days, streak or goal', async () => {
      const response = await at(learnerA, '2026-04-10T12:00:00.000Z')
        .get('/api/engagement/summary')
        .expect(200);
      const body = response.body.data;

      expect(body.today.attempts).toBe(0);
      expect(body.today.goalMet).toBe(false);
      expect(body.streak).toEqual({ current: 0, longest: 0 });
      expect(body.recentDays.every((day: any) => day.practiceSeconds === 0)).toBe(true);
    });

    it('shows learner B their own streak, in the same request cycle', async () => {
      const response = await at(learnerB, '2026-04-10T12:00:00.000Z')
        .get('/api/engagement/summary')
        .expect(200);

      expect(response.body.data.streak).toEqual({ current: 5, longest: 5 });
      expect(response.body.data.today.goalMet).toBe(true);
    });

    it('has no parameter that could name another user — a ?userId= is inert, not a way in', async () => {
      // The route takes no query DTO at all, so this is not "rejected" so much
      // as unreadable: `@CurrentUser('id')` is the only source of a user id in
      // the handler, and learner A gets learner A's (empty) summary back.
      const response = await request(server())
        .get(`/api/engagement/summary?userId=${learnerB.id}`)
        .set(authHeader(learnerA.accessToken))
        .set('x-test-clock', '2026-04-10T12:00:00.000Z')
        .expect(200);

      expect(response.body.data.streak).toEqual({ current: 0, longest: 0 });
      expect(response.body.data.today.attempts).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Local days (§3) — the property the whole table exists for
  // ---------------------------------------------------------------------------

  describe('a local day is the learner’s day, not UTC’s', () => {
    it('two attempts either side of UTC midnight land on ONE daily_activity row for an America/Los_Angeles learner', async () => {
      seedProfile(learnerA.id, { timezone: 'America/Los_Angeles' });

      // 16:30 on March 31st in Los Angeles.
      const created = await startSession(learnerA, '2026-03-31T23:30:00.000Z');
      const sessionId = created.session.id;
      const firstQuestion = created.nextQuestion.id;

      // 16:45 local — still March 31st in Los Angeles, and March 31st in UTC.
      const first = await answer(
        learnerA,
        '2026-03-31T23:45:00.000Z',
        sessionId,
        firstQuestion,
      );

      // 22:00 local — STILL March 31st in Los Angeles, but already April 1st
      // in UTC. A UTC-derived date would file this on a different day.
      await answer(
        learnerA,
        '2026-04-01T05:00:00.000Z',
        sessionId,
        first.body.data.nextQuestion.id,
      );

      const rows = activityFor(learnerA.id);
      expect(rows).toHaveLength(1);
      expect(dateKey(rows[0].activityDate)).toBe('2026-03-31');
      expect(rows[0].tzUsed).toBe('America/Los_Angeles');
      expect(rows[0].attempts).toBe(2);
      // Each slice is capped (§2.3): 15 minutes and five hours both bill 120s.
      expect(rows[0].practiceSeconds).toBe(240);
    });

    it('the summary reports that same local day as `today`, from the learner’s own zone', async () => {
      seedProfile(learnerA.id, { timezone: 'America/Los_Angeles' });

      const created = await startSession(learnerA, '2026-03-31T23:30:00.000Z');
      await answer(
        learnerA,
        '2026-04-01T05:00:00.000Z',
        created.session.id,
        created.nextQuestion.id,
      );

      const response = await at(learnerA, '2026-04-01T05:00:01.000Z')
        .get('/api/engagement/summary')
        .expect(200);

      expect(response.body.data.today.date).toBe('2026-03-31');
      expect(response.body.data.today.attempts).toBe(1);
      expect(response.body.data.timezone).toBe('America/Los_Angeles');
    });
  });

  // ---------------------------------------------------------------------------
  // Accrual through the real practice routes
  // ---------------------------------------------------------------------------

  describe('accrual through the practice loop', () => {
    it('counts an attempt and, on completion, the time up to the moment the learner finished', async () => {
      const created = await startSession(learnerA, '2026-04-10T12:00:00.000Z');
      const sessionId = created.session.id;

      await answer(learnerA, '2026-04-10T12:00:30.000Z', sessionId, created.nextQuestion.id);

      await at(learnerA, '2026-04-10T12:01:10.000Z')
        .post(`/api/practice/sessions/${sessionId}/complete`)
        .expect(201);

      const response = await at(learnerA, '2026-04-10T12:02:00.000Z')
        .get('/api/engagement/summary')
        .expect(200);

      expect(response.body.data.today).toMatchObject({
        date: '2026-04-10',
        attempts: 1,
        // 30s to the attempt, then 40s from that attempt to the completion —
        // the gap no attempt event ever closes.
        practiceSeconds: 70,
      });
    });

    it('a completion at the SAME pinned instant as its last attempt bills that time once', async () => {
      // The shape a live run hits under a pinned `X-Test-Clock`, and the one
      // production hits whenever a completion lands in the same clock tick as
      // the attempt before it. The slice between two events at one instant is
      // zero — the seconds before them already belong to the earlier event,
      // and billing them twice overstates what the learner practised.
      const created = await startSession(learnerA, '2026-04-10T12:00:00.000Z');
      const sessionId = created.session.id;

      await answer(learnerA, '2026-04-10T12:00:40.000Z', sessionId, created.nextQuestion.id);

      await at(learnerA, '2026-04-10T12:00:40.000Z')
        .post(`/api/practice/sessions/${sessionId}/complete`)
        .expect(201);

      const response = await at(learnerA, '2026-04-10T12:02:00.000Z')
        .get('/api/engagement/summary')
        .expect(200);

      expect(response.body.data.today).toMatchObject({
        date: '2026-04-10',
        attempts: 1,
        practiceSeconds: 40,
      });
    });

    it('a completion adds seconds but never attempts or correct (§2.2)', async () => {
      const created = await startSession(learnerA, '2026-04-10T12:00:00.000Z');
      await answer(learnerA, '2026-04-10T12:00:30.000Z', created.session.id, created.nextQuestion.id);

      const before = activityFor(learnerA.id)[0].attempts;

      await at(learnerA, '2026-04-10T12:01:10.000Z')
        .post(`/api/practice/sessions/${created.session.id}/complete`)
        .expect(201);

      expect(activityFor(learnerA.id)[0].attempts).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------
  // Settlement over HTTP
  // ---------------------------------------------------------------------------

  describe('settlement runs on the summary request, once', () => {
    it('covers a missed day inside a real streak, and a second request changes nothing', async () => {
      seedMetDay(learnerA.id, '2026-04-07');
      seedMetDay(learnerA.id, '2026-04-08');
      profiles.set(learnerA.id, {
        ...profiles.get(learnerA.id)!,
        streakFreezesGrantedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      const first = await at(learnerA, '2026-04-10T12:00:00.000Z')
        .get('/api/engagement/summary')
        .expect(200);

      expect(first.body.data.streak).toEqual({ current: 3, longest: 3 });
      expect(first.body.data.freezes.remaining).toBe(STREAK_FREEZE_MAX - 1);

      const frozenRow = activity.get(`${learnerA.id}|2026-04-09`);
      expect(frozenRow).toMatchObject({
        freezeUsed: true,
        goalMet: false,
        attempts: 0,
        correct: 0,
        practiceSeconds: 0,
      });

      const rowsAfterFirst = activityFor(learnerA.id).map((row) => ({ ...row }));

      const second = await at(learnerA, '2026-04-10T12:00:05.000Z')
        .get('/api/engagement/summary')
        .expect(200);

      expect(activityFor(learnerA.id)).toEqual(rowsAfterFirst);
      expect(second.body.data.freezes.remaining).toBe(STREAK_FREEZE_MAX - 1);
      expect(second.body.data.streak).toEqual(first.body.data.streak);
    });

    it('a FIRST-EVER spend starts the replenishment cooldown, so StrictMode’s second GET regrants nothing', async () => {
      // The test above seeds `streakFreezesGrantedAt` a day back, so the
      // cooldown is already running and a regrant is blocked for a reason that
      // has nothing to do with the spend. This one leaves it at its honest
      // `null` — the learner has never replenished — which is the state a real
      // first freeze spend happens in, and the state React 18 StrictMode's
      // double-invoked mount effect hits twice in a row on a dev page load.
      seedMetDay(learnerA.id, '2026-04-07');
      seedMetDay(learnerA.id, '2026-04-08');
      expect(profiles.get(learnerA.id)!.streakFreezesGrantedAt).toBeNull();

      const first = await at(learnerA, '2026-04-10T12:00:00.000Z')
        .get('/api/engagement/summary')
        .expect(200);
      expect(first.body.data.freezes.remaining).toBe(STREAK_FREEZE_MAX - 1);
      expect(profiles.get(learnerA.id)!.streakFreezesGrantedAt).toEqual(
        new Date('2026-04-10T12:00:00.000Z'),
      );

      const second = await at(learnerA, '2026-04-10T12:00:00.100Z')
        .get('/api/engagement/summary')
        .expect(200);

      expect(second.body.data.freezes.remaining).toBe(STREAK_FREEZE_MAX - 1);
      expect(profiles.get(learnerA.id)!.streakFreezes).toBe(STREAK_FREEZE_MAX - 1);
    });
  });

  // ===========================================================================
  // THE EPIC'S CENTRAL INVARIANT
  // ===========================================================================
  //
  // `PRD.md`: "Points, streaks, achievements, and challenges encourage the
  // journey. They must never artificially increase the user's Readiness
  // Score." `habit-streaks.md` §1 and `readiness-model.md` §2.4 state the same
  // rule, word for word, from each side of the boundary. This is the test that
  // holds it.
  // ===========================================================================

  describe('engagement never moves readiness', () => {
    it('a long streak, a spent freeze and a met goal leave the readiness score and EVERY component identical — engagement is not an input to readiness (PRD.md)', async () => {
      // --- real practice evidence, and a readiness score computed from it ----
      const created = await startSession(learnerA, '2026-04-10T12:00:00.000Z');
      await answer(learnerA, '2026-04-10T12:00:30.000Z', created.session.id, created.nextQuestion.id);

      const before = (
        await at(learnerA, '2026-04-10T12:01:00.000Z').get('/api/readiness').expect(200)
      ).body.data;

      // --- now change ENGAGEMENT state, and only engagement state -----------
      //
      // A 30-day streak ending yesterday, a freeze budget at zero, and today's
      // goal met — every lever this epic owns, pushed as far as it goes. Not
      // one `practice_attempts` row is added, so readiness's own evidence is
      // untouched by construction.
      for (let offset = 30; offset >= 1; offset -= 1) {
        const date = new Date(Date.parse('2026-04-10T00:00:00.000Z') - offset * 86_400_000)
          .toISOString()
          .slice(0, 10);
        seedMetDay(learnerA.id, date);
      }
      activity.set(`${learnerA.id}|2026-04-10`, {
        id: randomUUID(),
        userId: learnerA.id,
        activityDate: new Date('2026-04-10T00:00:00.000Z'),
        tzUsed: 'UTC',
        practiceSeconds: 3_600,
        attempts: 40,
        correct: 40,
        goalMet: true,
        freezeUsed: false,
      });

      const engagement = (
        await at(learnerA, '2026-04-10T12:02:00.000Z').get('/api/engagement/summary').expect(200)
      ).body.data;
      expect(engagement.streak.current).toBe(31);
      expect(engagement.today.goalMet).toBe(true);

      // --- force a genuine RECOMPUTE, not a cached row ----------------------
      //
      // Without this the second read would return the same stored snapshot and
      // prove nothing: what is being asserted is that the readiness ENGINE,
      // run again over a database that now contains 31 days of engagement
      // evidence, produces the identical answer.
      snapshots.clear();

      const after = (
        await at(learnerA, '2026-04-10T12:03:00.000Z').get('/api/readiness').expect(200)
      ).body.data;

      expect(after.score).toBe(before.score);
      expect(after.components).toEqual(before.components);
      expect(after.evidenceCounts).toEqual(before.evidenceCounts);
      expect(after.capReason).toBe(before.capReason);
      expect(after.topRecommendation).toEqual(before.topRecommendation);
    });

    it('the readiness response carries no streak, freeze or daily-activity field at all', async () => {
      const response = await at(learnerA, '2026-04-10T12:00:00.000Z')
        .get('/api/readiness')
        .expect(200);

      const body = JSON.stringify(response.body.data).toLowerCase();
      expect(body).not.toContain('streak');
      expect(body).not.toContain('freeze');
      expect(body).not.toContain('dailyactivity');
      expect(body).not.toContain('goalmet');
    });
  });
});

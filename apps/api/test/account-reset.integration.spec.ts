import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from './helpers/test-app.helper';
import { prismaMock, resetPrismaMock, mockPrismaTransaction } from './mocks/prisma.mock';
import { setupBaseMocks } from './fixtures/mock-setup.helper';
import { createMockTestUser, authHeader } from './helpers/auth-mock.helper';
import {
  ACCOUNT_RESET_PHRASES,
  ACCOUNT_RESET_TABLES,
} from '../src/account/account-reset.constants';

// =============================================================================
// Self-service account data reset — HTTP integration (issue #270)
// =============================================================================
//
// `AccountController` takes the caller's user id EXCLUSIVELY from
// `@CurrentUser('id')` — no path, query, or body parameter anywhere carries a
// user id (see that controller's own header comment). This suite proves the
// two routes over real HTTP through the full Nest pipeline (guards +
// interceptors + controller + service, with only Prisma mocked), the same
// shape `notifications-isolation.integration.spec.ts` uses for the identical
// "no route accepts a user id" property on a different feature.
//
// Every `ACCOUNT_RESET_TABLES` model is wired generically, by iterating the
// real constant, rather than fourteen hand-written mock setups — the same
// "one list, never duplicated" discipline that constant's own header argues
// for at length.
// =============================================================================

const CALLER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const CALLER_EMAIL = 'caller@example.com';

/** Per-table delete counts used across the "happy path" tests below. */
function tableCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  ACCOUNT_RESET_TABLES.forEach((entry, index) => {
    counts[entry.model] = index + 1; // distinct, deterministic, non-zero
  });
  return counts;
}

/** Wire every `ACCOUNT_RESET_TABLES` model's `count`/`deleteMany` mock. */
function mockResetTables(counts: Record<string, number>): void {
  for (const entry of ACCOUNT_RESET_TABLES) {
    const model = (prismaMock as Record<string, any>)[entry.model];
    model.count.mockResolvedValue(counts[entry.model]);
    model.deleteMany.mockResolvedValue({ count: counts[entry.model] });
  }
}

describe('Account Data Reset (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    mockPrismaTransaction();

    // No uploaded files for any caller unless a test says otherwise — keeps
    // `ObjectsService.delete` (real network/storage I/O) out of the loop for
    // every test that is not specifically about storage objects.
    prismaMock.storageObject.findMany.mockResolvedValue([]);
    prismaMock.storageObject.count.mockResolvedValue(0);

    // `AccountResetService.reset` reads the caller's own email via
    // `findUniqueOrThrow` — a different Prisma method from the `findUnique`
    // `setupUserMocks()` wires, so it needs its own mock here.
    prismaMock.user.findUniqueOrThrow.mockImplementation(async ({ where }: any) => {
      if (where?.id === CALLER_ID) {
        return { email: CALLER_EMAIL } as any;
      }
      throw new Error(`No mock user for id ${where?.id}`);
    });

    // `data_and_key` runs the REAL `AiUserKeyService.purgeForDeletedUser`,
    // which reaches the REAL `CredentialsService.deleteSecret` — one more
    // Prisma call this suite has to wire, exactly like every other model it
    // touches.
    prismaMock.credential.deleteMany.mockResolvedValue({ count: 0 });
  });

  async function caller() {
    return createMockTestUser(context, {
      id: CALLER_ID,
      email: CALLER_EMAIL,
      roleName: 'viewer',
    });
  }

  // ===========================================================================
  // GET /api/account/data-summary
  // ===========================================================================

  describe('GET /api/account/data-summary', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(context.app.getHttpServer())
        .get('/api/account/data-summary')
        .expect(401);
    });

    it('returns 200 with counts and the two exact reset phrases', async () => {
      mockResetTables(tableCounts());
      const user = await caller();

      const response = await request(context.app.getHttpServer())
        .get('/api/account/data-summary')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(typeof response.body.data.counts).toBe('object');
      // Read the real constant rather than hardcoding the strings a second
      // time — the whole point of `ACCOUNT_RESET_PHRASES` being shared.
      expect(response.body.data.phrases).toEqual({
        data: ACCOUNT_RESET_PHRASES.data,
        data_and_key: ACCOUNT_RESET_PHRASES.data_and_key,
      });
      expect(ACCOUNT_RESET_PHRASES.data).toBe('DELETE MY DATA');
      expect(ACCOUNT_RESET_PHRASES.data_and_key).toBe('DELETE EVERYTHING');
    });

    it('counts every ACCOUNT_RESET_TABLES entry plus storage_objects', async () => {
      const counts = tableCounts();
      mockResetTables(counts);
      prismaMock.storageObject.count.mockResolvedValue(7);
      const user = await caller();

      const response = await request(context.app.getHttpServer())
        .get('/api/account/data-summary')
        .set(authHeader(user.accessToken))
        .expect(200);

      for (const entry of ACCOUNT_RESET_TABLES) {
        expect(response.body.data.counts[entry.table]).toBe(counts[entry.model]);
      }
      expect(response.body.data.counts.storage_objects).toBe(7);
    });

    it('counts a caller\'s data only against their own id', async () => {
      mockResetTables(tableCounts());
      const user = await caller();

      await request(context.app.getHttpServer())
        .get('/api/account/data-summary')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(prismaMock.storageObject.count).toHaveBeenCalledWith({
        where: { uploadedById: CALLER_ID },
      });
      for (const entry of ACCOUNT_RESET_TABLES) {
        const model = (prismaMock as Record<string, any>)[entry.model];
        expect(model.count).toHaveBeenCalledWith({ where: { userId: CALLER_ID } });
      }
    });
  });

  // ===========================================================================
  // POST /api/account/reset
  // ===========================================================================

  describe('POST /api/account/reset', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(context.app.getHttpServer())
        .post('/api/account/reset')
        .send({ scope: 'data', confirmationPhrase: 'DELETE MY DATA' })
        .expect(401);
    });

    describe('validation — nothing destructive runs on a 400', () => {
      it('400s when confirmationPhrase is missing', async () => {
        const user = await caller();

        const response = await request(context.app.getHttpServer())
          .post('/api/account/reset')
          .set(authHeader(user.accessToken))
          .send({ scope: 'data' })
          .expect(400);

        expect(response.body.code).toBe('BAD_REQUEST');
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.practiceAttempt.deleteMany).not.toHaveBeenCalled();
        expect(prismaMock.auditEvent.create).not.toHaveBeenCalled();
      });

      it('400s when confirmationPhrase is an empty string', async () => {
        const user = await caller();

        await request(context.app.getHttpServer())
          .post('/api/account/reset')
          .set(authHeader(user.accessToken))
          .send({ scope: 'data', confirmationPhrase: '' })
          .expect(400);

        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.practiceAttempt.deleteMany).not.toHaveBeenCalled();
      });

      it('400s when confirmationPhrase is present but wrong-case for the scope', async () => {
        const user = await caller();

        const response = await request(context.app.getHttpServer())
          .post('/api/account/reset')
          .set(authHeader(user.accessToken))
          .send({ scope: 'data', confirmationPhrase: 'delete my data' })
          .expect(400);

        expect(response.body.code).toBe('BAD_REQUEST');
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.practiceAttempt.deleteMany).not.toHaveBeenCalled();
        expect(prismaMock.auditEvent.create).not.toHaveBeenCalled();
      });

      it("400s when the OTHER scope's phrase is used for this scope", async () => {
        const user = await caller();

        await request(context.app.getHttpServer())
          .post('/api/account/reset')
          .set(authHeader(user.accessToken))
          .send({ scope: 'data', confirmationPhrase: 'DELETE EVERYTHING' })
          .expect(400);

        expect(prismaMock.$transaction).not.toHaveBeenCalled();

        resetPrismaMock();
        setupBaseMocks();
        mockPrismaTransaction();
        prismaMock.storageObject.findMany.mockResolvedValue([]);
        prismaMock.user.findUniqueOrThrow.mockResolvedValue({ email: CALLER_EMAIL } as any);
        const user2 = await createMockTestUser(context, {
          id: CALLER_ID,
          email: CALLER_EMAIL,
          roleName: 'viewer',
        });

        await request(context.app.getHttpServer())
          .post('/api/account/reset')
          .set(authHeader(user2.accessToken))
          .send({ scope: 'data_and_key', confirmationPhrase: 'DELETE MY DATA' })
          .expect(400);

        expect(prismaMock.$transaction).not.toHaveBeenCalled();
      });

      it('400s when scope is an invalid enum value', async () => {
        const user = await caller();

        const response = await request(context.app.getHttpServer())
          .post('/api/account/reset')
          .set(authHeader(user.accessToken))
          .send({ scope: 'everything', confirmationPhrase: 'DELETE MY DATA' })
          .expect(400);

        expect(response.body.code).toBe('BAD_REQUEST');
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('happy path — scope: data', () => {
      it('returns { scope, deleted, aiKeyRemoved: false } and does not purge the AI key', async () => {
        const counts = tableCounts();
        mockResetTables(counts);
        const user = await caller();

        const response = await request(context.app.getHttpServer())
          .post('/api/account/reset')
          .set(authHeader(user.accessToken))
          .send({ scope: 'data', confirmationPhrase: 'DELETE MY DATA' })
          .expect(200);

        expect(response.body.data.scope).toBe('data');
        expect(response.body.data.aiKeyRemoved).toBe(false);
        for (const entry of ACCOUNT_RESET_TABLES) {
          expect(response.body.data.deleted[entry.table]).toBe(counts[entry.model]);
        }
        expect(response.body.data.deleted.storage_objects).toBe(0);

        for (const entry of ACCOUNT_RESET_TABLES) {
          const model = (prismaMock as Record<string, any>)[entry.model];
          expect(model.deleteMany).toHaveBeenCalledWith({ where: { userId: CALLER_ID } });
        }
        expect(prismaMock.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              actorUserId: CALLER_ID,
              action: 'account:reset',
              targetType: 'user',
              targetId: CALLER_ID,
            }),
          }),
        );
      });
    });

    describe('happy path — scope: data_and_key', () => {
      it('returns { scope, deleted, aiKeyRemoved: true }', async () => {
        const counts = tableCounts();
        mockResetTables(counts);
        const user = await caller();

        const response = await request(context.app.getHttpServer())
          .post('/api/account/reset')
          .set(authHeader(user.accessToken))
          .send({ scope: 'data_and_key', confirmationPhrase: 'DELETE EVERYTHING' })
          .expect(200);

        expect(response.body.data.scope).toBe('data_and_key');
        expect(response.body.data.aiKeyRemoved).toBe(true);
      });
    });

    describe('the route accepts no user id — the caller\'s own token is the only source', () => {
      it('ignores an extra `userId` field in the body; the reset runs against the caller\'s own id', async () => {
        const counts = tableCounts();
        mockResetTables(counts);
        const user = await caller();

        const response = await request(context.app.getHttpServer())
          .post('/api/account/reset')
          .set(authHeader(user.accessToken))
          .send({
            scope: 'data',
            confirmationPhrase: 'DELETE MY DATA',
            userId: OTHER_USER_ID,
          })
          .expect(200);

        expect(response.body.data.scope).toBe('data');

        // The one Prisma read keyed off "userId" as a plain string parameter
        // (not `{ where: { userId } }`) is `findUniqueOrThrow` for the
        // recipient email — proving it, proves the DTO's unknown `userId`
        // field never reached the service at all.
        expect(prismaMock.user.findUniqueOrThrow).toHaveBeenCalledWith({
          where: { id: CALLER_ID },
          select: { email: true },
        });
        expect(prismaMock.user.findUniqueOrThrow).not.toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: OTHER_USER_ID } }),
        );

        // And every deletion is scoped to the caller's id, never the body's.
        for (const entry of ACCOUNT_RESET_TABLES) {
          const model = (prismaMock as Record<string, any>)[entry.model];
          expect(model.deleteMany).toHaveBeenCalledWith({ where: { userId: CALLER_ID } });
          expect(model.deleteMany).not.toHaveBeenCalledWith({
            where: { userId: OTHER_USER_ID },
          });
        }
      });
    });
  });
});

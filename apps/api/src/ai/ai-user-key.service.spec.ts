import { Test, TestingModule } from '@nestjs/testing';

import { AiUserKeyService } from './ai-user-key.service';
import { AiSettingsService } from './ai-settings.service';
import { OpenAiProvider } from './providers/openai.provider';
import { aiSettingsSchema } from './ai-settings.schema';
import {
  AI_USER_CREDENTIAL_PURPOSE,
  aiUserCredentialName,
} from './ai-credential.constants';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

// =============================================================================
// AiUserKeyService — tests (issue #35, epic #25)
// =============================================================================
//
// The properties that matter here are all about ISOLATION and REACHABILITY:
//
//   1. Every operation addresses `('ai-user', <that user's id>)` and no other.
//   2. `list('ai-user')` — which enumerates every user's key metadata — is
//      never reached.
//   3. The test reports PER-ROLE reachability, and a key that authenticates
//      but cannot reach a bound model is a failure with `authenticated: true`.
//   4. The key reaches no response, no audit meta, and no log line.
// =============================================================================

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ALICE_KEY = 'sk-alice-abcdefghijklmnopqrstu';

function settings(overrides: Record<string, unknown> = {}) {
  return aiSettingsSchema.parse({
    provider: 'openai',
    enabled: true,
    models: { tutor: 'gpt-5.4', grader: 'gpt-5.4-mini' },
    ...overrides,
  });
}

describe('AiUserKeyService', () => {
  let service: AiUserKeyService;
  let prisma: MockPrismaService;
  let credentials: {
    describe: jest.Mock;
    setSecret: jest.Mock;
    deleteSecret: jest.Mock;
    getSecret: jest.Mock;
    list: jest.Mock;
  };
  let aiSettings: { get: jest.Mock };
  let openai: { testConnection: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrismaService();
    prisma.auditEvent.create.mockResolvedValue({} as never);

    credentials = {
      describe: jest.fn().mockResolvedValue(null),
      setSecret: jest.fn().mockResolvedValue(undefined),
      deleteSecret: jest.fn().mockResolvedValue(undefined),
      getSecret: jest.fn().mockResolvedValue(ALICE_KEY),
      // Present so a call to it would be observable, not absent so it would
      // throw for the wrong reason.
      list: jest.fn().mockResolvedValue([]),
    };
    aiSettings = { get: jest.fn().mockResolvedValue(settings()) };
    openai = {
      testConnection: jest.fn().mockResolvedValue({
        success: true,
        authenticated: true,
        roles: [
          { roleKey: 'tutor', modelId: 'gpt-5.4', reachable: true, error: null },
          {
            roleKey: 'grader',
            modelId: 'gpt-5.4-mini',
            reachable: true,
            error: null,
          },
        ],
        error: null,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiUserKeyService,
        { provide: PrismaService, useValue: prisma },
        { provide: CredentialsService, useValue: credentials },
        { provide: AiSettingsService, useValue: aiSettings },
        { provide: OpenAiProvider, useValue: openai },
      ],
    }).compile();

    service = module.get(AiUserKeyService);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  function lastAudit() {
    const calls = prisma.auditEvent.create.mock.calls;
    return (
      calls[calls.length - 1][0] as {
        data: { action: string; targetId: string; meta: Record<string, unknown> };
      }
    ).data;
  }

  // ---------------------------------------------------------------------------
  // Cross-user isolation
  // ---------------------------------------------------------------------------

  describe('cross-user isolation', () => {
    it.each([
      ['describe', (s: AiUserKeyService, id: string) => s.describe(id)],
      ['set', (s: AiUserKeyService, id: string) => s.set(id, ALICE_KEY)],
      ['remove', (s: AiUserKeyService, id: string) => s.remove(id)],
      ['test', (s: AiUserKeyService, id: string) => s.test(id)],
    ])('%s addresses only the given user', async (_name, call) => {
      await call(service, ALICE);

      // Every credential-store call in this operation used Alice's address and
      // nobody else's.
      const addressed = [
        ...credentials.describe.mock.calls,
        ...credentials.setSecret.mock.calls,
        ...credentials.deleteSecret.mock.calls,
        ...credentials.getSecret.mock.calls,
      ];

      expect(addressed.length).toBeGreaterThan(0);
      for (const [purpose, name] of addressed) {
        expect(purpose).toBe(AI_USER_CREDENTIAL_PURPOSE);
        expect(name).toBe(aiUserCredentialName(ALICE));
        expect(name).not.toBe(BOB);
      }
    });

    it('NEVER calls list(purpose), which would enumerate every user', async () => {
      // Not a plaintext leak — `CredentialInfo` cannot hold secret material —
      // but a cross-user metadata leak (who has a key, when, the masked hint),
      // and the shape that grows a "show me everything" endpoint.
      await service.describe(ALICE);
      await service.set(ALICE, ALICE_KEY);
      await service.remove(ALICE);
      await service.test(ALICE);

      expect(credentials.list).not.toHaveBeenCalled();
    });

    it('reads Bob\'s status only when asked for Bob', async () => {
      credentials.describe.mockResolvedValue(null);

      await service.describe(BOB);

      expect(credentials.describe).toHaveBeenCalledWith(
        AI_USER_CREDENTIAL_PURPOSE,
        BOB,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // describe / set / remove
  // ---------------------------------------------------------------------------

  describe('describe', () => {
    it('reports unconfigured when nothing is stored', async () => {
      await expect(service.describe(ALICE)).resolves.toEqual({
        configured: false,
        hint: null,
        updatedAt: null,
      });
    });

    it('reports the store\'s own mask, never the key', async () => {
      credentials.describe.mockResolvedValue({
        hint: '••••rstu',
        updatedAt: new Date('2026-09-01T00:00:00Z'),
      });

      const status = await service.describe(ALICE);

      expect(status).toEqual({
        configured: true,
        hint: '••••rstu',
        updatedAt: '2026-09-01T00:00:00.000Z',
      });
      // `describe`, not `getSecret` — the encrypted bytes never leave Postgres
      // for this read.
      expect(credentials.getSecret).not.toHaveBeenCalled();
    });
  });

  describe('set', () => {
    it('stores the key byte-for-byte, untrimmed', async () => {
      // A user pasting from a console is exactly who a silent trim bites.
      const padded = `  ${ALICE_KEY}\n`;

      await service.set(ALICE, padded);

      expect(credentials.setSecret).toHaveBeenCalledWith(
        AI_USER_CREDENTIAL_PURPOSE,
        ALICE,
        padded,
        expect.objectContaining({ updatedByUserId: ALICE }),
      );
    });

    it('passes a blank through to the store, which preserves or refuses', async () => {
      // Blank-preserves is the store's contract, not reimplemented here.
      await service.set(ALICE, '');

      expect(credentials.setSecret).toHaveBeenCalledWith(
        AI_USER_CREDENTIAL_PURPOSE,
        ALICE,
        '',
        expect.anything(),
      );
    });

    it('audits the write without the key', async () => {
      await service.set(ALICE, ALICE_KEY);

      expect(lastAudit().action).toBe('ai_key:set');
      expect(lastAudit().targetId).toBe(`ai-user/${ALICE}`);
      expect(JSON.stringify(lastAudit().meta)).not.toContain(ALICE_KEY);
    });
  });

  describe('remove', () => {
    it('is idempotent — removing nothing is a success', async () => {
      await expect(service.remove(ALICE)).resolves.toBeUndefined();
      expect(credentials.deleteSecret).toHaveBeenCalled();
    });

    it('audits the delete', async () => {
      await service.remove(ALICE);
      expect(lastAudit().action).toBe('ai_key:delete');
    });
  });

  // ---------------------------------------------------------------------------
  // test — reachability, not validity
  // ---------------------------------------------------------------------------

  describe('test', () => {
    it('probes each wired role\'s bound model on the USER\'s key', async () => {
      await service.test(ALICE);

      expect(openai.testConnection).toHaveBeenCalledWith(ALICE_KEY, [
        { roleKey: 'tutor', modelId: 'gpt-5.4', family: 'text' },
        { roleKey: 'grader', modelId: 'gpt-5.4-mini', family: 'text' },
      ]);
    });

    it('reports PER-ROLE results, not one boolean', async () => {
      const result = await service.test(ALICE);

      expect(result.roles).toHaveLength(2);
      expect(result.roles[0]).toMatchObject({ roleKey: 'tutor' });
    });

    it('FAILS for a key that authenticates but cannot reach a bound model', async () => {
      // The entire failure this endpoint exists to catch. Testing only
      // GET /v1/models would pass this key, and the user would finish
      // onboarding into a product that fails on their first practice answer.
      openai.testConnection.mockResolvedValue({
        success: false,
        authenticated: true,
        roles: [
          { roleKey: 'tutor', modelId: 'gpt-5.4', reachable: true, error: null },
          {
            roleKey: 'grader',
            modelId: 'gpt-5.4-mini',
            reachable: false,
            error: 'OpenAI: you do not have access to this model',
          },
        ],
        error: 'OpenAI: This key works, but it cannot reach the model bound to grader.',
      });

      const result = await service.test(ALICE);

      expect(result.success).toBe(false);
      // The key itself is fine — and saying so is what stops the user
      // replacing it.
      expect(result.authenticated).toBe(true);
      expect(result.roles[1].error).toMatch(/do not have access/);
    });

    it('says the key is missing rather than calling the provider', async () => {
      credentials.getSecret.mockResolvedValue(null);

      const result = await service.test(ALICE);

      expect(result.error).toMatch(/No API key is saved/);
      expect(openai.testConnection).not.toHaveBeenCalled();
    });

    it('blames the administrator, not the user, when no provider is chosen', async () => {
      // The user's key may be perfectly good. Anything that reads as a problem
      // with what they just typed is the wrong message.
      aiSettings.get.mockResolvedValue(settings({ provider: null }));

      const result = await service.test(ALICE);

      expect(result.error).toMatch(/administrator/);
      expect(result.error).toMatch(/has been saved/);
      expect(openai.testConnection).not.toHaveBeenCalled();
    });

    it('surfaces a corrupt settings row as the diagnosis', async () => {
      aiSettings.get.mockRejectedValue(
        new Error('Stored AI settings are invalid at: provider.'),
      );

      const result = await service.test(ALICE);

      expect(result.error).toMatch(/invalid at: provider/);
    });

    it('skips a wired role that has no binding', async () => {
      // An unbound role is the administrator's unfinished work, not a failure
      // of this user's key.
      aiSettings.get.mockResolvedValue(settings({ models: { tutor: 'gpt-5.4' } }));

      await service.test(ALICE);

      expect(openai.testConnection).toHaveBeenCalledWith(ALICE_KEY, [
        { roleKey: 'tutor', modelId: 'gpt-5.4', family: 'text' },
      ]);
    });

    it('audits every attempt, including refusals', async () => {
      credentials.getSecret.mockResolvedValue(null);
      await service.test(ALICE);
      expect(lastAudit().action).toBe('ai_key:test');

      prisma.auditEvent.create.mockClear();
      credentials.getSecret.mockResolvedValue(ALICE_KEY);
      await service.test(ALICE);
      expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Account deletion (#38)
  // ---------------------------------------------------------------------------

  describe('purgeForDeletedUser', () => {
    it('removes the deleted user\'s key', async () => {
      await service.purgeForDeletedUser(ALICE);

      expect(credentials.deleteSecret).toHaveBeenCalledWith(
        AI_USER_CREDENTIAL_PURPOSE,
        aiUserCredentialName(ALICE),
      );
    });

    it('is idempotent — purging a user with no key is not an error', async () => {
      await expect(service.purgeForDeletedUser(ALICE)).resolves.toBeUndefined();
    });

    it('deletes BEFORE auditing, so a failed audit cannot retain the key', async () => {
      // An unaudited deletion is a smaller problem than a retained live
      // OpenAI credential belonging to someone who has left.
      const order: string[] = [];
      credentials.deleteSecret.mockImplementation(async () => {
        order.push('delete');
      });
      (prisma.auditEvent.create as unknown as jest.Mock).mockImplementation(
        async () => {
          order.push('audit');
          return {};
        },
      );

      await service.purgeForDeletedUser(ALICE);

      expect(order).toEqual(['delete', 'audit']);
    });

    it('records why the key went', async () => {
      await service.purgeForDeletedUser(ALICE);

      expect(lastAudit().action).toBe('ai_key:delete');
      expect(lastAudit().meta).toMatchObject({ reason: 'account_deleted' });
    });

    it('touches only that user\'s address', async () => {
      await service.purgeForDeletedUser(BOB);

      expect(credentials.deleteSecret).toHaveBeenCalledWith(
        AI_USER_CREDENTIAL_PURPOSE,
        BOB,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // The key never escapes
  // ---------------------------------------------------------------------------

  describe('the key never escapes', () => {
    it('is absent from every response', async () => {
      openai.testConnection.mockResolvedValue({
        success: false,
        authenticated: false,
        roles: [],
        error: 'OpenAI: rejected',
      });

      const results = [
        await service.describe(ALICE),
        await service.test(ALICE),
      ];

      for (const result of results) {
        expect(JSON.stringify(result)).not.toContain(ALICE_KEY);
      }
    });

    it('is absent from every audit meta, and so is the hint', async () => {
      credentials.describe.mockResolvedValue({ hint: '••••rstu' });

      await service.set(ALICE, ALICE_KEY);
      expect(JSON.stringify(lastAudit().meta)).not.toContain(ALICE_KEY);
      expect(lastAudit().meta).not.toHaveProperty('hint');

      await service.test(ALICE);
      expect(JSON.stringify(lastAudit().meta)).not.toContain(ALICE_KEY);
      expect(lastAudit().meta).not.toHaveProperty('hint');
    });
  });
});

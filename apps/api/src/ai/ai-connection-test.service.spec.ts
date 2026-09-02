import { Test, TestingModule } from '@nestjs/testing';

import { AiConnectionTestService } from './ai-connection-test.service';
import { AiSettingsService } from './ai-settings.service';
import { OpenAiProvider } from './providers/openai.provider';
import { AI_SETTINGS_KEY, aiSettingsSchema } from './ai-settings.schema';
import {
  AI_SYSTEM_CREDENTIAL_NAME,
  AI_SYSTEM_CREDENTIAL_PURPOSE,
} from './ai-credential.constants';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

// =============================================================================
// AiConnectionTestService — tests (issue #32, epic #25)
// =============================================================================
//
// Four properties, and three of them are refusals:
//
//   1. A rejected key is 200 + { success: false }, never a throw.
//   2. Every attempt is audited — INCLUDING the pre-flight refusals, which are
//      the ones a hand-rolled early return would silently skip.
//   3. The master switch is honoured; testing while off does not call out.
//   4. The key reaches no response, no audit meta, and no log line.
// =============================================================================

const KEY = 'sk-server-abcdefghijklmnopqrstuvwx';
const ADMIN = '11111111-1111-4111-8111-111111111111';

function settings(overrides: Record<string, unknown> = {}) {
  return aiSettingsSchema.parse({
    provider: 'openai',
    enabled: true,
    models: { tutor: 'gpt-5.4', grader: 'gpt-5.4-mini' },
    ...overrides,
  });
}

describe('AiConnectionTestService', () => {
  let service: AiConnectionTestService;
  let prisma: MockPrismaService;
  let aiSettings: { get: jest.Mock };
  let credentials: { getSecret: jest.Mock };
  let openai: { testConnection: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrismaService();
    prisma.auditEvent.create.mockResolvedValue({} as never);

    aiSettings = { get: jest.fn().mockResolvedValue(settings()) };
    credentials = { getSecret: jest.fn().mockResolvedValue(KEY) };
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
        AiConnectionTestService,
        { provide: PrismaService, useValue: prisma },
        { provide: AiSettingsService, useValue: aiSettings },
        { provide: CredentialsService, useValue: credentials },
        { provide: OpenAiProvider, useValue: openai },
      ],
    }).compile();

    service = module.get(AiConnectionTestService);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  /** The audit row written by the last call. */
  function lastAudit() {
    const calls = prisma.auditEvent.create.mock.calls;
    return (
      calls[calls.length - 1][0] as {
        data: { action: string; targetId: string; meta: Record<string, unknown> };
      }
    ).data;
  }

  describe('the happy path', () => {
    it('reports success with per-role reachability', async () => {
      const result = await service.runTest(ADMIN);

      expect(result).toMatchObject({
        success: true,
        authenticated: true,
        providerKind: 'openai',
        error: null,
      });
      expect(result.roles).toHaveLength(2);
    });

    it('probes only wired roles that have a binding', async () => {
      // An unbound wired role is `systemReady`'s business (#36), not this
      // endpoint's. Conflating "you have not finished configuring" with "your
      // key does not work" is the same mistake merging the status flags is.
      aiSettings.get.mockResolvedValue(settings({ models: { tutor: 'gpt-5.4' } }));

      await service.runTest(ADMIN);

      const probes = openai.testConnection.mock.calls[0][1];
      expect(probes).toEqual([
        { roleKey: 'tutor', modelId: 'gpt-5.4', family: 'text' },
      ]);
    });

    it('never probes the four unwired roles', async () => {
      // They are declared and inert; probing them would fail a test for a
      // feature that does not exist yet.
      await service.runTest(ADMIN);

      const probes = openai.testConnection.mock.calls[0][1] as Array<{
        roleKey: string;
      }>;
      expect(probes.map((p) => p.roleKey).sort()).toEqual(['grader', 'tutor']);
    });

    it('audits the success', async () => {
      await service.runTest(ADMIN);

      expect(lastAudit()).toMatchObject({
        action: 'ai_settings:test',
        targetId: AI_SETTINGS_KEY,
      });
      expect(lastAudit().meta).toMatchObject({ success: true });
    });
  });

  describe('a rejected key is a result, not an error', () => {
    it('returns success:false rather than throwing', async () => {
      openai.testConnection.mockResolvedValue({
        success: false,
        authenticated: false,
        roles: [],
        error: 'OpenAI: 401 Incorrect API key provided',
      });

      const result = await service.runTest(ADMIN);

      expect(result.success).toBe(false);
      expect(result.error).toContain('401');
    });

    it('reports authenticated separately from success', async () => {
      // A key that works but cannot reach the bound model is a different
      // problem with a different fix. Told only "the test failed", an admin
      // would replace a perfectly good key.
      openai.testConnection.mockResolvedValue({
        success: false,
        authenticated: true,
        roles: [
          {
            roleKey: 'grader',
            modelId: 'gpt-5.4-mini',
            reachable: false,
            error: 'OpenAI: The model does not exist',
          },
        ],
        error: 'OpenAI: This key works, but it cannot reach …',
      });

      const result = await service.runTest(ADMIN);

      expect(result.success).toBe(false);
      expect(result.authenticated).toBe(true);
      expect(result.roles[0].reachable).toBe(false);
    });

    it('records which roles were unreachable, without their messages', async () => {
      openai.testConnection.mockResolvedValue({
        success: false,
        authenticated: true,
        roles: [
          { roleKey: 'tutor', modelId: 'a', reachable: true, error: null },
          { roleKey: 'grader', modelId: 'b', reachable: false, error: 'nope' },
        ],
        error: 'unreachable',
      });

      await service.runTest(ADMIN);

      expect(lastAudit().meta.unreachableRoles).toEqual(['grader']);
    });
  });

  describe('pre-flight refusals — the ones an early return would skip', () => {
    it('refuses and audits when no provider is selected', async () => {
      aiSettings.get.mockResolvedValue(settings({ provider: null }));

      const result = await service.runTest(ADMIN);

      expect(result.success).toBe(false);
      expect(result.providerKind).toBeNull();
      expect(result.error).toMatch(/No AI provider is selected/);
      expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
      expect(openai.testConnection).not.toHaveBeenCalled();
    });

    it('HONOURS THE MASTER SWITCH and does not call out', async () => {
      // A test button that calls out anyway would make the switch a lie in the
      // one place an admin is looking at it.
      aiSettings.get.mockResolvedValue(settings({ enabled: false }));

      const result = await service.runTest(ADMIN);

      expect(result.error).toMatch(/AI is turned off/);
      expect(openai.testConnection).not.toHaveBeenCalled();
      expect(credentials.getSecret).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
    });

    it('refuses and audits when no key is stored', async () => {
      credentials.getSecret.mockResolvedValue(null);

      const result = await service.runTest(ADMIN);

      expect(result.error).toMatch(/No API key is stored/);
      expect(openai.testConnection).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
    });

    it('surfaces a corrupt settings row as the diagnosis, with field paths', async () => {
      // Read through the CONSUMPTION path so it fails the same way a real
      // catalog fetch would.
      aiSettings.get.mockRejectedValue(
        new Error('Stored AI settings are invalid at: provider.'),
      );

      const result = await service.runTest(ADMIN);

      expect(result.error).toMatch(/invalid at: provider/);
      expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
    });

    it('writes exactly one audit row per attempt, always', async () => {
      // Every path goes through one funnel, so a second hand-rolled failure
      // literal cannot end up without a row.
      const cases = [
        () => aiSettings.get.mockResolvedValue(settings({ provider: null })),
        () => aiSettings.get.mockResolvedValue(settings({ enabled: false })),
        () => credentials.getSecret.mockResolvedValue(null),
        () => undefined,
      ];

      for (const setUp of cases) {
        prisma.auditEvent.create.mockClear();
        aiSettings.get.mockResolvedValue(settings());
        credentials.getSecret.mockResolvedValue(KEY);
        setUp();

        await service.runTest(ADMIN);

        expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('the key never escapes', () => {
    it('reads the key from the documented address and passes it straight through', async () => {
      await service.runTest(ADMIN);

      expect(credentials.getSecret).toHaveBeenCalledWith(
        AI_SYSTEM_CREDENTIAL_PURPOSE,
        AI_SYSTEM_CREDENTIAL_NAME,
      );
      expect(openai.testConnection).toHaveBeenCalledWith(KEY, expect.any(Array));
    });

    it('is absent from the response', async () => {
      openai.testConnection.mockResolvedValue({
        success: false,
        authenticated: false,
        roles: [],
        error: 'OpenAI: rejected',
      });

      const result = await service.runTest(ADMIN);

      expect(JSON.stringify(result)).not.toContain(KEY);
    });

    it('is absent from the audit meta, and so is its hint', async () => {
      // An audit row is queried and exported far more casually than a
      // credential is.
      await service.runTest(ADMIN);

      const meta = JSON.stringify(lastAudit().meta);
      expect(meta).not.toContain(KEY);
      expect(lastAudit().meta).not.toHaveProperty('hint');
      expect(lastAudit().meta).not.toHaveProperty('apiKey');
    });
  });
});

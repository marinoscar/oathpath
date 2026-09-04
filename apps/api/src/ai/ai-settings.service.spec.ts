import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AiSettingsService } from './ai-settings.service';
import {
  AI_SETTINGS_KEY,
  DEFAULT_AI_SETTINGS,
  aiSettingsSchema,
} from './ai-settings.schema';
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
// AiSettingsService — tests (issue #30, epic #25)
// =============================================================================
//
// The four properties this service exists to hold:
//
//   1. BLANK PRESERVES. An empty key field keeps the stored key and still
//      applies the other changes — and does NOT reach the credential store at
//      all, so an unconfigured system does not 400 on an unrelated save.
//   2. KEY FIRST. The credential write precedes the settings write, so a
//      refused key cannot leave a provider selected with nothing behind it.
//   3. TWO READ PATHS. `get` throws on a corrupt row; `describeForAdmin`
//      reports it and still renders.
//   4. NO KEY EGRESS. `getSecret` is never called on this path.
// =============================================================================

const KEY = 'sk-server-abcdefghijklmnopqrstuvwx';
const USER_ID = '11111111-1111-4111-8111-111111111111';

/** A settings row as stored, with every role slot present. */
function storedSettings(overrides: Record<string, unknown> = {}) {
  return aiSettingsSchema.parse({
    provider: 'openai',
    enabled: true,
    models: { tutor: 'gpt-5.4', grader: 'gpt-5.4-mini' },
    ...overrides,
  });
}

function settingsRow(value: unknown, version = 3) {
  return {
    id: 'row-1',
    key: AI_SETTINGS_KEY,
    value,
    version,
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    updatedByUser: { id: USER_ID, email: 'admin@example.com' },
  };
}

describe('AiSettingsService', () => {
  let service: AiSettingsService;
  let prisma: MockPrismaService;
  let credentials: {
    describe: jest.Mock;
    setSecret: jest.Mock;
    getSecret: jest.Mock;
  };

  beforeEach(async () => {
    prisma = createMockPrismaService();
    credentials = {
      describe: jest.fn().mockResolvedValue(null),
      setSecret: jest.fn().mockResolvedValue(undefined),
      getSecret: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiSettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CredentialsService, useValue: credentials },
      ],
    }).compile();

    service = module.get(AiSettingsService);

    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  // ---------------------------------------------------------------------------
  // get() — the consumption path
  // ---------------------------------------------------------------------------

  describe('get', () => {
    it('returns the defaults when nothing is configured', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue(null);

      await expect(service.get()).resolves.toEqual(DEFAULT_AI_SETTINGS);
    });

    it('THROWS on a stored-but-invalid row rather than substituting defaults', async () => {
      // Silently substituting defaults would report the system as "AI not
      // configured" when what happened is a hand-edited row or a bad
      // migration. That is the silent-disablement failure the credential store
      // refuses on a decrypt error, for the same reason.
      prisma.systemSettings.findUnique.mockResolvedValue({
        value: { provider: 'not-a-provider', enabled: 'yes' },
      } as never);

      await expect(service.get()).rejects.toThrow(/invalid at/);
    });

    it('names field paths, never stored values, in the error', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue({
        value: { provider: 'anthropic-secret-looking-value', enabled: true },
      } as never);

      await expect(service.get()).rejects.toThrow(/provider/);
      await expect(service.get()).rejects.not.toThrow(
        /anthropic-secret-looking-value/,
      );
    });

    it('does not touch the credential store', async () => {
      // A consumption path has no business paying for a credential lookup it
      // will not use.
      prisma.systemSettings.findUnique.mockResolvedValue(null);

      await service.get();

      expect(credentials.describe).not.toHaveBeenCalled();
      expect(credentials.getSecret).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // describeReadiness() — the gate's system half
  // ---------------------------------------------------------------------------

  describe('describeReadiness', () => {
    it('is ready with nothing left unbound when every wired role has a model', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue({
        value: storedSettings({
          models: {
            tutor: 'gpt-5.4',
            grader: 'gpt-5.4-mini',
            transcribe: 'whisper-1',
            speak: 'tts-1-hd',
          },
        }),
      } as never);

      await expect(service.describeReadiness()).resolves.toMatchObject({
        systemReady: true,
        unboundRoles: [],
      });
    });

    it('is not ready when the master switch is off', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue({
        value: storedSettings({ enabled: false }),
      } as never);

      await expect(service.describeReadiness()).resolves.toMatchObject({
        systemReady: false,
        enabled: false,
      });
    });

    it('names EVERY unbound wired role, in registry order', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue({
        value: storedSettings({ models: { tutor: 'gpt-5.4' } }),
      } as never);

      await expect(service.describeReadiness()).resolves.toMatchObject({
        systemReady: false,
        unboundRoles: ['grader', 'transcribe', 'speak'],
      });
    });

    it('IGNORES the unwired roles', async () => {
      // `realtime` and `embed` are declared and inert. Requiring them would
      // mean a fresh install could never become ready no matter what an admin
      // did.
      prisma.systemSettings.findUnique.mockResolvedValue({
        value: storedSettings(),
      } as never);

      const result = await service.describeReadiness();

      expect(result.unboundRoles).not.toContain('realtime');
      expect(result.unboundRoles).not.toContain('embed');
    });

    // -------------------------------------------------------------------------
    // The E9 split (#88): `unboundRoles` widened, `systemReady` narrowed
    // -------------------------------------------------------------------------

    it('is STILL ready with only tutor and grader bound, after the speech roles were wired', async () => {
      // THE REGRESSION THIS PAIR EXISTS FOR. Every installation deployed
      // before E9 has exactly these two bindings. Had `systemReady` stayed
      // "no wired role unbound", wiring `transcribe` and `speak` would have
      // flipped all of them to not-ready on deploy — an admin who changed
      // nothing, with a working tutor and grader, finding their system
      // reporting itself broken and their learners hitting `AiNotReady` on
      // features that have nothing to do with voice.
      prisma.systemSettings.findUnique.mockResolvedValue({
        value: storedSettings(),
      } as never);

      await expect(service.describeReadiness()).resolves.toMatchObject({
        systemReady: true,
      });
    });

    it('still NAMES the unbound speech roles on that same installation', async () => {
      // The other half: `unboundRoles` keeps meaning "every wired role with no
      // binding", so a voice surface can say WHICH role its administrator has
      // not configured (#109) rather than reading a system-wide boolean that
      // is `true` and then failing at the point of use with no explanation.
      prisma.systemSettings.findUnique.mockResolvedValue({
        value: storedSettings(),
      } as never);

      const result = await service.describeReadiness();

      expect(result.unboundRoles).toEqual(['transcribe', 'speak']);
    });

    it('is NOT ready when a text role is unbound, even with speech bound', async () => {
      // The narrowing cuts one way only: `tutor` and `grader` are what the
      // hard-blocking gate depends on, so an unbound one is still not ready no
      // matter what else is configured.
      prisma.systemSettings.findUnique.mockResolvedValue({
        value: storedSettings({
          models: {
            grader: 'gpt-5.4-mini',
            transcribe: 'whisper-1',
            speak: 'tts-1-hd',
          },
        }),
      } as never);

      const result = await service.describeReadiness();

      expect(result.systemReady).toBe(false);
      expect(result.unboundRoles).toEqual(['tutor']);
    });

    it('reports every wired role unbound on a corrupt row, speech included', async () => {
      // The catch branch stays consistent with `unboundRoles`' meaning: an
      // unreadable row means no binding can be honoured, so reporting a
      // narrower failure than there is would be a lie in the caller's favour.
      prisma.systemSettings.findUnique.mockResolvedValue({
        value: { provider: 42 },
      } as never);

      const result = await service.describeReadiness();

      expect(result.systemReady).toBe(false);
      expect(result.unboundRoles).toEqual([
        'tutor',
        'grader',
        'transcribe',
        'speak',
      ]);
    });

    it('reports not-ready rather than throwing on a corrupt row', async () => {
      // This feeds the gate that decides whether anyone can use the app; a
      // throw here would take that down.
      prisma.systemSettings.findUnique.mockResolvedValue({
        value: { provider: 42 },
      } as never);

      await expect(service.describeReadiness()).resolves.toMatchObject({
        systemReady: false,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // describeForAdmin() — the repair path
  // ---------------------------------------------------------------------------

  describe('describeForAdmin', () => {
    it('reports a corrupt row instead of throwing, so the repair screen renders', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue(
        settingsRow({ provider: 'nope' }) as never,
      );

      const view = await service.describeForAdmin();

      expect(view.settingsError).toMatch(/invalid at: provider/);
      expect(view.provider).toBeNull();
      expect(view.version).toBe(3);
    });

    it('reports the masked key status without reading the key', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue(
        settingsRow(storedSettings()) as never,
      );
      credentials.describe.mockResolvedValue({
        purpose: AI_SYSTEM_CREDENTIAL_PURPOSE,
        name: AI_SYSTEM_CREDENTIAL_NAME,
        hint: '••••vwx',
        label: 'OpenAI API key (server)',
        updatedByUserId: USER_ID,
        createdAt: new Date(),
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      });

      const view = await service.describeForAdmin();

      expect(view.apiKeyStatus).toMatchObject({
        configured: true,
        hint: '••••vwx',
        updatedByUserId: USER_ID,
      });
      // The one method that returns plaintext, never called here.
      expect(credentials.getSecret).not.toHaveBeenCalled();
    });

    it('reports configured:false when nothing is stored', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue(null);

      const view = await service.describeForAdmin();

      expect(view.apiKeyStatus).toEqual({
        configured: false,
        hint: null,
        updatedAt: null,
        updatedByUserId: null,
      });
      expect(view.version).toBe(0);
    });

    it('never returns a field named like a key', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue(null);

      const view = await service.describeForAdmin();

      expect(view).not.toHaveProperty('apiKey');
      expect(JSON.stringify(view)).not.toContain(KEY);
    });
  });

  // ---------------------------------------------------------------------------
  // update() — the write path
  // ---------------------------------------------------------------------------

  describe('update', () => {
    beforeEach(() => {
      prisma.systemSettings.upsert.mockResolvedValue(
        settingsRow(storedSettings(), 4) as never,
      );
      prisma.auditEvent.create.mockResolvedValue({} as never);
    });

    it('stores a submitted key byte-for-byte, untrimmed', async () => {
      // Trimming a secret produces an authentication failure with no visible
      // cause.
      const padded = `  ${KEY}  `;
      prisma.systemSettings.findUnique.mockResolvedValue(null);

      await service.update(
        { provider: 'openai', enabled: true, models: {}, apiKey: padded },
        USER_ID,
      );

      expect(credentials.setSecret).toHaveBeenCalledWith(
        AI_SYSTEM_CREDENTIAL_PURPOSE,
        AI_SYSTEM_CREDENTIAL_NAME,
        padded,
        expect.objectContaining({ updatedByUserId: USER_ID }),
      );
    });

    it('writes the credential BEFORE the settings row', async () => {
      // A refused key must not leave a provider selected with nothing behind
      // it. Asserted by invocation order rather than by comment.
      prisma.systemSettings.findUnique.mockResolvedValue(null);
      const order: string[] = [];
      credentials.setSecret.mockImplementation(async () => {
        order.push('credential');
      });
      (
        prisma.systemSettings.upsert as unknown as jest.Mock
      ).mockImplementation(async () => {
        order.push('settings');
        return settingsRow(storedSettings(), 1);
      });

      await service.update(
        { provider: 'openai', enabled: true, models: {}, apiKey: KEY },
        USER_ID,
      );

      expect(order).toEqual(['credential', 'settings']);
    });

    it('preserves the stored key on a blank submission and still applies the rest', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue({ version: 3 } as never);
      credentials.describe.mockResolvedValue({ hint: '••••vwx' });

      await service.update(
        {
          provider: 'openai',
          enabled: false,
          models: { tutor: 'gpt-5.6' },
          apiKey: '',
        },
        USER_ID,
      );

      // Never called at all — not called with a blank. Calling it on a system
      // that has never stored a key would raise the store's first-write 400 on
      // an ordinary save.
      expect(credentials.setSecret).not.toHaveBeenCalled();
      expect(prisma.systemSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            value: expect.objectContaining({ enabled: false }),
          }),
        }),
      );
    });

    it.each([[''], [null], [undefined]])(
      'treats %p as "I did not retype the key"',
      async (value) => {
        prisma.systemSettings.findUnique.mockResolvedValue({ version: 1 } as never);
        credentials.describe.mockResolvedValue({ hint: '••••vwx' });

        await service.update(
          { provider: 'openai', enabled: true, models: {}, apiKey: value },
          USER_ID,
        );

        expect(credentials.setSecret).not.toHaveBeenCalled();
      },
    );

    it('REJECTS selecting a provider with no key stored and none submitted', async () => {
      // Saving that would produce a configuration that cannot do anything, and
      // the admin would find out from an empty model dropdown.
      prisma.systemSettings.findUnique.mockResolvedValue(null);
      credentials.describe.mockResolvedValue(null);

      await expect(
        service.update(
          { provider: 'openai', enabled: true, models: {} },
          USER_ID,
        ),
      ).rejects.toThrow(ConflictException);

      expect(prisma.systemSettings.upsert).not.toHaveBeenCalled();
    });

    it('allows a blank key with no provider selected', async () => {
      // Turning AI off on a system that was never configured is a legitimate
      // save.
      prisma.systemSettings.findUnique.mockResolvedValue(null);
      credentials.describe.mockResolvedValue(null);

      await expect(
        service.update({ provider: null, enabled: false, models: {} }, USER_ID),
      ).resolves.toBeDefined();
    });

    it('normalises an empty model binding to null', async () => {
      // A <Select> with no selection submits ''. The schema expresses "not
      // bound" as null.
      prisma.systemSettings.findUnique.mockResolvedValue(null);

      await service.update(
        {
          provider: 'openai',
          enabled: true,
          models: { tutor: 'gpt-5.4', grader: '' },
          apiKey: KEY,
        },
        USER_ID,
      );

      const written = prisma.systemSettings.upsert.mock.calls[0][0] as {
        create: { value: { models: Record<string, string | null> } };
      };
      expect(written.create.value.models.grader).toBeNull();
    });

    it('returns 409 on a version mismatch rather than overwriting', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue({ version: 7 } as never);

      await expect(
        service.update(
          { provider: null, enabled: false, models: {} },
          USER_ID,
          3,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('accepts If-Match: 0 as "I believe nothing is stored"', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue(null);

      await expect(
        service.update(
          { provider: null, enabled: false, models: {} },
          USER_ID,
          0,
        ),
      ).resolves.toBeDefined();
    });

    it('strips a key that arrives inside the settings body', async () => {
      // zod drops unknown keys; this asserts the persisted blob is clean
      // rather than trusting the strip.
      prisma.systemSettings.findUnique.mockResolvedValue(null);

      await service.update(
        {
          provider: 'openai',
          enabled: true,
          models: {},
          apiKey: KEY,
        },
        USER_ID,
      );

      const written = prisma.systemSettings.upsert.mock.calls[0][0] as {
        create: { value: Record<string, unknown> };
      };
      expect(written.create.value).not.toHaveProperty('apiKey');
      expect(JSON.stringify(written.create.value)).not.toContain(KEY);
    });

    it('audits whether the key changed, never what it changed to', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue(null);

      await service.update(
        { provider: 'openai', enabled: true, models: {}, apiKey: KEY },
        USER_ID,
      );

      const audit = prisma.auditEvent.create.mock.calls[0][0] as {
        data: { action: string; meta: Record<string, unknown> };
      };
      expect(audit.data.action).toBe('ai_settings:replace');
      expect(audit.data.meta.apiKeyChanged).toBe(true);
      expect(JSON.stringify(audit.data.meta)).not.toContain(KEY);
    });

    it('notifies change listeners after a successful write', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue(null);
      const listener = jest.fn();
      service.onSettingsChanged(listener);

      await service.update(
        { provider: null, enabled: false, models: {} },
        USER_ID,
      );

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not fail a save because a listener threw', async () => {
      // The admin's change is already persisted; a stale cache is a far
      // smaller problem than a save that reports failure.
      prisma.systemSettings.findUnique.mockResolvedValue(null);
      service.onSettingsChanged(() => {
        throw new Error('cache blew up');
      });

      await expect(
        service.update({ provider: null, enabled: false, models: {} }, USER_ID),
      ).resolves.toBeDefined();
    });

    it('does not notify listeners when the write was refused', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue({ version: 9 } as never);
      const listener = jest.fn();
      service.onSettingsChanged(listener);

      await expect(
        service.update(
          { provider: null, enabled: false, models: {} },
          USER_ID,
          1,
        ),
      ).rejects.toThrow(ConflictException);

      expect(listener).not.toHaveBeenCalled();
    });
  });
});

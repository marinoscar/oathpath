import { Test, TestingModule } from '@nestjs/testing';

import { AiSettingsController } from './ai-settings.controller';
import { AiSettingsService } from './ai-settings.service';
import { OpenAiProvider } from './providers/openai.provider';
import { AiConnectionTestService } from './ai-connection-test.service';
import {
  AI_SETTINGS_RESPONSE_CARRIES_NO_SECRET,
  aiSettingsResponseSchema,
} from './dto/ai-settings-response.dto';
import { updateAiSettingsSchema } from './dto/update-ai-settings.dto';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PatService } from '../pat/pat.service';

// =============================================================================
// AiSettingsController — tests (issue #30, epic #25)
// =============================================================================
//
// The controller is thin, so these tests are about the three things that are
// NOT thin: the permission strings the registry card must mirror, the If-Match
// parsing (where a bare parseInt turns every save into an unfixable 409), and
// the write-only key field's schema rules.
// =============================================================================

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('AiSettingsController', () => {
  let controller: AiSettingsController;
  let service: {
    describeForAdmin: jest.Mock;
    update: jest.Mock;
    get: jest.Mock;
    describeCatalog: jest.Mock;
  };
  let openai: { supports: jest.Mock; listModels: jest.Mock };
  let connectionTest: { runTest: jest.Mock };

  beforeEach(async () => {
    service = {
      describeForAdmin: jest.fn().mockResolvedValue({ provider: null }),
      update: jest.fn().mockResolvedValue({ provider: 'openai' }),
      get: jest.fn().mockResolvedValue({ provider: 'openai' }),
      describeCatalog: jest.fn().mockResolvedValue({ models: [], roles: [] }),
    };
    openai = { supports: jest.fn(() => true), listModels: jest.fn() };
    connectionTest = { runTest: jest.fn().mockResolvedValue({ success: true }) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiSettingsController],
      providers: [
        { provide: AiSettingsService, useValue: service },
        { provide: OpenAiProvider, useValue: openai },
        { provide: AiConnectionTestService, useValue: connectionTest },
        // Not exercised: these methods are called directly, never through
        // `JwtAuthGuard` — which `@Auth()` attaches at the route level and
        // which Nest's DI graph still resolves at module-compile time, since
        // it appears in the controller's `@UseGuards` metadata.
        { provide: PatService, useValue: { validateToken: jest.fn() } },
      ],
    }).compile();

    controller = module.get(AiSettingsController);
  });

  describe('If-Match parsing', () => {
    it('passes a numeric header through as the expected version', async () => {
      await controller.replaceSettings({} as never, USER_ID, '7');

      expect(service.update).toHaveBeenCalledWith({}, USER_ID, 7);
    });

    it('passes 0 through — "I believe nothing is stored"', async () => {
      // Not falsy-coerced away. `0` is the only way to guard a FIRST save.
      await controller.replaceSettings({} as never, USER_ID, '0');

      expect(service.update).toHaveBeenCalledWith({}, USER_ID, 0);
    });

    it('treats an absent header as unconditional', async () => {
      await controller.replaceSettings({} as never, USER_ID, undefined);

      expect(service.update).toHaveBeenCalledWith({}, USER_ID, undefined);
    });

    it('treats an UNPARSEABLE header as absent, not as NaN', async () => {
      // `parseInt('abc')` is NaN, and `NaN !== currentVersion` is always true —
      // so a malformed header would turn every save into a 409 that no amount
      // of reloading fixes.
      await controller.replaceSettings({} as never, USER_ID, 'not-a-number');

      expect(service.update).toHaveBeenCalledWith({}, USER_ID, undefined);
    });
  });

  describe('GET /models query parameters', () => {
    it('resolves a role key to the capability family it needs', async () => {
      // The web never has to know the role -> family mapping.
      await controller.listModels(undefined, 'embed', undefined);

      expect(service.describeCatalog).toHaveBeenCalledWith(
        openai,
        expect.objectContaining({ family: 'embedding' }),
      );
    });

    it('accepts a family directly when no role is given', async () => {
      await controller.listModels(undefined, undefined, 'tts');

      expect(service.describeCatalog).toHaveBeenCalledWith(
        openai,
        expect.objectContaining({ family: 'tts' }),
      );
    });

    it('lets the role win over an explicit family', async () => {
      await controller.listModels(undefined, 'grader', 'tts');

      expect(service.describeCatalog).toHaveBeenCalledWith(
        openai,
        expect.objectContaining({ family: 'text' }),
      );
    });

    it('IGNORES an unknown role rather than rejecting it', async () => {
      // A stale client asking about a removed role should see a full list, not
      // an error page.
      await controller.listModels(undefined, 'role-that-was-removed', undefined);

      expect(service.describeCatalog).toHaveBeenCalledWith(
        openai,
        expect.objectContaining({ family: undefined }),
      );
    });

    it('ignores an unknown family too', async () => {
      await controller.listModels(undefined, undefined, 'not-a-family');

      expect(service.describeCatalog).toHaveBeenCalledWith(
        openai,
        expect.objectContaining({ family: undefined }),
      );
    });

    it('engages show-all only for the literal string "true"', async () => {
      // A bare Boolean(showAll) would make `?showAll=false` engage the hatch,
      // which is the opposite of what it says.
      await controller.listModels('true', undefined, undefined);
      expect(service.describeCatalog).toHaveBeenLastCalledWith(
        openai,
        expect.objectContaining({ showAll: true }),
      );

      await controller.listModels('false', undefined, undefined);
      expect(service.describeCatalog).toHaveBeenLastCalledWith(
        openai,
        expect.objectContaining({ showAll: false }),
      );

      await controller.listModels(undefined, undefined, undefined);
      expect(service.describeCatalog).toHaveBeenLastCalledWith(
        openai,
        expect.objectContaining({ showAll: false }),
      );
    });

    it('passes null for the provider when none is selected', async () => {
      service.get.mockResolvedValue({ provider: null });

      await controller.listModels(undefined, undefined, undefined);

      expect(service.describeCatalog).toHaveBeenCalledWith(
        null,
        expect.anything(),
      );
    });

    it('passes null rather than failing when the settings row is corrupt', async () => {
      // The admin page is where a corrupt row gets repaired.
      service.get.mockRejectedValue(new Error('invalid at: provider'));

      await expect(
        controller.listModels(undefined, undefined, undefined),
      ).resolves.toBeDefined();
      expect(service.describeCatalog).toHaveBeenCalledWith(
        null,
        expect.anything(),
      );
    });

    it('reads on system_settings:read, the same gate as the settings GET', () => {
      const permissions = Reflect.getMetadata(
        PERMISSIONS_KEY,
        AiSettingsController.prototype.listModels,
      );
      expect(permissions).toEqual([PERMISSIONS.SYSTEM_SETTINGS_READ]);
    });
  });

  describe('POST /test', () => {
    it('passes nothing but the caller to the test service', async () => {
      // There is no target parameter, and no body. A free-text model id would
      // make this a call-arbitrary-endpoint primitive on the organisation's
      // credential.
      await controller.testConnection(USER_ID);

      expect(connectionTest.runTest).toHaveBeenCalledWith(USER_ID);
      expect(connectionTest.runTest).toHaveBeenCalledTimes(1);
    });

    it('answers 200 even for a failed test', () => {
      // Declared with @HttpCode(200) rather than the POST default of 201, so a
      // refused connection arrives as a readable payload instead of going
      // through the error envelope, which suppresses detail in production.
      const status = Reflect.getMetadata(
        '__httpCode__',
        AiSettingsController.prototype.testConnection,
      );
      expect(status).toBe(200);
    });
  });

  describe('permission strings the registry card must mirror', () => {
    // CLAUDE.md's Settings UI Pattern rule 3: the card's `permission` field
    // must be the exact string the controller enforces. Pinned here so the
    // web-side assertion has something stable to mirror.
    it('reads on system_settings:read', () => {
      const permissions = Reflect.getMetadata(
        PERMISSIONS_KEY,
        AiSettingsController.prototype.getSettings,
      );
      expect(permissions).toEqual([PERMISSIONS.SYSTEM_SETTINGS_READ]);
    });

    it('writes on system_settings:write', () => {
      const permissions = Reflect.getMetadata(
        PERMISSIONS_KEY,
        AiSettingsController.prototype.replaceSettings,
      );
      expect(permissions).toEqual([PERMISSIONS.SYSTEM_SETTINGS_WRITE]);
    });

    it('TESTS on system_settings:WRITE, not read', () => {
      // A side-effecting operation: it causes the system to originate an
      // outbound request on the organisation's credential. `:read` is held by
      // anyone who may look at settings, and looking is not calling.
      const permissions = Reflect.getMetadata(
        PERMISSIONS_KEY,
        AiSettingsController.prototype.testConnection,
      );
      expect(permissions).toEqual([PERMISSIONS.SYSTEM_SETTINGS_WRITE]);
    });

    it('reuses system_settings rather than inventing an ai permission', () => {
      // A new string costs a seed change, a re-seed, and every existing Admin
      // role being updated.
      expect(Object.values(PERMISSIONS)).not.toContain('ai_settings:read');
      expect(Object.values(PERMISSIONS)).not.toContain('ai_settings:write');
    });
  });
});

describe('updateAiSettingsSchema — the write-only key field', () => {
  it('accepts a blank key, which means "keep the stored one"', () => {
    // `.min(1)` here would make an admin retype a secret they cannot see just
    // to change a model binding.
    for (const apiKey of ['', null, undefined]) {
      const result = updateAiSettingsSchema.safeParse({
        provider: 'openai',
        enabled: true,
        apiKey,
      });
      expect(result.success).toBe(true);
    }
  });

  it('does NOT trim a submitted key', () => {
    // A key whose surrounding whitespace is significant is a real key, and
    // silently altering a secret's bytes produces an authentication failure
    // with no visible cause.
    const padded = '  sk-with-significant-space  ';
    const parsed = updateAiSettingsSchema.parse({
      provider: 'openai',
      enabled: true,
      apiKey: padded,
    });

    expect(parsed.apiKey).toBe(padded);
  });

  it('bounds the key length so a paste accident is refused by the validator', () => {
    const result = updateAiSettingsSchema.safeParse({
      provider: 'openai',
      enabled: true,
      apiKey: 'x'.repeat(2000),
    });

    expect(result.success).toBe(false);
  });

  it('accepts an emptied model select', () => {
    const result = updateAiSettingsSchema.safeParse({
      provider: 'openai',
      enabled: true,
      models: { tutor: '', grader: null },
    });

    expect(result.success).toBe(true);
  });

  it('does not require minModelGeneration, matching the published schema', () => {
    expect(
      updateAiSettingsSchema.safeParse({ provider: null, enabled: false })
        .success,
    ).toBe(true);
  });
});

describe('aiSettingsResponseSchema', () => {
  it('carries its own no-secret proof, separate from the persisted schema', () => {
    // The response `.extend()`s the persisted schema, and an extension is
    // exactly where "just send the key back so the form can prefill it" lands.
    expect(AI_SETTINGS_RESPONSE_CARRIES_NO_SECRET).toBe(true);
  });

  it('has no key-shaped field', () => {
    const shape = Object.keys(aiSettingsResponseSchema.shape);

    expect(shape).not.toContain('apiKey');
    expect(shape).not.toContain('secret');
    expect(shape).toContain('apiKeyStatus');
  });

  it('exposes only non-secret facts about the stored key', () => {
    const statusShape = Object.keys(
      aiSettingsResponseSchema.shape.apiKeyStatus.shape,
    );

    expect(statusShape.sort()).toEqual(
      ['configured', 'hint', 'updatedAt', 'updatedByUserId'].sort(),
    );
  });
});

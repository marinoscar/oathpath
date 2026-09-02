import { Test, TestingModule } from '@nestjs/testing';

import { AiSettingsService } from './ai-settings.service';
import { AI_MODEL_ROLES } from './ai-model-roles';
import { AI_SETTINGS_KEY, aiSettingsSchema } from './ai-settings.schema';
import { AI_MODEL_CATALOG_CARRIES_NO_SECRET } from './dto/ai-model-catalog.dto';
import type { AiProvider } from './providers/ai-provider.interface';
import type { AiModelCatalogResult } from './ai.types';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

// =============================================================================
// GET /api/ai-settings/models — the catalog view (issue #31, epic #25)
// =============================================================================
//
// Four claims, and three of them are about NOT failing:
//
//   1. A fresh install with no key is `notConfigured`, not an error.
//   2. A provider refusal is a payload with the roles still in it, not a 500 —
//      withholding the roles would leave the admin page unable to render the
//      controls that explain what is wrong.
//   3. Show-all returns strictly more, including unparseable generations.
//   4. Nothing about the key is in the response.
// =============================================================================

const CATALOG: AiModelCatalogResult = {
  success: true,
  notConfigured: false,
  error: null,
  models: [
    { id: 'gpt-5.4', family: 'text', generation: 5.4, createdAt: new Date(3000) },
    { id: 'gpt-4o', family: 'text', generation: 4, createdAt: new Date(2000) },
    { id: 'whisper-1', family: 'transcribe', generation: null, createdAt: null },
    { id: 'mystery-model', family: 'other', generation: null, createdAt: null },
  ],
};

function fakeProvider(
  result: AiModelCatalogResult,
  supports: (f: string) => boolean = () => true,
): AiProvider {
  return {
    kind: 'openai',
    capabilities: new Set(),
    supports: supports as AiProvider['supports'],
    listModels: jest.fn().mockResolvedValue(result),
    testConnection: jest.fn(),
  } as unknown as AiProvider;
}

describe('AiSettingsService.describeCatalog', () => {
  let service: AiSettingsService;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiSettingsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: CredentialsService,
          useValue: { describe: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get(AiSettingsService);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    prisma.systemSettings.findUnique.mockResolvedValue({
      key: AI_SETTINGS_KEY,
      value: aiSettingsSchema.parse({
        provider: 'openai',
        enabled: true,
        models: {},
      }),
    } as never);
  });

  it('returns the roles even when no provider is selected', async () => {
    // They come from the code registry, not the provider, so a missing key has
    // no bearing on them. Withholding them leaves the admin page with an empty
    // screen instead of six selects and an explanation.
    const result = await service.describeCatalog(null);

    expect(result.roles).toHaveLength(AI_MODEL_ROLES.length);
    expect(result.models).toEqual([]);
    expect(result.notConfigured).toBe(true);
    expect(result.error).toBeNull();
  });

  it('reports notConfigured, not an error, when no key is stored', async () => {
    // The state of every fresh install. Rendering it as a failure makes a
    // brand-new system look broken.
    const provider = fakeProvider({
      success: false,
      models: [],
      error: null,
      notConfigured: true,
    });

    const result = await service.describeCatalog(provider);

    expect(result.notConfigured).toBe(true);
    expect(result.error).toBeNull();
    expect(result.roles.length).toBeGreaterThan(0);
  });

  it('surfaces a provider refusal as a message, with the roles intact', async () => {
    const provider = fakeProvider({
      success: false,
      models: [],
      error: 'OpenAI: 401 Incorrect API key provided',
      notConfigured: false,
    });

    const result = await service.describeCatalog(provider);

    expect(result.notConfigured).toBe(false);
    expect(result.error).toContain('401');
    expect(result.roles.length).toBeGreaterThan(0);
  });

  it('applies the floor to text and leaves other families alone', async () => {
    const result = await service.describeCatalog(fakeProvider(CATALOG));
    const ids = result.models.map((m) => m.id);

    expect(ids).toContain('gpt-5.4');
    expect(ids).not.toContain('gpt-4o');
    // No comparable generation; a floor would empty this list rather than
    // filter it.
    expect(ids).toContain('whisper-1');
  });

  it('hides unclassified models by default', async () => {
    const result = await service.describeCatalog(fakeProvider(CATALOG));

    expect(result.models.map((m) => m.id)).not.toContain('mystery-model');
  });

  it('returns strictly more under show-all, including unparseable generations', async () => {
    const narrow = await service.describeCatalog(fakeProvider(CATALOG));
    const all = await service.describeCatalog(fakeProvider(CATALOG), {
      showAll: true,
    });

    expect(all.models.length).toBeGreaterThan(narrow.models.length);
    for (const model of narrow.models) {
      expect(all.models.map((m) => m.id)).toContain(model.id);
    }
    expect(all.models.map((m) => m.id)).toContain('mystery-model');
    expect(all.models.map((m) => m.id)).toContain('gpt-4o');
    expect(all.showAll).toBe(true);
  });

  it('restricts to one family when asked', async () => {
    const result = await service.describeCatalog(fakeProvider(CATALOG), {
      family: 'transcribe',
    });

    expect(result.models.map((m) => m.id)).toEqual(['whisper-1']);
  });

  it('marks a role unwired when the provider cannot serve its family', async () => {
    // A provider that does not declare a capability cannot be selected for
    // that role. This is that gate reaching the UI: the page renders the role
    // inert rather than offering a select whose every choice would fail.
    const chatOnly = fakeProvider(CATALOG, (f) => f === 'text');

    const result = await service.describeCatalog(chatOnly);
    const roles = Object.fromEntries(result.roles.map((r) => [r.key, r.wired]));

    expect(roles.tutor).toBe(true);
    expect(roles.grader).toBe(true);
    expect(roles.realtime).toBe(false);
  });

  it('echoes the floor that was applied, so the page can explain the filter', async () => {
    const result = await service.describeCatalog(fakeProvider(CATALOG));

    expect(result.minGeneration).toBe(5.4);
  });

  it('falls back to the default floor rather than failing on a corrupt row', async () => {
    // The admin page is where a corrupt row gets repaired; this endpoint
    // taking it down would remove the repair route.
    prisma.systemSettings.findUnique.mockResolvedValue({
      value: { provider: 42 },
    } as never);

    const result = await service.describeCatalog(fakeProvider(CATALOG));

    expect(result.minGeneration).toBe(5.4);
    expect(result.roles.length).toBeGreaterThan(0);
  });

  it('serialises timestamps as ISO strings', async () => {
    const result = await service.describeCatalog(fakeProvider(CATALOG));

    expect(result.models[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('carries no key material in any shape', async () => {
    const result = await service.describeCatalog(fakeProvider(CATALOG));

    expect(result).not.toHaveProperty('apiKey');
    expect(result).not.toHaveProperty('hint');
    expect(AI_MODEL_CATALOG_CARRIES_NO_SECRET).toBe(true);
  });
});

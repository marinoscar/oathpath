import {
  AI_PROVIDER_KINDS,
  AI_SETTINGS_CARRIES_NO_SECRET,
  AI_SETTINGS_KEY,
  DEFAULT_AI_SETTINGS,
  DEFAULT_MIN_MODEL_GENERATION,
  aiSettingsSchema,
} from './ai-settings.schema';
import { AI_MODEL_ROLE_KEYS } from './ai-model-roles';

// =============================================================================
// AI settings schema (issue #27, epic #25)
// =============================================================================
//
// Three claims worth a test, and one that cannot have one.
//
//   1. The defaults are the real "fresh install" state, not `{}` dressed up.
//   2. The `models` map is DERIVED from the role registry, so adding a role
//      cannot leave a slot missing.
//   3. Unknown keys — including a secret-shaped one — do not survive a parse.
//
// The no-secret proof itself is a COMPILE-TIME guarantee and is untestable at
// runtime by construction: the failure mode is `tsc` refusing to build. The
// assertion on `AI_SETTINGS_CARRIES_NO_SECRET` below is the runtime shadow of
// it — worth having only because it makes the proof's existence visible to
// someone reading the tests rather than only to someone reading the schema.
// =============================================================================

describe('aiSettingsSchema', () => {
  it('stores AI configuration under its own system_settings key', () => {
    // A row of its own, not a key in the `global` blob — see the constant's
    // own note for why that blob would eat it.
    expect(AI_SETTINGS_KEY).toBe('ai');
  });

  describe('DEFAULT_AI_SETTINGS', () => {
    it('is a valid settings object, not an under-specified stand-in', () => {
      // The failure this guards: a default that only survives because nothing
      // validates it, and then fails the first time a real read parses it.
      expect(aiSettingsSchema.safeParse(DEFAULT_AI_SETTINGS).success).toBe(true);
    });

    it('describes a fresh install: no provider, disabled, nothing bound', () => {
      expect(DEFAULT_AI_SETTINGS.provider).toBeNull();
      expect(DEFAULT_AI_SETTINGS.enabled).toBe(false);
      expect(DEFAULT_AI_SETTINGS.minModelGeneration).toBe(
        DEFAULT_MIN_MODEL_GENERATION,
      );

      for (const key of AI_MODEL_ROLE_KEYS) {
        expect(DEFAULT_AI_SETTINGS.models[key]).toBeNull();
      }
    });

    it('carries a slot for every declared role and no others', () => {
      // The derivation claim. A hand-written default would go stale the first
      // time a role is added, and the staleness presents as a role the admin
      // page renders but cannot bind.
      expect(Object.keys(DEFAULT_AI_SETTINGS.models).sort()).toEqual(
        [...AI_MODEL_ROLE_KEYS].sort(),
      );
    });
  });

  describe('parsing', () => {
    it('defaults an omitted role binding to null rather than dropping the key', () => {
      // `null` and "absent" must not both be reachable: an absent key would be
      // indistinguishable from a role added after the row was written, and the
      // settings page could not tell "never configured" from "explicitly
      // cleared".
      const parsed = aiSettingsSchema.parse({
        provider: 'openai',
        enabled: true,
        models: { tutor: 'gpt-5.4' },
      });

      expect(parsed.models.tutor).toBe('gpt-5.4');
      for (const key of AI_MODEL_ROLE_KEYS) {
        expect(parsed.models).toHaveProperty(key);
      }
      expect(parsed.models.grader).toBeNull();
    });

    it('defaults the generation floor when it is not supplied', () => {
      const parsed = aiSettingsSchema.parse({
        provider: null,
        enabled: false,
        models: {},
      });

      expect(parsed.minModelGeneration).toBe(DEFAULT_MIN_MODEL_GENERATION);
    });

    it('strips a binding for a role the registry does not declare', () => {
      // Dropped on save rather than failing the parse: a role removed from the
      // registry must not take the settings page down with it.
      const parsed = aiSettingsSchema.parse({
        provider: 'openai',
        enabled: true,
        models: { tutor: 'gpt-5.4', 'role-that-was-removed': 'gpt-4' },
      });

      expect(parsed.models).not.toHaveProperty('role-that-was-removed');
    });

    it('strips a secret-shaped key rather than persisting it', () => {
      // The runtime half of the guarantee the compile-time proof makes.
      // zod drops unknown keys, so even a body that carries `apiKey` cannot
      // get it into the persisted blob.
      const parsed = aiSettingsSchema.parse({
        provider: 'openai',
        enabled: true,
        models: {},
        apiKey: 'sk-should-never-be-persisted',
      });

      expect(parsed).not.toHaveProperty('apiKey');
    });

    it('rejects a provider kind that is not declared', () => {
      const result = aiSettingsSchema.safeParse({
        provider: 'anthropic',
        enabled: true,
        models: {},
      });

      expect(result.success).toBe(false);
    });

    it('rejects an empty model id, which is not the same as unbound', () => {
      // Unbound is `null`. `''` is a form control that was cleared and would
      // otherwise be sent to the provider as a model name.
      const result = aiSettingsSchema.safeParse({
        provider: 'openai',
        enabled: true,
        models: { tutor: '' },
      });

      expect(result.success).toBe(false);
    });

    it('rejects a negative generation floor', () => {
      const result = aiSettingsSchema.safeParse({
        provider: null,
        enabled: false,
        models: {},
        minModelGeneration: -1,
      });

      expect(result.success).toBe(false);
    });

    it('rejects a floor above the bound that catches a decimal-point typo', () => {
      // `54` for `5.4` would silently empty every dropdown.
      const result = aiSettingsSchema.safeParse({
        provider: null,
        enabled: false,
        models: {},
        minModelGeneration: 540,
      });

      expect(result.success).toBe(false);
    });
  });

  describe('the no-secret proof', () => {
    it('is present, so removing it is a visible deletion', () => {
      expect(AI_SETTINGS_CARRIES_NO_SECRET).toBe(true);
    });

    it('declares openai as the only provider kind for now', () => {
      // Decision 3: the enum exists so a second provider is not a migration
      // over live admin configuration.
      expect([...AI_PROVIDER_KINDS]).toEqual(['openai']);
    });

    it('rejects `fake` as a provider an admin could select or a row could hold', () => {
      // `FakeAiProvider` (#105) registers AS `kind: 'openai'` and is
      // substituted at the DI layer; it deliberately adds no member here.
      //
      // THIS ENUM IS PERSISTED. A `'fake'` member would be a value the admin
      // page's dropdown offers on a production deployment, a value every
      // `Record<AiProviderKind, …>` in the settings and status paths needs a
      // branch for, and — the part no later fix can undo — a value that
      // SURVIVES IN THE DATABASE after the fake and its flag are deleted,
      // leaving a settings row nothing can parse and an AI configuration that
      // cannot be read or re-saved. See `ai-evaluation.md` §10 and §12.
      expect([...AI_PROVIDER_KINDS]).not.toContain('fake');

      expect(
        aiSettingsSchema.safeParse({
          provider: 'fake',
          enabled: true,
          models: {},
        }).success,
      ).toBe(false);
    });
  });
});

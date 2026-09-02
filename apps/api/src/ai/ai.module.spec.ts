import type { ConfigService } from '@nestjs/config';

import { AiModule, resolveAiProvider } from './ai.module';
import type { AiSettingsService } from './ai-settings.service';
import type { AiUsageService } from './ai-usage.service';
import type { CredentialsService } from '../credentials/credentials.service';
import { FakeAiProvider } from './providers/fake-ai.provider';
import { OpenAiProvider } from './providers/openai.provider';
import type { AiStatusService } from './ai-status.service';

// =============================================================================
// AiModule wiring (issue #30/#31, epic #25)
// =============================================================================
//
// The module's constructor does one thing that is easy to delete by accident
// and invisible when it is gone: it connects a settings write to the
// provider's catalog cache.
//
// Without it, an admin who rotates the server key keeps seeing the previous
// organisation's model list for up to five minutes — and the bug looks like a
// stale browser cache rather than a missing line in a module.
//
// It is wired HERE rather than by injecting either service into the other,
// because that cycle leaves `design:paramtypes` holding `undefined` under
// `emitDecoratorMetadata` and Nest fails to resolve the dependency at boot.
// The module is the one place that already knows about both.
// =============================================================================

describe('AiModule', () => {
  /** Build the module over stubs, returning every listener it registered. */
  function wire() {
    const listeners: Array<() => void> = [];

    const settings = {
      onSettingsChanged: (fn: () => void) => listeners.push(fn),
    } as unknown as AiSettingsService;

    const invalidateCatalogCache = jest.fn();
    const openai = { invalidateCatalogCache } as unknown as OpenAiProvider;

    const invalidateStatus = jest.fn();
    const status = { invalidate: invalidateStatus } as unknown as AiStatusService;

    new AiModule(settings, openai, status);

    return { listeners, invalidateCatalogCache, invalidateStatus };
  }

  it('invalidates the provider catalog cache on a settings write', () => {
    const { listeners, invalidateCatalogCache } = wire();

    for (const listener of listeners) listener();

    expect(invalidateCatalogCache).toHaveBeenCalledTimes(1);
  });

  it('invalidates the status cache on a settings write', () => {
    // An admin who has just bound the last model expects the app to become
    // usable immediately, not after a TTL — and the TTL is only a backstop.
    const { listeners, invalidateStatus } = wire();

    for (const listener of listeners) listener();

    expect(invalidateStatus).toHaveBeenCalledTimes(1);
  });

  it('registers BOTH caches, not one', () => {
    // Registering only one is the mistake that presents as "sometimes the
    // save takes effect and sometimes it does not", depending on which cache
    // the symptom happens to come from.
    expect(wire().listeners).toHaveLength(2);
  });
});

// =============================================================================
// The provider substitution (issue #105, epic #53)
// =============================================================================
//
// `resolveAiProvider` is the ONE place in the application that knows a fake
// provider exists. Everything else — `AiDispatchService`, the settings row, the
// admin page, the seed — addresses the `OpenAiProvider` token and holds the
// `AiProvider` interface, so there is no second decision that could disagree
// with this one and no consumer with a branch to get wrong.
//
// Which means the whole of the guarantee lives in this function, and the half
// of it that matters is the NEGATIVE half. `AI_PROVIDER_FAKE=true` reaching a
// production deployment is not exotic: a copied `.env`, a templated compose
// file, an image built from a developer's shell. If the environment check were
// missing, that deployment would grade every learner's answer against a lookup
// table while reporting itself perfectly healthy — `systemReady` true,
// connection tests green, usage rows being written, every verdict wrong and
// nothing failing. So the production case is asserted directly, with the flag
// set, rather than inferred from the development case working.
//
// The tests call the same exported function the module's registration uses.
// Asserting against a re-implementation of the rule would prove only that the
// re-implementation is right.
// =============================================================================

describe('resolveAiProvider', () => {
  /** A ConfigService stub over a plain record, as `TestEnvironmentGuard`'s tests use. */
  function configOf(values: Record<string, string | undefined>): ConfigService {
    return {
      get: <T>(key: string): T | undefined => values[key] as T | undefined,
    } as unknown as ConfigService;
  }

  const credentials = {} as unknown as CredentialsService;
  const usage = {} as unknown as AiUsageService;

  function resolve(values: Record<string, string | undefined>) {
    return resolveAiProvider(configOf(values), credentials, usage);
  }

  it('registers the real provider by default in development', () => {
    // The flag is opt-in. A developer who has not asked for the fake gets the
    // provider that talks to OpenAI, so nothing changes for anyone who has a
    // key.
    expect(resolve({ nodeEnv: 'development' })).toBeInstanceOf(OpenAiProvider);
  });

  it('registers the fake in development when the flag is set', () => {
    expect(
      resolve({ nodeEnv: 'development', AI_PROVIDER_FAKE: 'true' }),
    ).toBeInstanceOf(FakeAiProvider);
  });

  it('registers the fake in test when the flag is set', () => {
    expect(resolve({ nodeEnv: 'test', AI_PROVIDER_FAKE: 'true' })).toBeInstanceOf(
      FakeAiProvider,
    );
  });

  it('NEVER registers the fake under NODE_ENV=production, flag or not', () => {
    // The assertion this block exists for. See the header: an inherited flag
    // must be inert, not merely unlikely.
    expect(
      resolve({ nodeEnv: 'production', AI_PROVIDER_FAKE: 'true' }),
    ).toBeInstanceOf(OpenAiProvider);
    expect(
      resolve({ nodeEnv: 'production', AI_PROVIDER_FAKE: 'true' }),
    ).not.toBeInstanceOf(FakeAiProvider);
  });

  it('treats any value other than the exact string "true" as off', () => {
    // `'false'`, `'1'`, `'yes'` and an empty value all mean "not asked for".
    // An `!== 'false'` test would turn a typo into a fake-provider deployment.
    for (const value of ['false', '1', 'yes', 'TRUE', '']) {
      expect(
        resolve({ nodeEnv: 'development', AI_PROVIDER_FAKE: value }),
      ).toBeInstanceOf(OpenAiProvider);
    }
  });

  it('registers a provider that still reports the persisted openai kind', () => {
    // The settings row stores a real, valid `provider: 'openai'` either way —
    // `ai-evaluation.md` §10. A fake that reported a different kind would make
    // `describeReadiness` disagree with the row an admin actually saved.
    expect(
      resolve({ nodeEnv: 'development', AI_PROVIDER_FAKE: 'true' }).kind,
    ).toBe('openai');
  });
});

import { AiModule } from './ai.module';
import type { AiSettingsService } from './ai-settings.service';
import type { OpenAiProvider } from './providers/openai.provider';
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

import { AiModule } from './ai.module';
import type { AiSettingsService } from './ai-settings.service';
import type { OpenAiProvider } from './providers/openai.provider';

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
  it('invalidates the provider catalog cache on a settings write', () => {
    let listener: (() => void) | undefined;

    const settings = {
      onSettingsChanged: (fn: () => void) => {
        listener = fn;
      },
    } as unknown as AiSettingsService;

    const invalidateCatalogCache = jest.fn();
    const openai = { invalidateCatalogCache } as unknown as OpenAiProvider;

    new AiModule(settings, openai);

    expect(listener).toBeDefined();
    listener!();
    expect(invalidateCatalogCache).toHaveBeenCalledTimes(1);
  });
});

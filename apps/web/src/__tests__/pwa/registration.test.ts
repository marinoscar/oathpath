import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  shouldRegisterServiceWorker,
  registerServiceWorker,
  notifyUpdateReady,
  onUpdateReady,
  resetUpdateStateForTests,
} from '../../sw/registerServiceWorker';
import { SELF_DESTROYING_SERVICE_WORKER } from '../../sw/buildServiceWorker';

// =============================================================================
// Where the service worker is allowed to exist  (issue #359, epic #345)
// =============================================================================
//
// "The service worker is disabled in the test environment so it cannot
// intercept fixtures" is an acceptance criterion, and it is not a nicety: this
// suite's fixtures come from MSW, which works by patching `fetch`. A service
// worker sits in FRONT of that, so one registered here would answer from Cache
// Storage and turn a deterministic suite into one whose result depends on what
// an earlier test happened to cache.
// =============================================================================

describe('shouldRegisterServiceWorker', () => {
  it('is off in the test environment', () => {
    expect(shouldRegisterServiceWorker({ MODE: 'test', PROD: false })).toBe(false);
    // Even an explicit opt-in does not override the test gate: a suite that set
    // the flag for one case would be caching fixtures for every other one.
    expect(
      shouldRegisterServiceWorker({ MODE: 'test', PROD: false, VITE_ENABLE_SW: 'true' }),
    ).toBe(false);
  });

  it('is off in development unless explicitly enabled', () => {
    expect(shouldRegisterServiceWorker({ MODE: 'development', PROD: false })).toBe(false);
    expect(
      shouldRegisterServiceWorker({ MODE: 'development', PROD: false, VITE_ENABLE_SW: 'true' }),
    ).toBe(true);
    // Exactly `'true'` — a truthy-string check would enable it for `'false'`.
    expect(
      shouldRegisterServiceWorker({ MODE: 'development', PROD: false, VITE_ENABLE_SW: 'false' }),
    ).toBe(false);
  });

  it('is on in production', () => {
    expect(shouldRegisterServiceWorker({ MODE: 'production', PROD: true })).toBe(true);
  });

  it('reads the real environment as off, because this IS the test environment', () => {
    // Not a restatement of the first case: this one calls the function with no
    // argument, which is how `main.tsx` calls it.
    expect(shouldRegisterServiceWorker()).toBe(false);
  });
});

describe('registerServiceWorker', () => {
  afterEach(() => resetUpdateStateForTests());

  it('does nothing at all under test, even with a serviceWorker API present', async () => {
    // jsdom ships none, so a stub is the only way to prove the ENV gate — and
    // not merely the capability check — is what stops registration.
    const register = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register, addEventListener: vi.fn(), controller: null },
    });

    await registerServiceWorker();

    expect(register).not.toHaveBeenCalled();
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });
});

describe('the update publisher', () => {
  afterEach(() => resetUpdateStateForTests());

  it('latches, so a late subscriber still learns about a waiting worker', () => {
    const applyUpdate = vi.fn();
    notifyUpdateReady(applyUpdate);

    const listener = vi.fn();
    onUpdateReady(listener);

    expect(listener).toHaveBeenCalledWith(applyUpdate);
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = onUpdateReady(listener);
    unsubscribe();

    notifyUpdateReady(vi.fn());

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('the development placeholder worker', () => {
  it('uninstalls itself and drops every cache', () => {
    // A no-op would not be enough. Anyone who once ran with `VITE_ENABLE_SW`
    // keeps that worker until something replaces it, and a stale worker in
    // front of a dev server is edits that do not appear.
    expect(SELF_DESTROYING_SERVICE_WORKER).toContain('self.registration.unregister()');
    expect(SELF_DESTROYING_SERVICE_WORKER).toContain('caches.delete');
    expect(SELF_DESTROYING_SERVICE_WORKER).toContain('self.skipWaiting()');
  });
});

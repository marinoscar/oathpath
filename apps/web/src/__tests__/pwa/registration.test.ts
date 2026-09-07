import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  shouldRegisterServiceWorker,
  registerServiceWorker,
  notifyUpdateReady,
  onUpdateReady,
  resetUpdateStateForTests,
} from '../../sw/registerServiceWorker';

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
    // `MODE === 'test'` is checked first and nothing overrides it — see this
    // file's own header on why that ordering is the point.
    expect(shouldRegisterServiceWorker({ MODE: 'test', PROD: false })).toBe(false);
  });

  it('is on in development — there is no opt-in left to gate it (issue #397)', () => {
    expect(shouldRegisterServiceWorker({ MODE: 'development', PROD: false })).toBe(true);
  });

  it('is on in production', () => {
    expect(shouldRegisterServiceWorker({ MODE: 'production', PROD: true })).toBe(true);
  });

  it('registers with no VITE_ENABLE_SW property present at all', () => {
    // Pins the removal of the flag with an assertion rather than leaving it to
    // be true only by the absence of a property nobody checks.
    const env: { MODE?: string; PROD?: boolean } = { MODE: 'development', PROD: false };
    expect('VITE_ENABLE_SW' in env).toBe(false);
    expect(shouldRegisterServiceWorker(env)).toBe(true);
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

/**
 * `useWakeLock` — held while it is wanted, gone the moment it is not, and
 * never a failure anybody has to look at.
 *
 * Issue #310, epic #304 / E13. Three claims, each of which fails silently:
 *
 *   1. THE LOCK MATCHES THE FLAG. Held while conversation mode runs; released
 *      on exit AND on unmount. A lock still held after the session is a flat
 *      battery, and a battery drain is not something review notices.
 *   2. IT COMES BACK AFTER A TAB SWITCH. The browser drops the sentinel every
 *      time the document is hidden — an app switch, an incoming call, a
 *      notification. Without the re-request the learner returns to a session
 *      that is quietly thirty seconds from going dark again.
 *   3. UNAVAILABLE IS A NON-EVENT. A browser without the API (Firefox, older
 *      Safari) and a rejected request (battery saver, policy, hidden tab) both
 *      leave the caller working, throw nothing, and show nothing. The wake
 *      lock is an optimisation on a session that works without it.
 *
 * Issue #388 adds two STRUCTURAL claims, both read from the source tree,
 * because neither can be observed from this hook's own behaviour:
 *
 *   4. THERE IS EXACTLY ONE OWNER. One `useWakeLock` call in the whole
 *      application, in `PracticeSessionPage`, gated on "a voice session is
 *      under way" for BOTH transports. The bug this closes is the shipped one
 *      — the call used to live inside `useConversationSession`, gated on that
 *      driver's phase, so the realtime transport never took a lock at all —
 *      and the bug it prevents is the one a fix could easily introduce: a
 *      second call site means two sentinels whose held spans overlap across a
 *      mid-session fallback, and the loser is released by nobody.
 *   5. THE `<video>` FALLBACK IS ABSENT ON PURPOSE. `useWakeLock.ts`'s header
 *      records the five reasons; this file pins the decision so that adding
 *      one is a deliberate edit to both, never a drive-by.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StrictMode, createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWakeLock } from '../../hooks/useWakeLock';

// ---------------------------------------------------------------------------
// `navigator.wakeLock`, faked — including the part real browsers do that is
// easy to forget: the sentinel is released BY THE BROWSER on hide, and says so
// through its own 'release' event.
// ---------------------------------------------------------------------------

class FakeSentinel {
  released = false;
  private listeners: Array<() => void> = [];

  release = vi.fn(() => {
    if (!this.released) {
      this.released = true;
      this.emitRelease();
    }
    return Promise.resolve();
  });

  addEventListener = vi.fn((type: string, listener: () => void) => {
    if (type === 'release') this.listeners.push(listener);
  });

  removeEventListener = vi.fn();

  /** What a browser does when the tab is hidden: drop the lock, then tell us. */
  emitRelease(): void {
    this.released = true;
    this.listeners.forEach((listener) => listener());
  }
}

interface FakeWakeLock {
  request: ReturnType<typeof vi.fn>;
  sentinels: FakeSentinel[];
}

function installWakeLock(
  behaviour: 'grant' | 'reject' | 'pending' = 'grant',
): FakeWakeLock {
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn(() => {
    if (behaviour === 'reject') {
      return Promise.reject(new DOMException('denied', 'NotAllowedError'));
    }
    if (behaviour === 'pending') return new Promise<FakeSentinel>(() => {});
    const sentinel = new FakeSentinel();
    sentinels.push(sentinel);
    return Promise.resolve(sentinel);
  });

  Object.defineProperty(navigator, 'wakeLock', {
    value: { request },
    configurable: true,
    writable: true,
  });

  return { request, sentinels };
}

function removeWakeLock(): void {
  Reflect.deleteProperty(navigator, 'wakeLock');
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  });
}

/** Hide and re-show the tab, exactly as an app switch does. */
function hideThenShow(): void {
  setVisibility('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  setVisibility('visible');
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Let the `request()` promise and its continuation settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  setVisibility('visible');
});

afterEach(() => {
  removeWakeLock();
  vi.restoreAllMocks();
});

describe('useWakeLock — the lock matches the flag', () => {
  it('acquires a screen lock when it is wanted', async () => {
    const wakeLock = installWakeLock();

    const { result } = renderHook(() => useWakeLock(true));
    await settle();

    expect(wakeLock.request).toHaveBeenCalledTimes(1);
    expect(wakeLock.request).toHaveBeenCalledWith('screen');
    expect(result.current.isSupported).toBe(true);
    expect(result.current.isHeld).toBe(true);
  });

  it('requests nothing while it is not wanted', async () => {
    const wakeLock = installWakeLock();

    const { result } = renderHook(() => useWakeLock(false));
    await settle();

    expect(wakeLock.request).not.toHaveBeenCalled();
    expect(result.current.isHeld).toBe(false);
  });

  it('releases when conversation mode ends', async () => {
    const wakeLock = installWakeLock();

    const { result, rerender } = renderHook(
      ({ enabled }) => useWakeLock(enabled),
      { initialProps: { enabled: true } },
    );
    await settle();

    rerender({ enabled: false });
    await settle();

    expect(wakeLock.sentinels[0].release).toHaveBeenCalled();
    expect(result.current.isHeld).toBe(false);
  });

  it('releases on unmount', async () => {
    const wakeLock = installWakeLock();

    const { unmount } = renderHook(() => useWakeLock(true));
    await settle();

    unmount();

    expect(wakeLock.sentinels[0].release).toHaveBeenCalled();
  });

  it('holds one lock, not one per render', async () => {
    const wakeLock = installWakeLock();

    const { rerender } = renderHook(() => useWakeLock(true));
    await settle();
    rerender();
    rerender();
    await settle();

    expect(wakeLock.request).toHaveBeenCalledTimes(1);
  });

  it('holds exactly one lock under StrictMode', async () => {
    // `main.tsx` renders the app inside `React.StrictMode`, where effect,
    // cleanup, effect is the ordinary development path — and two sentinels
    // granted with one ref to hold them means one held for the life of the
    // page that nothing can release. The overlap case below is what pins that
    // race down deterministically; this one checks the wrapper the app
    // actually renders under does not break the hook.
    const wakeLock = installWakeLock();

    const { result } = renderHook(() => useWakeLock(true), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(StrictMode, null, children),
    });
    await settle();

    expect(result.current.isHeld).toBe(true);
    const stillHeld = wakeLock.sentinels.filter(
      (sentinel) => !sentinel.released,
    );
    expect(stillHeld).toHaveLength(1);
  });

  it('orphans nothing when a second request overlaps the first', async () => {
    const wakeLock = installWakeLock();

    const { rerender } = renderHook(({ enabled }) => useWakeLock(enabled), {
      initialProps: { enabled: true },
    });
    // Off and on again before the first request can settle.
    rerender({ enabled: false });
    rerender({ enabled: true });
    await settle();

    const stillHeld = wakeLock.sentinels.filter(
      (sentinel) => !sentinel.released,
    );
    expect(stillHeld).toHaveLength(1);
  });

  it('releases a sentinel that arrives after the session already ended', async () => {
    // The request is a promise: a learner can leave conversation mode while
    // one is in flight, and the lock that lands afterwards belongs to nobody.
    let grant: ((sentinel: FakeSentinel) => void) | undefined;
    const sentinel = new FakeSentinel();
    const request = vi.fn(
      () =>
        new Promise<FakeSentinel>((resolve) => {
          grant = resolve;
        }),
    );
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request },
      configurable: true,
      writable: true,
    });

    const { unmount } = renderHook(() => useWakeLock(true));
    unmount();

    await act(async () => {
      grant?.(sentinel);
      await Promise.resolve();
    });

    expect(sentinel.release).toHaveBeenCalled();
  });
});

describe('useWakeLock — it comes back after a tab switch', () => {
  it('re-acquires when the document becomes visible again', async () => {
    const wakeLock = installWakeLock();

    renderHook(() => useWakeLock(true));
    await settle();
    expect(wakeLock.request).toHaveBeenCalledTimes(1);

    // A real browser drops the sentinel on the way out.
    act(() => {
      wakeLock.sentinels[0].emitRelease();
    });

    await act(async () => {
      hideThenShow();
      await Promise.resolve();
    });

    expect(wakeLock.request).toHaveBeenCalledTimes(2);
    expect(wakeLock.sentinels).toHaveLength(2);
  });

  it('reports the lock as lost the moment the browser takes it', async () => {
    const wakeLock = installWakeLock();

    const { result } = renderHook(() => useWakeLock(true));
    await settle();
    expect(result.current.isHeld).toBe(true);

    act(() => {
      wakeLock.sentinels[0].emitRelease();
    });

    expect(result.current.isHeld).toBe(false);
  });

  it('does not request while the document is hidden', async () => {
    const wakeLock = installWakeLock();
    setVisibility('hidden');

    renderHook(() => useWakeLock(true));
    await settle();

    // Rejected by definition while hidden; asking anyway only litters the
    // console on every tab switch.
    expect(wakeLock.request).not.toHaveBeenCalled();

    await act(async () => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(wakeLock.request).toHaveBeenCalledTimes(1);
  });

  it('stops listening once the lock is no longer wanted', async () => {
    const wakeLock = installWakeLock();

    const { rerender } = renderHook(({ enabled }) => useWakeLock(enabled), {
      initialProps: { enabled: true },
    });
    await settle();

    rerender({ enabled: false });
    await settle();
    const callsAfterDisable = wakeLock.request.mock.calls.length;

    await act(async () => {
      hideThenShow();
      await Promise.resolve();
    });

    expect(wakeLock.request).toHaveBeenCalledTimes(callsAfterDisable);
  });
});

describe('useWakeLock — unavailable is a non-event', () => {
  it('survives a browser with no wake lock API at all', async () => {
    removeWakeLock();

    const { result, unmount } = renderHook(() => useWakeLock(true));
    await settle();

    expect(result.current.isSupported).toBe(false);
    expect(result.current.isHeld).toBe(false);
    expect(() => unmount()).not.toThrow();
  });

  it('survives an API object that is present but useless', async () => {
    Object.defineProperty(navigator, 'wakeLock', {
      value: {},
      configurable: true,
      writable: true,
    });

    const { result } = renderHook(() => useWakeLock(true));
    await settle();

    expect(result.current.isSupported).toBe(false);
    expect(result.current.isHeld).toBe(false);
  });

  it('survives a rejected request, reporting no error and holding nothing', async () => {
    const wakeLock = installWakeLock('reject');

    const { result, unmount } = renderHook(() => useWakeLock(true));
    await settle();

    expect(wakeLock.request).toHaveBeenCalled();
    expect(result.current.isSupported).toBe(true);
    expect(result.current.isHeld).toBe(false);
    expect(() => unmount()).not.toThrow();
  });

  it('survives unmounting while a request is still in flight', async () => {
    installWakeLock('pending');

    const { result, unmount } = renderHook(() => useWakeLock(true));

    expect(result.current.isHeld).toBe(false);
    expect(() => unmount()).not.toThrow();
  });

  it('survives a sentinel whose release rejects', async () => {
    const sentinel = new FakeSentinel();
    sentinel.release = vi.fn(() => Promise.reject(new Error('already gone')));
    const request = vi.fn(() => Promise.resolve(sentinel));
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request },
      configurable: true,
      writable: true,
    });

    const { unmount } = renderHook(() => useWakeLock(true));
    await settle();

    expect(() => unmount()).not.toThrow();
    await settle();
  });
});

// ---------------------------------------------------------------------------
// 4 and 5: the two claims about the SOURCE, which no behavioural test can make
// ---------------------------------------------------------------------------

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Every `.ts`/`.tsx` under `src/`, tests excluded — the shipped application. */
function shippedSources(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__' || entry === '__mocks__') continue;
        walk(full);
        continue;
      }
      if (/\.tsx?$/.test(entry)) found.push(full);
    }
  };
  walk(SRC);
  return found;
}

/** One file's source with every comment stripped. Code only. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('exactly one owner holds the screen (#388)', () => {
  it('is called from one file, and that file is the practice session page', () => {
    const callers = shippedSources()
      .filter((file) => !file.endsWith(join('hooks', 'useWakeLock.ts')))
      .filter((file) => /\buseWakeLock\s*\(/.test(codeOf(file)))
      .map((file) => relative(SRC, file));

    // A SECOND ENTRY HERE IS THE BUG, not a style note. Two hooks each
    // requesting a lock is two sentinels: across a mid-session fallback from
    // the realtime transport to E13's loop their held spans overlap, and the
    // one that loses `sentinelRef` is held until the tab closes. The
    // single-lock guarantee is this list having one element.
    expect(callers).toEqual([join('pages', 'PracticeSessionPage.tsx')]);
  });

  it('is not called by either voice driver — the screen is the session’s', () => {
    // The shipped regression, pinned by name. `useConversationSession` held
    // the only lock in the application and gated it on ITS OWN phase, so a
    // realtime session — where that hook is mounted and never runs — went
    // unprotected on a metered connection.
    for (const driver of ['useConversationSession.ts', 'useRealtimePractice.ts']) {
      const code = codeOf(join(SRC, 'hooks', driver));
      expect(code).not.toMatch(/useWakeLock/);
      expect(code).not.toMatch(/navigator\.wakeLock/);
    }
  });
});

describe('the `<video>` fallback is rejected, not forgotten (#388)', () => {
  it('ships no video element, and no other media-element workaround', () => {
    const code = codeOf(join(SRC, 'hooks', 'useWakeLock.ts'));

    // The NoSleep.js trick — a muted, looping, `playsinline` one-frame video
    // played for the life of the session — is deliberately not here. The five
    // reasons are in the hook's own header; the load-bearing one is that it
    // would replace an honest warning with an unverifiable promise, on the
    // very transport whose audio graph it could disturb.
    for (const forbidden of [
      /createElement\(\s*['"]video['"]/,
      /<video/i,
      /playsinline/i,
      /HTMLVideoElement/,
      /\bnosleep\b/i,
    ]) {
      expect(code).not.toMatch(forbidden);
    }
  });

  it('says why, in the file itself, so the decision outlives this test', () => {
    // The header is where a future reader looks. A rejection with no recorded
    // reason is indistinguishable from an oversight, and this module's whole
    // posture is being honest about the case it cannot save.
    const header = readFileSync(join(SRC, 'hooks', 'useWakeLock.ts'), 'utf8');
    expect(header).toMatch(/`<video>` FALLBACK IS REJECTED/);
  });

  it('leaves the honest warning as the only degradation, and reports it', async () => {
    // No API at all: the hook reports `isSupported: false` and holds nothing —
    // which is exactly the state `PracticeSessionPage` renders its "keep the
    // page open" footnote from. Nothing is played, nothing is appended.
    const before = document.querySelectorAll('video').length;

    const { result } = renderHook(() => useWakeLock(true));
    await settle();

    expect(result.current.isSupported).toBe(false);
    expect(result.current.isHeld).toBe(false);
    expect(document.querySelectorAll('video')).toHaveLength(before);
  });
});

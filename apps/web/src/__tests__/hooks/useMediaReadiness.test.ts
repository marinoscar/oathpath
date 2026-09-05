/**
 * `useMediaReadiness` — the preflight, and the four ways it could quietly
 * become a liability.
 *
 * Issue #349, epic #345. Every claim below exists because getting it wrong
 * produces something WORSE than the silence this hook replaces:
 *
 *  1. **THE COPY IS `useAudioCapture`'s, VERBATIM.** A preflight that wrote its
 *     own "microphone unavailable" sentence would undo the seven-remedies
 *     argument at the one moment it matters most — earlier, where the learner
 *     still has a free hand. Asserted against the real exported table, not
 *     against string literals copied into this file, because a copy here would
 *     pass forever after the real copy changed.
 *  2. **AN UNKNOWN IS NEVER A REFUSAL.** A browser with no Permissions API
 *     (Safari; jsdom; anything embedded) must not be told its microphone is
 *     blocked. That message is confident, specific, wrong, and sends the
 *     learner to a setting that is not set.
 *  3. **IT NEVER PROMPTS.** `getUserMedia` must not be reachable from merely
 *     rendering a screen. A prompt spent on a page nobody asked a question of
 *     is a one-shot resource spent, and only the learner can undo a denial.
 *  4. **IT UPDATES WITHOUT A RELOAD.** A learner who follows the remedy in
 *     another tab and comes back must not still be reading the blocked message,
 *     or they will reasonably conclude the product is broken.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { describeCaptureProblem } from '../../hooks/useAudioCapture';
import { useMediaReadiness } from '../../hooks/useMediaReadiness';
import { closeSharedAudioContext, getSharedAudioContext } from '../../lib/earcons';

// ---------------------------------------------------------------------------
// The platform, faked at the three seams the hook actually touches — and at no
// others. `getUserMedia` is installed as a spy in every case so that "it was
// never called" is a claim this file can make about EVERY test, not only one.
// ---------------------------------------------------------------------------

let getUserMedia: ReturnType<typeof vi.fn>;

/** A `PermissionStatus` whose `state` is live and whose `change` really fires. */
function makePermissionStatus(initial: PermissionState) {
  const listeners = new Set<() => void>();
  const status = {
    state: initial,
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'change') listeners.delete(listener);
    },
  };
  return {
    status: status as unknown as PermissionStatus,
    /** What another tab granting the permission looks like from this one. */
    change(next: PermissionState) {
      status.state = next;
      listeners.forEach((listener) => listener());
    },
  };
}

interface Platform {
  /** `undefined` installs no `permissions` object at all — the Safari case. */
  permission?: PermissionState;
  /** Make `permissions.query` reject, as an unsupported NAME does. */
  permissionRejects?: boolean;
  /** Make `permissions.query` throw synchronously, as older WebKit does. */
  permissionThrows?: boolean;
  /** `null` installs no `enumerateDevices` at all. */
  devices?: MediaDeviceInfo[] | null;
  enumerateThrows?: boolean;
}

function installPlatform(platform: Platform = {}) {
  getUserMedia = vi.fn();

  const mediaDevices: Record<string, unknown> = {
    getUserMedia,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  if (platform.devices !== null) {
    mediaDevices.enumerateDevices = vi.fn(async () => {
      if (platform.enumerateThrows) throw new Error('nope');
      return (
        platform.devices ?? [{ kind: 'audioinput', deviceId: '', label: '' }]
      );
    });
  }

  Object.defineProperty(navigator, 'mediaDevices', {
    value: mediaDevices,
    configurable: true,
  });

  // A `MediaRecorder` has to exist or `preflightCaptureProblem` answers
  // `unsupported` before any of the interesting cases can be reached — the
  // same reason `PracticeSessionPage.conversation.test.tsx` installs one.
  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = class {};

  let handle: ReturnType<typeof makePermissionStatus> | null = null;
  if (platform.permission !== undefined || platform.permissionRejects || platform.permissionThrows) {
    handle = platform.permission ? makePermissionStatus(platform.permission) : null;
    Object.defineProperty(navigator, 'permissions', {
      value: {
        query: vi.fn(() => {
          if (platform.permissionThrows) throw new TypeError('unsupported name');
          if (platform.permissionRejects) return Promise.reject(new Error('nope'));
          return Promise.resolve(handle!.status);
        }),
      },
      configurable: true,
    });
  }

  return handle;
}

beforeEach(() => {
  Object.defineProperty(window, 'isSecureContext', {
    value: true,
    configurable: true,
  });
});

afterEach(() => {
  closeSharedAudioContext();
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(navigator, 'permissions');
  Reflect.deleteProperty(window, 'MediaRecorder');
  Reflect.deleteProperty(window, 'isSecureContext');
  Reflect.deleteProperty(window, 'AudioContext');
  vi.restoreAllMocks();
});

/** Mount and wait for the first asynchronous probe to settle. */
async function mount() {
  const view = renderHook(() => useMediaReadiness());
  await waitFor(() => expect(view.result.current.isChecking).toBe(false));
  return view;
}

// ---------------------------------------------------------------------------
// 1. A blocked microphone, told BEFORE anything starts
// ---------------------------------------------------------------------------

describe('a blocked microphone is reported before a session starts', () => {
  it('reports permission_denied, with the capture hook’s own copy', async () => {
    installPlatform({ permission: 'denied' });

    const view = await mount();

    expect(view.result.current.permission).toBe('denied');
    // THE WHOLE POINT: identical to what `fail('permission_denied')` would put
    // on screen after the fact. Compared against the real exported builder, so
    // a reworded remedy moves both together or fails here.
    expect(view.result.current.problem).toEqual(
      describeCaptureProblem('permission_denied'),
    );
    // And it says the remedy, not merely that something is wrong.
    expect(view.result.current.problem?.remedy).toMatch(/site permissions/i);
  });

  it('outranks a device list that a denial has emptied', async () => {
    // Several browsers stop reporting devices once a site is blocked. Telling
    // that learner to buy a microphone is the wrong-remedy failure the whole
    // seven-name union exists to prevent.
    installPlatform({ permission: 'denied', devices: [] });

    const view = await mount();

    expect(view.result.current.problem).toEqual(
      describeCaptureProblem('permission_denied'),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. No input device
// ---------------------------------------------------------------------------

describe('no input device is reported before a session starts', () => {
  it('reports no_device when the enumeration found no audioinput', async () => {
    installPlatform({
      permission: 'prompt',
      devices: [{ kind: 'videoinput', deviceId: 'cam', label: '' } as MediaDeviceInfo],
    });

    const view = await mount();

    expect(view.result.current.hasAudioInput).toBe(false);
    expect(view.result.current.problem).toEqual(describeCaptureProblem('no_device'));
  });

  it('reports nothing when an input is present but unnamed', async () => {
    // Labels are empty until permission is granted. PRESENCE, not naming —
    // a hook that needed a label would report every fresh install as deviceless.
    installPlatform({
      permission: 'prompt',
      devices: [{ kind: 'audioinput', deviceId: '', label: '' } as MediaDeviceInfo],
    });

    const view = await mount();

    expect(view.result.current.hasAudioInput).toBe(true);
    expect(view.result.current.problem).toBeNull();
  });

  it('never accuses a browser whose enumeration threw', async () => {
    installPlatform({ permission: 'prompt', enumerateThrows: true });

    const view = await mount();

    // `null`, not `false`. An enumeration that failed tells us nothing about
    // the learner's hardware, and must not be reported as missing hardware.
    expect(view.result.current.hasAudioInput).toBeNull();
    expect(view.result.current.problem).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Unknown is not denied
// ---------------------------------------------------------------------------

describe('a browser without the Permissions API degrades to unknown', () => {
  it('reports unknown — never denied — and lets the flow proceed', async () => {
    // No `navigator.permissions` at all: Safari, jsdom, embedded browsers.
    installPlatform({});

    const view = await mount();

    expect(view.result.current.permission).toBe('unknown');
    expect(view.result.current.problem).toBeNull();
    // The synchronous pre-Start check agrees: an unknown never blocks a start.
    let blocked: unknown = 'unset';
    act(() => {
      blocked = view.result.current.recheck();
    });
    expect(blocked).toBeNull();
  });

  it('degrades to unknown when query REJECTS (an unsupported name)', async () => {
    installPlatform({ permissionRejects: true });

    const view = await mount();

    expect(view.result.current.permission).toBe('unknown');
    expect(view.result.current.problem).toBeNull();
  });

  it('degrades to unknown when query THROWS synchronously (older WebKit)', async () => {
    installPlatform({ permissionThrows: true });

    const view = await mount();

    expect(view.result.current.permission).toBe('unknown');
    expect(view.result.current.problem).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. It updates without a reload
// ---------------------------------------------------------------------------

describe('a permission changed in another tab reaches this one', () => {
  it('follows PermissionStatus.onchange, with no reload and no re-mount', async () => {
    const handle = installPlatform({ permission: 'denied' });

    const view = await mount();
    expect(view.result.current.problem).toEqual(
      describeCaptureProblem('permission_denied'),
    );

    // The learner opens site settings in another tab and allows it.
    act(() => handle!.change('granted'));

    await waitFor(() => {
      expect(view.result.current.permission).toBe('granted');
    });
    expect(view.result.current.problem).toBeNull();
  });

  it('sees a revocation on the synchronous pre-Start re-check', async () => {
    // The second of the two moments #349 names: permission can be revoked
    // between the picker and the Start tap, and `recheck()` reads the live
    // `PermissionStatus.state` rather than replaying what was rendered.
    const handle = installPlatform({ permission: 'granted' });

    const view = await mount();
    expect(view.result.current.problem).toBeNull();

    // Revoked WITHOUT firing `change` — the case a listener alone would miss.
    (handle!.status as unknown as { state: PermissionState }).state = 'denied';

    let blocked: unknown = null;
    act(() => {
      blocked = view.result.current.recheck();
    });
    expect(blocked).toEqual(describeCaptureProblem('permission_denied'));
  });
});

// ---------------------------------------------------------------------------
// 5. It never prompts
// ---------------------------------------------------------------------------

describe('the preflight never prompts', () => {
  it('does not call getUserMedia — not on mount, not on a re-check', async () => {
    installPlatform({ permission: 'prompt' });

    const view = await mount();
    act(() => {
      view.result.current.recheck();
    });
    await waitFor(() => expect(view.result.current.isChecking).toBe(false));

    // The single most important assertion in this file. See the header, and
    // `useBrowserNotificationPermission`'s, whose rule this reuses.
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. A suspended AudioContext is reported, not silently mute
// ---------------------------------------------------------------------------

describe('the shared AudioContext', () => {
  /** A context that stays `suspended` however often it is asked to resume. */
  function installSuspendedContext() {
    class StuckContext {
      state: AudioContextState = 'suspended';
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = StuckContext;
    // Built through the module's own door, so what the hook peeks at is the
    // real shared context rather than a fixture only this test can see.
    getSharedAudioContext();
  }

  it('reports a suspended context rather than letting every earcon be a no-op', async () => {
    installPlatform({ permission: 'granted' });
    installSuspendedContext();

    const view = await mount();

    expect(view.result.current.audioOutputState).toBe('suspended');
    expect(view.result.current.isAudioOutputSuspended).toBe(true);
    // A SEPARATE FACT from a capture problem: nothing about the microphone is
    // wrong, so it must not be reported as one of the seven named failures.
    expect(view.result.current.problem).toBeNull();
  });

  it('does not CREATE a context just by looking — a silent page is not a broken one', async () => {
    installPlatform({ permission: 'granted' });
    class NeverBuilt {
      constructor() {
        throw new Error('the preflight created an AudioContext');
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = NeverBuilt;

    const view = await mount();

    expect(view.result.current.audioOutputState).toBe('none');
    expect(view.result.current.isAudioOutputSuspended).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. The platform facts, reused rather than re-derived
// ---------------------------------------------------------------------------

describe('the platform checks are the capture hook’s own', () => {
  it('reports insecure_origin BEFORE unsupported', async () => {
    // An insecure origin DELETES `navigator.mediaDevices`, so a preflight that
    // checked support first would tell a perfectly capable browser to install a
    // different one. `preflightCaptureProblem`'s ordering, reused not copied.
    installPlatform({ permission: 'granted' });
    Object.defineProperty(window, 'isSecureContext', {
      value: false,
      configurable: true,
    });
    Reflect.deleteProperty(navigator, 'mediaDevices');

    const view = await mount();

    expect(view.result.current.problem).toEqual(
      describeCaptureProblem('insecure_origin'),
    );
  });

  it('reports unsupported where there is no MediaRecorder', async () => {
    installPlatform({ permission: 'granted' });
    Reflect.deleteProperty(window, 'MediaRecorder');

    const view = await mount();

    expect(view.result.current.problem).toEqual(describeCaptureProblem('unsupported'));
  });

  it('introduces no eighth message: every problem it can report is one of the seven', async () => {
    // Each of the three states this hook can reach, checked against the real
    // exported table rather than against literals copied into this file — a
    // copy here would keep passing after the copy over there changed, which is
    // the exact way "verbatim" quietly stops being true.
    const cases: Array<[Platform, 'permission_denied' | 'no_device']> = [
      [{ permission: 'denied' }, 'permission_denied'],
      [
        {
          permission: 'prompt',
          devices: [{ kind: 'videoinput', deviceId: 'c', label: '' } as MediaDeviceInfo],
        },
        'no_device',
      ],
    ];

    for (const [platform, code] of cases) {
      installPlatform(platform);
      const view = await mount();
      const problem = view.result.current.problem!;
      expect(problem).toEqual(describeCaptureProblem(code));
      // No preflight-specific wording anywhere in it.
      expect(problem.message).toBe(describeCaptureProblem(code).message);
      expect(problem.remedy).toBe(describeCaptureProblem(code).remedy);
      expect(problem.message).not.toMatch(/unavailable/i);
      view.unmount();
    }
  });
});

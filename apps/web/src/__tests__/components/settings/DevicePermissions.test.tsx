/**
 * `/settings/device` — the four promises this screen makes that are invisible
 * when broken.
 *
 * Issue #384. Each of these fails quietly, and each failure is expensive in a
 * way a reviewer cannot see by reading the JSX:
 *
 *   1. **NOTHING PROMPTS ON MOUNT.** This is the point of the feature, not a
 *      detail of it. A permission prompt fired by merely rendering a screen is
 *      frequently auto-blocked before a human sees it (Chrome's quieter UI,
 *      Firefox's gesture requirement, Safari's since 16.4), and a denial is
 *      effectively permanent — this application cannot re-prompt and cannot
 *      undo it. A regression here spends a one-shot resource on somebody who
 *      was never asked, and there is no screen afterwards that can recover it.
 *   2. **EVERY STATE HAS ITS OWN COPY AND ITS OWN REMEDY.** Collapsing "your
 *      browser is blocking this", "there is no microphone attached" and "this
 *      browser cannot record" into one sentence sends a learner whose headset
 *      is unplugged off to change a permission that was never the problem.
 *   3. **A BLOCKED STATE OFFERS NO BUTTON.** A control that can only fail is
 *      worse than no control: it reads as the product being broken on top of
 *      the permission being off.
 *   4. **THE REQUESTS GO THROUGH THE EXISTING DOORS.** One `getUserMedia`
 *      call, whose tracks are released immediately, and the SHARED
 *      `requestBrowserNotificationPermission` rather than a second
 *      `Notification.requestPermission()` call site.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import {
  DevicePermissions,
  MICROPHONE_GRANTED_MESSAGE,
  TEST_TONE_PLAYED_MESSAGE,
  TEST_TONE_UNAVAILABLE_MESSAGE,
  microphoneRowCopy,
  notificationRowCopy,
} from '../../../components/settings/DevicePermissions';
import { describeCaptureProblem } from '../../../hooks/useAudioCapture';
import { closeSharedAudioContext } from '../../../lib/earcons';
import { requestBrowserNotificationPermission } from '../../../services/browserNotifications';

// The SHARED request function, mocked as a module so "this component calls
// that door and not the native API" is a claim about the real import graph
// rather than about a prop somebody could rewire.
vi.mock('../../../services/browserNotifications', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../services/browserNotifications')
  >();
  return { ...actual, requestBrowserNotificationPermission: vi.fn(async () => 'granted') };
});

const requestNotificationsMock = vi.mocked(requestBrowserNotificationPermission);

// ---------------------------------------------------------------------------
// The platform, faked at the seams this screen actually touches — and at no
// others. `getUserMedia` and `Notification.requestPermission` are installed as
// spies in EVERY case, so "nothing prompted" is a claim this file can make
// about every test rather than about one.
// ---------------------------------------------------------------------------

let getUserMedia: ReturnType<typeof vi.fn>;
let requestPermissionSpy: ReturnType<typeof vi.fn>;
let stopTrack: ReturnType<typeof vi.fn>;

class FakeAudioParam {
  setValueAtTime = vi.fn(() => this);
  linearRampToValueAtTime = vi.fn(() => this);
}

class FakeOscillator {
  type: OscillatorType = 'sine';
  frequency = new FakeAudioParam();
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  currentTime = 0;
  state: AudioContextState = 'suspended';
  destination = {} as AudioDestinationNode;
  oscillators: FakeOscillator[] = [];

  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.state = 'closed';
    return Promise.resolve();
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createOscillator(): OscillatorNode {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator as unknown as OscillatorNode;
  }

  createGain(): GainNode {
    return {
      gain: new FakeAudioParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as GainNode;
  }
}

interface Platform {
  /** `undefined` installs no `permissions` object at all — the Safari case. */
  microphone?: PermissionState;
  /** `[]` is an enumeration that succeeded and found nothing: `no_device`. */
  devices?: MediaDeviceInfo[];
  /** `false` deletes `MediaRecorder`: `unsupported`. */
  canRecord?: boolean;
  /** `false` is a page served over http: `insecure_origin`. */
  secure?: boolean;
  /** `undefined` deletes `window.Notification`: `unsupported`. */
  notifications?: NotificationPermission | 'absent';
  /** `false` removes Web Audio entirely. */
  webAudio?: boolean;
}

function installPlatform(platform: Platform = {}) {
  const {
    microphone,
    devices = [{ kind: 'audioinput', deviceId: '', label: '' } as MediaDeviceInfo],
    canRecord = true,
    secure = true,
    notifications = 'default',
    webAudio = true,
  } = platform;

  Object.defineProperty(window, 'isSecureContext', {
    value: secure,
    configurable: true,
  });

  stopTrack = vi.fn();
  getUserMedia = vi.fn(async () => ({
    getTracks: () => [{ stop: stopTrack }],
  }));

  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => devices),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    configurable: true,
  });

  if (canRecord) {
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = class {};
  } else {
    Reflect.deleteProperty(window, 'MediaRecorder');
  }

  // `query` answers PER NAME. Both hooks on this screen call it, and a stub
  // that handed the microphone's status to the notifications hook would be
  // testing a browser that does not exist.
  Object.defineProperty(navigator, 'permissions', {
    value: {
      query: vi.fn(({ name }: { name: string }) => {
        if (name === 'microphone' && microphone) {
          return Promise.resolve({
            state: microphone,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          } as unknown as PermissionStatus);
        }
        // An unsupported NAME rejects rather than resolving — the Safari
        // behaviour both hooks explicitly fall back from.
        return Promise.reject(new Error('unsupported name'));
      }),
    },
    configurable: true,
  });

  requestPermissionSpy = vi.fn(async () => 'granted' as NotificationPermission);
  if (notifications === 'absent') {
    Reflect.deleteProperty(window, 'Notification');
  } else {
    Object.defineProperty(window, 'Notification', {
      value: { permission: notifications, requestPermission: requestPermissionSpy },
      configurable: true,
      writable: true,
    });
  }

  if (webAudio) {
    Object.defineProperty(window, 'AudioContext', {
      value: FakeAudioContext,
      configurable: true,
      writable: true,
    });
  } else {
    Reflect.deleteProperty(window, 'AudioContext');
    Reflect.deleteProperty(window, 'webkitAudioContext');
  }
}

/**
 * Assert a sentence is on screen at least once.
 *
 * `findAllByText` rather than `findByText` because a row's current state is
 * DELIBERATELY rendered twice — once in the visible alert, once in the always
 * mounted `role="status"` region a screen reader reads. That duplication is
 * the accessibility requirement, not an accident, so the query has to allow
 * for it rather than the component avoiding it.
 */
async function expectSaid(text: string) {
  const matches = await screen.findAllByText(text);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0];
}

/** Render, and wait for the readiness hook's first asynchronous probe. */
async function mount(platform: Platform = {}) {
  installPlatform(platform);
  const view = render(<DevicePermissions />);
  await waitFor(() =>
    expect(
      (navigator.permissions as Permissions).query as unknown as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalled(),
  );
  return view;
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  closeSharedAudioContext();
  requestNotificationsMock.mockClear();
});

afterEach(() => {
  closeSharedAudioContext();
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(navigator, 'permissions');
  Reflect.deleteProperty(window, 'MediaRecorder');
  Reflect.deleteProperty(window, 'isSecureContext');
  Reflect.deleteProperty(window, 'Notification');
  Reflect.deleteProperty(window, 'AudioContext');
  Reflect.deleteProperty(window, 'webkitAudioContext');
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. The load-bearing invariant
// ===========================================================================

describe('mounting the screen prompts for nothing', () => {
  it('calls no getUserMedia, no Notification.requestPermission, and builds no AudioContext', async () => {
    await mount({ microphone: 'prompt' });

    // The three buttons are all on screen, so this is not vacuously true
    // because the page failed to render.
    expect(
      screen.getByRole('button', { name: /allow microphone/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /allow notifications/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /play a test tone/i })).toBeInTheDocument();

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(requestPermissionSpy).not.toHaveBeenCalled();
    expect(requestNotificationsMock).not.toHaveBeenCalled();
    // An `AudioContext` constructed on mount would start `suspended` on every
    // mobile browser and stay that way, so a warmed-on-mount context is both a
    // side effect and a permanently silent button.
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('keeps prompting out of the source: getUserMedia appears exactly once, in a click handler', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(__dirname, '../../../components/settings/DevicePermissions.tsx'),
      'utf8',
    );
    // The file's header discusses all three APIs at length, on purpose — so
    // the comments are stripped and only real code is scanned. A test that
    // failed because the invariant was DOCUMENTED would teach exactly the
    // wrong lesson.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const calls = code.match(/getUserMedia\(/g) ?? [];
    expect(calls).toHaveLength(1);

    // And nothing in this file may reach the native permission API directly —
    // `services/browserNotifications.ts` is the one module that touches it.
    expect(code).not.toMatch(/Notification\.requestPermission/);

    // No effect at all: the invariant is that mounting is inert, and the
    // cheapest way to keep it so is to have no mount-time code to audit.
    expect(code).not.toMatch(/useEffect/);
  });
});

// ===========================================================================
// 2. Each state, its own copy and its own remedy
// ===========================================================================

describe('the microphone row', () => {
  it('says the microphone is allowed, and offers no action', async () => {
    await mount({ microphone: 'granted' });

    await expectSaid(microphoneRowCopy('granted').status);
    expect(screen.queryByRole('button', { name: /allow microphone/i })).toBeNull();
  });

  it('renders the capture hook’s own words for a blocked microphone — and no button', async () => {
    await mount({ microphone: 'denied' });

    const blocked = describeCaptureProblem('permission_denied');
    expect(await screen.findByText(blocked.message)).toBeInTheDocument();
    expect(screen.getByText(blocked.remedy)).toBeInTheDocument();

    // PROMISE 3. This application cannot undo a block; only the learner can,
    // from a browser menu — so a button here would produce nothing.
    expect(screen.queryByRole('button', { name: /allow microphone/i })).toBeNull();
  });

  it('distinguishes a browser that cannot record from a permission problem', async () => {
    await mount({ canRecord: false });

    const unsupported = describeCaptureProblem('unsupported');
    expect(await screen.findByText(unsupported.message)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /allow microphone/i })).toBeNull();
  });

  it('distinguishes an insecure origin, whose remedy is the URL and not a setting', async () => {
    await mount({ secure: false });

    const insecure = describeCaptureProblem('insecure_origin');
    expect(await screen.findByText(insecure.message)).toBeInTheDocument();
    expect(screen.getByText(insecure.remedy)).toHaveTextContent(/https/i);
    expect(screen.queryByRole('button', { name: /allow microphone/i })).toBeNull();
  });

  it('distinguishes no microphone attached — never "you blocked it"', async () => {
    await mount({ microphone: 'prompt', devices: [] });

    const missing = describeCaptureProblem('no_device');
    expect(await screen.findByText(missing.message)).toBeInTheDocument();
    expect(screen.queryByText(describeCaptureProblem('permission_denied').message)).toBeNull();
  });

  it('offers the button when the browser has simply not been asked yet', async () => {
    await mount({ microphone: 'prompt' });

    await expectSaid(microphoneRowCopy('prompt').status);
    expect(
      screen.getByRole('button', { name: /allow microphone/i }),
    ).toBeInTheDocument();
  });

  it('says it cannot tell on a browser with no Permissions API, and still offers the button', async () => {
    // No `microphone` state installed at all: `query` rejects, exactly as it
    // does in Safari and under jsdom. An unknown is NOT a denial — rendering
    // it as one would be a confident, specific, wrong instruction.
    await mount({});

    await expectSaid(microphoneRowCopy('unknown').status);
    expect(
      screen.queryAllByText(describeCaptureProblem('permission_denied').message),
    ).toHaveLength(0);
    expect(
      screen.getByRole('button', { name: /allow microphone/i }),
    ).toBeInTheDocument();
  });
});

describe('the notifications row', () => {
  it.each([
    ['granted' as const, 'granted' as NotificationPermission],
    ['denied' as const, 'denied' as NotificationPermission],
    ['default' as const, 'default' as NotificationPermission],
  ])('renders the %s state’s own sentence', async (expected, permission) => {
    await mount({ microphone: 'granted', notifications: permission });

    await expectSaid(notificationRowCopy(expected).status);
  });

  it('says the browser cannot show notifications at all, rather than that they are blocked', async () => {
    await mount({ microphone: 'granted', notifications: 'absent' });

    await expectSaid(notificationRowCopy('unsupported').status);
    expect(screen.queryAllByText(notificationRowCopy('denied').status)).toHaveLength(0);
  });

  it('offers no button in the blocked state, and names who owns the remedy', async () => {
    await mount({ microphone: 'granted', notifications: 'denied' });

    const blocked = notificationRowCopy('denied');
    await expectSaid(blocked.status);
    expect(screen.getByText(blocked.remedy!)).toHaveTextContent(/only you can/i);
    expect(screen.queryByRole('button', { name: /allow notifications/i })).toBeNull();
  });

  it('offers no button once permission has been granted — there is nothing left to ask', async () => {
    await mount({ microphone: 'granted', notifications: 'granted' });

    await expectSaid(notificationRowCopy('granted').status);
    expect(screen.queryByRole('button', { name: /allow notifications/i })).toBeNull();
  });
});

// ===========================================================================
// 3. The requests themselves
// ===========================================================================

describe('Allow microphone', () => {
  it('calls getUserMedia once and releases every track it obtained', async () => {
    const user = userEvent.setup();
    await mount({ microphone: 'prompt' });

    await user.click(await screen.findByRole('button', { name: /allow microphone/i }));

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    // THE PAGE MUST NOT HOLD THE MICROPHONE OPEN. A status screen that keeps
    // the recording indicator lit while it is read is both alarming and enough
    // to make the device unavailable to whatever wants it next.
    await waitFor(() => expect(stopTrack).toHaveBeenCalledTimes(1));

    await expectSaid(MICROPHONE_GRANTED_MESSAGE);
  });

  it('reports a denial in the capture hook’s words, and withdraws the button', async () => {
    const user = userEvent.setup();
    await mount({ microphone: 'prompt' });

    const error = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    getUserMedia.mockRejectedValueOnce(error);

    await user.click(await screen.findByRole('button', { name: /allow microphone/i }));

    const blocked = describeCaptureProblem('permission_denied');
    expect(await screen.findByText(blocked.message)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /allow microphone/i })).toBeNull();
  });

  it('keeps the button after a dismissed prompt — nothing was decided', async () => {
    const user = userEvent.setup();
    await mount({ microphone: 'prompt' });

    // A dismissal is invisible to `permissions.query` and is NOT a denial;
    // `classifyGetUserMediaError` tells the two apart by the message.
    const error = Object.assign(new Error('The request was dismissed.'), {
      name: 'NotAllowedError',
    });
    getUserMedia.mockRejectedValueOnce(error);

    await user.click(await screen.findByRole('button', { name: /allow microphone/i }));

    const dismissed = describeCaptureProblem('permission_dismissed');
    expect(await screen.findByText(dismissed.message)).toBeInTheDocument();
  });
});

describe('Allow notifications', () => {
  it('goes through the shared service, never Notification.requestPermission directly', async () => {
    const user = userEvent.setup();
    await mount({ microphone: 'granted', notifications: 'default' });

    await user.click(
      await screen.findByRole('button', { name: /allow notifications/i }),
    );

    await waitFor(() => expect(requestNotificationsMock).toHaveBeenCalledTimes(1));
    // The shared module is the one place that touches the native API, and it
    // is mocked here — so a component that had reached past it would show up
    // as a direct call on this spy.
    expect(requestPermissionSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. Sound
// ===========================================================================

describe('Play a test tone', () => {
  it('creates and resumes the context inside the click, then reports in text', async () => {
    const user = userEvent.setup();
    await mount({ microphone: 'granted' });

    expect(FakeAudioContext.instances).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /play a test tone/i }));

    expect(FakeAudioContext.instances).toHaveLength(1);
    const context = FakeAudioContext.instances[0];
    // A context built outside a gesture starts suspended and stays that way;
    // resuming from inside the handler is the only moment a browser allows.
    expect(context.resume).toHaveBeenCalled();
    expect(context.oscillators.length).toBeGreaterThan(0);

    // A muted device gives no other feedback at all, so the outcome has to be
    // readable as well as audible.
    await expectSaid(TEST_TONE_PLAYED_MESSAGE);
  });

  it('explains itself instead of offering a dead button when there is no Web Audio', async () => {
    await mount({ microphone: 'granted', webAudio: false });

    expect(screen.getByRole('button', { name: /play a test tone/i })).toBeDisabled();
    expect(screen.getByText(TEST_TONE_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
  });
});

// ===========================================================================
// 5. Accessibility
// ===========================================================================

describe('accessibility', () => {
  it('gives each row an h2 under the page’s own h1, and a live region that is always mounted', async () => {
    await mount({ microphone: 'granted' });

    expect(screen.getByRole('heading', { name: 'Microphone', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Notifications', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sound', level: 2 })).toBeInTheDocument();

    // THREE, present from the first render — one per row. A live region
    // inserted into the DOM at the same moment as its text is frequently not
    // announced at all, which is the one failure mode a status region has.
    const regions = screen.getAllByRole('status');
    expect(regions).toHaveLength(3);
    for (const region of regions) {
      expect(region).toHaveAttribute('aria-live', 'polite');
    }
  });
});

/**
 * Issue #384. `/settings/device` — the screen that exists so a learner meets
 * the microphone, notification and sound questions BEFORE a session does.
 *
 * THE FIRST TEST IS THE POINT OF THE FILE: mounting this page must not prompt
 * for anything. Both permission hooks promise that in their own headers, this
 * page adds the only `getUserMedia` call in the feature, and the guarantee is
 * worth an assertion rather than a comment — a prompt moved into an effect
 * would still render identically, and the cost of the mistake is a permission
 * this application can never ask for again.
 *
 * The two observation hooks are mocked so each state can be rendered directly;
 * their own behaviour (the `unknown`-is-not-`denied` rule, the cross-tab
 * refresh) is covered by `hooks/useMediaReadiness.test.ts` and
 * `hooks/useBrowserNotificationPermission.test.ts`. Everything the page itself
 * owns — the requests, the track teardown, the copy tables — is exercised for
 * real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

vi.mock('../../hooks/useMediaReadiness', () => ({
  useMediaReadiness: vi.fn(),
}));

vi.mock('../../hooks/useBrowserNotificationPermission', () => ({
  useBrowserNotificationPermission: vi.fn(),
}));

vi.mock('../../services/browserNotifications', () => ({
  requestBrowserNotificationPermission: vi.fn(async () => 'granted'),
}));

vi.mock('../../lib/earcons', () => ({
  LISTENING_EARCON: { name: 'listening', wave: 'sine', tones: [] },
  peekSharedAudioContextState: vi.fn(() => 'running'),
  playEarconIgnoringPreference: vi.fn(),
}));

import { useMediaReadiness } from '../../hooks/useMediaReadiness';
import { useBrowserNotificationPermission } from '../../hooks/useBrowserNotificationPermission';
import { requestBrowserNotificationPermission } from '../../services/browserNotifications';
import {
  peekSharedAudioContextState,
  playEarconIgnoringPreference,
} from '../../lib/earcons';
import { describeCaptureProblem } from '../../hooks/useAudioCapture';
import DeviceSettingsPage from '../../pages/DeviceSettingsPage';

const mockUseMediaReadiness = vi.mocked(useMediaReadiness);
const mockUseBrowserNotificationPermission = vi.mocked(
  useBrowserNotificationPermission,
);
const mockRequestNotificationPermission = vi.mocked(
  requestBrowserNotificationPermission,
);
const mockPeekAudioState = vi.mocked(peekSharedAudioContextState);
const mockPlayEarcon = vi.mocked(playEarconIgnoringPreference);

const recheck = vi.fn(() => null);
const refreshNotifications = vi.fn();

/** `useMediaReadiness`'s return, with the one field a case cares about set. */
function readiness(
  overrides: Partial<ReturnType<typeof useMediaReadiness>> = {},
): ReturnType<typeof useMediaReadiness> {
  return {
    permission: 'prompt',
    hasAudioInput: true,
    audioOutputState: 'none',
    isAudioOutputSuspended: false,
    problem: null,
    isChecking: false,
    recheck,
    ...overrides,
  };
}

/** A stopped-track spy per call, so the teardown assertion can see them. */
function installGetUserMedia(impl: () => Promise<MediaStream>) {
  const getUserMedia = vi.fn(impl);
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    configurable: true,
  });
  return getUserMedia;
}

function fakeStream(tracks: { stop: () => void }[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

beforeEach(() => {
  // Without both of these `preflightCaptureProblem` answers `unsupported`
  // before any interesting case is reachable — the same harness
  // `useMediaReadiness.test.ts` installs, for the same reason.
  Object.defineProperty(window, 'isSecureContext', {
    value: true,
    configurable: true,
  });
  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = class {};

  mockUseMediaReadiness.mockReturnValue(readiness());
  mockUseBrowserNotificationPermission.mockReturnValue({
    permission: 'default',
    refresh: refreshNotifications,
  });
  mockPeekAudioState.mockReturnValue('running');
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(window, 'MediaRecorder');
  Reflect.deleteProperty(window, 'isSecureContext');
  vi.clearAllMocks();
});

describe('DeviceSettingsPage - nothing prompts on mount (issue #384)', () => {
  it('renders the three rows without asking the browser for anything', async () => {
    const getUserMedia = installGetUserMedia(async () => fakeStream([]));
    render(<DeviceSettingsPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: /device & permissions/i }),
    ).toBeInTheDocument();
    for (const row of ['Microphone', 'Notifications', 'Sound']) {
      expect(screen.getByRole('heading', { level: 2, name: row })).toBeInTheDocument();
    }

    // The whole reason this screen exists is that the prompt belongs to a
    // deliberate press. A denial cannot be undone by this application.
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(mockRequestNotificationPermission).not.toHaveBeenCalled();
    expect(mockPlayEarcon).not.toHaveBeenCalled();
  });
});

describe('DeviceSettingsPage - microphone row', () => {
  it('requests the microphone on click, stops every track, and re-reads the permission', async () => {
    const stop = vi.fn();
    const getUserMedia = installGetUserMedia(async () =>
      fakeStream([{ stop }, { stop }]),
    );

    render(<DeviceSettingsPage />);
    await userEvent.click(screen.getByRole('button', { name: /allow microphone/i }));

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    // A permission request, not a capture session: leaving the stream open
    // lights the browser's recording indicator on a settings screen.
    expect(stop).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(recheck).toHaveBeenCalled());
    expect(await screen.findByText(/lets OathPath use your microphone/i)).toBeInTheDocument();
  });

  it('renders a rejected request as its named problem, with that problem’s own remedy', async () => {
    installGetUserMedia(async () => {
      const error = new Error('denied');
      error.name = 'NotAllowedError';
      throw error;
    });

    render(<DeviceSettingsPage />);
    await userEvent.click(screen.getByRole('button', { name: /allow microphone/i }));

    // `describeCaptureProblem`'s copy, verbatim - this page invents no second
    // taxonomy and no preflight-specific wording.
    const denied = describeCaptureProblem('permission_denied');
    expect(await screen.findByText(denied.message)).toBeInTheDocument();
    expect(screen.getByText(denied.remedy)).toBeInTheDocument();
  });

  it('offers no button when the browser is already blocking the microphone', () => {
    mockUseMediaReadiness.mockReturnValue(
      readiness({
        permission: 'denied',
        problem: describeCaptureProblem('permission_denied'),
      }),
    );

    render(<DeviceSettingsPage />);

    // After a denial `getUserMedia` rejects without opening a prompt, so a
    // button here would be a control that provably cannot work.
    expect(
      screen.queryByRole('button', { name: /allow microphone/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(describeCaptureProblem('permission_denied').remedy),
    ).toBeInTheDocument();
  });

  it('says a browser that cannot record cannot record, rather than that it is blocked', () => {
    mockUseMediaReadiness.mockReturnValue(
      readiness({ permission: 'unknown', problem: describeCaptureProblem('unsupported') }),
    );

    render(<DeviceSettingsPage />);

    expect(
      screen.getByText(describeCaptureProblem('unsupported').message),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /allow microphone/i }),
    ).not.toBeInTheDocument();
  });

  it('says no microphone was found when there is no audio input', () => {
    mockUseMediaReadiness.mockReturnValue(
      readiness({ permission: 'prompt', hasAudioInput: false, problem: describeCaptureProblem('no_device') }),
    );

    render(<DeviceSettingsPage />);

    expect(
      screen.getByText(describeCaptureProblem('no_device').message),
    ).toBeInTheDocument();
  });

  it('offers the button on an unknown permission, and never calls it blocked', () => {
    mockUseMediaReadiness.mockReturnValue(readiness({ permission: 'unknown' }));

    render(<DeviceSettingsPage />);

    // Safari never answers for `microphone`. Resolving that to "blocked" would
    // be a confident, specific, wrong accusation.
    expect(screen.getByText(/does not report whether the microphone is allowed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /allow microphone/i })).toBeInTheDocument();
  });
});

describe('DeviceSettingsPage - notifications row', () => {
  it('asks through the existing service and refreshes afterwards', async () => {
    installGetUserMedia(async () => fakeStream([]));
    render(<DeviceSettingsPage />);

    await userEvent.click(screen.getByRole('button', { name: /allow notifications/i }));

    await waitFor(() =>
      expect(mockRequestNotificationPermission).toHaveBeenCalledTimes(1),
    );
    // Unconditional, in a `finally`: a dismissed prompt leaves the permission
    // unchanged and the service can resolve `null` on a hostile browser.
    await waitFor(() => expect(refreshNotifications).toHaveBeenCalled());
  });

  it('offers no button when notifications are blocked, and says who can undo it', () => {
    mockUseBrowserNotificationPermission.mockReturnValue({
      permission: 'denied',
      refresh: refreshNotifications,
    });

    render(<DeviceSettingsPage />);

    expect(
      screen.queryByRole('button', { name: /allow notifications/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/OathPath cannot undo that/i)).toBeInTheDocument();
  });

  it('distinguishes an unsupported browser from a blocked one', () => {
    mockUseBrowserNotificationPermission.mockReturnValue({
      permission: 'unsupported',
      refresh: refreshNotifications,
    });

    render(<DeviceSettingsPage />);

    expect(screen.getByText(/cannot show notifications/i)).toBeInTheDocument();
    expect(screen.queryByText(/blocking notifications/i)).not.toBeInTheDocument();
  });

  it('points at /settings/notifications for which events notify, on every state', () => {
    render(<DeviceSettingsPage />);
    expect(screen.getByRole('link', { name: 'Notifications' })).toHaveAttribute(
      'href',
      '/settings/notifications',
    );
  });
});

describe('DeviceSettingsPage - sound row', () => {
  it('plays a real cue on click, ignoring the sound-cues preference', async () => {
    render(<DeviceSettingsPage />);

    await userEvent.click(screen.getByRole('button', { name: /play a test tone/i }));

    // `playEarconIgnoringPreference`, not `playEarcon`: the press IS the
    // request for sound, and a silent button is indistinguishable from the
    // fault the learner came here to diagnose.
    expect(mockPlayEarcon).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/rising chime/i)).toBeInTheDocument();
  });

  it('says so when the browser has this page’s audio suspended', async () => {
    mockPeekAudioState.mockReturnValue('suspended');
    render(<DeviceSettingsPage />);

    await userEvent.click(screen.getByRole('button', { name: /play a test tone/i }));

    expect(await screen.findByText(/paused audio for this page/i)).toBeInTheDocument();
  });

  it('says the cues cannot sound at all where there is no audio context', async () => {
    mockPeekAudioState.mockReturnValue('none');
    render(<DeviceSettingsPage />);

    await userEvent.click(screen.getByRole('button', { name: /play a test tone/i }));

    expect(
      await screen.findByText(/will not give the page an audio channel/i),
    ).toBeInTheDocument();
  });
});

describe('DeviceSettingsPage - accessibility', () => {
  it('mounts one live region per row, before there is anything to announce', () => {
    render(<DeviceSettingsPage />);

    // Always mounted, never inserted along with its text: a region that
    // appears at the same moment as its content is frequently never announced.
    const regions = screen.getAllByRole('status');
    expect(regions).toHaveLength(3);
    for (const region of regions) {
      expect(region).toHaveAttribute('aria-live', 'polite');
      // No control inside: everything in a live region is re-read whenever any
      // of it changes, and a permission can change from another tab.
      expect(region.querySelector('button')).toBeNull();
      expect(region.querySelector('a')).toBeNull();
    }
  });
});

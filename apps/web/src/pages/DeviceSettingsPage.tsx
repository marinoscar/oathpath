/**
 * Settings → Device & permissions (`/settings/device`).
 *
 * Issue #384. The one place a learner can grant the microphone, grant browser
 * notifications, and confirm this device makes a sound — BEFORE any of it is
 * needed in the middle of something else.
 *
 * =============================================================================
 * WHY A SCREEN AT ALL, WHEN EVERY PROMPT ALREADY EXISTS AT THE POINT OF USE
 * =============================================================================
 *
 * Because the point of use is the worst possible moment to meet it. A learner's
 * first spoken practice session asks for the microphone in the middle of the
 * question they were trying to answer; if they miss the prompt, tap the wrong
 * side of it, or their browser blocked this origin months ago, the session
 * stalls with no obvious remedy and the one-shot prompt is gone. The same is
 * true of a notification permission nobody has been asked for, and of audio
 * output, which on a phone can be silently muted or routed to a speaker in
 * another room.
 *
 * This screen does not replace any of those flows — `useAudioCapture` still
 * handles a blocked microphone at the moment of capture, and it must, because a
 * permission can be revoked between here and there. What it adds is somewhere
 * to answer all three questions deliberately, in advance, with a sentence next
 * to each explaining what it is for. A permission asked for with context
 * converts far better than the same permission asked for without one.
 *
 * =============================================================================
 * NOTHING HERE PROMPTS ON MOUNT, ON RENDER, OR ON NAVIGATION
 * =============================================================================
 *
 * The two hooks this page reads — `useMediaReadiness` and
 * `useBrowserNotificationPermission` — OBSERVE and never request; both say so at
 * length in their own headers, and this issue does not change that. Every
 * request in this feature lives in a click handler below:
 *
 *   * `handleAllowMicrophone` is THE ONLY `getUserMedia` CALL added by #384.
 *   * `handleAllowNotifications` calls the existing
 *     `requestBrowserNotificationPermission` — the same service #127 wired for
 *     the "Allow notifications" button on `/settings/notifications`. There is no
 *     second request path, deliberately: one call site per permission is what
 *     makes "does anything prompt on load?" answerable by reading one file.
 *
 * The reasoning is the hooks' own and is worth restating because it is what the
 * whole design rests on. A DENIAL IS EFFECTIVELY PERMANENT: this application
 * cannot re-prompt and cannot undo it, only the learner can, buried in browser
 * site settings. Spending that one-shot resource on somebody who has not yet
 * been given a reason to say yes kills the feature for them for good. Browsers
 * also penalise gestureless prompts — Chrome's quieter UI auto-blocks origins
 * that prompt without engagement, Firefox requires a gesture outright, Safari
 * has required one for `Notification.requestPermission()` since 16.4, and
 * `getUserMedia` on load fails on iOS Safari for the same reason — so a prompt
 * on mount frequently never even reaches the learner while still burning the
 * coin.
 *
 * =============================================================================
 * NO SETTINGS DOCUMENT, THEREFORE NO `UserSettingsSection`
 * =============================================================================
 *
 * This page reads and writes nothing on the server: no endpoint, no schema, no
 * migration. Every state on it is a fact about this browser on this device, and
 * the two actions change browser state, not stored state.
 *
 * `UserSettingsSection` exists to share ONE `useUserSettings()` call and its
 * save snackbars between the pages that edit the user settings DOCUMENT.
 * Wrapping this page in it would fire a `GET /user-settings` nothing here
 * reads, and — because that wrapper renders its children only once the document
 * has loaded — would blank the microphone row whenever an unrelated request
 * failed. A learner whose settings endpoint is down still needs to know whether
 * their microphone is blocked.
 *
 * So the chrome below is only what that wrapper would have contributed
 * visually: the container, the `h1` and the description. This is exactly the
 * call `UserTokensPage` already documents for the same reason, and it is not a
 * fork of anything — the hub itself is still the shared `SettingsHub`, reached
 * by declaring this card in `config/userSettingsSections.tsx`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Container, Typography } from '@mui/material';

import {
  DevicePermissionsSettings,
  type MicrophoneRequest,
  type SoundTest,
} from '../components/settings/DevicePermissionsSettings';
import {
  classifyGetUserMediaError,
  describeCaptureProblem,
  preflightCaptureProblem,
} from '../hooks/useAudioCapture';
import { useBrowserNotificationPermission } from '../hooks/useBrowserNotificationPermission';
import { useIsMounted } from '../hooks/useIsMounted';
import { useMediaReadiness } from '../hooks/useMediaReadiness';
import {
  LISTENING_EARCON,
  peekSharedAudioContextState,
  playEarconIgnoringPreference,
} from '../lib/earcons';
import { requestBrowserNotificationPermission } from '../services/browserNotifications';

/** Mirrors the `Device & permissions` card in `config/userSettingsSections.tsx`,
 *  so the hub card, the compact AppBar title (#95) and this page's `h1` all
 *  name the page identically. */
const PAGE_TITLE = 'Device & permissions';
const PAGE_DESCRIPTION =
  'Grant the microphone and notifications, and check that sound works, before a session needs them.';

/**
 * How long to wait before re-reading the audio context after a test tone.
 *
 * `AudioContext.resume()` is ASYNCHRONOUS. `getSharedAudioContext()` asks for a
 * resume on the way past — which is exactly right inside a click, since a click
 * is the gesture that permits it — but reading `state` in the same tick reports
 * the state we have just asked to change, and would tell a learner their audio
 * is paused a few milliseconds before it is not. One short re-read settles it.
 */
const AUDIO_STATE_SETTLE_MS = 400;

export default function DeviceSettingsPage() {
  const isMounted = useIsMounted();

  // OBSERVED, both of them. Neither hook can prompt; see the file header.
  const { permission, problem, isChecking, recheck } = useMediaReadiness();
  const { permission: notificationPermission, refresh: refreshNotifications } =
    useBrowserNotificationPermission();

  const [microphoneRequest, setMicrophoneRequest] = useState<MicrophoneRequest>({
    kind: 'idle',
  });
  const [isRequestingNotifications, setIsRequestingNotifications] = useState(false);
  const [soundTest, setSoundTest] = useState<SoundTest>({ kind: 'idle' });

  /** The pending audio re-read, so leaving the page cancels it. */
  const settleTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  /**
   * THE ONLY `getUserMedia` CALL THIS FEATURE ADDS. Reachable only from the
   * "Allow microphone" button — never from an effect, a timer, or a route
   * transition. See the file header for why that matters more than anything
   * else on this page.
   *
   * THE STREAM IS STOPPED THE INSTANT IT ARRIVES. This is a permission request,
   * not a capture session: the page has nothing to record and nothing to listen
   * to. A stream left open keeps the device held and lights the browser's
   * recording indicator — a red dot on a settings screen, for no reason, which
   * is the sort of thing a learner remembers about an app that asked for their
   * microphone.
   *
   * The platform preflight runs FIRST, in the same order `acquireStream` uses
   * (`insecure_origin` before `unsupported`, for `preflightCaptureProblem`'s own
   * reason), because on a non-secure origin `navigator.mediaDevices` is not
   * merely unhelpful — it is absent, and calling through it would throw a
   * `TypeError` that says nothing a learner can act on.
   */
  const handleAllowMicrophone = useCallback(async () => {
    const platform = preflightCaptureProblem();
    if (platform) {
      setMicrophoneRequest({
        kind: 'failed',
        problem: describeCaptureProblem(platform),
      });
      return;
    }

    setMicrophoneRequest({ kind: 'requesting' });

    try {
      // `{ audio: true }` and nothing else. No device id, no constraints: this
      // asks the one question the browser's permission model answers, and
      // choosing a specific input is explicitly out of scope (`useMediaReadiness`
      // reads device PRESENCE, never names).
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // BEFORE any state update, and outside the mounted guard below: a learner
      // who navigates away while the prompt is open must not leave a live
      // microphone behind them.
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // A stub or an exotic implementation. There is nothing to recover
          // from and nothing to tell anybody.
        }
      }

      if (isMounted()) setMicrophoneRequest({ kind: 'granted' });
    } catch (error) {
      // NO NEW TAXONOMY. `classifyGetUserMediaError` maps the spec's error
      // names onto the same seven named problems every other capture surface
      // in this app renders, each with its own one-step remedy — including the
      // two no observation can reach, a dismissed prompt and a device another
      // application is holding.
      if (isMounted()) {
        setMicrophoneRequest({
          kind: 'failed',
          problem: describeCaptureProblem(classifyGetUserMediaError(error)),
        });
      }
    } finally {
      // Unconditional, exactly as the notification handler refreshes in its own
      // `finally`: the Permissions API is the steady-state source of truth for
      // this row, and re-reading it is right whether the learner allowed,
      // blocked, or dismissed the prompt without choosing.
      if (isMounted()) recheck();
    }
  }, [isMounted, recheck]);

  /**
   * The notification prompt — the SAME service `/settings/notifications` uses
   * (#127), imported rather than reimplemented.
   *
   * THE REFRESH IS IN A `finally`, for the reason `UserNotificationsPage`
   * documents: the request resolves `null` on an unsupported or throwing
   * browser and can resolve with the permission unchanged when the learner
   * dismisses the prompt without choosing. Re-reading
   * `Notification.permission` is the only answer that is right in every one of
   * those cases, including "nothing happened, the button stays".
   */
  const handleAllowNotifications = useCallback(async () => {
    setIsRequestingNotifications(true);
    try {
      await requestBrowserNotificationPermission();
    } finally {
      // Guarded: the prompt is modal and the learner can navigate away while
      // it is open, so both of these can land after unmount.
      if (isMounted()) {
        setIsRequestingNotifications(false);
        refreshNotifications();
      }
    }
  }, [isMounted, refreshNotifications]);

  /**
   * Play one real cue, through the shared `AudioContext`.
   *
   * A REAL CUE, not a tone written for this screen: the learner is testing
   * whether they will hear the chime that tells them the microphone is open
   * hands-free, and testing a different sound would prove something else. The
   * rising two-tone is the one whose absence costs the most — a learner who
   * misses it does not know the session is listening.
   *
   * IT IGNORES `voice.soundCues` — see `playEarconIgnoringPreference`'s own
   * comment. That preference governs UNREQUESTED sound during a session; this
   * press IS the request, and it is most often made by somebody trying to work
   * out why they heard nothing, for whom a silent button is indistinguishable
   * from the fault they came to diagnose. The row says out loud that the test
   * tone sounds either way, so the switch never looks broken.
   *
   * The context is created (and resumed) inside the click, which is the gesture
   * that permits both.
   */
  const handlePlayTestTone = useCallback(() => {
    playEarconIgnoringPreference(LISTENING_EARCON);
    setSoundTest({ kind: 'played', output: peekSharedAudioContextState() });

    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      if (!isMounted()) return;
      // Second read, after `resume()` has had a chance to settle — and a
      // `recheck()` so the microphone row's own view of the audio output stays
      // in step with this one.
      setSoundTest({ kind: 'played', output: peekSharedAudioContextState() });
      recheck();
    }, AUDIO_STATE_SETTLE_MS);
  }, [isMounted, recheck]);

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {PAGE_DESCRIPTION}
        </Typography>

        <DevicePermissionsSettings
          microphone={{ permission, problem, isChecking, request: microphoneRequest }}
          // The promises are dropped deliberately: each handler owns its own
          // failure — there is nothing to report that the row does not already
          // say — and neither can reject.
          onAllowMicrophone={() => void handleAllowMicrophone()}
          notificationPermission={notificationPermission}
          onRequestNotificationPermission={() => void handleAllowNotifications()}
          isRequestingNotificationPermission={isRequestingNotifications}
          soundTest={soundTest}
          onPlayTestTone={handlePlayTestTone}
        />
      </Box>
    </Container>
  );
}

/**
 * Settings → Device & permissions: the three things this device has to be able
 * to do before spoken practice works, each with the ONE action that can change
 * it.
 *
 * Issue #384. Until this screen existed, a learner who could not practise
 * aloud had no place to find out why. Every permission this product needs was
 * discovered at the point of use — mid-session, after committing to a
 * hands-free run — and every remedy for a permission that had already been
 * refused lived in a browser menu nobody had been pointed at.
 *
 * =============================================================================
 * NOTHING HERE PROMPTS ON MOUNT, ON NAVIGATION, OR ON APP START. EVER.
 * =============================================================================
 *
 * THIS IS THE POINT OF THE FEATURE, not a detail of it. Every permission
 * request on this screen sits behind a real click, and there is deliberately
 * no effect, no timer, no route transition and no render path that can reach
 * one. Concretely, and checkably:
 *
 *   * `getUserMedia` is called from `handleAllowMicrophone` and NOWHERE ELSE
 *     in this file. It is the only `getUserMedia` call on this page.
 *   * `Notification.requestPermission()` is not called from this file at all —
 *     the request goes through `services/browserNotifications.ts`'s
 *     `requestBrowserNotificationPermission`, from `handleAllowNotifications`,
 *     which is the same shared function `/settings/notifications` uses. There
 *     is no second request path in this codebase and this file does not add
 *     one.
 *   * An `AudioContext` is created or resumed only inside `handleTestTone`,
 *     through `playTestTone()`. `isWebAudioSupported()` answers the render-time
 *     question without building one.
 *
 * The two hooks this component mounts — `useMediaReadiness` and
 * `useBrowserNotificationPermission` — are OBSERVERS, and each says so at
 * length in its own header. `permissions.query`, `enumerateDevices`,
 * `Notification.permission` and `peekSharedAudioContextState` are all specified
 * not to prompt and not to create anything. Mounting this screen must stay
 * exactly as inert as reading it.
 *
 * WHY, in the two forms that matter — because a future edit that adds a
 * mount-time prompt will look harmless, and this paragraph is what has to stop
 * it:
 *
 *   1. BROWSERS PENALISE PROMPT-ON-LOAD, so the prompt frequently never
 *      reaches the person at all. Chrome demotes gestureless permission
 *      requests into its quieter UI, which can auto-block them outright;
 *      Firefox requires a user gesture and auto-dismisses without one; Safari
 *      has required a gesture for `Notification.requestPermission()` since
 *      16.4; and `getUserMedia` called on load simply fails on iOS Safari. A
 *      prompt on mount is not merely rude — it is often a request that is
 *      refused before a human sees it.
 *   2. A DENIAL IS EFFECTIVELY PERMANENT. This application cannot re-prompt
 *      and cannot undo a block; only the person can, from a menu inside their
 *      browser. The prompt is therefore a ONE-SHOT RESOURCE. Spending it on
 *      somebody who has not yet been given a reason to say yes does not merely
 *      fail — it kills the feature for that person forever, and every screen
 *      afterwards can do nothing but explain what they lost.
 *
 * Which is exactly why the buttons below are attached to sentences that say
 * what the permission is for. The click is the consent; the copy is what makes
 * the click informed.
 *
 * =============================================================================
 * THE MICROPHONE'S WORDS ARE `describeCaptureProblem`'s, VERBATIM
 * =============================================================================
 *
 * Nothing here writes its own microphone failure copy. Every problem state
 * renders `MicrophoneReadinessNotice`, which renders the
 * `AudioCaptureProblem`'s own `message` and `remedy` — the same seven-remedy
 * table `useAudioCapture` fails with mid-session and `useMediaReadiness`
 * preflights with on the practice picker. A learner told one thing here and
 * something else on the picker has been given two accounts of one fact with no
 * way to tell which is current.
 *
 * `'unknown'` IS NOT `'denied'`, per `useMediaReadiness`'s own header: Safari
 * has never shipped the `microphone` permission name and jsdom has no
 * Permissions API at all, so an unknown is rendered as an unknown — we say we
 * cannot tell, and offer the button, because pressing it is the only way to
 * find out and it is harmless when permission has already been granted.
 *
 * =============================================================================
 * A BLOCKED STATE OFFERS NO BUTTON
 * =============================================================================
 *
 * On either row, a `denied` / blocked state renders an explanation and NO
 * action, because this application genuinely has none: a button there would be
 * a lie that produces nothing when pressed, which reads as the product being
 * broken on top of the permission being off. The copy names the remedy AND
 * says who owns it.
 */

import { useCallback, useId, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Typography,
} from '@mui/material';

import { MicrophoneReadinessNotice } from '../voice/MicrophoneReadinessNotice';
import {
  classifyGetUserMediaError,
  describeCaptureProblem,
  type AudioCaptureProblem,
} from '../../hooks/useAudioCapture';
import { useBrowserNotificationPermission } from '../../hooks/useBrowserNotificationPermission';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMediaReadiness } from '../../hooks/useMediaReadiness';
import type { BrowserNotificationPermission } from '../../hooks/useBrowserNotificationPermission';
import type { MicrophonePermission } from '../../hooks/useMediaReadiness';
import { isWebAudioSupported, playTestTone } from '../../lib/earcons';
import { requestBrowserNotificationPermission } from '../../services/browserNotifications';

// =============================================================================
// Copy
// =============================================================================

/**
 * One row's state as a table rather than as ternaries inside a render, the
 * same shape `NotificationSettings.browserChannelState` uses — and exported
 * for the same reason: "each state has its own copy and its own remedy" is
 * then a fact a test can check rather than a promise spread across a JSX tree.
 */
export interface PermissionRowCopy {
  /** What is true right now, one sentence, present tense. */
  status: string;
  /**
   * What to do about it, or `null` when there is nothing to do. NEVER a
   * cheerful non-instruction: a `null` means the row is fine.
   */
  remedy: string | null;
  /**
   * May the row render its request button?
   *
   * `false` for every state this application cannot change — see the file
   * header. It is not a styling decision.
   */
  canAsk: boolean;
  severity: 'success' | 'info' | 'warning';
}

/**
 * The microphone row, for the states that are NOT one of the seven named
 * capture problems.
 *
 * A problem outranks all of these and is rendered by
 * `MicrophoneReadinessNotice` instead — including `permission_denied`, which
 * is why "blocked" has no entry here and no button anywhere.
 */
export function microphoneRowCopy(
  permission: MicrophonePermission,
): PermissionRowCopy {
  switch (permission) {
    case 'granted':
      return {
        status: 'Your browser is allowing this site to use the microphone.',
        remedy: null,
        canAsk: false,
        severity: 'success',
      };
    case 'denied':
      // Unreachable in practice — `useMediaReadiness` turns a denial into the
      // `permission_denied` problem, which this row renders instead. Kept
      // honest rather than thrown, because a switch that lies in its
      // unreachable branch is a switch nobody can trust in its reachable ones.
      return {
        status: 'Your browser is blocking the microphone for this site.',
        remedy:
          'Open the site permissions from the icon in your address bar, allow the microphone, then reload this page. This application cannot undo a block — only you can.',
        canAsk: false,
        severity: 'warning',
      };
    case 'prompt':
      return {
        status: 'Your browser has not been asked for the microphone yet.',
        remedy:
          'Allow it here, once, and a spoken practice session can start without stopping to ask.',
        canAsk: true,
        severity: 'info',
      };
    case 'unknown':
    default:
      // `'unknown'` is a fourth state the Web API does not have, and it is NOT
      // a denial — see `useMediaReadiness`'s header. Saying so plainly is the
      // only honest option; the button is offered because pressing it is the
      // only way to find out, and because it does nothing at all when
      // permission has already been granted.
      return {
        status:
          'This browser does not tell us whether the microphone is already allowed.',
        remedy:
          'Choosing Allow microphone opens your browser’s own prompt if it has not been answered yet, and does nothing if it has.',
        canAsk: true,
        severity: 'info',
      };
  }
}

/**
 * The notifications row.
 *
 * Deliberately NOT `browserChannelState` from `NotificationSettings.tsx`,
 * which is not the same question and says so in its own words: that table is
 * about whether the preference MATRIX below it can take effect ("these
 * preferences cannot take effect", "Email notifications are unaffected"), and
 * there is no matrix on this page. What is shared between the two screens is
 * the thing that must not be duplicated — the request itself, which both reach
 * through `requestBrowserNotificationPermission` and neither implements.
 */
export function notificationRowCopy(
  permission: BrowserNotificationPermission,
): PermissionRowCopy {
  switch (permission) {
    case 'granted':
      return {
        status: 'Your browser is showing notifications from this site.',
        remedy: null,
        canAsk: false,
        severity: 'success',
      };
    case 'denied':
      return {
        status: 'Your browser is blocking notifications from this site.',
        remedy:
          'Open the site permissions from the icon in your address bar, allow notifications, then reload this page. This application cannot undo a block — only you can.',
        canAsk: false,
        severity: 'warning',
      };
    case 'unsupported':
      return {
        status: 'This browser cannot show notifications.',
        remedy:
          'Notifications need a browser that supports them, over a secure (https) connection. Anything you chose to receive by email still arrives.',
        canAsk: false,
        severity: 'info',
      };
    case 'default':
    default:
      return {
        status: 'Your browser has not been asked about notifications yet.',
        remedy:
          'Study reminders and other updates will not appear on this device until you allow them.',
        canAsk: true,
        severity: 'info',
      };
  }
}

/**
 * What the microphone button reports after a press.
 *
 * A SEPARATE FACT from the hook's observation, and rendered in preference to
 * it, because a press can produce an answer the Permissions API never will —
 * `permission_dismissed` (the prompt was closed unanswered) is invisible to
 * `permissions.query` and is a genuinely different situation from a denial.
 */
type MicrophoneRequestResult =
  | { kind: 'granted' }
  | { kind: 'problem'; problem: AudioCaptureProblem };

/** After a granted press. Says what we did with the microphone we opened. */
export const MICROPHONE_GRANTED_MESSAGE =
  'Your microphone is allowed. We opened it for a moment to check, and closed it again straight away.';

/**
 * After the test tone. It does NOT claim the learner heard anything, because
 * nothing on this device can know that — a scheduled oscillator says only that
 * the browser accepted the sound. So the sentence hands the check back to the
 * one party who can make it, and names the two things that silence usually
 * means.
 */
export const TEST_TONE_PLAYED_MESSAGE =
  'A test tone just played. If you did not hear it, check that your device is not on silent and turn the volume up.';

/** The browser could not play a tone at all. Not an error, and not silence. */
export const TEST_TONE_UNAVAILABLE_MESSAGE =
  'This browser could not play a test tone. Spoken practice will still read questions aloud where your browser supports speech, but the short tones will be silent.';

// =============================================================================
// Component
// =============================================================================

export function DevicePermissions() {
  const isMounted = useIsMounted();
  const idPrefix = useId();

  // OBSERVERS, both of them, and neither prompts on mount — see the file
  // header, and each hook's own.
  const { permission: micPermission, problem: micProblem, recheck } = useMediaReadiness();
  const { permission: notificationPermission, refresh: refreshNotificationPermission } =
    useBrowserNotificationPermission();

  const [micRequest, setMicRequest] = useState<MicrophoneRequestResult | null>(null);
  const [isRequestingMic, setIsRequestingMic] = useState(false);
  const [isRequestingNotifications, setIsRequestingNotifications] = useState(false);
  const [toneMessage, setToneMessage] = useState<string | null>(null);

  /**
   * THE ONLY `getUserMedia` CALL ON THIS PAGE, and it is a click handler.
   *
   * Two things it must do that a naive version would not:
   *
   *   1. STOP EVERY TRACK IT OBTAINS, immediately, in a `finally`. This page is
   *      a status screen, not a recording surface: holding the stream open
   *      would leave the browser's recording indicator lit and the device
   *      claimed for as long as the learner reads the page, which is both
   *      alarming and enough to make the microphone unavailable to the app
   *      that actually wants it next.
   *   2. `recheck()` afterwards, so the row moves to its granted or blocked
   *      treatment without a reload — and so a dismissal, which changes
   *      nothing, correctly leaves the button exactly where it was.
   */
  const handleAllowMicrophone = useCallback(async () => {
    setIsRequestingMic(true);
    setMicRequest(null);

    const devices = navigator?.mediaDevices;
    if (!devices?.getUserMedia) {
      // Never reachable through the button in practice — the preflight already
      // reports `unsupported` as a problem and the button is not rendered —
      // but the call below would throw a `TypeError` rather than a named
      // problem if it ever were, and a `TypeError` has no remedy to show.
      setIsRequestingMic(false);
      setMicRequest({
        kind: 'problem',
        problem: describeCaptureProblem('unsupported'),
      });
      return;
    }

    let stream: MediaStream | null = null;
    try {
      stream = await devices.getUserMedia({ audio: true });
      if (isMounted()) setMicRequest({ kind: 'granted' });
    } catch (error) {
      // The same classifier the capture hook uses, so a denial, a dismissal, a
      // missing device and a busy device stay four different sentences here
      // exactly as they are mid-session.
      if (isMounted()) {
        setMicRequest({
          kind: 'problem',
          problem: describeCaptureProblem(classifyGetUserMediaError(error)),
        });
      }
    } finally {
      // UNCONDITIONAL, and outside the mounted guard: a stream obtained after
      // the learner navigated away still has to be released.
      try {
        stream?.getTracks().forEach((track) => track.stop());
      } catch {
        // A stub or an exotic implementation. Nothing to report.
      }
      if (isMounted()) {
        setIsRequestingMic(false);
        recheck();
      }
    }
  }, [isMounted, recheck]);

  /**
   * The notification prompt, through the SHARED service function.
   *
   * `Notification.requestPermission()` is not called here, and must never be:
   * `services/browserNotifications.ts` is the one module that touches the
   * native API, `/settings/notifications` already calls it from its own
   * banner, and a second implementation would be a second thing to keep
   * defensive about a browser that throws on the constructor.
   *
   * The refresh is in a `finally`, exactly as `UserNotificationsPage` does it
   * and for the same reason: the request resolves `null` on a browser that
   * refuses outright and resolves unchanged when the learner dismisses the
   * prompt, so re-reading `Notification.permission` is the only answer that is
   * right in every case — including "nothing happened, the button stays".
   */
  const handleAllowNotifications = useCallback(async () => {
    setIsRequestingNotifications(true);
    try {
      await requestBrowserNotificationPermission();
    } finally {
      if (isMounted()) {
        setIsRequestingNotifications(false);
        refreshNotificationPermission();
      }
    }
  }, [isMounted, refreshNotificationPermission]);

  /**
   * THE ONLY PLACE AN `AudioContext` IS CREATED OR RESUMED ON THIS PAGE.
   *
   * `playTestTone()` reaches `getSharedAudioContext()`, which constructs the
   * context and calls `resume()` SYNCHRONOUSLY inside this handler — which is
   * the only moment a browser permits it. A context built on mount starts
   * `suspended` on every mobile browser and stays that way, so a version of
   * this that warmed the context in an effect would produce a button that
   * silently does nothing on exactly the devices this row exists for.
   */
  const handleTestTone = useCallback(() => {
    const result = playTestTone();
    setToneMessage(
      result === 'played' ? TEST_TONE_PLAYED_MESSAGE : TEST_TONE_UNAVAILABLE_MESSAGE,
    );
  }, []);

  // ---- microphone row -------------------------------------------------------

  // The press outranks the observation: it is fresher, and it can name states
  // the Permissions API cannot (a dismissed prompt). Both fall back to the
  // preflight's own problem, which is what reports an insecure origin, a
  // browser that cannot record, and a device that is not there.
  const effectiveMicProblem =
    micRequest?.kind === 'problem' ? micRequest.problem : micProblem;
  const effectiveMicPermission: MicrophonePermission =
    !effectiveMicProblem && micRequest?.kind === 'granted' ? 'granted' : micPermission;
  const mic = microphoneRowCopy(effectiveMicPermission);

  const micStatusMessage = effectiveMicProblem
    ? `${effectiveMicProblem.message} ${effectiveMicProblem.remedy}`
    : micRequest?.kind === 'granted'
      ? MICROPHONE_GRANTED_MESSAGE
      : mic.status;

  const notifications = notificationRowCopy(notificationPermission);
  const micHelpId = `${idPrefix}-microphone-help`;
  const notificationsHelpId = `${idPrefix}-notifications-help`;
  const soundHelpId = `${idPrefix}-sound-help`;
  const webAudio = isWebAudioSupported();

  return (
    <>
      {/* ===================================================================
          MICROPHONE
          =================================================================== */}
      <Card>
        <CardContent>
          <Typography variant="h6" component="h2" gutterBottom>
            Microphone
          </Typography>

          <Typography
            id={micHelpId}
            variant="body2"
            color="text.secondary"
            sx={{ maxWidth: '62ch', mb: 2 }}
          >
            Answering a practice question out loud needs the microphone. It is
            opened only while you are answering, and the recording is never
            stored.
          </Typography>

          {/* A PROBLEM RENDERS THE SHARED NOTICE, never wording of this file's
              own — see the header. This is the same component, with the same
              sentence, the practice picker shows. */}
          {effectiveMicProblem ? (
            <MicrophoneReadinessNotice problem={effectiveMicProblem} />
          ) : (
            <Alert severity={mic.severity}>
              {micRequest?.kind === 'granted' ? MICROPHONE_GRANTED_MESSAGE : mic.status}
              {mic.remedy && (
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  {mic.remedy}
                </Typography>
              )}
            </Alert>
          )}

          {/* NO BUTTON IN A BLOCKED, UNSUPPORTED, INSECURE OR NO-DEVICE STATE.
              `canAsk` is false for every state this application cannot change,
              and a problem suppresses the button outright — a control that can
              only fail is worse than no control. */}
          {!effectiveMicProblem && mic.canAsk && (
            <Box sx={{ mt: 1.5 }}>
              <Button
                variant="outlined"
                size="small"
                onClick={() => void handleAllowMicrophone()}
                disabled={isRequestingMic}
                aria-describedby={micHelpId}
                startIcon={
                  isRequestingMic ? <CircularProgress size={16} /> : undefined
                }
              >
                {/* Names the ACTION and its limit. "Enable" would over-promise:
                    this opens the browser's own prompt, and the browser — not
                    this application — decides what happens next. */}
                {isRequestingMic ? 'Waiting for your browser…' : 'Allow microphone'}
              </Button>
            </Box>
          )}

          {/* ALWAYS MOUNTED, text swapped — never inserted along with its
              content. A live region added to the DOM at the same moment as the
              text it carries is frequently not announced at all, which is the
              one failure mode a status region has. */}
          <Box role="status" aria-live="polite" sx={{ mt: 1.5 }}>
            <Typography variant="body2" color="text.secondary">
              {isRequestingMic ? 'Waiting for your browser…' : micStatusMessage}
            </Typography>
          </Box>
        </CardContent>
      </Card>

      {/* ===================================================================
          NOTIFICATIONS
          =================================================================== */}
      <Card>
        <CardContent>
          <Typography variant="h6" component="h2" gutterBottom>
            Notifications
          </Typography>

          <Typography
            id={notificationsHelpId}
            variant="body2"
            color="text.secondary"
            sx={{ maxWidth: '62ch', mb: 2 }}
          >
            Your browser decides whether this site may show a notification at
            all. Which notifications you actually receive is a separate choice,
            in Settings → Notifications.
          </Typography>

          <Alert severity={notifications.severity}>
            {notifications.status}
            {notifications.remedy && (
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                {notifications.remedy}
              </Typography>
            )}
          </Alert>

          {/* Rendered ONLY in the `default` state, for the reason the file
              header gives: `granted` has nothing to ask for, and in `denied`
              or `unsupported` a button would be a lie — neither is recoverable
              from inside this application. */}
          {notifications.canAsk && (
            <Box sx={{ mt: 1.5 }}>
              <Button
                variant="outlined"
                size="small"
                onClick={() => void handleAllowNotifications()}
                disabled={isRequestingNotifications}
                aria-describedby={notificationsHelpId}
                startIcon={
                  isRequestingNotifications ? <CircularProgress size={16} /> : undefined
                }
              >
                {isRequestingNotifications
                  ? 'Waiting for your browser…'
                  : 'Allow notifications'}
              </Button>
            </Box>
          )}

          <Box role="status" aria-live="polite" sx={{ mt: 1.5 }}>
            <Typography variant="body2" color="text.secondary">
              {isRequestingNotifications
                ? 'Waiting for your browser…'
                : notifications.status}
            </Typography>
          </Box>
        </CardContent>
      </Card>

      {/* ===================================================================
          SOUND

          NOT A PERMISSION, and the only row here with no browser state to
          read. A muted phone, a volume slider at zero and a browser that has
          suspended this page's audio are all invisible from script, so the
          only honest check is to make a sound and ask the one party who can
          hear it. That is why the row is a button and a sentence rather than a
          status.
          =================================================================== */}
      <Card>
        <CardContent>
          <Typography variant="h6" component="h2" gutterBottom>
            Sound
          </Typography>

          <Typography
            id={soundHelpId}
            variant="body2"
            color="text.secondary"
            sx={{ maxWidth: '62ch', mb: 2 }}
          >
            Spoken practice reads questions aloud and plays short tones to tell
            you when it is listening. Play a test tone to check that this device
            is not muted and the volume is where you expect.
          </Typography>

          {!webAudio && (
            <Alert severity="info" sx={{ mb: 1.5 }}>
              {TEST_TONE_UNAVAILABLE_MESSAGE}
            </Alert>
          )}

          <Button
            variant="outlined"
            size="small"
            onClick={handleTestTone}
            disabled={!webAudio}
            aria-describedby={soundHelpId}
          >
            Play a test tone
          </Button>

          {/* The result is TEXT as well as sound, deliberately: a device that is
              muted gives no other feedback at all, so a learner who hears
              nothing would otherwise not know whether the button worked. */}
          <Box role="status" aria-live="polite" sx={{ mt: 1.5 }}>
            <Typography variant="body2" color="text.secondary">
              {toneMessage ?? ''}
            </Typography>
          </Box>
        </CardContent>
      </Card>
    </>
  );
}

export default DevicePermissions;

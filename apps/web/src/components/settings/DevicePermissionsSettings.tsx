/**
 * The three device rows of `/settings/device` — microphone, notifications, and
 * sound — each stating what is true right now and offering the one action that
 * can change it.
 *
 * Issue #384. Rendered by `pages/DeviceSettingsPage.tsx`.
 *
 * =============================================================================
 * NOTHING IN THIS FILE PROMPTS. THE PROMPTS LIVE IN THE PAGE'S CLICK HANDLERS.
 * =============================================================================
 *
 * This component receives state and callbacks and calls neither
 * `getUserMedia` nor `Notification.requestPermission()`. That is the same
 * separation `NotificationSettings.tsx` keeps for the notification prompt, and
 * it exists for the reason both permission hooks state at length in their own
 * headers: a browser permission is a ONE-SHOT RESOURCE. A denial is effectively
 * permanent — this application can never re-ask and can never undo it, only the
 * learner can, from a browser menu — and browsers additionally penalise prompts
 * that are not tied to a user gesture (Chrome demotes them to a quiet UI,
 * Firefox requires the gesture outright, Safari has required one for
 * `requestPermission()` since 16.4).
 *
 * So the request has to be a deliberate press, and keeping every request in one
 * page's handlers is what keeps "does anything prompt on load?" answerable by
 * reading one file.
 *
 * =============================================================================
 * THE COPY IS THREE TABLES, NOT THIRTY TERNARIES
 * =============================================================================
 *
 * Each row resolves to a {@link RowPresentation} through an exported pure
 * function, exactly as `NotificationSettings.tsx`'s `browserChannelState` does
 * for its own banner. "What does `denied` say, and does it offer a button?" is
 * then one readable table rather than a search through JSX — and a test can
 * assert the copy without a DOM.
 *
 * THE MICROPHONE ROW INVENTS NO WORDING OF ITS OWN. Every failure it renders is
 * an {@link AudioCaptureProblem}, built by `describeCaptureProblem` from
 * `useAudioCapture`'s single table of seven named problems, each with its own
 * one-step remedy. `useMediaReadiness`'s header is explicit that a preflight
 * writing its own "microphone unavailable" sentence would undo that work at the
 * one moment it matters most — earlier, where the learner still has both hands
 * free to act on the remedy. That applies here more than anywhere: this screen
 * exists precisely so the problem is met before a session, not during one.
 *
 * The two states that are NOT problems — "granted" and "not asked yet" — do get
 * copy written here, because there is no failure to describe and nothing in
 * that table to reuse.
 *
 * =============================================================================
 * WHY THE NOTIFICATION COPY IS NOT `browserChannelState`'s
 * =============================================================================
 *
 * It reuses that module's TAXONOMY — `BrowserNotificationPermission`, all four
 * states including `unsupported`, which is not `denied` — and deliberately not
 * its sentences. `browserChannelState` is written about a preferences matrix
 * ("so these preferences cannot take effect"); on this page there is no matrix,
 * and a sentence pointing at controls that are on a different screen would be
 * describing something the learner cannot see. The remedy half is close to
 * identical because the remedy genuinely is identical, and saying it two
 * different ways would be worse than saying it twice.
 */

import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Link,
  Typography,
} from '@mui/material';
import MicNoneIcon from '@mui/icons-material/MicNone';
import NotificationsNoneIcon from '@mui/icons-material/NotificationsNone';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';

import type { AudioCaptureProblem } from '../../hooks/useAudioCapture';
import type { BrowserNotificationPermission } from '../../hooks/useBrowserNotificationPermission';
import type {
  AudioOutputState,
  MicrophonePermission,
} from '../../hooks/useMediaReadiness';

// =============================================================================
// The shape every row resolves to — the pure half, exported so the copy can be
// reasoned about and tested without a DOM.
// =============================================================================

/**
 * One row's rendered state.
 *
 * `action` is the load-bearing field: it says whether this row offers the
 * button at all. A button that cannot possibly help is worse than no button —
 * it reads as the product being broken when it does nothing — which is why
 * `denied` never gets one on either permission, and why `NotificationSettings`
 * already takes exactly that line for the notification half.
 */
export interface RowPresentation {
  /** Short state label for the chip. Two or three words, never a sentence. */
  status: string;
  /** The chip's colour. `default` where the state is neither good nor bad. */
  tone: 'success' | 'warning' | 'error' | 'info' | 'default';
  /** What is true, one or two sentences, in the learner's terms. */
  body: string;
  /** What to do about it. `null` when there is nothing to do. */
  remedy: string | null;
  /** Whether to render this row's action button. */
  action: boolean;
}

// =============================================================================
// Microphone
// =============================================================================

/**
 * What the "Allow microphone" press did, as the page's handler saw it.
 *
 * SEPARATE FROM THE OBSERVED PERMISSION, and both are needed. The observed
 * permission is the honest steady state and updates when the learner changes it
 * in another tab; the request outcome is the only thing that can be known on a
 * browser whose Permissions API does not answer for `microphone` at all —
 * Safari, where `useMediaReadiness` correctly reports `'unknown'` forever and
 * would otherwise leave a learner who just granted the microphone looking at
 * "we cannot tell".
 */
export type MicrophoneRequest =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'granted' }
  | { kind: 'failed'; problem: AudioCaptureProblem };

export interface MicrophoneRowInput {
  /** `useMediaReadiness().permission`. `'unknown'` is NOT `'denied'`. */
  permission: MicrophonePermission;
  /** `useMediaReadiness().problem` — the named problem, or `null`. */
  problem: AudioCaptureProblem | null;
  /** `useMediaReadiness().isChecking` — true until the first probe settles. */
  isChecking: boolean;
  /** The outcome of this page's own request, if one has been made. */
  request: MicrophoneRequest;
}

/**
 * Resolve the microphone row.
 *
 * THE ORDER OF THE BRANCHES IS THE DESIGN:
 *
 *   1. A request in flight, because the learner is looking at the browser's own
 *      dialogue and the row must not claim anything while they decide.
 *   2. The OBSERVED problem outranks a stale request outcome. A learner who
 *      granted the microphone at 10:00 and unplugged their headset at 10:05
 *      must see `no_device`, not "allowed".
 *   3. A failed request, which is the only source for the two problems no
 *      observation can reach: a prompt dismissed without an answer, and a
 *      device another application is holding.
 *   4. Granted — from either source, so Safari's permanent `'unknown'` still
 *      lands on the truth once the learner has actually granted it.
 *   5. `'prompt'`, the state this whole screen exists for: nothing has been
 *      asked yet, and asking now is free.
 *   6. `'unknown'`, which says so plainly. Resolving it to `denied` would put a
 *      confident, specific, wrong accusation on the screen of every Safari user
 *      whose microphone works — see `useMediaReadiness`'s header.
 */
export function microphoneRowPresentation(
  input: MicrophoneRowInput,
): RowPresentation {
  const { permission, problem, isChecking, request } = input;

  if (request.kind === 'requesting') {
    return {
      status: 'Waiting for your browser',
      tone: 'info',
      body: 'Your browser is asking whether this site may use the microphone. Choose Allow.',
      remedy: null,
      // The button is still rendered, and the page disables it — removing it
      // mid-press would move everything under the learner's finger.
      action: true,
    };
  }

  if (problem) {
    return {
      status: microphoneProblemStatus(problem),
      tone: 'warning',
      // VERBATIM, both halves. See the file header.
      body: problem.message,
      remedy: problem.remedy,
      // NO BUTTON on any observed problem. After a denial `getUserMedia`
      // rejects immediately without opening a prompt, so an "Allow microphone"
      // button there would be a control that provably cannot work; with no
      // device attached, or on a browser that cannot record at all, the same is
      // true for a different reason. Each of these states has a remedy, and
      // none of the remedies is this button.
      action: false,
    };
  }

  if (request.kind === 'failed') {
    return {
      status: microphoneProblemStatus(request.problem),
      tone: 'warning',
      body: request.problem.message,
      remedy: request.problem.remedy,
      // Asking again is worth a press here: a dismissed prompt reopens, and a
      // device someone else was holding may have been released. This mirrors
      // `isCaptureProblemRetryable`'s reasoning without importing it — that
      // helper answers "can holding the record button again help?", which is a
      // question about a capture flow this screen does not have.
      action: request.problem.code !== 'insecure_origin' &&
        request.problem.code !== 'unsupported',
    };
  }

  if (permission === 'granted' || request.kind === 'granted') {
    return {
      status: 'Allowed',
      tone: 'success',
      body:
        'This browser lets OathPath use your microphone, so spoken practice starts without stopping to ask.',
      remedy: null,
      action: false,
    };
  }

  if (isChecking) {
    return {
      status: 'Checking',
      tone: 'default',
      body: 'Reading what this browser allows.',
      remedy: null,
      // No button while we do not yet know what to offer. The check settles in
      // a tick or two; a button that appears and then changes meaning is worse
      // than one that appears once.
      action: false,
    };
  }

  if (permission === 'prompt') {
    return {
      status: 'Not asked yet',
      tone: 'default',
      body:
        'Your browser has not been asked for the microphone yet. Granting it here means your first spoken session begins straight away, instead of stopping to ask in the middle of a question.',
      remedy: null,
      action: true,
    };
  }

  return {
    status: 'Not known',
    tone: 'default',
    body:
      'This browser does not report whether the microphone is allowed — Safari does not — so the only way to find out is to ask. Nothing is blocked; you can grant it here, or leave it and answer the prompt when a spoken session opens one.',
    remedy: null,
    action: true,
  };
}

/**
 * A two-or-three word chip label per problem code.
 *
 * The SENTENCES stay `describeCaptureProblem`'s; this is the chip, which is a
 * label and not copy. `switch` on the closed union rather than a lookup with a
 * fallback, so an eighth code cannot be added without this row being revisited
 * — the property that union's own header says it exists to have.
 */
function microphoneProblemStatus(problem: AudioCaptureProblem): string {
  switch (problem.code) {
    case 'permission_denied':
      return 'Blocked';
    case 'permission_dismissed':
      return 'Not answered';
    case 'no_device':
      return 'No microphone';
    case 'device_in_use':
      return 'In use elsewhere';
    case 'insecure_origin':
      return 'Not available here';
    case 'unsupported':
      return 'Not supported';
    case 'recording_too_short':
      return 'Nothing recorded';
  }
}

// =============================================================================
// Notifications
// =============================================================================

/**
 * Resolve the notifications row from the browser's own permission.
 *
 * `unsupported` is a fourth state the Web API does not have and is NOT
 * `denied`: the browser has refused nothing, it simply has no `Notification`
 * constructor (an old browser, a page that is not on a secure origin, or jsdom
 * under the test runner). The remedies are completely different and only one of
 * them exists, so the two never share a sentence.
 */
export function notificationRowPresentation(
  permission: BrowserNotificationPermission,
  isRequesting: boolean,
): RowPresentation {
  if (isRequesting) {
    return {
      status: 'Waiting for your browser',
      tone: 'info',
      body: 'Your browser is asking whether this site may show notifications. Choose Allow.',
      remedy: null,
      action: true,
    };
  }

  switch (permission) {
    case 'granted':
      return {
        status: 'Allowed',
        tone: 'success',
        body:
          'This browser will show notifications from OathPath. Which events actually reach you is a separate choice, on the Notifications screen.',
        remedy: null,
        action: false,
      };
    case 'denied':
      return {
        status: 'Blocked',
        tone: 'warning',
        // Names the remedy AND who owns it. OathPath cannot re-ask for a
        // permission a browser has refused, so "try again here" would be a lie
        // — the same line `NotificationSettings`' denied banner takes.
        body:
          'Your browser is blocking notifications from this site, and OathPath cannot undo that — only you can.',
        remedy:
          'Open the site permissions from the icon in your address bar, allow notifications, then reload this page. Email notifications are unaffected either way.',
        action: false,
      };
    case 'unsupported':
      return {
        status: 'Not supported',
        tone: 'default',
        body:
          'This browser cannot show notifications. They need a browser that supports them, over a secure (https) connection.',
        remedy: 'Email notifications are unaffected, and you can choose those now.',
        action: false,
      };
    case 'default':
    default:
      return {
        status: 'Not asked yet',
        tone: 'default',
        body:
          'Your browser has not been asked for permission yet, so nothing can reach you here. Allowing it lets a study reminder arrive while this tab is in the background.',
        remedy: null,
        action: true,
      };
  }
}

// =============================================================================
// Sound
// =============================================================================

/**
 * What the last "Play a test tone" press did.
 *
 * `output` is `peekSharedAudioContextState()` read AFTER the cue was scheduled,
 * which is the only way to tell "it played" from "the browser has this page's
 * audio suspended, so it made no sound and said nothing about it".
 */
export type SoundTest =
  | { kind: 'idle' }
  | { kind: 'played'; output: AudioOutputState };

export function soundRowPresentation(test: SoundTest): RowPresentation {
  if (test.kind === 'idle') {
    return {
      status: 'Not tested',
      tone: 'default',
      body:
        'Hands-free practice uses short chimes to tell you when the microphone opens and when your answer has landed — the only signal there is when you are not looking at the screen.',
      remedy: null,
      action: true,
    };
  }

  switch (test.output) {
    case 'running':
      return {
        status: 'Tone played',
        tone: 'success',
        body: 'That was the rising chime that means the microphone is open.',
        // The three things that actually cause silence on a phone, in the order
        // they catch people out. A learner who heard nothing needs somewhere to
        // look, and "check your sound settings" is not somewhere.
        remedy:
          'If you heard nothing: check the silent switch on the side of your phone, turn the volume up, and check whether the sound is going to headphones or a Bluetooth speaker in another room.',
        action: true,
      };
    case 'suspended':
      return {
        status: 'Audio paused',
        tone: 'warning',
        body:
          'Your browser has paused audio for this page, so the tone made no sound.',
        remedy: 'Press the button once more — a second press usually resumes it. If it does not, reload the page and try again.',
        action: true,
      };
    case 'closed':
    case 'none':
    default:
      return {
        status: 'Not available',
        tone: 'default',
        body:
          'This browser will not give the page an audio channel, so you will not hear the practice chimes here.',
        // Says what still works, because it is most of what matters: the cues
        // are a courtesy on top of a session that runs without them, and
        // questions are read aloud by a different mechanism entirely.
        remedy:
          'Everything else still works, including questions read aloud — the browser speaks those itself, through a different mechanism.',
        action: true,
      };
  }
}

// =============================================================================
// Component
// =============================================================================

export interface DevicePermissionsSettingsProps {
  /** Everything the microphone row needs. See {@link MicrophoneRowInput}. */
  microphone: MicrophoneRowInput;
  /** Opens the browser's microphone prompt. THE ONLY `getUserMedia` caller. */
  onAllowMicrophone: () => void;

  /** `useBrowserNotificationPermission().permission`. */
  notificationPermission: BrowserNotificationPermission;
  /** Opens the browser's notification prompt. */
  onRequestNotificationPermission: () => void;
  isRequestingNotificationPermission: boolean;

  /** The last test tone's outcome. */
  soundTest: SoundTest;
  onPlayTestTone: () => void;
}

export function DevicePermissionsSettings({
  microphone,
  onAllowMicrophone,
  notificationPermission,
  onRequestNotificationPermission,
  isRequestingNotificationPermission,
  soundTest,
  onPlayTestTone,
}: DevicePermissionsSettingsProps) {
  const microphoneRow = microphoneRowPresentation(microphone);
  const notificationRow = notificationRowPresentation(
    notificationPermission,
    isRequestingNotificationPermission,
  );
  const soundRow = soundRowPresentation(soundTest);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <DeviceRow
        icon={<MicNoneIcon color="action" />}
        title="Microphone"
        purpose="Needed to answer out loud, in practice and in a mock interview. Typing works without it."
        presentation={microphoneRow}
        action={
          <Button
            variant="outlined"
            onClick={onAllowMicrophone}
            disabled={microphone.request.kind === 'requesting'}
            startIcon={
              microphone.request.kind === 'requesting' ? (
                <CircularProgress size={16} />
              ) : undefined
            }
          >
            {/* The label names the ACTION, not an outcome. "Enable" would
                over-promise: this button opens the browser's own prompt, and
                the browser — not this app — decides what happens next. */}
            {microphone.request.kind === 'requesting'
              ? 'Waiting for your browser…'
              : 'Allow microphone'}
          </Button>
        }
      />

      <DeviceRow
        icon={<NotificationsNoneIcon color="action" />}
        title="Notifications"
        purpose="Lets a study reminder reach you when this tab is in the background."
        presentation={notificationRow}
        action={
          <Button
            variant="outlined"
            onClick={onRequestNotificationPermission}
            disabled={isRequestingNotificationPermission}
            startIcon={
              isRequestingNotificationPermission ? (
                <CircularProgress size={16} />
              ) : undefined
            }
          >
            {isRequestingNotificationPermission
              ? 'Waiting for your browser…'
              : 'Allow notifications'}
          </Button>
        }
        // OUTSIDE the live region — see `DeviceRow`. This link is the answer to
        // the question the row raises and never answers: permission is the
        // browser-level grant, and WHICH events use it is a different screen.
        footer={
          <Typography variant="body2" color="text.secondary">
            Choose which events notify you, and whether they arrive by email or
            in your browser, on the{' '}
            <Link component={RouterLink} to="/settings/notifications">
              Notifications
            </Link>{' '}
            screen.
          </Typography>
        }
      />

      <DeviceRow
        icon={<VolumeUpIcon color="action" />}
        title="Sound"
        purpose="Used for the short chimes that mark each step of a hands-free session."
        presentation={soundRow}
        action={
          <Button variant="outlined" onClick={onPlayTestTone}>
            Play a test tone
          </Button>
        }
        footer={
          <Typography variant="body2" color="text.secondary">
            {/* SAID OUT LOUD, because the button deliberately ignores the
                preference (see `playEarconIgnoringPreference`). A learner who
                turned the cues off and then hears one has to be told why, or
                the switch looks broken. */}
            This test tone plays even if you have turned practice sound cues
            off. Whether the cues sound during a session is set on the{' '}
            <Link component={RouterLink} to="/settings/voice">
              Voice
            </Link>{' '}
            screen.
          </Typography>
        }
      />
    </Box>
  );
}

interface DeviceRowProps {
  icon: ReactNode;
  title: string;
  /** Why this permission exists, in one sentence. STATIC — never announced. */
  purpose: string;
  presentation: RowPresentation;
  action: ReactNode;
  footer?: ReactNode;
}

/**
 * One card: what this is for, what is true now, and the one thing to press.
 *
 * THE LIVE REGION IS ALWAYS MOUNTED and holds only the state — the chip, the
 * body sentence and the remedy. Two rules are being kept here at once:
 *
 *   1. A region inserted into the DOM at the same moment as its text is
 *      frequently never announced at all, which is why it is here on every
 *      render rather than rendered alongside a result.
 *   2. It contains NO BUTTON AND NO LINK. Everything inside a live region is
 *      re-announced when any of it changes, so a control in there would be read
 *      out again on every state change — and a permission state can change from
 *      another tab, with nobody touching this page.
 *
 * The static `purpose` line sits outside it for the same reason: it never
 * changes, so announcing it would be repeating something the learner has
 * already heard.
 */
function DeviceRow({
  icon,
  title,
  purpose,
  presentation,
  action,
  footer,
}: DeviceRowProps) {
  return (
    <Card>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          {/* Decorative: the heading beside it already carries the name, and a
              second reading of "microphone" helps nobody. */}
          <Box aria-hidden sx={{ display: 'flex' }}>
            {icon}
          </Box>
          {/* `h2` under the page's single `h1`. Three sibling rows, three `h2`s
              — no level is skipped and none is used for its size. */}
          <Typography variant="h6" component="h2">
            {title}
          </Typography>
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: '62ch' }}>
          {purpose}
        </Typography>

        <Box role="status" aria-live="polite" sx={{ mt: 2 }}>
          <Chip
            size="small"
            label={presentation.status}
            color={presentation.tone === 'default' ? undefined : presentation.tone}
            variant={presentation.tone === 'default' ? 'outlined' : 'filled'}
          />
          <Typography variant="body2" sx={{ mt: 1, maxWidth: '62ch' }}>
            {presentation.body}
          </Typography>
          {presentation.remedy && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 1, maxWidth: '62ch' }}
            >
              {presentation.remedy}
            </Typography>
          )}
        </Box>

        {presentation.action && <Box sx={{ mt: 2 }}>{action}</Box>}

        {footer && <Box sx={{ mt: 2 }}>{footer}</Box>}
      </CardContent>
    </Card>
  );
}

export default DevicePermissionsSettings;

/**
 * Can this device run a spoken session — asked BEFORE the learner commits.
 *
 * Issue #349, epic #345. Until this hook, nothing in `apps/web/src` read
 * `navigator.permissions`, nothing called `enumerateDevices()`, and nothing
 * looked at the shared `AudioContext`'s state. The first thing that discovered
 * a blocked microphone was `getUserMedia` itself — which runs *after* a learner
 * has tapped "Start hands-free", i.e. after they have committed to a hands-free
 * session, put a phone in a pocket, and started walking.
 *
 * =============================================================================
 * IT REPORTS THE EXISTING NAMED PROBLEMS. IT INVENTS NO NEW COPY.
 * =============================================================================
 *
 * `useAudioCapture`'s header argues that seven distinct problems have seven
 * distinct one-step fixes, and that collapsing them into one "microphone
 * unavailable" sentence sends a learner whose headset is unplugged off to
 * change a permission that was never the problem. A preflight that wrote its
 * own message would undo that argument at the one moment it matters most —
 * earlier, where the learner still has a free hand to act on the remedy.
 *
 * So {@link MediaReadiness.problem} is an {@link AudioCaptureProblem} built by
 * `describeCaptureProblem`, verbatim, from the same table `fail()` reads. There
 * is no eighth code and no preflight-specific wording. What this hook adds is
 * only WHEN the question is asked, never WHAT the answer says.
 *
 * Three of the seven are reachable from here, and the other four are not, which
 * is a fact about what can be known without a prompt rather than an omission:
 *
 *   insecure_origin       `preflightCaptureProblem()` — a fact about the URL
 *   unsupported           `preflightCaptureProblem()` — a fact about the browser
 *   permission_denied     the Permissions API said `denied`
 *   no_device             `enumerateDevices()` found no `audioinput`
 *   ---
 *   permission_dismissed  needs a prompt to have been opened and closed
 *   device_in_use         only `getUserMedia` can discover it
 *   recording_too_short   only a finished recording can be too short
 *
 * =============================================================================
 * "UNKNOWN" IS NOT "DENIED". THIS IS THE LOAD-BEARING DISTINCTION.
 * =============================================================================
 *
 * `navigator.permissions.query({ name: 'microphone' })` is not universally
 * supported: Safari has never shipped the `microphone` name, older WebKit
 * throws a synchronous `TypeError` for an unrecognised one rather than
 * rejecting, and the whole `permissions` object is absent in jsdom and in some
 * embedded browsers. Every one of those outcomes lands on `'unknown'` — a
 * FOURTH value the Web API does not have — and `'unknown'` NEVER produces a
 * problem.
 *
 * Resolving an unknown to `'denied'` would put "your browser is blocking the
 * microphone for this site" on the screen of every Safari user whose microphone
 * works perfectly, and send them to a permission setting that is not set. That
 * is worse than saying nothing: it is a confident, specific, wrong instruction,
 * and the learner has no way to tell it from a true one. The safe direction
 * here is the opposite of `useVoiceAvailability`'s (which resolves an unknown
 * binding to "no voice"), because the costs are not symmetric — there, an
 * unknown hides an optional control; here, an unknown would accuse the learner's
 * browser of something it has not done.
 *
 * The same rule governs devices: `hasAudioInput` is `boolean | null`, and only
 * `false` — an enumeration that succeeded and found no `audioinput` — is
 * `no_device`. A `null` (no `enumerateDevices`, or a call that threw) reports
 * nothing.
 *
 * =============================================================================
 * IT NEVER PROMPTS. THE PROMPT BELONGS TO A DELIBERATE TAP.
 * =============================================================================
 *
 * `useBrowserNotificationPermission`'s first rule, reused unchanged for a second
 * permission: this hook never calls `getUserMedia`, and merely rendering a
 * screen that mounts it must never raise the browser's microphone dialogue.
 * Both APIs it does call are observational — `permissions.query` and
 * `enumerateDevices` are specified not to prompt — and the third signal is a
 * peek at an `AudioContext` that already exists (see
 * {@link peekSharedAudioContextState}, which is non-creating for exactly this
 * reason).
 *
 * A prompt fired by opening the practice picker would also be a prompt the
 * learner cannot connect to anything they asked for, and a dismissed or denied
 * one is expensive: it is the app's one chance, and only the learner can undo
 * it, from a browser menu.
 *
 * =============================================================================
 * IT UPDATES WITHOUT A RELOAD
 * =============================================================================
 *
 * A learner who reads "your browser is blocking the microphone", follows the
 * remedy in another tab, and comes back must not still be looking at the
 * blocked message — they would reasonably conclude the product is broken. So
 * the value is state, refreshed on the three signals that can indicate a
 * change, exactly as `useBrowserNotificationPermission` does for its own:
 *
 *   1. `PermissionStatus`'s `change` event — the exact, immediate signal, and
 *      the one that carries a grant made in ANOTHER TAB.
 *   2. `devicechange` on `navigator.mediaDevices` — a headset plugged in.
 *   3. `visibilitychange`, the fallback for browsers with neither, and the
 *      moment a learner who just changed a setting comes back.
 *
 * =============================================================================
 * `recheck()` IS SYNCHRONOUS, AND THAT IS DELIBERATE
 * =============================================================================
 *
 * The second moment this hook is surfaced at is the instant before Start arms
 * the loop, because permission can be revoked between the picker and the tap.
 * That check must not `await` anything: the tap is the user gesture that lets
 * the page play audio at all, and a caller that awaited a device enumeration
 * before calling `conversation.start()` would be spending that gesture on a
 * promise. So {@link MediaReadiness.recheck} re-reads the two signals that CAN
 * be read synchronously — the platform preflight, and `PermissionStatus.state`
 * off the live status object this hook already holds — returns the problem (or
 * `null`) immediately, and schedules the asynchronous device probe for next
 * time. A device unplugged in that window is still caught, one layer down, by
 * `getUserMedia`'s own `NotFoundError`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  describeCaptureProblem,
  preflightCaptureProblem,
  type AudioCaptureProblem,
} from './useAudioCapture';
import { peekSharedAudioContextState } from '../lib/earcons';
import { useIsMounted } from './useIsMounted';

/**
 * The microphone permission as this app has to reason about it.
 *
 * `'unknown'` is a FOURTH state the Web API does not have, and it is not
 * `'denied'` — see the file header. It means "this browser did not tell us",
 * which is the ordinary case on Safari and the universal case under the test
 * runner.
 */
export type MicrophonePermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/** What the shared `AudioContext` is doing. `'none'` means there isn't one. */
export type AudioOutputState = AudioContextState | 'none';

export interface MediaReadiness {
  /** What the Permissions API says right now. See {@link MicrophonePermission}. */
  permission: MicrophonePermission;
  /**
   * Is there an audio input attached? `null` means we could not tell.
   *
   * PRESENCE, NOT NAMING. `enumerateDevices()` returns entries with empty
   * `label`s until permission has been granted, so nothing here reads a label
   * or offers a choice between devices — that is explicitly out of scope for
   * #349. Counting `kind === 'audioinput'` entries works before permission on
   * every browser this product supports, because they all expose a placeholder
   * entry for a device that exists.
   */
  hasAudioInput: boolean | null;
  /**
   * The shared `AudioContext`'s state, without creating one.
   *
   * `'none'` on a screen that has not played a cue yet, which is the normal
   * case on the picker and is not a problem.
   */
  audioOutputState: AudioOutputState;
  /**
   * The earcons would be silent: a context exists and the browser has suspended
   * it. Worth saying out loud, because a suspended context makes `playEarcon`
   * an unannounced no-op — the rising cue that tells a walking learner the
   * microphone is open simply never sounds, and nothing else on the screen
   * changes.
   */
  isAudioOutputSuspended: boolean;
  /**
   * The one named problem to render, or `null` to go ahead.
   *
   * `describeCaptureProblem`'s copy, verbatim. See the file header for which
   * three of the seven codes are reachable from a preflight and why.
   */
  problem: AudioCaptureProblem | null;
  /** True until the first asynchronous probe settles, success or failure. */
  isChecking: boolean;
  /**
   * Re-read every signal that can be read synchronously and return the problem.
   *
   * FOR THE MOMENT BEFORE START. Synchronous on purpose — see the file header.
   * It also schedules the asynchronous probe, so the rendered state catches up
   * a tick later.
   */
  recheck: () => AudioCaptureProblem | null;
}

/**
 * The precedence, in one place so the two readers cannot disagree.
 *
 * THE ORDER IS THE POINT, twice over:
 *
 *   1. The platform checks come first, for `preflightCaptureProblem`'s own
 *      reason — an insecure origin DELETES `navigator.mediaDevices`, so asking
 *      about devices first would report `unsupported` on a capable browser.
 *   2. `permission_denied` outranks `no_device`, because a denied permission is
 *      exactly the state in which several browsers stop reporting devices at
 *      all. Telling a learner who blocked the site to go and buy a microphone
 *      is the wrong-remedy failure this whole union exists to prevent.
 */
function problemFor(
  permission: MicrophonePermission,
  hasAudioInput: boolean | null,
): AudioCaptureProblem | null {
  const platform = preflightCaptureProblem();
  if (platform) return describeCaptureProblem(platform);
  if (permission === 'denied') return describeCaptureProblem('permission_denied');
  // ONLY an explicit `false`. `null` is "we could not tell", and an unknown is
  // never an accusation — see the file header.
  if (hasAudioInput === false) return describeCaptureProblem('no_device');
  return null;
}

/**
 * Read a live `PermissionStatus`, defensively.
 *
 * The `try` is not decorative: privacy-hardened builds expose the object and
 * throw on the property access, and this runs on the path that is about to
 * start a practice session.
 */
function readStatus(status: PermissionStatus | null): MicrophonePermission {
  if (!status) return 'unknown';
  try {
    const state = status.state as string;
    return state === 'granted' || state === 'denied' || state === 'prompt'
      ? state
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function useMediaReadiness(): MediaReadiness {
  const isMounted = useIsMounted();

  const [permission, setPermission] = useState<MicrophonePermission>('unknown');
  const [hasAudioInput, setHasAudioInput] = useState<boolean | null>(null);
  const [audioOutputState, setAudioOutputState] = useState<AudioOutputState>(() =>
    peekSharedAudioContextState(),
  );
  const [isChecking, setIsChecking] = useState(true);

  /**
   * The live status object, kept so `recheck()` can read `state` synchronously.
   *
   * This is what makes the pre-Start check a real re-check rather than a replay
   * of what was true when the picker rendered: `PermissionStatus.state` is a
   * live property, so reading it again reads the browser again.
   */
  const statusRef = useRef<PermissionStatus | null>(null);
  /** Mirrors `hasAudioInput`, for the same synchronous read. */
  const hasAudioInputRef = useRef<boolean | null>(null);
  hasAudioInputRef.current = hasAudioInput;

  const readAudioOutput = useCallback(() => {
    const next = peekSharedAudioContextState();
    setAudioOutputState((current) => (current === next ? current : next));
  }, []);

  /**
   * Ask the two asynchronous questions.
   *
   * NEVER REJECTS AND NEVER PROMPTS. Both calls are observational; every way
   * either can fail — absent API, synchronous throw, rejected promise — lands
   * on the unknown that produces no problem.
   */
  const probe = useCallback(async () => {
    const devices = navigator?.mediaDevices;

    // ---- devices: presence, never naming ---------------------------------
    let inputs: boolean | null = null;
    try {
      if (devices?.enumerateDevices) {
        const list = await devices.enumerateDevices();
        inputs = Array.isArray(list)
          ? list.some((device) => device.kind === 'audioinput')
          : null;
      }
    } catch {
      // An enumeration that threw tells us nothing about the learner's
      // hardware, so it must not be reported as missing hardware.
      inputs = null;
    }

    // ---- permission: observed, never requested ---------------------------
    // The `try` wraps the CALL, not only the promise: older WebKit throws a
    // synchronous `TypeError` for an unsupported permission name, and an
    // exception escaping here would blank a practice screen over a progressive
    // enhancement.
    let status: PermissionStatus | null = null;
    try {
      // `navigator.permissions` is typed as always present and is genuinely
      // absent in jsdom and in some embedded browsers, so the optional chain
      // is load-bearing at runtime even where the compiler thinks it is not.
      const permissions = navigator?.permissions as Permissions | undefined;
      if (permissions) {
        status = await permissions.query({
          name: 'microphone' as PermissionName,
        });
      }
    } catch {
      status = null;
    }

    if (!isMounted()) return;

    if (status) statusRef.current = status;
    setPermission(readStatus(status));
    setHasAudioInput(inputs);
    hasAudioInputRef.current = inputs;
    readAudioOutput();
    setIsChecking(false);
  }, [isMounted, readAudioOutput]);

  const recheck = useCallback((): AudioCaptureProblem | null => {
    // Live reads, both of them: the platform check is pure, and
    // `PermissionStatus.state` is a live property on an object the browser
    // updates in place.
    const fresh = readStatus(statusRef.current);
    setPermission(fresh);
    readAudioOutput();
    // The device list is the one signal that cannot be read synchronously.
    // Scheduled, not awaited — see the file header.
    void probe();
    return problemFor(fresh, hasAudioInputRef.current);
  }, [probe, readAudioOutput]);

  useEffect(() => {
    void probe();

    const onVisibility = () => {
      // Only on the return. Re-reading as the tab HIDES is work nobody can see,
      // and the interesting transition is a learner coming back from the
      // browser settings they were just sent to.
      if (document.visibilityState === 'visible') void probe();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // A headset plugged in or pulled out. Optional everywhere; `visibilitychange`
    // remains the fallback.
    const devices = navigator?.mediaDevices;
    const onDeviceChange = () => void probe();
    devices?.addEventListener?.('devicechange', onDeviceChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      devices?.removeEventListener?.('devicechange', onDeviceChange);
    };
  }, [probe]);

  /**
   * The permission changed — in this tab or in ANOTHER ONE.
   *
   * Bound in its own effect, keyed on the status object, because `probe()` is
   * what discovers that object and it may be discovered several times over a
   * screen's life (a `visibilitychange` re-query hands back a new one on some
   * engines). Re-reading rather than trusting the event's target keeps the one
   * source of truth at `statusRef`.
   */
  useEffect(() => {
    const status = statusRef.current;
    if (!status) return;
    const onChange = () => {
      if (!isMounted()) return;
      setPermission(readStatus(statusRef.current));
    };
    status.addEventListener?.('change', onChange);
    return () => status.removeEventListener?.('change', onChange);
    // `permission` and `isChecking` are the two states a successful probe
    // settles, so this re-runs exactly when a new status object may have
    // arrived — never on every render.
  }, [isMounted, permission, isChecking]);

  /**
   * THERE IS NO `statechange` LISTENER ON THE SHARED CONTEXT, deliberately.
   *
   * Attaching one would mean holding the context object, and the only way to
   * obtain it is `getSharedAudioContext()` — which CREATES one when none
   * exists, on a screen that has not made a sound. That is precisely the
   * side effect {@link peekSharedAudioContextState} was added to avoid, and
   * paying it to hear about a state we can simply re-read would trade the
   * hook's central promise for a refresh we already have three routes to.
   *
   * The routes: `visibilitychange` above (which is what a backgrounded,
   * auto-suspended context looks like from the page's side, and therefore
   * covers the case that actually happens), the `devicechange` probe, and
   * `recheck()` on the tap before Start.
   */

  return {
    permission,
    hasAudioInput,
    audioOutputState,
    isAudioOutputSuspended: audioOutputState === 'suspended',
    problem: problemFor(permission, hasAudioInput),
    isChecking,
    recheck,
  };
}

export default useMediaReadiness;

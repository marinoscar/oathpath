/**
 * `useWakeLock` — keep the screen awake for as long as a spoken session is
 * running, and be honest about the case it cannot save.
 *
 * Issue #310, epic #304 / E13 ("Conversation mode"). Re-homed by issue #388.
 *
 * =============================================================================
 * THE SCREEN GOING DARK DOES NOT DIM A SESSION. IT SUSPENDS IT.
 * =============================================================================
 *
 * A spoken session is a loop: listen, transcribe, grade, speak, listen again —
 * whether this application drives it turn by turn (E13's request/response
 * loop) or a live model does (E15's realtime transport). A learner practising
 * hands-free is not touching the screen for minutes at a time — that is the
 * feature, not an edge case — which is precisely the input every mobile
 * browser uses to decide the device has been abandoned. The default display
 * timeout on a phone is somewhere around thirty seconds, and when it fires the
 * page is not merely dimmed: timers are throttled to a crawl or stopped,
 * `MediaRecorder` stops delivering, audio output is cut. The loop does not
 * slow down, it stops, mid-question, having given no warning.
 *
 * From the learner's side that is identical to the app crashing. They were
 * answering a question, nothing came back, and the screen is black. So the
 * screen wake lock is requested for the whole time a spoken session is under
 * way, and released the moment it is not — a wake lock held after the session
 * ends is a flat battery, and a product that flattens a phone during a study
 * session does not get opened again on the bus.
 *
 * =============================================================================
 * ONE OWNER, ONE LOCK: THE PAGE, NEVER A DRIVER (#388)
 * =============================================================================
 *
 * This hook has exactly ONE call site, and it is `PracticeSessionPage`, gated
 * on "a voice session is under way" — `conversation.isRunning` OR
 * `realtimeSessionIsUnderWay(realtime.stage)`. `useWakeLock.test.ts` reads the
 * source tree and fails on a second one. That is not tidiness; it is the fix
 * for two distinct bugs, one shipped and one waiting:
 *
 *  1. **The shipped one.** The call used to live inside
 *     `useConversationSession`, gated on that driver's phase. On the realtime
 *     transport that driver is mounted and never runs, so the phase stayed
 *     `idle` and the lock was never requested at all — the screen went dark on
 *     the one path that ALSO holds a metered WebRTC connection, so a suspended
 *     tab kept billing the learner's own AI key while nothing happened.
 *  2. **The one a second call site would create.** Two hooks each requesting a
 *     lock is two sentinels. Across a mid-session fallback — a realtime
 *     session that drops, re-mints, gives up and lands on E13's loop — their
 *     held spans would overlap, and the loser is released by nobody until the
 *     tab closes. With one requester the flag simply flips true → false → true
 *     on the same hook: a release and then a re-acquire, in that order, never
 *     an overlap.
 *
 * A driver that needs to know about the lock should be handed the state, not
 * ask for its own.
 *
 * =============================================================================
 * WHAT THIS DOES NOT FIX, STATED PLAINLY: THE PHONE IN THE POCKET
 * =============================================================================
 *
 * A screen wake lock keeps the display on. It does not, and cannot, keep a
 * LOCKED device awake. If the learner presses the power button, or puts the
 * phone in a pocket where the proximity sensor and the lock button do their
 * work, the operating system suspends the tab outright: timers stop, audio
 * stops, `MediaRecorder` stops, and the browser drops the wake lock sentinel on
 * its way down. Nothing this hook — or any web API — can do prevents that. A
 * native app with a background audio session can; a web page cannot.
 *
 * This is a PLATFORM CONSTRAINT, NOT A DEFECT, and it is written here so that
 * the next person to read a bug report saying "conversation mode dies when I
 * pocket my phone" recognises it as the documented limit rather than spending a
 * day hunting a race condition that does not exist. The wake lock is the
 * mitigation for the common case — screen on, phone in hand or propped up —
 * and the honest scope of the fix is exactly that. The product answer to the
 * pocket case is copy telling the learner to keep the screen on, not more code
 * here.
 *
 * =============================================================================
 * THREE WAYS THIS IS UNAVAILABLE, AND ALL THREE ARE NON-EVENTS
 * =============================================================================
 *
 * `navigator.wakeLock` is absent on Firefox and on older Safari; a request can
 * be rejected outright (a low battery, a policy, a hidden document); and a
 * sentinel already held is released BY THE BROWSER whenever the tab goes
 * hidden, which happens on every app switch and every incoming notification —
 * so the sentinel is re-requested on the way back to visible, or a learner who
 * glanced at a message returns to a session that is once again thirty seconds
 * from going dark.
 *
 * None of the three surfaces to the learner. There is no error state, nothing
 * is thrown, and no message is shown: a wake lock is an optimisation on a
 * session that works without it, and telling somebody "screen wake lock
 * unavailable" hands them a sentence they can neither act on nor ignore. The
 * hook reports `isSupported` and `isHeld` for a caller that wants to nudge
 * ("keep your screen on") — never for an error banner.
 *
 * `PracticeSessionPage` is that caller, and it nudges on `isSupported` rather
 * than on `isHeld`, deliberately: `isHeld` is false on every tab switch by
 * design, and a warning that appears and disappears with the notification
 * shade is noise. `isSupported` is the durable fact.
 *
 * =============================================================================
 * THE `<video>` FALLBACK IS REJECTED, ON PURPOSE, WITH THE REASONS (#388)
 * =============================================================================
 *
 * The long-standing workaround for a browser with no Screen Wake Lock API is
 * to play a muted, looping, `playsinline`, one-frame video for the life of the
 * session (NoSleep.js's trick) and let the platform's "don't sleep during
 * video" heuristic do the work. It was considered for exactly the browsers the
 * section above names, and it is NOT shipped. Five reasons, in the order they
 * decided it:
 *
 *  1. **IT WOULD TRADE AN HONEST WARNING FOR A SILENT PROMISE.** Today an
 *     unsupported browser gets a sentence telling the learner the one thing
 *     that works: keep the page open. A fallback would replace that sentence
 *     with a mechanism — and on the day the mechanism stops working (see 2)
 *     the learner gets neither. A degradation that removes the warning is
 *     worse than no degradation, and this module's whole posture is being
 *     honest about the case it cannot save.
 *  2. **IT IS UNVERIFIABLE FROM HERE.** The trick is not a specified
 *     behaviour; it is a side effect of a heuristic, per platform, per
 *     version, and it has been quietly narrowed more than once (iOS Low Power
 *     Mode pauses the video outright; several versions require a user gesture
 *     to start it and again after any interruption). jsdom has no media
 *     pipeline, so CI can only ever assert that an element exists — never that
 *     it keeps a real screen on. Shipping a fix whose only test is "we
 *     appended a tag" is how a regression goes unnoticed for a release.
 *  3. **ON THE TRANSPORT THAT MOTIVATED THIS FIX, IT ENDANGERS THE THING IT
 *     PROTECTS.** A realtime session is already a WebRTC `<audio>` element
 *     plus, on some paths, `speechSynthesis`. Adding a third, permanently
 *     decoding media element to that graph risks the audio route and the
 *     session's focus on exactly the mobile browsers in question. A fix for a
 *     dark screen that can silence the coach is a worse bug than the one it
 *     closes.
 *  4. **THE POPULATION IT WOULD SERVE IS SMALL AND SHRINKING.** Chrome and
 *     Edge have had the API since 84, Safari since 16.4. What is left is
 *     Firefox and pre-16.4 iOS — and on the latter the gesture requirement in
 *     2 means the fallback would frequently not start at all, which is 1
 *     again.
 *  5. **IT COSTS BATTERY AND DATA TO DO NOTHING VISIBLE.** A decoding video
 *     for the length of a study session is a real cost on the same device this
 *     hook exists to keep usable, and it is paid by every learner on those
 *     browsers whether or not the heuristic ever fires.
 *
 * If it is ever revisited, the bar is a way to OBSERVE that it worked — not a
 * way to assert the element is on the page — and it must be additive to the
 * warning above, never a replacement for it.
 *
 * =============================================================================
 * DECLARATIVE, NOT `request()` / `release()`
 * =============================================================================
 *
 * The hook takes a boolean — hold a lock, or do not — instead of exposing
 * imperative acquire/release calls. Two reasons, and they are the same reason
 * twice: a caller that must remember to release on every exit path will
 * eventually miss one (an early return, a thrown render, a route change), and
 * that miss is a battery drain nobody notices in review; and unmount cleanup
 * then has to be duplicated by every caller instead of living here once. With
 * a flag, "release on exit" and "release on unmount" are the same line of code,
 * and there is one source of truth about whether a lock is wanted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useIsMounted } from './useIsMounted';

/** What the caller can see. Never enough to build an error message from. */
export interface UseWakeLockState {
  /** Does this browser expose the Screen Wake Lock API at all? */
  isSupported: boolean;
  /** Is a sentinel held right now? False whenever the tab is hidden. */
  isHeld: boolean;
}

/**
 * `navigator.wakeLock` is typed as always present, which is exactly wrong for
 * the browsers that matter here. `Partial<Navigator>` restores the honest
 * shape, and the `request` check catches a stub that is present but useless.
 */
function getWakeLockApi(): WakeLock | null {
  if (typeof navigator === 'undefined') return null;
  const api = (navigator as Partial<Navigator>).wakeLock;
  return typeof api?.request === 'function' ? api : null;
}

/**
 * Hold a screen wake lock for as long as `enabled` is true.
 *
 * @param enabled Whether a lock is wanted — "a spoken session is under way",
 *   asked of every transport rather than of one driver (#388). Releasing on
 *   exit and on unmount both follow from this being false or the component
 *   going away; see the file header.
 */
export function useWakeLock(enabled: boolean): UseWakeLockState {
  const [isHeld, setIsHeld] = useState(false);
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  /**
   * Whether a lock is still wanted, readable from an async continuation.
   * `request()` is a promise: conversation mode can end, or the component
   * unmount, while one is in flight, and the sentinel that arrives afterwards
   * must be released immediately rather than held by nobody until the tab
   * closes. Same shape of problem `useAudioCapture`'s `holdRef` solves for a
   * microphone that arrives after the learner let go.
   */
  const wantedRef = useRef(enabled);
  wantedRef.current = enabled;

  /**
   * Unmount is the second way a request in flight can become unwanted, and it
   * cannot be read from `wantedRef`: nothing re-renders on the way out, so the
   * flag is still whatever the last render set it to. Cleared by
   * `useIsMounted`'s own cleanup — and, under `StrictMode`'s deliberate
   * mount/unmount/mount, set back to true by its effect, which is exactly why
   * this is a mounted ref rather than a `wantedRef.current = false` in the
   * cleanup below. That version would leave a StrictMode remount believing the
   * lock was no longer wanted and release every sentinel it was granted.
   */
  const isMounted = useIsMounted();

  const isSupported = getWakeLockApi() !== null;

  const release = useCallback(() => {
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    setIsHeld(false);
    if (!sentinel) return;
    try {
      void Promise.resolve(sentinel.release()).catch(() => undefined);
    } catch {
      // An already-released sentinel rejects or throws depending on the
      // browser. Either way the lock is gone, which is what we wanted.
    }
  }, []);

  /**
   * True between asking for a lock and being handed one.
   *
   * `sentinelRef` alone cannot answer "is one already coming?", and a second
   * `acquire` during that window produces TWO sentinels — the second
   * overwrites the first in the ref, and the first is then held for the life
   * of the page with nothing left pointing at it to release it. `StrictMode`
   * reaches this on every mount (effect, cleanup, effect), so it is the
   * ordinary path in development, not an exotic race.
   */
  const requestingRef = useRef(false);

  const acquire = useCallback(async () => {
    if (sentinelRef.current || requestingRef.current) return;

    const api = getWakeLockApi();
    if (!api) return;

    // A request made while the document is hidden is rejected by definition.
    // Skipping it keeps a pointless rejected promise out of the console on
    // every tab switch; `visibilitychange` re-requests on the way back.
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden'
    ) {
      return;
    }

    let sentinel: WakeLockSentinel;
    requestingRef.current = true;
    try {
      sentinel = await api.request('screen');
    } catch {
      // Rejected: battery saver, a permissions policy, a backgrounded tab.
      // Non-fatal by design — the session continues, nothing is shown.
      return;
    } finally {
      requestingRef.current = false;
    }

    // Unwanted now, or superseded by a lock that arrived first: either way this
    // sentinel must go back immediately. A held lock nobody has a reference to
    // is released by nothing short of closing the tab.
    if (!wantedRef.current || !isMounted() || sentinelRef.current) {
      try {
        void Promise.resolve(sentinel.release()).catch(() => undefined);
      } catch {
        // Nothing to do; see `release`.
      }
      return;
    }

    sentinelRef.current = sentinel;
    setIsHeld(true);

    // The browser releases the sentinel by itself when the tab is hidden, and
    // tells us here. Without this the hook would believe it still holds a lock
    // it lost, and `acquire`'s early return would then refuse to take a new
    // one when the learner came back.
    sentinel.addEventListener?.('release', () => {
      if (sentinelRef.current !== sentinel) return;
      sentinelRef.current = null;
      setIsHeld(false);
    });
  }, [isMounted]);

  // Hold or drop the lock as the flag changes, and always drop it on unmount.
  useEffect(() => {
    if (!enabled) {
      release();
      return undefined;
    }
    void acquire();
    return release;
  }, [enabled, acquire, release]);

  // Re-acquire on the way back from hidden. See the file header: every app
  // switch and every notification costs the sentinel, and a session that
  // silently stops being protected is the failure this exists to prevent.
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return undefined;

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (!wantedRef.current || sentinelRef.current) return;
      void acquire();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, acquire]);

  return { isSupported, isHeld };
}

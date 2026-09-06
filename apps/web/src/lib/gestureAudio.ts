/**
 * One `<audio>` element, unlocked inside a tap, reused for the life of a
 * component.
 *
 * Issue #389, generalising the fix #383 made in `VoiceSettings.tsx`. Three
 * screens had written the same nine lines three times — and two of them had
 * written them in the order that does not work.
 *
 * =============================================================================
 * THE ORDERING RULE. EVERYTHING IN THIS FILE EXISTS FOR IT.
 * =============================================================================
 *
 * A mobile browser will not let a page make sound unless the element making it
 * was created or played inside a user gesture. A gesture is a WINDOW, not a
 * flag: it closes at the first `await`. Every caller here awaits a synthesis
 * round trip — a second or more — before it has any bytes to play, so the
 * shipped shape at all three sites,
 *
 *     const result = await synthesizeSpeech(text);   // the gesture ends HERE
 *     const audio = new Audio(URL.createObjectURL(result.audio));
 *     await audio.play();                            // …refused
 *
 * asked a brand new, never-touched element to play long after the tap that
 * justified it, and every mobile autoplay policy correctly refused. So:
 *
 *   1. THE ELEMENT IS CLAIMED AND PRIMED SYNCHRONOUSLY IN THE HANDLER, BEFORE
 *      THE FIRST `await` — {@link primeGestureAudio}. That call is what spends
 *      the tap and marks the element as one the learner asked to hear.
 *   2. THE BYTES ARE POURED INTO THAT SAME ALREADY-PERMITTED ELEMENT when they
 *      arrive — {@link playPreparedSample}, which takes the element rather than
 *      making one. The unlock is granted per ELEMENT, so building a fresh
 *      `Audio` per press throws away what the previous press earned.
 *
 * **Moving the prime call below an `await`, hoisting it into a `useEffect`, or
 * rebuilding the element between presses restores the bug exactly — and breaks
 * nothing a desktop test would notice.** Desktop browsers and every test double
 * in this repo play fine either way; only a phone can tell the difference, and
 * it tells it by saying nothing at all. That asymmetry is why the rule is
 * written down here at this length rather than left to be re-derived.
 *
 * =============================================================================
 * WHY THE PRIMING CALL HAS A SOURCE, AND WHY IT IS SILENT
 * =============================================================================
 *
 * #383 primed a SOURCELESS element. That is enough on Android Chrome, which
 * grants the unlock on the `play()` call itself — but some browsers, iOS Safari
 * among them, establish it only when playback actually BEGINS, and `play()` on
 * an element with no source rejects before it can begin. A fix that works on
 * one mobile browser and not the other is the failure this generalisation
 * exists to close, so the element is primed against
 * {@link SILENT_PRIMING_SOURCE} — 16 samples of 8 kHz silence, two
 * milliseconds, 60 bytes inline, no network.
 *
 * It is primed MUTED regardless. A page that makes an unrequested noise while
 * spending a gesture is exactly what an autoplay policy exists to punish, and
 * the sample the learner asked for is unmuted later, on the same element, by
 * {@link playPreparedSample}.
 *
 * =============================================================================
 * FEATURE DETECTION: `null` AND `false`, NEVER A THROW
 * =============================================================================
 *
 * jsdom has no media playback and a stripped embedded browser may have no
 * `Audio` constructor or no `URL.createObjectURL` at all. Every entry point
 * here answers that with `null` (no element) or `null` (no attempt), so a
 * caller degrades to the "we couldn't play that sample" copy it already has
 * rather than throwing inside a click handler.
 */

/**
 * Two milliseconds of 8 kHz silence, as a `data:` URI.
 *
 * Inline rather than a file in `public/`: a priming call that has to wait for a
 * network round trip is a priming call that happens after the gesture closed,
 * which is the whole bug. 60 bytes.
 *
 * Exported so a test double can tell the priming `play()` apart from a real
 * one — the two mean opposite things and a double that recorded both as
 * "played" would pass whether or not the fix were present.
 */
export const SILENT_PRIMING_SOURCE =
  'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgICA';

/**
 * The one element, plus whatever sample is currently loaded into it.
 *
 * A single mutable object rather than two `useRef`s per component, so "the
 * element outlives the sample" is a property of one type instead of a
 * convention three components have to keep separately. Hold it in a
 * `useRef(createGestureAudioSlot())`.
 */
export interface GestureAudioSlot {
  /** Built lazily, kept until unmount. Never nulled between presses. */
  element: HTMLAudioElement | null;
  /** The blob URL of the sample currently in `element`, if any. */
  objectUrl: string | null;
}

/** An empty slot. See {@link GestureAudioSlot}. */
export function createGestureAudioSlot(): GestureAudioSlot {
  return { element: null, objectUrl: null };
}

/**
 * Hand back the slot's one element, building it if this is the first call.
 *
 * **Does NOT spend a gesture** — there is no `play()` here. This is for the
 * paths that legitimately have no gesture to spend: `QuestionAudio`'s autoplay,
 * where `voice.readQuestionsAloud` starts a question with no tap at all and the
 * browser-voice fall-through is the correct design (`docs/specs/voice.md` §1).
 * A press path wants {@link primeGestureAudio}, which claims through here and
 * then unlocks.
 *
 * Returns `null` where there is no `Audio` constructor at all.
 */
export function claimGestureAudio(
  slot: GestureAudioSlot,
): HTMLAudioElement | null {
  if (slot.element) return slot.element;
  if (typeof Audio === 'undefined') return null;

  // No source argument: the element must exist BEFORE the bytes do, which is
  // the entire ordering this module is about.
  const audio = new Audio();
  audio.preload = 'auto';
  // iOS reads the ATTRIBUTE. The matching `playsInline` property is typed on
  // video elements only, and an attribute is what the platform honours here
  // anyway. `?.` because a test double need not implement it.
  audio.setAttribute?.('playsinline', '');
  slot.element = audio;
  return audio;
}

/**
 * Claim the element and unlock it for the gesture in progress.
 *
 * **MUST BE CALLED SYNCHRONOUSLY FROM THE EVENT HANDLER, BEFORE THE FIRST
 * `await`.** Everything about this function is that requirement; the file
 * header says what a phone does when it is not met. The muted, two-millisecond
 * `play()` below is not an attempt to make sound — it is the call that spends
 * the tap and marks this element as one the learner asked to hear. Its
 * rejection is expected on browsers that refuse it and is deliberately dropped:
 * whether sound is coming is answered by the real `play()` later, not here.
 *
 * Returns `null` where there is no `Audio` constructor at all, so the caller
 * can say so rather than throwing.
 */
export function primeGestureAudio(
  slot: GestureAudioSlot,
): HTMLAudioElement | null {
  const audio = claimGestureAudio(slot);
  if (!audio) return null;

  // Handlers belonging to a previous sample must not hear this one end two
  // milliseconds from now.
  audio.onended = null;
  audio.onerror = null;
  audio.onplay = null;

  // Muted, because the learner asked to hear a sample that does not exist yet
  // — and because an unmuted priming call is the "page that made a noise I did
  // not ask for" a browser is entitled to punish. Unmuted again in
  // `playPreparedSample`, on this same element.
  audio.muted = true;
  audio.src = SILENT_PRIMING_SOURCE;

  try {
    const started: unknown = audio.play();
    if (started && typeof (started as Promise<void>).catch === 'function') {
      // EXPECTED, AND NOT AN ERROR. Older browsers return `undefined` here,
      // which is why the promise is feature-detected rather than assumed.
      void (started as Promise<void>).catch(() => {});
    }
  } catch {
    // A synchronous throw is the same non-event: the gesture is spent either
    // way, and there is nothing here a learner could act on.
  }

  return audio;
}

/**
 * What a caller gets when the element accepted a sample and was asked to play.
 *
 * `started` is the answer to "did sound actually begin" — deliberately a
 * promise rather than a return value, because the two callers need it at
 * different times. `VoiceSettings` and `CoachSettings` ignore it and report
 * through the callbacks instead: `play()` resolves when playback BEGINS, which
 * behind an autoplay policy (and in jsdom) may be never, so a preview that
 * awaited it would sit on "Preparing…" forever. `QuestionAudio` awaits it,
 * because `true` there means "the premium clip is speaking, do not also read
 * the question in the browser voice".
 */
export interface GestureAudioAttempt {
  /** `true` once playback has begun; `false` if the ask was refused. */
  started: Promise<boolean>;
}

/** What happened to a sample. Three outcomes, never collapsed into one. */
export interface GestureAudioHandlers {
  /** Sound began. Fired from the element's own `play` event. */
  onStarted?: () => void;
  /** The clip reached its end. A genuine completion. */
  onEnded?: () => void;
  /**
   * `play()` was refused — an autoplay policy, most often — so nothing was
   * heard. `started` is all but always `false` here and is passed anyway, so a
   * caller that distinguishes "died mid-clip" from "never began" gets the same
   * fact from both failure callbacks rather than assuming one of them.
   */
  onBlocked?: (started: boolean) => void;
  /**
   * The element has bytes it cannot make sense of, or the media failed.
   * `started` says whether sound had already begun — the one fact only this
   * module holds, and the one a caller's fall-through depends on (#311).
   */
  onDecodeError?: (started: boolean) => void;
}

/**
 * Pour synthesized bytes into an ALREADY-PRIMED element and ask it to play.
 *
 * TAKES THE ELEMENT RATHER THAN MAKING ONE. Constructing an `HTMLAudioElement`
 * here is precisely what put the construction after the synthesis `await` at
 * all three call sites and lost the gesture, so this function's only job is the
 * source, the handlers and the ask. {@link claimGestureAudio} is the only place
 * an element is ever built.
 *
 * Returns `null` when there was nothing here that could play at all — no
 * `URL.createObjectURL`, or a `play()` that threw synchronously. A caller that
 * gets `null` has been told nothing is coming and should say so.
 *
 * THREE OUTCOMES, NOT ONE. Finishing, being refused, and failing to decode are
 * three different things to say to a learner, and collapsing them into a single
 * `onEnd` — which is what two of the three call sites did — is what made a
 * blocked sample byte-identical, on screen, to one that played.
 */
export function playPreparedSample(
  audio: HTMLAudioElement,
  blob: Blob,
  slot: GestureAudioSlot,
  handlers: GestureAudioHandlers,
): GestureAudioAttempt | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null;
  }

  const url = URL.createObjectURL(blob);
  slot.objectUrl = url;

  // Tracked HERE because the element does not report it: `onerror` is the same
  // event whether sound had begun or not, and the difference is what a caller
  // with a fall-through needs (#311).
  let started = false;

  audio.onplay = () => {
    started = true;
    handlers.onStarted?.();
  };
  audio.onended = () => handlers.onEnded?.();
  audio.onerror = () => handlers.onDecodeError?.(started);

  audio.src = url;
  // Unmuted here, and only here: it was muted for the priming call so that
  // spending the gesture could not itself make a noise.
  audio.muted = false;
  try {
    // The element is reused, so it may be sitting at the end of the last
    // sample. A seek before any metadata has loaded can throw, and that is not
    // worth failing a sample over — a fresh source starts at zero anyway.
    audio.currentTime = 0;
  } catch {
    /* Nothing to rewind. */
  }

  let resolveStarted!: (value: boolean) => void;
  const startedPromise = new Promise<boolean>((resolve) => {
    resolveStarted = resolve;
  });

  try {
    const asked: unknown = audio.play();
    if (asked && typeof (asked as Promise<void>).then === 'function') {
      void (asked as Promise<void>).then(
        () => resolveStarted(true),
        () => {
          // The rejection is REPORTED rather than dropped. It is not an error
          // — every caller here has a working fall-through — but it is a
          // different outcome from a sample that played, and the learner is
          // owed the difference.
          resolveStarted(false);
          handlers.onBlocked?.(started);
        },
      );
    } else {
      // Older browsers return `undefined` from `play()`. There is nothing to
      // wait on, so the ask is the answer.
      resolveStarted(true);
    }
  } catch {
    resolveStarted(false);
    handlers.onBlocked?.(started);
    return null;
  }

  return { started: startedPromise };
}

/**
 * Drop the SAMPLE — the bytes, the source and the handlers. **Keeps the
 * element**, which is the whole point (file header, rule 2).
 */
export function releaseGestureSample(slot: GestureAudioSlot): void {
  const audio = slot.element;
  if (audio) {
    // Handlers first: detaching a source can itself raise an error event, and
    // a listener still attached would report it as this sample failing.
    audio.onended = null;
    audio.onerror = null;
    audio.onplay = null;
    audio.pause();
    // `removeAttribute`, not `src = ''`: an empty string resolves against the
    // document URL, so the element would go and try to load the current page as
    // media and report the 404 as a decode error.
    audio.removeAttribute('src');
  }

  const url = slot.objectUrl;
  slot.objectUrl = null;
  if (
    url &&
    typeof URL !== 'undefined' &&
    typeof URL.revokeObjectURL === 'function'
  ) {
    // A blob URL nobody revokes pins its bytes for the lifetime of the
    // document.
    URL.revokeObjectURL(url);
  }
}

/**
 * Let go of the ELEMENT as well. **Unmount only.**
 *
 * Between presses the element is the thing being kept, not the thing being
 * cleaned up — calling this where {@link releaseGestureSample} belongs is
 * exactly how the fix undoes itself, because the next press then starts from
 * an element no gesture has ever unlocked.
 */
export function releaseGestureAudio(slot: GestureAudioSlot): void {
  releaseGestureSample(slot);
  slot.element = null;
}

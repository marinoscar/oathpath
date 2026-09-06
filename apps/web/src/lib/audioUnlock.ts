/**
 * One unlocked `<audio>` element, and the two calls that keep it unlocked.
 *
 * Issue #389, extracting what issue #383 established on `/settings/voice`.
 *
 * =============================================================================
 * WHY THIS IS A MODULE AND NOT THREE COPIES OF AN ORDERING RULE
 * =============================================================================
 *
 * #383 fixed exactly one screen. Two other call sites —
 * `components/settings/CoachSettings.tsx` and `components/voice/QuestionAudio.tsx`
 * — had the identical shape and were left alone, so the same bug shipped twice
 * more with the argument for the fix written down in only one of the three
 * places. That is what this file exists to end: the rule below now has ONE
 * home, and the call sites are short enough to read without it.
 *
 * =============================================================================
 * THE RULE: THE ELEMENT IS PLAYED INSIDE THE GESTURE, BEFORE THE FIRST `await`
 * =============================================================================
 *
 * A mobile browser only plays audio through an element that was itself started
 * during a user gesture. Synthesizing speech is a network round trip, so an
 * element constructed AFTER that `await` is an element the press never
 * touched: Android Chrome and iOS Safari reject its `play()`, and they reject
 * it SILENTLY — from the learner's side the button simply does nothing.
 *
 * So a press does this, in this order, with nothing between:
 *
 *   1. `acquireAndPrimeAudio(audioRef)` — synchronously, in the `onClick`
 *      itself. It takes ONE element (constructing it only the first time) and
 *      plays a data URI of silence through it, then pauses it.
 *   2. Only then does the async half start.
 *   3. `playAudioSample(blob, ctx)` — a round trip later — SWAPS the `src` on
 *      that already-unlocked element. It constructs nothing it can avoid
 *      constructing, and it never primes.
 *
 * A LATER EDIT THAT MOVES THE PRIMING AFTER AN `await` REINTRODUCES #383
 * EXACTLY, and does so invisibly on a desktop browser, where playback after
 * any gesture anywhere in the page is permitted and the whole thing looks like
 * it works.
 *
 * =============================================================================
 * THE SILENCE IS LOAD-BEARING. A SOURCELESS ELEMENT DOES NOT UNLOCK.
 * =============================================================================
 *
 * Some browsers establish the unlock only when playback actually BEGINS, and
 * `play()` on an element with no source rejects before it can begin — so the
 * gesture is spent and nothing is unlocked. Priming therefore assigns
 * {@link SILENT_AUDIO_DATA_URI} first. It is an inline data URI rather than a
 * file precisely so priming can never become a network request: on both
 * settings pages a press costs exactly one synthesis call and nothing else.
 *
 * =============================================================================
 * THE ELEMENT SURVIVES. ONLY THE SAMPLE IS RELEASED.
 * =============================================================================
 *
 * An element only has to be unlocked once, and the activation belongs to the
 * ELEMENT, not to the bytes. A fresh element per play is a fresh lock per play,
 * and the second one was never touched by a gesture — so `releaseAudioSample`
 * pauses, detaches the handlers, drops the `src` and revokes the object URL,
 * and deliberately does NOT null the element. Discarding it is an unmount-only
 * act, and it is the caller's, not this module's.
 *
 * =============================================================================
 * BLOCKED IS NOT ENDED, AND `started` IS NOT A DETAIL
 * =============================================================================
 *
 * `playAudioSample` reports four separate things because its three callers need
 * three different subsets of them, and flattening any of them loses a fix:
 *
 *   - `onEnded` — the clip ran to its own end. #383: collapsing a refusal into
 *     this is what made "your phone would not play this" and "you have just
 *     heard it" the same empty region on `/settings/voice`.
 *   - `onBlocked` — `play()` was refused (an autoplay policy, a muted phone).
 *     Optional, and it falls back to `onError`, never to `onEnded`: a caller
 *     that does not distinguish a refusal from a failure is still structurally
 *     unable to report one as a completion.
 *   - `onError(started)` — the element failed on the bytes. `started` is the
 *     one fact only this function holds (`onerror` is the same event either
 *     way), and issue #311 depends on it: a clip that had already begun is the
 *     end of that play, while one that never began leaves the caller's own
 *     fall-through still ahead of it.
 *   - the returned `{ attached, started }` — `attached` synchronously, for a
 *     caller that must not wait (a `play()` promise resolves when playback
 *     BEGINS, which behind an autoplay policy may be never), and `started` as
 *     a promise for a caller whose next decision depends on the answer.
 *
 * See `components/settings/VoiceSettings.tsx` (#383, the worked example for
 * blocked-vs-ended) and `components/voice/QuestionAudio.tsx` (#311, the worked
 * example for `started`, and the one caller with a path that must NOT prime —
 * `docs/specs/voice.md` §5.2).
 */

/**
 * A few milliseconds of silent WAV, inline.
 *
 * EXPORTED SO A TEST CAN TELL PRIMING FROM PLAYBACK. The `data:` prefix is
 * what separates the unlock from a real sample (a blob URL) from outside the
 * module, and it is the same thing the pause guard below checks.
 */
export const SILENT_AUDIO_DATA_URI =
  'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** A `useRef` holding the one element. Structural, so a test can pass a plain object. */
export interface AudioElementRef {
  current: HTMLAudioElement | null;
}

/** A `useRef` holding the object URL of whatever sample is loaded, if any. */
export interface ObjectUrlRef {
  current: string | null;
}

/** The two refs a caller keeps for the life of its component. */
export interface AudioSampleRefs {
  audioRef: AudioElementRef;
  objectUrlRef: ObjectUrlRef;
}

/** What playback reports back. See the file header for why these are four. */
export interface AudioSampleCallbacks {
  /** Sound has actually begun. Not "the caller pressed a button". */
  onStart?: () => void;
  /** The clip reached its own end. A genuine completion, and only that. */
  onEnded: () => void;
  /**
   * The element failed on the bytes. `started` is true when sound had already
   * begun — the #311 split; see the file header.
   */
  onError: (started: boolean) => void;
  /**
   * `play()` was refused. Optional: a caller that does not distinguish a
   * refusal from a failure gets `onError` instead — never `onEnded`.
   */
  onBlocked?: (started: boolean) => void;
}

/** What `playAudioSample` hands back. See the file header. */
export interface AudioSamplePlayback {
  /** The element took the bytes and `play()` was called. Known synchronously. */
  attached: boolean;
  /**
   * Whether playback actually began. NEVER REJECTS — a refusal resolves
   * `false`, having already run `onBlocked`.
   */
  started: Promise<boolean>;
}

/** Let go of an object URL, if there is one. A URL nobody revokes pins its bytes. */
function revokeObjectUrl(objectUrlRef: ObjectUrlRef): void {
  const url = objectUrlRef.current;
  objectUrlRef.current = null;
  if (!url) return;
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') {
    return;
  }
  URL.revokeObjectURL(url);
}

/**
 * The ONE element, constructed on first use and reused for ever after.
 *
 * DOES NOT PRIME — that is `acquireAndPrimeAudio`'s job and a gesture's alone,
 * which is the whole reason these are two functions. `null` where there is no
 * `Audio` constructor at all (jsdom); the caller falls through to whatever it
 * does when nothing can play.
 */
export function acquireAudioElement(
  audioRef: AudioElementRef,
): HTMLAudioElement | null {
  if (audioRef.current) return audioRef.current;
  if (typeof Audio === 'undefined') return null;

  try {
    audioRef.current = new Audio();
  } catch {
    return null;
  }
  return audioRef.current;
}

/**
 * Acquire the one element and unlock it — CALLED INSIDE A CLICK, NOWHERE ELSE.
 *
 * Playing silence and pausing it is the standard autoplay unlock: it leaves the
 * element user-activated for the rest of its life, so the `src` swap in
 * `playAudioSample` — a network round trip later, long after the gesture has
 * closed — plays instead of being rejected.
 *
 * NEVER THROWS out of a click handler, and never makes a request. It returns
 * `null` only where there is no `Audio` constructor at all; everywhere else it
 * returns the element even if the priming itself was refused, because priming
 * is an optimisation for mobile and not a precondition for anything.
 *
 * NEVER CALL THIS FROM AN EFFECT, a mount, a navigation or a timer. There is no
 * gesture there to spend, and a call site that primes without one reads, to the
 * next person, as a promise this module cannot keep.
 */
export function acquireAndPrimeAudio(
  audioRef: AudioElementRef,
): HTMLAudioElement | null {
  const audio = acquireAudioElement(audioRef);
  if (!audio) return null;

  try {
    // Handlers off: priming is not a sample, and must not report itself as one
    // that started, ended or failed.
    audio.onplay = null;
    audio.onended = null;
    audio.onerror = null;
    audio.src = SILENT_AUDIO_DATA_URI;
    const primedSrc = audio.src;

    const started: unknown = audio.play();
    if (started && typeof (started as Promise<void>).then === 'function') {
      void (started as Promise<void>)
        .then(() => {
          // Only while the silence is still what is loaded. This resolves on
          // its own schedule, and pausing here after the real sample has been
          // swapped in would stop the very audio the press asked for.
          if (audio.src === primedSrc) audio.pause();
        })
        .catch(() => {
          // A browser that refuses even silence tells us nothing actionable
          // here; the real `play()` reports for real, and says so out loud.
        });
    } else {
      audio.pause();
    }
  } catch {
    // jsdom has no playback at all. See the "never a precondition" note above.
  }

  return audio;
}

/**
 * Let go of the SAMPLE — the playback and the bytes — and of nothing else.
 *
 * The element is deliberately kept: it carries the user activation of the press
 * that unlocked it, and a replacement would carry none. See the file header.
 */
export function releaseAudioSample(refs: AudioSampleRefs): void {
  const audio = refs.audioRef.current;
  if (audio) {
    // Off first: a handler still attached while we tear the source down would
    // report an ending or an error that is ours, not the sample's.
    audio.onplay = null;
    audio.onended = null;
    audio.onerror = null;
    try {
      audio.pause();
    } catch {
      // An element that will not pause is not worth failing a press over.
    }
    // Detached before the URL is revoked, so the element is not left holding a
    // handle to bytes we have just released.
    audio.removeAttribute('src');
  }
  revokeObjectUrl(refs.objectUrlRef);
}

/**
 * Point the element at synthesized bytes and ask it to play.
 *
 * IT DOES NOT PRIME. If a gesture already primed the element this reuses it —
 * which is the fix — and if nothing did (an autoplay path, where there is no
 * gesture to prime from) it takes an ordinary, unprimed element and lets the
 * browser decide. Those are the only two cases, and neither one of them is a
 * place to spend a gesture that was not made.
 */
export function playAudioSample(
  blob: Blob,
  ctx: AudioSampleRefs & AudioSampleCallbacks,
): AudioSamplePlayback {
  const audio = acquireAudioElement(ctx.audioRef);
  if (
    !audio ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return { attached: false, started: Promise.resolve(false) };
  }

  // The previous sample's URL goes now, on the swap, not only on release: the
  // element is about to stop pointing at it and nothing else will.
  revokeObjectUrl(ctx.objectUrlRef);

  const url = URL.createObjectURL(blob);
  ctx.objectUrlRef.current = url;

  // Tracked HERE because the element does not report it: `onerror` is the same
  // event whether sound had begun or not, and the difference is #311's.
  let started = false;
  const blocked = ctx.onBlocked ?? ctx.onError;

  audio.onplay = () => {
    started = true;
    ctx.onStart?.();
  };
  audio.onended = () => ctx.onEnded();
  audio.onerror = () => ctx.onError(started);
  audio.src = url;

  try {
    const playing: unknown = audio.play();
    if (playing && typeof (playing as Promise<void>).then === 'function') {
      return {
        attached: true,
        started: (playing as Promise<void>).then(
          () => true,
          () => {
            // `onBlocked`, NOT `onEnded`. A rejection here is a browser
            // refusing to make a sound somebody explicitly asked for, and
            // reporting it as an ordinary ending is what made #383 invisible.
            blocked(started);
            return false;
          },
        ),
      };
    }
    // A browser (or a fake) whose `play()` returns nothing at all. Nothing to
    // wait on, and nothing has been refused.
    return { attached: true, started: Promise.resolve(true) };
  } catch {
    blocked(started);
    return { attached: false, started: Promise.resolve(false) };
  }
}

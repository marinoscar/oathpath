/**
 * A fake `Audio` whose construction, priming and playback are all observable.
 *
 * jsdom implements no media playback at all — `play()` and `pause()` are
 * `notImplemented` stubs — so every suite that cares what an `<audio>` element
 * was asked to do has to bring its own. This is that one, lifted out of
 * `VoiceSettingsPage.test.tsx` by issue #389 when a second and third call site
 * needed the same assertions.
 *
 * =============================================================================
 * `primed` AND `played` ARE SEPARATE LISTS, AND THAT IS THE WHOLE POINT
 * =============================================================================
 *
 * The autoplay unlock (`lib/audioUnlock.ts`, issues #383 and #389) plays a
 * silent `data:` URI inside the click and the real sample — a blob URL — a
 * network round trip later. The entire fix is that the FIRST happens before
 * the synthesis promise resolves, so a fake that lumped both into one list
 * could not see the bug it exists to catch: "an element played something"
 * would be true either way.
 *
 * The `data:` prefix is the only thing that tells the two apart from out here,
 * and it is the same thing the module itself checks before pausing.
 *
 * `elements` is the other half: ONE element for the life of a component,
 * reused, because an element only carries the user activation of the press
 * that unlocked it. A growing list is a fresh lock per play.
 */

/** The parts of an `HTMLAudioElement` these suites touch. */
export interface FakeAudioElement {
  src: string;
  paused: boolean;
  onplay: (() => void) | null;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

export interface FakeAudioHandle {
  /** Every `play()` of the silent unlock source, in order. */
  primed: string[];
  /** Every `play()` of a real sample (a blob URL), in order. */
  played: string[];
  /** Every element ever constructed. Should normally stay at one. */
  elements: FakeAudioElement[];
  /** The most recent element, for firing `ended`/`error` at it. */
  last: () => FakeAudioElement | null;
  /** Put the real (jsdom) constructor back. Call from `afterEach`. */
  restore: () => void;
}

export interface FakeAudioOptions {
  /**
   * What `play()` answers, per source.
   *
   * Omitted, every `play()` resolves. Returning a rejected promise for the
   * blob URL and a resolved one for the `data:` URI is exactly what a muted
   * phone or an autoplay policy does, and it is how the blocked-playback tests
   * are written.
   */
  play?: (src: string) => Promise<void>;
}

/**
 * Install the fake on `window.Audio`, returning what it recorded.
 *
 * The returned `restore()` must be called (an `afterEach`) — a fake left
 * installed leaks into every later file in the same worker.
 */
export function installFakeAudio(
  options: FakeAudioOptions = {},
): FakeAudioHandle {
  const primed: string[] = [];
  const played: string[] = [];
  const elements: FakeAudioElement[] = [];

  class FakeAudio implements FakeAudioElement {
    src = '';
    paused = false;
    onplay: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(src?: string) {
      if (src) this.src = src;
      elements.push(this);
    }

    play(): Promise<void> {
      const source = this.src;
      (source.startsWith('data:') ? primed : played).push(source);
      const settled = options.play ? options.play(source) : Promise.resolve();
      return settled.then(() => {
        // TWO CONDITIONS, BOTH MODELLING A REAL ELEMENT:
        //
        //   - `onplay` fires only when playback actually BEGINS, never on a
        //     refusal. `lib/audioUnlock.ts` reads exactly this to decide
        //     whether a later failure is mid-clip (#311), so a fake that fired
        //     it unconditionally would make that distinction untestable.
        //   - and only while THIS call's source is still loaded. The silent
        //     unlock resolves on its own schedule, frequently after the real
        //     sample has replaced it, and a real element does not report the
        //     abandoned source as having started. A fake that did would hand
        //     the unlock's resolution to the sample's `onplay` handler.
        if (this.src !== source) return;
        this.paused = false;
        this.onplay?.();
      });
    }

    pause(): void {
      this.paused = true;
    }

    removeAttribute(): void {
      this.src = '';
    }
  }

  const real = (window as unknown as { Audio?: unknown }).Audio;
  (window as unknown as { Audio: unknown }).Audio = FakeAudio;

  return {
    primed,
    played,
    elements,
    last: () => elements[elements.length - 1] ?? null,
    restore: () => {
      (window as unknown as { Audio?: unknown }).Audio = real;
    },
  };
}

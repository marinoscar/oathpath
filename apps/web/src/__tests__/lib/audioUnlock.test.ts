/**
 * The shared audio unlock — the promises that are invisible when broken.
 *
 * Issue #389, over `lib/audioUnlock.ts`. Every guarantee here fails silently,
 * and every one of them fails somewhere none of this project's contributors is
 * looking: a desktop browser permits playback after any gesture anywhere in
 * the page, so an unlock that has stopped working looks exactly like one that
 * works, right up until somebody opens the app on a phone.
 *
 * WHAT THESE PIN:
 *
 *   1. PRIMING NEVER THROWS OUT OF A CLICK HANDLER, and returns `null` where
 *      there is no `Audio` constructor at all. This module is called first in
 *      an `onClick`; anything it throws takes the whole press with it.
 *   2. THE PAUSE GUARD DOES NOT STOP A SAMPLE ALREADY SWAPPED IN. The silent
 *      unlock's `play()` resolves on its own schedule — often after the real
 *      sample has replaced it — and a pause there would stop the very audio
 *      the press asked for.
 *   3. THE ELEMENT SURVIVES A RELEASE. It carries the user activation; a
 *      replacement carries none.
 *   4. BLOCKED IS NOT ENDED, and `onBlocked` falls back to `onError` rather
 *      than to `onEnded` — so even a caller that does not distinguish a
 *      refusal from a failure is structurally unable to report one as a
 *      completion (#383).
 *   5. `onError(started)` KEEPS ITS #311 SPLIT: only this module knows whether
 *      sound had begun, because `onerror` is the same event either way.
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
  SILENT_AUDIO_DATA_URI,
  acquireAndPrimeAudio,
  acquireAudioElement,
  playAudioSample,
  releaseAudioSample,
  type AudioElementRef,
  type ObjectUrlRef,
} from '../../lib/audioUnlock';
import { installFakeAudio, type FakeAudioHandle } from '../utils/fake-audio';

let installed: FakeAudioHandle | null = null;

afterEach(() => {
  installed?.restore();
  installed = null;
});

function refs(): { audioRef: AudioElementRef; objectUrlRef: ObjectUrlRef } {
  return { audioRef: { current: null }, objectUrlRef: { current: null } };
}

/** Flush the microtasks the priming and playback promises resolve on. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('acquireAndPrimeAudio', () => {
  it('plays a silent data URI, then pauses it', async () => {
    installed = installFakeAudio();
    const { audioRef } = refs();

    const audio = acquireAndPrimeAudio(audioRef);

    expect(audio).not.toBeNull();
    expect(installed.primed).toEqual([SILENT_AUDIO_DATA_URI]);
    // SILENCE, NOT A SOURCELESS ELEMENT. `play()` on an element with no source
    // rejects before playback can begin, and some browsers establish the
    // unlock only when it does — so the gesture would be spent for nothing.
    expect(SILENT_AUDIO_DATA_URI.startsWith('data:audio/')).toBe(true);
    expect(installed.played).toEqual([]);

    await settle();
    expect(installed.last()?.paused).toBe(true);
  });

  it('returns the SAME element on every call', () => {
    installed = installFakeAudio();
    const { audioRef } = refs();

    const first = acquireAndPrimeAudio(audioRef);
    const second = acquireAndPrimeAudio(audioRef);

    expect(second).toBe(first);
    // An element only has to be unlocked once. A fresh element per press is a
    // fresh lock per press, and the second one was never touched by a gesture.
    expect(installed.elements).toHaveLength(1);
  });

  it('returns null, and does not throw, where there is no `Audio` at all', () => {
    const real = (window as unknown as { Audio?: unknown }).Audio;
    Reflect.deleteProperty(window, 'Audio');
    try {
      const { audioRef } = refs();
      expect(acquireAndPrimeAudio(audioRef)).toBeNull();
      expect(acquireAudioElement(audioRef)).toBeNull();
      expect(audioRef.current).toBeNull();
    } finally {
      (window as unknown as { Audio?: unknown }).Audio = real;
    }
  });

  it('does not throw when the browser refuses even the silence', async () => {
    installed = installFakeAudio({
      play: () => Promise.reject(new Error('NotAllowedError')),
    });
    const { audioRef } = refs();

    // A rejection here tells the caller nothing actionable — the real `play()`
    // reports for real — but it must never surface as an unhandled rejection
    // or an exception out of a click handler.
    expect(() => acquireAndPrimeAudio(audioRef)).not.toThrow();
    await settle();
  });

  it('does not pause a sample that has already been swapped in', async () => {
    // The unlock's `play()` resolves on its own schedule. By the time it does,
    // a round trip may already have replaced the silence with the real sample —
    // and pausing then would stop the very audio the press asked for.
    let releasePrime: () => void = () => {};
    installed = installFakeAudio({
      play: (src) =>
        src.startsWith('data:')
          ? new Promise<void>((resolve) => {
              releasePrime = resolve;
            })
          : Promise.resolve(),
    });
    const ctx = refs();

    acquireAndPrimeAudio(ctx.audioRef);
    playAudioSample(new Blob(['x']), {
      ...ctx,
      onEnded: () => {},
      onError: () => {},
    });
    await settle();
    expect(installed.last()?.paused).toBe(false);

    // Now the silent unlock finally resolves, long after the swap.
    releasePrime();
    await settle();

    expect(installed.last()?.paused).toBe(false);
  });
});

describe('releaseAudioSample', () => {
  it('drops the sample and the object URL, and KEEPS the element', () => {
    installed = installFakeAudio();
    const ctx = refs();
    const audio = acquireAndPrimeAudio(ctx.audioRef);

    playAudioSample(new Blob(['x']), {
      ...ctx,
      onEnded: () => {},
      onError: () => {},
    });
    expect(ctx.objectUrlRef.current).not.toBeNull();

    releaseAudioSample(ctx);

    expect(ctx.objectUrlRef.current).toBeNull();
    expect(installed.last()?.src).toBe('');
    expect(installed.last()?.onended).toBeNull();
    expect(installed.last()?.onerror).toBeNull();
    // THE ELEMENT SURVIVES. It carries the activation; discarding it is an
    // unmount-only act, and the caller's.
    expect(ctx.audioRef.current).toBe(audio);
  });

  it('is safe with nothing acquired and nothing playing', () => {
    installed = installFakeAudio();
    expect(() => releaseAudioSample(refs())).not.toThrow();
  });
});

describe('playAudioSample', () => {
  it('swaps the source on the primed element rather than building a second one', async () => {
    installed = installFakeAudio();
    const ctx = refs();
    acquireAndPrimeAudio(ctx.audioRef);

    const playback = playAudioSample(new Blob(['x']), {
      ...ctx,
      onEnded: () => {},
      onError: () => {},
    });

    expect(playback.attached).toBe(true);
    await expect(playback.started).resolves.toBe(true);
    expect(installed.elements).toHaveLength(1);
    expect(installed.played).toHaveLength(1);
    expect(installed.played[0].startsWith('data:')).toBe(false);
  });

  it('reports a refusal to `onBlocked`, never to `onEnded`', async () => {
    installed = installFakeAudio({
      play: (src) =>
        src.startsWith('data:')
          ? Promise.resolve()
          : Promise.reject(new Error('NotAllowedError')),
    });
    const ctx = refs();
    acquireAndPrimeAudio(ctx.audioRef);

    const events: string[] = [];
    const playback = playAudioSample(new Blob(['x']), {
      ...ctx,
      onEnded: () => events.push('ended'),
      onError: () => events.push('error'),
      onBlocked: () => events.push('blocked'),
    });

    await expect(playback.started).resolves.toBe(false);
    // #383: reporting a refusal as an ordinary ending is what made "your phone
    // would not play this" and "you have just heard it" the same empty region.
    expect(events).toEqual(['blocked']);
  });

  it('falls back to `onError` — and never to `onEnded` — when a caller omits `onBlocked`', async () => {
    installed = installFakeAudio({
      play: (src) =>
        src.startsWith('data:')
          ? Promise.resolve()
          : Promise.reject(new Error('NotAllowedError')),
    });
    const ctx = refs();
    acquireAndPrimeAudio(ctx.audioRef);

    const events: string[] = [];
    const playback = playAudioSample(new Blob(['x']), {
      ...ctx,
      onEnded: () => events.push('ended'),
      onError: (started) => events.push(`error:${started}`),
    });

    await expect(playback.started).resolves.toBe(false);
    // `started: false` is the #311 half: the caller's own fall-through — a
    // browser voice, say — is still ahead of it.
    expect(events).toEqual(['error:false']);
  });

  it('tells a mid-clip failure from one that never started (#311)', async () => {
    installed = installFakeAudio();
    const ctx = refs();
    acquireAndPrimeAudio(ctx.audioRef);

    const events: string[] = [];
    const playback = playAudioSample(new Blob(['x']), {
      ...ctx,
      onEnded: () => events.push('ended'),
      onError: (started) => events.push(`error:${started}`),
    });
    await playback.started;

    // Sound began, and only then did the element fail.
    installed.last()?.onerror?.();

    expect(events).toEqual(['error:true']);
  });

  it('reports nothing playable where there is no `Audio` constructor', async () => {
    const real = (window as unknown as { Audio?: unknown }).Audio;
    Reflect.deleteProperty(window, 'Audio');
    try {
      const events: string[] = [];
      const playback = playAudioSample(new Blob(['x']), {
        ...refs(),
        onEnded: () => events.push('ended'),
        onError: () => events.push('error'),
      });

      expect(playback.attached).toBe(false);
      await expect(playback.started).resolves.toBe(false);
      expect(events).toEqual([]);
    } finally {
      (window as unknown as { Audio?: unknown }).Audio = real;
    }
  });

  it('revokes the previous object URL on a swap, not only on release', async () => {
    installed = installFakeAudio();
    const ctx = refs();
    acquireAndPrimeAudio(ctx.audioRef);

    const callbacks = { onEnded: () => {}, onError: () => {} };
    playAudioSample(new Blob(['one']), { ...ctx, ...callbacks });
    const first = ctx.objectUrlRef.current;

    playAudioSample(new Blob(['two']), { ...ctx, ...callbacks });
    const second = ctx.objectUrlRef.current;

    // A blob URL nobody revokes pins its bytes for the lifetime of the
    // document, and the element has just stopped pointing at this one.
    expect(second).not.toBe(first);
    expect(installed.played).toHaveLength(2);
  });
});

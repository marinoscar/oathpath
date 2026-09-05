/**
 * `useAudioCapture` — the six named failures, and the two promises around them.
 *
 * Issue #99, epic #58 / E9. The suite is organised around the three claims the
 * hook makes that are expensive to get wrong and invisible when they are:
 *
 *   1. SIX DISTINCT PROBLEMS, SIX DISTINCT REMEDIES. A learner whose headset is
 *      unplugged must not be sent to change a permission, and a learner who
 *      blocked the site must not be told to press the button again. Every
 *      collapse of these into one "microphone unavailable" reads, from the
 *      other side, as a product that does not work.
 *   2. EVERY TRACK IS STOPPED WHEN THE HOLD ENDS. A live track means the
 *      browser's own recording indicator stays lit after the learner has
 *      finished speaking — the app saying "still listening" while it claims to
 *      have stopped.
 *   3. THE RECORDING IS NEVER PERSISTED — `docs/specs/voice.md` §4. No
 *      `localStorage`, no `IndexedDB`, no object URL, no download.
 *
 * Issue #347, epic #345 adds two more:
 *
 *   4. AN EMPTY RECORDING IS NAMED, NOT GUESSED AT. A zero-byte blob was
 *      reported as `device_in_use` — "your microphone is busy with another
 *      application" — to learners whose microphone was working perfectly and
 *      who had simply clicked a button built for holding. A wrong remedy is
 *      worse than a vague one: it sends somebody to fix a thing that is not
 *      broken and leaves the thing that is.
 *   5. THE PRE-ROLL IS IN THE BLOB, AND IT IS BOUNDED. A detector cannot report
 *      an onset until after it has happened, so a recorder started at the onset
 *      loses the syllable that caused it. The window that fixes that holds a
 *      learner's voice before they have decided to answer, so §4 governs it:
 *      small, named, discarded when the turn does not become an answer.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUDIO_CAPTURE_PRE_ROLL_MS,
  AUDIO_CAPTURE_TIMESLICE_MS,
  describeCaptureProblem,
  isCaptureProblemRetryable,
  useAudioCapture,
  type AudioCaptureProblemCode,
} from '../../hooks/useAudioCapture';

// ---------------------------------------------------------------------------
// A microphone, faked at the two seams the hook actually touches.
// ---------------------------------------------------------------------------

interface FakeTrack {
  kind: string;
  stop: ReturnType<typeof vi.fn>;
}

function makeStream(trackCount = 2): MediaStream & { tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = Array.from({ length: trackCount }, () => ({
    kind: 'audio',
    stop: vi.fn(),
  }));
  return { getTracks: () => tracks, tracks } as unknown as MediaStream & {
    tracks: FakeTrack[];
  };
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = (type: string) => type === 'audio/webm;codecs=opus';

  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  /** Set by a test to record silence — the "clicked, did not hold" case. */
  emitData = true;

  /**
   * The timeslice `start()` was given, or `null`.
   *
   * A real recorder emits a `dataavailable` every timeslice; without one it
   * emits everything at `stop()`. Recorded rather than ignored because the
   * pre-roll window is impossible without it — there is nothing to roll — so
   * "was a timeslice passed" is part of the contract, not an implementation
   * detail (issue #347).
   */
  timeslice: number | null = null;

  constructor(
    public stream: MediaStream,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
    FakeMediaRecorder.instances.push(this);
  }

  start(timeslice?: number) {
    this.state = 'recording';
    this.timeslice = timeslice ?? null;
  }

  /** One timeslice's worth of audio arriving, as the browser would deliver it. */
  emitChunk(label: string) {
    this.ondataavailable?.({
      data: new Blob([label], { type: this.mimeType }),
    });
  }

  stop() {
    this.state = 'inactive';
    if (this.emitData) {
      this.ondataavailable?.({
        data: new Blob(['pretend-opus-bytes'], { type: this.mimeType }),
      });
    }
    this.onstop?.();
  }
}

function installMicrophone(
  getUserMedia: ReturnType<typeof vi.fn>,
  { withRecorder = true } = {},
) {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  if (withRecorder) {
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder =
      FakeMediaRecorder;
  }
}

/** A `DOMException` with the real name `getUserMedia` rejects with. */
function rejection(name: string, message = ''): DOMException {
  return new DOMException(message, name);
}

const ALL_CODES: AudioCaptureProblemCode[] = [
  'permission_denied',
  'permission_dismissed',
  'no_device',
  'device_in_use',
  'insecure_origin',
  'unsupported',
  // Issue #347's seventh. An empty recording is a fact we know exactly.
  'recording_too_short',
];

beforeEach(() => {
  FakeMediaRecorder.instances = [];
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(window, 'MediaRecorder');
  Reflect.deleteProperty(window, 'isSecureContext');
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('the seven problems are seven problems', () => {
  it('gives every one of them its own message AND its own remedy', () => {
    const messages = ALL_CODES.map((code) => describeCaptureProblem(code).message);
    const remedies = ALL_CODES.map((code) => describeCaptureProblem(code).remedy);

    // Distinct, not merely present: a shared "microphone unavailable" would
    // pass a non-empty check and fail every learner it was written for.
    expect(new Set(messages).size).toBe(ALL_CODES.length);
    expect(new Set(remedies).size).toBe(ALL_CODES.length);

    for (const code of ALL_CODES) {
      const problem = describeCaptureProblem(code);
      expect(problem.code).toBe(code);
      expect(problem.message.length).toBeGreaterThan(10);
      // NEVER EMPTY. A named failure with no next step is a dead end wearing a
      // specific label.
      expect(problem.remedy.length).toBeGreaterThan(10);
    }
  });

  it('offers a retry only where pressing again could possibly help', () => {
    expect(isCaptureProblemRetryable('permission_denied')).toBe(true);
    expect(isCaptureProblemRetryable('permission_dismissed')).toBe(true);
    expect(isCaptureProblemRetryable('no_device')).toBe(true);
    expect(isCaptureProblemRetryable('device_in_use')).toBe(true);
    // Its whole remedy IS pressing again, differently.
    expect(isCaptureProblemRetryable('recording_too_short')).toBe(true);
    // Neither of these changes because somebody pressed the button again.
    expect(isCaptureProblemRetryable('insecure_origin')).toBe(false);
    expect(isCaptureProblemRetryable('unsupported')).toBe(false);
  });
});

describe('mapping a real getUserMedia rejection', () => {
  const cases: Array<[string, string, AudioCaptureProblemCode]> = [
    ['NotAllowedError', 'Permission denied', 'permission_denied'],
    ['NotAllowedError', 'Permission dismissed', 'permission_dismissed'],
    ['NotFoundError', 'Requested device not found', 'no_device'],
    ['OverconstrainedError', '', 'no_device'],
    ['NotReadableError', 'Could not start audio source', 'device_in_use'],
    ['AbortError', '', 'device_in_use'],
  ];

  it.each(cases)('%s (%s) -> %s', async (name, message, expected) => {
    installMicrophone(vi.fn().mockRejectedValue(rejection(name, message)));

    const { result } = renderHook(() => useAudioCapture());
    await act(async () => {
      result.current.start();
    });

    expect(result.current.state).toEqual({
      status: 'failed',
      problem: describeCaptureProblem(expected),
    });
    expect(result.current.isRecording).toBe(false);
  });
});

describe('the two failures that are known before the prompt', () => {
  it('reports unsupported, and never asks for the microphone', async () => {
    const getUserMedia = vi.fn();
    installMicrophone(getUserMedia, { withRecorder: false });

    const { result } = renderHook(() => useAudioCapture());
    await act(async () => {
      result.current.start();
    });

    expect(result.current.state).toEqual({
      status: 'failed',
      problem: describeCaptureProblem('unsupported'),
    });
    // Asking for a microphone this browser could not record from would take a
    // permission the learner gets nothing for.
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('reports an insecure origin BEFORE it reports unsupported', async () => {
    // The real ordering trap: an insecure origin has already deleted
    // `navigator.mediaDevices`, so a support check that ran first would send a
    // learner off to install a different browser over an http:// address.
    Object.defineProperty(window, 'isSecureContext', {
      value: false,
      configurable: true,
    });

    const { result } = renderHook(() => useAudioCapture());
    await act(async () => {
      result.current.start();
    });

    expect(result.current.state).toEqual({
      status: 'failed',
      problem: describeCaptureProblem('insecure_origin'),
    });
  });
});

describe('a recording, from hold to release', () => {
  it('records, and stops EVERY track the moment the hold ends', async () => {
    const stream = makeStream(2);
    installMicrophone(vi.fn().mockResolvedValue(stream));

    const { result } = renderHook(() => useAudioCapture());

    await act(async () => {
      result.current.start();
    });
    expect(result.current.isRecording).toBe(true);
    expect(result.current.state.status).toBe('recording');
    // Still live while the learner is speaking — the indicator is honest.
    stream.tracks.forEach((track) => expect(track.stop).not.toHaveBeenCalled());

    await act(async () => {
      result.current.stop();
    });

    expect(result.current.state.status).toBe('recorded');
    expect(result.current.recording).toBeInstanceOf(Blob);
    expect(result.current.isRecording).toBe(false);

    // EVERY track, not just the first. See the file header.
    expect(stream.tracks).toHaveLength(2);
    stream.tracks.forEach((track) => expect(track.stop).toHaveBeenCalledTimes(1));
  });

  it('picks a container the browser said it supports', async () => {
    installMicrophone(vi.fn().mockResolvedValue(makeStream()));

    const { result } = renderHook(() => useAudioCapture());
    await act(async () => {
      result.current.start();
    });

    expect(FakeMediaRecorder.instances[0].mimeType).toBe('audio/webm;codecs=opus');
  });

  it('reports a hold that captured nothing rather than going quiet', async () => {
    installMicrophone(vi.fn().mockResolvedValue(makeStream()));

    const { result } = renderHook(() => useAudioCapture());
    await act(async () => {
      result.current.start();
    });
    FakeMediaRecorder.instances[0].emitData = false;

    await act(async () => {
      result.current.stop();
    });

    // Silently returning to idle would look exactly like a button that does
    // nothing at all.
    expect(result.current.state.status).toBe('failed');
  });

  it('NEVER blames the device for a recording that captured nothing', async () => {
    // Issue #347. This reported `device_in_use` — "your microphone is busy
    // with another application" — for a mouse click on a hold-to-record
    // button, sending a learner to close an app that was not holding anything.
    installMicrophone(vi.fn().mockResolvedValue(makeStream()));

    const { result } = renderHook(() => useAudioCapture());
    await act(async () => {
      result.current.start();
    });
    FakeMediaRecorder.instances[0].emitData = false;

    await act(async () => {
      result.current.stop();
    });

    expect(result.current.state).toEqual({
      status: 'failed',
      problem: describeCaptureProblem('recording_too_short'),
    });
    if (result.current.state.status !== 'failed') throw new Error('unreachable');
    expect(result.current.state.problem.code).not.toBe('device_in_use');
    // And the remedy is about the gesture, not about another application.
    expect(result.current.state.problem.remedy).toMatch(/hold the button/i);
    expect(result.current.state.problem.remedy).not.toMatch(/close the other app/i);
  });

  it('starts the recorder with a timeslice, in per-answer mode too', async () => {
    // Not a pre-roll (there is none here) — the chunked flush itself, which is
    // what makes one possible at all. See `AUDIO_CAPTURE_TIMESLICE_MS`.
    installMicrophone(vi.fn().mockResolvedValue(makeStream()));

    const { result } = renderHook(() => useAudioCapture());
    await act(async () => {
      result.current.start();
    });

    expect(FakeMediaRecorder.instances[0].timeslice).toBe(
      AUDIO_CAPTURE_TIMESLICE_MS,
    );
  });

  it('stops the tracks when the component unmounts mid-recording', async () => {
    const stream = makeStream();
    installMicrophone(vi.fn().mockResolvedValue(stream));

    const { result, unmount } = renderHook(() => useAudioCapture());
    await act(async () => {
      result.current.start();
    });

    unmount();

    stream.tracks.forEach((track) => expect(track.stop).toHaveBeenCalled());
  });

  it('stops a stream granted after the learner already let go', async () => {
    // The permission prompt is a modal dialogue. A learner who taps, sees it,
    // and releases leaves a promise in flight that resolves with a LIVE
    // microphone seconds later — and nothing on screen expecting it.
    let grant: (stream: MediaStream) => void = () => {};
    const pending = new Promise<MediaStream>((resolve) => {
      grant = resolve;
    });
    const stream = makeStream();
    installMicrophone(vi.fn().mockReturnValue(pending));

    const { result } = renderHook(() => useAudioCapture());
    act(() => {
      result.current.start();
    });
    expect(result.current.state.status).toBe('requesting');

    act(() => {
      result.current.stop();
    });

    await act(async () => {
      grant(stream);
      await pending;
    });

    stream.tracks.forEach((track) => expect(track.stop).toHaveBeenCalled());
    expect(result.current.isRecording).toBe(false);
  });
});

describe('the audio is never written down anywhere — voice.md §4', () => {
  it('releases the blob and persists nothing at any point in the cycle', async () => {
    const setItem = vi.spyOn(window.localStorage, 'setItem');
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL');
    const open = vi.fn();
    Object.defineProperty(window, 'indexedDB', {
      value: { open },
      configurable: true,
    });

    installMicrophone(vi.fn().mockResolvedValue(makeStream()));

    const { result } = renderHook(() => useAudioCapture());
    await act(async () => {
      result.current.start();
    });
    await act(async () => {
      result.current.stop();
    });

    expect(result.current.recording).toBeInstanceOf(Blob);

    // The upload has finished; the audio stops existing here.
    act(() => {
      result.current.release();
    });

    expect(result.current.state).toEqual({ status: 'idle' });
    expect(result.current.recording).toBeNull();

    // Not to a key/value store, not to a database, and not to an object URL —
    // the last of which is how a "listen back to your answer" feature, ruled
    // out by name in §4, would arrive by accident.
    expect(setItem).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    Reflect.deleteProperty(window, 'indexedDB');
  });

  it('clears a failure too, so the button can be offered again', async () => {
    installMicrophone(
      vi.fn().mockRejectedValue(rejection('NotAllowedError', 'Permission denied')),
    );

    const { result } = renderHook(() => useAudioCapture());
    await act(async () => {
      result.current.start();
    });
    expect(result.current.state.status).toBe('failed');

    act(() => {
      result.current.release();
    });
    expect(result.current.state).toEqual({ status: 'idle' });
  });
});

// ---------------------------------------------------------------------------
// PERSISTENT MODE — issue #308, epic #304 / E13.
//
// Everything above this line is the per-answer hook E9 shipped, and it is here
// UNCHANGED on purpose: "the default mode is behaviourally unchanged" is not a
// claim you can make about a suite you had to edit to keep green.
//
// What the new mode adds is one stream that outlives the answers taken on it,
// so the tests below are mostly about a lifetime rather than a recording:
//
//   1. ONE `getUserMedia`, whatever the driver does. A hands-free loop asks to
//      record ten times a session, and ten device round-trips is ten pauses.
//   2. THE TRACKS STAY LIVE BETWEEN ANSWERS — that is what lets the app hear a
//      learner barge in over a question — and exactly one documented call
//      stops them: `releaseStream()`.
//   3. `release()` STILL MEANS "this answer is over". `PracticeSessionPage`
//      calls it after every upload settles; if it closed the microphone, a
//      conversation would end after its first answer.
//   4. THE SIX NAMED PROBLEMS ARE STILL SIX, including the one only this mode
//      can have: a device that goes away mid-session.
// ---------------------------------------------------------------------------

interface FakeLiveTrack extends FakeTrack {
  addEventListener(type: string, handler: () => void): void;
  /** The device going away BY ITSELF — unplugged, or taken by the OS. */
  end(): void;
}

/**
 * A stream whose tracks can raise `ended`, which `track.stop()` never does.
 *
 * A builder of its own rather than an extension of `makeStream`, so that every
 * test above keeps the exact fake it was written against.
 */
function makeLiveStream(
  trackCount = 2,
): MediaStream & { tracks: FakeLiveTrack[] } {
  const tracks: FakeLiveTrack[] = Array.from({ length: trackCount }, () => {
    const handlers: Array<() => void> = [];
    const track: FakeLiveTrack = {
      kind: 'audio',
      stop: vi.fn(),
      addEventListener(type: string, handler: () => void) {
        if (type === 'ended') handlers.push(handler);
      },
      end() {
        handlers.splice(0).forEach((handler) => handler());
      },
    };
    return track;
  });

  return { getTracks: () => tracks, tracks } as unknown as MediaStream & {
    tracks: FakeLiveTrack[];
  };
}

/** A `getUserMedia` that has not answered yet — the prompt is still open. */
function pendingStream() {
  let grant: (stream: MediaStream) => void = () => {};
  const promise = new Promise<MediaStream>((resolve) => {
    grant = resolve;
  });
  return { promise, grant };
}

/**
 * Let a promise chain settle inside `act`.
 *
 * Persistent acquisition is deliberately several `then`s deep — the device
 * call, the shared in-flight acquisition, and the caller that asked to record
 * on whatever it produced — and one `await` only drains the first of them.
 */
async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** The three calls one whole answer makes: hold, let go, upload settles. */
async function takeOneAnswer(result: {
  current: {
    start: () => void;
    stop: () => void;
    release: () => void;
    state: { status: string };
  };
}) {
  await act(async () => {
    result.current.start();
    await settle();
  });
  await act(async () => {
    result.current.stop();
  });
  expect(result.current.state.status).toBe('recorded');
  act(() => {
    result.current.release();
  });
  expect(result.current.state).toEqual({ status: 'idle' });
}

describe('persistent mode: one stream, many answers', () => {
  it('asks the device for the microphone EXACTLY ONCE across three answers', async () => {
    const stream = makeLiveStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    installMicrophone(getUserMedia);

    const { result } = renderHook(() => useAudioCapture({ persistent: true }));

    await takeOneAnswer(result);
    await takeOneAnswer(result);
    await takeOneAnswer(result);

    // THE POINT OF THE MODE. One prompt, one device round-trip, one light.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // And three real recordings on it — not one recording and two silent
    // no-ops, which is exactly what E9's `streamRef.current` clause in the
    // "already recording" guard would have produced here.
    expect(FakeMediaRecorder.instances).toHaveLength(3);
  });

  it('leaves every track live between answers, and after release()', async () => {
    const stream = makeLiveStream(2);
    installMicrophone(vi.fn().mockResolvedValue(stream));

    const { result } = renderHook(() => useAudioCapture({ persistent: true }));

    await takeOneAnswer(result);
    // `release()` has run. In per-answer mode that is where the light goes out;
    // here the conversation is still going and the app is still listening.
    stream.tracks.forEach((track) => expect(track.stop).not.toHaveBeenCalled());

    await takeOneAnswer(result);
    stream.tracks.forEach((track) => expect(track.stop).not.toHaveBeenCalled());
    expect(result.current.stream).toBe(stream);
  });

  it('stops EVERY track on releaseStream() — the one documented teardown', async () => {
    const stream = makeLiveStream(2);
    installMicrophone(vi.fn().mockResolvedValue(stream));

    const { result } = renderHook(() => useAudioCapture({ persistent: true }));
    await takeOneAnswer(result);

    act(() => {
      result.current.releaseStream();
    });

    expect(stream.tracks).toHaveLength(2);
    stream.tracks.forEach((track) => expect(track.stop).toHaveBeenCalledTimes(1));
    expect(result.current.stream).toBeNull();
    expect(result.current.state).toEqual({ status: 'idle' });
  });

  it('opens a fresh stream after releaseStream(), never a dead one', async () => {
    const first = makeLiveStream();
    const second = makeLiveStream();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    installMicrophone(getUserMedia);

    const { result } = renderHook(() => useAudioCapture({ persistent: true }));
    await takeOneAnswer(result);
    act(() => {
      result.current.releaseStream();
    });

    await takeOneAnswer(result);

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(result.current.stream).toBe(second);
  });

  it('exposes the live stream so a driver can attach its own analyser', async () => {
    const stream = makeLiveStream();
    installMicrophone(vi.fn().mockResolvedValue(stream));

    const { result } = renderHook(() => useAudioCapture({ persistent: true }));
    expect(result.current.stream).toBeNull();

    // BEFORE any recording: barge-in on the very first question needs the
    // analyser wired while the app is still reading that question out.
    let acquired: MediaStream | null = null;
    await act(async () => {
      acquired = await result.current.acquireStream();
      await settle();
    });

    expect(acquired).toBe(stream);
    expect(result.current.stream).toBe(stream);
    expect(result.current.state).toEqual({ status: 'idle' });
    stream.tracks.forEach((track) => expect(track.stop).not.toHaveBeenCalled());
  });

  it('opens ONE prompt when acquireStream() and start() race', async () => {
    const { promise, grant } = pendingStream();
    const stream = makeLiveStream();
    const getUserMedia = vi.fn().mockReturnValue(promise);
    installMicrophone(getUserMedia);

    const { result } = renderHook(() => useAudioCapture({ persistent: true }));

    act(() => {
      void result.current.acquireStream();
      void result.current.acquireStream();
      result.current.start();
    });

    await act(async () => {
      grant(stream);
      await settle();
    });

    // Three callers, one microphone. A second prompt stacked over the first is
    // a browser-level mess the learner has to dismiss twice.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('recording');
  });

  it('records on a warm stream without passing through "requesting"', async () => {
    const stream = makeLiveStream();
    installMicrophone(vi.fn().mockResolvedValue(stream));

    const { result } = renderHook(() => useAudioCapture({ persistent: true }));
    await act(async () => {
      await result.current.acquireStream();
      await settle();
    });

    // Synchronous: there is no prompt to sit in front of, so no `requesting`
    // state and no syllable lost off the front of the answer.
    act(() => {
      result.current.start();
    });
    expect(result.current.state.status).toBe('recording');
  });
});

describe('the "already recording" no-op, in both modes', () => {
  it('is still a no-op in persistent mode, where a stream is always live', async () => {
    const stream = makeLiveStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    installMicrophone(getUserMedia);

    const { result } = renderHook(() => useAudioCapture({ persistent: true }));
    await act(async () => {
      result.current.start();
      await settle();
    });
    expect(FakeMediaRecorder.instances).toHaveLength(1);

    // Autorepeat, or a doubled pointer event. Restarting here would throw away
    // whatever the learner has already said.
    await act(async () => {
      result.current.start();
      result.current.start();
      await settle();
    });

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('recording');
  });

  it('is still a no-op in per-answer mode, unweakened', async () => {
    const getUserMedia = vi.fn().mockResolvedValue(makeStream());
    installMicrophone(getUserMedia);

    const { result } = renderHook(() => useAudioCapture());
    await act(async () => {
      result.current.start();
    });
    await act(async () => {
      result.current.start();
    });

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('recording');
  });
});

describe('the app must not hear itself', () => {
  const PROCESSING = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  it('asks for echo cancellation, noise suppression and gain control', async () => {
    const getUserMedia = vi.fn().mockResolvedValue(makeLiveStream());
    installMicrophone(getUserMedia);

    const { result } = renderHook(() => useAudioCapture({ persistent: true }));
    await act(async () => {
      await result.current.acquireStream();
      await settle();
    });

    // With the speaker reading the question out and the microphone open, a
    // bare `{ audio: true }` records the app's own text-to-speech and then
    // grades the learner on it.
    expect(getUserMedia).toHaveBeenCalledWith({ audio: PROCESSING });
  });

  it('asks for all three in per-answer mode too', async () => {
    const getUserMedia = vi.fn().mockResolvedValue(makeStream());
    installMicrophone(getUserMedia);

    const { result } = renderHook(() => useAudioCapture());
    await act(async () => {
      result.current.start();
    });

    // A laptop speaker has the same problem during a push-to-talk hold — just
    // for less of the time.
    expect(getUserMedia).toHaveBeenCalledWith({ audio: PROCESSING });
  });
});

describe('persistent mode still names all six problems', () => {
  const FAILURES: Array<{
    code: AudioCaptureProblemCode;
    install: () => ReturnType<typeof vi.fn>;
  }> = [
    {
      code: 'permission_denied',
      install() {
        const getUserMedia = vi
          .fn()
          .mockRejectedValue(rejection('NotAllowedError', 'Permission denied'));
        installMicrophone(getUserMedia);
        return getUserMedia;
      },
    },
    {
      code: 'permission_dismissed',
      install() {
        const getUserMedia = vi
          .fn()
          .mockRejectedValue(rejection('NotAllowedError', 'Permission dismissed'));
        installMicrophone(getUserMedia);
        return getUserMedia;
      },
    },
    {
      code: 'no_device',
      install() {
        const getUserMedia = vi
          .fn()
          .mockRejectedValue(rejection('NotFoundError', 'Device not found'));
        installMicrophone(getUserMedia);
        return getUserMedia;
      },
    },
    {
      code: 'device_in_use',
      install() {
        const getUserMedia = vi
          .fn()
          .mockRejectedValue(rejection('NotReadableError', 'Could not start source'));
        installMicrophone(getUserMedia);
        return getUserMedia;
      },
    },
    {
      code: 'insecure_origin',
      install() {
        const getUserMedia = vi.fn();
        installMicrophone(getUserMedia);
        Object.defineProperty(window, 'isSecureContext', {
          value: false,
          configurable: true,
        });
        return getUserMedia;
      },
    },
    {
      code: 'unsupported',
      install() {
        const getUserMedia = vi.fn();
        installMicrophone(getUserMedia, { withRecorder: false });
        return getUserMedia;
      },
    },
  ];

  // BOTH doors into the device. `acquireStream()` reaches `getUserMedia`
  // without going through `start()`, so it has to run the same preflight in the
  // same order — otherwise it reports `unsupported` over an http:// address,
  // which is the one ordering trap this hook has always had.
  describe.each(['start', 'acquireStream'] as const)('via %s()', (door) => {
    it.each(FAILURES)('$code', async ({ code, install }) => {
      const getUserMedia = install();

      const { result } = renderHook(() => useAudioCapture({ persistent: true }));
      await act(async () => {
        if (door === 'start') {
          result.current.start();
        } else {
          await result.current.acquireStream();
        }
        await settle();
      });

      expect(result.current.state).toEqual({
        status: 'failed',
        problem: describeCaptureProblem(code),
      });
      expect(result.current.stream).toBeNull();

      if (code === 'insecure_origin' || code === 'unsupported') {
        // Known before the prompt, so the prompt is never opened.
        expect(getUserMedia).not.toHaveBeenCalled();
      }
    });
  });

  it('reports a device taken away mid-session, and lets the learner start again', async () => {
    const first = makeLiveStream();
    const second = makeLiveStream();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    installMicrophone(getUserMedia);

    const { result } = renderHook(() => useAudioCapture({ persistent: true }));
    await act(async () => {
      result.current.start();
      await settle();
    });

    // The recorder's own way of saying the device went: a call grabbed it, or
    // the headset was unplugged mid-answer.
    act(() => {
      FakeMediaRecorder.instances[0].onerror?.();
    });

    expect(result.current.state).toEqual({
      status: 'failed',
      problem: describeCaptureProblem('device_in_use'),
    });
    // The light must not stay on over a device that is not there any more.
    first.tracks.forEach((track) => expect(track.stop).toHaveBeenCalled());
    expect(result.current.stream).toBeNull();

    // …and the remedy the learner was just given ("close the other app, then
    // hold the record button again") has to actually work.
    await act(async () => {
      result.current.start();
      await settle();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(result.current.state.status).toBe('recording');
    expect(result.current.stream).toBe(second);
  });

  it('reports a track that ends by itself BETWEEN answers', async () => {
    // The window only persistent mode has: a stream open with no recorder
    // running on it, so there is no `onerror` to notice the loss for us.
    const stream = makeLiveStream();
    installMicrophone(vi.fn().mockResolvedValue(stream));

    const { result } = renderHook(() => useAudioCapture({ persistent: true }));
    await act(async () => {
      await result.current.acquireStream();
      await settle();
    });

    act(() => {
      stream.tracks[0].end();
    });

    expect(result.current.state).toEqual({
      status: 'failed',
      problem: describeCaptureProblem('device_in_use'),
    });
    stream.tracks.forEach((track) => expect(track.stop).toHaveBeenCalled());
    expect(result.current.stream).toBeNull();
  });
});

describe('unmount releases the stream in both modes', () => {
  it('stops a persistent stream left open between answers', async () => {
    const stream = makeLiveStream(2);
    installMicrophone(vi.fn().mockResolvedValue(stream));

    const { result, unmount } = renderHook(() =>
      useAudioCapture({ persistent: true }),
    );
    await takeOneAnswer(result);
    stream.tracks.forEach((track) => expect(track.stop).not.toHaveBeenCalled());

    // Navigating away from a conversation is a way out of it like any other,
    // and it is the one nobody remembers to write a teardown for.
    unmount();

    stream.tracks.forEach((track) => expect(track.stop).toHaveBeenCalledTimes(1));
  });

  it('stops a stream acquired but never recorded on', async () => {
    const stream = makeLiveStream();
    installMicrophone(vi.fn().mockResolvedValue(stream));

    const { result, unmount } = renderHook(() =>
      useAudioCapture({ persistent: true }),
    );
    await act(async () => {
      await result.current.acquireStream();
      await settle();
    });

    unmount();

    stream.tracks.forEach((track) => expect(track.stop).toHaveBeenCalled());
  });

  // Per-answer mode's unmount is covered above, mid-recording, by
  // "stops the tracks when the component unmounts mid-recording".
});

// ---------------------------------------------------------------------------
// THE PRE-ROLL — issue #347, epic #345.
//
// A voice-activity detector reports an onset 145-190 ms after the learner
// actually started talking (a ~43 ms RMS window, a 25 ms poll, a 120 ms sustain
// requirement) plus the encoder's own start-up, so a recorder started at the
// onset EVENT has already missed the syllable that produced it. The detector
// has always back-dated its own timestamp for exactly this reason; only the
// audio was missing.
//
// The two claims below are the ones worth holding: the audio from BEFORE the
// onset is in the uploaded blob, and it is BOUNDED — `voice.md` §4 governs a
// buffer holding a learner's voice before they have decided to answer.
// ---------------------------------------------------------------------------

describe('the pre-roll', () => {
  /** Open a persistent stream and start the pre-roll window on it. */
  async function armPreRoll() {
    const stream = makeLiveStream();
    installMicrophone(vi.fn().mockResolvedValue(stream));

    const { result, unmount } = renderHook(() =>
      useAudioCapture({ persistent: true }),
    );
    await act(async () => {
      await result.current.acquireStream();
      await settle();
    });

    act(() => result.current.startPreRoll());
    return { result, stream, unmount, recorder: FakeMediaRecorder.instances[0] };
  }

  it('puts audio from BEFORE the onset into the uploaded blob', async () => {
    const { result, recorder } = await armPreRoll();

    // The learner starts talking. These two chunks are the first syllable —
    // the detector cannot possibly have reported an onset yet.
    recorder.emitChunk('HEADER:');
    recorder.emitChunk('first-syllable:');

    // NOW the detector reports the onset and the driver calls `start()`.
    act(() => result.current.start());
    recorder.emitChunk('the-rest-of-the-answer');

    await act(async () => {
      result.current.stop();
    });

    expect(result.current.state.status).toBe('recorded');
    const blob = result.current.recording!;
    const bytes = await blob.text();

    // The whole point: the syllable that happened before the onset is here.
    expect(bytes).toContain('first-syllable:');
    expect(bytes).toContain('the-rest-of-the-answer');
    // And in order, header first — a container header dropped or moved is a
    // blob a transcription provider cannot decode at all.
    expect(bytes.indexOf('HEADER:')).toBe(0);
    expect(bytes.indexOf('first-syllable:')).toBeLessThan(
      bytes.indexOf('the-rest-of-the-answer'),
    );
  });

  it('promotes the running recorder rather than starting a second one', async () => {
    // Building a fresh recorder at the onset would throw away exactly the
    // audio the pre-roll exists to keep, while also encoding twice.
    const { result, recorder } = await armPreRoll();
    expect(FakeMediaRecorder.instances).toHaveLength(1);

    act(() => result.current.start());

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(recorder.state).toBe('recording');
    expect(recorder.timeslice).toBe(AUDIO_CAPTURE_TIMESLICE_MS);
  });

  it('BOUNDS the window — it never accumulates a whole waiting turn', async () => {
    // `voice.md` §4: this holds a learner's voice before they have decided to
    // answer, so it is a short, named ceiling and not "everything since we
    // started listening".
    const { result, recorder } = await armPreRoll();

    recorder.emitChunk('HEADER:');
    // Far more than the window: a learner who took several seconds to start.
    const slices = Math.ceil(AUDIO_CAPTURE_PRE_ROLL_MS / AUDIO_CAPTURE_TIMESLICE_MS);
    for (let i = 0; i < slices * 6; i += 1) recorder.emitChunk(`old-${i}:`);
    for (let i = 0; i < slices; i += 1) recorder.emitChunk(`kept-${i}:`);

    act(() => result.current.start());
    await act(async () => {
      result.current.stop();
    });

    const bytes = await result.current.recording!.text();
    // The header survives, the recent window survives, the rest is gone.
    expect(bytes.indexOf('HEADER:')).toBe(0);
    expect(bytes).toContain(`kept-${slices - 1}:`);
    expect(bytes).not.toContain('old-0:');
    expect(bytes).not.toContain(`old-${slices * 6 - 1}:`);
  });

  it('is not a recording — the screen never says "Recording" for it', async () => {
    // A learner who has not started speaking must not be told they are being
    // recorded, and a driver must not treat a pre-roll as an answer in flight.
    const { result, recorder } = await armPreRoll();
    recorder.emitChunk('HEADER:');

    expect(result.current.state.status).toBe('idle');
    expect(result.current.isRecording).toBe(false);
    expect(result.current.recording).toBeNull();
  });

  it('DISCARDS a window that never became an answer', async () => {
    // The onset-timeout path: nobody spoke, so there is nothing to hand over,
    // and half a second of somebody's room is not a recording anybody asked
    // for (`voice.md` §4).
    const { result, stream, recorder } = await armPreRoll();
    recorder.emitChunk('HEADER:');
    recorder.emitChunk('a-room-nobody-answered-in');

    await act(async () => {
      result.current.stop();
    });

    expect(result.current.state.status).toBe('idle');
    expect(result.current.recording).toBeNull();
    // …and the session's microphone is untouched: the turn ended, not the
    // conversation.
    stream.tracks.forEach((track) => expect(track.stop).not.toHaveBeenCalled());
    expect(result.current.stream).toBe(stream);

    // The next turn opens a fresh window rather than resuming that one.
    act(() => result.current.startPreRoll());
    expect(FakeMediaRecorder.instances).toHaveLength(2);
  });

  it('is idempotent, and never opens a second recorder on the same stream', async () => {
    const { result } = await armPreRoll();

    act(() => result.current.startPreRoll());
    act(() => result.current.startPreRoll());

    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  it('does nothing at all with no stream open', async () => {
    installMicrophone(vi.fn());

    const { result } = renderHook(() => useAudioCapture({ persistent: true }));
    act(() => result.current.startPreRoll());

    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(result.current.state).toEqual({ status: 'idle' });
  });

  it('does nothing in per-answer mode, where there is nothing to pre-roll', async () => {
    // There, the recorder and the learner's decision to speak are the same
    // event: they press the button and then talk.
    installMicrophone(vi.fn().mockResolvedValue(makeStream()));

    const { result } = renderHook(() => useAudioCapture());
    act(() => {
      (result.current as { startPreRoll?: () => void }).startPreRoll?.();
    });

    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it('spends the server\'s 120 s budget on the BLOB, not on the onset', async () => {
    // The cap exists because `POST /api/ai/speech/transcribe` rejects anything
    // over 120 seconds BEFORE it dispatches. The blob is the retained window
    // plus everything after the onset, so timing the courtesy stop from the
    // onset alone would hand the server a recording over its own limit — and
    // the learner would be told, after speaking for two minutes, that none of
    // it counted.
    vi.useFakeTimers();
    try {
      const stream = makeLiveStream();
      installMicrophone(vi.fn().mockResolvedValue(stream));

      const { result } = renderHook(() =>
        useAudioCapture({ persistent: true, maxDurationMs: 10_000 }),
      );
      await act(async () => {
        await result.current.acquireStream();
        await settle();
      });

      act(() => result.current.startPreRoll());
      FakeMediaRecorder.instances[0].emitChunk('HEADER:');
      act(() => result.current.start());
      expect(result.current.state.status).toBe('recording');

      // Still going a hair before the budget…
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000 - AUDIO_CAPTURE_PRE_ROLL_MS - 1);
      });
      expect(result.current.state.status).toBe('recording');

      // …and stopped by the time the BLOB would have reached the cap.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2);
      });
      expect(result.current.state.status).toBe('recorded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the window with the session on releaseStream()', async () => {
    const { result, stream } = await armPreRoll();
    FakeMediaRecorder.instances[0].emitChunk('HEADER:');

    act(() => result.current.releaseStream());

    expect(result.current.state).toEqual({ status: 'idle' });
    expect(result.current.recording).toBeNull();
    stream.tracks.forEach((track) => expect(track.stop).toHaveBeenCalled());
  });

  it('drops the window when the component unmounts', async () => {
    const { stream, unmount } = await armPreRoll();
    FakeMediaRecorder.instances[0].emitChunk('HEADER:');

    unmount();

    stream.tracks.forEach((track) => expect(track.stop).toHaveBeenCalled());
  });
});

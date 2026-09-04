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
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
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

  /** Set by a test to record silence — the "tapped, did not hold" case. */
  emitData = true;

  constructor(
    public stream: MediaStream,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = 'recording';
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

describe('the six problems are six problems', () => {
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

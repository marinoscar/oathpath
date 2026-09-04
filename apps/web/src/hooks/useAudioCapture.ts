/**
 * Push-to-talk microphone capture, as React state.
 *
 * Issue #99, epic #58 / E9. One hold of a button produces one `Blob` and
 * nothing else — no file, no cache entry, no object URL, no replay.
 *
 * =============================================================================
 * SIX FAILURES, SIX NAMES, SIX REMEDIES. NEVER "MICROPHONE UNAVAILABLE".
 * =============================================================================
 *
 * Microphone capture is the part of this epic most likely to fail in the field,
 * and it fails in more ways than one. A denied permission, a dismissed prompt,
 * no input device at all, a device another application is already holding, an
 * insecure origin, and a browser with no `MediaRecorder` are SIX DISTINCT
 * PROBLEMS WITH SIX DISTINCT REMEDIES:
 *
 *   permission_denied     change a browser setting and reload
 *   permission_dismissed  press and hold again, then choose Allow
 *   no_device             plug something in
 *   device_in_use         quit the other application
 *   insecure_origin       open the https address
 *   unsupported           use another browser — or just type
 *
 * Collapsing them into one "microphone unavailable" sentence tells a learner
 * whose headset is simply unplugged to go and change a permission that was
 * never the problem; collapsing them into a disabled button with no text at all
 * tells them the product is broken. Either way the honest, one-step fix is
 * invisible, so they stop. That is why the failure is a NAMED case carrying its
 * own `message` and its own `remedy` rather than a boolean and a string.
 *
 * And every one of them leaves typing reachable. `docs/specs/voice.md` §5:
 * voice is always optional, so no capture failure is ever a dead end.
 *
 * =============================================================================
 * THE TRACKS ARE STOPPED THE MOMENT THE LEARNER STOPS SPEAKING
 * =============================================================================
 *
 * `stream.getTracks().forEach((t) => t.stop())` runs on every exit from a
 * recording: a normal release, a failure, a superseded start, and unmount. This
 * is not resource hygiene. While a track is live the browser shows its own
 * recording indicator — a red dot in the tab, an OS-level microphone light —
 * and a learner who has finished speaking and can still see that light has been
 * told, by their own operating system, that this app is listening to them when
 * it said it had stopped. That is a trust failure, and it is not recoverable by
 * explaining afterwards.
 *
 * =============================================================================
 * THE RECORDING IS NEVER PERSISTED. ANYWHERE. — `docs/specs/voice.md` §4
 * =============================================================================
 *
 * The `Blob` lives in React state for exactly the span between "stop recording"
 * and "the transcript came back", and `release()` drops it. There is no write
 * to `IndexedDB`, no `localStorage` entry, no cache, no download link, and no
 * `URL.createObjectURL` — not even a revoked one, because the only reason to
 * make one would be to play the recording back, and §4 rules that feature out
 * by name: an audio-replay affordance IS the retained recording it forbids.
 *
 * An unnecessary recording of somebody's voice, made while they practise for a
 * naturalization interview, is a liability this product has no use for.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useIsMounted } from './useIsMounted';

/**
 * Why capture could not happen. A CLOSED SET OF SIX, and the closure is
 * load-bearing: a consumer switches over it exhaustively so a seventh cause can
 * never be added without every screen that renders one being revisited.
 */
export type AudioCaptureProblemCode =
  /** The browser is blocking the microphone for this site. */
  | 'permission_denied'
  /** The permission prompt was closed without an answer. Not the same thing. */
  | 'permission_dismissed'
  /** There is no microphone attached. */
  | 'no_device'
  /** Something else already holds the microphone. */
  | 'device_in_use'
  /** The page is not on a secure origin, where capture is forbidden outright. */
  | 'insecure_origin'
  /** This browser cannot record audio at all. */
  | 'unsupported';

export interface AudioCaptureProblem {
  code: AudioCaptureProblemCode;
  /** What happened, one sentence, in the learner's terms. Never generic. */
  message: string;
  /** What to do about it, one sentence. NEVER EMPTY — see the file header. */
  remedy: string;
}

/**
 * The copy, in one table so that "six distinct messages" is a fact a test can
 * check rather than a promise spread over six call sites.
 *
 * TONE: `VISION.md`'s AI Personality section — calm, specific, never blaming
 * the person. Nothing here is the learner's fault, and none of it is an alarm.
 */
const CAPTURE_PROBLEMS: Record<
  AudioCaptureProblemCode,
  Omit<AudioCaptureProblem, 'code'>
> = {
  permission_denied: {
    message: 'Your browser is blocking the microphone for this site.',
    remedy:
      'Open the site permissions from the icon in your address bar, allow the microphone, then reload this page.',
  },
  permission_dismissed: {
    message: 'The microphone request closed before it was answered.',
    remedy: 'Hold the record button again, and choose Allow when asked.',
  },
  no_device: {
    message: 'No microphone was found on this device.',
    remedy:
      'Connect a microphone or a headset — then hold the record button again.',
  },
  device_in_use: {
    message: 'Your microphone is busy with another application.',
    remedy:
      'Close the other app using it — a call or a recorder, usually — then hold the record button again.',
  },
  insecure_origin: {
    message:
      'Browsers only allow recording over a secure (https) connection, and this page was not loaded over one.',
    remedy: 'Open this site at its https address, then try again.',
  },
  unsupported: {
    message: 'This browser cannot record audio.',
    remedy:
      'A recent Chrome, Edge, Firefox or Safari can — or answer by typing, which works everywhere.',
  },
};

/** Build the full problem for a code. Exported so a consumer can render one. */
export function describeCaptureProblem(
  code: AudioCaptureProblemCode,
): AudioCaptureProblem {
  return { code, ...CAPTURE_PROBLEMS[code] };
}

/**
 * Can holding the button again plausibly help?
 *
 * `insecure_origin` and `unsupported` are facts about where the page is loaded
 * from and what the browser is, and neither changes because somebody pressed
 * again. Offering a retry there is an invitation to press a button that is
 * guaranteed to fail, which reads as the product being broken; the other four
 * are genuinely worth one more press once the remedy has been followed.
 */
export function isCaptureProblemRetryable(
  code: AudioCaptureProblemCode,
): boolean {
  return code !== 'insecure_origin' && code !== 'unsupported';
}

/**
 * Where one hold-to-speak has got to.
 *
 * `requesting` is separate from `recording` on purpose: between them sits the
 * browser's permission prompt, which on a first use is a modal dialogue the
 * learner has to read. A UI that said "Recording" over it would be claiming to
 * capture audio that is not being captured, and the first thing that learner
 * would do is start talking into it.
 */
export type AudioCaptureState =
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'recording'; startedAt: number }
  | { status: 'recorded'; blob: Blob; mimeType: string; durationMs: number }
  | { status: 'failed'; problem: AudioCaptureProblem };

export interface UseAudioCaptureOptions {
  /**
   * Stop recording by itself after this long. Defaults to 120 seconds.
   *
   * `docs/specs/voice.md` §9 caps a transcription at 120 seconds SERVER-SIDE,
   * before dispatch, so a longer recording is rejected as a 400. Stopping here
   * means a learner who leaves the button held never records two minutes of
   * audio only to be told, after the upload finishes, that none of it counted.
   * The server's cap remains the enforcement; this is only courtesy.
   */
  maxDurationMs?: number;
}

export interface UseAudioCaptureReturn {
  /** The one state a consumer switches over. See {@link AudioCaptureState}. */
  state: AudioCaptureState;
  /** True exactly while audio is being captured. Drives the visible indicator. */
  isRecording: boolean;
  /** The finished recording, or `null`. The same object as `state.blob`. */
  recording: Blob | null;
  /** Begin. Asks for permission if needed. NEVER THROWS — failures are state. */
  start: () => void;
  /** End the recording and stop every track. Safe at any time. */
  stop: () => void;
  /**
   * Drop the recording and clear any problem, returning to `idle`.
   *
   * CALL THIS WHEN THE UPLOAD SETTLES, success or failure. It is the line where
   * the audio stops existing — see the file header and `docs/specs/voice.md`
   * §4. Also the dismiss for a failure message.
   */
  release: () => void;
}

/** 120 seconds. See {@link UseAudioCaptureOptions.maxDurationMs}. */
const DEFAULT_MAX_DURATION_MS = 120_000;

/**
 * Preferred container/codec, best first.
 *
 * Opus in WebM is what Chrome, Edge and Firefox record natively and what speech
 * providers accept happily; Safari records mp4/AAC and supports none of the
 * others. An empty result means "let the browser choose", which is always
 * better than forcing a `mimeType` the platform will reject at construction.
 */
const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

export function useAudioCapture(
  options: UseAudioCaptureOptions = {},
): UseAudioCaptureReturn {
  const { maxDurationMs = DEFAULT_MAX_DURATION_MS } = options;

  const [state, setState] = useState<AudioCaptureState>({ status: 'idle' });
  const isMounted = useIsMounted();

  /** The live stream, or null. THE ONLY REFERENCE — see `stopTracks`. */
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef(0);
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Which hold we are on.
   *
   * Bumped by every `stop`, `release` and `start`, and captured by the async
   * `getUserMedia` continuation. It answers the one question a boolean cannot:
   * a learner who taps the button, sees the permission prompt, and releases
   * before answering it leaves a `getUserMedia` promise in flight that resolves
   * with a LIVE MICROPHONE seconds later. Without this check that stream is
   * recorded from, and its indicator light stays on, for a hold that was over
   * before it began.
   */
  const holdRef = useRef(0);

  /**
   * Stop every track and forget the stream. Idempotent.
   *
   * EVERY track, not `getAudioTracks()[0]`: a constraint set can hand back more
   * than one, and a track nobody stopped is a microphone the learner can see is
   * still on. See the file header — this is a trust question, not a leak.
   */
  const stopTracks = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
  }, []);

  const clearMaxDurationTimer = useCallback(() => {
    if (maxDurationTimerRef.current === null) return;
    clearTimeout(maxDurationTimerRef.current);
    maxDurationTimerRef.current = null;
  }, []);

  /** Tear down everything, keeping no audio. Used by stop paths and unmount. */
  const teardown = useCallback(() => {
    clearMaxDurationTimer();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      // Detached first: this teardown is not the flush path, and letting the
      // handlers fire here would push a blob into a state nobody is going to
      // read and, worse, resurrect a stream reference we are discarding.
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        recorder.stop();
      } catch {
        // A recorder already stopping throws `InvalidStateError`. Nothing to
        // do about it and nothing to tell anybody: the tracks still get
        // stopped on the next line, which is the part that matters.
      }
    }
    chunksRef.current = [];
    stopTracks();
  }, [clearMaxDurationTimer, stopTracks]);

  // Unmount ends the recording. A learner who navigates away mid-sentence must
  // not leave a live microphone (and its indicator light) behind them.
  useEffect(() => teardown, [teardown]);

  const release = useCallback(() => {
    holdRef.current += 1;
    teardown();
    if (isMounted()) setState({ status: 'idle' });
  }, [isMounted, teardown]);

  const fail = useCallback(
    (code: AudioCaptureProblemCode) => {
      teardown();
      if (isMounted()) {
        setState({ status: 'failed', problem: describeCaptureProblem(code) });
      }
    },
    [isMounted, teardown],
  );

  const stop = useCallback(() => {
    holdRef.current += 1;
    clearMaxDurationTimer();

    const recorder = recorderRef.current;
    if (!recorder) {
      // Released before the permission resolved, or before a recorder existed.
      // The in-flight `getUserMedia` is now on a stale hold and will stop
      // whatever stream it is handed; there is nothing recorded to keep.
      stopTracks();
      if (isMounted()) {
        setState((current) =>
          current.status === 'requesting' ? { status: 'idle' } : current,
        );
      }
      return;
    }

    if (recorder.state === 'inactive') {
      stopTracks();
      return;
    }

    // `onstop` (installed in `start`) assembles the blob and stops the tracks.
    // The tracks are NOT stopped here first: a track killed before the recorder
    // has flushed can truncate the final chunk, which is the learner's last
    // word — and being cut off mid-answer is exactly the "the recognizer
    // mangled it" experience §3 exists to keep out of a grade.
    recorder.stop();
  }, [clearMaxDurationTimer, isMounted, stopTracks]);

  const start = useCallback(() => {
    // Supersede nothing: a second start while one is live is a no-op rather
    // than a restart, so a repeated `keydown` (autorepeat) or a pointer event
    // fired twice cannot drop the recording already in progress.
    if (recorderRef.current || streamRef.current) return;

    const hold = holdRef.current + 1;
    holdRef.current = hold;
    const isCurrent = () => holdRef.current === hold && isMounted();

    // ---- Preflight, in this order, and the order is the point --------------
    //
    // `insecure_origin` IS CHECKED FIRST because a browser on an insecure
    // origin does not merely refuse capture — it deletes `navigator.mediaDevices`
    // entirely. Checking support first would therefore report `unsupported` on
    // a perfectly capable browser, and send the learner off to install a
    // different one when the actual fix is the address bar.
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      fail('insecure_origin');
      return;
    }

    const mediaDevices =
      typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (
      !mediaDevices?.getUserMedia ||
      typeof window === 'undefined' ||
      typeof window.MediaRecorder === 'undefined'
    ) {
      // Both halves are needed: Safari shipped `getUserMedia` years before
      // `MediaRecorder`, so a browser can grant a microphone and still have no
      // way to record from it. Discovering that AFTER the permission prompt
      // would ask a learner to hand over their microphone for nothing.
      fail('unsupported');
      return;
    }

    setState({ status: 'requesting' });

    mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (!isCurrent()) {
          // The hold ended (or the component unmounted) while the prompt was
          // open. Stop the tracks we were just handed — see `holdRef`.
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;

        let recorder: MediaRecorder;
        try {
          const mimeType = pickMimeType(window.MediaRecorder);
          recorder = new window.MediaRecorder(
            stream,
            mimeType ? { mimeType } : undefined,
          );
        } catch {
          // A `MediaRecorder` that exists but cannot honour any container we
          // asked for. Rare, and still a browser that cannot record — the
          // learner's remedy is the same one.
          fail('unsupported');
          return;
        }

        recorderRef.current = recorder;
        chunksRef.current = [];
        startedAtRef.current = Date.now();

        recorder.ondataavailable = (event: BlobEvent) => {
          if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
        };

        recorder.onstop = () => {
          const chunks = chunksRef.current;
          chunksRef.current = [];
          recorderRef.current = null;
          clearMaxDurationTimer();

          // FIRST, before any state work: the indicator light goes out when the
          // learner stops speaking, not when React gets around to a render.
          stopTracks();

          // NOT gated on `isCurrent()`: `stop()` has already bumped the hold
          // — that is what ended this recording — so the flush that follows it
          // is by definition on the previous hold. Only mounting matters here.
          if (!isMounted()) return;

          const firstChunk = chunks[0];
          const type =
            recorder.mimeType ||
            (firstChunk instanceof Blob ? firstChunk.type : '') ||
            'audio/webm';
          const blob = new Blob(chunks, { type });

          if (blob.size === 0) {
            // Nothing was captured — a tap rather than a hold, or a muted
            // device. Silently returning to idle would look like the button
            // does nothing at all, so this is reported with the remedy for the
            // cause it most often is.
            setState({
              status: 'failed',
              problem: describeCaptureProblem('device_in_use'),
            });
            return;
          }

          setState({
            status: 'recorded',
            blob,
            mimeType: blob.type,
            durationMs: Date.now() - startedAtRef.current,
          });
        };

        recorder.onerror = () => {
          // The recorder died mid-capture; the usual cause is the device being
          // taken away (unplugged, or grabbed by a call).
          fail('device_in_use');
        };

        try {
          recorder.start();
        } catch {
          fail('unsupported');
          return;
        }

        // Courtesy stop at the server's own cap. See `maxDurationMs`.
        maxDurationTimerRef.current = setTimeout(() => {
          maxDurationTimerRef.current = null;
          stop();
        }, maxDurationMs);

        setState({ status: 'recording', startedAt: startedAtRef.current });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        fail(classifyGetUserMediaError(error));
      });
  }, [clearMaxDurationTimer, fail, isMounted, maxDurationMs, stop, stopTracks]);

  return {
    state,
    isRecording: state.status === 'recording',
    recording: state.status === 'recorded' ? state.blob : null,
    start,
    stop,
    release,
  };
}

/**
 * The first container this browser will actually record, or `''` for
 * "you choose". Guarded because `isTypeSupported` is itself optional.
 */
function pickMimeType(recorder: typeof MediaRecorder): string {
  if (typeof recorder.isTypeSupported !== 'function') return '';
  return PREFERRED_MIME_TYPES.find((type) => recorder.isTypeSupported(type)) ?? '';
}

/**
 * Turn a `getUserMedia` rejection into one of the six named problems.
 *
 * The names are the spec's (`MediaDevices.getUserMedia()`), and the mapping is
 * where "six distinct remedies" is either earned or thrown away:
 *
 *   NotAllowedError      the user (or a policy) said no. Chrome distinguishes a
 *                        DISMISSED prompt from a denied one only in the message
 *                        text, so that is read where present and treated as a
 *                        denial otherwise — the safer way round, because
 *                        "reopen the prompt" is useless advice to somebody who
 *                        has actually blocked the site, whereas "change the
 *                        setting" still works for somebody who merely dismissed.
 *   SecurityError        Firefox's shape for capture being forbidden outright,
 *                        which in practice means the origin.
 *   NotFoundError        no device matched. Nothing to permit.
 *   OverconstrainedError a device exists but nothing satisfies the constraints,
 *                        which from the learner's side is the same errand:
 *                        attach something that works.
 *   NotReadableError     the OS or another app has it.
 *   AbortError           it was taken away mid-acquisition. Same errand again.
 *
 * ANYTHING ELSE lands on `device_in_use`, deliberately, and it is worth saying
 * why rather than leaving it as a fallthrough: of the six, it is the only one
 * whose remedy — close whatever else might be using it and try again — is still
 * honest advice when we genuinely do not know what went wrong. A seventh
 * "something went wrong" case would be exactly the generic message this whole
 * union exists to keep off the screen.
 */
export function classifyGetUserMediaError(
  error: unknown,
): AudioCaptureProblemCode {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';
  const message = typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message: unknown }).message)
    : '';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError': // legacy name, still emitted by older builds
      return /dismiss/i.test(message) ? 'permission_dismissed' : 'permission_denied';
    case 'SecurityError':
      return 'insecure_origin';
    case 'NotFoundError':
    case 'DevicesNotFoundError': // legacy
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError': // legacy
      return 'no_device';
    case 'NotSupportedError':
    case 'TypeError':
      return 'unsupported';
    default:
      return 'device_in_use';
  }
}

export default useAudioCapture;

/**
 * Microphone capture, as React state — per answer, or held open for a
 * conversation.
 *
 * Issue #99, epic #58 / E9: one hold of a button produces one `Blob` and
 * nothing else — no file, no cache entry, no object URL, no replay.
 * Issue #308, epic #304 / E13 added the opt-in `persistent` mode below, which
 * changes WHEN the stream is opened and closed and nothing else about any of
 * that.
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
 * All six reach the learner in persistent mode too, including the one that only
 * exists there: a device taken away DURING a hands-free session, which arrives
 * either as the recorder's own `onerror` or as a track ending by itself.
 *
 * =============================================================================
 * PER-ANSWER MODE: THE TRACKS ARE STOPPED THE MOMENT THE LEARNER STOPS SPEAKING
 * =============================================================================
 *
 * This is the default, and it is what `PracticeSessionPage` and
 * `ReadingPracticePage` use. `stream.getTracks().forEach((t) => t.stop())` runs
 * on every exit from a recording: a normal release, a failure, a superseded
 * start, and unmount. This is not resource hygiene. While a track is live the
 * browser shows its own recording indicator — a red dot in the tab, an OS-level
 * microphone light — and a learner who has finished speaking and can still see
 * that light has been told, by their own operating system, that this app is
 * listening to them when it said it had stopped. That is a trust failure, and
 * it is not recoverable by explaining afterwards.
 *
 * =============================================================================
 * PERSISTENT MODE KEEPS THE LIGHT ON, AND MEANS IT — issue #308, epic #304 / E13
 * =============================================================================
 *
 * `persistent: true` is opt-in, and nothing in this app passes it today. It
 * inverts the paragraph above deliberately, for one reason: BARGE-IN. A
 * hands-free conversation has to let a learner answer over the top of the
 * question being read to them, and a stream that only exists between "press"
 * and "release" cannot hear somebody who started talking before either
 * happened. The second reason is smaller and still real: re-opening the device
 * around every answer adds a round-trip to every question, in a loop that pays
 * it ten times a session.
 *
 * So in persistent mode the microphone light stays on for a whole hands-free
 * session — AND THAT IS THE HONEST SIGNAL, because the app really is listening
 * the whole time. The trust argument above was never "keep the light off"; it
 * was "never let the light say something the app is not doing". A per-answer
 * hold that leaves the light on afterwards is a lie. A conversation that keeps
 * it on while it is genuinely listening for the learner's next word is not —
 * provided something puts it out when the conversation ends, and provided the
 * screen that opened it says in words that the microphone is open. The first of
 * those is this file's job, and it is exactly one call:
 *
 *   releaseStream()   STOPS THE TRACKS. The one documented teardown for the
 *                     stream, in either mode. Unmount does the same thing.
 *   release()         does NOT stop a persistent stream — read on.
 *
 * `release()` keeps its E9 meaning unchanged: "drop the recording and go back
 * to idle", which `PracticeSessionPage` calls after EVERY upload settles,
 * success or failure. Widening it to "…and close the microphone" would end a
 * hands-free session after its first answer, from a call site that has no idea
 * it is doing so. Two lifetimes, two names: `release()` ends an ANSWER,
 * `releaseStream()` ends the SESSION. In per-answer mode there is no difference
 * between them, because there the answer IS the session.
 *
 * =============================================================================
 * THE APP MUST NOT HEAR ITSELF — echo cancellation, in both modes
 * =============================================================================
 *
 * With the speaker reading a question aloud and the microphone open at the same
 * time, a bare `getUserMedia({ audio: true })` — which is what this file asked
 * for until #308 — hands back a stream carrying our own text-to-speech, which
 * is then recorded, transcribed, and graded as if the learner had said it.
 * `echoCancellation`, `noiseSuppression` and `autoGainControl` are therefore
 * requested in BOTH modes: a per-answer hold next to a laptop speaker has the
 * same problem, just for less of the time. They are plain booleans rather than
 * `{ exact: true }` so that a device which cannot do them still yields a
 * stream, instead of an `OverconstrainedError` reported as `no_device` about a
 * microphone that is sitting right there.
 *
 * THIS IS A MITIGATION, NOT THE PROTECTION. The structural protection is that
 * `MediaRecorder` starts only on a detected speech onset and never while the
 * app is speaking — and that decision belongs to the conversation driver, a
 * later issue in epic #304, not to this hook. Echo cancellation makes the
 * overlap survivable; it is not what makes it correct.
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
 * `persistent` names the lifetime of the STREAM and nothing else. Neither mode
 * writes a byte of audio anywhere, and a longer-lived microphone is not a
 * longer-lived recording — the blob's span is the same in both.
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
 *
 * A persistent-mode `start()` on an already-warm stream skips `requesting`
 * entirely and is `recording` on the same tick — there is no prompt to sit in
 * front of, which is the latency the mode exists to remove.
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
   *
   * It caps ONE RECORDING, not one stream: in persistent mode the stream
   * outlives this timer, which is restarted for every answer.
   */
  maxDurationMs?: number;

  /**
   * Hold the microphone open across answers. Defaults to `false`.
   *
   * OPT IN ONLY, and read the "PERSISTENT MODE KEEPS THE LIGHT ON" section of
   * the file header before doing so — it changes what the learner's own
   * operating system tells them about this app, and it makes `releaseStream()`
   * (or unmount) the only thing that closes the device.
   *
   * `false` is the E9 behaviour, unchanged in every particular: one hold, one
   * stream, tracks stopped the moment the hold ends.
   */
  persistent?: boolean;
}

/**
 * What a per-answer caller gets. The six members `PushToTalkButton` needs.
 *
 * The three persistent-mode members are deliberately NOT here: in per-answer
 * mode `acquireStream()` would hand back a stream that the very next `start()`
 * has to throw away, and a `stream` field would be null every time anybody
 * outside a hold looked at it. Advertising them on this type would be
 * advertising three calls whose honest documentation is "does nothing useful
 * here" — so the persistent overload of {@link useAudioCapture} returns
 * {@link UsePersistentAudioCaptureReturn} instead, and asking for them is a
 * compile error until you have opted into the mode they belong to.
 */
export interface UseAudioCaptureReturn {
  /** The one state a consumer switches over. See {@link AudioCaptureState}. */
  state: AudioCaptureState;
  /** True exactly while audio is being captured. Drives the visible indicator. */
  isRecording: boolean;
  /** The finished recording, or `null`. The same object as `state.blob`. */
  recording: Blob | null;
  /**
   * Begin. Asks for permission if needed. NEVER THROWS — failures are state.
   *
   * A no-op while a recording is already running, in both modes: a repeated
   * `keydown` (autorepeat) or a doubled pointer event must not drop the
   * recording in progress.
   */
  start: () => void;
  /** End the recording. Stops the tracks too, unless the mode is persistent. */
  stop: () => void;
  /**
   * Drop the recording and clear any problem, returning to `idle`.
   *
   * CALL THIS WHEN THE UPLOAD SETTLES, success or failure. It is the line where
   * the audio stops existing — see the file header and `docs/specs/voice.md`
   * §4. Also the dismiss for a failure message.
   *
   * IT ENDS AN ANSWER, NOT A SESSION. In per-answer mode that also stops the
   * tracks, because there the stream belonged to the answer. In persistent mode
   * it deliberately leaves the microphone open for the next question —
   * `releaseStream()` is what closes it.
   */
  release: () => void;
}

/**
 * What a persistent caller gets: the six above, plus the three that only mean
 * something when the stream outlives the answer.
 */
export interface UsePersistentAudioCaptureReturn extends UseAudioCaptureReturn {
  /**
   * The live capture stream, or `null` when none is open.
   *
   * State, not a ref, so an effect can re-run when it appears: the point of
   * exposing it is that a conversation driver attaches its own `AnalyserNode`
   * for voice-activity detection, and it must be able to do that BEFORE the
   * first `start()` — barge-in on the very first question depends on it.
   *
   * Borrow it; do not close it. The hook owns the tracks, and stopping them
   * from outside leaves this state pointing at a dead stream.
   */
  stream: MediaStream | null;
  /**
   * Open the microphone now, without recording anything.
   *
   * Optional — the first `start()` acquires the stream by itself. Calling it
   * early is what gets the permission prompt, the device round-trip and the
   * analyser wiring out of the way BEFORE the first question is read aloud,
   * which is the difference between hearing the learner interrupt it and not.
   *
   * NEVER THROWS AND NEVER REJECTS: resolves with the live stream, or with
   * `null` when it could not be opened, having put one of the six named
   * problems into `state`. Idempotent and safe to call concurrently — a second
   * call while the prompt is open joins the first rather than opening a second
   * prompt.
   */
  acquireStream: () => Promise<MediaStream | null>;
  /**
   * STOP THE TRACKS. The one call that closes the microphone.
   *
   * This is the teardown the E13 acceptance criterion names: the stream's
   * tracks stay live between recordings, and `releaseStream()` is what stops
   * them. Unmount does the same thing; nothing else does.
   *
   * It is a superset of `release()` — any recording in progress is discarded
   * and the state returns to `idle` — because a session that is over has no use
   * for the answer that was half-said when it ended. Call it when the
   * hands-free session ends, on every path out of it.
   */
  releaseStream: () => void;
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

/**
 * What we ask the device for, in BOTH modes. See "THE APP MUST NOT HEAR
 * ITSELF" in the file header for why these three and why they are plain
 * booleans (ideal) rather than `{ exact: true }` (required).
 */
const CAPTURE_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * The outcome of one attempt to open the microphone.
 *
 * Three cases, not two, and the third is the one worth naming: `abandoned`
 * means nobody is waiting for this stream any more — the hold ended while the
 * prompt was open, or the component unmounted, or `releaseStream()` ran. A
 * failure THERE must not be reported, because there is no longer a screen it
 * belongs to; folding it into `failed` would flash a microphone error at a
 * learner who has already moved on.
 */
type StreamAttempt =
  | { status: 'ok'; stream: MediaStream }
  | { status: 'failed'; code: AudioCaptureProblemCode }
  | { status: 'abandoned' };

export function useAudioCapture(
  options: UseAudioCaptureOptions & { persistent: true },
): UsePersistentAudioCaptureReturn;
export function useAudioCapture(
  options?: UseAudioCaptureOptions,
): UseAudioCaptureReturn;
export function useAudioCapture(
  options: UseAudioCaptureOptions = {},
): UsePersistentAudioCaptureReturn {
  const { maxDurationMs = DEFAULT_MAX_DURATION_MS, persistent = false } = options;

  const [state, setState] = useState<AudioCaptureState>({ status: 'idle' });
  const isMounted = useIsMounted();

  /**
   * The live stream, published for rendering. PERSISTENT MODE ONLY.
   *
   * `streamRef` below remains the reference every lifecycle decision is made
   * against; this is a mirror of it, and it exists only so an effect can attach
   * an analyser when the stream appears. In per-answer mode it is never written
   * at all — nothing outside a hold could use it, and not writing it keeps that
   * mode's render behaviour exactly as E9 shipped it.
   */
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null);

  /** The live stream. THE reference the hook acts on — see `stopTracks`. */
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
   * Which STREAM we are on. Persistent mode's answer to the same question.
   *
   * A hold is the wrong unit for a persistent acquisition: the stream outlives
   * every hold by design, so "is this still wanted?" cannot be "is this still
   * the current hold?" — a learner who lets go while the prompt is open still
   * wants the microphone for the next question. It is bumped by `stopTracks`,
   * which is every path that decides the current stream is finished with, so an
   * acquisition that lands afterwards knows to stop the tracks it was handed
   * rather than install them behind a session that has ended.
   */
  const streamGenRef = useRef(0);

  /** A persistent acquisition in flight, so a second caller joins it. */
  const acquisitionRef = useRef<Promise<StreamAttempt> | null>(null);

  const publishStream = useCallback(
    (stream: MediaStream | null) => {
      if (!persistent) return;
      if (isMounted()) setLiveStream(stream);
    },
    [isMounted, persistent],
  );

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
    // Bumped whether or not a stream was actually held: this call is the
    // decision that nobody wants the current one, and an acquisition in flight
    // is an acquisition of exactly that.
    streamGenRef.current += 1;
    acquisitionRef.current = null;
    publishStream(null);
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
  }, [publishStream]);

  /**
   * End the stream that belonged to THIS ANSWER.
   *
   * Per-answer mode: the stream is the hold's, so this is `stopTracks` and the
   * indicator light goes out with the learner's last word. Persistent mode: the
   * stream is the SESSION's, so this is a no-op and `releaseStream()` is the
   * only thing that stops it. Every "the answer is over" path calls this;
   * nothing calls `stopTracks` directly except the paths that genuinely mean
   * "the microphone is finished with" — failure, `releaseStream`, unmount.
   */
  const endAnswerStream = useCallback(() => {
    if (persistent) return;
    stopTracks();
  }, [persistent, stopTracks]);

  const clearMaxDurationTimer = useCallback(() => {
    if (maxDurationTimerRef.current === null) return;
    clearTimeout(maxDurationTimerRef.current);
    maxDurationTimerRef.current = null;
  }, []);

  /** Discard the recorder and anything it captured. Leaves the stream alone. */
  const teardownRecorder = useCallback(() => {
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
        // stopped by the caller when that is what the caller meant.
      }
    }
    chunksRef.current = [];
  }, [clearMaxDurationTimer]);

  /** Tear down everything, keeping no audio and no microphone. */
  const teardown = useCallback(() => {
    teardownRecorder();
    stopTracks();
  }, [stopTracks, teardownRecorder]);

  // Unmount ends the recording AND the stream, in both modes. A learner who
  // navigates away mid-sentence — or mid-conversation — must not leave a live
  // microphone (and its indicator light) behind them.
  useEffect(() => teardown, [teardown]);

  const release = useCallback(() => {
    holdRef.current += 1;
    teardownRecorder();
    // Per-answer: the stream was this answer's, so it goes here, exactly as it
    // did in E9. Persistent: the session keeps listening. See the header.
    endAnswerStream();
    if (isMounted()) setState({ status: 'idle' });
  }, [endAnswerStream, isMounted, teardownRecorder]);

  const releaseStream = useCallback(() => {
    holdRef.current += 1;
    teardown();
    if (isMounted()) setState({ status: 'idle' });
  }, [isMounted, teardown]);

  const fail = useCallback(
    (code: AudioCaptureProblemCode) => {
      // A named problem is always about the microphone itself, so it takes the
      // stream with it in BOTH modes: after a device is unplugged mid-session,
      // leaving the indicator light on would be the app claiming to listen
      // through a device that is not there. The next `start()` or
      // `acquireStream()` asks again, which is what every remedy tells the
      // learner to expect.
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
      // The in-flight `getUserMedia` is now on a stale hold; in per-answer mode
      // it will stop whatever stream it is handed, and in persistent mode it
      // will keep it warm for the next question. Either way there is nothing
      // recorded to keep.
      endAnswerStream();
      if (isMounted()) {
        setState((current) =>
          current.status === 'requesting' ? { status: 'idle' } : current,
        );
      }
      return;
    }

    if (recorder.state === 'inactive') {
      endAnswerStream();
      return;
    }

    // `onstop` (installed in `beginRecording`) assembles the blob and, in
    // per-answer mode, stops the tracks. The tracks are NOT stopped here first:
    // a track killed before the recorder has flushed can truncate the final
    // chunk, which is the learner's last word — and being cut off mid-answer is
    // exactly the "the recognizer mangled it" experience §3 exists to keep out
    // of a grade.
    recorder.stop();
  }, [clearMaxDurationTimer, endAnswerStream, isMounted]);

  /**
   * Notice a device that goes away mid-session. PERSISTENT MODE ONLY.
   *
   * `track.stop()` does not fire `ended` — the spec reserves it for a track
   * that ended for some other reason, which in practice means the headset was
   * unplugged or the OS took the device. In per-answer mode the recorder's own
   * `onerror` already covers that window, because there IS no window in which
   * a stream is open and no recorder is running. Persistent mode invents one,
   * so it has to watch for the loss itself.
   */
  const watchForTrackLoss = useCallback(
    (stream: MediaStream) => {
      stream.getTracks().forEach((track) => {
        if (typeof track.addEventListener !== 'function') return;
        track.addEventListener(
          'ended',
          () => {
            // Ignore a track from a stream we have already moved on from.
            if (streamRef.current !== stream) return;
            fail('device_in_use');
          },
          { once: true },
        );
      });
    },
    [fail],
  );

  /**
   * One `getUserMedia` call, classified. Never throws.
   *
   * `isCurrent` is the caller's own answer to "does anybody still want this?" —
   * hold-scoped for a per-answer start, stream-generation-scoped for a
   * persistent acquisition. See {@link StreamAttempt} for why `abandoned` is a
   * case of its own rather than a failure.
   */
  const requestStream = useCallback(
    async (isCurrent: () => boolean): Promise<StreamAttempt> => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: CAPTURE_CONSTRAINTS,
        });

        if (!isCurrent()) {
          // Stop the tracks we were just handed — see `holdRef`/`streamGenRef`.
          stream.getTracks().forEach((track) => track.stop());
          return { status: 'abandoned' };
        }

        streamRef.current = stream;
        publishStream(stream);
        if (persistent) watchForTrackLoss(stream);
        return { status: 'ok', stream };
      } catch (error) {
        if (!isCurrent()) return { status: 'abandoned' };
        return { status: 'failed', code: classifyGetUserMediaError(error) };
      }
    },
    [persistent, publishStream, watchForTrackLoss],
  );

  /**
   * The persistent stream, opening it if it is not open yet.
   *
   * Three ways to already have an answer, in this order: a live stream, an
   * acquisition somebody else started, or a preflight failure. Only the fourth
   * case reaches the device — which is what makes "`getUserMedia` is called
   * exactly once per session" true even when the driver calls
   * `acquireStream()` and `start()` in the same tick.
   */
  const acquirePersistentStream = useCallback((): Promise<StreamAttempt> => {
    const live = streamRef.current;
    if (live) return Promise.resolve({ status: 'ok', stream: live });

    const inFlight = acquisitionRef.current;
    if (inFlight) return inFlight;

    const code = preflightCaptureProblem();
    if (code) {
      fail(code);
      return Promise.resolve({ status: 'failed', code });
    }

    const generation = streamGenRef.current;
    const attempt: Promise<StreamAttempt> = requestStream(
      () => isMounted() && streamGenRef.current === generation,
    ).then((result) => {
      // Only if it is still OURS: `stopTracks` clears the slot, and a newer
      // acquisition may already have claimed it.
      if (acquisitionRef.current === attempt) acquisitionRef.current = null;
      // Reported here rather than by the caller because a persistent
      // acquisition is not a hold: `acquireStream()` has no hold at all, and
      // its failure is still the learner's to see.
      if (result.status === 'failed') fail(result.code);
      return result;
    });

    acquisitionRef.current = attempt;
    return attempt;
  }, [fail, isMounted, requestStream]);

  const acquireStream = useCallback(async (): Promise<MediaStream | null> => {
    // A no-op in per-answer mode, where the stream is the hold's and `start()`
    // opens it. The overload above keeps this unreachable from that mode.
    if (!persistent) return null;
    const result = await acquirePersistentStream();
    return result.status === 'ok' ? result.stream : null;
  }, [acquirePersistentStream, persistent]);

  /** Put a recorder on a stream we already hold, and start it. */
  const beginRecording = useCallback(
    (stream: MediaStream) => {
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

        // FIRST, before any state work: in per-answer mode the indicator light
        // goes out when the learner stops speaking, not when React gets around
        // to a render. In persistent mode this is a no-op and the light stays
        // on for the session — see the header.
        endAnswerStream();

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
        // taken away (unplugged, or grabbed by a call). In persistent mode this
        // is the mid-session device loss, and `fail` takes the session's stream
        // down with it rather than leaving a light on over a dead device.
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
    },
    [clearMaxDurationTimer, endAnswerStream, fail, isMounted, maxDurationMs, stop],
  );

  const start = useCallback(() => {
    // ---- "already recording" is a no-op, in both modes ---------------------
    //
    // Supersede nothing: a second start while one is live is a no-op rather
    // than a restart, so a repeated `keydown` (autorepeat) or a pointer event
    // fired twice cannot drop the recording already in progress.
    //
    // A LIVE RECORDER IS THE WHOLE TEST IN PERSISTENT MODE. E9 also treated a
    // live STREAM as "already recording", which was exact then — a stream only
    // existed inside a hold — and would be catastrophic now: a persistent
    // stream is live between every pair of answers, so that clause alone would
    // make `start()` a permanent no-op from the second question onwards, in
    // silence. It is kept, unweakened, for per-answer mode, where a held stream
    // still means a hold in progress whose recorder has not been built yet.
    if (recorderRef.current) return;
    if (!persistent && streamRef.current) return;

    const hold = holdRef.current + 1;
    holdRef.current = hold;
    const isCurrent = () => holdRef.current === hold && isMounted();

    // ---- Preflight, in this order, and the order is the point --------------
    // See `preflightCaptureProblem` — `insecure_origin` before `unsupported`.
    const problem = preflightCaptureProblem();
    if (problem) {
      fail(problem);
      return;
    }

    // Persistent and already warm: no prompt, no device round-trip, and no
    // `requesting` state to pass through. This is the latency the mode buys.
    const warm = persistent ? streamRef.current : null;
    if (warm) {
      beginRecording(warm);
      return;
    }

    setState({ status: 'requesting' });

    const attempt = persistent
      ? acquirePersistentStream()
      : requestStream(isCurrent);

    void attempt.then((result) => {
      if (result.status === 'abandoned') return;

      if (result.status === 'failed') {
        // Persistent acquisitions report their own failures (they are not
        // hold-scoped, and `acquireStream()` callers need the same named
        // problem); a per-answer one is this hold's to report, and only if the
        // hold is still the current one.
        if (!persistent && isCurrent()) fail(result.code);
        return;
      }

      if (!isCurrent()) {
        // The hold ended while the prompt was open. Per-answer: the stream was
        // this hold's, so it goes. Persistent: it is the session's and stays
        // warm for the next question.
        endAnswerStream();
        return;
      }

      beginRecording(result.stream);
    });
  }, [
    acquirePersistentStream,
    beginRecording,
    endAnswerStream,
    fail,
    isMounted,
    persistent,
    requestStream,
  ]);

  return {
    state,
    isRecording: state.status === 'recording',
    recording: state.status === 'recorded' ? state.blob : null,
    start,
    stop,
    release,
    stream: liveStream,
    acquireStream,
    releaseStream,
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
 * The two failures that are known before the prompt, or `null` to go ahead.
 *
 * THE ORDER IS THE POINT. `insecure_origin` IS CHECKED FIRST because a browser
 * on an insecure origin does not merely refuse capture — it deletes
 * `navigator.mediaDevices` entirely. Checking support first would therefore
 * report `unsupported` on a perfectly capable browser, and send the learner off
 * to install a different one when the actual fix is the address bar.
 *
 * The support check needs both halves: Safari shipped `getUserMedia` years
 * before `MediaRecorder`, so a browser can grant a microphone and still have no
 * way to record from it. Discovering that AFTER the permission prompt would ask
 * a learner to hand over their microphone for nothing.
 *
 * A module-level function rather than a step inside `start`, because since #308
 * `acquireStream()` reaches the device without going through `start` and has to
 * run exactly the same two checks in exactly the same order.
 */
function preflightCaptureProblem(): AudioCaptureProblemCode | null {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return 'insecure_origin';
  }

  const mediaDevices =
    typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  if (
    !mediaDevices?.getUserMedia ||
    typeof window === 'undefined' ||
    typeof window.MediaRecorder === 'undefined'
  ) {
    return 'unsupported';
  }

  return null;
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

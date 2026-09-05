/**
 * `useConversationSession` — the hands-free loop, driven by fakes.
 *
 * Issue #312, epic #304 / E13. Every port the driver uses is injected, which
 * is what lets the whole six-state machine be exercised here: a fake
 * microphone, a fake voice-activity detector, a fake voice, and a
 * `transcribe`/`submit` pair that resolve whatever the case is about. The
 * suite is organised around the claims that fail SILENTLY in the field —
 * nothing below throws when it breaks, and a learner on a walk is the only
 * one who would notice:
 *
 *   1. THE RECORDER IS NEVER RUNNING WHILE THE APP IS TALKING. If it is, the
 *      app transcribes its own text-to-speech and grades a learner against an
 *      answer they never gave. There is no stack trace for that; there is a
 *      wrong mark on a question they knew.
 *   2. SILENCE IS NEVER GRADED. A hangover-driven detector produces empty
 *      transcripts routinely, and every one of them auto-submitted is an
 *      attempt recorded for a question nobody answered.
 *   3. THE RETRY BUDGET IS EXACTLY ONE. A broken microphone must not be able
 *      to hold a learner on one question forever, whichever way it is broken.
 *   4. EVERY INVOLUNTARY EXIT IS SPOKEN. The premise of the mode is a phone
 *      that is not being looked at, so an exit that is only rendered is an
 *      exit nobody receives — and it must release the microphone and the wake
 *      lock on its way out.
 *   5. THE LEARNER'S OWN CONTROLS WORK FROM EVERY PHASE. Stop, Type instead
 *      and Next never wait for a timer or a threshold.
 *
 * Issue #314 added three more claims, each because the child issues above
 * left it uncovered rather than because it changed:
 *
 *   6. THE FOUR HOOKS COMPOSE AS ONE CHAIN, IN ORDER. Every test for claim 1
 *      above proves one edge of `endOfTurn → capture.stop() → transcribe()
 *      → submit()` in isolation; the "one composed chain" describe block
 *      drives all four as a single sequence and asserts on
 *      `mock.invocationCallOrder`, which no single-transition test does.
 *   7. THE RETRY BUDGET IS A PROPERTY, NOT AN EXAMPLE. Claim 3's own tests
 *      are specific sequences (wrong-then-wrong, empty-then-wrong); "the
 *      retry budget as a PROPERTY" drives every ordered pair of the five
 *      miss kinds this hook recognises (25 sequences) and asserts the one
 *      invariant that must hold for all of them.
 *   8. UNMOUNT RELEASES THE STREAM, THE WAKE LOCK, THE VOICE **AND THE
 *      SHARED AUDIOCONTEXT**, IN EVERY STATE. The unmount describe block's
 *      own `PHASES` array was missing `speakingAnswer` before this issue —
 *      every other phase-enumerated block in this file already lists all
 *      five — and none of its tests asserted `closeSharedAudioContext()`
 *      (`../../lib/earcons`, now spied at the top of this file) was ever
 *      called at all.
 *
 * =============================================================================
 * WHAT THIS SUITE DOES NOT TEST — AND CANNOT
 * =============================================================================
 *
 * Nothing acoustic, and nothing about whether the loop FEELS like a
 * conversation. jsdom has no microphone, no speaker and no room; the detector
 * and the voice arrive here as objects whose methods were called. Read a green
 * run as "the machine transitions correctly, and releases what it holds" —
 * `docs/specs/conversation-mode.md` §16 puts the acoustic half in the manual
 * checklist on purpose.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONVERSATION_ADVANCE_PAUSE_MS,
  CONVERSATION_NOTICE_GRADE_FAILED,
  CONVERSATION_NOTICE_NO_ANSWER,
  CONVERSATION_NOTICE_SESSION_COMPLETE,
  CONVERSATION_NOTICE_TRANSCRIBE_UNAVAILABLE,
  CONVERSATION_NUDGE_EMPTY,
  CONVERSATION_NUDGE_RETRY,
  CONVERSATION_NUDGE_SILENCE,
  CONVERSATION_NUDGE_TRANSCRIBE_FAILED,
  CONVERSATION_RECORDING_WAIT_MS,
  useConversationSession,
  type ConversationGrade,
  type ConversationPhase,
  type ConversationSpeechKind,
  type ConversationSpeechOutcome,
  type UseConversationSessionOptions,
} from '../../hooks/useConversationSession';
import {
  describeCaptureProblem,
  type AudioCaptureProblemCode,
  type AudioCaptureState,
} from '../../hooks/useAudioCapture';
import type { TranscribeResponse } from '../../types';
import type { VoiceActivityEvent } from '../../hooks/useVoiceActivity';

// ---------------------------------------------------------------------------
// `../../lib/earcons`, spied rather than left real. jsdom has no `AudioContext`
// at all, so `closeSharedAudioContext()` is already a no-op there — a green
// suite proves the CALL happens on every way out, never that a context was
// genuinely closed (that half is `earcons.test.ts`'s own job, against a fake
// `AudioContext` it installs). `vi.hoisted` is what lets these spies exist
// before `vi.mock`'s factory runs, the same device
// `PracticeSessionPage.conversation.test.tsx` uses for its own capture/VAD
// mocks.
// ---------------------------------------------------------------------------

const earconsSpies = vi.hoisted(() => ({
  closeSharedAudioContext: vi.fn(),
  playCapturedEarcon: vi.fn(),
  playListeningEarcon: vi.fn(),
  startProcessingPulse: vi.fn(),
  stopProcessingPulse: vi.fn(),
}));

vi.mock('../../lib/earcons', () => earconsSpies);

// ---------------------------------------------------------------------------
// `navigator.wakeLock`, faked — enough of it to prove the lock is taken while
// the loop runs and dropped on every way out of it.
// ---------------------------------------------------------------------------

class FakeSentinel {
  released = false;
  release = vi.fn(() => {
    this.released = true;
    return Promise.resolve();
  });
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

let sentinels: FakeSentinel[] = [];

function installWakeLock(): void {
  sentinels = [];
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: vi.fn(() => {
        const sentinel = new FakeSentinel();
        sentinels.push(sentinel);
        return Promise.resolve(sentinel as unknown as WakeLockSentinel);
      }),
    },
  });
}

function removeWakeLock(): void {
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'wakeLock');
}

// ---------------------------------------------------------------------------
// The harness. Every port is a plain object the case can reach into, and
// `props()` re-snapshots them so a `rerender` carries whatever changed.
// ---------------------------------------------------------------------------

const QUESTION_ONE = { id: 'q1', text: 'What is the supreme law of the land?' };
const QUESTION_TWO = { id: 'q2', text: 'What does the Constitution do?' };

interface HeldSpeech {
  text: string;
  kind: ConversationSpeechKind;
  resolve: (outcome: ConversationSpeechOutcome) => void;
}

function makeHarness() {
  // ---- the microphone ----------------------------------------------------
  const captureState: { current: AudioCaptureState } = {
    current: { status: 'idle' },
  };
  const recording: { current: Blob | null } = { current: null };

  const capture = {
    get state() {
      return captureState.current;
    },
    get isRecording() {
      return captureState.current.status === 'recording';
    },
    get recording() {
      return recording.current;
    },
    start: vi.fn(() => {
      captureState.current = { status: 'recording', startedAt: 0 };
    }),
    stop: vi.fn(() => {
      captureState.current = { status: 'idle' };
    }),
    release: vi.fn(() => {
      recording.current = null;
      captureState.current = { status: 'idle' };
    }),
    acquireStream: vi.fn(() => Promise.resolve({} as MediaStream)),
    // Issue #347: the driver opens the pre-roll window when the microphone
    // opens for the learner, so the first syllable is inside the blob.
    startPreRoll: vi.fn(),
    releaseStream: vi.fn(),
    stream: {} as MediaStream | null,
  };

  // ---- the detector ------------------------------------------------------
  const voiceActivity = { arm: vi.fn(), disarm: vi.fn() };

  // ---- the voice ---------------------------------------------------------
  const spoken: Array<{ text: string; kind: ConversationSpeechKind }> = [];
  const held: HeldSpeech[] = [];
  const speech = {
    /** While true, nothing resolves until the case says so. Barge-in needs it. */
    hold: false,
    calls: spoken,
    held,
    speak: vi.fn((text: string, kind: ConversationSpeechKind) => {
      spoken.push({ text, kind });
      if (!speech.hold) return Promise.resolve<ConversationSpeechOutcome>('ended');
      return new Promise<ConversationSpeechOutcome>((resolve) => {
        held.push({ text, kind, resolve });
      });
    }),
    stop: vi.fn(),
    /** Resolve the oldest held utterance. */
    settle(outcome: ConversationSpeechOutcome = 'ended') {
      held.shift()?.resolve(outcome);
    },
    /** Did the driver say this, in any kind? */
    said(text: string) {
      return spoken.some((entry) => entry.text === text);
    },
  };

  // ---- the calls ---------------------------------------------------------
  const transcribe = vi.fn<[Blob], Promise<TranscribeResponse>>(() =>
    Promise.resolve({ status: 'ok', text: 'the constitution', confidence: 0.9 }),
  );
  const submit = vi.fn<
    [string, number | null],
    Promise<ConversationGrade | null>
  >(() =>
    Promise.resolve<ConversationGrade>({
      outcome: 'correct',
      spokenAnswer: 'the Constitution',
    }),
  );

  const question = { current: QUESTION_ONE as { id: string; text: string } | null };
  const advance = vi.fn(() => {
    question.current = QUESTION_TWO;
  });

  const harness = {
    capture,
    voiceActivity,
    speech,
    transcribe,
    submit,
    advance,
    question,
    captureState,
    recording,
    props(): UseConversationSessionOptions {
      return {
        capture,
        voiceActivity,
        speech,
        transcribe,
        submit,
        advance,
        questionId: question.current?.id ?? null,
        questionText: question.current?.text ?? null,
      };
    },
    /** What `MediaRecorder` would hand back after a `stop()`. */
    deliverRecording(blob = new Blob(['audio'])) {
      recording.current = blob;
      captureState.current = {
        status: 'recorded',
        blob,
        mimeType: 'audio/webm',
        durationMs: 1_000,
      };
      return blob;
    },
    /** One of the six named failures, from the hook's own copy table. */
    failCapture(code: AudioCaptureProblemCode) {
      captureState.current = { status: 'failed', problem: describeCaptureProblem(code) };
    },
  };

  return harness;
}

type Harness = ReturnType<typeof makeHarness>;

function mount(harness: Harness) {
  return renderHook(
    (props: UseConversationSessionOptions) => useConversationSession(props),
    { initialProps: harness.props() },
  );
}

type Mounted = ReturnType<typeof mount>;

/** Flush pending microtasks and any timer the loop is sitting on. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Start, open the device, read the question, and land in `listening`. */
async function startToListening(
  harness: Harness,
  view: Mounted,
): Promise<void> {
  await act(async () => {
    view.result.current.start();
  });
  view.rerender(harness.props());
  await settle();
  view.rerender(harness.props());
}

function fire(view: Mounted, event: VoiceActivityEvent): void {
  act(() => {
    view.result.current.onVoiceActivityEvent(event);
  });
}

const ONSET: VoiceActivityEvent = { type: 'onset', at: 1_000 };
const END_OF_TURN: VoiceActivityEvent = {
  type: 'endOfTurn',
  at: 3_000,
  speechStartedAt: 1_000,
  speechDurationMs: 2_000,
};

/** Say the answer, hand over the bytes, and let the grade land. */
async function speakAnswer(harness: Harness, view: Mounted): Promise<void> {
  fire(view, ONSET);
  fire(view, END_OF_TURN);
  await act(async () => {
    harness.deliverRecording();
    view.rerender(harness.props());
    await vi.advanceTimersByTimeAsync(0);
  });
  view.rerender(harness.props());
  await settle();
  view.rerender(harness.props());
}

const phaseOf = (view: Mounted): ConversationPhase => view.result.current.phase;

beforeEach(() => {
  vi.useFakeTimers();
  installWakeLock();
});

afterEach(() => {
  vi.useRealTimers();
  removeWakeLock();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe('useConversationSession — the happy loop, transition by transition', () => {
  it('idle → speakingQuestion on start: opens the stream, arms barge-in, reads the question', async () => {
    const harness = makeHarness();
    harness.speech.hold = true;
    const view = mount(harness);

    expect(phaseOf(view)).toBe('idle');

    await act(async () => {
      view.result.current.start();
    });

    expect(phaseOf(view)).toBe('speakingQuestion');
    expect(harness.capture.acquireStream).toHaveBeenCalledTimes(1);
    expect(harness.voiceActivity.arm).toHaveBeenLastCalledWith('barge-in');
    expect(harness.speech.calls).toEqual([
      { text: QUESTION_ONE.text, kind: 'question' },
    ]);
    // The wake lock is taken by entering a running phase, not by a separate call.
    expect(view.result.current.isRunning).toBe(true);
    expect(sentinels).toHaveLength(1);
  });

  it('speakingQuestion → listening when playback ends, with the rising cue and the detector re-armed', async () => {
    const harness = makeHarness();
    const view = mount(harness);

    await startToListening(harness, view);

    expect(phaseOf(view)).toBe('listening');
    expect(harness.voiceActivity.arm).toHaveBeenLastCalledWith('listening');
  });

  it('listening → processing on end of turn, and only then is the recorder stopped', async () => {
    const harness = makeHarness();
    const view = mount(harness);
    await startToListening(harness, view);

    fire(view, ONSET);
    expect(harness.capture.start).toHaveBeenCalledTimes(1);
    expect(harness.capture.stop).not.toHaveBeenCalled();

    fire(view, END_OF_TURN);
    expect(phaseOf(view)).toBe('processing');
    expect(harness.capture.stop).toHaveBeenCalledTimes(1);
    expect(harness.voiceActivity.disarm).toHaveBeenCalled();
  });

  it('processing → speakingAnswer → advancing → the next question, on a correct answer', async () => {
    const harness = makeHarness();
    const view = mount(harness);
    await startToListening(harness, view);
    await speakAnswer(harness, view);

    expect(harness.transcribe).toHaveBeenCalledTimes(1);
    expect(harness.submit).toHaveBeenCalledWith('the constitution', 0.9);
    // The accepted answer was read aloud before moving on.
    expect(harness.speech.calls).toContainEqual({
      text: 'the Constitution',
      kind: 'answer',
    });
    expect(phaseOf(view)).toBe('advancing');
    expect(harness.advance).not.toHaveBeenCalled();

    await settle(CONVERSATION_ADVANCE_PAUSE_MS);
    expect(harness.advance).toHaveBeenCalledTimes(1);

    // The host moved the screen on; the loop follows it, budget reset.
    view.rerender(harness.props());
    await settle();
    view.rerender(harness.props());
    expect(phaseOf(view)).toBe('listening');
    expect(harness.speech.calls).toContainEqual({
      text: QUESTION_TWO.text,
      kind: 'question',
    });
  });

  it('the audio stops existing the moment transcription settles', async () => {
    const harness = makeHarness();
    const view = mount(harness);
    await startToListening(harness, view);
    await speakAnswer(harness, view);

    expect(harness.capture.release).toHaveBeenCalled();
    expect(harness.capture.recording).toBeNull();
  });

  it('a null questionId while running ends the session, spoken', async () => {
    const harness = makeHarness();
    const view = mount(harness);
    await startToListening(harness, view);

    harness.question.current = null;
    view.rerender(harness.props());
    await settle();

    expect(phaseOf(view)).toBe('idle');
    expect(view.result.current.notice?.reason).toBe('session_complete');
    expect(harness.speech.said(CONVERSATION_NOTICE_SESSION_COMPLETE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//
// CROSS-HOOK COMPOSITION, AS ONE CHAIN (issue #314). Every test above this
// point proves ONE transition in isolation — "end of turn stops the
// recorder" is its own `it`, and "processing ends with `submit` called" is a
// different one. Neither, on its own, proves the four stages are actually
// COUPLED in the right order: a regression that let `submit` race ahead of
// `capture.stop()` (say, a dropped `await`) would still pass both of those
// tests, because each only checks its own edge of the chain. The two tests
// below drive the whole thing — VAD `endOfTurn` → recorder `stop()` →
// `transcribe(blob)` → `submit(transcript, confidence)` — as one sequence and
// assert on ORDER (`mock.invocationCallOrder`) and on VALUE FLOW (the exact
// blob reaching `transcribe`, the exact text/confidence reaching `submit`),
// neither of which any single-transition test above establishes.
// ---------------------------------------------------------------------------

describe('useConversationSession — one composed chain: end of turn → recorder stop → transcribe → submit', () => {
  it('the four stages fire in order, each fed the value the one before it produced', async () => {
    const harness = makeHarness();
    harness.transcribe.mockResolvedValue({
      status: 'ok',
      text: 'the constitution',
      confidence: 0.87,
    });
    const view = mount(harness);
    await startToListening(harness, view);

    fire(view, ONSET);
    fire(view, END_OF_TURN);
    // END OF TURN -> RECORDER STOP, before anything downstream runs.
    expect(phaseOf(view)).toBe('processing');
    expect(harness.capture.stop).toHaveBeenCalledTimes(1);
    expect(harness.transcribe).not.toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();

    const blob = new Blob(['spoken']);
    await act(async () => {
      harness.deliverRecording(blob);
      view.rerender(harness.props());
      await vi.advanceTimersByTimeAsync(0);
    });

    // RECORDER STOP -> TRANSCRIBE, fed the EXACT blob the recorder delivered.
    // (Both mocks resolve on already-settled promises, so by the time this
    // `act` returns TRANSCRIBE has already run and fed straight into SUBMIT
    // in the same microtask flush — asserted on below by VALUE and by
    // ORDER, which is the honest way to prove the coupling here rather than
    // an intermediate "not yet called" this fake's synchronicity cannot
    // support.)
    expect(harness.transcribe).toHaveBeenCalledTimes(1);
    expect(harness.transcribe).toHaveBeenCalledWith(blob);

    view.rerender(harness.props());
    await settle();
    view.rerender(harness.props());

    // TRANSCRIBE -> SUBMIT, fed the EXACT text and confidence transcribe
    // resolved — not a value the driver invented, and not the raw blob.
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.submit).toHaveBeenCalledWith('the constitution', 0.87);

    // AND IN THAT ORDER. A race that let `submit` fire before the recorder
    // had genuinely stopped would satisfy every assertion above this line
    // and fail only this one.
    const stopOrder = harness.capture.stop.mock.invocationCallOrder[0];
    const transcribeOrder = harness.transcribe.mock.invocationCallOrder[0];
    const submitOrder = harness.submit.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(transcribeOrder);
    expect(transcribeOrder).toBeLessThan(submitOrder);
  });

  it('a retry composes the SAME four-stage chain again, from a fresh onset — never a replay of turn 1', async () => {
    const harness = makeHarness();
    harness.submit.mockResolvedValueOnce({
      outcome: 'incorrect',
      spokenAnswer: 'the Constitution',
    });
    const view = mount(harness);
    await startToListening(harness, view);
    await speakAnswer(harness, view); // turn 1: a miss, one retry offered
    expect(phaseOf(view)).toBe('listening');

    const startsBefore = harness.capture.start.mock.calls.length;
    const stopsBefore = harness.capture.stop.mock.calls.length;
    const transcribesBefore = harness.transcribe.mock.calls.length;
    const submitsBefore = harness.submit.mock.calls.length;

    fire(view, ONSET);
    expect(harness.capture.start.mock.calls.length).toBe(startsBefore + 1);
    fire(view, END_OF_TURN);
    expect(harness.capture.stop.mock.calls.length).toBe(stopsBefore + 1);

    const retryBlob = new Blob(['retry']);
    await act(async () => {
      harness.deliverRecording(retryBlob);
      view.rerender(harness.props());
      await vi.advanceTimersByTimeAsync(0);
    });
    view.rerender(harness.props());
    await settle();
    view.rerender(harness.props());

    // A SECOND, INDEPENDENT run of the chain — its own `transcribe(blob)`
    // call on the retry's own bytes, its own `submit`, not turn 1's cached
    // result replayed.
    expect(harness.transcribe.mock.calls.length).toBe(transcribesBefore + 1);
    expect(harness.transcribe).toHaveBeenLastCalledWith(retryBlob);
    expect(harness.submit.mock.calls.length).toBe(submitsBefore + 1);
  });
});

// ---------------------------------------------------------------------------

describe('useConversationSession — the recorder never runs while the app talks', () => {
  it('does not start the recorder in speakingQuestion, even on an onset', async () => {
    const harness = makeHarness();
    harness.speech.hold = true;
    const view = mount(harness);

    await act(async () => {
      view.result.current.start();
    });
    expect(phaseOf(view)).toBe('speakingQuestion');

    // A detector armed for barge-in does not emit `onset`, but a mis-armed one
    // would — and the recorder must still refuse.
    fire(view, ONSET);
    expect(harness.capture.start).not.toHaveBeenCalled();
  });

  it('does not start the recorder in speakingAnswer', async () => {
    const harness = makeHarness();
    const view = mount(harness);
    await startToListening(harness, view);

    harness.speech.hold = true;
    fire(view, ONSET);
    fire(view, END_OF_TURN);
    await act(async () => {
      harness.deliverRecording();
      view.rerender(harness.props());
      await vi.advanceTimersByTimeAsync(0);
    });
    view.rerender(harness.props());
    await settle();
    view.rerender(harness.props());

    expect(phaseOf(view)).toBe('speakingAnswer');
    const before = harness.capture.start.mock.calls.length;
    fire(view, ONSET);
    expect(harness.capture.start.mock.calls.length).toBe(before);
  });

  it('starts the recorder on onset and nowhere else across a whole question', async () => {
    const harness = makeHarness();
    const view = mount(harness);
    await startToListening(harness, view);

    expect(harness.capture.start).not.toHaveBeenCalled();
    fire(view, ONSET);
    expect(harness.capture.start).toHaveBeenCalledTimes(1);

    await speakAnswer(harness, view);
    // `speakAnswer` fires a second onset of its own; nothing else started it.
    expect(harness.capture.start).toHaveBeenCalledTimes(2);
  });

  // ---- The pre-roll — issue #347, epic #345 -------------------------------
  //
  // It moves the recorder EARLIER inside the window where it was always
  // allowed to run, and nowhere else: `listening` is entered after
  // `speech.stop()`, so the app is by definition not talking there.

  it('opens the pre-roll window when the microphone opens for the learner', async () => {
    const harness = makeHarness();
    const view = mount(harness);
    await startToListening(harness, view);

    // The detector cannot report an onset until 145-190 ms after the learner
    // began; the window has to already be filling by then or there is nothing
    // in front of the onset to keep.
    expect(harness.capture.startPreRoll).toHaveBeenCalledTimes(1);
    expect(harness.capture.start).not.toHaveBeenCalled();
  });

  it('does NOT open it while the app is speaking', async () => {
    const harness = makeHarness();
    harness.speech.hold = true;
    const view = mount(harness);

    await act(async () => {
      view.result.current.start();
    });

    expect(phaseOf(view)).toBe('speakingQuestion');
    // The whole structural guarantee: no recorder of any kind runs over the
    // app's own voice, so the app can never transcribe itself.
    expect(harness.capture.startPreRoll).not.toHaveBeenCalled();
    expect(harness.capture.start).not.toHaveBeenCalled();
  });

  it('opens one per turn, including the barge-in turn', async () => {
    const harness = makeHarness();
    harness.speech.hold = true;
    const view = mount(harness);
    await act(async () => {
      view.result.current.start();
    });

    fire(view, { type: 'bargeIn', at: 1_000, level: 0.9 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The learner is already mid-word, so the window opens and is promoted in
    // the same breath — `start()` on a running pre-roll keeps its buffer.
    expect(harness.capture.startPreRoll).toHaveBeenCalledTimes(1);
    expect(harness.capture.start).toHaveBeenCalledTimes(1);
  });

  it('discards the window when nobody spoke', async () => {
    // `voice.md` §4: half a second of a room nobody answered in is not a
    // recording anybody asked for. `stop()` on a recorder that never reached
    // an onset drops its bytes rather than handing them over.
    const harness = makeHarness();
    const view = mount(harness);
    await startToListening(harness, view);

    await act(async () => {
      view.result.current.onVoiceActivityEvent({
        type: 'onsetTimeout',
        at: 9_000,
        waitedMs: 8_000,
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(harness.capture.stop).toHaveBeenCalled();
    expect(harness.capture.start).not.toHaveBeenCalled();
    expect(harness.transcribe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('useConversationSession — barge-in', () => {
  it('cancels playback, opens the microphone and starts recording immediately', async () => {
    const harness = makeHarness();
    harness.speech.hold = true;
    const view = mount(harness);

    await act(async () => {
      view.result.current.start();
    });
    expect(phaseOf(view)).toBe('speakingQuestion');

    fire(view, { type: 'bargeIn', at: 2_000, level: 0.8 });

    expect(harness.speech.stop).toHaveBeenCalled();
    expect(phaseOf(view)).toBe('listening');
    expect(harness.voiceActivity.arm).toHaveBeenLastCalledWith('listening');
    // The learner is already mid-word: waiting for another onset would clip it.
    expect(harness.capture.start).toHaveBeenCalledTimes(1);
  });

  it('a cancelled playback resolving late does not move the machine', async () => {
    const harness = makeHarness();
    harness.speech.hold = true;
    const view = mount(harness);

    await act(async () => {
      view.result.current.start();
    });
    fire(view, { type: 'bargeIn', at: 2_000, level: 0.8 });
    expect(phaseOf(view)).toBe('listening');

    // `QuestionAudio` does not report a cancel at all; an adapter that does
    // must not be able to re-open the microphone behind the driver's back.
    await act(async () => {
      harness.speech.settle('cancelled');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(phaseOf(view)).toBe('listening');
    expect(harness.voiceActivity.arm).toHaveBeenCalledTimes(2); // barge-in, then listening
  });

  it('is ignored outside speakingQuestion', async () => {
    const harness = makeHarness();
    const view = mount(harness);
    await startToListening(harness, view);

    const armsBefore = harness.voiceActivity.arm.mock.calls.length;
    fire(view, { type: 'bargeIn', at: 2_000, level: 0.8 });

    expect(phaseOf(view)).toBe('listening');
    expect(harness.voiceActivity.arm.mock.calls.length).toBe(armsBefore);
  });
});

// ---------------------------------------------------------------------------

describe('useConversationSession — silence is never graded', () => {
  it('an empty transcript re-listens once, spoken, and submits nothing', async () => {
    const harness = makeHarness();
    harness.transcribe.mockResolvedValue({
      status: 'ok',
      text: '   ',
      confidence: 0.4,
    });
    const view = mount(harness);
    await startToListening(harness, view);
    await speakAnswer(harness, view);

    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.speech.said(CONVERSATION_NUDGE_EMPTY)).toBe(true);
    expect(harness.speech.calls.at(-1)?.kind).toBe('nudge');
    expect(phaseOf(view)).toBe('listening');
  });

  it('an onset timeout re-listens once, spoken, and records nothing', async () => {
    const harness = makeHarness();
    const view = mount(harness);
    await startToListening(harness, view);

    await act(async () => {
      view.result.current.onVoiceActivityEvent({
        type: 'onsetTimeout',
        at: 9_000,
        waitedMs: 8_000,
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(harness.capture.start).not.toHaveBeenCalled();
    expect(harness.transcribe).not.toHaveBeenCalled();
    expect(harness.speech.said(CONVERSATION_NUDGE_SILENCE)).toBe(true);
    expect(phaseOf(view)).toBe('listening');
  });

  it('a failed transcription re-listens once, spoken', async () => {
    const harness = makeHarness();
    harness.transcribe.mockResolvedValue({
      status: 'failed',
      errorCode: 'provider_error',
      error: 'redacted',
    });
    const view = mount(harness);
    await startToListening(harness, view);
    await speakAnswer(harness, view);

    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.speech.said(CONVERSATION_NUDGE_TRANSCRIBE_FAILED)).toBe(true);
    expect(phaseOf(view)).toBe('listening');
  });

  it('a recorder that never hands over its bytes does not strand the loop', async () => {
    const harness = makeHarness();
    const view = mount(harness);
    await startToListening(harness, view);

    fire(view, ONSET);
    fire(view, END_OF_TURN);
    expect(phaseOf(view)).toBe('processing');

    await settle(CONVERSATION_RECORDING_WAIT_MS);

    expect(harness.transcribe).not.toHaveBeenCalled();
    expect(harness.speech.said(CONVERSATION_NUDGE_TRANSCRIBE_FAILED)).toBe(true);
    expect(phaseOf(view)).toBe('listening');
  });
});

// ---------------------------------------------------------------------------

describe('useConversationSession — the retry budget is exactly one', () => {
  it('a wrong answer buys one "say that again", then advances on the second miss', async () => {
    const harness = makeHarness();
    harness.submit.mockResolvedValue({
      outcome: 'incorrect',
      spokenAnswer: 'the Constitution',
    });
    const view = mount(harness);
    await startToListening(harness, view);

    await speakAnswer(harness, view);
    expect(harness.speech.said(CONVERSATION_NUDGE_RETRY)).toBe(true);
    expect(phaseOf(view)).toBe('listening');

    await speakAnswer(harness, view);
    expect(harness.submit).toHaveBeenCalledTimes(2);
    // Budget spent: the second miss moves on rather than asking again.
    expect(phaseOf(view)).toBe('advancing');
  });

  it('treats a misheard "correct" as a miss worth one more go', async () => {
    const harness = makeHarness();
    harness.submit.mockResolvedValue({
      outcome: 'correct',
      spokenAnswer: 'the Constitution',
      misheard: true,
    });
    const view = mount(harness);
    await startToListening(harness, view);
    await speakAnswer(harness, view);

    expect(harness.speech.said(CONVERSATION_NUDGE_RETRY)).toBe(true);
    expect(phaseOf(view)).toBe('listening');
  });

  it('shares one budget across DIFFERENT failure modes — empty, then wrong', async () => {
    const harness = makeHarness();
    harness.transcribe.mockResolvedValueOnce({
      status: 'ok',
      text: '',
      confidence: null,
    });
    harness.submit.mockResolvedValue({
      outcome: 'incorrect',
      spokenAnswer: 'the Constitution',
    });
    const view = mount(harness);
    await startToListening(harness, view);

    await speakAnswer(harness, view); // empty transcript: budget spent
    expect(phaseOf(view)).toBe('listening');

    await speakAnswer(harness, view); // wrong answer, and no budget left
    expect(harness.speech.calls.filter((c) => c.text === CONVERSATION_NUDGE_RETRY))
      .toHaveLength(0);
    expect(phaseOf(view)).toBe('advancing');
  });

  it('ends the session rather than advancing past a question nothing was graded for', async () => {
    const harness = makeHarness();
    harness.transcribe.mockResolvedValue({
      status: 'ok',
      text: '',
      confidence: null,
    });
    const view = mount(harness);
    await startToListening(harness, view);

    await speakAnswer(harness, view); // first empty: one nudge
    expect(phaseOf(view)).toBe('listening');

    await speakAnswer(harness, view); // second empty, and no attempt exists
    expect(harness.advance).not.toHaveBeenCalled();
    expect(phaseOf(view)).toBe('idle');
    expect(view.result.current.notice?.reason).toBe('no_answer');
    expect(harness.speech.said(CONVERSATION_NOTICE_NO_ANSWER)).toBe(true);
  });

  it('resets the budget on the next question', async () => {
    const harness = makeHarness();
    harness.submit.mockResolvedValue({
      outcome: 'incorrect',
      spokenAnswer: 'the Constitution',
    });
    const view = mount(harness);
    await startToListening(harness, view);

    await speakAnswer(harness, view); // retry offered
    await speakAnswer(harness, view); // budget spent → advancing
    await settle(CONVERSATION_ADVANCE_PAUSE_MS);
    view.rerender(harness.props());
    await settle();
    view.rerender(harness.props());
    expect(phaseOf(view)).toBe('listening');

    const retriesBefore = harness.speech.calls.filter(
      (c) => c.text === CONVERSATION_NUDGE_RETRY,
    ).length;
    await speakAnswer(harness, view);
    const retriesAfter = harness.speech.calls.filter(
      (c) => c.text === CONVERSATION_NUDGE_RETRY,
    ).length;
    expect(retriesAfter).toBe(retriesBefore + 1);
  });
});

// ---------------------------------------------------------------------------
//
// THE RETRY BUDGET AS A PROPERTY (issue #314), over a RANGE of miss
// sequences — not the handful of hand-picked examples above. Each test
// above this line drives one specific sequence chosen because it reads
// well (wrong-then-wrong, empty-then-wrong), not because the set was
// checked for coverage. The invariant `useConversationSession.ts`'s own
// header states is broader than any one example: "a single budget shared
// by every reason a turn can miss" — REGARDLESS of which two reasons, or
// in which order. `MissKind` below is every way a turn can miss that this
// hook recognises (`onsetTimeout`, an empty transcript, a `failed`
// transcription, a wrong answer, and a low-confidence "correct" — the
// `misheard` case), and the test drives EVERY ORDERED PAIR of them
// (5×5 = 25 sequences), asserting the one property that must hold for all
// twenty-five: `listening` is entered at most twice for one question, and
// after the second miss it is never entered a third time.
// ---------------------------------------------------------------------------

type MissKind = 'onsetTimeout' | 'empty' | 'failed' | 'wrong' | 'lowConfidenceCorrect';

const MISS_KINDS: MissKind[] = [
  'onsetTimeout',
  'empty',
  'failed',
  'wrong',
  'lowConfidenceCorrect',
];

/** Does this miss kind ever reach `submit` (and so set `gradedRef`)? */
function gradesOnMiss(kind: MissKind): boolean {
  return kind === 'wrong' || kind === 'lowConfidenceCorrect';
}

/** Configure the mocks for ONE turn's miss, of the given kind, then drive it. */
async function driveOneMiss(
  harness: Harness,
  view: Mounted,
  kind: MissKind,
): Promise<void> {
  switch (kind) {
    case 'onsetTimeout':
      // Fired directly: nobody spoke, so there is no onset/end-of-turn pair
      // to drive through `speakAnswer` at all.
      await act(async () => {
        view.result.current.onVoiceActivityEvent({
          type: 'onsetTimeout',
          at: 9_000,
          waitedMs: 8_000,
        });
        await vi.advanceTimersByTimeAsync(0);
      });
      return;
    case 'empty':
      harness.transcribe.mockResolvedValueOnce({
        status: 'ok',
        text: '   ',
        confidence: 0.5,
      });
      await speakAnswer(harness, view);
      return;
    case 'failed':
      harness.transcribe.mockResolvedValueOnce({
        status: 'failed',
        errorCode: 'provider_error',
        error: 'redacted',
      });
      await speakAnswer(harness, view);
      return;
    case 'wrong':
      harness.transcribe.mockResolvedValueOnce({
        status: 'ok',
        text: 'not it',
        confidence: 0.9,
      });
      harness.submit.mockResolvedValueOnce({
        outcome: 'incorrect',
        spokenAnswer: 'the Constitution',
      });
      await speakAnswer(harness, view);
      return;
    case 'lowConfidenceCorrect':
      harness.transcribe.mockResolvedValueOnce({
        status: 'ok',
        text: 'the constitution',
        confidence: 0.3,
      });
      harness.submit.mockResolvedValueOnce({
        outcome: 'correct',
        spokenAnswer: 'the Constitution',
        misheard: true,
      });
      await speakAnswer(harness, view);
      return;
  }
}

describe('useConversationSession — the retry budget as a PROPERTY over a range of miss sequences', () => {
  const PAIRS: Array<[MissKind, MissKind]> = MISS_KINDS.flatMap((first) =>
    MISS_KINDS.map((second): [MissKind, MissKind] => [first, second]),
  );

  it.each(PAIRS)(
    'after %s then %s: at most one retry, and never a third listen',
    async (first, second) => {
      const harness = makeHarness();
      const view = mount(harness);
      await startToListening(harness, view);

      await driveOneMiss(harness, view, first);
      // ONE retry, always offered after the FIRST miss, whatever kind it was.
      expect(phaseOf(view)).toBe('listening');

      const listeningArmsBefore = harness.voiceActivity.arm.mock.calls.filter(
        (call) => call[0] === 'listening',
      ).length;

      await driveOneMiss(harness, view, second);

      // THE INVARIANT: `arm('listening')` must NOT have been called again —
      // regardless of which two kinds of miss composed this sequence, the
      // budget is spent and the loop does not re-listen a third time.
      const listeningArmsAfter = harness.voiceActivity.arm.mock.calls.filter(
        (call) => call[0] === 'listening',
      ).length;
      expect(listeningArmsAfter).toBe(listeningArmsBefore);
      expect(phaseOf(view)).not.toBe('listening');

      if (gradesOnMiss(first) || gradesOnMiss(second)) {
        // Something was graded across the two turns — the loop moves ON.
        expect(phaseOf(view)).toBe('advancing');
      } else {
        // Nothing was EVER graded across either turn — there is no question
        // to advance past, so the session ends rather than looping forever.
        expect(phaseOf(view)).toBe('idle');
        expect(view.result.current.notice?.reason).toBe('no_answer');
      }
    },
  );
});

// ---------------------------------------------------------------------------

describe('useConversationSession — every involuntary exit is spoken', () => {
  const CODES: AudioCaptureProblemCode[] = [
    'permission_denied',
    'permission_dismissed',
    'no_device',
    'device_in_use',
    'insecure_origin',
    'unsupported',
    // Issue #347's seventh. A hands-free learner is not reading the screen, so
    // it has to be spoken with its own remedy exactly like the other six —
    // and it must not be spoken in `device_in_use`'s words, which would send
    // somebody walking down a street to go and close an application.
    'recording_too_short',
  ];

  it.each(CODES)(
    '%s exits the loop cleanly, speaks its own reason, and releases stream + wake lock',
    async (code) => {
      const harness = makeHarness();
      const view = mount(harness);
      await startToListening(harness, view);
      expect(sentinels).toHaveLength(1);

      await act(async () => {
        harness.failCapture(code);
        view.rerender(harness.props());
        await vi.advanceTimersByTimeAsync(0);
      });

      const problem = describeCaptureProblem(code);
      expect(phaseOf(view)).toBe('idle');
      expect(view.result.current.notice).toEqual({
        reason: 'capture_problem',
        message: `${problem.message} ${problem.remedy}`,
        problem,
      });
      // Spoken, not merely rendered — the whole premise of the mode.
      expect(harness.speech.said(`${problem.message} ${problem.remedy}`)).toBe(true);
      expect(harness.capture.releaseStream).toHaveBeenCalled();
      expect(harness.voiceActivity.disarm).toHaveBeenCalled();
      expect(sentinels[0].release).toHaveBeenCalled();
    },
  );

  it('every problem produces a distinct sentence', () => {
    const sentences = new Set(
      CODES.map((code) => {
        const problem = describeCaptureProblem(code);
        return `${problem.message} ${problem.remedy}`;
      }),
    );
    expect(sentences.size).toBe(CODES.length);
  });

  it('an unavailable transcription leaves the loop — it is not a retry', async () => {
    const harness = makeHarness();
    harness.transcribe.mockResolvedValue({
      status: 'unavailable',
      cause: 'role_unbound',
      role: 'transcribe',
    });
    const view = mount(harness);
    await startToListening(harness, view);
    await speakAnswer(harness, view);

    expect(phaseOf(view)).toBe('idle');
    expect(view.result.current.notice?.reason).toBe('transcribe_unavailable');
    expect(harness.speech.said(CONVERSATION_NOTICE_TRANSCRIBE_UNAVAILABLE)).toBe(true);
    expect(harness.capture.releaseStream).toHaveBeenCalled();
    expect(sentinels[0].release).toHaveBeenCalled();
  });

  it('a grade that could not be recorded leaves the loop, spoken', async () => {
    const harness = makeHarness();
    harness.submit.mockResolvedValue(null);
    const view = mount(harness);
    await startToListening(harness, view);
    await speakAnswer(harness, view);

    expect(phaseOf(view)).toBe('idle');
    expect(view.result.current.notice?.reason).toBe('grade_failed');
    expect(harness.speech.said(CONVERSATION_NOTICE_GRADE_FAILED)).toBe(true);
  });

  it('a thrown transcription is a failed one, not a crash', async () => {
    const harness = makeHarness();
    harness.transcribe.mockRejectedValue(new Error('offline'));
    const view = mount(harness);
    await startToListening(harness, view);
    await speakAnswer(harness, view);

    expect(harness.speech.said(CONVERSATION_NUDGE_TRANSCRIBE_FAILED)).toBe(true);
    expect(phaseOf(view)).toBe('listening');
  });
});

// ---------------------------------------------------------------------------

describe('useConversationSession — the learner is never held', () => {
  const PHASES: Array<{
    name: ConversationPhase;
    reach: (harness: Harness, view: Mounted) => Promise<void>;
  }> = [
    {
      name: 'speakingQuestion',
      reach: async (harness, view) => {
        harness.speech.hold = true;
        await act(async () => {
          view.result.current.start();
        });
      },
    },
    {
      name: 'listening',
      reach: async (harness, view) => {
        await startToListening(harness, view);
      },
    },
    {
      name: 'processing',
      reach: async (harness, view) => {
        await startToListening(harness, view);
        fire(view, ONSET);
        fire(view, END_OF_TURN);
      },
    },
    {
      name: 'speakingAnswer',
      reach: async (harness, view) => {
        await startToListening(harness, view);
        harness.speech.hold = true;
        fire(view, ONSET);
        fire(view, END_OF_TURN);
        await act(async () => {
          harness.deliverRecording();
          view.rerender(harness.props());
          await vi.advanceTimersByTimeAsync(0);
        });
        view.rerender(harness.props());
        await settle();
        view.rerender(harness.props());
      },
    },
    {
      name: 'advancing',
      reach: async (harness, view) => {
        await startToListening(harness, view);
        await speakAnswer(harness, view);
      },
    },
  ];

  it.each(PHASES)('Stop exits immediately from $name', async ({ name, reach }) => {
    const harness = makeHarness();
    const view = mount(harness);
    await reach(harness, view);
    expect(phaseOf(view)).toBe(name);

    act(() => {
      view.result.current.stop();
    });

    expect(phaseOf(view)).toBe('idle');
    expect(view.result.current.isRunning).toBe(false);
    // A deliberate exit says nothing: the learner just asked for it.
    expect(view.result.current.notice).toBeNull();
    expect(harness.capture.releaseStream).toHaveBeenCalled();
    expect(harness.voiceActivity.disarm).toHaveBeenCalled();
    expect(harness.speech.stop).toHaveBeenCalled();
    expect(sentinels[0].release).toHaveBeenCalled();
  });

  it.each(PHASES)('Type instead exits immediately from $name', async ({ name, reach }) => {
    const harness = makeHarness();
    const view = mount(harness);
    await reach(harness, view);
    expect(phaseOf(view)).toBe(name);

    act(() => {
      view.result.current.stop('typing');
    });

    expect(phaseOf(view)).toBe('idle');
    expect(view.result.current.notice).toBeNull();
    expect(harness.capture.releaseStream).toHaveBeenCalled();
  });

  it.each(PHASES)('Next moves on immediately from $name', async ({ name, reach }) => {
    const harness = makeHarness();
    const view = mount(harness);
    await reach(harness, view);
    expect(phaseOf(view)).toBe(name);

    const advancesBefore = harness.advance.mock.calls.length;
    act(() => {
      view.result.current.skip();
    });

    expect(phaseOf(view)).toBe('advancing');
    // No pause, no timer: the learner already waited.
    expect(harness.advance.mock.calls.length).toBe(advancesBefore + 1);
    expect(harness.speech.stop).toHaveBeenCalled();
    expect(harness.voiceActivity.disarm).toHaveBeenCalled();
    // Still running — Next pauses the turn, it does not end the session.
    expect(view.result.current.isRunning).toBe(true);
  });

  it('nothing in flight can restart a stopped loop', async () => {
    const harness = makeHarness();
    const view = mount(harness);
    await startToListening(harness, view);

    fire(view, ONSET);
    fire(view, END_OF_TURN);
    act(() => {
      view.result.current.stop();
    });

    // The bytes arrive after the learner has already left.
    await act(async () => {
      harness.deliverRecording();
      view.rerender(harness.props());
      await vi.advanceTimersByTimeAsync(CONVERSATION_RECORDING_WAIT_MS);
    });

    expect(harness.transcribe).not.toHaveBeenCalled();
    expect(phaseOf(view)).toBe('idle');
  });

  it('start is a no-op while running, and while there is no question', async () => {
    const harness = makeHarness();
    const view = mount(harness);
    await startToListening(harness, view);

    act(() => {
      view.result.current.start();
    });
    expect(harness.capture.acquireStream).toHaveBeenCalledTimes(1);

    act(() => {
      view.result.current.stop();
    });
    harness.question.current = null;
    view.rerender(harness.props());
    act(() => {
      view.result.current.start();
    });
    expect(phaseOf(view)).toBe('idle');
    expect(harness.capture.acquireStream).toHaveBeenCalledTimes(1);
  });

  it('dismissNotice clears the rendered reason', async () => {
    const harness = makeHarness();
    harness.submit.mockResolvedValue(null);
    const view = mount(harness);
    await startToListening(harness, view);
    await speakAnswer(harness, view);
    expect(view.result.current.notice).not.toBeNull();

    act(() => {
      view.result.current.dismissNotice();
    });
    expect(view.result.current.notice).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('useConversationSession — unmount', () => {
  const PHASES: Array<{
    name: ConversationPhase;
    reach: (harness: Harness, view: Mounted) => Promise<void>;
  }> = [
    {
      name: 'speakingQuestion',
      reach: async (harness, view) => {
        harness.speech.hold = true;
        await act(async () => {
          view.result.current.start();
        });
      },
    },
    {
      name: 'listening',
      reach: async (harness, view) => {
        await startToListening(harness, view);
      },
    },
    {
      name: 'processing',
      reach: async (harness, view) => {
        await startToListening(harness, view);
        fire(view, ONSET);
        fire(view, END_OF_TURN);
      },
    },
    {
      // Issue #314: missing from this array before this issue — every OTHER
      // phase-enumerated describe block in this file (`the learner is never
      // held`, above) already lists all five, and unmount is exactly the one
      // place a missing phase is easy to not notice, because nothing here
      // would have failed without it.
      name: 'speakingAnswer',
      reach: async (harness, view) => {
        await startToListening(harness, view);
        harness.speech.hold = true;
        fire(view, ONSET);
        fire(view, END_OF_TURN);
        await act(async () => {
          harness.deliverRecording();
          view.rerender(harness.props());
          await vi.advanceTimersByTimeAsync(0);
        });
        view.rerender(harness.props());
        await settle();
        view.rerender(harness.props());
      },
    },
    {
      name: 'advancing',
      reach: async (harness, view) => {
        await startToListening(harness, view);
        await speakAnswer(harness, view);
      },
    },
  ];

  it.each(PHASES)(
    'releases the stream, the wake lock, the voice AND the shared AudioContext when unmounted in $name',
    async ({ name, reach }) => {
      const harness = makeHarness();
      const view = mount(harness);
      await reach(harness, view);
      expect(phaseOf(view)).toBe(name);
      expect(sentinels).toHaveLength(1);

      view.unmount();

      expect(harness.capture.releaseStream).toHaveBeenCalled();
      expect(harness.voiceActivity.disarm).toHaveBeenCalled();
      expect(harness.speech.stop).toHaveBeenCalled();
      expect(sentinels[0].release).toHaveBeenCalled();
      // Issue #314: the fourth thing unmount must release, alongside the
      // stream, the wake lock and the voice — `closeSharedAudioContext()`
      // (`../../lib/earcons`, spied at the top of this file) is called on
      // EVERY one of the five phases, not merely asserted not to crash.
      expect(earconsSpies.closeSharedAudioContext).toHaveBeenCalled();
    },
  );

  it('a hook that never ran leaves the shared devices alone', () => {
    const harness = makeHarness();
    const view = mount(harness);

    view.unmount();

    expect(harness.capture.releaseStream).not.toHaveBeenCalled();
    expect(harness.capture.acquireStream).not.toHaveBeenCalled();
    // Nothing was ever borrowed, so nothing here closes the SHARED context
    // either — a hook that mounted and never started must not tear down an
    // `AudioContext` some other, unrelated part of the page might be
    // playing through (`hasRunRef`'s own reason, `useConversationSession.ts`).
    expect(earconsSpies.closeSharedAudioContext).not.toHaveBeenCalled();
  });

  it('an unmount mid-flight still drops the recording', async () => {
    const harness = makeHarness();
    let resolveTranscription: (result: TranscribeResponse) => void = () => undefined;
    harness.transcribe.mockImplementation(
      () =>
        new Promise<TranscribeResponse>((resolve) => {
          resolveTranscription = resolve;
        }),
    );

    const view = mount(harness);
    await startToListening(harness, view);
    fire(view, ONSET);
    fire(view, END_OF_TURN);
    await act(async () => {
      harness.deliverRecording();
      view.rerender(harness.props());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(harness.transcribe).toHaveBeenCalledTimes(1);

    view.unmount();
    await act(async () => {
      resolveTranscription({ status: 'ok', text: 'late', confidence: 1 });
      await vi.advanceTimersByTimeAsync(0);
    });

    // The blob goes even though nobody is listening any more, and the grade
    // that would have followed does not run.
    expect(harness.capture.release).toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();
  });
});

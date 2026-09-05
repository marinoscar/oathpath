/**
 * `useConversationSession` — the hands-free loop, as one state machine.
 *
 * Issue #312, epic #304 / E13 ("Conversation mode"). This is the driver
 * `docs/specs/conversation-mode.md` §4 names: the thing that reads a question
 * aloud, hears the answer, sends it to be transcribed and graded, speaks the
 * accepted answer, and moves on — so a learner practising on a walk taps once
 * at the start and not again.
 *
 * ```
 * idle
 *  └─ start() ─────────► arms speech, takes the wake lock, opens the stream
 * speakingQuestion       TTS plays; the VAD is armed for barge-in
 *  ├─ playback ends ────────────────────────► listening
 *  └─ barge-in detected ─► cancel TTS ──────► listening   (recorder starts here)
 * listening              onset window, then hangover; rising earcon on open
 *  └─ end of turn ──────────────────────────► processing
 * processing             transcribe → submit → grade; the soft "working" pulse
 *  └─ graded ───────────────────────────────► speakingAnswer
 * speakingAnswer         TTS reads the accepted answer
 *  ├─ correct ──────────────────────────────► advancing
 *  └─ missed AND no retry used ─► "say that again" ──► listening (retry)
 * advancing              a short pause, then advance()
 * ```
 *
 * =============================================================================
 * IT DRIVES; IT DOES NOT OWN. EVERY MOVING PART IS AN INJECTED PORT.
 * =============================================================================
 *
 * Nothing below imports `PracticeSessionPage`, calls `fetch`, mounts a
 * component, or reaches for a DOM node. The microphone, the detector, the
 * voice, the transcription call, the grading call and "go to the next
 * question" all arrive as {@link UseConversationSessionOptions}, and the hook
 * is the sequencing between them and nothing else.
 *
 * That is not decoration. This machine has six states, four timers' worth of
 * asynchrony, and a dozen transitions that only ever fire in a browser holding
 * a live microphone in a room with a person talking in it — which is to say,
 * nowhere a test can go. Injecting the ports is what moves the whole of it
 * into a `renderHook`: a fake capture handle, a fake detector, a fake voice, a
 * `transcribe` that resolves whatever the case needs. The alternative — the
 * page owning this inline — is 1,700 lines of screen you would have to render
 * to assert that a barge-in cancels playback.
 *
 * The ports are also deliberately the SHAPES THAT ALREADY EXIST.
 * {@link ConversationCapturePort} is `useAudioCapture`'s own persistent return
 * type; the detector port is a `Pick` of `useVoiceActivity`'s; `transcribe`
 * resolves the real `TranscribeResponse` union. A port invented here would be
 * an adapter the host has to write and keep true; a port that is the existing
 * type is a variable the host already has.
 *
 * =============================================================================
 * THE RECORDER IS NEVER RUNNING WHILE THE APP IS TALKING
 * =============================================================================
 *
 * `MediaRecorder` is started on a detected speech ONSET, and on a barge-in
 * (where the onset has already happened — the learner is mid-word), and never
 * in `speakingQuestion` or `speakingAnswer`. `startRecording` refuses outright
 * in those two phases rather than trusting the call sites.
 *
 * THIS, NOT ECHO CANCELLATION, IS WHAT KEEPS THE APP FROM TRANSCRIBING ITSELF
 * (`docs/specs/conversation-mode.md` §2). `useAudioCapture` asks the device for
 * `echoCancellation` in both its modes and that helps, but it reduces bleed —
 * it does not promise zero. A recorder running through playback would be
 * capturing some fraction of the question being read, and the transcript of
 * "What is the supreme law of the land?" spoken by this app grades as an
 * answer a learner never gave. A recorder that is not running captures nothing,
 * which is a guarantee rather than a probability.
 *
 * The microphone STREAM does stay open through playback — that is what makes
 * barge-in detectable at all — and the detector listens on it the whole time.
 * Open stream, stopped recorder: the two are different things, and only one of
 * them produces bytes.
 *
 * =============================================================================
 * SILENCE IS NEVER GRADED, AND THE BUDGET FOR TRYING AGAIN IS EXACTLY ONE
 * =============================================================================
 *
 * A voice-activity detector stopping on a hangover produces empty transcripts
 * routinely: a learner who paused a beat too long, a cough that cleared the
 * onset bar, a street that did. `docs/specs/voice-hands-free.md` §1 forbids
 * auto-submitting any of it, and this driver never does — an empty transcript
 * takes the same road as a `failed` transcription and an onset timeout: a
 * SPOKEN nudge, and listen again.
 *
 * ONE per question. Not one per failure mode, one per question — a single
 * budget shared by every reason a turn can miss, because the thing being
 * bounded is not "how many ways can this fail" but "how long can a learner be
 * held on one question by a microphone that is not working". A budget per
 * cause would let a broken setup alternate between empty transcripts and
 * grader misses forever, each one still "within budget".
 *
 * When the budget is spent the loop moves on rather than looping — with one
 * exception, stated plainly because it is a deliberate divergence from the
 * epic's "a second miss advances" wording. If the budget is spent and NOTHING
 * was ever graded for this question, there is nothing to advance past:
 * `advance()` on the host is "show the result's next question", and a question
 * with no recorded attempt has no result. Advancing there would leave the
 * driver waiting for a question change that is never coming — the exact trap
 * the rule exists to prevent, arrived at by obeying its letter. So that case
 * ends the session, out loud, with a reason. Either way the learner is not held.
 *
 * =============================================================================
 * EVERY EXIT IS SPOKEN. A WALKING LEARNER IS NOT READING THE SCREEN.
 * =============================================================================
 *
 * The whole premise of this mode is a phone that is not being looked at, so an
 * error rendered and not spoken is an error nobody receives. Every involuntary
 * exit — all six of `AudioCaptureProblemCode`, an unavailable transcription, a
 * grade that could not be recorded, the end of the session — is spoken AND put
 * in {@link UseConversationSessionReturn.notice} for the screen. The two
 * deliberate exits (`stop()`, and stopping to type) are silent, because the
 * learner just asked for them and being told what you did is not information.
 *
 * The six capture problems are not collapsed, translated or re-worded here:
 * `describeCaptureProblem` already carries one message and one remedy per
 * code, and the notice speaks and renders those. A seventh case cannot appear
 * without that closed union gaining a member.
 *
 * =============================================================================
 * EARCONS, AND WHY THE DULL ONE IS THE IMPORTANT ONE
 * =============================================================================
 *
 * Rising cue when the microphone opens, falling cue when the turn is captured,
 * and a soft pulse for the whole of `processing`. The first two are manners.
 * The third is load-bearing: `processing` covers a transcription round trip
 * AND a grade that may escalate to an AI grader, so several seconds of silence
 * is the normal case, and hands-free, several seconds of silence is
 * indistinguishable from the app having died. The pulse is the difference
 * between waiting and giving up, and it is stopped on EVERY exit from that
 * state — verdict, error, learner tap, unmount.
 *
 * =============================================================================
 * NO API CALL IS CHANGED, AND NONE IS MADE HERE
 * =============================================================================
 *
 * Epic #304's locked decision 6: this epic is a driver over the server contract
 * E9 and E12 already shipped. `transcribe` and `submit` are ports; the host
 * binds them to the same `POST /api/ai/speech/transcribe` and
 * `POST /api/practice/sessions/{id}/attempts` calls the hand-driven flow
 * already makes, with the same `inputMode: 'spoken'` fields and the same retry
 * semantics. There is no request in this file.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  closeSharedAudioContext,
  playCapturedEarcon,
  playListeningEarcon,
  startProcessingPulse,
  stopProcessingPulse,
} from '../lib/earcons';
import type { PracticeOutcome, TranscribeResponse } from '../types';
import type {
  AudioCaptureProblem,
  UsePersistentAudioCaptureReturn,
} from './useAudioCapture';
import { useIsMounted } from './useIsMounted';
import type { UseVoiceActivityReturn, VoiceActivityEvent } from './useVoiceActivity';
import { useWakeLock, type UseWakeLockState } from './useWakeLock';

// ---------------------------------------------------------------------------
// Tunables. Named constants in one place, for the reason `useVoiceActivity`'s
// own header gives and `ASR_CONFIDENCE_THRESHOLD` sets the house model for: a
// product decision like "how long is the pause before the next question"
// should be findable and changeable in one place, not typed twice.
// ---------------------------------------------------------------------------

/**
 * The beat between the accepted answer being read and the next question
 * starting. Long enough to be a breath rather than a cut; short enough that a
 * learner does not wonder whether it stopped.
 */
export const CONVERSATION_ADVANCE_PAUSE_MS = 900;

/**
 * How long `processing` waits for the recorder to hand over its `Blob`.
 *
 * `MediaRecorder.stop()` delivers on its own schedule and, on a device that
 * has quietly lost the microphone, may deliver nothing at all. Without this,
 * that device leaves a hands-free learner in a state with no sound, no screen
 * change and no way out but a tap they cannot see to make. It is a backstop
 * for a case the capture hook's own failure reporting does not cover, not a
 * substitute for it.
 */
export const CONVERSATION_RECORDING_WAIT_MS = 5_000;

/** One retry per question, shared across every reason a turn can miss. */
export const CONVERSATION_RETRY_BUDGET = 1;

// ---------------------------------------------------------------------------
// Spoken copy. `VISION.md`'s AI Personality section: calm, specific, never
// blaming the learner, and never an alarm. All of it is spoken as well as
// rendered, so it is written to be HEARD — short sentences, no punctuation a
// synthesiser reads as a pause in the wrong place, no jargon.
// ---------------------------------------------------------------------------

/** Nothing came back from the recogniser. Not an error, and not the learner's. */
export const CONVERSATION_NUDGE_EMPTY = "I didn't catch that. Go ahead.";

/** Nobody spoke inside the onset window. */
export const CONVERSATION_NUDGE_SILENCE = "I didn't hear an answer. Go ahead.";

/** The transcription call was attempted and did not work. */
export const CONVERSATION_NUDGE_TRANSCRIBE_FAILED =
  "That didn't work. Let's try again.";

/** The answer missed, and the budget allows one more go. */
export const CONVERSATION_NUDGE_RETRY = 'Say that again.';

/** `transcribe` is not bound on this deployment. Nothing was attempted. */
export const CONVERSATION_NOTICE_TRANSCRIBE_UNAVAILABLE =
  'Speech recognition is not set up here, so conversation mode has stopped. You can still answer by typing.';

/** The attempt could not be recorded. */
export const CONVERSATION_NOTICE_GRADE_FAILED =
  'That answer could not be graded, so conversation mode has stopped. You can still answer by typing.';

/** The recorder produced nothing, twice, and there is no attempt to move past. */
export const CONVERSATION_NOTICE_NO_ANSWER =
  "I couldn't hear an answer, so conversation mode has stopped. You can still answer by typing.";

/** There is no next question. */
export const CONVERSATION_NOTICE_SESSION_COMPLETE =
  'That was the last question. Conversation mode has stopped.';

// ---------------------------------------------------------------------------
// The machine's vocabulary
// ---------------------------------------------------------------------------

/**
 * Where the loop is. Six states, exactly the six in
 * `docs/specs/conversation-mode.md` §4 — `idle` is both "never started" and
 * "stopped", because a stopped conversation has no residue: the stream is
 * closed, the wake lock is dropped and the next `start()` begins from nothing.
 * A separate `stopped` state would be a state whose only distinguishing
 * property is the notice, which is already its own field.
 */
export type ConversationPhase =
  | 'idle'
  | 'speakingQuestion'
  | 'listening'
  | 'processing'
  | 'speakingAnswer'
  | 'advancing';

/**
 * What is being said, so a host can route it.
 *
 * `question` and `answer` are content — a host sends them through
 * `QuestionAudio`, which gets the premium voice, the learner's rate and the
 * shared audio cache. `nudge` is the driver's own short line, which wants none
 * of that and should not spend a key on a five-word sentence.
 */
export type ConversationSpeechKind = 'question' | 'answer' | 'nudge';

/**
 * How one piece of speech ended.
 *
 * `cancelled` exists so an adapter can be honest about a `stop()` it was
 * asked to perform. `QuestionAudio` deliberately does NOT fire `onFinished`
 * for a cancel (issue #311), which is exactly right and is what this driver
 * relies on for barge-in: the playback it cut off does not later announce
 * itself as finished and move the machine on. An adapter built on that
 * component therefore resolves `cancelled` from its own `stop()` path or never
 * resolves at all, and both are fine — every continuation here is guarded by
 * the turn token, so a promise that resolves late, or not at all, changes
 * nothing.
 */
export type ConversationSpeechOutcome = 'ended' | 'failed' | 'cancelled';

/** The voice, as one port. See {@link ConversationSpeechOutcome}. */
export interface ConversationSpeechPort {
  /**
   * Say this, and resolve when it is over.
   *
   * SHOULD NOT REJECT — a rejection is treated as `failed` rather than
   * propagated, because a coach that cannot speak one sentence is not a reason
   * to end a session. It also must not resolve BEFORE the audio finishes for
   * `question` and `answer`: the whole `speakingQuestion → listening`
   * transition hangs off this promise, and a premature resolution opens the
   * microphone into the app's own voice.
   */
  speak: (
    text: string,
    kind: ConversationSpeechKind,
  ) => Promise<ConversationSpeechOutcome>;
  /** Cut off whatever is speaking. Must be idempotent and safe when silent. */
  stop: () => void;
}

/**
 * The microphone. `useAudioCapture({ persistent: true })`'s own return type,
 * not a shape invented here — see the file header.
 */
export type ConversationCapturePort = UsePersistentAudioCaptureReturn;

/**
 * The detector, narrowed to what a driver uses.
 *
 * `arm`/`disarm` only: the driver never reads `state`, because it already
 * knows what it armed for and when, and `getLevel` belongs to a meter. Events
 * arrive the other way — the host passes
 * {@link UseConversationSessionReturn.onVoiceActivityEvent} as
 * `useVoiceActivity`'s `onEvent`, which keeps the two hooks siblings under the
 * page rather than one nested inside the other.
 */
export type ConversationVoiceActivityPort = Pick<
  UseVoiceActivityReturn,
  'arm' | 'disarm'
>;

/**
 * What came back from grading one spoken answer.
 *
 * Deliberately NOT `PracticeAttemptResult`. The driver needs three facts —
 * did it land, what should be read aloud, and is the grade untrustworthy —
 * and taking the whole attempt shape would couple this machine to the practice
 * API's response for no gain and make the mock in every test a page of
 * fixture. The host, which already has the full result, answers the three.
 */
export interface ConversationGrade {
  /** The recorded outcome. Anything but `correct` is a miss. */
  outcome: PracticeOutcome;
  /**
   * The accepted answer to read aloud, or `null` to say nothing.
   *
   * `null` is ordinary, not an error: a question whose answer resolution needs
   * a state the learner has not set has nothing to read.
   */
  spokenAnswer: string | null;
  /**
   * The recogniser was not trusted (`failureCause: 'misheard'`).
   *
   * Carried separately from `outcome` because the server does not fold it in:
   * `docs/specs/voice.md` §3 keeps `outcome` untouched and records the doubt
   * as a cause. A misheard `correct` is still worth another go — the learner
   * may have been right about words we are not sure they said.
   */
  misheard?: boolean;
}

/** Why the loop stopped. */
export type ConversationStopReason =
  /** The learner tapped Stop. Silent — they know. */
  | 'learner'
  /** The learner chose to type instead. Silent, same reason. */
  | 'typing'
  /** One of the six named `AudioCaptureProblemCode` cases. */
  | 'capture_problem'
  /** `transcribe` is unbound on this deployment. Nothing was attempted. */
  | 'transcribe_unavailable'
  /** The attempt could not be recorded. */
  | 'grade_failed'
  /** The retry budget is spent and no attempt was ever recorded to move past. */
  | 'no_answer'
  /** There is no next question. */
  | 'session_complete';

/** What the screen shows about an exit, and what was spoken about it. */
export interface ConversationNotice {
  reason: ConversationStopReason;
  /** The exact sentence that was spoken. Render this; do not rewrite it. */
  message: string;
  /**
   * The capture problem, when that is why. Carried whole so a renderer can
   * show `message` and `remedy` as the hand-driven flow already does, rather
   * than parsing them back out of the joined sentence.
   */
  problem?: AudioCaptureProblem;
}

/** The sentence spoken (and rendered) for each involuntary exit. */
const STOP_MESSAGES: Record<ConversationStopReason, string | null> = {
  learner: null,
  typing: null,
  capture_problem: null, // supplied per problem — see `stopForCaptureProblem`
  transcribe_unavailable: CONVERSATION_NOTICE_TRANSCRIBE_UNAVAILABLE,
  grade_failed: CONVERSATION_NOTICE_GRADE_FAILED,
  no_answer: CONVERSATION_NOTICE_NO_ANSWER,
  session_complete: CONVERSATION_NOTICE_SESSION_COMPLETE,
};

export interface UseConversationSessionOptions {
  /** The persistent microphone. See {@link ConversationCapturePort}. */
  capture: ConversationCapturePort;
  /** The detector. See {@link ConversationVoiceActivityPort}. */
  voiceActivity: ConversationVoiceActivityPort;
  /** The voice. See {@link ConversationSpeechPort}. */
  speech: ConversationSpeechPort;
  /**
   * Turn one recording into text. The host's binding of
   * `POST /api/ai/speech/transcribe`, unchanged — the real three-member union
   * arrives here and is switched over exhaustively.
   */
  transcribe: (blob: Blob) => Promise<TranscribeResponse>;
  /**
   * Record and grade one spoken answer.
   *
   * The host's binding of `POST /api/practice/sessions/{id}/attempts` with the
   * same `inputMode: 'spoken'` fields E12's auto-submit already sends,
   * INCLUDING `retryOfAttemptId` when this is the retry — supersession is the
   * host's business, not the driver's, because the driver has no attempt id.
   *
   * `null` means no attempt was recorded. It ends the session rather than
   * looping: a grade that did not happen cannot be spoken, retried against, or
   * advanced past.
   */
  submit: (
    transcript: string,
    confidence: number | null,
  ) => Promise<ConversationGrade | null>;
  /**
   * Move to the next question — the host's own "Next", unchanged.
   *
   * The driver does not wait on it. It waits for {@link questionId} to change,
   * which is the only signal that actually means the screen moved.
   */
  advance: () => void;
  /**
   * Which question is on screen, or `null` when there is none left.
   *
   * The loop's clock. A change means a new question (reset the retry budget,
   * read it aloud); `null` while running ends the session.
   */
  questionId: string | null;
  /** The prompt to read aloud. `null` is treated as "no question". */
  questionText: string | null;

  /** Overrides for the tunables above. Each defaults to its exported constant. */
  advancePauseMs?: number;
  recordingWaitMs?: number;
}

export interface UseConversationSessionReturn {
  /** Where the loop is. See {@link ConversationPhase}. */
  phase: ConversationPhase;
  /** `phase !== 'idle'`. What a `Stop` control renders from. */
  isRunning: boolean;
  /** The last exit's reason, spoken and renderable. Cleared by the next start. */
  notice: ConversationNotice | null;
  /** The screen wake lock, for a host that wants to say it could not be held. */
  wakeLock: UseWakeLockState;
  /** Begin. A no-op when already running or when there is no question. */
  start: () => void;
  /** End it now, from any phase. Defaults to the silent, deliberate exit. */
  stop: (reason?: ConversationStopReason) => void;
  /** The learner tapped Next: abandon this turn and move on, from any phase. */
  skip: () => void;
  /** Dismiss the rendered notice. Does not un-speak it. */
  dismissNotice: () => void;
  /** Wire this to `useVoiceActivity`'s `onEvent`. See the port's own comment. */
  onVoiceActivityEvent: (event: VoiceActivityEvent) => void;
}

export function useConversationSession(
  options: UseConversationSessionOptions,
): UseConversationSessionReturn {
  const [phase, setPhaseState] = useState<ConversationPhase>('idle');
  const [notice, setNotice] = useState<ConversationNotice | null>(null);

  const isMounted = useIsMounted();

  /**
   * Everything the machine reads, refreshed every render.
   *
   * The same move `useVoiceActivity` makes, for the same reason: continuations
   * here resolve network round trips and timers created several renders ago,
   * and what they need is the LATEST port and the LATEST question — not the
   * ones that were true when the learner started talking.
   */
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /** The phase, readable from a continuation. `phase` re-renders; this decides. */
  const phaseRef = useRef<ConversationPhase>('idle');
  const setPhase = useCallback((next: ConversationPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  /**
   * The turn token.
   *
   * Bumped at every boundary — a new question, a barge-in, a stop, a skip.
   * Every async continuation captures it and returns if it no longer matches,
   * so a transcription that lands after the learner tapped Stop, or a premium
   * clip that resolves after a barge-in cut it off, cannot move a machine that
   * has already moved. Same shape of guard as `useAudioCapture`'s `holdRef`.
   */
  const turnRef = useRef(0);
  const beginTurn = useCallback(() => {
    turnRef.current += 1;
    return turnRef.current;
  }, []);
  const isCurrent = useCallback(
    (turn: number) => turnRef.current === turn && isMounted(),
    [isMounted],
  );

  /** The question the loop believes it is on. Compared against the option. */
  const questionIdRef = useRef<string | null>(null);
  /** Spent for this question? One budget, every miss. See the file header. */
  const retryUsedRef = useRef(false);
  /** Has anything been graded for this question? See the file header. */
  const gradedRef = useRef(false);
  /** The blob already sent, so a re-render cannot transcribe it twice. */
  const uploadedRef = useRef<Blob | null>(null);
  /** Did this hook ever run? Guards the teardown of shared, borrowed things. */
  const hasRunRef = useRef(false);

  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingWaitRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (advanceTimerRef.current !== null) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    if (recordingWaitRef.current !== null) {
      clearTimeout(recordingWaitRef.current);
      recordingWaitRef.current = null;
    }
  }, []);

  // -------------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------------

  /**
   * Start the recorder — THE ONE PLACE IT IS EVER STARTED.
   *
   * The phase guard is the structural protection described in the file header,
   * and it lives here rather than at the call sites on purpose: a future
   * transition that forgets the rule is refused by the mechanism instead of
   * silently recording the app's own voice. `useAudioCapture.start()` is
   * already a no-op while a recorder is live, so a doubled call is safe and is
   * not fought (`docs/specs/conversation-mode.md` §9).
   */
  const startRecording = useCallback(() => {
    if (
      phaseRef.current === 'speakingQuestion' ||
      phaseRef.current === 'speakingAnswer'
    ) {
      return;
    }
    optionsRef.current.capture.start();
  }, []);

  /** Say one line and wait for it. A voice that cannot speak is not fatal. */
  const say = useCallback(
    async (text: string, kind: ConversationSpeechKind = 'nudge') => {
      try {
        await optionsRef.current.speech.speak(text, kind);
      } catch {
        // A coach that lost its voice for one sentence still has a session to
        // run. The nudge is lost; the loop is not.
      }
    },
    [],
  );

  /**
   * End the loop, from anywhere, and say why unless the learner asked for it.
   *
   * Order matters and is the order below: invalidate everything in flight
   * FIRST (so nothing that resolves during teardown restarts a state), then
   * silence, then release the devices, then speak the reason — after
   * `speech.stop()`, never before it, or the reason is the thing that gets cut
   * off.
   */
  const finish = useCallback(
    (
      reason: ConversationStopReason,
      message?: string | null,
      problem?: AudioCaptureProblem,
    ) => {
      beginTurn();
      clearTimers();
      stopProcessingPulse();

      const opts = optionsRef.current;
      opts.voiceActivity.disarm();
      opts.speech.stop();
      opts.capture.stop();
      opts.capture.release();
      opts.capture.releaseStream();

      questionIdRef.current = null;
      uploadedRef.current = null;
      setPhase('idle');

      const spoken = message ?? STOP_MESSAGES[reason];
      if (!spoken) {
        setNotice(null);
        return;
      }
      setNotice({ reason, message: spoken, problem });
      void say(spoken);
    },
    [beginTurn, clearTimers, say, setPhase],
  );

  /**
   * Open the microphone for the learner's turn.
   *
   * `alreadySpeaking` is the barge-in case: the learner is mid-word, so the
   * recorder starts NOW rather than waiting for an onset that has already been
   * and gone. The detector is still armed for `listening` so the hangover ends
   * the turn normally.
   */
  const toListening = useCallback(
    (alreadySpeaking = false) => {
      const opts = optionsRef.current;
      // Idempotent, and the one call that guarantees nothing is still speaking
      // when the microphone opens.
      opts.speech.stop();
      setPhase('listening');
      playListeningEarcon();
      opts.voiceActivity.arm('listening');
      if (alreadySpeaking) startRecording();
    },
    [setPhase, startRecording],
  );

  /** The pause, then the host's own Next. */
  const toAdvancing = useCallback(
    (turn: number) => {
      const opts = optionsRef.current;
      opts.voiceActivity.disarm();
      setPhase('advancing');
      advanceTimerRef.current = setTimeout(() => {
        advanceTimerRef.current = null;
        if (!isCurrent(turn)) return;
        optionsRef.current.advance();
      }, opts.advancePauseMs ?? CONVERSATION_ADVANCE_PAUSE_MS);
    },
    [isCurrent, setPhase],
  );

  /** Read the current question, watching for an interruption while it plays. */
  const askQuestion = useCallback(
    (turn: number) => {
      const opts = optionsRef.current;
      const text = opts.questionText;
      if (!text) {
        finish('session_complete');
        return;
      }

      setPhase('speakingQuestion');
      // Armed BEFORE playback starts. The detector owns the ~500 ms grace
      // period itself (`VOICE_ACTIVITY_BARGE_IN_ARMING_MS`), so there is no
      // second delay to coordinate here.
      opts.voiceActivity.arm('barge-in');

      void opts.speech.speak(text, 'question').then(
        (outcome) => {
          if (!isCurrent(turn)) return;
          if (phaseRef.current !== 'speakingQuestion') return;
          // A cancel is OUR cancel — a barge-in has already opened the
          // microphone. `QuestionAudio` does not report one at all; an adapter
          // that does must not be allowed to open it a second time.
          if (outcome === 'cancelled') return;
          toListening();
        },
        () => {
          if (!isCurrent(turn)) return;
          if (phaseRef.current !== 'speakingQuestion') return;
          // A voice that failed is still a question the learner can answer —
          // it is on screen. Stranding them in `speakingQuestion` is worse.
          toListening();
        },
      );
    },
    [finish, isCurrent, setPhase, toListening],
  );

  /**
   * A turn missed. Spend the budget if there is any, or move on.
   *
   * The `no_answer` branch is the divergence the file header argues for: with
   * nothing graded there is no next question to advance to.
   */
  const retryOrMoveOn = useCallback(
    async (nudge: string, turn: number) => {
      stopProcessingPulse();

      if (retryUsedRef.current) {
        if (!gradedRef.current) {
          finish('no_answer');
          return;
        }
        toAdvancing(turn);
        return;
      }

      retryUsedRef.current = true;
      await say(nudge);
      if (!isCurrent(turn)) return;
      toListening();
    },
    [finish, isCurrent, say, toAdvancing, toListening],
  );

  /** Grade the transcript, read the accepted answer, then retry or move on. */
  const gradeTranscript = useCallback(
    async (heard: string, confidence: number | null, turn: number) => {
      const opts = optionsRef.current;

      let grade: ConversationGrade | null;
      try {
        grade = await opts.submit(heard, confidence);
      } catch {
        grade = null;
      }
      if (!isCurrent(turn)) return;

      stopProcessingPulse();

      if (!grade) {
        finish('grade_failed');
        return;
      }
      gradedRef.current = true;

      setPhase('speakingAnswer');
      // Disarmed for the whole of `speakingAnswer`. Barge-in is armed only
      // over the QUESTION: interrupting a verdict has nothing to interrupt
      // towards, and an armed detector there would hand a "yes!" of relief to
      // the machine as the start of an answer.
      optionsRef.current.voiceActivity.disarm();

      if (grade.spokenAnswer) {
        await say(grade.spokenAnswer, 'answer');
        if (!isCurrent(turn)) return;
      }

      const missed = grade.outcome !== 'correct' || grade.misheard === true;
      if (missed && !retryUsedRef.current) {
        retryUsedRef.current = true;
        await say(CONVERSATION_NUDGE_RETRY);
        if (!isCurrent(turn)) return;
        toListening();
        return;
      }

      toAdvancing(turn);
    },
    [finish, isCurrent, say, setPhase, toAdvancing, toListening],
  );

  /** Transcribe the turn, then grade it — or nudge, or leave. */
  const runTranscription = useCallback(
    async (blob: Blob, turn: number) => {
      const opts = optionsRef.current;

      let result: TranscribeResponse;
      try {
        result = await opts.transcribe(blob);
      } catch {
        // A thrown transcription is an attempted one that did not work, which
        // is precisely `failed`. Inventing a seventh shape for it would give
        // the switch below a branch the API can never produce.
        result = { status: 'failed', errorCode: 'transcribe_threw', error: '' };
      } finally {
        // THE AUDIO STOPS EXISTING HERE, on every path — `docs/specs/voice.md`
        // §4. Unconditional, and outside the mounted check on purpose: a
        // recording kept because the component went away is still a recording.
        optionsRef.current.capture.release();
      }

      if (!isCurrent(turn)) return;

      switch (result.status) {
        case 'ok': {
          const heard = result.text.trim();
          if (!heard) {
            // Silence is never graded, on either setting
            // (`docs/specs/voice-hands-free.md` §1).
            await retryOrMoveOn(CONVERSATION_NUDGE_EMPTY, turn);
            return;
          }
          // Confidence straight through, `null` included: unknown is not low.
          await gradeTranscript(heard, result.confidence, turn);
          return;
        }
        case 'failed':
          await retryOrMoveOn(CONVERSATION_NUDGE_TRANSCRIBE_FAILED, turn);
          return;
        case 'unavailable':
          // NOT A RETRY. Nothing was attempted, and nothing about trying again
          // would change that — the model is unbound on this deployment.
          finish('transcribe_unavailable');
          return;
      }
    },
    [finish, gradeTranscript, isCurrent, retryOrMoveOn],
  );

  /** End of turn: stop the recorder and wait for its bytes, audibly. */
  const toProcessing = useCallback(
    (turn: number) => {
      const opts = optionsRef.current;
      opts.voiceActivity.disarm();
      opts.capture.stop();
      playCapturedEarcon();
      setPhase('processing');
      startProcessingPulse();

      recordingWaitRef.current = setTimeout(() => {
        recordingWaitRef.current = null;
        if (!isCurrent(turn)) return;
        if (phaseRef.current !== 'processing') return;
        void retryOrMoveOn(CONVERSATION_NUDGE_TRANSCRIBE_FAILED, turn);
      }, opts.recordingWaitMs ?? CONVERSATION_RECORDING_WAIT_MS);
    },
    [isCurrent, retryOrMoveOn, setPhase],
  );

  // -------------------------------------------------------------------------
  // The learner's own controls. Every one of them works from every phase.
  // -------------------------------------------------------------------------

  const start = useCallback(() => {
    if (phaseRef.current !== 'idle') return;
    const opts = optionsRef.current;
    if (!opts.questionText) return;

    hasRunRef.current = true;
    setNotice(null);
    retryUsedRef.current = false;
    gradedRef.current = false;
    uploadedRef.current = null;
    questionIdRef.current = opts.questionId;

    const turn = beginTurn();
    // The phase moves first: it is what takes the wake lock, and it is what a
    // second tap on Start is refused by while the device is being opened.
    setPhase('speakingQuestion');

    void opts.capture.acquireStream().then(
      (stream) => {
        if (!isCurrent(turn)) return;
        // A null stream has already put one of the six named problems into
        // `capture.state`; the effect watching it speaks and renders that one,
        // rather than this path inventing a generic sentence for all six.
        if (!stream) return;
        askQuestion(turn);
      },
      () => {
        // `acquireStream` documents that it never rejects. If a fake or a
        // future version does, the same effect covers it.
      },
    );
  }, [askQuestion, beginTurn, isCurrent, setPhase]);

  const stop = useCallback(
    (reason: ConversationStopReason = 'learner') => {
      if (phaseRef.current === 'idle') return;
      finish(reason);
    },
    [finish],
  );

  const skip = useCallback(() => {
    if (phaseRef.current === 'idle') return;

    const turn = beginTurn();
    clearTimers();
    stopProcessingPulse();

    const opts = optionsRef.current;
    opts.voiceActivity.disarm();
    opts.speech.stop();
    opts.capture.stop();
    opts.capture.release();
    uploadedRef.current = null;

    // No pause. The learner asked to move on, and has already waited for
    // whatever they were interrupting.
    setPhase('advancing');
    if (!isCurrent(turn)) return;
    opts.advance();
  }, [beginTurn, clearTimers, isCurrent, setPhase]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  // -------------------------------------------------------------------------
  // Events and observations
  // -------------------------------------------------------------------------

  const onVoiceActivityEvent = useCallback(
    (event: VoiceActivityEvent) => {
      const turn = turnRef.current;

      switch (event.type) {
        case 'onset':
          // THE ONE ORDINARY PLACE THE RECORDER STARTS.
          if (phaseRef.current !== 'listening') return;
          startRecording();
          return;

        case 'bargeIn':
          // Armed only over the question — see `gradeTranscript`.
          if (phaseRef.current !== 'speakingQuestion') return;
          optionsRef.current.speech.stop();
          toListening(true);
          return;

        case 'endOfTurn':
        case 'maxDuration':
          if (phaseRef.current !== 'listening') return;
          toProcessing(turn);
          return;

        case 'onsetTimeout':
          // A named timeout, NOT an empty recording: nothing was recorded, so
          // there is nothing to transcribe and certainly nothing to grade.
          if (phaseRef.current !== 'listening') return;
          void retryOrMoveOn(CONVERSATION_NUDGE_SILENCE, turn);
          return;
      }
    },
    [retryOrMoveOn, startRecording, toListening, toProcessing],
  );

  /**
   * The recorder handed over its bytes.
   *
   * Guarded by identity rather than by a flag so a re-render — or a
   * development double-effect — cannot spend the learner's key twice on the
   * same audio, exactly as `PracticeSessionPage`'s own transcription effect
   * does for the hand-driven path.
   */
  const recording = options.capture.recording;
  useEffect(() => {
    if (!recording) return;
    if (phaseRef.current !== 'processing') return;
    if (uploadedRef.current === recording) return;
    uploadedRef.current = recording;

    if (recordingWaitRef.current !== null) {
      clearTimeout(recordingWaitRef.current);
      recordingWaitRef.current = null;
    }
    void runTranscription(recording, turnRef.current);
  }, [recording, runTranscription]);

  /**
   * The microphone failed. All six causes, one exit, six sentences.
   *
   * The copy is `describeCaptureProblem`'s, spoken and rendered — see the file
   * header on why it is not re-worded or collapsed here.
   */
  const captureState = options.capture.state;
  useEffect(() => {
    if (phaseRef.current === 'idle') return;
    if (captureState.status !== 'failed') return;
    const problem = captureState.problem;
    finish(
      'capture_problem',
      `${problem.message} ${problem.remedy}`,
      problem,
    );
  }, [captureState, finish]);

  /**
   * The question on screen changed.
   *
   * The loop's clock, and the only thing `advance()` is trusted through: the
   * host may re-read the session, jump, or finish, and every one of those
   * reaches the driver as the same fact — a different question, or none.
   */
  const { questionId, questionText } = options;
  useEffect(() => {
    if (phaseRef.current === 'idle') return;
    if (questionId === questionIdRef.current) return;

    questionIdRef.current = questionId;
    clearTimers();

    if (!questionId || !questionText) {
      finish('session_complete');
      return;
    }

    retryUsedRef.current = false;
    gradedRef.current = false;
    uploadedRef.current = null;
    askQuestion(beginTurn());
  }, [askQuestion, beginTurn, clearTimers, finish, questionId, questionText]);

  /**
   * Unmount mid-loop.
   *
   * The stream, the pulse, the timers and the shared `AudioContext` all go.
   * The wake lock is released by `useWakeLock`'s own unmount, which is the
   * whole reason it is a declarative hook.
   *
   * `hasRunRef` gates the two SHARED things — the capture stream and the
   * module-level audio context — because a host that mounted this hook and
   * never started a conversation has not borrowed either, and closing a
   * context another part of the page is playing through would be a bug this
   * hook caused for a feature that was never used.
   */
  useEffect(
    () => () => {
      clearTimers();
      stopProcessingPulse();
      const opts = optionsRef.current;
      opts.voiceActivity.disarm();
      opts.speech.stop();
      if (!hasRunRef.current) return;
      opts.capture.stop();
      opts.capture.release();
      opts.capture.releaseStream();
      closeSharedAudioContext();
    },
    [clearTimers],
  );

  const wakeLock = useWakeLock(phase !== 'idle');

  return {
    phase,
    isRunning: phase !== 'idle',
    notice,
    wakeLock,
    start,
    stop,
    skip,
    dismissNotice,
    onVoiceActivityEvent,
  };
}

export default useConversationSession;

/**
 * One realtime (spoken) practice session, as React state — issue #355,
 * epic #345 / E15.
 *
 * =============================================================================
 * THIS HOOK IS A RELAY. IT DECIDES NOTHING.
 * =============================================================================
 *
 * `docs/specs/realtime-practice.md` §1 and §4. Five tools arrive over the data
 * channel; each one is posted, unexamined, to
 * `POST /api/practice/sessions/:id/realtime/tool-calls`, and whatever comes
 * back is handed to the model VERBATIM.
 *
 * Nothing in this file compares an answer to anything, counts a correct answer,
 * counts how many questions have been asked, selects a question, or knows a
 * pass mark — there is no such value here to look at. The result shape it
 * receives deliberately cannot carry one (`PracticeRealtimeToolOk` has `say`,
 * `then` and `questionId`, and the API carries a compile-time proof that no
 * `outcome`, `correct` or `score` can be added to it), and the call shape it
 * sends deliberately cannot express one either. `useRealtimePractice.source.test.ts`
 * reads this file and asserts both absences, because the way this regresses is
 * somebody adding "just a little" client-side bookkeeping to make a screen
 * nicer.
 *
 * THE ONE EXCEPTION, AND IT IS NOT A SECOND OPINION (issue #399). A
 * `grade_answer` for a turn in which the provider transcribed no learner speech
 * at all is refused here and never posted, so an answer nobody gave cannot
 * become a `practice_attempts` row. It reads no transcript, compares nothing to
 * an accepted answer and forms no verdict — it asks only whether the microphone
 * produced anything since the current question was asked, which is a fact only
 * this process holds. See `heardThisTurnRef` for the mechanism and
 * `transcriptionSeenRef` for why absence alone is never enough to refuse on.
 *
 * A REFUSAL IS A NORMAL RESULT, NOT AN ERROR. The route answers a rejected
 * tool call with HTTP 200 and an `instruction` field, and relaying that
 * instruction verbatim is what gets the session moving again. Treating it as a
 * failure would leave the coach holding a tool call that never resolves — a
 * live conversation, billing by the minute, that has silently stopped.
 *
 * =============================================================================
 * NO `MediaRecorder`, NO `useVoiceActivity`, NO EARCONS. NOT AN OVERSIGHT.
 * =============================================================================
 *
 * The tempting design is to reuse `useConversationSession` and swap its
 * `transcribe` port for a realtime one. It is the wrong design and it fails in
 * a specific way, which is why the absence is stated here rather than left to
 * be noticed:
 *
 *   * `useVoiceActivity` calibrates an ambient threshold, decides an utterance
 *     ended after a hangover window, and gates a `MediaRecorder`.
 *     `TURN_DETECTION` in `services/realtimeConnection.ts` is `semantic_vad`
 *     with `interrupt_response: true`, and the PROVIDER decides when a turn
 *     ended. Running both is two independent opinions about the same event,
 *     gating a recorder that must not exist on this path at all — a half-duplex
 *     gate imposed on a full-duplex transport.
 *   * There is no `MediaRecorder` here because nothing on this path uploads a
 *     blob: the audio goes browser ↔ provider over WebRTC, and the only thing
 *     this application ever receives is text the model already heard.
 *   * The earcons (`lib/earcons.ts`) covered the request/response loop's
 *     multi-second silent `processing` state. `realtime-practice.md` §8.1: the
 *     realtime transport HAS no `processing` phase and none should be added —
 *     the model is talking. A cue announcing a gap that does not exist teaches
 *     a learner the sound means nothing.
 *
 * =============================================================================
 * THIS HOOK NEVER OPENS AND NEVER CLOSES A MICROPHONE. IT BORROWS ONE.
 * =============================================================================
 *
 * There is no `getUserMedia` call in this file, no `track.stop()`, no
 * `track.enabled = …` and no `replaceTrack`. The page owns exactly ONE
 * microphone — the persistent `useAudioCapture` instance E13's loop already
 * uses, which requests `echoCancellation` (see §11 and that hook's own "THE APP
 * MUST NOT HEAR ITSELF" section) — and hands it here through
 * {@link RealtimePracticeMicrophonePort}.
 *
 * Two rules follow, and both are asserted:
 *
 *  1. **Exactly one live stream per page.** Because the transport is a runtime
 *     switch, two hooks each acquiring their own would mean two live streams,
 *     a recorder possibly running on one while the other transmits, and on
 *     mobile Safari a second `getUserMedia` that steals or fails.
 *  2. **The mic track is never disabled, muted or replaced for the life of the
 *     session.** `realtimeConnection.ts`'s header forbids it outright: "every
 *     one of those is a half-duplex design wearing a different name."
 *
 * `openRealtimeConnection` DOES stop the tracks when the connection ends —
 * that is its own documented contract, and it is right: the microphone light
 * must go out when a session ends. So every close path here calls
 * `microphone.release()` FIRST and closes the connection second. The order is
 * load-bearing rather than tidy: `useAudioCapture`'s persistent mode watches
 * its tracks for an unexpected `ended` and reports `device_in_use` when one
 * fires, and `releaseStream()` clears its own reference before stopping
 * anything — so releasing first turns a shutdown into an ordinary teardown
 * instead of a spurious "another application is using your microphone" on a
 * screen the learner is about to answer on.
 *
 * =============================================================================
 * EVERY FAILURE ENDS SOMEWHERE A LEARNER CAN STILL PRACTISE
 * =============================================================================
 *
 * `realtime-practice.md` §8's ladder. This hook produces the {@link fallback}
 * that ladder reads; it does not itself decide which rung is next — that is
 * `resolveVoiceTransport` in `PracticeSessionPage.tsx`, the one site where the
 * whole ladder is decided.
 *
 * PROGRESS IS NEVER LOST ACROSS A FALLBACK, structurally rather than by care:
 * every attempt is a `practice_attempts` row committed by the engine before
 * the tool result that mentions it ever reaches this file. There is no
 * client-held answer, count or verdict for a fallback to drop, because none of
 * it was ever client-held.
 *
 * A MID-SESSION FALLBACK IS SPOKEN, not merely rendered. A learner walking with
 * the phone in their pocket is not reading the screen, and the loop is about to
 * change character — E13 states the same rule for every spoken edge case on its
 * own transport. One sentence, from a code-owned constant, through the port the
 * page supplies; the identical string is also the rendered {@link notice}, so
 * the two can never say different things.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createPracticeRealtimeSession,
  sendPracticeRealtimeToolCall,
} from '../services/api';
import {
  openRealtimeConnection,
  type RealtimeConnection,
  type RealtimeProviderError,
  type RealtimeSpeechEvent,
  type RealtimeToolCallEvent,
} from '../services/realtimeConnection';
import { useIsMounted } from './useIsMounted';
import type {
  AiUnavailableCause,
  PracticeRealtimeToolCallInput,
  PracticeRealtimeToolCallResponse,
  PracticeRealtimeToolName,
} from '../types';

/**
 * How many times a dropped connection is re-minted before falling back.
 *
 * BOUNDED, and the bound is small on purpose. Each attempt is a mint on the
 * learner's own key and a handshake they are sitting in silence through; a
 * loop that kept trying would spend their money to keep them waiting.
 * `realtime-practice.md` §10 requires a bound and a named constant; it is this
 * hook's own rather than the interview's, because a practice session's
 * tolerance for silence is its own question and sharing the constant would
 * make one epic's tuning the other's.
 */
export const MAX_RECONNECTS = 2;

/**
 * How long a live connection may carry no tool call and no speech before it
 * closes itself.
 *
 * `realtime-practice.md` §10: a realtime connection bills for audio duration,
 * so a session nobody is in is a session spending a learner's own money on
 * silence. Long enough that a learner thinking hard about a question is never
 * cut off (they are also being listened to, which resets it); short enough
 * that a phone left on a kitchen counter stops on its own.
 */
export const REALTIME_PRACTICE_IDLE_MS = 120_000;

/**
 * The sentence spoken — and rendered — when the spoken session ends by itself.
 *
 * CODE-OWNED COPY, never a model's words and never a provider's error string.
 * A learner who is not looking at the screen has to be told, in one sentence,
 * that the loop has changed and that nothing they have already answered is
 * gone.
 */
export const REALTIME_PRACTICE_FALLBACK_LINE =
  'The live voice connection stopped. Everything you have answered is saved, ' +
  'and you can carry on here.';

/** Spoken and rendered when the session closes because it ran out of time. */
export const REALTIME_PRACTICE_IDLE_LINE =
  'I stopped the live voice session because it had been quiet for a while. ' +
  'Everything you have answered is saved.';

/** Rendered — never spoken — when a hidden tab closes the connection. */
export const REALTIME_PRACTICE_HIDDEN_LINE =
  'The live voice session ended when you left this tab. Everything you have ' +
  'answered is saved.';

/** Rendered when the engine says the session is complete. Not a failure. */
export const REALTIME_PRACTICE_COMPLETE_LINE =
  'That is the whole session. Nicely done.';

/**
 * Rendered — never spoken — when the provider reports an error mid-session.
 *
 * ISSUE #385, AND THE POINT IS THAT SILENCE IS NOW EXPLAINED. A provider error
 * usually ends one TURN rather than the session: the coach misses a question
 * and the connection stays up, so the honest thing is a sentence on screen and
 * a way out, not a fallback that abandons a working connection.
 *
 * CODE-OWNED, and it names no provider, no code and no error string — those go
 * to the console for a developer. A learner cannot act on
 * `conversation_already_has_active_response`; they can act on "ask it again".
 *
 * NOT SPOKEN, unlike the fallback and idle lines. Those announce that the loop
 * itself has changed and a learner who is not looking at the screen has to be
 * told; this one describes a hiccup in a session that is still running, and
 * talking over a coach who may be mid-sentence to report a hiccup is worse than
 * the hiccup.
 */
export const REALTIME_PRACTICE_PROVIDER_ERROR_LINE =
  'The voice connection hit a snag. If the coach goes quiet, ask it to repeat ' +
  'the question — or stop and carry on here.';

/** Why the spoken practice session cannot continue. A closed set. */
export type RealtimePracticeFallbackCode =
  /** No mint was attempted: `realtime` unbound, AI off, or no key stored. */
  | 'ai_unavailable'
  /** There is no live microphone, so no mint was attempted either. */
  | 'microphone'
  /** The mint was attempted and did not produce a usable session. */
  | 'mint_failed'
  /** The handshake never completed. */
  | 'connection_failed'
  /** It dropped mid-session and could not be re-established. */
  | 'connection_lost';

export interface RealtimePracticeFallback {
  code: RealtimePracticeFallbackCode;
  /** What happened, one sentence, in the learner's terms. Never generic. */
  message: string;
  /** What they can do about it, or null when there is genuinely nothing. */
  remedy: string | null;
  /**
   * Set only for `ai_unavailable` — WHICH of the four causes.
   *
   * `no_user_key` is the learner's own to fix; the other three are an
   * administrator's. Collapsing them would tell somebody with no key stored
   * that their administrator has not finished setting something up.
   */
  cause: AiUnavailableCause | null;
  /** Whether pressing "try again" could plausibly help. */
  retryable: boolean;
}

/**
 * One sentence for the screen, and the exact sentence that was spoken.
 *
 * The same contract E13's `ConversationNotice` states: render this, do not
 * rewrite it. Two renderings of one fact, never two facts.
 */
export interface RealtimePracticeNotice {
  message: string;
  /** True when this sentence was also said out loud. */
  spoken: boolean;
}

/**
 * The page's one microphone, as a port.
 *
 * NOT `useAudioCapture` ITSELF, deliberately: a port is what makes "this hook
 * never opens a microphone" checkable rather than merely intended, and it is
 * what lets the page decide that the E13 loop and this transport share a single
 * device. See the file header.
 */
export interface RealtimePracticeMicrophonePort {
  /**
   * Open (or reuse) the one microphone this page owns.
   *
   * NEVER THROWS. Resolves with the live stream, or with `null` having recorded
   * its own named problem — which is the signal to fall back to text BEFORE any
   * mint is attempted, since a mint on a learner's own key for a session they
   * have no microphone to speak into spends their money on nothing.
   */
  acquire: () => Promise<MediaStream | null>;
  /**
   * The owner's own teardown. The ONLY thing this hook ever calls to end a
   * microphone, and it never stops a track itself.
   */
  release: () => void;
  /** What went wrong when `acquire` resolved `null`, in the learner's terms. */
  problem: { message: string; remedy: string | null; retryable: boolean } | null;
}

export interface UseRealtimePracticeOptions {
  /** The practice session this conversation is about. */
  sessionId: string | null | undefined;
  /** See {@link RealtimePracticeMicrophonePort}. */
  microphone: RealtimePracticeMicrophonePort;
  /**
   * Say one code-owned sentence with the browser's own voice. Never rejects.
   *
   * A PORT RATHER THAN A `speechSynthesis` CALL HERE, so the page keeps its one
   * speaking surface and this hook keeps its one job. It is used for exactly
   * the sentences in this file's constants — never for anything a model said,
   * which the model says for itself over the live connection.
   */
  speak: (text: string) => void;
  /**
   * Does this session still have something to ask?
   *
   * `false` refuses to mint at all (`realtime-practice.md` §10: "never mint for
   * a session with nothing left to ask"), which is also the 409 the mint route
   * would answer with — checked here so a doomed mint is never attempted.
   */
  hasQuestion: boolean;
}

/** Where the spoken practice session has got to. */
export type RealtimePracticeStage =
  /** Nothing has been attempted yet. */
  | 'idle'
  /** Microphone, mint, handshake — in that order. */
  | 'connecting'
  /** The conversation is live. */
  | 'live'
  /** It cannot continue by voice. See {@link UseRealtimePracticeReturn.fallback}. */
  | 'fallback'
  /** The learner stopped it, or the engine said the session is complete. */
  | 'ended';

export interface UseRealtimePracticeReturn {
  stage: RealtimePracticeStage;
  /**
   * When THIS spoken session began, as an epoch millisecond, or `null`.
   *
   * ISSUE #387, AND IT IS A COST FIGURE RATHER THAN A DECORATION. A realtime
   * connection bills the learner's own key by the minute (epic #345, decision
   * 7), so the elapsed clock a learner reads is the only running statement of
   * what a session is costing them — and a clock that restarts systematically
   * under-reports it.
   *
   * SET ONCE, WHEN `start()` OPENS THE SESSION, and deliberately NOT re-set by
   * a re-mint: `MAX_RECONNECTS` reconnections are one continuous session to the
   * learner, they are billed as one, and a clock that restarted on each would
   * hide exactly the sessions that cost the most. `retry()` does re-set it,
   * because that is a new session after a fallback rather than a repair of this
   * one.
   *
   * It is not cleared when the session ends: the only reader is the surface,
   * which is unmounted by then, and a second place that clears it is a second
   * place for it to disagree with `stage`.
   */
  startedAt: number | null;
  /** Set exactly when `stage === 'fallback'`. The ladder's input. */
  fallback: RealtimePracticeFallback | null;
  /** The last thing this hook has to say, spoken or not. */
  notice: RealtimePracticeNotice | null;

  /**
   * The question the ENGINE says is outstanding, or `null`.
   *
   * A JOIN KEY, never a verdict and never a count. The page uses it as the
   * signal that the conversation moved — which is when it re-reads the session
   * from the server, the only place the answered/planned figures ever come
   * from.
   */
  questionId: string | null;

  /** True while the coach's words are still arriving. Drives `aria-busy`. */
  isCoachSpeaking: boolean;
  /**
   * The learner's own last words, as the PROVIDER heard them.
   *
   * Rendered so they can see they were heard. Nothing here compares its WORDS
   * to anything — the one decision taken from learner speech (#399) is taken
   * from whether any arrived this turn, never from what it said, and the
   * grading ladder is still the engine's alone.
   */
  heard: string | null;

  /** The coach's voice. Attach it to an audio element and play it. */
  remoteStream: MediaStream | null;

  /** Begin: microphone, then mint, then handshake. Never throws. */
  start: () => void;
  /** End the session now. Idempotent, and safe from any stage. */
  stop: () => void;
  /** Try the whole of `start` again after a retryable fallback. */
  retry: () => void;
  /** Dismiss the rendered notice. Does not un-speak it. */
  dismissNotice: () => void;
}

/**
 * The fallback a session that was already live ends at.
 *
 * ONE OBJECT FOR BOTH WAYS OF GETTING HERE — a channel that closed, and a
 * re-mint that failed — because from the learner's side they are the same
 * event: the coach stopped talking and is not coming back. A screen that told
 * them their AI provider had refused a mint would be explaining the wrong
 * layer to somebody who only wants to finish their practice.
 */
const CONNECTION_LOST: RealtimePracticeFallback = {
  code: 'connection_lost',
  message: REALTIME_PRACTICE_FALLBACK_LINE,
  remedy: null,
  cause: null,
  retryable: false,
};

/** Is this one of the five tools the practice contract declares? */
export function isPracticeToolName(
  name: string,
): name is PracticeRealtimeToolName {
  return (
    name === 'next_question' ||
    name === 'grade_answer' ||
    name === 'repeat_question' ||
    name === 'skip_question' ||
    name === 'end_session'
  );
}

/**
 * Narrow one tool call's arguments to the shape its tool declares, or `null`.
 *
 * NOT A CAST. A `grade_answer` without a `questionId`, a `skip_question`
 * without one and an `end_session` without a `reason` are calls the API would
 * refuse as a 400, and a 400 reaches the model as a generic failure rather than
 * as the instruction that would get the session moving again. Refusing here
 * produces the same refusal shape the server produces, one round trip sooner.
 *
 * NOTHING IS INVENTED and nothing is inspected: `transcript` is passed through
 * exactly as the model reported it, because what the learner said is graded
 * server-side by the one ladder every transport shares.
 */
export function toPracticeToolCallInput(
  event: RealtimeToolCallEvent,
): PracticeRealtimeToolCallInput | null {
  const { args } = event;

  if (event.name === 'next_question') return { tool: 'next_question' };
  if (event.name === 'repeat_question') return { tool: 'repeat_question' };

  if (event.name === 'grade_answer') {
    const questionId = args.questionId;
    const transcript = args.transcript;
    if (typeof questionId !== 'string' || typeof transcript !== 'string') {
      return null;
    }
    return { tool: 'grade_answer', questionId, transcript };
  }

  if (event.name === 'skip_question') {
    const questionId = args.questionId;
    if (typeof questionId !== 'string') return null;
    return { tool: 'skip_question', questionId };
  }

  if (event.name === 'end_session') {
    const reason = args.reason;
    if (reason !== 'learner_asked' && reason !== 'no_questions_left') return null;
    return { tool: 'end_session', reason };
  }

  return null;
}

/**
 * Build the refusal this hook sends when a call never reached the engine.
 *
 * THE SAME SHAPE THE SERVER'S OWN REFUSALS TAKE, including `instruction`,
 * because the model has no way to tell the two apart and no reason to need one.
 * What it must never receive is nothing at all.
 */
function localRejection(
  tool: string,
  reason: string,
  error: string,
  instruction = 'Call next_question and say what it returns.',
): Record<string, unknown> {
  return {
    tool,
    status: 'rejected',
    reason,
    error,
    instruction,
  };
}

/**
 * The instruction a `grade_answer` gets when the microphone heard nothing.
 *
 * WORDED LIKE THE ENGINE'S OWN `emptyTranscriptRejection`, deliberately — that
 * refusal covers the neighbouring case ("that call carried no answer") and this
 * one covers "that call carried an answer we can find no evidence of". Both end
 * the same way: ask again, take no decision on the learner's behalf, and never
 * record something they did not say.
 *
 * `repeat_question` rather than `next_question`, because the question is still
 * outstanding — the engine would refuse a `next_question` with
 * `answer_outstanding` and the turn would cost a round trip to arrive back
 * here. Read aloud again, it is also the only thing the learner needs: they are
 * about to hear the question they were trying to answer.
 */
const NOTHING_HEARD_INSTRUCTION =
  'Call repeat_question and say what it returns. Do not call skip_question ' +
  'unless the learner has asked to move on, and never report an answer they ' +
  'did not give.';

export function useRealtimePractice(
  options: UseRealtimePracticeOptions,
): UseRealtimePracticeReturn {
  const [stage, setStage] = useState<RealtimePracticeStage>('idle');
  const [fallback, setFallback] = useState<RealtimePracticeFallback | null>(null);
  const [notice, setNotice] = useState<RealtimePracticeNotice | null>(null);
  const [questionId, setQuestionId] = useState<string | null>(null);
  const [isCoachSpeaking, setIsCoachSpeaking] = useState(false);
  const [heard, setHeard] = useState<string | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  /** See {@link UseRealtimePracticeReturn.startedAt}. */
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const isMounted = useIsMounted();

  /**
   * Everything this hook reads from its caller, refreshed every render.
   *
   * The same move `useConversationSession` makes, for the same reason:
   * continuations here resolve round trips started several renders ago, and
   * what they need is the LATEST microphone port and the LATEST session id —
   * not the ones that were true when the learner pressed Start.
   */
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const connectionRef = useRef<RealtimeConnection | null>(null);
  const startingRef = useRef(false);
  const reconnectsRef = useRef(0);
  /** Was the conversation ever live? Decides whether an exit is SPOKEN. */
  const wasLiveRef = useRef(false);
  /**
   * Is the page's microphone currently on loan to THIS hook?
   *
   * THE ENFORCEMENT OF "RELEASES ONLY WHAT IT ACQUIRED". The page owns the
   * device and both spoken transports borrow the same one, so a `stop()` from a
   * hook that never started — the learner tapping Text while E13's loop is the
   * one running, which calls both transports' stops — must not reach in and
   * close a microphone somebody else opened. Set when `acquire` hands a stream
   * over, cleared the moment it goes back.
   */
  const borrowedRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------------------
  // DID THE MICROPHONE HEAR ANYTHING THIS TURN? (issue #399)
  // ---------------------------------------------------------------------------
  //
  // The one check on this transport that is not a relay, and it is here rather
  // than server-side because the evidence exists only here: the provider's
  // transcription of the LEARNER'S INPUT AUDIO arrives on the browser's own
  // data channel and reaches no other process. Until #399 it was rendered and
  // otherwise discarded, so what the model CLAIMED it heard was never set
  // against what the microphone actually picked up — and a model grading its
  // own voice returning through a loudspeaker was believed all the way into a
  // `practice_attempts` row, about an answer nobody gave.
  //
  // IT DECIDES NOTHING ABOUT CORRECTNESS. It does not read the transcript, does
  // not compare it to an answer and does not know what a right answer is; it
  // asks only whether the learner's microphone produced ANY speech since the
  // current question was asked. The grading ladder is still the engine's, and
  // still the only one.

  /**
   * Has the provider transcribed any learner speech since this question was
   * asked?
   *
   * RESET WHEN A QUESTION IS ASKED, never on a timer: a turn is bounded by the
   * question it belongs to, and a clock would decide that a learner who thought
   * for eleven seconds had not spoken.
   */
  const heardThisTurnRef = useRef(false);

  /**
   * Has this hook EVER seen the provider transcribe learner input?
   *
   * THE DIFFERENCE BETWEEN "TRANSCRIBED NOTHING" AND "DOES NOT TRANSCRIBE", and
   * without it the guard above is a brick rather than a safeguard. A realtime
   * session only transcribes its input when the mint asked it to (it now does —
   * `openai.provider.ts`'s `DEFAULT_REALTIME_TRANSCRIPTION_MODEL`), and a
   * deployment where that never reaches the provider — an older API behind a
   * cached bundle, a model that ignores the field — would produce no
   * transcription events at all. Enforcing on absence there would refuse EVERY
   * answer of every session, which is a far worse failure than the one being
   * fixed.
   *
   * So the guard arms itself only once this connection has PROVEN the provider
   * transcribes: fail open until then, closed ever after. It is monotonic and
   * never reset, including across a re-mint, because it describes the
   * deployment rather than the connection.
   */
  const transcriptionSeenRef = useRef(false);

  /** The question the engine last said was outstanding. A join key, not a verdict. */
  const lastQuestionIdRef = useRef<string | null>(null);

  /** Start a fresh turn: nothing has been heard for the question just asked. */
  const beginTurn = useCallback(() => {
    heardThisTurnRef.current = false;
  }, []);

  /**
   * May a `grade_answer` be relayed at all?
   *
   * `true` when the microphone produced speech this turn — and also when this
   * deployment has never been observed transcribing input, for the reason
   * {@link transcriptionSeenRef} states.
   */
  const heardSomethingThisTurn = useCallback(
    () => heardThisTurnRef.current || !transcriptionSeenRef.current,
    [],
  );

  // ---------------------------------------------------------------------------
  // Ending a session
  // ---------------------------------------------------------------------------

  /** Give the microphone back — but only if this hook is the one holding it. */
  const releaseMicrophone = useCallback(() => {
    if (!borrowedRef.current) return;
    borrowedRef.current = false;
    optionsRef.current.microphone.release();
  }, []);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current === null) return;
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
  }, []);

  /**
   * Close the connection and give the microphone back. Idempotent.
   *
   * THE RELEASE COMES FIRST — see the file header. `openRealtimeConnection`
   * stops the tracks itself on close, and doing that while the page's capture
   * hook still holds the stream would fire its `ended` watcher and report a
   * device problem that did not happen.
   */
  const teardown = useCallback(() => {
    clearIdleTimer();
    const connection = connectionRef.current;
    connectionRef.current = null;
    releaseMicrophone();
    connection?.close();
  }, [clearIdleTimer, releaseMicrophone]);

  /** Unmount ends the session — §10's third close condition. */
  useEffect(() => teardown, [teardown]);

  /**
   * Stop, with one sentence about why.
   *
   * `spoken` is the caller's, not this function's, because the rule is about
   * WHEN rather than about which sentence: a learner who has been talking to
   * this application for five minutes and is about to be moved to another loop
   * has to hear it, and a learner who left the tab is not listening to
   * anything.
   */
  const endSession = useCallback(
    (line: string, spoken: boolean) => {
      teardown();
      wasLiveRef.current = false;
      if (spoken) optionsRef.current.speak(line);
      if (!isMounted()) return;
      setRemoteStream(null);
      setIsCoachSpeaking(false);
      setStage('ended');
      setNotice({ message: line, spoken });
    },
    [isMounted, teardown],
  );

  /**
   * Give up on the spoken transport.
   *
   * SPOKEN WHEN THE SESSION WAS LIVE, silent when it never opened: a learner
   * who has just pressed Start is looking at the screen and the fallback's own
   * copy is on it, while a learner mid-conversation is not.
   */
  const fallBack = useCallback(
    (landing: RealtimePracticeFallback) => {
      const wasLive = wasLiveRef.current;
      teardown();
      wasLiveRef.current = false;
      if (wasLive) optionsRef.current.speak(landing.message);
      if (!isMounted()) return;
      setRemoteStream(null);
      setIsCoachSpeaking(false);
      setFallback(landing);
      setNotice({ message: landing.message, spoken: wasLive });
      setStage('fallback');
    },
    [isMounted, teardown],
  );

  // ---------------------------------------------------------------------------
  // The relay
  // ---------------------------------------------------------------------------

  /**
   * Restart the idle countdown.
   *
   * Called on every tool call and every utterance in either direction, so the
   * timer measures SILENCE rather than session length — a learner who is
   * talking is never cut off by it.
   */
  const touchIdle = useCallback(() => {
    clearIdleTimer();
    // NO CONNECTION, NO TIMER. A relay continuation can outlive the connection
    // that started it (a channel that closed mid-opening-turn), and a timer
    // armed there would end a session two minutes after it had already ended —
    // speaking a sentence at a learner who has been typing ever since.
    if (!connectionRef.current) return;
    idleTimerRef.current = setTimeout(() => {
      endSession(REALTIME_PRACTICE_IDLE_LINE, true);
    }, REALTIME_PRACTICE_IDLE_MS);
  }, [clearIdleTimer, endSession]);

  /**
   * Post one tool call and hand the answer back to the model.
   *
   * `callId` is `null` for a call THIS HOOK originated — the opening turn — for
   * which there is no tool result to return; the coach is told to speak the
   * engine's own lines instead.
   *
   * The result is forwarded VERBATIM, including a rejection, and exactly three
   * of its fields are read afterwards: `questionId` (a join key the page uses
   * to know the conversation moved), `then` (an action name — identical for a
   * right answer, a wrong one and a skip), and, on the last turn only, `say`
   * — passed straight to the speech port without being read for meaning.
   */
  const relay = useCallback(
    async (
      call: PracticeRealtimeToolCallInput,
      callId: string | null,
    ): Promise<PracticeRealtimeToolCallResponse | null> => {
      const id = optionsRef.current.sessionId;
      if (!id) return null;

      touchIdle();

      let result: PracticeRealtimeToolCallResponse;
      try {
        result = await sendPracticeRealtimeToolCall(id, call);
      } catch (err) {
        // A transport failure on the RELAY, not in the session. The model is
        // still waiting on a tool result, and leaving it waiting is how a live
        // conversation goes silent — so it is told, in the same shape a
        // server-side refusal takes, to carry on.
        if (callId !== null) {
          connectionRef.current?.sendToolResult(
            callId,
            localRejection(
              call.tool,
              'relay_failed',
              err instanceof Error
                ? err.message
                : 'That could not be sent to the application.',
            ),
          );
        }
        return null;
      }

      // VERBATIM, INCLUDING A REJECTION. `instruction` is the field that gets
      // the session moving again.
      if (callId !== null) connectionRef.current?.sendToolResult(callId, result);

      if (!isMounted()) return result;

      if (result.status === 'ok') {
        // THE SESSION HAS DEMONSTRABLY RECOVERED (#399), so whatever the last
        // provider error said stops being true here.
        //
        // `providerError` sets a notice and, until this line, only a reconnect
        // or the learner's own dismissal cleared it — so ONE turn-level
        // rejection at eight seconds branded the remaining thirty-nine of a
        // working session with "the voice connection hit a snag". That message
        // is about a turn, and its own doc comment says the session usually
        // keeps running; a sentence that outlives the thing it describes is a
        // sentence a learner reads as the app being broken.
        //
        // AN HONOURED TOOL RESULT IS THE PROOF, and it is the strongest one
        // available: the model called a tool, the engine accepted it, and the
        // coach is about to speak. A REJECTED result deliberately does not
        // clear it — the session moved, but nothing was shown to be working.
        // Nothing here says anything new; it only stops saying something that
        // has stopped being so.
        setNotice(null);

        // A NEW TURN BEGINS WHEN A QUESTION IS ASKED (#399), which is exactly
        // these two cases: a tool that puts a question in the air, and any
        // honoured result that moved the outstanding question on. Never a
        // timer — see `heardThisTurnRef`. `repeat_question` counts because the
        // learner is being asked again and has not answered yet.
        if (
          call.tool === 'next_question' ||
          call.tool === 'repeat_question' ||
          result.questionId !== lastQuestionIdRef.current
        ) {
          beginTurn();
        }
        lastQuestionIdRef.current = result.questionId;

        setQuestionId(result.questionId);
        if (result.then === 'session_complete') {
          // §10's first close condition. The engine — not this hook and not the
          // model — has said there is nothing left to ask.
          //
          // THE ENGINE'S OWN LAST LINES, SPOKEN LOCALLY. Closing the connection
          // the instant the session is over is what §10 asks for, and it cuts
          // the coach off mid-sentence — the result was handed to the model a
          // line ago and the model is about to say it. Rather than lose the
          // engine's closing words (a verdict for the last answer, the accepted
          // answer, the coach's reaction) or keep a per-minute connection open
          // on a timer to hear them, they are said here, verbatim, with the
          // browser's own free voice. Nothing is composed and nothing is
          // summarised: `say` is passed through exactly as it arrived.
          endSession(
            result.say.join(' ') || REALTIME_PRACTICE_COMPLETE_LINE,
            wasLiveRef.current,
          );
        }
      }

      return result;
    },
    [beginTurn, endSession, isMounted, touchIdle],
  );

  /** Turn one tool call from the model into an HTTP relay. */
  const handleToolCall = useCallback(
    (event: RealtimeToolCallEvent) => {
      if (!isPracticeToolName(event.name)) {
        // A tool nobody declared. Refused here rather than posted and refused
        // as a 400 — same outcome for the model, one fewer round trip, and no
        // unexplained validation error in the API's logs.
        connectionRef.current?.sendToolResult(
          event.callId,
          localRejection(
            event.name,
            'unknown_tool',
            `${event.name} is not a tool in this session.`,
          ),
        );
        return;
      }

      const call = toPracticeToolCallInput(event);
      if (!call) {
        connectionRef.current?.sendToolResult(
          event.callId,
          localRejection(
            event.name,
            'malformed_arguments',
            'Those arguments were not the ones that tool takes.',
          ),
        );
        return;
      }

      // ---- THE ONE CALL THAT IS NOT RELAYED UNCONDITIONALLY (#399) ---------
      //
      // A `grade_answer` for a turn in which the microphone produced no speech
      // at all is refused HERE, and it never reaches
      // `POST /api/practice/sessions/:id/realtime/tool-calls` — so no
      // `practice_attempts` row can be written for it, whatever the acoustics
      // in the room. The engine cannot make this check itself: the evidence is
      // the provider's transcription of the learner's input audio, which
      // arrives on this data channel and nowhere else.
      //
      // NOT A FALLBACK, NOT A TEARDOWN AND NOT AN ERROR ON SCREEN. The session
      // is working; one call was not honoured. The model is handed the same
      // refusal shape every other locally-refused call gets, and its
      // instruction asks for the question to be read again — so a learner who
      // was talked over simply hears it a second time.
      if (call.tool === 'grade_answer' && !heardSomethingThisTurn()) {
        connectionRef.current?.sendToolResult(
          event.callId,
          localRejection(
            'grade_answer',
            'nothing_heard',
            'Your microphone picked up no speech since that question was asked.',
            NOTHING_HEARD_INSTRUCTION,
          ),
        );
        return;
      }

      void relay(call, event.callId);
    },
    [heardSomethingThisTurn, relay],
  );

  /**
   * Open the conversation, on a fresh session and on a re-mint alike.
   *
   * `repeat_question` FIRST, and it is not a guess. A re-minted connection has
   * a model with no context at all and the session may still be waiting on an
   * answer; `repeat_question` writes nothing, costs nothing, and returns the
   * outstanding question's own words. When nothing is outstanding — every fresh
   * session — the engine refuses it with `no_answer_outstanding` and an
   * instruction to call `next_question`, and this follows that instruction
   * literally. Opening with `next_question` instead would abandon an
   * outstanding question on every resume.
   *
   * The lines spoken are the ENGINE's, handed to `speakVerbatim` exactly as
   * they arrived. This hook composes no sentence of its own here.
   */
  const openingTurn = useCallback(async () => {
    const first = await relay({ tool: 'repeat_question' }, null);
    if (first?.status === 'ok') {
      for (const line of first.say) connectionRef.current?.speakVerbatim(line);
      return;
    }
    const next = await relay({ tool: 'next_question' }, null);
    if (next?.status !== 'ok') return;
    for (const line of next.say) connectionRef.current?.speakVerbatim(line);
  }, [relay]);

  // ---------------------------------------------------------------------------
  // Connecting
  // ---------------------------------------------------------------------------

  /**
   * The whole start sequence: microphone, then mint, then handshake.
   *
   * THE ORDER IS THE POINT (§10). A mint on a learner's own key, for a session
   * they have no microphone to speak into, spends their money on nothing — so
   * the browser's own permission refusal is caught before any
   * `POST /api/practice/sessions/:id/realtime-session` is made.
   */
  const connect = useCallback(
    async (isReconnect: boolean) => {
      const { sessionId, microphone, hasQuestion } = optionsRef.current;
      if (!sessionId || startingRef.current) return;
      // NEVER MINT FOR A SESSION WITH NOTHING LEFT TO ASK (§10) — the same 409
      // the route enforces server-side, checked here so a doomed mint is never
      // attempted at all.
      if (!hasQuestion) return;
      startingRef.current = true;

      /**
       * Give up on this attempt.
       *
       * ON THE FIRST ATTEMPT the learner has not started speaking, so they are
       * told exactly what went wrong: an unbound role, a refused microphone and
       * a failed mint are three different errands and only one of them is worth
       * a retry.
       *
       * ON A RECONNECT none of that is the useful thing to say. The coach has
       * gone silent mid-conversation, so the attempt is repeated up to
       * {@link MAX_RECONNECTS} times and, when that is spent, the session falls
       * to the request/response loop.
       */
      const giveUp = (landing: RealtimePracticeFallback) => {
        startingRef.current = false;
        if (!isReconnect) {
          fallBack(landing);
          return;
        }
        if (reconnectsRef.current < MAX_RECONNECTS) {
          reconnectsRef.current += 1;
          void connectRef.current(true);
          return;
        }
        fallBack(CONNECTION_LOST);
      };

      if (isMounted()) {
        setStage('connecting');
        setFallback(null);
        setNotice(null);
        // THE SESSION'S OWN CLOCK, STARTED ONCE. A re-mint continues the same
        // session on the same key and must not restart it — see
        // `UseRealtimePracticeReturn.startedAt`.
        if (!isReconnect) setStartedAt(Date.now());
      }

      // ---- 1. The microphone ------------------------------------------------
      //
      // BORROWED, NEVER OPENED HERE. The port's own problem copy is
      // `useAudioCapture`'s six named problems with six named remedies — a
      // denied permission, a dismissed prompt, no device, a device another app
      // holds, an insecure origin and a browser that cannot capture — because
      // "microphone unavailable" sends a learner whose headset is unplugged off
      // to change a permission that was never the problem.
      const stream = await microphone.acquire();
      borrowedRef.current = stream !== null;
      if (!stream) {
        const problem = microphone.problem;
        giveUp({
          code: 'microphone',
          message: problem?.message ?? 'Your microphone could not be opened.',
          remedy: problem?.remedy ?? null,
          cause: null,
          retryable: problem?.retryable ?? true,
        });
        return;
      }

      // ---- 2. The mint ------------------------------------------------------
      try {
        const session = await createPracticeRealtimeSession(sessionId);

        if (session.status === 'unavailable') {
          // NOT AN ERROR. Nothing was spent and nothing is broken — this is a
          // deployment where spoken practice is not configured, or a learner
          // who has not stored a key. Either way the answer is the next rung of
          // the ladder, and every recorded attempt is untouched.
          giveUp({
            code: 'ai_unavailable',
            message:
              session.cause === 'no_user_key'
                ? 'A live voice session runs on your own AI key, and there isn’t one saved on your account yet.'
                : 'Live voice practice is not set up on this installation.',
            remedy: null,
            cause: session.cause,
            retryable: false,
          });
          return;
        }

        if (session.status === 'failed') {
          giveUp({
            code: 'mint_failed',
            // The API's own message, already redacted — never a key, and never
            // the secret this route mints.
            message: session.error || 'The voice session could not be started.',
            remedy:
              'Trying again often works. Your practice session is unaffected.',
            cause: null,
            retryable: true,
          });
          return;
        }

        // ---- 3. The handshake ----------------------------------------------
        const connection = await openRealtimeConnection({
          clientSecret: session.clientSecret,
          modelId: session.modelId,
          stream,
          handlers: {
            onToolCall: (event) => handleToolCallRef.current(event),
            // The coach's own words. `onOfficerSpeech` is the transport's name
            // for "the side that is not the learner" — this transport's is a
            // coach, and nothing but the label differs.
            onOfficerSpeech: (event) => coachSpeechRef.current(event),
            onApplicantSpeech: (event) => learnerSpeechRef.current(event),
            onProviderError: (error) => providerErrorRef.current(error),
            onRemoteStream: (remote) => {
              if (isMounted()) setRemoteStream(remote);
            },
            onClosed: (reason) => closedRef.current(reason),
          },
        });

        connectionRef.current = connection;
        startingRef.current = false;
        wasLiveRef.current = true;

        if (!isMounted()) {
          // Unmounted during the handshake. Close what we just opened rather
          // than leaving a live microphone attached to a page nobody is on.
          releaseMicrophone();
          connection.close();
          return;
        }

        setStage('live');
        touchIdle();
        await openingTurn();
      } catch (error) {
        giveUp({
          code: 'connection_failed',
          message:
            error instanceof Error
              ? error.message
              : 'The voice connection could not be opened.',
          remedy:
            'You can carry on here — nothing you have already answered is lost.',
          cause: null,
          retryable: true,
        });
      }
    },
    [fallBack, isMounted, openingTurn, releaseMicrophone, touchIdle],
  );

  // ---------------------------------------------------------------------------
  // Handlers, held in refs
  // ---------------------------------------------------------------------------
  //
  // `openRealtimeConnection` captures its handlers once, at handshake time, and
  // the connection outlives many renders. Passing the callbacks directly would
  // freeze the first render's closures — a tool call relayed against a stale
  // session id, and a drop handled by a reconnect counter nobody had
  // incremented. The refs are re-pointed on every render so the connection
  // always calls the current one.

  const connectRef = useRef(connect);
  connectRef.current = connect;

  const handleToolCallRef = useRef(handleToolCall);
  handleToolCallRef.current = handleToolCall;

  const coachSpeech = useCallback(
    (event: RealtimeSpeechEvent) => {
      touchIdle();
      if (!isMounted()) return;
      setIsCoachSpeaking(!event.done);
    },
    [isMounted, touchIdle],
  );
  const coachSpeechRef = useRef(coachSpeech);
  coachSpeechRef.current = coachSpeech;

  const learnerSpeech = useCallback(
    (event: RealtimeSpeechEvent) => {
      touchIdle();

      // THE ONE THING THIS EVENT IS NOW READ FOR (#399): whether there was any
      // learner speech at all this turn. Not its words, not their meaning —
      // only that the microphone produced some. Deltas count as much as the
      // final event: a learner who was cut off mid-answer still spoke.
      //
      // BEFORE THE MOUNT CHECK, on purpose. The flags are what the next
      // `grade_answer` is measured against, and a hook whose component has
      // unmounted still owns a live connection until its teardown runs — an
      // utterance dropped here would become an answer that could not be
      // accounted for.
      if (event.text.trim() !== '') {
        transcriptionSeenRef.current = true;
        heardThisTurnRef.current = true;
      }

      if (!isMounted()) return;
      // DISPLAY. What reaches the engine is still the transcript the MODEL
      // reports on its own `grade_answer` call — this is never sent anywhere
      // and is never compared to an answer.
      if (event.done) setHeard(event.text || null);
    },
    [isMounted, touchIdle],
  );
  const learnerSpeechRef = useRef(learnerSpeech);
  learnerSpeechRef.current = learnerSpeech;

  /**
   * The provider reported an error (#385).
   *
   * TWO AUDIENCES, TWO RENDERINGS, AND NEITHER IS A TEARDOWN. The console line
   * carries the provider's own code and prose, which is what a developer needs
   * and what a learner cannot use; the notice is this hook's own sentence,
   * which is what a learner needs. The session is left running because most of
   * these end a single turn — falling back here would close a live, working
   * connection over a hiccup the next question would not have noticed.
   *
   * AND IT IS NO LONGER PERMANENT (#399). Because most of these end one turn,
   * the notice this sets is cleared by the next honoured tool result in
   * `relay` — the session saying, in the only way it can, that the turn it
   * described is over.
   */
  const providerError = useCallback(
    (error: RealtimeProviderError) => {
      console.warn(
        '[realtime practice] the provider reported an error',
        error.code,
        error.message,
      );
      if (!isMounted()) return;
      setNotice({
        message: REALTIME_PRACTICE_PROVIDER_ERROR_LINE,
        spoken: false,
      });
    },
    [isMounted],
  );
  const providerErrorRef = useRef(providerError);
  providerErrorRef.current = providerError;

  const closed = useCallback(
    (reason: 'closed' | 'dropped') => {
      connectionRef.current = null;
      // THE MICROPHONE GOES BACK IMMEDIATELY, on a drop as much as on a close.
      // `openRealtimeConnection`'s teardown has already stopped the tracks, and
      // handing the page's capture hook a dead stream is how a later Start
      // reports a device problem that is not there.
      releaseMicrophone();

      // A deliberate close is this hook's own teardown; it has already said
      // whatever there was to say.
      if (reason === 'closed') return;

      if (reconnectsRef.current < MAX_RECONNECTS) {
        // §10's bounded re-mint. The session resumes at whatever question the
        // engine's own state says is outstanding, because that state is
        // server-side and was never held in the connection that just died.
        reconnectsRef.current += 1;
        void connectRef.current(true);
        return;
      }

      fallBack(CONNECTION_LOST);
    },
    [fallBack, releaseMicrophone],
  );
  const closedRef = useRef(closed);
  closedRef.current = closed;

  // ---------------------------------------------------------------------------
  // Session bounds
  // ---------------------------------------------------------------------------

  /**
   * A hidden tab closes the connection — §10's second condition.
   *
   * CLOSE, NOT PAUSE. A backgrounded tab still holding a realtime connection is
   * still accruing audio-duration cost with no learner present, and
   * `conversation-mode.md` §8 already names the platform reality that makes
   * "pause" an illusion on mobile: a locked screen suspends timers and audio
   * alike. Closing outright is the honest response to a suspension the
   * application cannot prevent.
   *
   * NOT SPOKEN: nobody is listening to a tab they have left, and a mobile
   * browser will not play it anyway.
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') return;
      if (!connectionRef.current) return;
      endSession(REALTIME_PRACTICE_HIDDEN_LINE, false);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [endSession]);

  // ---------------------------------------------------------------------------
  // What the page calls
  // ---------------------------------------------------------------------------

  const start = useCallback(() => {
    reconnectsRef.current = 0;
    void connect(false);
  }, [connect]);

  const stop = useCallback(() => {
    teardown();
    wasLiveRef.current = false;
    if (!isMounted()) return;
    setRemoteStream(null);
    setIsCoachSpeaking(false);
    setStage('ended');
  }, [isMounted, teardown]);

  const retry = useCallback(() => {
    reconnectsRef.current = 0;
    setFallback(null);
    setNotice(null);
    void connect(false);
  }, [connect]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    stage,
    startedAt,
    fallback,
    notice,
    questionId,
    isCoachSpeaking,
    heard,
    remoteStream,
    start,
    stop,
    retry,
    dismissNotice,
  };
}

export default useRealtimePractice;

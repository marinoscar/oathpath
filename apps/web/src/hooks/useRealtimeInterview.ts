/**
 * One realtime (spoken) mock interview, as React state — issue #159,
 * epic #60 / E11.
 *
 * The single owner of everything the realtime screen renders, and the only
 * place the relay loop lives. `RealtimeInterviewPage` reads; it never grades,
 * never counts, never chooses a question, and never decides a phase is over.
 *
 * Shaped after `useMockInterview` (#140) — the same `isMounted` discipline, the
 * same "an error is a string the page renders, never a thrown exception"
 * contract, the same server-is-the-truth posture — over a transport that stays
 * open instead of one request per turn.
 *
 * =============================================================================
 * THE BROWSER IS A RELAY. IT DECIDES NOTHING.
 * =============================================================================
 *
 * `docs/specs/realtime-interview.md` §4, and issue #155's statement of the risk
 * the whole epic is organised around: "a speech-to-speech model asked to
 * conduct a civics interview will happily invent a civics question from memory
 * and declare an answer correct."
 *
 * Three tools arrive over the data channel. Each one is posted, unexamined, to
 * `POST /api/interviews/:id/realtime/tool-calls`, and whatever comes back is
 * handed to the model VERBATIM. Nothing in this file reads a `civics_questions`
 * row, compares an answer to anything, counts a correct answer, or looks at a
 * pass mark — there is no such value here to look at.
 *
 * A REFUSAL IS A NORMAL RESULT, NOT AN ERROR. The route answers a rejected
 * tool call with HTTP 200 and an `instruction` field, and relaying that
 * instruction is what gets the interview moving again. Treating it as a
 * failure would leave the officer holding a tool call that never resolves —
 * a live conversation that has silently stopped, with nothing on screen to say
 * so, which is the worst failure mode this screen has.
 *
 * =============================================================================
 * THE WRITING SENTENCE NEVER REACHES THE DOM. TWICE OVER.
 * =============================================================================
 *
 * `english-test.md` §4: the writing test is a DICTATION, so a screen that
 * printed the sentence would not be showing the learner the question — it would
 * be showing them the answer. On this transport the sentence necessarily passes
 * THROUGH the browser (it is the relay between the engine and the model), so
 * the rule is a DOM invariant enforced here, exactly as `CLAUDE.md` already
 * states it for the request/response transport.
 *
 * Two separate leaks are closed, and they are separate:
 *
 *  1. **The tool result.** `next_question` returns `speakOnly: true` for a
 *     writing sentence. {@link toTranscriptEntry} stores `text: null` for such
 *     a turn — the raw string goes to `connection.sendToolResult` and nowhere
 *     else, and there is no branch in this file that puts a `speakOnly` result's
 *     `text` into state.
 *  2. **The officer's own spoken transcript.** The provider transcribes the
 *     officer's audio, and that audio IS the dictated sentence. A live
 *     transcript that rendered it would leak the sentence by the back door
 *     while the tool result was being scrupulously withheld at the front.
 *     {@link UseRealtimeInterviewReturn.transcript} therefore withholds every
 *     officer utterance for as long as a `speakOnly` item is outstanding.
 *
 * A test asserts the sentence appears nowhere in `document.body`.
 *
 * =============================================================================
 * EVERY FAILURE ENDS AT THE TEXT INTERVIEW, WITH THE SAME INTERVIEW ID
 * =============================================================================
 *
 * §12's third locked decision: "The text interview never goes away." An unbound
 * `realtime` role, a refused microphone, a handshake that never completes and a
 * secret that expires mid-conversation all resolve to the same place, because
 * the engine's state — which question is next, how many have been asked, whether
 * the stop rule has fired — is server-side and untouched by which transport is
 * driving it. Falling back is a TRANSPORT CHANGE, not a restart, and nothing a
 * learner has already answered is asked again.
 *
 * A dropped connection is re-minted first, up to {@link MAX_RECONNECTS} times
 * (§3): the secret is short-lived by design, and a fresh mint resolves the
 * interview's CURRENT engine state, so the officer resumes at whatever question
 * comes next rather than at the first one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  completeInterview,
  createRealtimeSession,
  getInterview,
  sendRealtimeToolCall,
} from '../services/api';
import {
  isRealtimeToolName,
  openRealtimeConnection,
  type RealtimeConnection,
  type RealtimeSpeechEvent,
  type RealtimeToolCallEvent,
} from '../services/realtimeConnection';
import {
  classifyGetUserMediaError,
  describeCaptureProblem,
  type AudioCaptureProblem,
} from './useAudioCapture';
import { useIsMounted } from './useIsMounted';
import type {
  AiUnavailableCause,
  Interview,
  InterviewDebrief,
  InterviewPhase,
  InterviewProgress,
  RealtimeToolCallInput,
  RealtimeToolCallResponse,
} from '../types';

/**
 * How many times a dropped connection is re-minted before falling back.
 *
 * BOUNDED, and the bound is small on purpose. Each attempt is a mint on the
 * learner's own key and a handshake they are sitting in silence through; a
 * loop that kept trying would spend their money to keep them waiting, and §7
 * says a failed connection "falls back to text after a bounded number of retry
 * attempts" rather than persisting.
 */
export const MAX_RECONNECTS = 2;

/** Why the spoken interview cannot continue. A closed set, each with a remedy. */
export type RealtimeFallbackCode =
  /** No mint was attempted: `realtime` unbound, AI off, or no key stored. */
  | 'ai_unavailable'
  /** There is no live microphone, so no mint was attempted either (§7). */
  | 'microphone'
  /** The mint was attempted and did not produce a usable session. */
  | 'mint_failed'
  /** The handshake never completed. */
  | 'connection_failed'
  /** It dropped mid-interview and could not be re-established. */
  | 'connection_lost';

export interface RealtimeFallback {
  code: RealtimeFallbackCode;
  /** What happened, one sentence, in the learner's terms. Never generic. */
  message: string;
  /** What they can do about it, or null when there is genuinely nothing. */
  remedy: string | null;
  /**
   * Set only for `ai_unavailable` — WHICH of the four causes.
   *
   * `no_user_key` is the learner's own to fix and gets its own copy; the other
   * three are an administrator's, and the screen renders the shared
   * `AiNotReady` naming the `realtime` role for those. Collapsing them would
   * tell somebody with no key stored that their administrator has not finished
   * setting something up.
   */
  cause: AiUnavailableCause | null;
  /** Whether pressing "try again" could plausibly help. */
  retryable: boolean;
}

/**
 * One line of the live conversation.
 *
 * `text: null` is NOT "they said nothing" — it is WITHHELD, and the only thing
 * that is ever withheld is the writing test's dictated sentence. See the file
 * header. A renderer must say what is happening rather than render an empty
 * bubble.
 */
export interface RealtimeTranscriptEntry {
  id: string;
  role: 'officer' | 'applicant';
  phase: InterviewPhase;
  /** What was said, or `null` when it must not be shown. */
  text: string | null;
  /** True once this utterance is finished. Drives `aria-busy`. */
  final: boolean;
}

/** What the officer is currently waiting on, when it is the learner's typing. */
export interface RealtimeWritingPrompt {
  /** The `english_sentences` id a `grade_answer` must name. */
  itemId: string;
}

/** Where the spoken interview has got to. */
export type RealtimeStage =
  /** Nothing has been attempted yet. */
  | 'idle'
  /** Microphone, mint, handshake — in that order. */
  | 'connecting'
  /** The conversation is live. */
  | 'live'
  /** It cannot continue by voice. See {@link UseRealtimeInterviewReturn.fallback}. */
  | 'fallback'
  /** The learner ended it, or the officer finished. */
  | 'ended';

export interface UseRealtimeInterviewReturn {
  interview: Interview | null;
  isLoading: boolean;
  loadError: string | null;

  stage: RealtimeStage;
  /** Set exactly when `stage === 'fallback'`. */
  fallback: RealtimeFallback | null;

  transcript: RealtimeTranscriptEntry[];
  /** True while the officer's words are still arriving. */
  isOfficerSpeaking: boolean;

  phase: InterviewPhase | null;
  progress: InterviewProgress | null;
  awaitingCompletion: boolean;

  /**
   * Set while the writing test is waiting on typing, and `null` otherwise.
   *
   * The sentence itself is NOT on this shape and never will be — see the file
   * header. All a screen needs to render the dictation is that one is
   * outstanding.
   */
  writingPrompt: RealtimeWritingPrompt | null;

  /** The officer's voice. Attach it to an audio element. */
  remoteStream: MediaStream | null;

  /** Begin: microphone, then mint, then handshake. Never throws. */
  start: () => void;
  /** Try the whole of `start` again after a retryable fallback. */
  retry: () => void;

  /** Send the learner's typed answer to the writing test. Never throws. */
  submitWriting: (text: string) => void;
  isSubmittingWriting: boolean;

  isCompleting: boolean;
  completeError: string | null;
  /**
   * End the session and finish the interview.
   *
   * Closes the connection and stops every media track BEFORE the request, then
   * completes. Resolves to the debrief, or null when the call failed.
   */
  end: () => Promise<InterviewDebrief | null>;
}

export function useRealtimeInterview(
  id: string | null | undefined,
): UseRealtimeInterviewReturn {
  const [interview, setInterview] = useState<Interview | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(id));
  const [loadError, setLoadError] = useState<string | null>(null);

  const [stage, setStage] = useState<RealtimeStage>('idle');
  const [fallback, setFallback] = useState<RealtimeFallback | null>(null);

  const [transcript, setTranscript] = useState<RealtimeTranscriptEntry[]>([]);
  const [isOfficerSpeaking, setIsOfficerSpeaking] = useState(false);

  const [phase, setPhase] = useState<InterviewPhase | null>(null);
  const [progress, setProgress] = useState<InterviewProgress | null>(null);
  const [awaitingCompletion, setAwaitingCompletion] = useState(false);
  const [writingPrompt, setWritingPrompt] =
    useState<RealtimeWritingPrompt | null>(null);
  const [isSubmittingWriting, setIsSubmittingWriting] = useState(false);

  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const [isCompleting, setIsCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  const connectionRef = useRef<RealtimeConnection | null>(null);
  const startingRef = useRef(false);
  const reconnectsRef = useRef(0);

  /**
   * The officer's next line, held across a reconnect.
   *
   * On the FIRST connection this is the opening turn, which
   * `POST /api/interviews` already returned and which the tool-call route
   * therefore never serves — #158 flagged this explicitly, and without it the
   * interview opens in silence while the model waits for a `next_question`
   * result the engine has no reason to produce.
   *
   * On a RECONNECT it is whatever the officer last said, so the resumed session
   * repeats the outstanding question instead of starting the conversation over.
   * That includes a writing sentence, which is the one line the browser cannot
   * re-read from the transcript route — the API deliberately never stores it
   * (`interviews.service.ts`: "the writing sentence is never written into the
   * transcript"), so holding it here is what makes a resumed dictation possible
   * at all.
   */
  const pendingLineRef = useRef<string | null>(null);

  /**
   * True while an officer utterance must not be rendered.
   *
   * Set by a `speakOnly` tool result and cleared when that item is graded. The
   * officer's spoken audio during a dictation IS the sentence, so a live
   * transcript without this flag would print the answer the tool result was so
   * carefully withholding. See the file header.
   */
  const withholdOfficerRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Reading the interview
  // ---------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    if (!id) {
      if (isMounted()) {
        setInterview(null);
        setIsLoading(false);
        setLoadError('That interview could not be found.');
      }
      return;
    }

    setIsLoading(true);
    setLoadError(null);
    try {
      const detail = await getInterview(id);
      if (!isMounted()) return;

      setInterview(detail.interview);
      setProgress(detail.progress);
      setAwaitingCompletion(detail.awaitingCompletion);
      setPhase(detail.turns[detail.turns.length - 1]?.phase ?? 'smalltalk');

      // The opening line — or, resuming an interview that was being conducted
      // in text a moment ago, the outstanding question. Either way it is the
      // officer's own last words, read from the server rather than remembered.
      const lastOfficer = [...detail.turns]
        .reverse()
        .find((turn) => turn.role === 'officer');
      pendingLineRef.current = lastOfficer?.text ?? null;
    } catch (err) {
      if (isMounted()) {
        setInterview(null);
        setLoadError(
          err instanceof Error
            ? err.message
            : 'That interview could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [id, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---------------------------------------------------------------------------
  // The relay
  // ---------------------------------------------------------------------------

  /** Apply the "where is the interview now" fields every honoured result carries. */
  const applyTurnStatus = useCallback((result: RealtimeToolCallResponse) => {
    if (result.status !== 'ok') return;
    if (result.tool === 'end_phase') {
      setPhase(result.nextPhase);
      setAwaitingCompletion(result.awaitingCompletion);
      return;
    }
    setPhase(result.phase);
    setProgress(result.progress);
    setAwaitingCompletion(result.awaitingCompletion);
  }, []);

  /**
   * Post one tool call and hand the answer back to the model.
   *
   * `callId` is `null` for a call this SCREEN originated rather than the model
   * — the typed writing answer, which the model never heard and so could never
   * have reported. There is no tool result to return in that case; the officer
   * is told to speak the acknowledgement instead, which is also what prompts it
   * to ask for the next question.
   */
  const relay = useCallback(
    async (
      call: RealtimeToolCallInput,
      callId: string | null,
    ): Promise<RealtimeToolCallResponse | null> => {
      if (!id) return null;

      let result: RealtimeToolCallResponse;
      try {
        result = await sendRealtimeToolCall(id, call);
      } catch (err) {
        // A transport failure on the RELAY, not on the interview. The model is
        // still waiting on a tool result, and leaving it waiting is how a live
        // conversation goes silent — so it is told, in the same shape a
        // server-side refusal takes, to carry on.
        if (callId !== null) {
          connectionRef.current?.sendToolResult(callId, {
            tool: call.tool,
            status: 'rejected',
            reason: 'relay_failed',
            error:
              err instanceof Error
                ? err.message
                : 'That could not be sent to the application.',
            instruction: 'call next_question and continue the interview',
          });
        }
        return null;
      }

      // VERBATIM, INCLUDING A REJECTION. The `instruction` on a refused call is
      // the field that gets the interview moving again (§4.2).
      if (callId !== null) connectionRef.current?.sendToolResult(callId, result);

      if (!isMounted()) return result;

      applyTurnStatus(result);

      if (result.status === 'ok' && result.tool === 'next_question') {
        // Held for a reconnect, and — for a dictation — this is the ONLY copy.
        pendingLineRef.current = result.text;
        withholdOfficerRef.current = result.speakOnly;

        setTranscript((current) => [
          ...current,
          toTranscriptEntry(result, current.length),
        ]);

        setWritingPrompt(
          result.speakOnly && result.itemId
            ? { itemId: result.itemId }
            : null,
        );
      }

      if (result.status === 'ok' && result.tool === 'grade_answer') {
        // The item is answered, so the officer's words are renderable again.
        // `recorded` is deliberately not surfaced: it is a statement about the
        // RECORD (a reading transcript the recogniser did not trust writes no
        // row and the officer asks again), never about whether the learner was
        // right, and this screen shows no verdict of any kind before the
        // debrief.
        withholdOfficerRef.current = false;
        setWritingPrompt(null);
      }

      return result;
    },
    [applyTurnStatus, id, isMounted],
  );

  /** Turn one tool call from the model into an HTTP relay. */
  const handleToolCall = useCallback(
    (event: RealtimeToolCallEvent) => {
      if (!isRealtimeToolName(event.name)) {
        // A tool nobody declared. Refused here rather than posted and refused
        // as a 400 — same outcome for the model, one fewer round trip, and no
        // unexplained validation error in the API's logs.
        connectionRef.current?.sendToolResult(event.callId, {
          tool: event.name,
          status: 'rejected',
          reason: 'unknown_tool',
          error: `${event.name} is not a tool in this interview.`,
          instruction: 'call next_question and continue the interview',
        });
        return;
      }

      const call = toToolCallInput(event);
      if (!call) {
        connectionRef.current?.sendToolResult(event.callId, {
          tool: event.name,
          status: 'rejected',
          reason: 'malformed_arguments',
          error: 'Those arguments were not the ones that tool takes.',
          instruction: 'call next_question and continue the interview',
        });
        return;
      }

      void relay(call, event.callId);
    },
    [relay],
  );

  // ---------------------------------------------------------------------------
  // Connecting
  // ---------------------------------------------------------------------------

  /** Stop the connection and every track it holds. Idempotent. */
  const teardown = useCallback(() => {
    const connection = connectionRef.current;
    connectionRef.current = null;
    connection?.close();
  }, []);

  // Unmount ends the session. A learner who navigates away must not leave a
  // live microphone — and its indicator light — behind them.
  useEffect(() => teardown, [teardown]);

  const fallBack = useCallback(
    (next: RealtimeFallback) => {
      teardown();
      if (!isMounted()) return;
      setRemoteStream(null);
      setIsOfficerSpeaking(false);
      setFallback(next);
      setStage('fallback');
    },
    [isMounted, teardown],
  );

  /**
   * The whole start sequence: microphone, then mint, then handshake.
   *
   * THE ORDER IS THE POINT. §7: "the browser's own permission denial is caught
   * before a realtime-session mint is even attempted (no
   * `POST /api/interviews/:id/realtime-session` call is made without a live
   * audio input)". A mint on a learner's own key, for a session they have no
   * microphone to speak into, spends their money on nothing.
   */
  const connect = useCallback(
    async (isReconnect: boolean) => {
      if (!id || startingRef.current) return;
      startingRef.current = true;

      if (isMounted()) {
        setStage('connecting');
        setFallback(null);
      }

      // ---- 1. The microphone ------------------------------------------------
      //
      // The six named problems and their six remedies come from
      // `useAudioCapture` (#99) rather than being re-derived here: a denied
      // permission, a dismissed prompt, no device, a device another app holds,
      // an insecure origin and a browser that cannot capture are six different
      // errands, and "microphone unavailable" sends a learner whose headset is
      // simply unplugged to change a permission that was never the problem.
      let stream: MediaStream;
      try {
        stream = await requestMicrophone();
      } catch (error) {
        startingRef.current = false;
        const problem = toCaptureProblem(error);
        fallBack({
          code: 'microphone',
          message: problem.message,
          remedy: problem.remedy,
          cause: null,
          retryable: problem.code !== 'insecure_origin' && problem.code !== 'unsupported',
        });
        return;
      }

      // ---- 2. The mint ------------------------------------------------------
      try {
        const session = await createRealtimeSession(id);

        if (session.status === 'unavailable') {
          // NOT AN ERROR. Nothing was spent and nothing is broken — this is a
          // deployment where the voice interview is not configured, or a
          // learner who has not stored a key. Either way the answer is the text
          // interview (§7).
          stopStream(stream);
          startingRef.current = false;
          fallBack({
            code: 'ai_unavailable',
            message:
              session.cause === 'no_user_key'
                ? 'A spoken interview runs on your own AI key, and there isn’t one saved on your account yet.'
                : 'Spoken interviews are not set up on this installation.',
            remedy: null,
            cause: session.cause,
            retryable: false,
          });
          return;
        }

        if (session.status === 'failed') {
          stopStream(stream);
          startingRef.current = false;
          fallBack({
            code: 'mint_failed',
            // The API's own message, already redacted — never a key, never the
            // secret this route mints.
            message: session.error || 'The voice session could not be started.',
            remedy: 'Trying again often works. The interview itself is unaffected.',
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
            onOfficerSpeech: (event) => officerSpeechRef.current(event),
            onApplicantSpeech: (event) => applicantSpeechRef.current(event),
            onRemoteStream: (remote) => {
              if (isMounted()) setRemoteStream(remote);
            },
            onClosed: (reason) => closedRef.current(reason),
          },
        });

        connectionRef.current = connection;
        startingRef.current = false;

        if (!isMounted()) {
          // Unmounted during the handshake. Close what we just opened rather
          // than leaving a live microphone attached to a page nobody is on.
          connection.close();
          return;
        }

        setStage('live');

        // THE OPENING TURN, WHICH THE TOOL-CALL ROUTE NEVER SERVES. See
        // `pendingLineRef`.
        const line = pendingLineRef.current;
        if (line) connection.speakVerbatim(line);
      } catch (error) {
        stopStream(stream);
        startingRef.current = false;
        fallBack({
          code: isReconnect ? 'connection_lost' : 'connection_failed',
          message:
            error instanceof Error
              ? error.message
              : 'The voice connection could not be opened.',
          remedy:
            'You can carry on in text — nothing you have already answered is lost.',
          cause: null,
          retryable: !isReconnect,
        });
      }
    },
    [fallBack, id, isMounted],
  );

  // ---------------------------------------------------------------------------
  // Handlers, held in refs
  // ---------------------------------------------------------------------------
  //
  // `openRealtimeConnection` captures its handlers once, at handshake time, and
  // the connection outlives many renders. Passing the callbacks directly would
  // freeze the first render's closures — a transcript that stops growing after
  // the first officer turn, and a tool call relayed against a stale interview
  // id. The refs are re-pointed on every render so the connection always calls
  // the current one.

  const handleToolCallRef = useRef(handleToolCall);
  handleToolCallRef.current = handleToolCall;

  const officerSpeech = useCallback((event: RealtimeSpeechEvent) => {
    if (!isMounted()) return;
    setIsOfficerSpeaking(!event.done);
    // WITHHELD DURING A DICTATION — the officer's audio at that moment IS the
    // sentence. See the file header.
    appendSpeech(setTranscript, 'officer', event, withholdOfficerRef.current);
  }, [isMounted]);
  const officerSpeechRef = useRef(officerSpeech);
  officerSpeechRef.current = officerSpeech;

  const applicantSpeech = useCallback((event: RealtimeSpeechEvent) => {
    if (!isMounted()) return;
    appendSpeech(setTranscript, 'applicant', event, false);
  }, [isMounted]);
  const applicantSpeechRef = useRef(applicantSpeech);
  applicantSpeechRef.current = applicantSpeech;

  const closed = useCallback(
    (reason: 'closed' | 'dropped') => {
      connectionRef.current = null;
      if (!isMounted()) return;
      setRemoteStream(null);
      setIsOfficerSpeaking(false);

      // A deliberate close is the learner ending the interview; the page is
      // already navigating and has nothing to recover from.
      if (reason === 'closed') return;

      if (reconnectsRef.current < MAX_RECONNECTS) {
        // §3: re-mint while `in_progress`. The interview resumes at whatever
        // question the engine's own state says comes next, because that state
        // is server-side and was never held in the connection that just died.
        reconnectsRef.current += 1;
        void connect(true);
        return;
      }

      fallBack({
        code: 'connection_lost',
        message: 'The voice connection dropped and could not be re-established.',
        remedy:
          'You can carry on in text — the interview picks up exactly where it left off.',
        cause: null,
        retryable: false,
      });
    },
    [connect, fallBack, isMounted],
  );
  const closedRef = useRef(closed);
  closedRef.current = closed;

  // ---------------------------------------------------------------------------
  // What the page calls
  // ---------------------------------------------------------------------------

  const start = useCallback(() => {
    reconnectsRef.current = 0;
    void connect(false);
  }, [connect]);

  const retry = useCallback(() => {
    reconnectsRef.current = 0;
    setFallback(null);
    void connect(false);
  }, [connect]);

  const submitWriting = useCallback(
    (text: string) => {
      const prompt = writingPrompt;
      if (!prompt || isSubmittingWriting) return;

      setIsSubmittingWriting(true);
      void relay(
        {
          tool: 'grade_answer',
          questionId: prompt.itemId,
          // WHAT THEY TYPED, VERBATIM. No trimming of "extra" words, no
          // spell-check, no normalisation: the scorer is server-side and it is
          // the one place a writing attempt is judged.
          transcript: text,
          // NO `confidence`. Nothing was recognised — they typed it — and a
          // number here would be this screen inventing a fact about audio that
          // does not exist. Absent means unknown, which is the truth.
        },
        null,
      )
        .then((result) => {
          if (!isMounted()) return;
          setIsSubmittingWriting(false);
          // The officer never heard this answer, so it is told the interview
          // moved. Speaking the acknowledgement is also what prompts it to ask
          // for the next question.
          if (result?.status === 'ok' && result.tool === 'grade_answer') {
            connectionRef.current?.speakVerbatim(result.ack);
          }
        })
        .catch(() => {
          if (isMounted()) setIsSubmittingWriting(false);
        });
    },
    [isMounted, isSubmittingWriting, relay, writingPrompt],
  );

  const end = useCallback(async (): Promise<InterviewDebrief | null> => {
    if (!id) return null;

    // BEFORE the request, always. The learner has said they are done, and a
    // microphone that is still live — with its indicator light still on — while
    // a completion request is in flight is this application listening to
    // somebody who has just told it to stop.
    teardown();
    if (isMounted()) {
      setStage('ended');
      setRemoteStream(null);
      setIsOfficerSpeaking(false);
    }

    setIsCompleting(true);
    setCompleteError(null);
    try {
      const debrief = await completeInterview(id);
      if (isMounted()) setIsCompleting(false);
      return debrief;
    } catch (err) {
      if (isMounted()) {
        setCompleteError(
          err instanceof Error
            ? err.message
            : 'This interview could not be finished.',
        );
        setIsCompleting(false);
      }
      return null;
    }
  }, [id, isMounted, teardown]);

  return {
    interview,
    isLoading,
    loadError,

    stage,
    fallback,

    transcript,
    isOfficerSpeaking,

    phase,
    progress,
    awaitingCompletion,
    writingPrompt,
    remoteStream,

    start,
    retry,

    submitWriting,
    isSubmittingWriting,

    isCompleting,
    completeError,
    end,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Ask for the microphone, with `useAudioCapture`'s own preflight order.
 *
 * `insecure_origin` IS CHECKED FIRST because a browser on an insecure origin
 * does not merely refuse capture — it deletes `navigator.mediaDevices`
 * entirely, so checking support first reports `unsupported` on a perfectly
 * capable browser and sends the learner off to install a different one when the
 * actual fix is the address bar. That reasoning is `useAudioCapture`'s; it is
 * repeated in one sentence here because the order looks arbitrary otherwise.
 *
 * NO `MediaRecorder` CHECK, unlike push-to-talk: a realtime session streams its
 * audio over WebRTC and never records a blob, so a browser with `getUserMedia`
 * and no recorder can hold a perfectly good spoken interview.
 */
async function requestMicrophone(): Promise<MediaStream> {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    throw new DOMException('Insecure origin', 'SecurityError');
  }

  const mediaDevices =
    typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  if (!mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
    throw new DOMException('Unsupported', 'NotSupportedError');
  }

  return mediaDevices.getUserMedia({ audio: true });
}

/** One `getUserMedia` rejection, as one of `useAudioCapture`'s six problems. */
function toCaptureProblem(error: unknown): AudioCaptureProblem {
  return describeCaptureProblem(classifyGetUserMediaError(error));
}

/** Stop every track on a stream. Safe on a stream that has none. */
function stopStream(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

/**
 * Turn one honoured `next_question` result into a transcript entry.
 *
 * THE ONE BRANCH THAT DECIDES WHETHER THE WRITING SENTENCE REACHES THE DOM.
 * `speakOnly` means the string is the dictated sentence, so the entry carries
 * `null` and the raw text goes only to the data channel. Exported for the test
 * that asserts exactly that.
 */
export function toTranscriptEntry(
  result: Extract<
    RealtimeToolCallResponse,
    { tool: 'next_question'; status: 'ok' }
  >,
  index: number,
): RealtimeTranscriptEntry {
  return {
    id: `officer-turn-${result.turnIndex}-${index}`,
    role: 'officer',
    phase: result.phase,
    text: result.speakOnly ? null : result.text,
    final: true,
  };
}

/**
 * Fold one speech event into the transcript.
 *
 * Deltas accumulate onto the entry with the same provider item id, so an
 * utterance grows in place rather than arriving as one line per fragment — the
 * difference between a readable transcript and a column of half-words. A
 * `done` event REPLACES the accumulated text with the provider's own final
 * version, which is the one that has had its punctuation settled.
 */
function appendSpeech(
  setTranscript: React.Dispatch<
    React.SetStateAction<RealtimeTranscriptEntry[]>
  >,
  role: 'officer' | 'applicant',
  event: RealtimeSpeechEvent,
  withhold: boolean,
) {
  const key = `${role}-${event.itemId || 'live'}`;

  setTranscript((current) => {
    const index = current.findIndex((entry) => entry.id === key);
    const phase = current[current.length - 1]?.phase ?? 'smalltalk';

    if (index === -1) {
      if (!event.text && !withhold) return current;
      return [
        ...current,
        {
          id: key,
          role,
          phase,
          text: withhold ? null : event.text,
          final: event.done,
        },
      ];
    }

    const existing = current[index];
    const next: RealtimeTranscriptEntry = {
      ...existing,
      // Once withheld, always withheld for this utterance: a `done` event
      // carrying the whole dictated sentence must not undo a delta's
      // suppression.
      text: withhold || existing.text === null
        ? null
        : event.done
          ? event.text || existing.text
          : existing.text + event.text,
      final: event.done,
    };

    const updated = [...current];
    updated[index] = next;
    return updated;
  });
}

/**
 * Narrow one tool call's arguments to the shape its tool declares, or `null`.
 *
 * NOT A CAST. `grade_answer` without a `questionId` and `end_phase` without a
 * `phase` are calls the API would refuse as a 400, and a 400 reaches the model
 * as a generic failure rather than as the instruction that would get the
 * interview moving again. Refusing here produces the same refusal shape the
 * server produces, one round trip sooner.
 *
 * NOTHING IS INVENTED. A missing `confidence` stays missing — absent means
 * unknown, and a default would make every answer on a provider that reports
 * none read as misheard.
 */
export function toToolCallInput(
  event: RealtimeToolCallEvent,
): RealtimeToolCallInput | null {
  const { args } = event;

  if (event.name === 'next_question') return { tool: 'next_question' };

  if (event.name === 'grade_answer') {
    const questionId = args.questionId;
    const transcript = args.transcript;
    if (typeof questionId !== 'string' || typeof transcript !== 'string') {
      return null;
    }
    return {
      tool: 'grade_answer',
      questionId,
      transcript,
      confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
    };
  }

  if (event.name === 'end_phase') {
    const phase = args.phase;
    if (typeof phase !== 'string') return null;
    return { tool: 'end_phase', phase: phase as InterviewPhase };
  }

  return null;
}

export default useRealtimeInterview;

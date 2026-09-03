/**
 * One mock interview, as React state — issue #140, epic #57 / E8.
 *
 * The single owner of everything the interview screen renders: the officer's
 * transcript, the phase, the civics progress, whether the interview is now
 * waiting to be completed, and where the current turn's stream has got to.
 * `InterviewPage` reads; it never counts, never grades, and never decides which
 * question comes next.
 *
 * Shaped after `useExplanation` (#125) — the same `isMounted` discipline, the
 * same "an error is a string the page renders, never a thrown exception"
 * contract — over `usePracticeSession`'s resume-from-the-server posture.
 *
 * =============================================================================
 * ABORT IS THE FEATURE, NOT THE CLEANUP
 * =============================================================================
 *
 * The officer's phrasing is generated on the LEARNER'S OWN API KEY, exactly as
 * an explanation is (`ai-evaluation.md` §11 — the per-user AI routes exist
 * because each person pays for their own calls). A stream nobody is reading is
 * a charge on somebody's card for words that will never be seen.
 *
 * So the signal is threaded all the way down — through `streamInterviewTurn`,
 * through `streamSseRequest`, into `fetch` — and it is fired from three places,
 * all of which are real:
 *
 *   1. **Unmount.** The learner navigated away mid-turn.
 *   2. **A second `submitTurn`.** The later answer supersedes the earlier one;
 *      leaving both running would bill twice and race two writers into one
 *      officer turn. (`InterviewPage` disables the answer box while a turn is
 *      streaming, so in practice this is the belt to that braces.)
 *   3. **`complete()`.** Ending the interview stops generating words for a
 *      conversation that is over — and the end control is reachable in every
 *      phase, INCLUDING mid-stream, which is precisely when this matters.
 *
 * The server honours it: the turn endpoint aborts its upstream provider call on
 * disconnect. That only works if this end actually closes the socket, which is
 * why there is no way to start a turn here without a controller attached to it.
 *
 * =============================================================================
 * A TURN THAT WAS TAKEN IS NEVER DROPPED, WHICHEVER TERMINAL FRAME ARRIVES
 * =============================================================================
 *
 * `done`, `unavailable` and `error` all carry the same outcome, because the
 * interview advanced in all three cases — same next question, same grading,
 * same stop rule; only the officer's wording differs (`mock-interview.md`
 * §5.2). So {@link applyOutcome} runs for all three, and only the STATUS
 * differs afterwards. `unavailable` in particular is NOT an error and must not
 * be rendered as one: nothing is broken, nothing was spent, and the officer's
 * line is a fixed, code-owned neutral sentence the server already returned.
 *
 * When a terminal frame's outcome cannot be trusted (a truncated payload), or
 * when the body closes with no terminal frame at all, the recovery is to
 * RE-READ `GET /api/interviews/:id` rather than to show an error: the turn was
 * persisted before a single byte went on the wire, so the server is the one
 * place that certainly knows what happened. That is the same reason
 * `usePracticeSession` refuses to carry session state through navigation — a
 * reload, a second tab and a dropped connection all resume from the same place.
 *
 * =============================================================================
 * THE OFFICER'S TRANSCRIPT ONLY — NOT THE APPLICANT'S
 * =============================================================================
 *
 * {@link UseMockInterviewReturn.officerTurns} filters the transcript to
 * `role: 'officer'`, and that is a retention decision rather than a layout one.
 * With `transcriptRetained: false` — the default — an applicant turn is
 * persisted with `text: ''` deliberately (§8.2), so a screen that rendered
 * applicant turns would show a learner an empty bubble under their own answer
 * and tell them, wordlessly and falsely, that they said nothing. The API's own
 * DTO warns about exactly that misreading. Not rendering them at all is the
 * only version of this screen where the misreading cannot occur.
 *
 * =============================================================================
 * NOTHING HERE HOLDS A VERDICT, BECAUSE NOTHING SENDS ONE
 * =============================================================================
 *
 * There is no `correct`, no `outcome`, no score and no per-answer feedback on
 * any state in this file, and there is nowhere for one to arrive from: §10 —
 * the engine knew whether each answer was right the instant it graded it,
 * recorded it, used it to choose the next question and to run the stop rule,
 * and deliberately does not send it. `completeInterview` is the first moment
 * any of it exists where the learner can see it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { completeInterview, getInterview } from '../services/api';
import {
  streamInterviewTurn,
  type InterviewTurnOutcome,
} from '../services/interviewStream';
import type {
  AiUnavailableCause,
  Interview,
  InterviewDebrief,
  InterviewPhase,
  InterviewProgress,
  InterviewTurnRecord,
} from '../types';
import { useIsMounted } from './useIsMounted';

/**
 * Where the current turn's stream has got to.
 *
 * `idle` is ordinary; the other four are the endpoint's three terminal frames
 * plus the state while bytes are still arriving. `unavailable` is kept apart
 * from `error` for the reason `useExplanation` gives at length: collapsing them
 * would tell a learner something is broken on a screen whose honest message is
 * "your administrator hasn't finished setting this up, your key is fine, and
 * the interview carried on regardless".
 */
export type InterviewTurnStatus =
  | 'idle'
  | 'streaming'
  | 'complete'
  | 'unavailable'
  | 'error';

export interface UseMockInterviewReturn {
  /** The interview header, or null before the first read. */
  interview: Interview | null;
  /** The OFFICER's turns, oldest first. See the file header. */
  officerTurns: InterviewTurnRecord[];
  /** The phase the interview is in now, or null before the first read. */
  phase: InterviewPhase | null;
  progress: InterviewProgress | null;
  /** True once the only remaining action is `complete`. */
  awaitingCompletion: boolean;

  isLoading: boolean;
  /** A message to render, or null. Never an exception to catch. */
  loadError: string | null;
  refresh: () => Promise<void>;

  turnStatus: InterviewTurnStatus;
  /** True exactly while the officer's words can still arrive. */
  isStreaming: boolean;
  /** The officer's acknowledgement as it arrives. Cleared once the turn lands. */
  streamingText: string;
  /** Set only when `turnStatus === 'unavailable'`. Not an error. */
  unavailableCause: AiUnavailableCause | null;
  /** Set only when `turnStatus === 'error'`. A sentence, never an exception. */
  turnError: string | null;

  /** Answer the officer. Supersedes a turn already streaming. Never throws. */
  submitTurn: (text: string) => void;

  isCompleting: boolean;
  completeError: string | null;
  /**
   * End the interview: abort anything streaming, then `complete`.
   *
   * Resolves to the debrief, or null when the call failed (the reason is in
   * `completeError`). Never throws — the page navigates on a truthy result.
   */
  complete: () => Promise<InterviewDebrief | null>;
}

export function useMockInterview(
  id: string | null | undefined,
): UseMockInterviewReturn {
  const [interview, setInterview] = useState<Interview | null>(null);
  const [officerTurns, setOfficerTurns] = useState<InterviewTurnRecord[]>([]);
  const [phase, setPhase] = useState<InterviewPhase | null>(null);
  const [progress, setProgress] = useState<InterviewProgress | null>(null);
  const [awaitingCompletion, setAwaitingCompletion] = useState(false);

  // Starts false when there is no id to fetch, so a malformed URL shows its
  // message immediately rather than a spinner that never resolves.
  const [isLoading, setIsLoading] = useState(Boolean(id));
  const [loadError, setLoadError] = useState<string | null>(null);

  const [turnStatus, setTurnStatus] = useState<InterviewTurnStatus>('idle');
  const [streamingText, setStreamingText] = useState('');
  const [unavailableCause, setUnavailableCause] =
    useState<AiUnavailableCause | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);

  const [isCompleting, setIsCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  /** The live turn's controller, or null when nothing is streaming. */
  const controllerRef = useRef<AbortController | null>(null);

  /**
   * Did a terminal frame arrive on the current turn?
   *
   * A ref rather than state because the check happens after the stream's
   * promise settles, in the same tick, where a state read would still see the
   * value from the render that started it. It answers one question: did the
   * stream END, or did it just STOP producing? A body that closes with no
   * terminal frame is a truncated response, and the interview screen must then
   * re-read the server rather than sit on a question that has already moved.
   */
  const terminatedRef = useRef(false);

  /** Abort whatever is streaming. Idempotent, and safe before the first turn. */
  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  // Unmount ends the generation. See the file header — this is the difference
  // between a learner leaving mid-turn and a learner paying for words nobody
  // will read.
  useEffect(() => abort, [abort]);

  /**
   * Read the interview from the server — the only source of truth for this
   * screen, on first load, on resume, and as the recovery path above.
   */
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

      const officers = detail.turns.filter((turn) => turn.role === 'officer');
      setInterview(detail.interview);
      setOfficerTurns(officers);
      setProgress(detail.progress);
      setAwaitingCompletion(detail.awaitingCompletion);
      // DERIVED FROM THE LAST TURN, because the detail payload carries no
      // `phase` of its own: the phase an interview is in IS the phase of the
      // most recent thing said in it. `smalltalk` is the honest fallback for a
      // transcript with nothing in it yet — it is where every interview opens,
      // not a guess about a later one.
      setPhase(detail.turns[detail.turns.length - 1]?.phase ?? 'smalltalk');
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

  /**
   * Apply one turn outcome: the officer's new words, the new phase, the new
   * progress.
   *
   * Runs for `done`, `unavailable` and `error` alike — the interview advanced
   * in all three cases. See the file header.
   */
  const applyOutcome = useCallback((outcome: InterviewTurnOutcome) => {
    setOfficerTurns((current) => [...current, ...outcome.officerTurns]);
    setPhase(outcome.phase);
    setProgress(outcome.progress);
    setAwaitingCompletion(outcome.awaitingCompletion);
    // The streamed acknowledgement is now the opening of the officer turn that
    // has just been appended above, verbatim and whole. Keeping the partial
    // would render it twice.
    setStreamingText('');
  }, []);

  const submitTurn = useCallback(
    (text: string) => {
      if (!id) return;

      // Supersede, never run two. See the file header.
      abort();

      const controller = new AbortController();
      controllerRef.current = controller;
      terminatedRef.current = false;

      setTurnStatus('streaming');
      setStreamingText('');
      setUnavailableCause(null);
      setTurnError(null);

      /** Ignore anything from a turn that has been superseded or unmounted. */
      const isCurrent = () =>
        controllerRef.current === controller && isMounted();

      /**
       * The server is the authority on a turn this client could not decode.
       *
       * Never an error message: the turn really happened (it was committed
       * before the response opened), so the honest repair is to re-read it.
       */
      const reconcile = async () => {
        await refresh();
        if (isCurrent()) {
          setStreamingText('');
          controllerRef.current = null;
        }
      };

      void streamInterviewTurn(id, text, {
        signal: controller.signal,

        onFrame: (frame) => {
          if (!isCurrent()) return;

          switch (frame.event) {
            case 'delta':
              // FUNCTIONAL UPDATE, always. Tokens arrive faster than React
              // re-renders, and a `setStreamingText(text + chunk)` closing over
              // a stale render's value drops every delta that lands between two
              // commits — which is most of them.
              setStreamingText((current) => current + frame.text);
              break;

            case 'done':
              terminatedRef.current = true;
              if (frame.outcome) {
                applyOutcome(frame.outcome);
                setTurnStatus('complete');
              } else {
                void reconcile();
                setTurnStatus('complete');
              }
              break;

            case 'unavailable':
              terminatedRef.current = true;
              // THE INTERVIEW STILL ADVANCED. The officer's line is the neutral
              // code-owned fallback the server already returned, and the phase,
              // the next question and the grading are all unchanged (§5.2).
              if (frame.outcome) applyOutcome(frame.outcome);
              else void reconcile();
              setUnavailableCause(frame.cause);
              setTurnStatus('unavailable');
              break;

            case 'error':
              terminatedRef.current = true;
              // Identically to `unavailable`: the turn happened, only the
              // wording is plainer. The distinction between the two exists so a
              // caller can tell "nothing was attempted" from "something was
              // attempted and did not finish", not so one of them can skip the
              // outcome.
              if (frame.outcome) applyOutcome(frame.outcome);
              else void reconcile();
              // The API's `error` string is already redacted — never a prompt,
              // never a completion, never an exception message. `errorCode` is
              // for grouping in logs and is not a sentence, so it is not shown.
              setTurnError(
                frame.error ||
                  'The officer’s reply could not be delivered. Your answer was recorded.',
              );
              setTurnStatus('error');
              break;
          }
        },
      })
        .then(() => {
          if (!isCurrent()) return;
          controllerRef.current = null;
          // A body that closed with no terminal frame. The contract says one
          // always arrives, so this is a truncated response — and the turn it
          // was reporting is already committed, which is why this re-reads
          // rather than complains.
          if (!terminatedRef.current) {
            setTurnStatus('complete');
            void reconcile();
          }
        })
        .catch((err: unknown) => {
          // An abort lands here too. It is not a failure: either the learner
          // left, they ended the interview, or a later answer superseded this
          // one — and in every case somebody else owns the state now.
          if (controller.signal.aborted) return;
          if (!isCurrent()) return;

          controllerRef.current = null;
          setTurnError(
            err instanceof Error
              ? err.message
              : 'That answer could not be sent.',
          );
          setTurnStatus('error');
          // Reconciled even here. A transport failure can mean the request
          // never reached the server (nothing changed, and this is a no-op) or
          // that it did and the response was lost (the turn is recorded, and
          // the screen would otherwise sit on a question that has moved on).
          // Only the server can tell those apart, so it is asked.
          void refresh();
        });
    },
    [abort, applyOutcome, id, isMounted, refresh],
  );

  const complete = useCallback(async (): Promise<InterviewDebrief | null> => {
    if (!id) return null;

    // BEFORE the request, not after: the learner has said they are done, and
    // words still being generated for a conversation that is over are words
    // nobody will read on a key somebody pays for.
    abort();

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
  }, [abort, id, isMounted]);

  return {
    interview,
    officerTurns,
    phase,
    progress,
    awaitingCompletion,

    isLoading,
    loadError,
    refresh,

    turnStatus,
    isStreaming: turnStatus === 'streaming',
    streamingText,
    unavailableCause,
    turnError,

    submitTurn,

    isCompleting,
    completeError,
    complete,
  };
}

export default useMockInterview;

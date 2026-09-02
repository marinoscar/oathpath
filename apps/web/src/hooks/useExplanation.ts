/**
 * One streamed explanation of one civics question, as React state.
 *
 * Issue #125, epic #53. Shaped after `useEmailSettings` — the same
 * `isMounted` discipline, the same "an error is a string the page renders,
 * never a thrown exception" contract — with the one structural difference that
 * makes it a hook of its own: **the answer arrives in pieces, and the pieces
 * cost money.**
 *
 * =============================================================================
 * ABORT IS THE FEATURE, NOT THE CLEANUP
 * =============================================================================
 *
 * Every token of an explanation is generated on the LEARNER'S OWN API KEY
 * (`ai-evaluation.md` §11 — the per-user AI routes exist because each person
 * pays for their own calls). A stream nobody is reading is a charge on
 * somebody's card for text that will never be seen.
 *
 * So the abort signal is threaded all the way down — through
 * `streamCivicsExplanation`, through `streamSseRequest`, into `fetch` — and it
 * is fired from THREE places, all of which are real:
 *
 *   1. **Unmount.** The learner navigated away mid-explanation.
 *   2. **`stop()`.** They closed the panel, or pressed Stop.
 *   3. **A second `start()`.** Asking again supersedes the first request;
 *      leaving both running would bill twice and race two writers into one
 *      string.
 *
 * The server honours it: `POST … /explain` aborts the upstream provider call on
 * disconnect and records the abandoned stream distinctly. That only works if
 * this end actually closes the socket, which is why there is no way to start a
 * stream here without a controller attached to it.
 *
 * =============================================================================
 * SEVEN STATES, BECAUSE FOUR OF THEM MEAN DIFFERENT THINGS TO A LEARNER
 * =============================================================================
 *
 * `idle` and `streaming` are ordinary. The other five are the endpoint's four
 * terminal frames plus the one the learner causes:
 *
 *   `complete`        the `done` frame. The explanation is whole.
 *   `stopped`         the learner stopped it. Whatever arrived still stands.
 *   `unavailable`     no call was attempted, and `cause` says why. NOT AN
 *                     ERROR: nothing is broken and nothing was spent, so a
 *                     consumer renders `AiNotReady`, never an error alert.
 *   `state_required`  a state-scope question with no state on the profile.
 *                     Not an AI fact at all — the remedy is a profile field.
 *   `error`           the call was made and did not produce a usable answer.
 *
 * Collapsing `unavailable` into `error` is the specific mistake this shape
 * exists to prevent: it would tell a learner something is wrong on a screen
 * where the honest message is "your administrator hasn't finished setting this
 * up, and your key is fine".
 *
 * =============================================================================
 * DELTAS ALREADY RECEIVED ARE NEVER DISCARDED
 * =============================================================================
 *
 * `error` and `stopped` both keep `text`. Those tokens were really generated
 * and really paid for, and half an explanation a learner can read is worth
 * more than an empty box — as long as the screen does not claim it is whole,
 * which is what the state is for.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { streamCivicsExplanation } from '../services/explainStream';
import type { AiUnavailableCause } from '../types';
import { useIsMounted } from './useIsMounted';

/** Where one explanation request has got to. See the file header. */
export type ExplanationStatus =
  | 'idle'
  | 'streaming'
  | 'complete'
  | 'stopped'
  | 'unavailable'
  | 'state_required'
  | 'error';

export interface UseExplanationReturn {
  /** Everything received so far, in order. Never cleared by a failure. */
  text: string;
  status: ExplanationStatus;
  /** True exactly while tokens can still arrive. */
  isStreaming: boolean;
  /** Set only when `status === 'unavailable'`. */
  unavailableCause: AiUnavailableCause | null;
  /** Set only when `status === 'error'`. A sentence, never an exception. */
  error: string | null;
  /** Ask for an explanation. Supersedes one already running. Never throws. */
  start: (focus?: string) => void;
  /** Stop generating. Keeps whatever arrived. Safe to call at any time. */
  stop: () => void;
  /** Back to `idle` with no text, and stop anything running. */
  reset: () => void;
}

export function useExplanation(questionId: string | null): UseExplanationReturn {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<ExplanationStatus>('idle');
  const [unavailableCause, setUnavailableCause] =
    useState<AiUnavailableCause | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  /** The live request's controller, or null when nothing is running. */
  const controllerRef = useRef<AbortController | null>(null);

  /**
   * Did a terminal frame arrive on the current request?
   *
   * A ref rather than state because the check happens after the stream's
   * promise settles, in the same tick, where a state read would still see the
   * value from the render that started the request. It answers one question:
   * did the stream END, or did it just STOP producing? A body that closes with
   * no terminal frame is a truncated response — the API's contract says there
   * is always exactly one — and saying "complete" over it would present half an
   * explanation as whole.
   */
  const terminatedRef = useRef(false);

  /** The learner asked for this to stop. Distinguishes stop from a failure. */
  const stoppedRef = useRef(false);

  /** Abort whatever is running. Idempotent, and safe before the first start. */
  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  // Unmount ends the generation. See the file header — this is the difference
  // between a learner navigating away and a learner paying for text nobody
  // will read.
  useEffect(() => abort, [abort]);

  // A different question is a different explanation. Anything still arriving
  // belongs to the question that is no longer on screen, so it is stopped and
  // its text dropped rather than appended under a new prompt.
  useEffect(() => {
    abort();
    setText('');
    setStatus('idle');
    setUnavailableCause(null);
    setError(null);
  }, [questionId, abort]);

  const stop = useCallback(() => {
    if (!controllerRef.current) return;
    stoppedRef.current = true;
    abort();
    if (isMounted()) setStatus('stopped');
  }, [abort, isMounted]);

  const reset = useCallback(() => {
    abort();
    if (!isMounted()) return;
    setText('');
    setStatus('idle');
    setUnavailableCause(null);
    setError(null);
  }, [abort, isMounted]);

  const start = useCallback(
    (focus?: string) => {
      if (!questionId) return;

      // Supersede, never run two. See the file header.
      abort();

      const controller = new AbortController();
      controllerRef.current = controller;
      terminatedRef.current = false;
      stoppedRef.current = false;

      setText('');
      setStatus('streaming');
      setUnavailableCause(null);
      setError(null);

      /** Ignore anything from a request that has been superseded or stopped. */
      const isCurrent = () => controllerRef.current === controller && isMounted();

      void streamCivicsExplanation(questionId, {
        focus,
        signal: controller.signal,

        onFrame: (frame) => {
          if (!isCurrent()) return;

          switch (frame.event) {
            case 'delta':
              // FUNCTIONAL UPDATE, always. Tokens arrive faster than React
              // re-renders, and a `setText(text + chunk)` closing over a stale
              // render's value drops every delta that lands between two
              // commits — which is most of them.
              setText((current) => current + frame.text);
              break;

            case 'done':
              terminatedRef.current = true;
              setStatus('complete');
              break;

            case 'unavailable':
              terminatedRef.current = true;
              setUnavailableCause(frame.cause);
              setStatus('unavailable');
              break;

            case 'state_required':
              terminatedRef.current = true;
              setStatus('state_required');
              break;

            case 'error':
              terminatedRef.current = true;
              // The API's `error` string is already redacted — never a prompt,
              // never a completion, never an exception message — so it is safe
              // to show. `errorCode` is for grouping in logs and is not a
              // sentence, so it is deliberately not rendered.
              setError(
                frame.error ||
                  'That explanation could not be finished. Please try again.',
              );
              setStatus('error');
              break;
          }
        },
      })
        .then(() => {
          if (!isCurrent()) return;
          controllerRef.current = null;
          // A body that closed with no terminal frame. The contract says one
          // always arrives, so this is a truncated response — and whatever
          // text came through must not be presented as a whole explanation.
          if (!terminatedRef.current) {
            setError('That explanation ended before it was finished.');
            setStatus('error');
          }
        })
        .catch((err: unknown) => {
          // An abort lands here too. It is not a failure, and `stop()` has
          // already said what it was; a stale controller means this request was
          // superseded, whose successor owns the state now.
          if (stoppedRef.current || controller.signal.aborted) return;
          if (!isCurrent()) return;

          controllerRef.current = null;
          setError(
            err instanceof Error
              ? err.message
              : 'That explanation could not be loaded.',
          );
          setStatus('error');
        });
    },
    [abort, isMounted, questionId],
  );

  return {
    text,
    status,
    isStreaming: status === 'streaming',
    unavailableCause,
    error,
    start,
    stop,
    reset,
  };
}

export default useExplanation;

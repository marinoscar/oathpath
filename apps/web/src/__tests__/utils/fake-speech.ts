import { act } from '@testing-library/react';

/**
 * Drain a fake speech engine until the coach has genuinely stopped talking.
 *
 * Lifted out of `PracticeSessionPage.conversation.test.tsx` by issue #403 when
 * a second and third call site needed the same rule — the same reason
 * `fake-audio.ts` exists, stated in its own header.
 *
 * =============================================================================
 * WHY "THE QUEUE IS EMPTY" IS NOT "THE TURN IS OVER"
 * =============================================================================
 *
 * A spoken turn is several utterances, and the driver
 * (`useConversationSession.gradeTranscript`) speaks them ONE AT A TIME,
 * awaiting each before asking for the next. So the queue is empty for a moment
 * between every pair of lines, and a helper that returns the first time it
 * observes an empty queue returns MID-TURN.
 *
 * The gap is not one microtask, which is why flushing harder is not the fix on
 * its own. Ending line N resolves the driver's `say`, which calls
 * `speech.speak(line N+1, 'answer')`, which does not touch
 * `window.speechSynthesis` at all — it sets React state
 * (`PracticeSessionPage`'s `setSpeechRequest`), remounts `QuestionAudio` under
 * a new `key`, and that component's own autoplay effect is what eventually
 * calls `speak`. Between "line N ended" and "line N+1 is queued" there is a
 * render, an effect, and a short chain of awaits inside it.
 *
 * =============================================================================
 * WHY THIS SURFACED NOW, AND WHY IT IS NOT A FLAKE
 * =============================================================================
 *
 * The bug is old; the exposure is new. Before issue #403 the coach said one
 * line about an answer, so there were no gaps to mistake for the end. #403
 * made the turn carry the verdict, the reason and the accepted answer — three
 * or four utterances where there was one — and every extra line is another gap
 * a single-observation drain can stop in. It reproduced under a loaded full
 * suite and not in an isolated file for the ordinary reason: load changes when
 * already-scheduled work runs relative to `act`'s flush, so it changes which
 * gap is observed, not whether the gaps exist.
 *
 * It is the same class of defect as the one PR #377 hit, where a single drain
 * pass ended line 1 of a multi-line turn and left the loop where it stood.
 *
 * =============================================================================
 * THE RULE: QUIET ACROSS SEVERAL SETTLES, NOT QUIET ONCE
 * =============================================================================
 *
 * A pass either ends every live utterance, or — finding none — settles and
 * looks again. Only {@link QUIET_PASSES} consecutive empty observations, each
 * separated by a settle, count as the end of the turn: the driver has been
 * given that many complete opportunities to queue its next line and has not.
 *
 * `MAX_PASSES` is a safety net against a driver that queues for ever, not an
 * expected count. A helper that spun here would HANG the suite instead of
 * failing it, and a hung suite is a suite nobody can read.
 */

/** The one utterance field this module touches. Nothing here reads text. */
interface EndableUtterance {
  onend?: (() => void) | null;
}

/** The fake engine's queue of utterances that have started and not ended. */
export interface SpokenQueue {
  live: EndableUtterance[];
}

/**
 * How many consecutive empty observations mean the turn is over.
 *
 * THREE, NOT ONE, and not because three is lucky: one is the bug, two is one
 * settle's worth of evidence, and three costs nothing measurable while
 * covering a gap that spans a render, its effect, and the effect's own awaits.
 * Every one of those is drained by a single {@link settle}, so three of them
 * is deliberate slack rather than a threshold anybody has to tune.
 */
export const QUIET_PASSES = 3;

/** Bound on total passes. Reached only by a driver that never goes quiet. */
export const MAX_PASSES = 60;

/**
 * Let everything already scheduled run, and nothing else.
 *
 * NOT A SLEEP, and the distinction is the whole reason this is allowed to
 * exist: it waits for work that has ALREADY been queued — React's own work
 * loop and its effects (`act`), the promise chain those effects start
 * (`Promise.resolve`), and any zero-delay timer they scheduled (`setTimeout`
 * with no delay). It does not wait a fixed period hoping a race resolves, and
 * lengthening it would not make a failing case pass.
 *
 * What makes the drain CORRECT is {@link QUIET_PASSES} — the requirement that
 * the queue stay empty across several of these — not the contents of any one
 * settle.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/**
 * End every utterance of the current turn, and return once the turn is over.
 *
 * Safe to call when nothing is speaking yet: an empty queue is settled and
 * re-checked rather than taken at face value, so a caller that gets here a
 * fraction before the first line is queued still waits for the turn.
 *
 * Throws rather than hangs if the engine never goes quiet.
 */
export async function drainSpokenTurn(queue: SpokenQueue): Promise<void> {
  let quiet = 0;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    if (queue.live.length === 0) {
      quiet += 1;
      if (quiet >= QUIET_PASSES) return;
      await settle();
      continue;
    }

    // A line was queued after all, so the run of quiet observations is broken
    // — not decremented. Two lines separated by a gap must not accumulate
    // towards the same total.
    quiet = 0;

    await act(async () => {
      // TAKEN, THEN ENDED. Clearing first is what lets the driver's own
      // reaction to `onend` queue the next line into a fresh array rather than
      // into the one being iterated.
      const live = queue.live;
      queue.live = [];
      for (const utterance of live) utterance.onend?.();
    });
  }

  throw new Error(
    `drainSpokenTurn: still speaking after ${MAX_PASSES} passes ` +
      `(${queue.live.length} utterance(s) live)`,
  );
}

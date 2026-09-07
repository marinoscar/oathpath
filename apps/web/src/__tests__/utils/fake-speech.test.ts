import { describe, expect, it } from 'vitest';

import { drainSpokenTurn, MAX_PASSES, type SpokenQueue } from './fake-speech';

/**
 * The drain helper's own contract — issue #403.
 *
 * =============================================================================
 * WHY A TEST FOR A TEST HELPER
 * =============================================================================
 *
 * Because this one was wrong for months and nothing said so. It returned the
 * first time it observed an empty queue, which is a state that occurs between
 * every pair of lines in a spoken turn, so it could return mid-turn — and the
 * only symptom was a `findByText` in a DIFFERENT file timing out, under load,
 * on an assertion that was correct. Three suites now depend on it, and a
 * helper whose failure mode is "somebody else's test looks broken" is one that
 * has to state its contract somewhere it can be checked directly.
 *
 * THE GAP IS MODELLED AS A ZERO-DELAY TIMER, deliberately. In the real driver
 * the next line is queued after a React render, that render's effect, and a
 * chain of awaits inside it (`utils/fake-speech.ts`'s header spells the chain
 * out). None of that is reproducible here without mounting the whole practice
 * page, and none of it needs to be: what the helper has to survive is a gap
 * WIDER THAN A MICROTASK, and `setTimeout(…, 0)` is the smallest honest one.
 */

/** A fake utterance, with the one field the helper touches. */
interface Utterance {
  text: string;
  onend: (() => void) | null;
}

/**
 * A queue that behaves like the driver: one line at a time, and the next line
 * queued a macrotask after the previous one ends.
 */
function scriptedTurn(lines: string[]): {
  queue: SpokenQueue;
  ended: string[];
  start: () => void;
} {
  const queue: SpokenQueue = { live: [] };
  const ended: string[] = [];
  let index = 0;

  const speak = () => {
    const text = lines[index];
    if (text === undefined) return;
    index += 1;
    const utterance: Utterance = {
      text,
      onend: () => {
        ended.push(text);
        // THE GAP. The driver does not queue the next line synchronously from
        // `onend`; it resolves a promise, re-renders, and an effect speaks.
        setTimeout(speak, 0);
      },
    };
    queue.live.push(utterance);
  };

  return { queue, ended, start: speak };
}

describe('drainSpokenTurn', () => {
  it('ends every line of a multi-line turn, not just the first', async () => {
    // THE REGRESSION. Before #403 this helper stopped as soon as it saw an
    // empty queue, so it ended line 1, observed the gap before line 2, and
    // returned — leaving the loop in `speakingAnswer` while the caller went on
    // to assert it had reached `advancing`.
    const turn = scriptedTurn([
      'We heard “the Constitution”',
      'That’s right.',
      'Nice one.',
    ]);
    turn.start();

    await drainSpokenTurn(turn.queue);

    expect(turn.ended).toEqual([
      'We heard “the Constitution”',
      'That’s right.',
      'Nice one.',
    ]);
    expect(turn.queue.live).toHaveLength(0);
  });

  it('waits through a turn that has not started speaking yet', async () => {
    // The caller's own shape at the `speakingAnswer` step: it reaches this
    // helper the moment the phase text renders, which can be a beat before the
    // first utterance is queued. Taking an empty queue at face value there
    // returns instantly and skips the whole turn.
    const turn = scriptedTurn(['The answer is: the Constitution.']);
    setTimeout(turn.start, 0);

    await drainSpokenTurn(turn.queue);

    expect(turn.ended).toEqual(['The answer is: the Constitution.']);
  });

  it('returns on a turn that really is over', async () => {
    const queue: SpokenQueue = { live: [] };

    await expect(drainSpokenTurn(queue)).resolves.toBeUndefined();
  });

  it('tolerates an utterance with no `onend` handler', async () => {
    const queue: SpokenQueue = { live: [{ onend: null }] };

    await expect(drainSpokenTurn(queue)).resolves.toBeUndefined();
    expect(queue.live).toHaveLength(0);
  });

  it('fails loudly rather than hanging when the engine never goes quiet', async () => {
    // THE SAFETY NET, and the reason it is an error and not a spin: a helper
    // that looped for ever here would hang the whole suite, and a hung suite
    // reports nothing at all. A driver that queues without end is a real bug
    // and has to be legible as one.
    const queue: SpokenQueue = { live: [] };
    const forever: Utterance = {
      text: 'and another thing',
      onend: () => {
        queue.live.push(forever);
      },
    };
    queue.live.push(forever);

    await expect(drainSpokenTurn(queue)).rejects.toThrow(
      new RegExp(`still speaking after ${MAX_PASSES} passes`),
    );
  });
});

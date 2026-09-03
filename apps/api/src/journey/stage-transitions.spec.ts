import type { JourneyStage } from '@prisma/client';

import type { MasteryState } from '../practice/mastery/scheduler';
import { nextStageOnMasteryEvent } from './stage-transitions';

// =============================================================================
// nextStageOnMasteryEvent — tests (issue #82, epic #54 / E5 "Memory")
// =============================================================================
//
// A small pure function over three inputs; table-driven per its own header's
// two-transition contract:
//
//   oriented -> learning     unconditionally, on ANY mastery event.
//   learning -> remembering  only on a genuine promotion to mastered
//                             (`priorMasteryState !== 'mastered' &&
//                             nextMasteryState === 'mastered'`).
//   everything else          -> null, including `learning` with no crossing,
//                             `remembering` (already past this function's
//                             reach), and every stage past it.
// =============================================================================

/** Every mastery state the scheduler can produce, for exhaustive pairing. */
const MASTERY_STATES: MasteryState[] = [
  'new',
  'learning',
  'review',
  'lapsed',
  'mastered',
];

/** The full 8-stage journey enum, in declared order. */
const ALL_STAGES: JourneyStage[] = [
  'uncertain',
  'oriented',
  'learning',
  'remembering',
  'speaking',
  'practicing',
  'performing',
  'ready',
];

describe('nextStageOnMasteryEvent', () => {
  // ---------------------------------------------------------------------------
  // oriented -> learning, unconditionally
  // ---------------------------------------------------------------------------

  describe('oriented', () => {
    it.each(
      MASTERY_STATES.flatMap((prior) =>
        MASTERY_STATES.map((next) => [prior, next] as const),
      ),
    )(
      'always returns learning regardless of the mastery states (%s -> %s)',
      (prior, next) => {
        expect(nextStageOnMasteryEvent('oriented', prior, next)).toBe('learning');
      },
    );
  });

  // ---------------------------------------------------------------------------
  // learning -> remembering, only on a genuine crossing into mastered
  // ---------------------------------------------------------------------------

  describe('learning', () => {
    it.each(
      MASTERY_STATES.filter((state) => state !== 'mastered'),
    )('promotes to remembering when %s crosses into mastered', (prior) => {
      expect(nextStageOnMasteryEvent('learning', prior, 'mastered')).toBe(
        'remembering',
      );
    });

    it('does NOT promote when the prior state was already mastered (no crossing)', () => {
      expect(nextStageOnMasteryEvent('learning', 'mastered', 'mastered')).toBeNull();
    });

    it.each(
      MASTERY_STATES.filter((state) => state !== 'mastered'),
    )('does NOT promote when the next state is %s (never crosses into mastered)', (next) => {
      for (const prior of MASTERY_STATES) {
        expect(nextStageOnMasteryEvent('learning', prior, next)).toBeNull();
      }
    });

    it('does not promote on a review -> review non-event (no crossing at all)', () => {
      expect(nextStageOnMasteryEvent('learning', 'review', 'review')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // remembering — the terminal stage this function reaches, a no-op past it
  // ---------------------------------------------------------------------------

  describe('remembering', () => {
    it.each(
      MASTERY_STATES.flatMap((prior) =>
        MASTERY_STATES.map((next) => [prior, next] as const),
      ),
    )('is always null, even on a mastery promotion (%s -> %s)', (prior, next) => {
      expect(nextStageOnMasteryEvent('remembering', prior, next)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Every other stage — this function only ever acts on oriented and learning
  // ---------------------------------------------------------------------------

  describe('every stage other than oriented and learning', () => {
    const otherStages = ALL_STAGES.filter(
      (stage) => stage !== 'oriented' && stage !== 'learning',
    );

    it('covers the full 8-stage enum, minus the two this function acts on', () => {
      expect(otherStages).toEqual([
        'uncertain',
        'remembering',
        'speaking',
        'practicing',
        'performing',
        'ready',
      ]);
    });

    it.each(otherStages)(
      'returns null for %s regardless of the mastery states, including a mastery crossing',
      (stage) => {
        expect(nextStageOnMasteryEvent(stage, 'new', 'mastered')).toBeNull();
        expect(nextStageOnMasteryEvent(stage, 'review', 'mastered')).toBeNull();
        expect(nextStageOnMasteryEvent(stage, 'learning', 'learning')).toBeNull();
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Purity — same inputs, same output, forever.
  // ---------------------------------------------------------------------------

  it('is deterministic — two consecutive calls with the same inputs agree', () => {
    expect(nextStageOnMasteryEvent('learning', 'review', 'mastered')).toEqual(
      nextStageOnMasteryEvent('learning', 'review', 'mastered'),
    );
    expect(nextStageOnMasteryEvent('oriented', 'new', 'learning')).toEqual(
      nextStageOnMasteryEvent('oriented', 'new', 'learning'),
    );
  });
});

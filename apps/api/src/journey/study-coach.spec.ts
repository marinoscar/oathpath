import {
  NEXT_ACTION_KINDS,
  NEXT_ACTION_PATHS,
  type NextActionKind,
} from './next-action';
import { recommendStudyAction, type StudyCoachInput } from './study-coach';

// =============================================================================
// recommendStudyAction — tests (issue #82, epic #54 / E5 "Memory")
// =============================================================================
//
// Three things worth protecting, same order as `next-action.spec.ts`:
//
//   1. THE PATH INVARIANT — every kind this function can emit still resolves
//      to one of `NEXT_ACTION_PATHS`' real, non-redirecting routes.
//   2. The ordering contract this file's own header states:
//        orientation > interview_countdown > review > practice > explore
//   3. The one judgment call the header flags explicitly: the fire condition
//      is `dueCount + lapsedCount > 0`, and the reason string interpolates
//      that SUM — not `dueCount` alone, as `docs/specs/memory-model.md` §6's
//      literal quote reads. Both the gate and the copy are pinned here so a
//      future edit that "fixes" the interpolation back to the spec's literal
//      wording (while leaving the sum-gated fire condition alone) fails a
//      test rather than shipping a card that names a count of zero.
// =============================================================================

const ORIENTED_AT = new Date('2026-01-01T12:00:00Z');

/** Every path the coach is permitted to emit. Real, mounted routes. */
const ALLOWED_PATHS = ['/setup/journey', '/learn', '/practice'];

/**
 * An oriented learner with nothing else going on, plus whatever the test is
 * actually about — mirrors `next-action.spec.ts`'s own `input` builder,
 * widened with the two mastery counts this file adds.
 */
function input(overrides: Partial<StudyCoachInput> = {}): StudyCoachInput {
  return {
    orientationCompletedAt: ORIENTED_AT,
    daysUntilInterview: null,
    hasPractisedToday: false,
    dueCount: 0,
    lapsedCount: 0,
    ...overrides,
  };
}

describe('recommendStudyAction', () => {
  // ---------------------------------------------------------------------------
  // The closed union — `review` is now reachable through THIS function
  // ---------------------------------------------------------------------------

  describe('the closed union and its hardcoded paths', () => {
    it.each([
      [input({ orientationCompletedAt: null })],
      [input({ dueCount: 3 })],
      [input({ lapsedCount: 3 })],
      [input({ daysUntilInterview: 5 })],
      [input()],
      [input({ hasPractisedToday: true })],
    ])('never emits a kind or path outside the closed sets (%j)', (given) => {
      const action = recommendStudyAction(given);

      expect(NEXT_ACTION_KINDS).toContain(action.kind);
      expect(ALLOWED_PATHS).toContain(action.path);
      expect(action.path).toBe(NEXT_ACTION_PATHS[action.kind as NextActionKind]);
      expect(action.title.length).toBeGreaterThan(0);
      expect(action.reason.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // orientation and interview_countdown — delegated to `recommendNextAction`
  // unchanged. A light smoke test each; the exhaustive coverage of these two
  // branches already lives in `next-action.spec.ts`.
  // ---------------------------------------------------------------------------

  describe('orientation', () => {
    it('outranks review even with due/lapsed evidence sitting there', () => {
      const action = recommendStudyAction(
        input({ orientationCompletedAt: null, dueCount: 5, lapsedCount: 5 }),
      );

      expect(action.kind).toBe('orientation');
      expect(action.path).toBe('/setup/journey');
    });
  });

  describe('interview_countdown', () => {
    it('outranks review — a booked date is the more specific true thing to say', () => {
      const action = recommendStudyAction(
        input({ daysUntilInterview: 4, dueCount: 3, lapsedCount: 2 }),
      );

      expect(action.kind).toBe('interview_countdown');
      expect(action.path).toBe('/practice');
    });

    it('outranks review on the interview day itself', () => {
      const action = recommendStudyAction(
        input({ daysUntilInterview: 0, dueCount: 1 }),
      );

      expect(action.kind).toBe('interview_countdown');
    });

    it('does NOT outrank review once the interview date has passed', () => {
      // A past interview falls through `recommendNextAction`'s own branch 2,
      // so review — the new rung this file inserts — gets its turn.
      const action = recommendStudyAction(
        input({ daysUntilInterview: -3, dueCount: 2 }),
      );

      expect(action.kind).toBe('review');
    });
  });

  // ---------------------------------------------------------------------------
  // review — the one new branch this file adds
  // ---------------------------------------------------------------------------

  describe('review', () => {
    it('fires when dueCount alone is positive, with lapsedCount at zero', () => {
      const action = recommendStudyAction(input({ dueCount: 3, lapsedCount: 0 }));

      expect(action.kind).toBe('review');
      expect(action.path).toBe('/practice');
    });

    it('fires when lapsedCount alone is positive, with dueCount at zero', () => {
      const action = recommendStudyAction(input({ dueCount: 0, lapsedCount: 3 }));

      expect(action.kind).toBe('review');
      expect(action.path).toBe('/practice');
    });

    it('fires when both counts contribute', () => {
      const action = recommendStudyAction(input({ dueCount: 2, lapsedCount: 1 }));

      expect(action.kind).toBe('review');
    });

    it('does NOT fire when both counts are zero', () => {
      const action = recommendStudyAction(input({ dueCount: 0, lapsedCount: 0 }));

      expect(action.kind).not.toBe('review');
    });

    // -------------------------------------------------------------------------
    // The flagged judgment call: the SUM drives both the gate and the copy,
    // never `dueCount` alone — pinned as behaviour, not left implicit.
    // -------------------------------------------------------------------------

    it('interpolates the SUM into the title, not dueCount alone', () => {
      // dueCount: 0 would read "You have 0 questions ready to review" under
      // the spec's literal `{dueCount}`-only wording — a fabricated-confidence
      // shape journey-shell.md §10 rules out. The shipped behaviour uses the
      // sum for both the gate and the copy, so this asserts the title never
      // shows a number that contradicts why the card appeared.
      const action = recommendStudyAction(input({ dueCount: 0, lapsedCount: 4 }));

      expect(action.title).toBe('Review 4 questions.');
      expect(action.title).not.toContain('0');
    });

    it('interpolates the SUM into the reason text, not dueCount alone', () => {
      const action = recommendStudyAction(input({ dueCount: 1, lapsedCount: 2 }));

      expect(action.reason).toContain('You have 3 question');
      expect(action.reason).not.toContain('You have 1 question');
    });

    it('spells out the singular for exactly one due-or-lapsed question', () => {
      const action = recommendStudyAction(input({ dueCount: 1, lapsedCount: 0 }));

      expect(action.title).toBe('Review 1 question.');
      expect(action.reason).toContain('You have 1 question ready to review');
      expect(action.reason).not.toContain('1 questions');
    });

    it('pluralizes for more than one due-or-lapsed question', () => {
      const action = recommendStudyAction(input({ dueCount: 2, lapsedCount: 0 }));

      expect(action.title).toBe('Review 2 questions.');
      expect(action.reason).toContain('2 questions ready to review');
    });

    it('outranks practice — reviewing is more specific than a generic nudge', () => {
      const action = recommendStudyAction(
        input({ dueCount: 3, hasPractisedToday: false }),
      );

      expect(action.kind).toBe('review');
    });

    it('outranks explore too — due/lapsed evidence wins even after today’s practice is done', () => {
      const action = recommendStudyAction(
        input({ dueCount: 3, hasPractisedToday: true }),
      );

      expect(action.kind).toBe('review');
    });
  });

  // ---------------------------------------------------------------------------
  // practice / explore — delegated unchanged, reachable once review's gate is
  // closed. Mirrors the equivalent fixtures in `next-action.spec.ts`.
  // ---------------------------------------------------------------------------

  describe('practice', () => {
    it('is the answer with no due/lapsed evidence and nothing practised today', () => {
      const action = recommendStudyAction(input());

      expect(action.kind).toBe('practice');
      expect(action.path).toBe('/practice');
    });
  });

  describe('explore', () => {
    it('is the fallback once today is practised and there is no due/lapsed evidence', () => {
      const action = recommendStudyAction(input({ hasPractisedToday: true }));

      expect(action.kind).toBe('explore');
      expect(action.path).toBe('/learn');
    });
  });

  // ---------------------------------------------------------------------------
  // Determinism — ROADMAP §7's own requirement, restated for this wrapper.
  // ---------------------------------------------------------------------------

  it('is deterministic — two consecutive calls give an identical answer', () => {
    const given = input({ dueCount: 2, lapsedCount: 1 });

    expect(recommendStudyAction(given)).toEqual(recommendStudyAction(given));
  });
});

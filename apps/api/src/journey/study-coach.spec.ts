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
//        orientation > interview_countdown > review > practice > interview
//        > explore
//   3. The one judgment call the header flags explicitly: the fire condition
//      is `dueCount + lapsedCount > 0`, and the reason string interpolates
//      that SUM — not `dueCount` alone, as `docs/specs/memory-model.md` §6's
//      literal quote reads. Both the gate and the copy are pinned here so a
//      future edit that "fixes" the interpolation back to the spec's literal
//      wording (while leaving the sum-gated fire condition alone) fails a
//      test rather than shipping a card that names a count of zero.
//   4. THE STAGE GATE on `interview` (#133, epic #57 / E8): the rung is
//      offered at `practicing`, `performing` and `ready`, and at no other
//      stage. `mock-interview.md` §14.1 is the reason, and it is a product
//      one rather than a technical one — inviting a learner who has not yet
//      shown civics competence to sit a full rehearsal is inviting them to
//      fail it. Every one of the eight stages is asserted below, so a ninth
//      stage added to the registry cannot silently join or leave the set.
// =============================================================================

const ORIENTED_AT = new Date('2026-01-01T12:00:00Z');

/** Every path the coach is permitted to emit. Real, mounted routes. */
const ALLOWED_PATHS = [
  '/setup/journey',
  '/learn',
  '/practice',
  '/practice/interviews',
];

/**
 * An oriented learner with nothing else going on, plus whatever the test is
 * actually about — mirrors `next-action.spec.ts`'s own `input` builder,
 * widened with the two mastery counts and the journey stage this file adds.
 *
 * The DEFAULT STAGE IS `learning`, deliberately below the `interview` rung's
 * gate. Every fixture written before #133 assumed the chain ended at
 * `practice`/`explore`, and a default of `practicing` would have silently
 * re-pointed several of them at the new rung — so the default is a stage where
 * the new branch does not fire, and the tests that are about it say so.
 */
function input(overrides: Partial<StudyCoachInput> = {}): StudyCoachInput {
  return {
    orientationCompletedAt: ORIENTED_AT,
    daysUntilInterview: null,
    hasPractisedToday: false,
    dueCount: 0,
    lapsedCount: 0,
    stage: 'learning',
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
      [input({ hasPractisedToday: true, stage: 'practicing' })],
      [input({ hasPractisedToday: true, stage: 'ready' })],
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

  // ---------------------------------------------------------------------------
  // interview — the rung E8 inserts, between `practice` and `explore`
  // ---------------------------------------------------------------------------

  describe('interview', () => {
    it.each(['practicing', 'performing', 'ready'] as const)(
      'fires at stage %s once today is practised and nothing is due',
      (stage) => {
        const action = recommendStudyAction(
          input({ hasPractisedToday: true, stage }),
        );

        expect(action.kind).toBe('interview');
        expect(action.path).toBe('/practice/interviews');
      },
    );

    it.each([
      'uncertain',
      'oriented',
      'learning',
      'remembering',
      'speaking',
    ] as const)('does NOT fire at stage %s — it falls through to explore', (stage) => {
      // `mock-interview.md` §14.1: a mock interview presumes real civics
      // competence to rehearse against. A learner earlier than `practicing` is
      // invited to look around, not to sit a rehearsal they would likely fail.
      const action = recommendStudyAction(
        input({ hasPractisedToday: true, stage }),
      );

      expect(action.kind).toBe('explore');
    });

    it('does NOT displace the daily practice nudge', () => {
      // THE TRADE §14.1 STATES OUTRIGHT: an interview is a bigger ask than five
      // questions, and `VISION.md`'s "Five Minutes Should Matter" is what keeps
      // the product usable on a day with little time. A learner opening the app
      // for a quick session must not be met with an invitation to a full
      // rehearsal instead.
      const action = recommendStudyAction(
        input({ hasPractisedToday: false, stage: 'ready' }),
      );

      expect(action.kind).toBe('practice');
    });

    it('does NOT displace review — due evidence is the more specific thing to say', () => {
      const action = recommendStudyAction(
        input({ hasPractisedToday: true, dueCount: 2, stage: 'ready' }),
      );

      expect(action.kind).toBe('review');
    });

    it('does NOT displace the interview countdown', () => {
      const action = recommendStudyAction(
        input({ hasPractisedToday: true, daysUntilInterview: 3, stage: 'ready' }),
      );

      expect(action.kind).toBe('interview_countdown');
    });

    it('is an invitation, never a loss-framed push', () => {
      // `VISION.md`: "We should never create pressure, shame, fear, or unhealthy
      // compulsion to increase engagement metrics." A full rehearsal is the card
      // most tempting to sell with urgency, so the copy is pinned against the
      // vocabulary that would do it.
      const action = recommendStudyAction(
        input({ hasPractisedToday: true, stage: 'practicing' }),
      );

      const copy = `${action.title} ${action.reason}`.toLowerCase();

      // WHOLE WORDS, not substrings. A plain `toContain('lose')` matches
      // "closest", which is how a test meant to protect the product's voice
      // ends up rejecting a perfectly gentle sentence — and a contributor's
      // fix for that is to weaken the check, not to improve the copy.
      for (const pressure of [
        'lose',
        'lost',
        'losing',
        'miss',
        'risk',
        'streak',
        'behind',
        'must',
        'fail',
        'failing',
        'urgent',
        'hurry',
      ]) {
        expect(copy).not.toMatch(new RegExp(`\\b${pressure}\\b`));
      }

      expect(copy).not.toContain('last chance');
      expect(copy).not.toContain('running out');
    });
  });

  describe('explore', () => {
    it('is the fallback once today is practised, nothing is due, and the stage is early', () => {
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

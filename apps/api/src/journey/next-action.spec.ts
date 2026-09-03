import {
  NEXT_ACTION_KINDS,
  NEXT_ACTION_PATHS,
  recommendNextAction,
  type NextActionInput,
} from './next-action';

// =============================================================================
// nextAction recommender — tests (issue #65, epic #50; extended by #81, E3)
// =============================================================================
//
// Three things are being protected here, in order of how badly they fail:
//
//   1. THE PATH INVARIANT. A next action must never point at a route that
//      redirects to `/` (journey-shell.md §4.1). Enforced structurally by the
//      closed `kind` union; asserted here so the enforcement is visible.
//   2. DETERMINISM. Two consecutive loads must give the same card (ROADMAP §7).
//   3. The branch ordering, which is the contract for which card wins.
//
// E3 added a fourth kind and one new input fact, so the ordering block below
// now has four rungs rather than three. Nothing that existed moved.
// =============================================================================

const ORIENTED_AT = new Date('2026-01-01T12:00:00Z');

/** Every path the recommender is permitted to emit. Real, mounted routes. */
const ALLOWED_PATHS = ['/setup/journey', '/learn', '/practice'];

/**
 * An oriented learner with nothing else going on, plus whatever the test is
 * actually about.
 *
 * A builder rather than object literals repeated per case: `NextActionInput`
 * gained a field in E3 and will gain more, and every test that only cares
 * about one of them should not have to restate the others.
 */
function input(overrides: Partial<NextActionInput> = {}): NextActionInput {
  return {
    orientationCompletedAt: ORIENTED_AT,
    daysUntilInterview: null,
    hasPractisedToday: false,
    ...overrides,
  };
}

describe('recommendNextAction', () => {
  describe('the closed union and its hardcoded paths', () => {
    it('caps kind at the five values that have a destination', () => {
      // `review` (E5, #82) is produced by `study-coach.ts`'s
      // `recommendStudyAction`, never by `recommendNextAction` itself — none
      // of the input fixtures below can make `recommendNextAction` return it,
      // since this function has no mastery data to decide that branch with.
      // It still belongs in this closed set: `NEXT_ACTION_KINDS` is the ONE
      // union both functions share, per journey-shell.md §4.1.
      expect([...NEXT_ACTION_KINDS]).toEqual([
        'orientation',
        'interview_countdown',
        'review',
        'practice',
        'explore',
      ]);
    });

    it('maps every kind to one of the verified, non-redirecting routes', () => {
      // `/setup/journey` is mounted OUTSIDE `RequireOrientation`; `/learn` and
      // `/practice` are real bar destinations, and since E3 `/practice` is a
      // real destination rather than an empty state. None redirects, so a
      // learner tapping the card never lands back where they started.
      for (const kind of NEXT_ACTION_KINDS) {
        expect(ALLOWED_PATHS).toContain(NEXT_ACTION_PATHS[kind]);
      }
    });

    it('gives every kind a non-empty, root-relative path', () => {
      // The structural half of §4.1's invariant, asserted on the shape rather
      // than on the specific strings: a path that is absolute (`https://…`),
      // relative (`practice`), or empty could not be navigated to from Home
      // without either leaving the application or resolving against whatever
      // route the learner happens to be on.
      for (const kind of NEXT_ACTION_KINDS) {
        const path = NEXT_ACTION_PATHS[kind];

        expect(typeof path).toBe('string');
        expect(path.length).toBeGreaterThan(1);
        expect(path.startsWith('/')).toBe(true);
        expect(path.startsWith('//')).toBe(false);
        expect(path).not.toMatch(/^\/{2}|:\/\//);
      }
    });

    it('exposes the path map frozen, so nothing can repoint it at runtime', () => {
      expect(Object.isFrozen(NEXT_ACTION_PATHS)).toBe(true);
    });

    it.each([
      [input({ orientationCompletedAt: null })],
      [input({ orientationCompletedAt: null, daysUntilInterview: 5 })],
      [input({ daysUntilInterview: 30 })],
      [input({ daysUntilInterview: 0 })],
      [input({ daysUntilInterview: -1 })],
      [input()],
      [input({ hasPractisedToday: true })],
      [input({ daysUntilInterview: -1, hasPractisedToday: true })],
    ])('never emits a kind or path outside the closed sets (%j)', (given) => {
      const action = recommendNextAction(given);

      expect(NEXT_ACTION_KINDS).toContain(action.kind);
      expect(ALLOWED_PATHS).toContain(action.path);
      expect(action.path).toBe(NEXT_ACTION_PATHS[action.kind]);
      expect(action.title.length).toBeGreaterThan(0);
      expect(action.reason.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // The ordering contract: orientation > interview_countdown > practice > explore
  // ---------------------------------------------------------------------------

  describe('orientation', () => {
    it('outranks everything while orientation is unfinished', () => {
      // Even with an interview eight days out and nothing practised: a learner
      // who has not told us which test they take has nothing useful to be told
      // about a countdown, and no test version to practise against either.
      const action = recommendNextAction(
        input({ orientationCompletedAt: null, daysUntilInterview: 8 }),
      );

      expect(action.kind).toBe('orientation');
      expect(action.path).toBe('/setup/journey');
      expect(action.title).toBe('Finish setting up your plan.');
    });

    it('answers correctly even though the live gate makes this unreachable', () => {
      // journey-shell.md §4.2: `RequireOrientation` redirects an unoriented
      // learner before Home mounts, so this card never renders in the running
      // product. The function must still be right about the input.
      expect(
        recommendNextAction(input({ orientationCompletedAt: null })).kind,
      ).toBe('orientation');
    });
  });

  describe('interview_countdown', () => {
    it('counts down to an upcoming interview', () => {
      const action = recommendNextAction(input({ daysUntilInterview: 13 }));

      expect(action.kind).toBe('interview_countdown');
      expect(action.title).toBe('13 days until your interview');
      expect(action.reason).toBe(
        'Practice is the closest thing to the real interview. A few questions today, and the day itself will feel familiar.',
      );
      // Re-pointed by E3 (#81): `/learn` until Practice had real content to
      // send a learner to, `/practice` from the moment it did.
      expect(action.path).toBe('/practice');
    });

    it('no longer offers practice as something to build up to', () => {
      // The E1 line — "Start with the material, then build up to full
      // practice." — was honest only while `/practice` was an empty state.
      expect(
        recommendNextAction(input({ daysUntilInterview: 13 })).reason,
      ).not.toContain('build up to');
    });

    it('treats the interview day itself as upcoming, in words', () => {
      const action = recommendNextAction(input({ daysUntilInterview: 0 }));

      expect(action.kind).toBe('interview_countdown');
      expect(action.title).toBe('Your interview is today.');
    });

    it('does not say "1 days"', () => {
      expect(recommendNextAction(input({ daysUntilInterview: 1 })).title).toBe(
        '1 day until your interview',
      );
    });

    it('outranks practice — a booked date is the more specific true thing to say', () => {
      // Already practised today AND an interview on Thursday: the countdown
      // wins, because it is about a date on the calendar rather than about
      // today's habit.
      const action = recommendNextAction(
        input({ daysUntilInterview: 4, hasPractisedToday: true }),
      );

      expect(action.kind).toBe('interview_countdown');
    });

    it('still outranks practice for a learner who has not practised today', () => {
      const action = recommendNextAction(
        input({ daysUntilInterview: 4, hasPractisedToday: false }),
      );

      expect(action.kind).toBe('interview_countdown');
    });
  });

  describe('practice', () => {
    it('is the answer for an oriented learner with no date who has not practised today', () => {
      const action = recommendNextAction(input());

      expect(action.kind).toBe('practice');
      expect(action.title).toBe('Practice five questions.');
      expect(action.reason).toBe(
        "It only takes a few minutes, and every answer you give builds the evidence that you're ready.",
      );
      expect(action.path).toBe('/practice');
    });

    it('outranks explore, which is only what is left once today is done', () => {
      expect(recommendNextAction(input({ hasPractisedToday: false })).kind).toBe(
        'practice',
      );
      expect(recommendNextAction(input({ hasPractisedToday: true })).kind).toBe(
        'explore',
      );
    });

    it('is the answer once the interview date has passed, if today is still empty', () => {
      // E3 moved this case from `explore` to `practice` by inserting a rung,
      // not by reordering one. Deliberately still NOT a count-up: nobody has
      // told us how the interview went, so "your interview was 12 days ago"
      // would be a claim dressed as a countdown (journey-shell.md §10).
      // Inviting them to practise is true either way.
      const action = recommendNextAction(input({ daysUntilInterview: -12 }));

      expect(action.kind).toBe('practice');
      expect(action.title).not.toContain('12');
      expect(action.reason).not.toContain('12');
    });
  });

  describe('explore', () => {
    it('is the fallback for a learner who has already practised today', () => {
      const action = recommendNextAction(input({ hasPractisedToday: true }));

      expect(action.kind).toBe('explore');
      expect(action.title).toBe("You've practiced today.");
      expect(action.path).toBe('/learn');
    });

    it('no longer claims the learning and practice tools are on their way', () => {
      // That sentence became false the moment E3 shipped — and this branch is
      // now only ever reached by someone who has just finished a practice
      // session, which would have made it false to their face.
      const action = recommendNextAction(input({ hasPractisedToday: true }));

      expect(action.reason).not.toContain('on their way');
      expect(action.reason).not.toContain('what’s ready');
      expect(action.reason).not.toContain("what's ready");
    });

    it('is also where a past interview lands once today has been practised', () => {
      const action = recommendNextAction(
        input({ daysUntilInterview: -12, hasPractisedToday: true }),
      );

      expect(action.kind).toBe('explore');
      expect(action.title).not.toContain('12');
    });
  });

  it('is deterministic — two consecutive calls give an identical answer', () => {
    const given = input({ daysUntilInterview: 21 });

    expect(recommendNextAction(given)).toEqual(recommendNextAction(given));
  });
});

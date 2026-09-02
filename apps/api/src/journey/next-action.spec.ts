import {
  NEXT_ACTION_KINDS,
  NEXT_ACTION_PATHS,
  recommendNextAction,
} from './next-action';

// =============================================================================
// nextAction recommender — tests (issue #65, epic #50)
// =============================================================================
//
// Three things are being protected here, in order of how badly they fail:
//
//   1. THE PATH INVARIANT. A next action must never point at a route that
//      redirects to `/` (journey-shell.md §4.1). Enforced structurally by the
//      closed `kind` union; asserted here so the enforcement is visible.
//   2. DETERMINISM. Two consecutive loads must give the same card (ROADMAP §7).
//   3. The branch ordering, which is the contract for which card wins.
// =============================================================================

const ORIENTED_AT = new Date('2026-01-01T12:00:00Z');

/** Every path the recommender is permitted to emit. Real, mounted routes. */
const ALLOWED_PATHS = ['/setup/journey', '/learn'];

describe('recommendNextAction', () => {
  describe('the closed union and its hardcoded paths', () => {
    it('caps kind at the three E1 values', () => {
      expect([...NEXT_ACTION_KINDS]).toEqual([
        'orientation',
        'interview_countdown',
        'explore',
      ]);
    });

    it('maps every kind to one of the verified, non-redirecting routes', () => {
      // `/setup/journey` is mounted OUTSIDE `RequireOrientation`, and `/learn`
      // is a real bar destination that ships in E1. Neither redirects, so a
      // learner tapping the card never lands back where they started.
      for (const kind of NEXT_ACTION_KINDS) {
        expect(ALLOWED_PATHS).toContain(NEXT_ACTION_PATHS[kind]);
      }
    });

    it('exposes the path map frozen, so nothing can repoint it at runtime', () => {
      expect(Object.isFrozen(NEXT_ACTION_PATHS)).toBe(true);
    });

    it.each([
      [{ orientationCompletedAt: null, daysUntilInterview: null }],
      [{ orientationCompletedAt: null, daysUntilInterview: 5 }],
      [{ orientationCompletedAt: ORIENTED_AT, daysUntilInterview: 30 }],
      [{ orientationCompletedAt: ORIENTED_AT, daysUntilInterview: 0 }],
      [{ orientationCompletedAt: ORIENTED_AT, daysUntilInterview: -1 }],
      [{ orientationCompletedAt: ORIENTED_AT, daysUntilInterview: null }],
    ])('never emits a kind or path outside the closed sets (%j)', (input) => {
      const action = recommendNextAction(input);

      expect(NEXT_ACTION_KINDS).toContain(action.kind);
      expect(ALLOWED_PATHS).toContain(action.path);
      expect(action.path).toBe(NEXT_ACTION_PATHS[action.kind]);
      expect(action.title.length).toBeGreaterThan(0);
      expect(action.reason.length).toBeGreaterThan(0);
    });
  });

  describe('orientation', () => {
    it('outranks everything while orientation is unfinished', () => {
      // Even with an interview eight days out: a learner who has not told us
      // which test they take has nothing useful to be told about a countdown.
      const action = recommendNextAction({
        orientationCompletedAt: null,
        daysUntilInterview: 8,
      });

      expect(action.kind).toBe('orientation');
      expect(action.path).toBe('/setup/journey');
      expect(action.title).toBe('Finish setting up your plan.');
    });

    it('answers correctly even though the live gate makes this unreachable', () => {
      // journey-shell.md §4.2: `RequireOrientation` redirects an unoriented
      // learner before Home mounts, so this card never renders in the running
      // product. The function must still be right about the input.
      expect(
        recommendNextAction({
          orientationCompletedAt: null,
          daysUntilInterview: null,
        }).kind,
      ).toBe('orientation');
    });
  });

  describe('interview_countdown', () => {
    it('counts down to an upcoming interview', () => {
      const action = recommendNextAction({
        orientationCompletedAt: ORIENTED_AT,
        daysUntilInterview: 13,
      });

      expect(action.kind).toBe('interview_countdown');
      expect(action.title).toBe('13 days until your interview');
      expect(action.reason).toBe(
        'Start with the material, then build up to full practice.',
      );
      // Points at `/learn`, not `/practice`, until E3 re-points it — see the
      // recommender's header.
      expect(action.path).toBe('/learn');
    });

    it('treats the interview day itself as upcoming, in words', () => {
      const action = recommendNextAction({
        orientationCompletedAt: ORIENTED_AT,
        daysUntilInterview: 0,
      });

      expect(action.kind).toBe('interview_countdown');
      expect(action.title).toBe('Your interview is today.');
    });

    it('does not say "1 days"', () => {
      expect(
        recommendNextAction({
          orientationCompletedAt: ORIENTED_AT,
          daysUntilInterview: 1,
        }).title,
      ).toBe('1 day until your interview');
    });
  });

  describe('explore', () => {
    it('is the answer for an oriented learner with no interview date', () => {
      const action = recommendNextAction({
        orientationCompletedAt: ORIENTED_AT,
        daysUntilInterview: null,
      });

      expect(action.kind).toBe('explore');
      expect(action.title).toBe("See what's here so far.");
      expect(action.path).toBe('/learn');
    });

    it('is the answer once the interview date has passed', () => {
      // Deliberately NOT a count-up. Nobody has told us how the interview
      // went, so "your interview was 12 days ago" would be a claim dressed as
      // a countdown — journey-shell.md §10.
      const action = recommendNextAction({
        orientationCompletedAt: ORIENTED_AT,
        daysUntilInterview: -12,
      });

      expect(action.kind).toBe('explore');
      expect(action.title).not.toContain('12');
    });
  });

  it('is deterministic — two consecutive calls give an identical answer', () => {
    const input = {
      orientationCompletedAt: ORIENTED_AT,
      daysUntilInterview: 21,
    };

    expect(recommendNextAction(input)).toEqual(recommendNextAction(input));
  });
});

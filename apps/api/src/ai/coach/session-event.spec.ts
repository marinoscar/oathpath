import {
  COACH_SESSION_MIXED_RATIO,
  COACH_SESSION_STRONG_RATIO,
  coachEventForSessionSummary,
} from './session-event';
import { COACH_REACTION_EVENTS } from './reaction-lines';

describe('coachEventForSessionSummary', () => {
  it('bands a session by the share it got right', () => {
    expect(coachEventForSessionSummary({ answered: 10, correct: 10 })).toBe(
      'session.complete_strong',
    );
    expect(coachEventForSessionSummary({ answered: 10, correct: 8 })).toBe(
      'session.complete_strong',
    );
    expect(coachEventForSessionSummary({ answered: 10, correct: 7 })).toBe(
      'session.complete_mixed',
    );
    expect(coachEventForSessionSummary({ answered: 10, correct: 5 })).toBe(
      'session.complete_mixed',
    );
    expect(coachEventForSessionSummary({ answered: 10, correct: 4 })).toBe(
      'session.complete_weak',
    );
    expect(coachEventForSessionSummary({ answered: 10, correct: 0 })).toBe(
      'session.complete_weak',
    );
  });

  it('treats each cutoff as inclusive of its own band', () => {
    // Stated as an assertion rather than left to the reader of a `>=`: the
    // band a learner lands in at exactly 80% is the better one, deliberately.
    const answered = 100;

    expect(
      coachEventForSessionSummary({
        answered,
        correct: answered * COACH_SESSION_STRONG_RATIO,
      }),
    ).toBe('session.complete_strong');

    expect(
      coachEventForSessionSummary({
        answered,
        correct: answered * COACH_SESSION_MIXED_RATIO,
      }),
    ).toBe('session.complete_mixed');
  });

  it('calls an empty session weak rather than strong', () => {
    // The degenerate case a ratio cannot answer: 0/0 is not 100%. `weak` is
    // the honest band, and its lines are the ones written to point forward.
    expect(coachEventForSessionSummary({ answered: 0, correct: 0 })).toBe(
      'session.complete_weak',
    );
  });

  it('only ever returns an event the bank has a cell for', () => {
    for (let answered = 0; answered <= 20; answered += 1) {
      for (let correct = 0; correct <= answered; correct += 1) {
        expect(COACH_REACTION_EVENTS).toContain(
          coachEventForSessionSummary({ answered, correct }),
        );
      }
    }
  });

  it('is pure — the same summary always bands the same way', () => {
    const summary = { answered: 7, correct: 4 };

    expect(coachEventForSessionSummary(summary)).toBe(
      coachEventForSessionSummary(summary),
    );
  });
});

import {
  COACH_CORRECT_RUN_THRESHOLD,
  coachCorrectRunLengths,
  coachEventForAttempt,
  type CoachAttemptFacts,
} from './attempt-event';
import { COACH_REACTION_EVENTS } from './reaction-lines';

/** A plain correct, exactly-graded attempt. Every case below varies from this. */
function facts(overrides: Partial<CoachAttemptFacts> = {}): CoachAttemptFacts {
  return {
    outcome: 'correct',
    gradingMethod: 'exact',
    failureCause: null,
    correctRunLength: 1,
    ...overrides,
  };
}

describe('coachEventForAttempt', () => {
  it('maps each outcome to its own event', () => {
    expect(coachEventForAttempt(facts({ outcome: 'correct' }))).toBe(
      'answer.correct',
    );
    expect(coachEventForAttempt(facts({ outcome: 'partial' }))).toBe(
      'answer.partial',
    );
    expect(coachEventForAttempt(facts({ outcome: 'incorrect' }))).toBe(
      'answer.incorrect',
    );
    expect(coachEventForAttempt(facts({ outcome: 'skipped' }))).toBe(
      'answer.skipped',
    );
  });

  it('only ever returns an event the bank has a cell for', () => {
    // Totality against the CLOSED set, not against "some string". A mapper
    // that returned an event the bank does not carry would fall through to
    // `select-line`'s neutral fallback and the learner would silently get the
    // same flat sentence this epic exists to replace.
    const every: CoachAttemptFacts[] = [];
    for (const outcome of ['correct', 'partial', 'incorrect', 'skipped'] as const) {
      for (const gradingMethod of ['exact', 'self', 'ai'] as const) {
        for (const failureCause of [null, 'misheard', 'not_known', 'unknown']) {
          for (const correctRunLength of [0, 1, 2, 3, 9]) {
            every.push({ outcome, gradingMethod, failureCause, correctRunLength });
          }
        }
      }
    }

    for (const input of every) {
      expect(COACH_REACTION_EVENTS).toContain(coachEventForAttempt(input));
    }
  });

  describe('misheard outranks the outcome', () => {
    // THE PRECEDENCE THAT MATTERS MOST. A mishearing is a statement about the
    // microphone, never about the speaker (`docs/specs/voice.md` §3), and such
    // a row is `incorrect` in its outcome column — so an outcome-first mapper
    // would tell a learner their answer was wrong when what actually happened
    // is that we did not hear them. That is the floor's first rule.
    it.each(['incorrect', 'partial', 'skipped', 'correct'] as const)(
      'reacts to a misheard %s attempt as misheard, not as its outcome',
      (outcome) => {
        expect(
          coachEventForAttempt(
            facts({ outcome, failureCause: 'misheard', gradingMethod: 'ai' }),
          ),
        ).toBe('answer.misheard');
      },
    );

    it('outranks a self-mark too', () => {
      expect(
        coachEventForAttempt(
          facts({ gradingMethod: 'self', failureCause: 'misheard' }),
        ),
      ).toBe('answer.misheard');
    });

    it('does not fire on any other cause', () => {
      for (const cause of [null, 'not_known', 'not_recalled', 'expression', 'unknown']) {
        expect(
          coachEventForAttempt(
            facts({ outcome: 'incorrect', failureCause: cause, gradingMethod: 'ai' }),
          ),
        ).toBe('answer.incorrect');
      }
    });
  });

  describe('self-marking is its own event', () => {
    it('outranks the correct outcome it produced', () => {
      // The outcome says it counts as right; `gradingMethod` says how it came
      // to be right. Congratulating a self-mark in the words used for a
      // verified match would be congratulating somebody on a matcher's behalf.
      expect(
        coachEventForAttempt(facts({ outcome: 'correct', gradingMethod: 'self' })),
      ).toBe('answer.self_marked');
    });

    it('outranks a long correct run', () => {
      expect(
        coachEventForAttempt(
          facts({ gradingMethod: 'self', correctRunLength: 12 }),
        ),
      ).toBe('answer.self_marked');
    });
  });

  describe('the correct run', () => {
    it('needs the threshold, counting this attempt', () => {
      for (let run = 0; run < COACH_CORRECT_RUN_THRESHOLD; run += 1) {
        expect(coachEventForAttempt(facts({ correctRunLength: run }))).toBe(
          'answer.correct',
        );
      }
      expect(
        coachEventForAttempt(
          facts({ correctRunLength: COACH_CORRECT_RUN_THRESHOLD }),
        ),
      ).toBe('answer.correct_run');
      expect(coachEventForAttempt(facts({ correctRunLength: 25 }))).toBe(
        'answer.correct_run',
      );
    });

    it('turns five in a row into more than one sentence', () => {
      // The epic's own stated failure, as an assertion: five consecutive
      // correct answers must not all draw from the same cell.
      const events = [1, 2, 3, 4, 5].map((correctRunLength) =>
        coachEventForAttempt(facts({ correctRunLength })),
      );

      expect(new Set(events).size).toBeGreaterThan(1);
    });

    it('is not consulted for a non-correct outcome', () => {
      expect(
        coachEventForAttempt(facts({ outcome: 'incorrect', correctRunLength: 9 })),
      ).toBe('answer.incorrect');
    });
  });
});

describe('coachCorrectRunLengths', () => {
  it('counts consecutive correct answers and resets on anything else', () => {
    const runs = coachCorrectRunLengths([
      { id: 'a', outcome: 'correct' },
      { id: 'b', outcome: 'correct' },
      { id: 'c', outcome: 'incorrect' },
      { id: 'd', outcome: 'correct' },
      { id: 'e', outcome: 'skipped' },
      { id: 'f', outcome: 'correct' },
      { id: 'g', outcome: 'correct' },
      { id: 'h', outcome: 'correct' },
    ]);

    expect(runs.get('a')).toBe(1);
    expect(runs.get('b')).toBe(2);
    expect(runs.get('c')).toBe(0);
    expect(runs.get('d')).toBe(1);
    expect(runs.get('e')).toBe(0);
    expect(runs.get('f')).toBe(1);
    expect(runs.get('g')).toBe(2);
    expect(runs.get('h')).toBe(3);
  });

  it('gives every attempt an entry, including the non-correct ones', () => {
    const attempts = [
      { id: 'a', outcome: 'incorrect' },
      { id: 'b', outcome: 'partial' },
    ];

    const runs = coachCorrectRunLengths(attempts);

    expect(runs.size).toBe(attempts.length);
    expect(runs.get('a')).toBe(0);
    expect(runs.get('b')).toBe(0);
  });

  it('is empty for a session with no attempts', () => {
    expect(coachCorrectRunLengths([]).size).toBe(0);
  });

  it('is pure — the same input twice gives the same map', () => {
    // The determinism the live screen and the summary re-read both depend on
    // starts here: if this disagreed between calls, the two surfaces would
    // disagree about whether a learner was on a run.
    const attempts = [
      { id: 'a', outcome: 'correct' },
      { id: 'b', outcome: 'correct' },
    ];

    expect([...coachCorrectRunLengths(attempts)]).toEqual([
      ...coachCorrectRunLengths(attempts),
    ]);
  });
});

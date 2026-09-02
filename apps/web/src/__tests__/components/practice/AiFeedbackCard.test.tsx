/**
 * `AiFeedbackCard` and the failure-cause copy table (issue #125, epic #53).
 *
 * Two rules are load-bearing here, and every test below defends one of them.
 *
 *  1. **THE RAW ENUM VALUE NEVER REACHES THE SCREEN.** `not_recalled` is a
 *     column value; rendered as-is it is a machine telling somebody they were
 *     "not_recalled". Each cause therefore gets its own case asserting the
 *     plain copy is present AND that no member of `FAILURE_CAUSE_KEYS` appears
 *     anywhere in the DOM.
 *
 *  2. **A DETERMINISTICALLY GRADED ATTEMPT INVENTS NOTHING.** Rung 3 of
 *     `ai-evaluation.md` §6 falls back to `gradingMethod: 'exact'` when the AI
 *     call is unavailable or fails, so "exact" covers both "the matcher
 *     matched" and "no AI opinion exists". Rendering a cause on either is the
 *     "manufactured diagnosis" §8 rejects by name — a confident story about a
 *     learner's own mind that no grader ever told.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AiFeedbackCard } from '../../../components/practice/AiFeedbackCard';
import { AttemptReview } from '../../../components/practice/AttemptReview';
import {
  FAILURE_CAUSE_KEYS,
  failureCauseCopy,
} from '../../../components/practice/failureCause';
import type {
  PracticeAttempt,
  PracticeFailureCause,
  PracticeGradingMethod,
  PracticeOutcome,
} from '../../../types';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function makeAttempt(overrides: Partial<PracticeAttempt> = {}): PracticeAttempt {
  return {
    id: 'attempt-1',
    sessionId: 'session-1',
    questionId: 'question-1',
    question: {
      id: 'question-1',
      number: 1,
      prompt: 'What is the supreme law of the land?',
      categoryId: 'category-1',
      dynamicScope: 'none',
    },
    source: 'practice',
    inputMode: 'typed',
    promptMode: 'read',
    responseText: 'the rules everyone follows',
    outcome: 'incorrect',
    gradingMethod: 'exact',
    revealed: false,
    hintUsed: false,
    durationMs: 4200,
    failureCause: null,
    aiFeedback: null,
    aiUsageEventId: null,
    answeredAt: '2026-03-01T12:00:00.000Z',
    answerSnapshot: {
      resolvedAt: '2026-03-01T12:00:00.000Z',
      answerResolution: 'resolved',
      resolvedForStateCode: null,
      answers: [
        {
          id: 'answer-1',
          text: 'the Constitution',
          sort: 0,
          stateCode: null,
          verifiedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
    ...overrides,
  };
}

/** An attempt the AI grading rung actually produced a verdict for. */
function aiGraded(
  failureCause: PracticeFailureCause,
  feedback = 'Try naming the document itself.',
  outcome: PracticeOutcome = 'incorrect',
): PracticeAttempt {
  return makeAttempt({
    outcome,
    gradingMethod: 'ai',
    failureCause,
    aiFeedback: {
      verdict: outcome === 'correct' ? 'correct' : 'incorrect',
      failureCause,
      feedback,
    },
    aiUsageEventId: 'usage-1',
  });
}

/** Every raw enum value, asserted absent from the rendered document. */
function expectNoRawEnumValues() {
  const text = document.body.textContent ?? '';
  for (const key of FAILURE_CAUSE_KEYS) {
    expect(text).not.toContain(key);
  }
}

// -----------------------------------------------------------------------------
// The copy table itself
// -----------------------------------------------------------------------------

describe('the failure-cause copy table', () => {
  it('covers every value of the union, with nothing missing', () => {
    // The table is a TOTAL `Record<PracticeFailureCause, …>`, so the compiler
    // already refuses a missing key. This asserts the other half — that the six
    // the database has are the six that are here — which is what would catch a
    // cause being added to the enum and quietly rendered as nothing.
    expect([...FAILURE_CAUSE_KEYS].sort()).toEqual([
      'expression',
      'misheard',
      'nervous',
      'not_known',
      'not_recalled',
      'unknown',
    ]);
  });

  it('never uses a raw enum value as its own copy', () => {
    for (const key of FAILURE_CAUSE_KEYS) {
      const copy = failureCauseCopy[key];
      expect(copy.headline).not.toContain(key);
      expect(copy.detail).not.toContain(key);
      // A sentence, not a label — see `failureCause.ts`.
      expect(copy.headline.length).toBeGreaterThan(10);
      expect(copy.detail.length).toBeGreaterThan(20);
    }
  });

  it('names `expression` as a win, not a deficiency', () => {
    // THE CAUSE THIS PRODUCT EXISTS FOR (`ai-evaluation.md` §8). The learner
    // knew the civics and the English got in the way, and the copy has to lead
    // with the fact rather than with the grammar.
    expect(failureCauseCopy.expression.headline).toMatch(/you knew this/i);
  });
});

// -----------------------------------------------------------------------------
// One case per cause
// -----------------------------------------------------------------------------

describe('AiFeedbackCard — one case per failure cause', () => {
  for (const cause of FAILURE_CAUSE_KEYS) {
    it(`renders plain language for ${cause}, and never the value itself`, () => {
      render(<AiFeedbackCard attempt={aiGraded(cause)} />);

      expect(screen.getByText(failureCauseCopy[cause].headline)).toBeInTheDocument();
      expect(screen.getByText(failureCauseCopy[cause].detail)).toBeInTheDocument();
      expectNoRawEnumValues();
    });
  }

  it('renders the grader’s one line of coaching under the cause', () => {
    render(
      <AiFeedbackCard
        attempt={aiGraded('not_recalled', 'You named a different branch of government.')}
      />,
    );

    expect(
      screen.getByText('You named a different branch of government.'),
    ).toBeInTheDocument();
  });

  it('shows the coaching line for a correct AI verdict, which carries no cause', () => {
    // §6 rung 2: a `correct` verdict has nothing to explain, so the API writes
    // no `failureCause`. The sentence is still worth reading.
    const attempt = makeAttempt({
      outcome: 'correct',
      gradingMethod: 'ai',
      failureCause: null,
      aiFeedback: {
        verdict: 'correct',
        failureCause: 'unknown',
        feedback: 'That means the same as the accepted answer.',
      },
    });

    render(<AiFeedbackCard attempt={attempt} />);

    expect(
      screen.getByText('That means the same as the accepted answer.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(failureCauseCopy.unknown.headline),
    ).not.toBeInTheDocument();
  });

  it('says nothing about a cause it has never heard of', () => {
    // A newer server writing a seventh value. `null` from the lookup means
    // RENDER NOTHING — never the value, never a placeholder.
    const attempt = makeAttempt({
      gradingMethod: 'ai',
      failureCause: 'distracted' as PracticeFailureCause,
      aiFeedback: {
        verdict: 'incorrect',
        failureCause: 'unknown',
        feedback: 'Have another look at the answer below.',
      },
    });

    render(<AiFeedbackCard attempt={attempt} />);

    expect(document.body.textContent).not.toContain('distracted');
    // The coaching sentence still stands: it came from the grader, and the
    // unrenderable cause is the only thing that is missing.
    expect(
      screen.getByText('Have another look at the answer below.'),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// The rule that matters most
// -----------------------------------------------------------------------------

describe('AiFeedbackCard — a deterministic grade invents nothing', () => {
  it('shows the plain verdict and no cause for an exact-graded miss', () => {
    render(<AiFeedbackCard attempt={makeAttempt()} />);

    expect(screen.getByText('Not a match')).toBeInTheDocument();
    expect(
      screen.getByText('That doesn’t match an accepted answer.'),
    ).toBeInTheDocument();

    // No diagnosis of any kind — not one of the six headlines is present.
    for (const key of FAILURE_CAUSE_KEYS) {
      expect(
        screen.queryByText(failureCauseCopy[key].headline),
      ).not.toBeInTheDocument();
    }
    expectNoRawEnumValues();
  });

  it.each<PracticeGradingMethod>(['exact', 'self'])(
    'renders no cause and no coaching for a %s grade, even if the row carries them',
    (gradingMethod) => {
      // The gate is `gradingMethod === 'ai'` FIRST, and the fields second. A
      // row that somehow carried both — a future write path, a stale cache, a
      // hand-edited fixture — must still render nothing, because nothing
      // diagnosed this learner.
      const attempt = makeAttempt({
        gradingMethod,
        outcome: gradingMethod === 'self' ? 'correct' : 'incorrect',
        failureCause: 'expression',
        aiFeedback: {
          verdict: 'incorrect',
          failureCause: 'expression',
          feedback: 'A sentence no grader on this attempt ever produced.',
        },
      });

      render(<AiFeedbackCard attempt={attempt} />);

      expect(
        screen.queryByText(failureCauseCopy.expression.headline),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText('A sentence no grader on this attempt ever produced.'),
      ).not.toBeInTheDocument();
      expectNoRawEnumValues();
    },
  );

  it('still names the self-mark, which is a fact about who decided', () => {
    render(
      <AiFeedbackCard
        attempt={makeAttempt({ gradingMethod: 'self', outcome: 'correct' })}
      />,
    );

    expect(
      screen.getByText('You marked this one correct yourself.'),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// The same judgement, twice
// -----------------------------------------------------------------------------

describe('the summary review shows the judgement the learner saw live', () => {
  it('renders the same cause and coaching on a review row', () => {
    const attempt = aiGraded('expression', 'Your meaning was right.');

    render(
      <ul>
        <AttemptReview attempt={attempt} />
      </ul>,
    );

    expect(
      screen.getByText(failureCauseCopy.expression.headline),
    ).toBeInTheDocument();
    expect(screen.getByText('Your meaning was right.')).toBeInTheDocument();
    expect(screen.getByText('Graded by the assistant.')).toBeInTheDocument();
    expectNoRawEnumValues();
  });

  it('states the verdict exactly once on a review row', () => {
    // The row header already carries the verdict chip; the shared card is
    // mounted with `includeVerdict={false}` so one judgement does not read as
    // two.
    render(
      <ul>
        <AttemptReview attempt={aiGraded('not_known')} />
      </ul>,
    );

    expect(screen.getAllByText('Not a match')).toHaveLength(1);
  });

  it('adds nothing at all to an ordinary exact-graded review row', () => {
    render(
      <ul>
        <AttemptReview attempt={makeAttempt()} />
      </ul>,
    );

    expect(screen.getByText('Not a match')).toBeInTheDocument();
    expect(screen.queryByText('Graded by the assistant.')).not.toBeInTheDocument();
    expectNoRawEnumValues();
  });
});

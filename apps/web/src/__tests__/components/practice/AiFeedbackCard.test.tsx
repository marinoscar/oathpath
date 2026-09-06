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
 *
 * ADJUSTED BY #358 (epic #345) in three places, and only where this card
 * DELIBERATELY changed:
 *
 *  * The verdict is now the chip alone. `outcomeDisplay`'s `detail` sentence
 *    was deleted, so the assertions that read it are gone with it.
 *  * The provenance note ("Graded by the assistant.") lives behind a "How this
 *    was graded" disclosure, so the tests that read it open the disclosure
 *    first — which is itself the assertion that it is no longer stacked on
 *    every verdict.
 *  * The coach's reaction no longer carries a `role="status"` of its own; on
 *    the live screen it sits inside `PracticeSessionPage`'s one live region.
 *    The tests that used `getByRole('status')` as a handle on the line now
 *    address it by its text.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AiFeedbackCard } from '../../../components/practice/AiFeedbackCard';
import { AttemptReview } from '../../../components/practice/AttemptReview';
import {
  FAILURE_CAUSE_KEYS,
  failureCauseCopy,
} from '../../../components/practice/failureCause';
import type {
  CoachPersona,
  PracticeAttempt,
  PracticeFailureCause,
  PracticeGradingMethod,
  PracticeOutcome,
} from '../../../types';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

/**
 * Open the "How this was graded" disclosure and hand back what it revealed.
 *
 * Every call is also an assertion that the disclosure EXISTS — which is the
 * half of #358 that would otherwise decay quietly: the prose could drift back
 * out from behind it and every text assertion below would still pass.
 */
async function openGradingDetails() {
  const user = userEvent.setup();
  const toggle = screen.getByRole('button', { name: /how this was graded/i });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

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
    // The E9 voice columns, at their pre-voice values: every attempt written
    // before this epic — and every typed one after it — reads exactly this.
    transcript: null,
    asrConfidence: null,
    retryOfAttemptId: null,
    // Reactions off by default in the fixture, so every pre-existing test
    // below keeps asserting exactly the card it was written against. The
    // coach's own cases opt in explicitly.
    coachReaction: null,
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
    // AND NOTHING RESTATES IT (#358). The chip is the verdict; the sentence
    // that used to sit beside it said the same thing again in prose, with the
    // coach's line sandwiched between the two.
    expect(document.body.textContent).not.toMatch(/accepted answer\./i);

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

  it('still names the self-mark, which is a fact about who decided', async () => {
    render(
      <AiFeedbackCard
        attempt={makeAttempt({ gradingMethod: 'self', outcome: 'correct' })}
      />,
    );

    // NOT ON THE VERDICT ITSELF (#358) — available, when it is asked for.
    expect(
      screen.queryByText('You marked this one correct yourself.'),
    ).not.toBeInTheDocument();

    await openGradingDetails();

    expect(
      screen.getByText('You marked this one correct yourself.'),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// The same judgement, twice
// -----------------------------------------------------------------------------

describe('the summary review shows the judgement the learner saw live', () => {
  it('renders the same cause and coaching on a review row', async () => {
    const attempt = aiGraded('expression', 'Your meaning was right.');

    render(
      <ul>
        <AttemptReview attempt={attempt} />
      </ul>,
    );

    // The DIAGNOSIS is not behind the disclosure and must not be: something
    // actually ran on this attempt and produced it. Only the provenance note
    // — who decided — moved (#358).
    expect(
      screen.getByText(failureCauseCopy.expression.headline),
    ).toBeInTheDocument();
    expect(screen.getByText('Your meaning was right.')).toBeInTheDocument();

    await openGradingDetails();
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

// -----------------------------------------------------------------------------
// The coach's reaction (issue #321, epic #305)
// -----------------------------------------------------------------------------
//
// Three claims, and the first two are the ones that would decay quietly:
//
//  1. The reaction renders on a DETERMINISTICALLY graded attempt. That is the
//     common case, it has no `aiFeedback` at all, and before this epic it left
//     the card saying nothing but the verdict — so if this regressed, the
//     feature would be silently absent exactly where it was needed, and every
//     other test here would still pass.
//
//  2. The verdict never wears the personality. If a persona ever changed the
//     chip, the product would be dressing up an assessment to match a tone
//     preference — and it would be invisible, because the wording changed too.
//
//  3. The live screen and the summary review show the same line. That is the
//     whole reason `AiFeedbackCard` is one component, and the reaction is the
//     first thing it renders that is chosen from more than one candidate.
// -----------------------------------------------------------------------------

const REACTION = 'Not quite right — but you can get it next time.';

function withReaction(
  persona: CoachPersona = 'supportive',
  text: string = REACTION,
  overrides: Partial<PracticeAttempt> = {},
): PracticeAttempt {
  return makeAttempt({ coachReaction: { text, persona }, ...overrides });
}

describe('AiFeedbackCard — the coach reaction', () => {
  it('renders on an exact-graded attempt, which has no AI feedback at all', () => {
    // THE HEADLINE ASSERTION. `gradingMethod: 'exact'` is the case every other
    // coaching field on this card is deliberately null for.
    const attempt = withReaction();

    expect(attempt.gradingMethod).toBe('exact');
    expect(attempt.aiFeedback).toBeNull();

    render(<AiFeedbackCard attempt={attempt} />);

    expect(screen.getByText(REACTION)).toBeInTheDocument();
  });

  it('renders on a self-marked attempt too', () => {
    render(
      <AiFeedbackCard
        attempt={withReaction('playful', 'Counted! Take the point.', {
          outcome: 'correct',
          gradingMethod: 'self',
        })}
      />,
    );

    expect(screen.getByText('Counted! Take the point.')).toBeInTheDocument();
  });

  it('renders nothing when the learner has reactions off', () => {
    // `null`, not an empty string: the card must not reserve space for a line
    // that is never coming.
    const { container } = render(
      <AiFeedbackCard attempt={makeAttempt({ coachReaction: null })} />,
    );

    expect(screen.queryByText(REACTION)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain(REACTION);
  });

  it('renders nothing for a whitespace-only line', () => {
    const { container } = render(
      <AiFeedbackCard attempt={withReaction('supportive', '   ')} />,
    );

    // No paragraph reserved for a line that never came: the only Typography in
    // an exact-graded card with no reaction is nothing at all.
    expect(container.querySelectorAll('.MuiTypography-root')).toHaveLength(0);
  });

  it('leaves the verdict chip byte-identical across every persona', () => {
    // Asserted over all four, on the same attempt otherwise. `VISION.md`
    // Principle #11: a beautiful wrong answer is still wrong.
    const personas: CoachPersona[] = [
      'supportive',
      'academic',
      'playful',
      'unfiltered',
    ];

    const rendered = personas.map((persona) => {
      const { unmount } = render(
        <AiFeedbackCard attempt={withReaction(persona, `line for ${persona}`)} />,
      );
      const chip = screen.getByText('Not a match');
      const result = { label: chip.textContent, className: chip.className };
      unmount();
      return result;
    });

    for (const one of rendered) {
      expect(one).toEqual(rendered[0]);
    }
  });

  it('leaves the announcing to its host, and adds no heading to the outline', () => {
    render(<AiFeedbackCard attempt={withReaction()} />);

    // NO REGION OF ITS OWN SINCE #358. On the live screen this card renders
    // inside `PracticeSessionPage`'s one `role="status"` region, which is what
    // announces the line when it arrives with the grade; a region here would
    // be a live region nested in a live region, read twice. The page's own
    // suite asserts the announcement end to end.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText(REACTION)).toBeInTheDocument();

    // The card's heading order belongs to the cause block. A coach's aside
    // must not insert itself into the document outline — `h6` here is a SIZE,
    // and the element is still a `<p>`.
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByText(REACTION).tagName).toBe('P');
  });

  it('is the most prominent sentence in the block', () => {
    // MEASURED AGAINST ITS SIBLINGS, not asserted as a class name in
    // isolation: what #358 asks for is that nothing in the feedback block
    // outweighs the coach's line, and a rule that only checks the line itself
    // would pass on the day something louder is added beside it.
    const RANK: Record<string, number> = {
      h1: 7, h2: 6, h3: 5, h4: 4, h5: 3, h6: 2,
      subtitle1: 1, subtitle2: 1,
      body1: 0, body2: -1, caption: -2, overline: -2,
    };

    const { container } = render(
      <AiFeedbackCard
        attempt={withReaction('academic', REACTION, {
          gradingMethod: 'ai',
          failureCause: 'expression',
          aiFeedback: {
            verdict: 'incorrect',
            failureCause: 'expression',
            feedback: 'A sentence from the grader.',
          },
        })}
      />,
    );

    const reaction = screen.getByText(REACTION);
    const rankOf = (el: Element) => {
      const variant = Array.from(el.classList)
        .map((name) => /^MuiTypography-(\w+)$/.exec(name)?.[1])
        .find((v) => v && v in RANK);
      return variant ? RANK[variant] : Number.NEGATIVE_INFINITY;
    };

    expect(rankOf(reaction)).toBe(RANK.h6);
    for (const other of container.querySelectorAll('.MuiTypography-root')) {
      if (other === reaction) continue;
      expect(rankOf(other)).toBeLessThan(rankOf(reaction));
    }
  });

  it('shows the same line live and on the summary review', () => {
    const attempt = withReaction('unfiltered', 'That answer was a mess.');

    const live = render(<AiFeedbackCard attempt={attempt} />);
    const liveText = screen.getByText('That answer was a mess.').textContent;
    live.unmount();

    render(
      <ul>
        <AttemptReview attempt={attempt} />
      </ul>,
    );

    expect(screen.getByText('That answer was a mess.').textContent).toBe(liveText);
  });

  it('renders on a review row that would otherwise have nothing to say', () => {
    // The early-return case: an exact-graded row on the summary has no
    // provenance, no cause and no coaching, so the card returns null — unless
    // there is a reaction, which there now is.
    render(
      <ul>
        <AttemptReview attempt={withReaction()} />
      </ul>,
    );

    expect(screen.getByText(REACTION)).toBeInTheDocument();
  });

  it('never renders the line as markup', () => {
    render(
      <AiFeedbackCard
        attempt={withReaction('playful', '<em>not</em> markup & fine')}
      />,
    );

    const line = screen.getByText('<em>not</em> markup & fine');
    expect(line.textContent).toBe('<em>not</em> markup & fine');
    expect(line.querySelector('em')).toBeNull();
  });
});

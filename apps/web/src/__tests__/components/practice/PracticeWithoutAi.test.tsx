/**
 * The practice loop with AI unavailable (issue #125, epic #53).
 *
 * =============================================================================
 * E4 IS ADDITIVE. E3's SCREENS MUST STILL WORK WITH NOTHING BEHIND THEM.
 * =============================================================================
 *
 * `ai-evaluation.md` §6 rung 3 makes this a contract rather than an aspiration:
 * an unavailable, failed or schema-invalid grading call falls back to the
 * deterministic verdict, persists `gradingMethod: 'exact'`, and answers **200,
 * never a 5xx** — "a learner mid-practice-session is not the audience for a
 * stack trace". A deployment whose administrator has not finished configuring
 * AI, or whose provider is down, is a deployment where people can still study.
 *
 * So this file asserts the loop from the components a learner actually presses:
 * the verdict is there, the accepted answers are there, the self-mark is there,
 * Next still moves on — and the one AI surface says plainly why it is not
 * offering anything, using the shared `AiNotReady` (#43) rather than a spinner,
 * an error, or nothing at all.
 *
 * It is deliberately a COMPONENT-level test in its own file: the page-level
 * suites for `/practice` belong to their own files, and a second harness for
 * the same page would be two fixtures to keep in step.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { AttemptFeedback } from '../../../components/practice/AttemptFeedback';
import { ExplainPanel } from '../../../components/ai/ExplainPanel';
import { AiStatusProvider } from '../../../contexts/AiStatusContext';
import { AuthContext } from '../../../contexts/AuthContext';
import { FAILURE_CAUSE_KEYS } from '../../../components/practice/failureCause';
import { mockUser } from '../../utils/test-utils';
import type { AiStatus, PracticeAttemptResult } from '../../../types';

const NOT_READY: AiStatus = {
  userKeyConfigured: true,
  systemReady: false,
  enabled: true,
  providerConfigured: true,
  unboundRoles: ['tutor', 'grader'],
};

/**
 * A miss whose grading call never happened — rung 3's fallback, which is
 * INDISTINGUISHABLE ON THE ROW from an ordinary exact-match miss, and
 * deliberately so.
 */
const RESULT: PracticeAttemptResult = {
  attempt: {
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
    responseText: 'the big rules',
    outcome: 'incorrect',
    gradingMethod: 'exact',
    revealed: true,
    hintUsed: false,
    durationMs: 3100,
    failureCause: null,
    aiFeedback: null,
    aiUsageEventId: null,
    // The E9 voice columns, at their pre-voice values: every attempt written
    // before this epic — and every typed one after it — reads exactly this.
    transcript: null,
    asrConfidence: null,
    retryOfAttemptId: null,
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
  },
  acceptedAnswers: [
    {
      id: 'answer-1',
      text: 'the Constitution',
      sort: 0,
      stateCode: null,
      verifiedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  nextQuestion: {
    id: 'question-2',
    number: 2,
    prompt: 'What does the Constitution do?',
    categoryId: 'category-1',
    dynamicScope: 'none',
  },
  progress: { planned: 5, answered: 1, remaining: 4 },
};

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/ai/status')) {
      return new Response(JSON.stringify({ data: NOT_READY }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Nothing else may be called. An explanation request from a blocked panel
    // would be a charge on the learner's key for a call that cannot succeed.
    throw new Error(`unexpected request: ${String(input)}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function renderWithAiStatus(ui: React.ReactNode) {
  const auth = {
    user: mockUser,
    isLoading: false,
    isAuthenticated: true,
    providers: [],
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  };

  return render(
    <AuthContext.Provider value={auth as never}>
      <MemoryRouter>
        <AiStatusProvider>{ui}</AiStatusProvider>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('the practice loop with AI unavailable', () => {
  it('shows the verdict, the answers and the way onward, unchanged', async () => {
    const onNext = vi.fn();
    const user = userEvent.setup();

    renderWithAiStatus(
      <AttemptFeedback
        result={RESULT}
        onNext={onNext}
        nextLabel="Next question"
        onSelfMark={vi.fn()}
        selfMarking={false}
        selfMarkError={null}
      />,
    );

    // The verdict, from the deterministic matcher.
    expect(screen.getByText('Not a match')).toBeInTheDocument();
    // The answers, which is the whole reason the screen exists.
    expect(screen.getByText('the Constitution')).toBeInTheDocument();
    // And the loop keeps moving.
    await user.click(screen.getByRole('button', { name: 'Next question' }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('invents no diagnosis when no grader ran', () => {
    renderWithAiStatus(
      <AttemptFeedback
        result={RESULT}
        onNext={vi.fn()}
        nextLabel="Next question"
        onSelfMark={vi.fn()}
        selfMarking={false}
        selfMarkError={null}
      />,
    );

    // Rung 3's fallback is `gradingMethod: 'exact'` with all three AI columns
    // NULL. Nothing analysed this answer, so nothing on screen says it did.
    const text = document.body.textContent ?? '';
    for (const key of FAILURE_CAUSE_KEYS) expect(text).not.toContain(key);
    expect(screen.queryByText('Graded by the assistant.')).not.toBeInTheDocument();
  });

  it('keeps the self-mark, which needs no AI at all', async () => {
    const onSelfMark = vi.fn();
    const user = userEvent.setup();

    renderWithAiStatus(
      <AttemptFeedback
        result={RESULT}
        onNext={vi.fn()}
        nextLabel="Next question"
        onSelfMark={onSelfMark}
        selfMarking={false}
        selfMarkError={null}
      />,
    );

    await user.click(screen.getByRole('button', { name: /i was right/i }));
    expect(onSelfMark).toHaveBeenCalledTimes(1);
  });

  it('explains the missing Explain action instead of hiding it', async () => {
    renderWithAiStatus(<ExplainPanel questionId="question-1" />);

    expect(
      await screen.findByText(/This is not a problem with your key/i),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /explain this answer/i }),
      ).toBeDisabled(),
    );
    // Not a spinner, and not a silent absence.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

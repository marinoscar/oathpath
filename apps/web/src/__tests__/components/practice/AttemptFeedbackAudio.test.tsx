/**
 * The accepted answer is read aloud too (#287, epic #280).
 *
 * With epic #280's auto-submit a learner can ask and answer entirely by voice,
 * and then had to LOOK at the screen to find out what the right answer was. The
 * real interview is spoken in both directions.
 *
 * What this suite protects, in the order the issue states it:
 *
 *  1. The control is on EVERY revealed answer — a graded attempt, a skip, and
 *     "Show me the answer". Those are the three paths that reach this
 *     component, and none of them is a case where hearing the answer is worth
 *     less.
 *  2. Auto-play is a preference AND a gesture. With `readAnswersAloud` off it
 *     never speaks by itself; with it on but no gesture yet it stays SILENT and
 *     shows NO error, because a browser refusing sound to a page nobody has
 *     touched is not a failure.
 *  3. An unbound `speak` is not a degraded state (`voice.md` §2): the browser's
 *     own voice reads the answer and NOTHING anywhere explains itself.
 *  4. With no speech synthesis at all the control is ABSENT, not disabled, and
 *     the answer text on the page is untouched.
 *  5. Several accepted answers are not concatenated — the FIRST is spoken, the
 *     one `AcceptedAnswers` presents as canonical.
 *
 * Every query here is role+name or scoped to the region it means: the same copy
 * ("Stop reading") is shared with the question's player, and a bare `getByText`
 * would pass for the wrong control.
 */

import { ThemeProvider } from '@mui/material/styles';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttemptFeedback } from '../../../components/practice/AttemptFeedback';
import { AiStatusProvider } from '../../../contexts/AiStatusContext';
import { lightTheme } from '../../../theme';
import type {
  AiStatus,
  PracticeAttempt,
  PracticeAttemptResult,
  PracticeQuestion,
  PracticeSnapshotAnswer,
} from '../../../types';
import { server } from '../../mocks/server';

// -----------------------------------------------------------------------------
// The browser's own voice. jsdom ships none.
// -----------------------------------------------------------------------------

interface FakeUtterance {
  text: string;
  rate: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

let spoken: FakeUtterance[] = [];
let cancels = 0;

function installSpeechSynthesis() {
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      cancel: vi.fn(() => {
        cancels += 1;
      }),
      speak: vi.fn((utterance: FakeUtterance) => {
        spoken.push(utterance);
        // A real engine fires `start` when sound actually begins.
        utterance.onstart?.();
      }),
    },
    configurable: true,
  });
  (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    class {
      text: string;
      rate = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    };
}

let statusCalls = 0;
let synthesizeCalls = 0;

function mockStatus(overrides: Partial<AiStatus> = {}) {
  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    unboundRoles: [],
    ...overrides,
  };
  server.use(
    http.get('*/api/ai/status', () => {
      statusCalls += 1;
      return HttpResponse.json({ data: status });
    }),
    http.post('*/api/ai/speech/synthesize', () => {
      synthesizeCalls += 1;
      return HttpResponse.arrayBuffer(new ArrayBuffer(8), {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),
  );
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const QUESTION: PracticeQuestion = {
  id: 'question-1',
  number: 1,
  prompt: 'What is the supreme law of the land?',
  categoryId: 'category-1',
  dynamicScope: 'none',
};

const ANSWER: PracticeSnapshotAnswer = {
  id: 'answer-1',
  text: 'the Constitution',
  sort: 0,
  stateCode: null,
  verifiedAt: '2026-01-01T00:00:00.000Z',
};

function makeAttempt(overrides: Partial<PracticeAttempt> = {}): PracticeAttempt {
  return {
    id: 'attempt-1',
    sessionId: 'session-1',
    questionId: QUESTION.id,
    question: QUESTION,
    source: 'practice',
    inputMode: 'typed',
    promptMode: 'read',
    responseText: 'the big rules',
    outcome: 'incorrect',
    gradingMethod: 'exact',
    revealed: false,
    hintUsed: false,
    durationMs: 4200,
    failureCause: null,
    aiFeedback: null,
    aiUsageEventId: null,
    transcript: null,
    asrConfidence: null,
    retryOfAttemptId: null,
    answeredAt: '2026-03-01T12:01:00.000Z',
    answerSnapshot: {
      resolvedAt: '2026-03-01T12:01:00.000Z',
      answerResolution: 'resolved',
      resolvedForStateCode: null,
      answers: [ANSWER],
    },
    ...overrides,
  };
}

function makeResult(
  attemptOverrides: Partial<PracticeAttempt> = {},
  answers: PracticeSnapshotAnswer[] = [ANSWER],
): PracticeAttemptResult {
  const attempt = makeAttempt({
    ...attemptOverrides,
    answerSnapshot: {
      ...makeAttempt().answerSnapshot,
      ...(attemptOverrides.answerSnapshot ?? {}),
      answers,
    },
  });
  return {
    attempt,
    acceptedAnswers: answers,
    nextQuestion: null,
    progress: { answered: 1, planned: 5 },
  };
}

type FeedbackProps = Parameters<typeof AttemptFeedback>[0];

function renderFeedback(props: Partial<FeedbackProps> = {}) {
  return render(
    <ThemeProvider theme={lightTheme}>
      {/* `StateRequiredNotice` links to the plan, so a router has to be above
          this even on the cases that never render it. */}
      <MemoryRouter>
        <AiStatusProvider>
          <AttemptFeedback
            result={makeResult()}
            onNext={vi.fn()}
            nextLabel="Next question"
            onSelfMark={vi.fn()}
            selfMarking={false}
            selfMarkError={null}
            {...props}
          />
        </AiStatusProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** The answer's own player, by its accessible name. Never `getByText`. */
function answerPlayButton() {
  return screen.getByRole('button', { name: /read the answer aloud/i });
}

function queryAnswerPlayButton() {
  return screen.queryByRole('button', { name: /read the answer aloud/i });
}

beforeEach(() => {
  spoken = [];
  cancels = 0;
  statusCalls = 0;
  synthesizeCalls = 0;
});

afterEach(() => {
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// 1. Wherever the answer is revealed
// -----------------------------------------------------------------------------

describe('the control appears on every revealed answer', () => {
  it.each([
    ['a graded attempt', { outcome: 'incorrect' as const, revealed: false }],
    ['a skip', { outcome: 'skipped' as const, responseText: null, revealed: false }],
    ['"Show me the answer"', { outcome: 'incorrect' as const, revealed: true }],
  ])('renders it after %s', async (_label, overrides) => {
    installSpeechSynthesis();
    mockStatus();

    renderFeedback({ result: makeResult(overrides) });

    const play = answerPlayButton();
    expect(play).toBeInTheDocument();
    expect(play).toBeEnabled();

    await userEvent.click(play);
    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0].text).toBe(ANSWER.text);
  });

  it('is absent where there is no answer text to read', () => {
    installSpeechSynthesis();
    mockStatus();

    // `state_required` shows the notice and NO answer text. Speaking would be
    // inventing content the panel above deliberately withholds.
    renderFeedback({
      result: makeResult({
        answerSnapshot: {
          resolvedAt: '2026-03-01T12:01:00.000Z',
          answerResolution: 'state_required',
          resolvedForStateCode: null,
          answers: [],
        },
      }, []),
    });

    expect(queryAnswerPlayButton()).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// 2. Auto-play: a preference AND a gesture
// -----------------------------------------------------------------------------

describe('auto-play', () => {
  it('reads the answer by itself when the learner asked and a gesture has happened', async () => {
    installSpeechSynthesis();
    mockStatus();

    renderFeedback({ readAnswersAloud: true, hasUserGesture: true });

    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0].text).toBe(ANSWER.text);
    // The live region says what is happening, in the answer's words.
    const status = await screen.findByText('Reading the answer aloud.');
    expect(status).toBeInTheDocument();
  });

  it('stays SILENT and shows NO error with no gesture yet', async () => {
    installSpeechSynthesis();
    mockStatus();

    renderFeedback({ readAnswersAloud: true, hasUserGesture: false });

    await waitFor(() => expect(statusCalls).toBe(1));
    expect(spoken).toHaveLength(0);

    // NOTHING WENT WRONG. A browser withholding sound from a page nobody has
    // touched is the browser working as designed.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/could not be read aloud/i)).toBeNull();
    // …and the control is still there to be pressed.
    expect(answerPlayButton()).toBeEnabled();
  });

  it('does not speak by itself when the preference is off', async () => {
    installSpeechSynthesis();
    mockStatus();

    renderFeedback({ readAnswersAloud: false, hasUserGesture: true });

    await waitFor(() => expect(statusCalls).toBe(1));
    expect(spoken).toHaveLength(0);
    expect(answerPlayButton()).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// 3. `speak` unbound is the ordinary state of a fresh install
// -----------------------------------------------------------------------------

describe('with `speak` unbound', () => {
  it('reads the answer with the browser voice and warns about nothing', async () => {
    installSpeechSynthesis();
    mockStatus({ systemReady: false, unboundRoles: ['speak'] });

    renderFeedback({ premiumVoice: true });
    // Wait for the status, so "called no endpoint" is a decision rather than a
    // race this test happened to win.
    await waitFor(() => expect(statusCalls).toBe(1));

    await userEvent.click(answerPlayButton());
    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0].text).toBe(ANSWER.text);
    expect(synthesizeCalls).toBe(0);

    // `voice.md` §2: nothing is missing, so nothing explains itself. No
    // `AiNotReady`, no alert, no mention of an administrator, anywhere.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/administrator/i)).toBeNull();
    expect(screen.queryByText(/not available yet/i)).toBeNull();
    expect(screen.queryByText(/could not be read aloud/i)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// 4. No speech synthesis at all
// -----------------------------------------------------------------------------

describe('with no speech synthesis in the browser at all', () => {
  it('renders NO control — not a disabled one — and leaves the answer text alone', async () => {
    // Deliberately no `installSpeechSynthesis()`.
    mockStatus();

    renderFeedback({ readAnswersAloud: true, hasUserGesture: true });
    await waitFor(() => expect(statusCalls).toBe(1));

    expect(queryAnswerPlayButton()).toBeNull();
    // Not present-and-disabled, under any name.
    expect(screen.queryByRole('button', { name: /aloud/i })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    // The answer is the content, and it is untouched.
    const heading = screen.getByRole('heading', { level: 3, name: /accepted answer/i });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText(ANSWER.text)).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// 5. The FIRST answer, never a concatenation
// -----------------------------------------------------------------------------

describe('when a question has several accepted answers', () => {
  it('speaks the first one only', async () => {
    installSpeechSynthesis();
    mockStatus();

    const many: PracticeSnapshotAnswer[] = [
      { ...ANSWER, id: 'a1', text: 'the Constitution', sort: 0 },
      { ...ANSWER, id: 'a2', text: 'the supreme law of the land', sort: 1 },
      { ...ANSWER, id: 'a3', text: 'the law of the land', sort: 2 },
    ];

    renderFeedback({ result: makeResult({}, many) });

    await userEvent.click(answerPlayButton());
    await waitFor(() => expect(spoken).toHaveLength(1));

    // Exactly the canonical one — not a paragraph nobody asked to hear.
    expect(spoken[0].text).toBe('the Constitution');
    expect(spoken[0].text).not.toContain('supreme law');

    // …and every alternative is still ON SCREEN, in the list above.
    const list = screen.getByRole('list');
    for (const answer of many) {
      expect(within(list).getByText(answer.text)).toBeInTheDocument();
    }
  });
});

// -----------------------------------------------------------------------------
// 6. The learner's stored voice preferences reach the audio
// -----------------------------------------------------------------------------

describe('the learner’s voice preferences', () => {
  it('applies the stored speech rate on the browser path', async () => {
    installSpeechSynthesis();
    mockStatus();

    renderFeedback({ speechRate: 0.6 });

    await userEvent.click(answerPlayButton());
    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0].rate).toBe(0.6);
  });

  it('takes the premium path only when the learner asked AND `speak` is bound', async () => {
    installSpeechSynthesis();
    mockStatus({ unboundRoles: [] });

    renderFeedback({ premiumVoice: true, preferredVoice: 'alloy' });
    await waitFor(() => expect(statusCalls).toBe(1));

    await userEvent.click(answerPlayButton());
    await waitFor(() => expect(synthesizeCalls).toBe(1));
  });
});

// -----------------------------------------------------------------------------
// 7. Leaving the answer behind silences it
// -----------------------------------------------------------------------------

describe('unmounting', () => {
  it('stops the answer audio', async () => {
    installSpeechSynthesis();
    mockStatus();

    const { unmount } = renderFeedback({
      readAnswersAloud: true,
      hasUserGesture: true,
    });
    await waitFor(() => expect(spoken).toHaveLength(1));

    const before = cancels;
    unmount();
    // `QuestionAudio`'s own cleanup — the answer does not read on over
    // whatever comes next.
    expect(cancels).toBeGreaterThan(before);
  });
});

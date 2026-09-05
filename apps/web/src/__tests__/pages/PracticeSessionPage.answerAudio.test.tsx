/**
 * Hearing the ANSWER on the practice session screen (#287, epic #280).
 *
 * `AttemptFeedbackAudio.test.tsx` covers the control itself. What only the page
 * can answer is how the answer's player and the QUESTION's player behave as one
 * screen, and every assertion here is a way that could go wrong quietly:
 *
 *  1. **Two players, one voice.** The question's mount and the answer's mount
 *     are on screen together, so starting either must silence the other. The
 *     assertion is structural rather than about audio: at most ONE "Stop
 *     reading" button can exist at any instant.
 *  2. **Moving on silences the answer.** Pressing Next unmounts the feedback,
 *     and a sentence still being read over the next question is disorienting.
 *  3. **Nothing records `promptMode: 'heard'` because the ANSWER played.** The
 *     answer is read AFTER the attempt is written, at a question the learner
 *     answered without hearing. `onPlayed` is deliberately not wired on that
 *     mount, and this is the assertion that keeps it that way — a future reader
 *     "fixing" the missing prop fails here rather than in production, where it
 *     would be a wrong row in the one table E5/E6/E7/E8 all read as fact.
 *
 * Queries are role+name throughout. "Stop reading" is shared copy between the
 * two players, which is exactly why it is counted rather than fetched.
 */

import { CssBaseline, ThemeProvider } from '@mui/material';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { AuthContext } from '../../contexts/AuthContext';
import PracticeSessionPage from '../../pages/PracticeSessionPage';
import { lightTheme } from '../../theme';
import type {
  AiStatus,
  PracticeAttempt,
  PracticeAttemptResult,
  PracticeQuestion,
  PracticeSession,
  PracticeSessionDetail,
  RecordPracticeAttemptInput,
} from '../../types';
import { server } from '../mocks/server';
import { mockUser } from '../utils/test-utils';

// -----------------------------------------------------------------------------
// The browser's own voice, which jsdom does not have
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
/** The utterances still "playing", so `cancel()` can interrupt them as a real engine does. */
let live: FakeUtterance[] = [];

function installSpeechSynthesis() {
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      cancel: vi.fn(() => {
        cancels += 1;
        const interrupted = live;
        live = [];
        // A REAL ENGINE REPORTS THE UTTERANCE IT CUT OFF as an error with
        // `canceled`. Faking that is what makes "starting one stops the other"
        // a test of the component rather than of this fake's optimism.
        for (const utterance of interrupted) utterance.onerror?.({ error: 'canceled' });
      }),
      speak: vi.fn((utterance: FakeUtterance) => {
        spoken.push(utterance);
        live.push(utterance);
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

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const API_BASE = '*/api';
const SESSION_ID = 'session-1';
const ACCEPTED = 'the Constitution';

const QUESTION_1: PracticeQuestion = {
  id: 'question-1',
  number: 1,
  prompt: 'What is the supreme law of the land?',
  categoryId: 'category-1',
  dynamicScope: 'none',
};

const QUESTION_2: PracticeQuestion = {
  id: 'question-2',
  number: 2,
  prompt: 'What does the Constitution do?',
  categoryId: 'category-1',
  dynamicScope: 'none',
};

const SESSION_BASE: PracticeSession = {
  id: SESSION_ID,
  kind: 'quick',
  status: 'in_progress',
  testVersionCode: 'v2008',
  categoryId: null,
  plannedCount: 5,
  startedAt: '2026-03-01T12:00:00.000Z',
  completedAt: null,
  summary: null,
};

function makeAttempt(overrides: Partial<PracticeAttempt> = {}): PracticeAttempt {
  return {
    id: 'attempt-1',
    sessionId: SESSION_ID,
    questionId: QUESTION_1.id,
    question: QUESTION_1,
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
      answers: [
        {
          id: 'answer-1',
          text: ACCEPTED,
          sort: 0,
          stateCode: null,
          verifiedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
    ...overrides,
  };
}

interface Options {
  /** `user_settings.voice.readAnswersAloud`. Defaults to on for this suite. */
  readAnswersAloud?: boolean;
  onAttempt?: (input: RecordPracticeAttemptInput) => void;
}

function renderSession(options: Options = {}) {
  const detail: PracticeSessionDetail = {
    session: SESSION_BASE,
    nextQuestion: QUESTION_1,
    progress: { answered: 0, planned: 5 },
    attempts: [],
  };

  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    // `speak` UNBOUND, deliberately: the ordinary state of a fresh install.
    // Everything below therefore runs on the browser's own voice.
    unboundRoles: ['speak'],
  };

  server.use(
    http.get(`${API_BASE}/ai/status`, () => HttpResponse.json({ data: status })),
    http.get(`${API_BASE}/user-settings`, () =>
      HttpResponse.json({
        data: {
          theme: 'system',
          profile: { displayName: null, useProviderImage: true, customImageUrl: null },
          voice: { readAnswersAloud: options.readAnswersAloud ?? true },
          updatedAt: '2026-03-01T12:00:00.000Z',
          version: 1,
        },
      }),
    ),
    http.get(`${API_BASE}/practice/sessions/${SESSION_ID}`, () =>
      HttpResponse.json({ data: detail }),
    ),
    http.post(
      `${API_BASE}/practice/sessions/${SESSION_ID}/attempts`,
      async ({ request }) => {
        const input = (await request.json()) as RecordPracticeAttemptInput;
        options.onAttempt?.(input);
        const attempt = makeAttempt({
          questionId: input.questionId,
          responseText: input.responseText ?? null,
          outcome: input.skipped ? 'skipped' : 'incorrect',
          revealed: Boolean(input.revealed),
          inputMode: input.inputMode ?? 'typed',
          promptMode: input.promptMode ?? 'read',
        });
        return HttpResponse.json({
          data: {
            attempt,
            acceptedAnswers: attempt.answerSnapshot.answers,
            nextQuestion: QUESTION_2,
            progress: { answered: 1, planned: 5 },
          } satisfies PracticeAttemptResult,
        });
      },
    ),
  );

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
    <ThemeProvider theme={lightTheme}>
      <CssBaseline />
      <AuthContext.Provider value={auth as never}>
        <AiStatusProvider>
          <MemoryRouter initialEntries={[`/practice/sessions/${SESSION_ID}`]}>
            <Routes>
              <Route path="/practice/sessions/:id" element={<PracticeSessionPage />} />
              <Route path="/practice" element={<h1>Practice</h1>} />
            </Routes>
          </MemoryRouter>
        </AiStatusProvider>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

/** Type an answer and submit it — the gesture that arms auto-play, too. */
async function answerQuestion(
  user: ReturnType<typeof userEvent.setup>,
  prompt: string,
  text = 'the big rules',
) {
  await screen.findByRole('heading', { level: 2, name: prompt });
  await user.type(screen.getByLabelText(/your answer/i), text);
  await user.click(screen.getByRole('button', { name: /^submit$/i }));
}

/** The "Accepted answer" panel is up — the result region has rendered. */
function findAnswerPanel() {
  return screen.findByRole('heading', { level: 3, name: /accepted answer/i });
}

/**
 * How many players claim to be speaking. Never more than one.
 *
 * COUNTED, NOT FETCHED: "Stop reading" is copy the question's player and the
 * answer's player share, so the only safe question to ask of that name is how
 * many carry it.
 */
function stopButtons() {
  return screen.queryAllByRole('button', { name: /^stop reading$/i });
}

beforeEach(() => {
  spoken = [];
  live = [];
  cancels = 0;
  installSpeechSynthesis();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------

describe('the answer is read aloud in the result region', () => {
  it('auto-plays the accepted answer once the attempt is graded', async () => {
    const user = userEvent.setup();
    renderSession();

    await answerQuestion(user, QUESTION_1.prompt);

    await findAnswerPanel();
    await waitFor(() => expect(spoken).toHaveLength(1));
    // The ANSWER, not the question — this player has its own text.
    expect(spoken[0].text).toBe(ACCEPTED);
    // It is reading, so its button offers the stop — and it is the only one.
    expect(stopButtons()).toHaveLength(1);
    expect(screen.getByText('Reading the answer aloud.')).toBeInTheDocument();
  });

  it('does not auto-play when the learner has not asked for it', async () => {
    const user = userEvent.setup();
    renderSession({ readAnswersAloud: false });

    await answerQuestion(user, QUESTION_1.prompt);

    // The control is still offered; it simply waits to be pressed.
    const play = await screen.findByRole('button', { name: /read the answer aloud/i });
    expect(spoken).toHaveLength(0);

    await user.click(play);
    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0].text).toBe(ACCEPTED);
  });
});

describe('one voice at a time', () => {
  it('starting the question stops the answer, and starting the answer stops the question', async () => {
    const user = userEvent.setup();
    renderSession({ readAnswersAloud: false });

    await answerQuestion(user, QUESTION_1.prompt);
    const answerPlay = await screen.findByRole('button', {
      name: /read the answer aloud/i,
    });

    // 1. The answer speaks. Exactly one player is stoppable.
    await user.click(answerPlay);
    await waitFor(() => expect(stopButtons()).toHaveLength(1));
    expect(
      screen.getByRole('button', { name: /read the question aloud/i }),
    ).toBeInTheDocument();

    // 2. The QUESTION now speaks — and the answer falls silent in the same act.
    await user.click(screen.getByRole('button', { name: /read the question aloud/i }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /read the answer aloud/i }),
      ).toBeInTheDocument(),
    );
    expect(stopButtons()).toHaveLength(1);
    expect(spoken[spoken.length - 1].text).toBe(QUESTION_1.prompt);

    // 3. And back the other way.
    await user.click(screen.getByRole('button', { name: /read the answer aloud/i }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /read the question aloud/i }),
      ).toBeInTheDocument(),
    );
    expect(stopButtons()).toHaveLength(1);
    expect(spoken[spoken.length - 1].text).toBe(ACCEPTED);
  });

  it('never lets the auto-played answer talk over the question', async () => {
    const user = userEvent.setup();
    renderSession();

    // Start the question reading, then grade an attempt so the answer
    // auto-plays on top of it.
    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await user.click(screen.getByRole('button', { name: /read the question aloud/i }));
    expect(stopButtons()).toHaveLength(1);

    await user.type(screen.getByLabelText(/your answer/i), 'the big rules');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    await findAnswerPanel();
    await waitFor(() => expect(spoken[spoken.length - 1].text).toBe(ACCEPTED));
    // The question's player is back at rest, and only one player is stoppable.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /read the question aloud/i }),
      ).toBeInTheDocument(),
    );
    expect(stopButtons()).toHaveLength(1);
  });
});

describe('moving on', () => {
  it('stops the answer audio and takes the control away with it', async () => {
    const user = userEvent.setup();
    renderSession();

    await answerQuestion(user, QUESTION_1.prompt);
    await findAnswerPanel();
    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0].text).toBe(ACCEPTED);

    const before = cancels;
    await user.click(screen.getByRole('button', { name: /next question/i }));

    // The next question is up, the answer's player is gone, and the engine was
    // told to stop rather than left reading over it.
    await screen.findByRole('heading', { level: 2, name: QUESTION_2.prompt });
    expect(
      screen.queryByRole('button', { name: /read the answer aloud/i }),
    ).toBeNull();
    expect(screen.queryByText('Reading the answer aloud.')).toBeNull();
    expect(cancels).toBeGreaterThan(before);
    // Nothing on the page is still reading — the question's player is at rest
    // too, and there is no second player left to be reading at all.
    expect(stopButtons()).toHaveLength(0);
  });
});

describe('the evidence table', () => {
  it('records `promptMode: "read"` even though the ANSWER was read aloud', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({ onAttempt: (input) => posted.push(input) });

    // Question 1: never heard. The answer auto-plays after grading.
    await answerQuestion(user, QUESTION_1.prompt);
    await findAnswerPanel();
    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0].text).toBe(ACCEPTED);

    // Question 2: also never heard, and the previous answer's playback must not
    // leak into it.
    await user.click(screen.getByRole('button', { name: /next question/i }));
    await answerQuestion(user, QUESTION_2.prompt, 'it sets up the government');

    await waitFor(() => expect(posted).toHaveLength(2));
    // `heard` means the QUESTION was spoken to them before they answered. An
    // answer read back afterwards is not that, and must never be recorded as it.
    expect(posted.map((input) => input.promptMode)).toEqual(['read', 'read']);
  });
});

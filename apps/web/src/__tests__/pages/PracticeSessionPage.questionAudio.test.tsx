/**
 * Hearing the QUESTION on the practice session screen (#311, epic #304 / E13).
 *
 * The mirror of `PracticeSessionPage.answerAudio.test.tsx`, for the switch that
 * had no reader. #288 shipped `voice.readQuestionsAloud` on `/settings/voice`
 * and `resolveVoicePreferences` has resolved it since, but the question's
 * `QuestionAudio` mount passed no `autoPlay` at all: a learner who explicitly
 * asked for questions to be read aloud got silence, with no error and nothing
 * on screen to explain why. A preference that resolves correctly and is read by
 * nobody is invisible to every unit test of the hook, which is why the
 * assertion has to live at the page.
 *
 * THE GATE IS THE PREFERENCE **AND** A PRIOR GESTURE, exactly as the answer's
 * mount is gated (`AttemptFeedback`), because the browser refuses sound until
 * the document has been interacted with either way. Today `hasUserGesture` is
 * set in `submitAttempt` and nowhere else, so the first question of a session
 * never speaks by itself — a known gap, #313's to close from the Start/mode
 * tap, and asserted here as the current behaviour rather than left to be
 * discovered as a regression.
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
// The browser's own voice, which jsdom does not have. `speak` is left UNBOUND
// throughout, so everything below runs on it — the ordinary fresh install.
// -----------------------------------------------------------------------------

interface FakeUtterance {
  text: string;
  rate: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

let spoken: FakeUtterance[] = [];
let live: FakeUtterance[] = [];

function installSpeechSynthesis() {
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      cancel: vi.fn(() => {
        const interrupted = live;
        live = [];
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

/** Everything that has been read aloud, in order. */
function spokenTexts() {
  return spoken.map((utterance) => utterance.text);
}

// -----------------------------------------------------------------------------
// Fixtures — the same shape as the answer-audio suite next door.
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
  /** `user_settings.voice.readQuestionsAloud`. The switch under test. */
  readQuestionsAloud?: boolean;
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
    unboundRoles: ['speak'],
  };

  server.use(
    http.get(`${API_BASE}/ai/status`, () => HttpResponse.json({ data: status })),
    http.get(`${API_BASE}/user-settings`, () =>
      HttpResponse.json({
        data: {
          theme: 'system',
          profile: { displayName: null, useProviderImage: true, customImageUrl: null },
          voice: {
            readQuestionsAloud: options.readQuestionsAloud ?? true,
            // OFF THROUGHOUT, deliberately: the answer's player is the other
            // suite's subject, and leaving it on would put a second voice in
            // every assertion about what was read aloud here.
            readAnswersAloud: false,
          },
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

beforeEach(() => {
  spoken = [];
  live = [];
  installSpeechSynthesis();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------

describe('`voice.readQuestionsAloud` is honoured on the question', () => {
  it('reads the next question aloud once the learner has asked for it', async () => {
    const user = userEvent.setup();
    renderSession({ readQuestionsAloud: true });

    // The gesture, and the first question answered.
    await answerQuestion(user, QUESTION_1.prompt);
    await screen.findByRole('heading', { level: 3, name: /accepted answer/i });

    await user.click(screen.getByRole('button', { name: /next question/i }));
    await screen.findByRole('heading', { level: 2, name: QUESTION_2.prompt });

    // THE ASSERTION THIS SUITE EXISTS FOR: nobody pressed play, and the
    // question was read anyway, because the learner said to.
    await waitFor(() =>
      expect(spokenTexts()[spokenTexts().length - 1]).toBe(QUESTION_2.prompt),
    );
    expect(screen.getByText('Reading the question aloud.')).toBeInTheDocument();
  });

  it('reads nothing at all when the learner has not asked for it', async () => {
    const user = userEvent.setup();
    renderSession({ readQuestionsAloud: false });

    await answerQuestion(user, QUESTION_1.prompt);
    await screen.findByRole('heading', { level: 3, name: /accepted answer/i });

    await user.click(screen.getByRole('button', { name: /next question/i }));
    await screen.findByRole('heading', { level: 2, name: QUESTION_2.prompt });

    // Same session, same gesture, opposite preference: silence.
    expect(spokenTexts()).toEqual([]);

    // The CONTROL is still there — this preference governs auto-play, never
    // whether a learner may hear the question at all.
    await user.click(screen.getByRole('button', { name: /read the question aloud/i }));
    await waitFor(() => expect(spokenTexts()).toEqual([QUESTION_2.prompt]));
  });

  it('still waits for a gesture on the first question of a session (#313)', async () => {
    // NOT A BUG BEING BAKED IN — a browser refuses sound until the document has
    // been interacted with, and asking for it before then is a play that is
    // silently refused. `hasUserGesture` is armed in `submitAttempt` today, so
    // question 1 has none; #313 arms it from the Start/mode tap. This test is
    // what turns that gap into a decision somebody has to change on purpose.
    renderSession({ readQuestionsAloud: true });

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await screen.findByRole('button', { name: /read the question aloud/i });

    expect(spokenTexts()).toEqual([]);
  });
});

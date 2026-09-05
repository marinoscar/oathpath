/**
 * Answering a practice question OUT LOUD (issue #104, epic #58 / E9).
 *
 * The text-mode behaviour of this page is covered by `PracticeSessionPage.test.tsx`
 * and is untouched here. What this file protects is the voice loop, and every
 * assertion in it exists because of a specific way the loop could quietly stop
 * being fair:
 *
 *  1. **EVERY SPOKEN ATTEMPT CAN BE CORRECTED, AND THE CORRECTION COSTS
 *     NOTHING.** This is the load-bearing one, and issue #286 (epic #280 /
 *     E12) is where it moved. E9 kept `VISION.md` line 228's promise — a
 *     learner is never "unfairly penalized for accent or speech-recognition
 *     errors" — with a confirm-before-grade step, and this file's first
 *     assertion used to be that nothing was POSTed until the learner pressed a
 *     button. E12 grades the transcript on release instead (line 230: "a
 *     patient human coach, not operating a voice command interface") and moves
 *     the same protection to AFTER the verdict: the words that were graded stay
 *     visible and editable, a correction posts a superseding attempt, and
 *     `recomputeMasteryForQuestion` (#285, server-side) replays the question's
 *     mastery without the corrected row. So what is asserted here now is that
 *     the correction is ALWAYS REACHABLE and the counter never double-counts —
 *     not that grading waited. `docs/specs/voice-hands-free.md` §1-§2.
 *  1b. **The confirm step is the OPT-OUT, not a deletion.** With
 *     `voice.autoSubmitSpoken: false` every E9 assertion above still holds,
 *     byte for byte, and the suites below prove it rather than assume it.
 *  2. **A low-confidence transcription changes the COPY, not the flow.** It
 *     never decided an outcome and now does not decide whether grading
 *     happened either; the raw number is never shown to anybody.
 *  3. **A retry names the attempt it supersedes.** `retryOfAttemptId` is what
 *     keeps an answer and its correction from counting as two questions, and
 *     its two refusals (409, 404) must leave the learner somewhere they can act
 *     rather than on a dead question. A second correction of the same attempt
 *     is never offered, because the server 409s it.
 *  4. **All four `inputMode` × `promptMode` combinations are sent correctly.**
 *     Nothing on the server can reconstruct either after the fact — the
 *     recording is transcribed and discarded at the point of capture — so a
 *     wrong value here is a permanently wrong row, and `spoken` is the
 *     evidence E6's spoken-readiness component is built from.
 *  5. **Toggling voice → text → voice keeps the session.** Including the
 *     progress counter and the attempts already recorded.
 *  6. **Both themes, 360px, and the confirmation reachable from a keyboard.**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CssBaseline, ThemeProvider } from '@mui/material';

import { server } from '../mocks/server';
import { resetViewportWidth, setViewportWidth } from '../setup';
import { mockUser } from '../utils/test-utils';
import { AuthContext } from '../../contexts/AuthContext';
import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { darkTheme, lightTheme } from '../../theme';
import PracticeSessionPage from '../../pages/PracticeSessionPage';
import type {
  AiStatus,
  AiUnavailableCause,
  PracticeAttempt,
  PracticeAttemptResult,
  PracticeQuestion,
  PracticeSession,
  PracticeSessionDetail,
  RecordPracticeAttemptInput,
  VoiceSettings,
} from '../../types';

/** The opt-out: E9's confirm-then-grade flow, kept as a preference (#286). */
const CONFIRM_FIRST: VoiceSettings = { autoSubmitSpoken: false };

// -----------------------------------------------------------------------------
// The microphone, under this test's control
// -----------------------------------------------------------------------------
//
// `useAudioCapture` is mocked rather than driven, because jsdom has no
// `MediaRecorder` at all: the real hook would answer `unsupported` before any
// of the behaviour below could happen. The hook's OWN failure states are
// covered exhaustively by `hooks/useAudioCapture.test.ts` and
// `components/voice/PushToTalkButton.test.tsx`; what this file needs from it
// is a recording that arrives, which is precisely what the fake supplies.
//
// `release()` returns it to idle, which is also the assertion behind "the page
// lets go of the audio": the page calls it in a `finally`, so the fake going
// back to `idle` after every upload is that call being made.

const captureControl = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const control = {
    listeners,
    state: { status: 'idle' } as {
      status: string;
      blob?: Blob;
      mimeType?: string;
      durationMs?: number;
    },
    releases: 0,
    set(next: typeof control.state) {
      control.state = next;
      listeners.forEach((listener) => listener());
    },
    reset() {
      control.state = { status: 'idle' };
      control.releases = 0;
    },
  };
  return control;
});

vi.mock('../../hooks/useAudioCapture', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { useCallback, useEffect, useState } = await import('react');

  return {
    ...actual,
    useAudioCapture: () => {
      const [, force] = useState(0);
      useEffect(() => {
        const listener = () => force((n) => n + 1);
        captureControl.listeners.add(listener);
        return () => {
          captureControl.listeners.delete(listener);
        };
      }, []);

      // STABLE IDENTITIES, exactly as the real hook's `useCallback`s give. The
      // page builds a reset callback out of `release`, so a fresh function per
      // render would make this fake behave in a way the real hook never does —
      // testing the mock rather than the page.
      const release = useCallback(() => {
        captureControl.releases += 1;
        captureControl.set({ status: 'idle' });
      }, []);
      const start = useCallback(() => {}, []);
      const stop = useCallback(() => {}, []);

      return {
        state: captureControl.state,
        isRecording: captureControl.state.status === 'recording',
        recording:
          captureControl.state.status === 'recorded'
            ? (captureControl.state.blob ?? null)
            : null,
        start,
        stop,
        release,
      };
    },
  };
});

/** One hold of the button, finished. */
function finishRecording() {
  act(() => {
    captureControl.set({
      status: 'recorded',
      blob: new Blob(['audio'], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      durationMs: 1500,
    });
  });
}

// -----------------------------------------------------------------------------
// The browser's own voice, which jsdom does not have either
// -----------------------------------------------------------------------------

function installSpeechSynthesis() {
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      cancel: vi.fn(),
      speak: vi.fn((utterance: { onstart?: (() => void) | null }) => {
        // ACTUALLY SPEAKING is what `onPlayed` reports, so the fake fires the
        // same event the real engine does rather than resolving on the click.
        utterance.onstart?.();
      }),
    },
    configurable: true,
  });
  (
    window as unknown as { SpeechSynthesisUtterance: unknown }
  ).SpeechSynthesisUtterance = class {
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
const PHONE = 360;

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

function detailFor(
  overrides: Partial<PracticeSessionDetail> = {},
): PracticeSessionDetail {
  return {
    session: SESSION_BASE,
    nextQuestion: QUESTION_1,
    progress: { answered: 0, planned: 5 },
    attempts: [],
    ...overrides,
  };
}

interface Options {
  detail?: PracticeSessionDetail;
  /** Every attempt body the page posted, in order. */
  onAttempt?: (input: RecordPracticeAttemptInput) => void;
  /** Answer the POST with this instead of the default `incorrect` grade. */
  attemptResult?: PracticeAttemptResult | (() => PracticeAttemptResult);
  /** Refuse the POST with this status — the retry refusals. */
  attemptStatus?: number;
  /** `POST /api/ai/speech/transcribe` answers `{status:'ok', ...}` with this. */
  transcription?: { text: string; confidence: number | null };
  /**
   * …or a genuine transport failure (a real non-2xx, which still rejects).
   * Distinct from `transcriptionUnavailable`/`transcriptionFailed` below,
   * which are both HTTP 200 (issue #277).
   */
  transcriptionFails?: boolean;
  /** The 200 `{status:'unavailable', ...}` member — nothing was attempted. */
  transcriptionUnavailable?: { cause: AiUnavailableCause; role?: 'transcribe' | 'speak' };
  /** The 200 `{status:'failed', ...}` member — attempted, and it didn't work. */
  transcriptionFailed?: { errorCode: string; error: string };
  /** `transcribe` bound on this deployment? Defaults to yes. */
  transcribeBound?: boolean;
  /**
   * Bound when the page loads, unbound on the next read — the state the page's
   * own re-read effect exists for. `docs/specs/voice.md` §1: an administrator
   * unbinding `transcribe` mid-session is an ordinary deployment change, and
   * the page has to move from "the call came back unavailable" to "this
   * deployment has no transcription" rather than leaving a dead microphone up.
   */
  unbindTranscribeOnRefresh?: boolean;
  /**
   * The stored `voice` namespace, or nothing at all (every field absent, so
   * every default applies — `autoSubmitSpoken` included, which is `true`).
   *
   * THE SAME `GET /api/user-settings` THE APP ALREADY READS. `useVoicePrefs`
   * adds no endpoint and no second fetch, so a test that wants a different
   * preference changes the settings document, exactly as a learner would.
   */
  voice?: VoiceSettings;
  theme?: typeof lightTheme;
}

let transcribeCalls = 0;

function renderSession(options: Options = {}) {
  const detail = options.detail ?? detailFor();

  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    unboundRoles: options.transcribeBound === false ? ['transcribe'] : [],
  };

  let statusReads = 0;

  // The stored document, mutated by PATCH exactly as the server mutates it —
  // FIELD-WISE within `voice`, never wholesale. Since #313 this page WRITES a
  // voice preference (the session-wide `Text | Voice` control stores
  // `voice.conversationMode`), so a mock that replaced the namespace with the
  // one key that was sent would silently reset `autoSubmitSpoken` and grade
  // every opt-out suite below on the opposite setting.
  let stored: Record<string, unknown> = {
    theme: 'system',
    profile: { useProviderImage: true, customImageUrl: null },
    ...(options.voice ? { voice: options.voice } : {}),
    updatedAt: '2026-03-01T00:00:00.000Z',
    version: 1,
  };

  server.use(
    http.get(`${API_BASE}/user-settings`, () => HttpResponse.json({ data: stored })),
    http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
      const body = (await request.json()) as { voice?: Record<string, unknown> };
      const merged = { ...((stored.voice as Record<string, unknown>) ?? {}) };
      for (const [key, value] of Object.entries(body.voice ?? {})) {
        // `null` is the DELETE, exactly as `mergeVoice` treats it server-side.
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      stored = {
        ...stored,
        voice: merged,
        version: (stored.version as number) + 1,
      };
      return HttpResponse.json({ data: stored });
    }),
    http.get(`${API_BASE}/ai/status`, () => {
      statusReads += 1;
      if (options.unbindTranscribeOnRefresh && statusReads > 1) {
        return HttpResponse.json({
          data: { ...status, unboundRoles: ['transcribe'] },
        });
      }
      return HttpResponse.json({ data: status });
    }),
    http.post(`${API_BASE}/ai/speech/transcribe`, async () => {
      transcribeCalls += 1;
      if (options.transcriptionFails) {
        return HttpResponse.json(
          { error: { code: 'AI_UNAVAILABLE', message: 'Speech recognition is not available right now.' } },
          { status: 503 },
        );
      }
      if (options.transcriptionUnavailable) {
        return HttpResponse.json({
          data: {
            status: 'unavailable',
            cause: options.transcriptionUnavailable.cause,
            role: options.transcriptionUnavailable.role ?? 'transcribe',
          },
        });
      }
      if (options.transcriptionFailed) {
        return HttpResponse.json({
          data: {
            status: 'failed',
            errorCode: options.transcriptionFailed.errorCode,
            error: options.transcriptionFailed.error,
          },
        });
      }
      return HttpResponse.json({
        data: {
          status: 'ok',
          ...(options.transcription ?? { text: 'the Constitution', confidence: 0.94 }),
        },
      });
    }),
    http.get(`${API_BASE}/practice/sessions/${SESSION_ID}`, () =>
      HttpResponse.json({ data: detail }),
    ),
    http.post(
      `${API_BASE}/practice/sessions/${SESSION_ID}/attempts`,
      async ({ request }) => {
        const input = (await request.json()) as RecordPracticeAttemptInput;
        options.onAttempt?.(input);

        if (options.attemptStatus) {
          return HttpResponse.json(
            {
              error: {
                code: 'CONFLICT',
                message: `Practice attempt "${input.retryOfAttemptId}" has already been retried`,
              },
            },
            { status: options.attemptStatus },
          );
        }

        if (options.attemptResult) {
          const result =
            typeof options.attemptResult === 'function'
              ? options.attemptResult()
              : options.attemptResult;
          return HttpResponse.json({ data: result });
        }

        const attempt = makeAttempt({
          responseText: input.responseText ?? null,
          outcome: input.skipped ? 'skipped' : 'incorrect',
          revealed: Boolean(input.revealed),
          inputMode: input.inputMode ?? 'typed',
          promptMode: input.promptMode ?? 'read',
          transcript: input.transcript ?? null,
          asrConfidence: input.asrConfidence ?? null,
          retryOfAttemptId: input.retryOfAttemptId ?? null,
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
    http.post(`${API_BASE}/practice/sessions/${SESSION_ID}/complete`, () =>
      HttpResponse.json({
        data: { ...SESSION_BASE, status: 'completed', completedAt: '2026-03-01T12:20:00.000Z' },
      }),
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
    <ThemeProvider theme={options.theme ?? lightTheme}>
      <CssBaseline />
      <AuthContext.Provider value={auth as never}>
        <AiStatusProvider>
          <MemoryRouter initialEntries={[`/practice/sessions/${SESSION_ID}`]}>
            <Routes>
              <Route path="/practice/sessions/:id" element={<PracticeSessionPage />} />
              <Route
                path="/practice/sessions/:id/summary"
                element={<h1>Practice summary</h1>}
              />
              <Route path="/practice" element={<h1>Practice</h1>} />
            </Routes>
          </MemoryRouter>
        </AiStatusProvider>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

/**
 * Wait for the question, then switch to the microphone.
 *
 * THE CONTROL IS NOW `Voice`, ABOVE THE QUESTION, AND SESSION-WIDE (#313,
 * epic #304 / E13): `docs/specs/conversation-mode.md` §7 formally amends
 * `voice.md` §5's per-question picker. Only the label and its position moved —
 * choosing Voice still renders `PushToTalkButton` and still runs every flow
 * asserted below, because the hands-free loop is armed by its own Start and by
 * nothing else.
 */
async function startSpeaking(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
  const speak = await screen.findByRole('button', { name: /^voice$/i });
  await user.click(speak);
  return speak;
}

function answerField(): HTMLInputElement {
  return screen.getByLabelText(/your answer/i) as HTMLInputElement;
}

beforeEach(() => {
  captureControl.reset();
  transcribeCalls = 0;
});

afterEach(() => {
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
  resetViewportWidth();
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// 1. THE LOAD-BEARING ONE: GRADE ON RELEASE, CORRECT AFTERWARDS (#286)
// -----------------------------------------------------------------------------

/** The correction card's opening control, once a spoken attempt is graded. */
function correctionButton() {
  return screen.queryByRole('button', { name: /that.s not what i said/i });
}

/** The editable transcript, once the correction card is opened. */
function correctionField(): HTMLInputElement {
  return screen.getByLabelText(/what you actually said/i) as HTMLInputElement;
}

describe('a spoken answer grades itself the moment it lands', () => {
  it('grades on release with NO further interaction, and shows the result', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({ onAttempt: (input) => posted.push(input) });

    await startSpeaking(user);
    finishRecording();

    // ONE HOLD, ONE RELEASE, ONE VERDICT. No transcript to read, no button to
    // press: `VISION.md` line 230's "patient human coach" rather than four
    // deliberate actions per question.
    expect(await screen.findByText('Not a match')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /next question/i }),
    ).toBeInTheDocument();

    expect(transcribeCalls).toBe(1);
    expect(posted).toHaveLength(1);
    // Everything `voiceFields()` assembled before still rides with it.
    expect(posted[0].responseText).toBe('the Constitution');
    expect(posted[0].transcript).toBe('the Constitution');
    expect(posted[0].inputMode).toBe('spoken');
    expect(posted[0].promptMode).toBe('read');
    expect(posted[0].asrConfidence).toBe(0.94);
    expect(posted[0].retryOfAttemptId).toBeUndefined();
  });

  it('NEVER submits an empty transcript, and says so instead', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({
      // `text: ''` is a `status: 'ok'` SUCCESS (`ai-speech.dto.ts`) — it is what
      // silence, or a tap instead of a hold, sounds like.
      transcription: { text: '   ', confidence: 0.9 },
      onAttempt: (input) => posted.push(input),
    });

    await startSpeaking(user);
    finishRecording();

    expect(
      await screen.findByText(/nothing was picked up in that recording/i),
    ).toBeInTheDocument();
    // Auto-submitting this would record a failure at a question the learner
    // never answered — the one thing worse than making them press a button.
    expect(posted).toHaveLength(0);
    expect(screen.queryByText('Not a match')).toBeNull();

    // And they can simply go again: the microphone is live, not blocked.
    expect(
      screen.getByRole('button', { name: /hold to record/i }),
    ).toBeEnabled();
    await user.type(answerField(), 'the Constitution');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].inputMode).toBe('typed');
  });

  it('leaves typing available immediately after an auto-submitted answer', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({ onAttempt: (input) => posted.push(input) });

    await startSpeaking(user);
    finishRecording();
    await screen.findByRole('button', { name: /next question/i });

    // On to question 2, and the field is usable with no toggle, no reload and
    // no recovery step. `voice.md` §5: the text path is unconditional, and an
    // auto-submitted answer is not allowed to be the end of the session.
    await user.click(screen.getByRole('button', { name: /next question/i }));
    await screen.findByRole('heading', { level: 2, name: QUESTION_2.prompt });
    expect(answerField()).toBeEnabled();
    expect(answerField().value).toBe('');

    await user.type(answerField(), 'it sets up the government');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].inputMode).toBe('typed');
    expect(posted[1].questionId).toBe(QUESTION_2.id);
  });
});

// -----------------------------------------------------------------------------
// 1a. THE OPT-OUT: E9's CONFIRM-THEN-GRADE FLOW, UNCHANGED (#286)
// -----------------------------------------------------------------------------

describe('with `voice.autoSubmitSpoken: false`, nothing is graded before the learner confirms', () => {
  it('shows the transcript and records NO attempt until the learner submits it', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({ voice: CONFIRM_FIRST, onAttempt: (input) => posted.push(input) });

    await startSpeaking(user);
    finishRecording();

    // The transcript arrives and lands in the field the learner already knows.
    await waitFor(() => expect(answerField().value).toBe('the Constitution'));
    expect(transcribeCalls).toBe(1);

    // AND NOTHING HAS BEEN RECORDED. This is what the learner asked for by
    // turning auto-submit off, and it is E9's flow byte for byte.
    expect(posted).toHaveLength(0);
    expect(
      screen.getByText(/nothing is graded until you choose use this answer/i),
    ).toBeInTheDocument();

    // Only now, and only because they asked.
    await user.click(screen.getByRole('button', { name: /use this answer/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
  });

  it('lets the learner EDIT the transcript first, and grades what they edited', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({
      voice: CONFIRM_FIRST,
      // What a mishearing looks like: close, and wrong.
      transcription: { text: 'the constipation', confidence: 0.91 },
      onAttempt: (input) => posted.push(input),
    });

    await startSpeaking(user);
    finishRecording();
    await waitFor(() => expect(answerField().value).toBe('the constipation'));

    await user.clear(answerField());
    await user.type(answerField(), 'the Constitution');
    await user.click(screen.getByRole('button', { name: /use this answer/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    // BOTH fields carry the corrected words: `transcript` is the CONFIRMED
    // text, never the recogniser's raw output.
    expect(posted[0].responseText).toBe('the Constitution');
    expect(posted[0].transcript).toBe('the Constitution');
    expect(posted[0].inputMode).toBe('spoken');
  });

  it('still refuses to submit an empty transcript', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({
      voice: CONFIRM_FIRST,
      transcription: { text: '', confidence: 0.9 },
      onAttempt: (input) => posted.push(input),
    });

    await startSpeaking(user);
    finishRecording();

    expect(
      await screen.findByText(/nothing was picked up in that recording/i),
    ).toBeInTheDocument();
    expect(posted).toHaveLength(0);
    // Not dropped into a confirmation step over an empty box, which reads as
    // the product having lost their answer.
    expect(screen.queryByText(/is this what you said\?/i)).toBeNull();
  });
});

describe('a transcription that never produced words', () => {
  it('records nothing at all when the transcription fails, and keeps typing open', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({ transcriptionFails: true, onAttempt: (input) => posted.push(input) });

    await startSpeaking(user);
    finishRecording();

    expect(
      await screen.findByText(/hold the button and say it again, or type your answer below/i),
    ).toBeInTheDocument();
    expect(posted).toHaveLength(0);

    // `voice.md` §5: typing is unconditional, and a failed recognition is not
    // allowed to be the end of the session.
    await user.type(answerField(), 'the Constitution');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].inputMode).toBe('typed');
    expect(posted[0].transcript).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// 1b. THE SERVER'S OWN 200-WITH-A-CAUSE ANSWERS (issue #277 — the regression)
//
// `transcribeAudio` resolves a union on `status`, and all three members are
// HTTP 200. This is the suite that would have caught #277: the old fixtures
// never sent anything but `{ text, confidence }`, so nothing here ever
// exercised `text.trim()` on an `undefined` `text`.
// -----------------------------------------------------------------------------

describe('when the transcription call answers something other than `ok`', () => {
  it('shows the amber retry alert for `failed`, and never the raw error or a JS diagnostic', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({
      transcriptionFailed: {
        errorCode: 'provider_timeout',
        error: 'upstream request to the provider timed out',
      },
      onAttempt: (input) => posted.push(input),
    });

    await startSpeaking(user);
    finishRecording();

    expect(
      await screen.findByText(/hold the button and say it again, or type your answer below/i),
    ).toBeInTheDocument();
    expect(posted).toHaveLength(0);

    // THE REGRESSION ITSELF: this used to be a `TypeError` rendered verbatim
    // in this very alert, on a deployment where nothing had gone wrong.
    expect(document.body.textContent).not.toMatch(/cannot read propert/i);
    expect(document.body.textContent).not.toContain('provider_timeout');
    expect(document.body.textContent).not.toContain(
      'upstream request to the provider timed out',
    );

    // Typing is still the unconditional fallback.
    await user.type(answerField(), 'the Constitution');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].inputMode).toBe('typed');
  });

  it('does NOT show the amber retry alert for `unavailable` — there is nothing to retry', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({
      transcriptionUnavailable: { cause: 'role_unbound', role: 'transcribe' },
      onAttempt: (input) => posted.push(input),
    });

    await startSpeaking(user);
    finishRecording();

    // Give the (rejected) transcription a moment to resolve before asserting
    // an absence.
    await waitFor(() => expect(transcribeCalls).toBe(1));

    expect(
      screen.queryByText(/hold the button and say it again, or type your answer below/i),
    ).toBeNull();
    // Not a JS diagnostic either — nothing here should ever surface one.
    expect(document.body.textContent).not.toMatch(/cannot read propert/i);
    expect(posted).toHaveLength(0);

    // Typing still works — the unconditional fallback survives every path.
    await user.type(answerField(), 'the Constitution');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].inputMode).toBe('typed');
  });

  it('renders the ROLE-SCOPED not-ready state once the status agrees the role is gone', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({
      // Bound when the page loaded — which is why the microphone was there to
      // press — and unbound by the time the page re-reads the status after the
      // `unavailable` frame. That re-read is the page's own effect, and this is
      // the case it exists for.
      transcriptionUnavailable: { cause: 'role_unbound', role: 'transcribe' },
      unbindTranscribeOnRefresh: true,
      onAttempt: (input) => posted.push(input),
    });

    await startSpeaking(user);
    finishRecording();

    // THE SHARED `AiNotReady`, role-scoped to `transcribe` — never a message
    // written on this page, and never the amber retry alert. Its signature
    // sentence is the assertion, because that sentence is the whole reason the
    // component exists and the first thing a local rewrite would drop. (The
    // role NAME is admin-only copy, so a learner never sees it.)
    expect(await screen.findByText(/not available yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/this is not a problem with your key/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/hold the button and say it again, or type your answer below/i),
    ).toBeNull();
    expect(posted).toHaveLength(0);

    // And the session is still a complete, working, text-mode session.
    await user.type(answerField(), 'the Constitution');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].inputMode).toBe('typed');
  });

  it('renders the "add your key" message, not `AiNotReady`, for `no_user_key`', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({
      transcriptionUnavailable: { cause: 'no_user_key', role: 'transcribe' },
      onAttempt: (input) => posted.push(input),
    });

    await startSpeaking(user);
    finishRecording();

    expect(
      await screen.findByText(/add your ai key to answer out loud/i),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /add your key/i });
    expect(link).toHaveAttribute('href', '/settings/ai');

    // `AiNotReady`'s own "not available yet" / "not a problem with your key"
    // copy must NOT be what renders for this cause — that message is for a
    // deployment fact, and this cause is the learner's own.
    expect(screen.queryByText(/not available yet/i)).toBeNull();
    expect(screen.queryByText(/not a problem with your key/i)).toBeNull();
    expect(
      screen.queryByText(/hold the button and say it again, or type your answer below/i),
    ).toBeNull();
    expect(posted).toHaveLength(0);

    // Typing still works.
    await user.type(answerField(), 'the Constitution');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].inputMode).toBe('typed');
  });
});

// -----------------------------------------------------------------------------
// 2. LOW CONFIDENCE CHANGES THE COPY, NOT THE OUTCOME
// -----------------------------------------------------------------------------

describe('a low-confidence transcription', () => {
  it('is still GRADED, and the result reads as a likely mishearing', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({
      transcription: { text: 'the constitutional', confidence: 0.41 },
      onAttempt: (input) => posted.push(input),
    });

    await startSpeaking(user);
    finishRecording();

    // GRADING HAPPENED. The confidence never decided an outcome and, since
    // #286, does not decide whether the answer is graded either — it decides
    // the WORDS beside the verdict and nothing else.
    expect(await screen.findByText('Not a match')).toBeInTheDocument();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].asrConfidence).toBe(0.41);

    // …and the invitation to check it is the stronger one.
    expect(
      screen.getByText(/that may not be what you said/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/more likely our mistake than yours/i),
    ).toBeInTheDocument();
    expect(correctionButton()).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /record it again/i }),
    ).toBeInTheDocument();
  });

  it('with the opt-out, invites the correction BEFORE grading, exactly as E9 did', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({
      voice: CONFIRM_FIRST,
      transcription: { text: 'the constitutional', confidence: 0.41 },
      onAttempt: (input) => posted.push(input),
    });

    await startSpeaking(user);
    finishRecording();

    expect(
      await screen.findByText(/that may not be what you said/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/more likely our mistake than yours/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /record again/i }),
    ).toBeInTheDocument();

    // NO OUTCOME. Nothing is graded until the learner says so on this setting.
    expect(posted).toHaveLength(0);
    expect(screen.queryByText('Not a match')).toBeNull();
  });

  it('NEVER shows the learner the confidence number', async () => {
    const user = userEvent.setup();
    const { container } = renderSession({
      transcription: { text: 'the constitutional', confidence: 0.41 },
    });

    await startSpeaking(user);
    finishRecording();
    await screen.findByText(/that may not be what you said/i);

    // Not in the text, and not anywhere in the raw DOM either — a "41%" in a
    // tooltip or a `data-` attribute is still a diagnostic detail a learner
    // has no way to act on and every way to misread.
    for (const shape of ['0.41', '41%', '41 %']) {
      expect(container.innerHTML).not.toContain(shape);
    }
  });

  it('reads as an ordinary "this is what we heard" when the recogniser was confident', async () => {
    const user = userEvent.setup();
    renderSession({ transcription: { text: 'the Constitution', confidence: 0.94 } });

    await startSpeaking(user);
    finishRecording();

    expect(await screen.findByText('This is what we heard.')).toBeInTheDocument();
    expect(screen.queryByText(/that may not be what you said/i)).toBeNull();
  });

  it('treats an UNKNOWN confidence as ordinary, never as low', async () => {
    // `null` means the recogniser did not report a score — several models
    // never do. Reading it as `0` would greet every learner on those
    // deployments with "that may not be what you said" about a transcript
    // nothing was uncertain about.
    const user = userEvent.setup();
    renderSession({ transcription: { text: 'the Constitution', confidence: null } });

    await startSpeaking(user);
    finishRecording();

    expect(await screen.findByText('This is what we heard.')).toBeInTheDocument();
    expect(screen.queryByText(/that may not be what you said/i)).toBeNull();
  });

  it('trusts the transcript at EXACTLY the threshold — 0.6 is not low', async () => {
    // `confidence.ts`'s own header: "STRICTLY BELOW, never at-or-below,
    // matching the server exactly: 0.6 is trusted." The API side of this
    // exact boundary is already covered
    // (`practice.service.spec.ts`'s `isMisheardAttempt` suite asserts
    // `isMisheardAttempt(0.6, 'incorrect')` is `false`); this is the web
    // mirror `isLowConfidence` has to agree with, and nothing before this
    // test pins the boundary value itself — only comfortably above (0.94)
    // and comfortably below (0.41) it.
    const user = userEvent.setup();
    renderSession({ transcription: { text: 'the Constitution', confidence: 0.6 } });

    await startSpeaking(user);
    finishRecording();

    expect(await screen.findByText('This is what we heard.')).toBeInTheDocument();
    expect(screen.queryByText(/that may not be what you said/i)).toBeNull();
  });

  it('sends NO `asrConfidence` at all when the recogniser reported none', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({
      transcription: { text: 'the Constitution', confidence: null },
      onAttempt: (input) => posted.push(input),
    });

    await startSpeaking(user);
    finishRecording();

    await waitFor(() => expect(posted).toHaveLength(1));
    // ABSENT, NEVER `0`. A `0` is below the server's threshold, so it would
    // stamp `misheard` on an answer nothing was uncertain about.
    expect('asrConfidence' in posted[0]).toBe(false);
  });

  it('sends the confidence through unchanged when there IS one', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({
      transcription: { text: 'the Constitution', confidence: 0.41 },
      onAttempt: (input) => posted.push(input),
    });

    await startSpeaking(user);
    finishRecording();

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].asrConfidence).toBe(0.41);
    // AND NO VERDICT OF ANY KIND. The client reports the measurement; the
    // server alone concludes `misheard` from it.
    expect('failureCause' in posted[0]).toBe(false);
    expect('misheard' in posted[0]).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// 3. THE CORRECTION (E9's retry, widened by #286 to any spoken attempt)
// -----------------------------------------------------------------------------

describe('correcting a graded spoken answer', () => {
  const graded = makeAttempt({
    id: 'attempt-graded',
    inputMode: 'spoken',
    outcome: 'incorrect',
    responseText: 'the constitutional',
    transcript: 'the constitutional',
    asrConfidence: 0.41,
    failureCause: 'misheard',
  });

  const corrected = makeAttempt({
    id: 'attempt-retry',
    inputMode: 'spoken',
    outcome: 'correct',
    responseText: 'the Constitution',
    transcript: 'the Constitution',
    asrConfidence: 0.41,
    retryOfAttemptId: graded.id,
  });

  function resultFor(attempt: PracticeAttempt): PracticeAttemptResult {
    return {
      attempt,
      acceptedAnswers: attempt.answerSnapshot.answers,
      nextQuestion: QUESTION_2,
      // THE SERVER'S NUMBER, AND IT DOES NOT MOVE. A superseded attempt is
      // excluded from `answered`, so an answer and its correction are ONE
      // answered question — which is what the counter has to keep saying.
      progress: { answered: 1, planned: 5 },
    };
  }

  /** The graded attempt, then its correction. */
  function gradedThenCorrection() {
    let call = 0;
    return (): PracticeAttemptResult => {
      call += 1;
      return resultFor(call === 1 ? graded : corrected);
    };
  }

  it('pre-fills the graded transcript, posts `retryOfAttemptId`, and re-renders the result', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({
      transcription: { text: 'the constitutional', confidence: 0.41 },
      attemptResult: gradedThenCorrection(),
      onAttempt: (input) => posted.push(input),
    });

    await startSpeaking(user);
    finishRecording();
    expect(await screen.findByText('Not a match')).toBeInTheDocument();
    expect(screen.getByText('Question 1 of 5')).toBeInTheDocument();

    // The words that were graded are on screen, and one control away from
    // being editable — pre-filled, so fixing one misheard word is one
    // keystroke rather than retyping the sentence.
    await user.click(correctionButton() as HTMLElement);
    expect(correctionField().value).toBe('the constitutional');

    await user.clear(correctionField());
    await user.type(correctionField(), 'the Constitution');
    await user.click(screen.getByRole('button', { name: /use this instead/i }));

    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[0].retryOfAttemptId).toBeUndefined();
    expect(posted[1].retryOfAttemptId).toBe('attempt-graded');
    expect(posted[1].inputMode).toBe('spoken');
    expect(posted[1].responseText).toBe('the Constitution');
    expect(posted[1].transcript).toBe('the Constitution');
    // The measurement belongs to the RECORDING, so it rides with the
    // correction unchanged — exactly as an edited transcript always sent it
    // under the confirm flow. The client never sends a verdict about it.
    expect(posted[1].asrConfidence).toBe(0.41);

    // The card re-renders from the retry's own grading…
    expect(await screen.findByText('Correct')).toBeInTheDocument();
    // …and the counter still reads ONE answered question, not two.
    expect(screen.getByText('Question 1 of 5')).toBeInTheDocument();

    // ONE CORRECTION PER ATTEMPT. `requireRetryTarget` 409s a second, so
    // offering it would be offering something that cannot work.
    expect(correctionButton()).toBeNull();
    expect(
      screen.queryByRole('button', { name: /record it again/i }),
    ).toBeNull();
  });

  it('offers nothing when the attempt is ALREADY a retry — the chain stops at two', async () => {
    const user = userEvent.setup();
    renderSession({ attemptResult: resultFor(corrected) });

    await startSpeaking(user);
    finishRecording();

    await screen.findByRole('button', { name: /next question/i });
    expect(correctionButton()).toBeNull();
  });

  it('offers the correction for a CONFIDENTLY wrong answer too, not only a doubted one', async () => {
    const user = userEvent.setup();
    renderSession({ transcription: { text: 'the big rules', confidence: 0.97 } });

    await startSpeaking(user);
    finishRecording();
    await screen.findByRole('button', { name: /next question/i });

    // THE CASE AUTO-SUBMIT CREATED. Accented speech very often transcribes
    // confidently and wrongly, so `failureCause: 'misheard'` — which needs a
    // confidence below 0.6 — cannot see the transcript that most needs fixing
    // (`voice-hands-free.md` §2). The copy stays ordinary; the offer does not
    // depend on doubt.
    expect(screen.getByText('This is what we heard.')).toBeInTheDocument();
    expect(screen.queryByText(/that may not be what you said/i)).toBeNull();
    expect(correctionButton()).toBeInTheDocument();
  });

  it('offers nothing for a TYPED answer', async () => {
    const user = userEvent.setup();
    renderSession();

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await user.type(answerField(), 'the big rules');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    await screen.findByRole('button', { name: /next question/i });
    // Nothing misheard a keyboard. A second go at every typed miss is the
    // grinding loophole the one-attempt rule exists to close, and E12 widened
    // the correction to spoken attempts only.
    expect(correctionButton()).toBeNull();
  });

  it('offers nothing after "Show me the answer" — the accepted answer is on screen', async () => {
    const user = userEvent.setup();
    // The reveal path needs a transcript that has NOT been graded yet, which
    // is the confirm flow — with auto-submit there is no window in which to
    // press it.
    renderSession({ voice: CONFIRM_FIRST });

    await startSpeaking(user);
    finishRecording();
    await waitFor(() => expect(answerField().value).toBe('the Constitution'));
    await user.click(screen.getByRole('button', { name: /show me the answer/i }));

    await screen.findByRole('button', { name: /next question/i });
    // `requireRetryTarget` has no opinion on `revealed`, so this gate is the
    // only one there is: "correcting" a transcript to match an answer already
    // on screen would turn a reveal into a free `correct`.
    expect(correctionButton()).toBeNull();
  });

  it.each([
    ['409', 409],
    ['404', 404],
  ])('explains a %s refusal in words a learner can act on', async (_name, status) => {
    const user = userEvent.setup();
    renderSession({
      transcription: { text: 'the constitutional', confidence: 0.41 },
      attemptResult: resultFor(graded),
    });

    await startSpeaking(user);
    finishRecording();
    await screen.findByText('Not a match');

    // The correction is refused: the server has since recorded a supersession
    // (409), or the attempt id names nothing this learner owns here (404).
    server.use(
      http.post(`${API_BASE}/practice/sessions/${SESSION_ID}/attempts`, () =>
        HttpResponse.json(
          { error: { code: 'CONFLICT', message: 'Practice attempt "attempt-graded" has already been retried' } },
          { status },
        ),
      ),
    );

    await user.click(correctionButton() as HTMLElement);
    await user.clear(correctionField());
    await user.type(correctionField(), 'the Constitution');
    await user.click(screen.getByRole('button', { name: /use this instead/i }));

    // NOT the raw server sentence, which names a row id and a rule about
    // chains — neither of which a learner can do anything with.
    expect(
      await screen.findByText(/already recorded, so it could not be replaced/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/has already been retried/i)).toBeNull();
  });

  it('can be answered again out loud instead of typed', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({
      transcription: { text: 'the constitutional', confidence: 0.41 },
      attemptResult: gradedThenCorrection(),
      onAttempt: (input) => posted.push(input),
    });

    await startSpeaking(user);
    finishRecording();
    await screen.findByText('Not a match');

    await user.click(screen.getByRole('button', { name: /record it again/i }));

    // Back on the same question, with the counter unmoved — moving it and
    // moving it back is a flicker that reads as a lost answer.
    expect(
      screen.getByRole('heading', { level: 2, name: QUESTION_1.prompt }),
    ).toBeInTheDocument();
    expect(screen.getByText('Question 1 of 5')).toBeInTheDocument();

    finishRecording();
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].retryOfAttemptId).toBe('attempt-graded');
    expect(posted[1].inputMode).toBe('spoken');
  });
});

// -----------------------------------------------------------------------------
// 4. THE FOUR COMBINATIONS
// -----------------------------------------------------------------------------

describe('`inputMode` and `promptMode`', () => {
  it('read + typed — the pre-voice shape, unchanged', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({ onAttempt: (input) => posted.push(input) });

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await user.type(answerField(), 'the Constitution');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].inputMode).toBe('typed');
    expect(posted[0].promptMode).toBe('read');
  });

  it('heard + typed — listening practice without speaking', async () => {
    installSpeechSynthesis();
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({ onAttempt: (input) => posted.push(input) });

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await user.click(screen.getByRole('button', { name: /read the question aloud/i }));

    await user.type(answerField(), 'the Constitution');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].inputMode).toBe('typed');
    expect(posted[0].promptMode).toBe('heard');
  });

  it('read + spoken — a learner who wants to hear themselves answer', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({ onAttempt: (input) => posted.push(input) });

    await startSpeaking(user);
    finishRecording();

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].inputMode).toBe('spoken');
    expect(posted[0].promptMode).toBe('read');
  });

  it('heard + spoken — the closest rehearsal of the real interview', async () => {
    installSpeechSynthesis();
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({ onAttempt: (input) => posted.push(input) });

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await user.click(screen.getByRole('button', { name: /read the question aloud/i }));
    await startSpeaking(user);
    finishRecording();

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].inputMode).toBe('spoken');
    // `promptMode` is read through the same ref the auto-submit branch uses, so
    // a question that was ACTUALLY played is still recorded as heard even
    // though nothing between the release and the POST re-rendered.
    expect(posted[0].promptMode).toBe('heard');
  });

  it('a SKIP is never `spoken`, and carries neither transcript nor confidence', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    // The confirm flow, because a skip after a transcript only exists there:
    // with auto-submit the words are graded before Skip can be pressed.
    renderSession({ voice: CONFIRM_FIRST, onAttempt: (input) => posted.push(input) });

    await startSpeaking(user);
    finishRecording();
    await waitFor(() => expect(answerField().value).toBe('the Constitution'));
    await user.click(screen.getByRole('button', { name: /^skip$/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    // The server rejects a skip carrying either, and rightly: there was no
    // answer to transcribe. `promptMode` still travels — how the question
    // reached them is true whether or not they answered it.
    expect(posted[0].skipped).toBe(true);
    expect(posted[0].inputMode).toBe('typed');
    expect(posted[0].transcript).toBeUndefined();
    expect('asrConfidence' in posted[0]).toBe(false);
    expect(posted[0].promptMode).toBe('read');
  });

  it('goes back to `typed` when the learner throws the transcript away', async () => {
    // `record-attempt.dto.ts`'s own worked example: a learner who spoke, saw
    // the transcript and typed something else instead is a TYPED attempt.
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    // "Type it instead" belongs to the confirm step, so this is the opt-out's
    // behaviour — unchanged by #286.
    renderSession({ voice: CONFIRM_FIRST, onAttempt: (input) => posted.push(input) });

    await startSpeaking(user);
    finishRecording();
    await waitFor(() => expect(answerField().value).toBe('the Constitution'));

    await user.click(screen.getByRole('button', { name: /type it instead/i }));
    expect(answerField().value).toBe('');

    await user.type(answerField(), 'the supreme law');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].inputMode).toBe('typed');
    expect(posted[0].transcript).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// 5. THE TOGGLE KEEPS THE SESSION
// -----------------------------------------------------------------------------

describe('switching between speaking and typing mid-session', () => {
  it('voice → text → voice preserves the progress counter and the answered questions', async () => {
    const posted: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({
      // The session is resumed with one question already answered, so "the
      // questions already answered" is a real fact on screen rather than one
      // this test would have to create and then hope survived.
      detail: detailFor({
        nextQuestion: QUESTION_2,
        progress: { answered: 1, planned: 5 },
        attempts: [makeAttempt()],
      }),
      onAttempt: (input) => posted.push(input),
    });

    await screen.findByRole('heading', { level: 2, name: QUESTION_2.prompt });
    expect(screen.getByText('Question 2 of 5')).toBeInTheDocument();

    // Voice…
    await user.click(screen.getByRole('button', { name: /^voice$/i }));
    expect(
      await screen.findByRole('button', { name: /hold to record/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Question 2 of 5')).toBeInTheDocument();

    // …text…
    await user.click(screen.getByRole('button', { name: /^text$/i }));
    expect(screen.queryByRole('button', { name: /hold to record/i })).toBeNull();
    expect(screen.getByText('Question 2 of 5')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: QUESTION_2.prompt }),
    ).toBeInTheDocument();

    // …and back. Nothing restarted, nothing re-fetched, nothing re-asked.
    await user.click(screen.getByRole('button', { name: /^voice$/i }));
    expect(
      await screen.findByRole('button', { name: /hold to record/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Question 2 of 5')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: QUESTION_2.prompt }),
    ).toBeInTheDocument();
    expect(posted).toHaveLength(0);

    // And the session still records against the question it was on.
    await user.type(answerField(), 'it sets up the government');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].questionId).toBe(QUESTION_2.id);
  });

  it('keeps typing available at all times, including in voice mode', async () => {
    const user = userEvent.setup();
    renderSession();

    await startSpeaking(user);
    // `voice.md` §5: the text path is unconditional. The field is present and
    // usable with the microphone on screen.
    expect(answerField()).toBeEnabled();
    await user.type(answerField(), 'the Constitution');
    expect(answerField().value).toBe('the Constitution');
  });

  it('offers no microphone and no toggle when `transcribe` is unbound', async () => {
    const user = userEvent.setup();
    renderSession({ transcribeBound: false });

    // The notice is what stands where the microphone would have been.
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /speak/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /hold to record/i })).toBeNull();

    // And the session is a complete, working, text-mode session.
    await user.type(answerField(), 'the Constitution');
    expect(screen.getByRole('button', { name: /^submit$/i })).toBeEnabled();
  });
});

// -----------------------------------------------------------------------------
// 6. ACCESSIBILITY, THEMES AND WIDTH
// -----------------------------------------------------------------------------

describe('the confirmation step is reachable and announced', () => {
  it('is announced in a live region and edited through a real `<label>`', async () => {
    const user = userEvent.setup();
    renderSession({
      voice: CONFIRM_FIRST,
      transcription: { text: 'the constitutional', confidence: 0.41 },
    });

    await startSpeaking(user);
    finishRecording();

    const heading = await screen.findByText(/that may not be what you said/i);
    // A `role="status"` ancestor: the transcript announces itself when it
    // lands, rather than waiting for somebody to go looking for why the
    // microphone stopped.
    const live = heading.closest('[role="status"]');
    expect(live).not.toBeNull();
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(within(live as HTMLElement).getByRole('button', { name: /record again/i })).toBeInTheDocument();

    // The editable transcript is bound to a REAL label, not a placeholder.
    const field = answerField();
    expect(field).toBeInTheDocument();
    const label = document.querySelector(`label[for="${field.id}"]`);
    expect(label?.textContent).toMatch(/your answer/i);
  });

  it('is reachable and operable from the keyboard alone', async () => {
    const user = userEvent.setup();
    const posted: RecordPracticeAttemptInput[] = [];
    renderSession({ voice: CONFIRM_FIRST, onAttempt: (input) => posted.push(input) });

    await startSpeaking(user);
    finishRecording();
    await waitFor(() => expect(answerField().value).toBe('the Constitution'));

    // The transcript takes focus, so the correction is one keystroke away.
    expect(document.activeElement).toBe(answerField());

    // The confirmation's own controls sit just before the field in the DOM, so
    // they are one and two shifted tabs away — reachable, in reading order,
    // with no pointer and no focus trap between them.
    await user.tab({ shift: true });
    expect((document.activeElement as HTMLElement).textContent).toBe(
      'Type it instead',
    );
    await user.tab({ shift: true });
    expect((document.activeElement as HTMLElement).textContent).toBe(
      'Record again',
    );

    // …and Enter in the field submits the confirmed answer, with no pointer
    // anywhere in the flow.
    answerField().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].transcript).toBe('the Constitution');
  });

  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ] as const)('renders the confirmation at 360px in %s', async (_name, theme) => {
    setViewportWidth(PHONE);
    const user = userEvent.setup();
    renderSession({
      voice: CONFIRM_FIRST,
      theme,
      transcription: { text: 'the constitutional', confidence: 0.41 },
    });

    await startSpeaking(user);
    finishRecording();

    expect(
      await screen.findByText(/that may not be what you said/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record again/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /use this answer/i })).toBeVisible();
    expect(answerField()).toBeVisible();
  });

  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ] as const)('renders the CORRECTION at 360px in %s', async (_name, theme) => {
    setViewportWidth(PHONE);
    const user = userEvent.setup();
    renderSession({
      theme,
      transcription: { text: 'the constitutional', confidence: 0.41 },
    });

    await startSpeaking(user);
    finishRecording();

    expect(
      await screen.findByText(/that may not be what you said/i),
    ).toBeVisible();
    expect(correctionButton()).toBeVisible();
    expect(screen.getByRole('button', { name: /record it again/i })).toBeVisible();

    await user.click(correctionButton() as HTMLElement);
    // A REAL `<label>` of its own, not a placeholder and not a second control
    // bound to the disabled "Your answer" field above it.
    const field = correctionField();
    expect(field).toBeVisible();
    const label = document.querySelector(`label[for="${field.id}"]`);
    expect(label?.textContent).toMatch(/what you actually said/i);
    expect(screen.getByRole('button', { name: /use this instead/i })).toBeVisible();
  });

  it('does not announce the correction twice — the verdict region owns that', async () => {
    const user = userEvent.setup();
    renderSession({ transcription: { text: 'the constitutional', confidence: 0.41 } });

    await startSpeaking(user);
    finishRecording();
    const heading = await screen.findByText(/that may not be what you said/i);

    // OUTSIDE the verdict's `role="status"` region, and carrying no live region
    // of its own: an `<Alert>`'s default `role="alert"` firing beside the
    // verdict's own announcement reads as two unrelated interruptions.
    expect(heading.closest('[role="status"]')).toBeNull();
    expect(heading.closest('[role="alert"]')).toBeNull();
  });
});

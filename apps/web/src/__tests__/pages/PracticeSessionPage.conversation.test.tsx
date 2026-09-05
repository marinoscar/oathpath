/**
 * The session-wide `Text | Voice` control and the hands-free loop it mounts
 * (issue #313, epic #304 / E13).
 *
 * `PracticeSessionPage.voice.test.tsx` covers the HAND-DRIVEN spoken flow and
 * is untouched by this file: choosing Voice and not starting the loop is still
 * E9/E12's push-to-talk, byte for byte, which is what
 * `docs/specs/conversation-mode.md` §10's degradation row promises. What is
 * asserted here is everything #313 adds on top, and each claim exists because
 * of a specific way it could quietly stop being true:
 *
 *  1. **THE CONTROL IS SESSION-WIDE AND SITS ABOVE THE QUESTION.** It is no
 *     longer a choice about which control to type into — it decides how the
 *     whole session is conducted, which is why `conversation-mode.md` §7
 *     formally amends `voice.md` §5 rather than contradicting it. Its position
 *     is asserted against the question heading itself, not against a class
 *     name.
 *  2. **THE CHOICE SURVIVES A RELOAD**, because it is `voice.conversationMode`
 *     and nothing else. A mode kept in component state would make "one tap"
 *     true exactly once per session, which is not what the epic promises — and
 *     returning to the built-in default sends the NULL-DELETE, never `false`,
 *     or a learner is pinned to today's default forever (`useVoicePrefs`'s own
 *     header).
 *  3. **QUESTION 1 SPEAKS.** `hasUserGesture` used to be set in
 *     `submitAttempt` and nowhere else, so a learner who turned
 *     `voice.readQuestionsAloud` on got silence on the one question they most
 *     clearly asked to hear. `PracticeSessionPage.questionAudio.test.tsx`
 *     asserts the gap as it was; this asserts it closed, from the mode tap.
 *  4. **"TYPE INSTEAD" WORKS FROM EVERY PHASE**, and takes nothing with it.
 *     The session, the answered questions and the progress counter all live on
 *     the server, so a learner who gets on a bus mid-walk loses none of them —
 *     `voice.md` §5, preserved by `conversation-mode.md` §7.
 *  5. **THE VOICE OPTION IS ABSENT, NOT DISABLED**, when `transcribe` is
 *     unbound, and the reason is on screen. Locked decision 4: the alternative
 *     — discovering mid-walk that nothing can record you — is strictly worse
 *     than never offering the mode.
 *  6. **THE QUESTION IS READ ONCE.** The loop reads it through its own player,
 *     so the page's autoplay must stand down or the learner hears the same
 *     sentence twice, over itself.
 *  7. **The control has a real accessible name and works from the keyboard.**
 */

import { CssBaseline, ThemeProvider } from '@mui/material';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
  PracticeOutcome,
  PracticeQuestion,
  PracticeSession,
  PracticeSessionDetail,
  RecordPracticeAttemptInput,
  VoiceSettings,
} from '../../types';
import { server } from '../mocks/server';
import { mockUser } from '../utils/test-utils';

// -----------------------------------------------------------------------------
// The microphone. jsdom has no `MediaRecorder`, so the real hook answers
// `unsupported` before any of this could happen — the hook's own six failure
// causes are covered exhaustively by `hooks/useAudioCapture.test.ts`.
//
// ONE FAKE SERVES BOTH CALLS the page makes (the per-answer hook and the
// persistent one), which is stricter than the browser: there, the loop's
// recording cannot reach the page's own transcription effect because they are
// different instances. Here they are the same object, so this fake is what
// proves the page's `conversationRunningRef` guard actually holds.
// -----------------------------------------------------------------------------

const captureControl = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    state: { status: 'idle' } as { status: string; blob?: Blob },
    stream: {} as MediaStream,
    starts: 0,
    releases: 0,
    streamReleases: 0,
    set(next: { status: string; blob?: Blob }) {
      this.state = next;
      listeners.forEach((listener) => listener());
    },
    reset() {
      this.state = { status: 'idle' };
      this.starts = 0;
      this.releases = 0;
      this.streamReleases = 0;
    },
  };
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

      const start = useCallback(() => {
        captureControl.starts += 1;
      }, []);
      const stop = useCallback(() => {}, []);
      const release = useCallback(() => {
        captureControl.releases += 1;
        captureControl.set({ status: 'idle' });
      }, []);
      const releaseStream = useCallback(() => {
        captureControl.streamReleases += 1;
      }, []);
      const acquireStream = useCallback(
        async () => captureControl.stream,
        [],
      );

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
        stream: captureControl.stream,
        acquireStream,
        releaseStream,
      };
    },
  };
});

/** The recorder hands over its bytes. */
function deliverRecording() {
  act(() => {
    captureControl.set({
      status: 'recorded',
      blob: new Blob(['audio'], { type: 'audio/webm' }),
    });
  });
}

// -----------------------------------------------------------------------------
// The detector. Mocked so this file can DRIVE the loop: jsdom has no
// `AudioContext`, so the real hook's `arm()` reports `unavailable` and no
// onset, hangover or barge-in can ever fire. Its own machine is covered against
// synthetic levels by `hooks/useVoiceActivity.test.ts` — what is needed here is
// a way to say "the learner started talking" and "the learner stopped".
// -----------------------------------------------------------------------------

const vadControl = vi.hoisted(() => ({
  onEvent: null as ((event: { type: string }) => void) | null,
  armed: [] as string[],
  reset() {
    this.onEvent = null;
    this.armed = [];
  },
}));

vi.mock('../../hooks/useVoiceActivity', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useVoiceActivity: (options: { onEvent?: (event: { type: string }) => void }) => {
      vadControl.onEvent = options.onEvent ?? null;
      return {
        state: { status: 'idle', mode: null, thresholds: null },
        isArmed: false,
        arm: (mode: string) => vadControl.armed.push(mode),
        disarm: () => {},
        getLevel: () => 0,
      };
    },
  };
});

function emitVoiceActivity(type: string) {
  act(() => {
    vadControl.onEvent?.({ type });
  });
}

// -----------------------------------------------------------------------------
// The browser's own voice, controllable. `autoEnd: false` HOLDS the loop in
// whichever speaking phase it is in, which is the only way a test can stand in
// `speakingQuestion` long enough to assert anything about it.
// -----------------------------------------------------------------------------

interface FakeUtterance {
  text: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

const speech = {
  spoken: [] as string[],
  live: [] as FakeUtterance[],
  autoEnd: true,
};

function installSpeechSynthesis() {
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      cancel: vi.fn(() => {
        const interrupted = speech.live;
        speech.live = [];
        for (const utterance of interrupted) utterance.onerror?.({ error: 'canceled' });
      }),
      speak: vi.fn((utterance: FakeUtterance) => {
        speech.spoken.push(utterance.text);
        utterance.onstart?.();
        if (speech.autoEnd) utterance.onend?.();
        else speech.live.push(utterance);
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

/** Let whatever is speaking finish, the way a real engine eventually does. */
async function finishSpeaking() {
  await act(async () => {
    const live = speech.live;
    speech.live = [];
    for (const utterance of live) utterance.onend?.();
  });
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const API_BASE = '*/api';
const SESSION_ID = 'session-1';

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
  startedAt: '2026-09-01T12:00:00.000Z',
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
    inputMode: 'spoken',
    promptMode: 'heard',
    responseText: 'the Constitution',
    outcome: 'correct',
    gradingMethod: 'exact',
    revealed: false,
    hintUsed: false,
    durationMs: 4200,
    failureCause: null,
    aiFeedback: null,
    aiUsageEventId: null,
    transcript: 'the Constitution',
    asrConfidence: 0.94,
    retryOfAttemptId: null,
    answeredAt: '2026-09-01T12:01:00.000Z',
    answerSnapshot: {
      resolvedAt: '2026-09-01T12:01:00.000Z',
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

function detailFor(overrides: Partial<PracticeSessionDetail> = {}): PracticeSessionDetail {
  return {
    session: SESSION_BASE,
    nextQuestion: QUESTION_1,
    progress: { answered: 0, planned: 5 },
    attempts: [],
    ...overrides,
  };
}

/**
 * The stored settings document, SHARED ACROSS RENDERS in one test.
 *
 * That is the whole point of the reload assertion: unmounting and rendering
 * again has to read back what the first mount wrote, which a per-render fixture
 * could never show.
 */
let stored: Record<string, unknown>;
/** Every `voice` patch body the page sent, in order. */
let voicePatches: Array<Record<string, unknown>>;
let posted: RecordPracticeAttemptInput[];
let transcribeCalls: number;

interface Options {
  detail?: PracticeSessionDetail;
  transcribeBound?: boolean;
  outcome?: PracticeOutcome;
  nextQuestion?: PracticeQuestion | null;
  transcript?: string;
}

function installHandlers(options: Options = {}) {
  const detail = options.detail ?? detailFor();

  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    // `speak` UNBOUND throughout — the ordinary fresh install — so every
    // utterance below takes the browser path and this file's fake is the only
    // voice in play. The premium path is `QuestionAudio`'s own business and is
    // covered where it belongs.
    unboundRoles:
      options.transcribeBound === false ? ['transcribe', 'speak'] : ['speak'],
  };

  server.use(
    http.get(`${API_BASE}/user-settings`, () => HttpResponse.json({ data: stored })),
    // FIELD-WISE within `voice`, exactly as `mergeVoice` merges server-side —
    // and `null` is the delete, which is what makes the null-delete assertion
    // below a test of behaviour rather than of a request body alone.
    http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
      const body = (await request.json()) as { voice?: Record<string, unknown> };
      if (body.voice) voicePatches.push(body.voice);
      const merged = { ...((stored.voice as Record<string, unknown>) ?? {}) };
      for (const [key, value] of Object.entries(body.voice ?? {})) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      stored = { ...stored, voice: merged, version: (stored.version as number) + 1 };
      return HttpResponse.json({ data: stored });
    }),
    http.get(`${API_BASE}/ai/status`, () => HttpResponse.json({ data: status })),
    http.get(`${API_BASE}/practice/sessions/${SESSION_ID}`, () =>
      HttpResponse.json({ data: detail }),
    ),
    http.post(`${API_BASE}/ai/speech/transcribe`, () => {
      transcribeCalls += 1;
      return HttpResponse.json({
        data: {
          status: 'ok',
          text: options.transcript ?? 'the Constitution',
          confidence: 0.94,
        },
      });
    }),
    http.post(
      `${API_BASE}/practice/sessions/${SESSION_ID}/attempts`,
      async ({ request }) => {
        const input = (await request.json()) as RecordPracticeAttemptInput;
        posted.push(input);
        const attempt = makeAttempt({
          id: `attempt-${posted.length}`,
          questionId: input.questionId,
          outcome: options.outcome ?? 'correct',
          retryOfAttemptId: input.retryOfAttemptId ?? null,
        });
        const result: PracticeAttemptResult = {
          attempt,
          acceptedAnswers: attempt.answerSnapshot.answers,
          nextQuestion:
            options.nextQuestion === undefined ? QUESTION_2 : options.nextQuestion,
          // The counter the server would report after this row — the page
          // never increments it in the browser, and the phase assertions below
          // depend on it staying coherent with the detail it was seeded from.
          progress: { answered: (detail.progress.answered ?? 0) + 1, planned: 5 },
        };
        return HttpResponse.json({ data: result });
      },
    ),
  );
}

function renderSession() {
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

function modeGroup() {
  return screen.getByRole('group', { name: 'How you want to answer' });
}

function voiceOption() {
  return screen.queryByRole('button', { name: /^voice$/i });
}

/** Wait for the question, then choose Voice. THE mode tap #313 is about. */
async function chooseVoice(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
  await waitFor(() => expect(voiceOption()).not.toBeNull());
  await user.click(voiceOption() as HTMLElement);
}

function setStoredVoice(voice?: VoiceSettings) {
  stored = {
    theme: 'system',
    profile: { useProviderImage: true, customImageUrl: null },
    ...(voice ? { voice } : {}),
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  };
}

beforeEach(() => {
  captureControl.reset();
  vadControl.reset();
  speech.spoken = [];
  speech.live = [];
  speech.autoEnd = true;
  posted = [];
  voicePatches = [];
  transcribeCalls = 0;
  setStoredVoice();
  installSpeechSynthesis();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// 1 + 7. The control itself
// -----------------------------------------------------------------------------

describe('the session-wide Text | Voice control', () => {
  it('is labelled Voice, not Speak, and sits ABOVE the question', async () => {
    installHandlers();
    renderSession();

    const heading = await screen.findByRole('heading', {
      level: 2,
      name: QUESTION_1.prompt,
    });
    await waitFor(() => expect(voiceOption()).not.toBeNull());

    const group = modeGroup();
    expect(within(group).getByRole('button', { name: /^text$/i })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: /^voice$/i })).toBeInTheDocument();
    // The old per-question label is gone, not merely moved.
    expect(screen.queryByRole('button', { name: /^speak$/i })).toBeNull();

    // ABOVE THE QUESTION, asserted against the question itself rather than
    // against a class name or a test id — position is the claim.
    expect(
      group.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('has a real accessible name and is operable from the keyboard alone', async () => {
    const user = userEvent.setup();
    installHandlers();
    renderSession();

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await waitFor(() => expect(voiceOption()).not.toBeNull());

    // The GROUP is named, which is what tells a screen-reader user what "Text"
    // and "Voice" are a choice between before either label means anything.
    expect(modeGroup()).toBeInTheDocument();

    // Real `<button>`s: focusable by tab order, activated by Enter.
    const voice = voiceOption() as HTMLElement;
    voice.focus();
    expect(voice).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(
      await screen.findByRole('button', { name: /start hands-free/i }),
    ).toBeInTheDocument();
  });

  it('is ABSENT — not disabled — when no `transcribe` model is bound, and says why', async () => {
    installHandlers({ transcribeBound: false });
    renderSession();

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    // The reason, from the shared notice rather than a sentence written here.
    await screen.findByText(/answering out loud is not available yet/i);

    expect(voiceOption()).toBeNull();
    expect(screen.queryByRole('group', { name: 'How you want to answer' })).toBeNull();
    // Nothing to start, either: the mode is not reachable at all.
    expect(screen.queryByRole('button', { name: /start hands-free/i })).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// 2. The choice is a stored preference
// -----------------------------------------------------------------------------

describe('the mode is `voice.conversationMode`, not component state', () => {
  it('writes the preference when Voice is chosen, and reads it back on reload', async () => {
    const user = userEvent.setup();
    installHandlers();
    const first = renderSession();

    await chooseVoice(user);
    await waitFor(() => expect(voicePatches).toEqual([{ conversationMode: true }]));

    first.unmount();

    // A "reload": a fresh mount against the document the first one wrote.
    installHandlers();
    renderSession();

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    // Landed in Voice with nobody touching the control.
    expect(
      await screen.findByRole('button', { name: /start hands-free/i }),
    ).toBeInTheDocument();
  });

  it('sends the NULL-DELETE when the learner goes back to Text', async () => {
    const user = userEvent.setup();
    setStoredVoice({ conversationMode: true });
    installHandlers();
    renderSession();

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await screen.findByRole('button', { name: /start hands-free/i });

    await user.click(screen.getByRole('button', { name: /^text$/i }));

    // `null`, never `false`: writing today's default back pins this learner to
    // it forever, including after a later release moves it.
    await waitFor(() => expect(voicePatches).toEqual([{ conversationMode: null }]));
    await waitFor(() =>
      expect((stored.voice as Record<string, unknown>).conversationMode).toBeUndefined(),
    );
  });
});

// -----------------------------------------------------------------------------
// 3. Question 1 speaks
// -----------------------------------------------------------------------------

describe('`voice.readQuestionsAloud` on the FIRST question (#313)', () => {
  it('reads question 1 aloud from the mode tap, with nothing submitted first', async () => {
    const user = userEvent.setup();
    setStoredVoice({ readQuestionsAloud: true });
    installHandlers();
    renderSession();

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    // Nothing yet: a browser refuses sound before the document is touched.
    expect(speech.spoken).toEqual([]);

    await user.click(voiceOption() as HTMLElement);

    // THE GESTURE IS THE MODE TAP. No answer has been submitted, and none
    // needs to be.
    await waitFor(() => expect(speech.spoken).toEqual([QUESTION_1.prompt]));
    expect(posted).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// 4 + 6. The loop
// -----------------------------------------------------------------------------

/** Start the loop and hold it in `speakingQuestion`. */
async function startLoop(user: ReturnType<typeof userEvent.setup>) {
  await chooseVoice(user);
  speech.autoEnd = false;
  speech.spoken = [];
  await user.click(screen.getByRole('button', { name: /start hands-free/i }));
  await screen.findByText('Asking you the question.');
  // The phase is set a render BEFORE the loop's player mounts, so waiting on
  // the phase alone would race the audio it is describing.
  await waitFor(() => expect(speech.spoken).toContain(QUESTION_1.prompt));
}

describe('the hands-free loop', () => {
  it('reads, hears, grades, answers and moves on — from ONE tap', async () => {
    const user = userEvent.setup();
    installHandlers();
    renderSession();

    await startLoop(user);

    // READ ONCE. The page's own autoplay stands down while the loop drives, or
    // the learner hears the same sentence twice, over itself.
    expect(speech.spoken).toEqual([QUESTION_1.prompt]);

    await finishSpeaking();
    await screen.findByText('Listening. Answer when you are ready.');

    // The learner speaks, and stops.
    emitVoiceActivity('onset');
    expect(captureControl.starts).toBeGreaterThan(0);
    emitVoiceActivity('endOfTurn');
    await screen.findByText('Working out how that went.');

    deliverRecording();

    // ONE transcription, and ONE attempt: the page's own transcription effect
    // stood down for a recording the driver owns.
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(transcribeCalls).toBe(1);
    expect(posted[0].inputMode).toBe('spoken');
    expect(posted[0].transcript).toBe('the Constitution');
    expect(posted[0].promptMode).toBe('heard');

    // The accepted answer is read back, and then the loop moves on by itself.
    await screen.findByText('Telling you the answer.');
    await waitFor(() => expect(speech.spoken).toContain('the Constitution'));
    await finishSpeaking();

    await screen.findByRole('heading', { level: 2, name: QUESTION_2.prompt });
  });

  it('stops, spoken and on screen, when there is no next question', async () => {
    const user = userEvent.setup();
    installHandlers({ nextQuestion: null });
    renderSession();

    await startLoop(user);
    await finishSpeaking();
    emitVoiceActivity('onset');
    emitVoiceActivity('endOfTurn');
    deliverRecording();

    await waitFor(() => expect(posted).toHaveLength(1));
    await screen.findByText('Telling you the answer.');
    await finishSpeaking();

    // Rendered as well as spoken — a learner who glances at the screen, has
    // sound off, or is using a screen reader gets the same sentence.
    await screen.findByText(/that was the last question/i);
  });
});

// -----------------------------------------------------------------------------
// 4. "Type instead", from every phase
// -----------------------------------------------------------------------------

describe('"Type instead" is reachable at every phase, and costs nothing', () => {
  /** Drive the loop to one named phase and leave it there. */
  async function driveTo(
    user: ReturnType<typeof userEvent.setup>,
    phase: string,
  ) {
    await startLoop(user);
    if (phase === 'speakingQuestion') return;

    await finishSpeaking();
    await screen.findByText('Listening. Answer when you are ready.');
    if (phase === 'listening') return;

    emitVoiceActivity('onset');
    emitVoiceActivity('endOfTurn');
    await screen.findByText('Working out how that went.');
    if (phase === 'processing') return;

    deliverRecording();
    await screen.findByText('Telling you the answer.');
    if (phase === 'speakingAnswer') return;

    await finishSpeaking();
    await screen.findByText('Moving on to the next question.');
  }

  const PHASES = [
    'speakingQuestion',
    'listening',
    'processing',
    'speakingAnswer',
    'advancing',
  ];

  it.each(PHASES)(
    'from %s: leaves the loop, keeps the session, keeps the counter',
    async (phase) => {
      const user = userEvent.setup();
      installHandlers({
        detail: detailFor({
          nextQuestion: QUESTION_1,
          progress: { answered: 1, planned: 5 },
          attempts: [makeAttempt()],
        }),
      });
      renderSession();

      await screen.findByText('Question 2 of 5');
      await driveTo(user, phase);

      await user.click(screen.getByRole('button', { name: /type instead/i }));

      // Back on the typed control, with the session intact: the questions
      // already answered, the counter and the question on screen all come from
      // the server and none of them moved.
      expect(
        await screen.findByRole('button', { name: /^text$/i }),
      ).toHaveAttribute('aria-pressed', 'true');
      // The typed control is back. It is DISABLED once an attempt has been
      // graded — that is E3's own rule, not conversation mode's — so what is
      // asserted here is that it is on screen and labelled, not that it is
      // editable at a moment the page has never allowed editing.
      expect(screen.getByLabelText(/your answer/i)).toBeInTheDocument();
      expect(screen.getByText('Question 2 of 5')).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { level: 2, name: QUESTION_1.prompt }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /start hands-free/i })).toBeNull();

      // A SILENT exit. The learner asked for it; being told what you just did
      // is not information.
      expect(screen.queryByText(/conversation mode has stopped/i)).toBeNull();
    },
  );
});

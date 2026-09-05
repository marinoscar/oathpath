/**
 * One tap: `/practice` → a session → the hands-free loop running (issue #350,
 * epic #345).
 *
 * This is the only suite in the repository that renders BOTH practice screens
 * in one router, and it has to be: the claim it exists to hold is about what
 * happens ACROSS the navigation between them, and neither screen can show it
 * alone. `PracticePage.modeChoice.test.tsx` covers the choice itself,
 * `PracticeSessionPage.conversation.test.tsx` covers the loop itself, and
 * neither is touched by this file.
 *
 * What is asserted here, each claim an acceptance criterion of #350:
 *
 *  1. **EXACTLY ONE TAP.** With Voice chosen and remembered, "Start a Quick 5"
 *     starts the session AND the loop. Measured with an INSTRUMENTED TAP COUNT
 *     — every `click` event that reaches the document while the session is
 *     starting — because "one tap" is a claim about the learner's hands, not
 *     about which functions happened to be called. #313 shipped two taps on two
 *     controls in two blocks; a regression to that costs a number here.
 *  2. **TEXT IS UNCHANGED.** The same one tap in Text mode starts the session
 *     and arms nothing — no microphone, no phase line — and the explicit
 *     control is on screen for a learner who changes their mind.
 *  3. **THE EXPLICIT CONTROL SURVIVES WHERE IT IS NEEDED.** A session opened
 *     directly (resumed from Recent sessions, a reload, a link) lands on Voice
 *     if that is the stored preference and WAITS. A stored preference is not a
 *     gesture, and a microphone that opens itself on a screen the learner
 *     merely navigated to is the failure this rule prevents.
 *  4. **REVERSIBILITY IS UNTOUCHED.** "Type instead" is on screen in the
 *     auto-armed loop's very first phase and ends it, keeping the session, the
 *     answered questions and the progress counter.
 *  5. **A BLOCKED MICROPHONE STOPS THE ARM, NOT THE SESSION.** The automatic
 *     start runs #349's preflight exactly as the manual one does: the session
 *     is created, the loop is not armed, the remedy is on screen, and typing is
 *     one control away.
 */

import { CssBaseline, ThemeProvider } from '@mui/material';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { AuthContext } from '../../contexts/AuthContext';
import { LearnerProfileProvider } from '../../contexts/LearnerProfileContext';
import PracticePage from '../../pages/PracticePage';
import PracticeSessionPage from '../../pages/PracticeSessionPage';
import { describeCaptureProblem } from '../../hooks/useAudioCapture';
import { CONVERSATION_MODE_LABEL } from '../../components/settings/VoiceSettings';
import { lightTheme } from '../../theme';
import type {
  AiStatus,
  PracticeQueue,
  PracticeQuestion,
  PracticeSessionDetail,
  VoiceSettings,
} from '../../types';
import { server } from '../mocks/server';
import { mockUser } from '../utils/test-utils';
import { ORIENTED_PROFILE } from '../utils/journey-fixtures';
import { CATEGORIES, civicsHandlers, journeyProfileHandler } from '../utils/civics-fixtures';

// -----------------------------------------------------------------------------
// The microphone and the detector, faked exactly as
// `PracticeSessionPage.conversation.test.tsx` fakes them: jsdom has neither
// `MediaRecorder` nor `AudioContext`, so without these the loop could not run at
// all and this file would be asserting nothing.
// -----------------------------------------------------------------------------

const captureControl = vi.hoisted(() => ({
  stream: {} as MediaStream,
  starts: 0,
}));

vi.mock('../../hooks/useAudioCapture', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { useCallback } = await import('react');

  return {
    ...actual,
    useAudioCapture: () => {
      const start = useCallback(() => {
        captureControl.starts += 1;
      }, []);
      const noop = useCallback(() => {}, []);
      const acquireStream = useCallback(async () => captureControl.stream, []);
      return {
        state: { status: 'idle' },
        isRecording: false,
        recording: null,
        start,
        stop: noop,
        release: noop,
        stream: captureControl.stream,
        acquireStream,
        startPreRoll: noop,
        releaseStream: noop,
      };
    },
  };
});

vi.mock('../../hooks/useVoiceActivity', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useVoiceActivity: () => ({
      state: { status: 'idle', mode: null, thresholds: null },
      isArmed: false,
      arm: () => {},
      disarm: () => {},
      getLevel: () => 0,
    }),
  };
});

// -----------------------------------------------------------------------------
// The browser's own voice. `autoEnd: false` HOLDS the loop in whichever
// speaking phase it reaches, which is what lets a case stand in
// `speakingQuestion` long enough to assert the loop is actually running.
// -----------------------------------------------------------------------------

interface FakeUtterance {
  text: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

const speech = { spoken: [] as string[], live: [] as FakeUtterance[] };

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
        speech.live.push(utterance);
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
// The platform the preflight reads. `getUserMedia` is a spy with no behaviour:
// the preflight must never reach it on any path in this file.
// -----------------------------------------------------------------------------

let getUserMedia: ReturnType<typeof vi.fn>;

function installMediaEnvironment({ permission = 'granted' as PermissionState } = {}) {
  getUserMedia = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => [
        { kind: 'audioinput', deviceId: '', label: '' } as MediaDeviceInfo,
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    configurable: true,
  });
  Object.defineProperty(navigator, 'permissions', {
    value: {
      query: vi.fn(async () => ({
        state: permission,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    },
    configurable: true,
  });
  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = class {};
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const API_BASE = '*/api';
const SESSION_ID = 'session-started';

const QUESTION_1: PracticeQuestion = {
  id: 'question-1',
  number: 1,
  prompt: 'What is the supreme law of the land?',
  categoryId: CATEGORIES[0].id,
  dynamicScope: 'none',
};

const QUEUE: PracticeQueue = {
  testVersionCode: 'v2008',
  total: 10,
  due: 0,
  weak: 0,
  new: {
    total: 10,
    byCategory: CATEGORIES.map((category) => ({
      categoryId: category.id,
      categoryName: category.name,
      newCount: 2,
    })),
  },
  learning: 0,
  mastered: 0,
};

/** A session two questions in, for the progress-counter claim. */
const DETAIL: PracticeSessionDetail = {
  session: {
    id: SESSION_ID,
    kind: 'quick',
    status: 'in_progress',
    testVersionCode: 'v2008',
    categoryId: null,
    plannedCount: 5,
    startedAt: '2026-09-01T12:00:00.000Z',
    completedAt: null,
    summary: null,
  },
  nextQuestion: QUESTION_1,
  progress: { answered: 2, planned: 5 },
  attempts: [],
};

let started: number;
let stored: Record<string, unknown>;

function setStoredVoice(voice?: VoiceSettings) {
  stored = {
    theme: 'system',
    profile: { useProviderImage: true, customImageUrl: null },
    ...(voice ? { voice } : {}),
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  };
}

function installHandlers() {
  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    // `speak` unbound — the ordinary fresh install — so every utterance takes
    // the browser path and this file's fake is the only voice in play.
    unboundRoles: ['speak'],
  };

  server.use(
    ...civicsHandlers(),
    journeyProfileHandler(ORIENTED_PROFILE),
    http.get(`${API_BASE}/user-settings`, () => HttpResponse.json({ data: stored })),
    http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
      const body = (await request.json()) as { voice?: Record<string, unknown> };
      const merged = { ...((stored.voice as Record<string, unknown>) ?? {}) };
      for (const [key, value] of Object.entries(body.voice ?? {})) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      stored = { ...stored, voice: merged, version: (stored.version as number) + 1 };
      return HttpResponse.json({ data: stored });
    }),
    http.get(`${API_BASE}/ai/status`, () => HttpResponse.json({ data: status })),
    http.get(`${API_BASE}/practice/queue`, () => HttpResponse.json({ data: QUEUE })),
    http.get(`${API_BASE}/practice/sessions`, () =>
      HttpResponse.json({
        data: { items: [], total: 0, page: 1, pageSize: 5, totalPages: 1 },
      }),
    ),
    http.get(`${API_BASE}/practice/sessions/${SESSION_ID}`, () =>
      HttpResponse.json({ data: DETAIL }),
    ),
    http.post(`${API_BASE}/practice/sessions`, () => {
      started += 1;
      return HttpResponse.json({ data: DETAIL });
    }),
  );
}

function renderApp(initialEntry = '/practice') {
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
          <MemoryRouter initialEntries={[initialEntry]}>
            <Routes>
              <Route element={<LearnerProfileProvider />}>
                <Route path="/practice" element={<PracticePage />} />
                <Route
                  path="/practice/sessions/:id"
                  element={<PracticeSessionPage />}
                />
                <Route
                  path="/practice/sessions/:id/summary"
                  element={<h1>Practice summary</h1>}
                />
              </Route>
            </Routes>
          </MemoryRouter>
        </AiStatusProvider>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

/**
 * The instrumented tap count.
 *
 * EVERY `click` THAT REACHES THE DOCUMENT, captured, so it counts what a
 * learner's finger did rather than what the page decided to do about it. It is
 * reset immediately before the one tap under test, so page setup cannot inflate
 * or deflate it.
 */
function countTaps() {
  const counter = { taps: 0 };
  const listener = () => {
    counter.taps += 1;
  };
  document.addEventListener('click', listener, true);
  return {
    get taps() {
      return counter.taps;
    },
    reset() {
      counter.taps = 0;
    },
    stop() {
      document.removeEventListener('click', listener, true);
    },
  };
}

function quickFive() {
  return screen.findByRole('button', { name: /start a quick 5|review now/i });
}

/** The picker is loaded AND the AI status has settled, so Voice is on offer. */
async function readyPicker() {
  await quickFive();
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /^voice$/i })).not.toBeNull(),
  );
}

beforeEach(() => {
  started = 0;
  captureControl.starts = 0;
  speech.spoken = [];
  speech.live = [];
  setStoredVoice();
  installSpeechSynthesis();
  installMediaEnvironment();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(navigator, 'permissions');
  Reflect.deleteProperty(window, 'MediaRecorder');
  Reflect.deleteProperty(window, 'isSecureContext');
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// 1. One tap
// -----------------------------------------------------------------------------

describe('starting a Quick 5 with Voice remembered', () => {
  it('starts the session AND the loop from exactly one tap', async () => {
    const user = userEvent.setup();
    setStoredVoice({ conversationMode: true });
    installHandlers();
    renderApp();

    await readyPicker();
    // The mode came from storage, so getting here cost nothing.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^voice$/i })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );

    const taps = countTaps();
    taps.reset();

    await user.click(await quickFive());

    // The session exists…
    await waitFor(() => expect(started).toBe(1));
    // …and the loop is RUNNING, not merely selected: the phase line and the
    // Stop control are both things only a running loop puts on screen.
    expect(await screen.findByText('Asking you the question.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeInTheDocument();
    // The phase is set a render BEFORE the loop's player mounts, so waiting on
    // the phase alone would race the audio it is describing.
    await waitFor(() => expect(speech.spoken).toContain(QUESTION_1.prompt));

    // THE NUMBER. One finger, one press.
    expect(taps.taps).toBe(1);
    // And the redundant second control is gone from this path: nothing on
    // screen is asking to be pressed to start something already started.
    expect(screen.queryByRole('button', { name: /start hands-free/i })).toBeNull();

    taps.stop();
  });

  it('costs one tap to choose Voice and one to start, on the first ever session', async () => {
    const user = userEvent.setup();
    installHandlers(); // nothing stored: this learner has never chosen
    renderApp();

    await readyPicker();

    const taps = countTaps();
    taps.reset();

    await user.click(screen.getByRole('button', { name: /^voice$/i }));
    await user.click(await quickFive());

    await waitFor(() => expect(started).toBe(1));
    await screen.findByText('Asking you the question.');

    // TWO, and only for a learner who has never expressed a preference — the
    // choice and the start. Every session after this one costs one, because the
    // choice was stored; the case above is that session.
    expect(taps.taps).toBe(2);
    await waitFor(() =>
      expect((stored.voice as Record<string, unknown>).conversationMode).toBe(true),
    );

    taps.stop();
  });
});

// -----------------------------------------------------------------------------
// 1b. The setting's LABEL, pinned against what it does
// -----------------------------------------------------------------------------

describe('`voice.conversationMode`’s label and its behaviour agree', () => {
  it('promises a hands-free START, and a start with it on is hands-free', async () => {
    const user = userEvent.setup();

    // THE PROMISE, read out of the exact string `/settings/voice` renders —
    // imported, not retyped, so a reworded label reaches this assertion.
    expect(CONVERSATION_MODE_LABEL).toMatch(/^start\b/i);
    expect(CONVERSATION_MODE_LABEL).toMatch(/practice session/i);
    expect(CONVERSATION_MODE_LABEL).toMatch(/hands-free/i);

    // THE BEHAVIOUR. `conversationMode: true` is what that switch stores, so
    // this is the same account one tick after a learner turned it on.
    setStoredVoice({ conversationMode: true });
    installHandlers();
    renderApp();

    await readyPicker();
    await user.click(await quickFive());

    // Started — a practice session, hands-free, from the act the label calls
    // starting one. Until #350 this assertion failed: the switch seeded a mode
    // and the loop still waited behind a second tap on "Start hands-free".
    await waitFor(() => expect(started).toBe(1));
    expect(await screen.findByText('Asking you the question.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start hands-free/i })).toBeNull();
  });

  it('starts nothing hands-free with the switch off — the label is not a lie either way', async () => {
    const user = userEvent.setup();
    setStoredVoice({ conversationMode: false });
    installHandlers();
    renderApp();

    await readyPicker();
    await user.click(await quickFive());

    await waitFor(() => expect(started).toBe(1));
    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    expect(screen.queryByText('Asking you the question.')).toBeNull();
    expect(captureControl.starts).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// 2. Text is unchanged
// -----------------------------------------------------------------------------

describe('starting a Quick 5 in Text mode', () => {
  it('starts the session and arms nothing', async () => {
    const user = userEvent.setup();
    installHandlers();
    renderApp();

    await readyPicker();
    const taps = countTaps();
    taps.reset();

    await user.click(await quickFive());

    await waitFor(() => expect(started).toBe(1));
    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });

    expect(taps.taps).toBe(1);
    // No loop, no microphone, no sound.
    expect(screen.queryByText('Asking you the question.')).toBeNull();
    expect(screen.queryByText('Opening your microphone.')).toBeNull();
    expect(captureControl.starts).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    // The answer field is what is on screen, and it is focused.
    expect(screen.getByLabelText(/your answer/i)).toBeInTheDocument();

    taps.stop();
  });
});

// -----------------------------------------------------------------------------
// 3. The explicit arm control, where it is genuinely needed
// -----------------------------------------------------------------------------

describe('a session opened directly, not started from the picker', () => {
  it('lands on Voice but WAITS for a deliberate tap', async () => {
    setStoredVoice({ conversationMode: true });
    installHandlers();
    // A resumed session, a reload, a link — no hand-off in the navigation.
    renderApp(`/practice/sessions/${SESSION_ID}`);

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });

    // The mode is honoured…
    expect(
      await screen.findByRole('button', { name: /start hands-free/i }),
    ).toBeInTheDocument();
    // …and nothing started itself. A stored preference is not a gesture, and a
    // microphone that opens on a screen somebody merely navigated to is the
    // failure this rule exists to prevent.
    await waitFor(() => expect(captureControl.starts).toBe(0));
    expect(screen.queryByText('Asking you the question.')).toBeNull();
    expect(speech.spoken).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// 4. Reversibility, from the auto-armed loop
// -----------------------------------------------------------------------------

describe('"Type instead", from a loop nobody armed by hand', () => {
  it('is on screen in the first phase, and costs the learner nothing', async () => {
    const user = userEvent.setup();
    setStoredVoice({ conversationMode: true });
    installHandlers();
    renderApp();

    await readyPicker();
    await user.click(await quickFive());
    await screen.findByText('Asking you the question.');

    // Reachable from the phase the auto-arm lands in — the same control the
    // hand-armed loop renders, from the same branch, at every phase.
    await user.click(screen.getByRole('button', { name: /type instead/i }));

    // The typed control is back…
    expect(screen.getByLabelText(/your answer/i)).toBeInTheDocument();
    // …the loop is over…
    expect(screen.queryByText('Asking you the question.')).toBeNull();
    // …and NOTHING about the session went with it: the same question, the same
    // counter the server reported, and no new session was created.
    expect(
      screen.getByRole('heading', { level: 2, name: QUESTION_1.prompt }),
    ).toBeInTheDocument();
    expect(screen.getByText('Question 3 of 5')).toBeInTheDocument();
    expect(started).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// 5. The preflight runs on the automatic path too
// -----------------------------------------------------------------------------

describe('with the microphone blocked', () => {
  it('starts the session, refuses the arm, and says what to do', async () => {
    const user = userEvent.setup();
    setStoredVoice({ conversationMode: true });
    installMediaEnvironment({ permission: 'denied' });
    installHandlers();
    renderApp();

    await readyPicker();
    // The warning is already on the picker (#349), before anything is created.
    const problem = describeCaptureProblem('permission_denied');
    await screen.findByText(problem.message);

    await user.click(await quickFive());

    // The session was created — a blocked microphone is not a reason to stop
    // somebody practising.
    await waitFor(() => expect(started).toBe(1));
    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });

    // The loop was NOT armed, the remedy is on screen, and both ways out are
    // there: fix it and press Start, or type.
    await waitFor(() =>
      expect(screen.getByText(problem.remedy)).toBeInTheDocument(),
    );
    expect(screen.queryByText('Opening your microphone.')).toBeNull();
    expect(screen.queryByText('Asking you the question.')).toBeNull();
    expect(captureControl.starts).toBe(0);
    expect(
      screen.getByRole('button', { name: /start hands-free/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /type instead/i })).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Housekeeping: the fake voice must not be left holding an utterance open
// between cases, which would make a later case's phase assertion read a stale
// one. `act` because ending an utterance drives the loop.
// -----------------------------------------------------------------------------

afterEach(async () => {
  await act(async () => {
    const live = speech.live;
    speech.live = [];
    for (const utterance of live) utterance.onend?.();
  });
});

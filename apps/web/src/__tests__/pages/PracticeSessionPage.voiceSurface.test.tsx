/**
 * Entering and leaving the full-screen voice surface (issue #356, epic #345).
 *
 * `components/voice/VoiceSurface.test.tsx` covers the surface in isolation —
 * the viewport, the four states, the one live region, the controls. This file
 * covers the one thing that can only be seen from the page: THE SWAP.
 *
 *  1. **A RUNNING VOICE SESSION IS A DIFFERENT SCREEN**, not this one
 *     restyled. The answer field, the mode picker and the Start control are
 *     GONE while the loop drives — they belong to the text path — and the
 *     document has exactly one `h1` and exactly one live region either way.
 *  2. **`getLevel()` REACHES THE METER.** `useVoiceActivity` has published a
 *     level ~40x a second since #347 and nothing has ever read it. The wiring
 *     runs page → surface → visual, and a break anywhere along it looks
 *     exactly like a quiet room.
 *  3. **THE SCREEN AND THE AUDIO AGREE.** What was heard and the verdict come
 *     from `spokenTurn` (#351), rendered rather than re-derived — a second
 *     description of one verdict is free to disagree with the first, and the
 *     one a learner trusts is whichever they noticed second.
 *  4. **LEAVING COSTS NOTHING.** Stop and "Type instead" both return to the
 *     existing page with the session, the answered questions and the progress
 *     counter intact — which is structural, because none of those three was
 *     ever in the browser: they are `GET /api/practice/sessions/:id`'s.
 *  5. **THE SWAP IS PER-TRANSPORT, NOT PER-DRIVER (#381).** Sections 1-4 run
 *     over E13's request/response loop, whose `conversation.isRunning` was for
 *     a while the ONLY thing that could open this surface — so on every
 *     deployment with a `realtime` model bound, which is the ladder's FIRST
 *     rung and therefore the common case, the surface could never render at
 *     all and a learner who asked to talk was handed a keyboard. Section 5 is
 *     that regression, pinned.
 */

import { CssBaseline, ThemeProvider } from '@mui/material';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { AuthContext } from '../../contexts/AuthContext';
import PracticeSessionPage, {
  realtimeSessionIsUnderWay,
  realtimeStageAsPhase,
} from '../../pages/PracticeSessionPage';
import { VOICE_SURFACE_TITLE } from '../../components/voice/VoiceSurface';
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
import { drainSpokenTurn } from '../utils/fake-speech';
import { mockUser } from '../utils/test-utils';

// -----------------------------------------------------------------------------
// The microphone, the detector and the voice — the same three fakes
// `PracticeSessionPage.conversation.test.tsx` installs, for the same reasons
// (jsdom has no `MediaRecorder`, no `AudioContext` and no speech engine). The
// ONE difference is that this file's detector hands out a REAL SPY for
// `getLevel`, because whether anything calls it is the point of case 2.
// -----------------------------------------------------------------------------

const captureControl = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    state: { status: 'idle' } as { status: string; blob?: Blob },
    // ENOUGH OF A `MediaStream` FOR BOTH TRANSPORTS. E13's driver only ever
    // passes it around, but the realtime transport hands its audio tracks to a
    // peer connection (`services/realtimeConnection.ts`), so a bare `{}` would
    // throw on `getAudioTracks()` before the surface could ever render.
    stream: {
      getTracks: () => [{ kind: 'audio', stop() {} }],
      getAudioTracks: () => [{ kind: 'audio', stop() {} }],
    } as unknown as MediaStream,
    set(next: { status: string; blob?: Blob }) {
      this.state = next;
      listeners.forEach((listener) => listener());
    },
    reset() {
      this.state = { status: 'idle' };
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

      const noop = useCallback(() => {}, []);
      const release = useCallback(() => {
        captureControl.set({ status: 'idle' });
      }, []);
      const acquireStream = useCallback(async () => captureControl.stream, []);

      return {
        state: captureControl.state,
        isRecording: captureControl.state.status === 'recording',
        recording:
          captureControl.state.status === 'recorded'
            ? (captureControl.state.blob ?? null)
            : null,
        start: noop,
        stop: noop,
        release,
        stream: captureControl.stream,
        acquireStream,
        startPreRoll: noop,
        releaseStream: noop,
      };
    },
  };
});

function deliverRecording() {
  act(() => {
    captureControl.set({
      status: 'recorded',
      blob: new Blob(['audio'], { type: 'audio/webm' }),
    });
  });
}

const vadControl = vi.hoisted(() => ({
  onEvent: null as ((event: { type: string }) => void) | null,
  // THE SPY THIS FILE EXISTS FOR. Stable across renders, exactly as the real
  // hook's `useCallback`-wrapped getter is, so a consumer's animation frame
  // loop is not torn down and restarted on every commit.
  getLevel: vi.fn(() => 0.5),
  reset() {
    this.onEvent = null;
    this.getLevel.mockClear();
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
        arm: () => {},
        disarm: () => {},
        getLevel: vadControl.getLevel,
      };
    },
  };
});

function emitVoiceActivity(type: string) {
  act(() => {
    vadControl.onEvent?.({ type });
  });
}

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

/**
 * Let whatever is speaking finish.
 *
 * DRAINS UNTIL QUIET, NOT ONCE (#403). This used to be a single pass, which is
 * the shape that is wrong the moment a turn is more than one utterance: ending
 * line 1 merely makes line 2 live, and the helper returns with the loop still
 * mid-turn. #403 made the coach speak a verdict, a reason and the accepted
 * answer where it used to speak one line, so every call site of this became
 * exposed at once. `utils/fake-speech.ts` carries the rule and the argument.
 */
async function finishSpeaking() {
  await drainSpokenTurn(speech);
}

function installMediaEnvironment() {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: vi.fn(),
      enumerateDevices: vi.fn(async () => [
        { kind: 'audioinput', deviceId: '', label: '' },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    configurable: true,
  });
  Object.defineProperty(navigator, 'permissions', {
    value: {
      query: vi.fn(async () => ({
        state: 'granted' as PermissionState,
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

/** The composed turn #351 put on the wire. The SCREEN renders exactly this. */
const SPOKEN_TURN = ['That’s right.', 'The answer is the Constitution.'];

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
    coachReaction: null,
    spokenTurn: SPOKEN_TURN,
    retryBoundary: null,
    ...overrides,
  };
}

function detailFor(): PracticeSessionDetail {
  return {
    session: SESSION_BASE,
    nextQuestion: QUESTION_1,
    // ONE ALREADY ANSWERED. The counter is what has to survive the round trip
    // to the surface and back, so it must not read `1 of 5` by coincidence.
    progress: { answered: 1, planned: 5 },
    attempts: [makeAttempt()],
  };
}

let stored: Record<string, unknown>;
let posted: RecordPracticeAttemptInput[];

function installHandlers() {
  const detail = detailFor();
  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    // `realtime` PINNED UNBOUND (#355, epic #345 / E15): this file exercises
    // the surface over E13's request/response loop, and the ladder in
    // `PracticeSessionPage.tsx` resolves Voice to the LIVE transport whenever a
    // `realtime` model is bound. The realtime rungs are
    // `PracticeSessionPage.realtime.test.tsx`'s.
    unboundRoles: ['speak', 'realtime'],
  };

  server.use(
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
    http.get(`${API_BASE}/practice/sessions/${SESSION_ID}`, () =>
      HttpResponse.json({ data: detail }),
    ),
    http.post(`${API_BASE}/ai/speech/transcribe`, () =>
      HttpResponse.json({
        data: { status: 'ok', text: 'the Constitution', confidence: 0.94 },
      }),
    ),
    http.post(
      `${API_BASE}/practice/sessions/${SESSION_ID}/attempts`,
      async ({ request }) => {
        const input = (await request.json()) as RecordPracticeAttemptInput;
        posted.push(input);
        const attempt = makeAttempt({ id: `attempt-${posted.length + 1}` });
        const result: PracticeAttemptResult = {
          attempt,
          acceptedAnswers: attempt.answerSnapshot.answers,
          nextQuestion: QUESTION_2,
          progress: { answered: 2, planned: 5 },
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
              <Route path="/practice" element={<h1>Practice</h1>} />
            </Routes>
          </MemoryRouter>
        </AiStatusProvider>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

/** Choose Voice, then arm the loop, and hold it in `speakingQuestion`. */
async function startLoop(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /^voice$/i })).not.toBeNull(),
  );
  await user.click(screen.getByRole('button', { name: /^voice$/i }));
  speech.autoEnd = false;
  speech.spoken = [];
  await user.click(screen.getByRole('button', { name: /start hands-free/i }));
  await screen.findByText('Asking you the question.');
  await waitFor(() => expect(speech.spoken).toContain(QUESTION_1.prompt));
}

function surface(): HTMLElement {
  return screen.getByRole('region', { name: VOICE_SURFACE_TITLE });
}

function liveRegions(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      '[aria-live],[role="status"],[role="alert"],[role="log"]',
    ),
  ).filter((element) => element.closest('[aria-hidden="true"]') === null);
}

beforeEach(() => {
  captureControl.reset();
  vadControl.reset();
  speech.spoken = [];
  speech.live = [];
  speech.autoEnd = true;
  posted = [];
  stored = {
    theme: 'system',
    profile: { useProviderImage: true, customImageUrl: null },
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  };
  installSpeechSynthesis();
  installMediaEnvironment();
});

afterEach(() => {
  document.body.style.overflow = '';
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(navigator, 'permissions');
  Reflect.deleteProperty(window, 'MediaRecorder');
  Reflect.deleteProperty(window, 'isSecureContext');
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// 1. The swap
// -----------------------------------------------------------------------------

describe('a running voice session is its own screen', () => {
  it('replaces the practice page, and takes its form and its chrome with it', async () => {
    const user = userEvent.setup();
    installHandlers();
    renderSession();

    // Before: the ordinary page, with the typed control and the picker.
    expect(await screen.findByLabelText(/your answer/i)).toBeInTheDocument();

    await startLoop(user);

    // After: the surface, and NOT this page restyled — the text path's own
    // controls are gone rather than hidden, which is what makes them free to
    // keep the layout they have for the learners still typing.
    expect(surface()).toBeInTheDocument();
    expect(screen.queryByLabelText(/your answer/i)).toBeNull();
    expect(screen.queryByRole('group', { name: 'How you want to answer' })).toBeNull();
    expect(screen.queryByRole('button', { name: /start hands-free/i })).toBeNull();

    // The question is still the `h2`, under the surface's single `h1`.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      VOICE_SURFACE_TITLE,
    );
    expect(
      screen.getByRole('heading', { level: 2, name: QUESTION_1.prompt }),
    ).toBeInTheDocument();

    // ONE live region for the whole screen — the loop's own player is mounted
    // (it is what is speaking) and contributes none, because it is hidden from
    // the accessibility tree along with its "Reading the question aloud."
    expect(liveRegions(document.body)).toHaveLength(1);
    expect(liveRegions(document.body)[0]).toHaveTextContent('Asking you the question.');

    // The cost guardrails, both of them.
    expect(screen.getByText('Elapsed 0:00')).toBeInTheDocument();
    expect(screen.getByText(/runs on your own AI key/i)).toBeInTheDocument();

    // And the document itself cannot scroll while this is up.
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('drives the meter from `useVoiceActivity.getLevel()`', async () => {
    const user = userEvent.setup();
    installHandlers();
    renderSession();

    await startLoop(user);
    // Nothing reads a level while the question is being asked: it is not the
    // learner's turn, and there is no meter to move.
    expect(vadControl.getLevel).not.toHaveBeenCalled();

    await finishSpeaking();
    await screen.findByText('Listening. Answer when you are ready.');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    // THE FIRST CONSUMER THAT HOOK HAS EVER HAD. A break anywhere on the path
    // page → surface → visual looks exactly like a silent room, which is why
    // it is asserted end to end rather than only in the component's own test.
    expect(vadControl.getLevel).toHaveBeenCalled();
    expect(screen.getByTestId('voice-level-meter').style.transform).toMatch(/^scale\(1\./);
  });
});

// -----------------------------------------------------------------------------
// 2. What the learner's answer is doing
// -----------------------------------------------------------------------------

describe('the screen and the audio agree about the answer', () => {
  it('shows what was heard and the composed spoken turn, not a second wording', async () => {
    const user = userEvent.setup();
    installHandlers();
    renderSession();

    await startLoop(user);
    await finishSpeaking();
    await screen.findByText('Listening. Answer when you are ready.');

    emitVoiceActivity('onset');
    emitVoiceActivity('endOfTurn');
    await screen.findByText('Working out how that went.');
    deliverRecording();

    await waitFor(() => expect(posted).toHaveLength(1));
    await screen.findByText('Telling you the answer.');

    const [region] = liveRegions(document.body);
    // What was heard, as it was graded.
    expect(region).toHaveTextContent('We heard “the Constitution”');
    // …and the verdict, verbatim from `spokenTurn` (#351). Not re-derived from
    // `outcome` and `acceptedAnswers`: two descriptions of one verdict are free
    // to disagree, and the audio is reading this one.
    for (const line of SPOKEN_TURN) expect(region).toHaveTextContent(line);
  });
});

// -----------------------------------------------------------------------------
// 3. Leaving costs nothing
// -----------------------------------------------------------------------------

describe('leaving the surface', () => {
  it('Stop returns to the practice page with the session and the counter intact', async () => {
    const user = userEvent.setup();
    installHandlers();
    renderSession();

    await screen.findByText('Question 2 of 5');
    await startLoop(user);

    await user.click(screen.getByRole('button', { name: /^stop$/i }));

    // Back on the page it left, mid-session: the question, the counter and the
    // answered rows all came from the server and none of them moved.
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: VOICE_SURFACE_TITLE })).toBeNull(),
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Practice');
    expect(screen.getByText('Question 2 of 5')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: QUESTION_1.prompt }),
    ).toBeInTheDocument();
    // Still in Voice — Stop ended the loop, not the mode — with the arm
    // control back where #350 leaves it for a resumed session.
    expect(screen.getByRole('button', { name: /^voice$/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.getByRole('button', { name: /start hands-free/i }),
    ).toBeInTheDocument();

    // The body lock is released with the surface, not left behind.
    expect(document.body.style.overflow).toBe('');
  });

  it('"Type instead" returns to the typed control AND puts the caret in it', async () => {
    const user = userEvent.setup();
    installHandlers();
    renderSession();

    await startLoop(user);
    await user.click(screen.getByRole('button', { name: /type instead/i }));

    const field = await screen.findByLabelText(/your answer/i);
    expect(screen.getByRole('button', { name: /^text$/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // THE FIELD IS FOCUSED. Pressed from the surface, the field is not in the
    // tree yet, so the old direct `focus()` call silently did nothing and left
    // a keyboard user on a detached node the browser resets to `<body>`.
    expect(field).toHaveFocus();
    expect(screen.getByText('Question 2 of 5')).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// 5. The realtime transport (#381)
// -----------------------------------------------------------------------------
//
// Everything above pins `realtime` UNBOUND, deliberately, so that it keeps
// exercising E13's request/response loop. This section is the other transport:
// the same surface, entered from `realtime.stage` instead of from
// `conversation.isRunning`.
//
// The fakes are `PracticeSessionPage.realtime.test.tsx`'s, kept to the minimum
// this file needs — a peer connection whose data channel the test opens by
// hand, so that `connecting` is a stable, observable stage rather than a frame
// between two awaits.
// -----------------------------------------------------------------------------

class FakeDataChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 'closed';
  });
}

class FakePeerConnection {
  connectionState = 'new';
  channel: FakeDataChannel | null = null;
  addedTracks: unknown[] = [];
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  closed = false;

  constructor() {
    peerConnections.push(this);
  }
  createDataChannel() {
    this.channel = new FakeDataChannel();
    return this.channel;
  }
  addTrack(track: unknown) {
    this.addedTracks.push(track);
  }
  getReceivers() {
    return [];
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\nfake-offer' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {
    this.closed = true;
  }
}

let peerConnections: FakePeerConnection[] = [];

/** The mint's answer. `unavailable` is how this file reaches `fallback`. */
type MintOutcome = 'ok' | 'unavailable';

/**
 * The same wire as `installHandlers`, with `realtime` BOUND.
 *
 * `transcribe` stays bound too, so that a fallback lands on E13's loop rather
 * than all the way on text — which is what makes the `fallback` case below able
 * to assert that a learner can still restart by voice.
 */
function installRealtimeHandlers(mint: MintOutcome = 'ok') {
  const detail = detailFor();
  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    unboundRoles: ['speak'],
  };

  server.use(
    http.get(`${API_BASE}/user-settings`, () => HttpResponse.json({ data: stored })),
    http.patch(`${API_BASE}/user-settings`, () => HttpResponse.json({ data: stored })),
    http.get(`${API_BASE}/ai/status`, () => HttpResponse.json({ data: status })),
    http.get(`${API_BASE}/practice/sessions/${SESSION_ID}`, () =>
      HttpResponse.json({ data: detail }),
    ),
    http.post(`${API_BASE}/practice/sessions/${SESSION_ID}/realtime-session`, () =>
      HttpResponse.json({
        data:
          mint === 'ok'
            ? {
                status: 'ok',
                clientSecret: 'ek_ephemeral_secret_for_one_session',
                expiresAt: '2026-09-01T12:01:00.000Z',
                modelId: 'gpt-4o-realtime-preview',
              }
            : { status: 'unavailable', cause: 'role_unbound' },
      }),
    ),
    http.post(
      `${API_BASE}/practice/sessions/${SESSION_ID}/realtime/tool-calls`,
      () =>
        HttpResponse.json({
          data: {
            status: 'ok',
            tool: 'next_question',
            say: [QUESTION_1.prompt],
            then: 'await_answer',
            questionId: QUESTION_1.id,
            instruction:
              'Speak every line in say, in order, word for word, and then stop. ' +
              'Say nothing else: do not add, drop, reorder, summarise or explain a ' +
              'line, do not announce that you are calling a tool or waiting for one, ' +
              'and never mention the application, the session or its grading.',
            // THE QUESTION THE COACH WAS HANDED (#402). The surface renders
            // this, not the session endpoint's own freshly-drawn `nextQuestion`
            // — so a fixture that omits it renders no prompt at all, which is
            // the honest answer to "nothing has been asked yet".
            question: QUESTION_1,
          },
        }),
    ),
    // Browser ↔ provider, directly. Never an API route of this application's.
    http.post('https://api.openai.com/v1/realtime/calls', () =>
      HttpResponse.text('v=0\r\nfake-answer'),
    ),
  );
}

/** Choose Voice on a deployment where Voice means the live transport. */
async function chooseVoice(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /^voice$/i })).not.toBeNull(),
  );
  await user.click(screen.getByRole('button', { name: /^voice$/i }));
  await screen.findByRole('button', { name: /start live voice/i });
}

/** Press Start and stop at `connecting`: the data channel is left unopened. */
async function startConnecting(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /start live voice/i }));
}

/** Open the data channel, which is what takes the hook from `connecting` to `live`. */
async function goLive() {
  await waitFor(() => expect(peerConnections.length).toBe(1));
  await act(async () => {
    const dc = peerConnections[0].channel!;
    dc.readyState = 'open';
    dc.onopen?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function typingControlsArePresent(): boolean {
  return screen.queryByLabelText(/your answer/i) !== null;
}

beforeEach(() => {
  peerConnections = [];
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
    FakePeerConnection;
});

afterEach(() => {
  Reflect.deleteProperty(
    globalThis as unknown as Record<string, unknown>,
    'RTCPeerConnection',
  );
});

describe('the stage → phase mapping', () => {
  it('maps the two stages a session is under way in, and nothing else', () => {
    // The two that matter, and the only two the gate ever renders.
    expect(realtimeStageAsPhase('connecting', false)).toBe('preparing');
    expect(realtimeStageAsPhase('connecting', true)).toBe('preparing');

    // `live` IS TWO PICTURES, NOT ONE (#386). It used to collapse to
    // `listening` unconditionally, so the surface read "Listening" for the
    // whole session — including while the coach was reading the question out
    // loud, which invited a learner to answer a question that had not
    // finished being asked.
    expect(realtimeStageAsPhase('live', false)).toBe('listening');
    expect(realtimeStageAsPhase('live', true)).toBe('speakingQuestion');

    // The three the surface must NOT be showing for. They map to `idle` so the
    // mapping is total; correctness for them comes from the gate excluding
    // them, which is the next `describe`.
    for (const speaking of [false, true]) {
      expect(realtimeStageAsPhase('idle', speaking)).toBe('idle');
      expect(realtimeStageAsPhase('fallback', speaking)).toBe('idle');
      expect(realtimeStageAsPhase('ended', speaking)).toBe('idle');
    }
  });

  it('calls exactly `connecting` and `live` a session under way', () => {
    expect(realtimeSessionIsUnderWay('connecting')).toBe(true);
    expect(realtimeSessionIsUnderWay('live')).toBe(true);
    expect(realtimeSessionIsUnderWay('idle')).toBe(false);
    expect(realtimeSessionIsUnderWay('fallback')).toBe(false);
    expect(realtimeSessionIsUnderWay('ended')).toBe(false);
  });
});

describe('a live realtime session is its own screen — THE #381 REGRESSION GUARD', () => {
  it('renders the surface, and NOT the typing layout, while the stage is `live`', async () => {
    const user = userEvent.setup();
    installRealtimeHandlers();
    renderSession();
    await chooseVoice(user);
    await startConnecting(user);
    await goLive();

    // THE BUG, IN ONE ASSERTION. Before #381 this branch could not be taken at
    // all — `conversation.isRunning` is `false` for the whole life of a
    // realtime session — so a learner who asked to talk fell through to the
    // ordinary page and was handed the keyboard.
    expect(await screen.findByRole('region', { name: VOICE_SURFACE_TITLE }))
      .toBeInTheDocument();
    expect(screen.queryByLabelText('Your answer')).toBeNull();
    expect(screen.queryByRole('button', { name: /^submit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /show me the answer/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^skip$/i })).toBeNull();

    // And the inline realtime panel is not underneath it either — the early
    // return is what makes that structural rather than a `display: none`.
    expect(screen.queryByRole('button', { name: /start live voice/i })).toBeNull();
    expect(screen.queryByText(/billed by the minute/i)).toBeNull();

    // The surface's own chrome, on the transport that never had it.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      VOICE_SURFACE_TITLE,
    );
    expect(
      screen.getByRole('heading', { level: 2, name: QUESTION_1.prompt }),
    ).toBeInTheDocument();
    expect(screen.getByText('Question 2 of 5')).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('renders the surface, and NOT the typing layout, while the stage is `connecting`', async () => {
    const user = userEvent.setup();
    installRealtimeHandlers();
    renderSession();
    await chooseVoice(user);
    await startConnecting(user);

    // `connecting` IS a session: the microphone is open and the mint has been
    // spent on the learner's own key. They are waiting on a voice, not on a
    // control, and the keyboard is the wrong screen for that.
    expect(await screen.findByRole('region', { name: VOICE_SURFACE_TITLE }))
      .toBeInTheDocument();
    expect(screen.queryByLabelText('Your answer')).toBeNull();
    expect(screen.queryByRole('button', { name: /^submit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /show me the answer/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^skip$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /start live voice/i })).toBeNull();
  });

  it('takes the phase sentence from `REALTIME_STAGE_TEXT`, never from E13’s table', async () => {
    const user = userEvent.setup();
    installRealtimeHandlers();
    renderSession();
    await chooseVoice(user);
    await startConnecting(user);
    await goLive();

    // SCOPED TO THE SURFACE, not to the document: the inline realtime panel
    // renders the identical sentence from the identical table, so an unscoped
    // query would pass on the very bug this file exists to pin.
    const [region] = liveRegions(surface());
    // The live transport's own sentence, from the table its own inline panel
    // shares with it.
    expect(region).toHaveTextContent('Live. Talk to the coach whenever you are ready.');
    // NOT `CONVERSATION_PHASE_TEXT[listening]`, which is the phase this stage
    // MAPS TO — the mapping decides the picture, never the words. A wiring
    // that looked the sentence up from the mapped phase would read this, and
    // would be describing a driver that is not running.
    expect(region).not.toHaveTextContent('Listening. Answer when you are ready.');
  });

  it('shows what the provider heard, which is the realtime transport’s own field', async () => {
    const user = userEvent.setup();
    installRealtimeHandlers();
    renderSession();
    await chooseVoice(user);
    await startConnecting(user);
    await goLive();

    // A realtime attempt is recorded by the engine inside the tool-call route
    // and never sets this page's `result`, so the surface reads
    // `realtime.heard` on this transport — the same field the inline panel
    // renders as "Heard: …". Nothing has been said yet, so there is nothing to
    // show, and the region is the phase sentence alone.
    const [region] = liveRegions(surface());
    expect(region).not.toHaveTextContent('We heard');
  });
});

describe('leaving the realtime surface', () => {
  it('Stop stops the REALTIME session, not E13’s driver', async () => {
    const user = userEvent.setup();
    installRealtimeHandlers();
    renderSession();
    await chooseVoice(user);
    await startConnecting(user);
    await goLive();

    // FROM THE SURFACE'S OWN CONTROL. The inline panel has an identically
    // named Stop, so an unscoped query would be testing the panel — which is
    // exactly what was on screen before #381.
    await user.click(within(surface()).getByRole('button', { name: /^stop$/i }));

    // THE CONNECTION IS CLOSED. Stopping E13's driver here would have returned
    // the learner to the ordinary page with the live connection still open and
    // still billing by the minute.
    await waitFor(() => expect(peerConnections[0].closed).toBe(true));

    // Back on the page it left, mid-session, still in Voice, with the control
    // that starts another one.
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: VOICE_SURFACE_TITLE })).toBeNull(),
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Practice');
    expect(screen.getByText('Question 2 of 5')).toBeInTheDocument();
    expect(typingControlsArePresent()).toBe(true);
    expect(
      await screen.findByRole('button', { name: /start live voice/i }),
    ).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });

  it('"Type instead" returns to the typed control and closes the connection', async () => {
    const user = userEvent.setup();
    installRealtimeHandlers();
    renderSession();
    await chooseVoice(user);
    await startConnecting(user);
    await goLive();

    await user.click(within(surface()).getByRole('button', { name: /type instead/i }));

    const field = await screen.findByLabelText(/your answer/i);
    expect(field).toHaveFocus();
    expect(screen.getByRole('button', { name: /^text$/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => expect(peerConnections[0].closed).toBe(true));
  });
});

describe('the stages the surface must NOT be showing for', () => {
  it('`idle`: the ordinary page, with the answer field and the Start control', async () => {
    const user = userEvent.setup();
    installRealtimeHandlers();
    renderSession();
    await chooseVoice(user);

    expect(screen.queryByRole('region', { name: VOICE_SURFACE_TITLE })).toBeNull();
    expect(typingControlsArePresent()).toBe(true);
    expect(
      screen.getByRole('button', { name: /start live voice/i }),
    ).toBeInTheDocument();
    // The panel's own copy, which lives nowhere else.
    expect(screen.getByText(/billed by the minute/i)).toBeInTheDocument();
  });

  it('`ended`: the ordinary page comes back, and the Start control with it', async () => {
    const user = userEvent.setup();
    installRealtimeHandlers();
    renderSession();
    await chooseVoice(user);
    await startConnecting(user);
    await goLive();
    await user.click(within(surface()).getByRole('button', { name: /^stop$/i }));

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: VOICE_SURFACE_TITLE })).toBeNull(),
    );
    expect(typingControlsArePresent()).toBe(true);
    expect(
      await screen.findByRole('button', { name: /start live voice/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/billed by the minute/i)).toBeInTheDocument();
  });

  it('`fallback`: the ordinary page, the spoken reason, and a way to go on', async () => {
    const user = userEvent.setup();
    installRealtimeHandlers('unavailable');
    renderSession();
    await chooseVoice(user);
    await startConnecting(user);

    // NO SURFACE. A fallback is not a session under way, so the gate keeps it
    // off the screen exactly as it does for `idle` and `ended`.
    await waitFor(() =>
      expect(screen.queryByText(/live voice practice is not set up/i)).not.toBeNull(),
    );
    expect(screen.queryByRole('region', { name: VOICE_SURFACE_TITLE })).toBeNull();

    // TYPING ALWAYS WORKS, in every cell of every ladder.
    expect(typingControlsArePresent()).toBe(true);

    // And the ladder has moved a rung, which is #355's behaviour and not this
    // change's: the realtime panel is UNMOUNTED on a fallback by definition
    // (`voiceTransport` is no longer `'realtime'`), and E13's loop is what
    // Voice means now — so there is still a spoken session one tap away.
    expect(screen.queryByRole('button', { name: /start live voice/i })).toBeNull();
    expect(
      await screen.findByRole('button', { name: /start hands-free/i }),
    ).toBeInTheDocument();
  });
});

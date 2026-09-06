/**
 * The screen stays awake for the SESSION, on either transport (issue #388).
 *
 * `useWakeLock.test.ts` proves the hook holds a lock while its flag is true and
 * drops it the moment it is not, and — since #388 — reads the source tree to
 * prove there is exactly ONE caller. Neither of those can prove the thing that
 * actually broke, which is only visible from the page: WHAT THE FLAG IS WIRED
 * TO.
 *
 * The shipped bug: the only `useWakeLock` call lived inside
 * `useConversationSession`, gated on that driver's phase. On the realtime
 * transport that driver is mounted and never runs, so its phase stayed `idle`
 * for the whole session and no lock was ever requested. A learner talking to
 * the live coach on a phone watched the screen go dark after the display
 * timeout and the session suspend — which, per `useWakeLock`'s header, is not
 * a dimmed session but a stopped one, mid-question, with no warning. And the
 * one affordance that would have revealed it was suppressed on exactly that
 * path (`!surfaceIsRealtime && !conversation.wakeLock.isSupported`), so the
 * learner least able to guess was the only one not told.
 *
 * Five claims, in the order they matter:
 *
 *  1. A REALTIME SESSION UNDER WAY TAKES THE LOCK — `connecting` as much as
 *     `live`, because `connecting` is already a session (the microphone is
 *     open and the mint is on the learner's key).
 *  2. SO DOES E13's LOOP, unchanged. The fix moved the lock, and moving it
 *     must not cost the transport that already had it.
 *  3. NEVER TWO, INCLUDING ACROSS A MID-SESSION FALLBACK. A live session that
 *     drops, exhausts its re-mints and lands on E13's loop is the sequence
 *     where two owners would overlap — so this file watches the number of
 *     SIMULTANEOUSLY HELD sentinels across the whole journey and asserts it
 *     never reaches 2.
 *  4. IT IS RELEASED when the session ends and when the page unmounts. A lock
 *     held after the session is a flat battery.
 *  5. THE WARNING IS TOLD TO THE LEARNER WHO NEEDS IT — rendered on the
 *     realtime path when the browser has no API, and absent when a lock is
 *     actually held. It promises nothing: the Screen Wake Lock API only holds
 *     while the document is visible, so the copy asks the learner to keep the
 *     page open and never implies practice continues with the phone locked.
 *
 * The fakes are `PracticeSessionPage.voiceSurface.test.tsx`'s, which is where
 * both transports are already driven end to end.
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
import { VOICE_SURFACE_TITLE } from '../../components/voice/VoiceSurface';
import { lightTheme } from '../../theme';
import type {
  AiStatus,
  PracticeAttempt,
  PracticeQuestion,
  PracticeSession,
  PracticeSessionDetail,
} from '../../types';
import { server } from '../mocks/server';
import { mockUser } from '../utils/test-utils';

// -----------------------------------------------------------------------------
// `navigator.wakeLock`, faked — and instrumented for the ONE fact this file
// exists to establish: how many sentinels are held AT THE SAME TIME.
//
// A count of requests is not that number. Across a fallback the lock is
// legitimately released and re-requested (one owner, flag true → false →
// true), which is two requests and never two locks. The bug shape is overlap,
// so overlap is what is measured — continuously, at every request and every
// release, not sampled at the end.
// -----------------------------------------------------------------------------

class FakeSentinel {
  released = false;
  private listeners: Array<() => void> = [];

  constructor(private readonly onChange: () => void) {}

  release = vi.fn(() => {
    if (!this.released) {
      this.released = true;
      this.onChange();
      for (const listener of this.listeners) listener();
    }
    return Promise.resolve();
  });

  addEventListener = vi.fn((type: string, listener: () => void) => {
    if (type === 'release') this.listeners.push(listener);
  });

  removeEventListener = vi.fn();
}

const lock = {
  sentinels: [] as FakeSentinel[],
  request: vi.fn(),
  /** The highest number of sentinels ever held at one instant. */
  peakHeld: 0,
  held(): number {
    return this.sentinels.filter((sentinel) => !sentinel.released).length;
  },
  observe() {
    this.peakHeld = Math.max(this.peakHeld, this.held());
  },
  reset() {
    this.sentinels = [];
    this.peakHeld = 0;
    this.request = vi.fn();
  },
};

function installWakeLock(): void {
  lock.reset();
  lock.request = vi.fn(() => {
    const sentinel = new FakeSentinel(() => lock.observe());
    lock.sentinels.push(sentinel);
    lock.observe();
    return Promise.resolve(sentinel as unknown as WakeLockSentinel);
  });
  Object.defineProperty(navigator, 'wakeLock', {
    value: { request: lock.request },
    configurable: true,
    writable: true,
  });
}

/** A browser with no Screen Wake Lock API at all: Firefox, pre-16.4 iOS. */
function removeWakeLock(): void {
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'wakeLock');
}

/** Let the hook's in-flight `request()` promise settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// -----------------------------------------------------------------------------
// The microphone, the detector and the voice — jsdom has none of the three.
// -----------------------------------------------------------------------------

const captureControl = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    state: { status: 'idle' } as { status: string; blob?: Blob },
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

vi.mock('../../hooks/useVoiceActivity', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useVoiceActivity: () => ({
      state: { status: 'idle', mode: null, thresholds: null },
      isArmed: false,
      arm: () => {},
      disarm: () => {},
      getLevel: () => 0.4,
    }),
  };
});

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

function installSpeechSynthesis(): void {
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

function installMediaEnvironment(): void {
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
// The connection, faked: the test opens and closes the data channel by hand.
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

const ATTEMPT: PracticeAttempt = {
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
  spokenTurn: ['That’s right.'],
  retryBoundary: null,
};

function detailFor(): PracticeSessionDetail {
  return {
    session: SESSION_BASE,
    nextQuestion: QUESTION_1,
    progress: { answered: 1, planned: 5 },
    attempts: [ATTEMPT],
  };
}

let stored: Record<string, unknown>;

/** How the mint answers. `'ok-then-unavailable'` is how a LIVE session falls. */
type MintPlan = 'ok' | 'unavailable' | 'ok-then-unavailable';

/**
 * The wire.
 *
 * `transcribe` is bound in every plan, so a realtime fallback lands on E13's
 * loop rather than all the way on typing — which is the journey claim 3 needs.
 */
function installHandlers(options: { realtime: boolean; mint?: MintPlan }): void {
  const detail = detailFor();
  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    unboundRoles: options.realtime ? ['speak'] : ['speak', 'realtime'],
  };

  let mints = 0;
  const mintBody = () => {
    mints += 1;
    const plan = options.mint ?? 'ok';
    const ok = plan === 'ok' || (plan === 'ok-then-unavailable' && mints === 1);
    return ok
      ? {
          status: 'ok',
          clientSecret: 'ek_ephemeral_secret_for_one_session',
          expiresAt: '2026-09-01T12:01:00.000Z',
          modelId: 'gpt-4o-realtime-preview',
        }
      : { status: 'unavailable', cause: 'role_unbound' };
  };

  server.use(
    http.get(`${API_BASE}/user-settings`, () => HttpResponse.json({ data: stored })),
    http.patch(`${API_BASE}/user-settings`, () => HttpResponse.json({ data: stored })),
    http.get(`${API_BASE}/ai/status`, () => HttpResponse.json({ data: status })),
    http.get(`${API_BASE}/practice/sessions/${SESSION_ID}`, () =>
      HttpResponse.json({ data: detail }),
    ),
    http.post(`${API_BASE}/practice/sessions/${SESSION_ID}/realtime-session`, () =>
      HttpResponse.json({ data: mintBody() }),
    ),
    http.post(`${API_BASE}/practice/sessions/${SESSION_ID}/realtime/tool-calls`, () =>
      HttpResponse.json({
        data: {
          status: 'ok',
          tool: 'next_question',
          say: [QUESTION_1.prompt],
          then: 'await_answer',
          questionId: QUESTION_1.id,
        },
      }),
    ),
    http.post(`${API_BASE}/ai/speech/transcribe`, () =>
      HttpResponse.json({
        data: { status: 'ok', text: 'the Constitution', confidence: 0.94 },
      }),
    ),
    http.post('https://api.openai.com/v1/realtime/calls', () =>
      HttpResponse.text('v=0\r\nfake-answer'),
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

function surface(): HTMLElement {
  return screen.getByRole('region', { name: VOICE_SURFACE_TITLE });
}

/** Choose Voice on a deployment where Voice means the LIVE transport. */
async function chooseLiveVoice(user: ReturnType<typeof userEvent.setup>) {
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

/** Open the data channel — what takes the hook from `connecting` to `live`. */
async function goLive() {
  await waitFor(() => expect(peerConnections.length).toBeGreaterThan(0));
  await act(async () => {
    const dc = peerConnections[peerConnections.length - 1].channel!;
    dc.readyState = 'open';
    dc.onopen?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Choose Voice, then arm E13's loop, holding it in `speakingQuestion`. */
async function startHandsFree(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /start hands-free/i })).not.toBeNull(),
  );
  speech.autoEnd = false;
  await user.click(screen.getByRole('button', { name: /start hands-free/i }));
  await screen.findByText('Asking you the question.');
}

const UNSUPPORTED_COPY = /can’t keep the screen awake/i;

beforeEach(() => {
  captureControl.reset();
  speech.spoken = [];
  speech.live = [];
  speech.autoEnd = true;
  peerConnections = [];
  stored = {
    theme: 'system',
    profile: { useProviderImage: true, customImageUrl: null },
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  };
  installSpeechSynthesis();
  installMediaEnvironment();
  installWakeLock();
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
    FakePeerConnection;
});

afterEach(() => {
  document.body.style.overflow = '';
  removeWakeLock();
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(navigator, 'permissions');
  Reflect.deleteProperty(window, 'MediaRecorder');
  Reflect.deleteProperty(window, 'isSecureContext');
  Reflect.deleteProperty(
    globalThis as unknown as Record<string, unknown>,
    'RTCPeerConnection',
  );
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// 1. The realtime transport — the path that had no lock at all
// -----------------------------------------------------------------------------

describe('a realtime session under way holds the screen awake', () => {
  it('requests the lock at `connecting`, before a word has been spoken', async () => {
    const user = userEvent.setup();
    installHandlers({ realtime: true });
    renderSession();
    await chooseLiveVoice(user);

    // NOT YET. Sitting in Voice with nothing armed is the ordinary page, and a
    // lock held there is a flat battery for a learner who is reading.
    expect(lock.request).not.toHaveBeenCalled();

    await startConnecting(user);
    await settle();

    // `connecting` IS a session: the microphone is open and the mint has been
    // made on the learner's own key. See `realtimeSessionIsUnderWay`.
    await waitFor(() => expect(lock.request).toHaveBeenCalledWith('screen'));
    expect(lock.held()).toBe(1);
  });

  it('keeps exactly the one lock through `live`, and drops it on Stop', async () => {
    const user = userEvent.setup();
    installHandlers({ realtime: true });
    renderSession();
    await chooseLiveVoice(user);
    await startConnecting(user);
    await goLive();
    await settle();

    // ONE lock, not one per stage: `connecting` → `live` is the same session,
    // so the flag never goes false and nothing is re-requested.
    expect(lock.request).toHaveBeenCalledTimes(1);
    expect(lock.held()).toBe(1);

    await user.click(within(surface()).getByRole('button', { name: /^stop$/i }));
    await waitFor(() => expect(lock.held()).toBe(0));
    expect(lock.sentinels[0].release).toHaveBeenCalled();
  });

  it('releases it when the page unmounts mid-session', async () => {
    const user = userEvent.setup();
    installHandlers({ realtime: true });
    const view = renderSession();
    await chooseLiveVoice(user);
    await startConnecting(user);
    await goLive();
    await settle();
    expect(lock.held()).toBe(1);

    view.unmount();

    // A lock nobody holds a reference to survives until the tab closes. This
    // is the exit path a `request()`/`release()` API would eventually miss,
    // and the reason `useWakeLock` takes a flag instead.
    expect(lock.held()).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// 2. E13's loop — the transport that already had it, and must keep it
// -----------------------------------------------------------------------------

describe('E13’s request/response loop still holds the screen awake', () => {
  it('takes one lock when the loop arms, and drops it when it stops', async () => {
    const user = userEvent.setup();
    // `realtime` UNBOUND, so the ladder resolves Voice to E13's loop.
    installHandlers({ realtime: false });
    renderSession();

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^voice$/i })).not.toBeNull(),
    );
    await user.click(screen.getByRole('button', { name: /^voice$/i }));
    expect(lock.request).not.toHaveBeenCalled();

    await startHandsFree(user);
    await settle();

    // Moving the call out of `useConversationSession` must not cost the
    // transport that already had it — this is the regression that would be.
    await waitFor(() => expect(lock.held()).toBe(1));
    expect(lock.request).toHaveBeenCalledTimes(1);

    await user.click(within(surface()).getByRole('button', { name: /^stop$/i }));
    await waitFor(() => expect(lock.held()).toBe(0));
  });
});

// -----------------------------------------------------------------------------
// 3. Never two — the fallback journey, watched the whole way
// -----------------------------------------------------------------------------

describe('exactly one lock exists at any moment', () => {
  it('never reaches two across realtime → drop → fallback → E13’s loop', async () => {
    const user = userEvent.setup();
    // The first mint succeeds, every later one is `unavailable`: so the
    // session goes LIVE, drops, and its bounded re-mints all fail, which is
    // what lands the ladder on E13's loop mid-session.
    installHandlers({ realtime: true, mint: 'ok-then-unavailable' });
    renderSession();

    await chooseLiveVoice(user);
    await startConnecting(user);
    await goLive();
    await settle();
    expect(lock.held()).toBe(1);

    // The connection dies under the session.
    await act(async () => {
      const dc = peerConnections[0].channel!;
      dc.readyState = 'closed';
      dc.onclose?.();
      await Promise.resolve();
    });

    // A drop is not the end of a session — the hook re-mints, stays in
    // `connecting`, and the lock is legitimately still held. When the re-mints
    // are spent it falls back, and the LADDER moves to E13's loop.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /start hands-free/i })).not.toBeNull(),
    );
    await settle();

    // Nothing is running now, so nothing is held: this is the moment a second
    // owner would have left an orphan sentinel behind.
    await waitFor(() => expect(lock.held()).toBe(0));

    // And on to the other transport, with a lock of its own.
    await startHandsFree(user);
    await settle();
    await waitFor(() => expect(lock.held()).toBe(1));

    // THE CLAIM. Measured continuously — at every request and every release —
    // rather than sampled here, because an overlap that opened and closed
    // between two awaits is exactly the bug and would be invisible to a
    // sampled count.
    expect(lock.peakHeld).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// 4. The warning, told to the learner who needs it
// -----------------------------------------------------------------------------

describe('the browser that cannot keep the screen awake says so', () => {
  it('renders the footnote on the REALTIME path when the API is absent', async () => {
    const user = userEvent.setup();
    // Firefox, or pre-16.4 iOS. The API is simply not there.
    removeWakeLock();
    installHandlers({ realtime: true });
    renderSession();
    await chooseLiveVoice(user);
    await startConnecting(user);
    await goLive();

    // THE #388 REGRESSION. This footnote used to be gated on
    // `!surfaceIsRealtime`, so the one transport where the screen genuinely
    // would not stay awake was the one transport that never mentioned it.
    expect(within(surface()).getByText(UNSUPPORTED_COPY)).toBeInTheDocument();
  });

  it('renders it on E13’s loop too, unchanged', async () => {
    const user = userEvent.setup();
    removeWakeLock();
    installHandlers({ realtime: false });
    renderSession();

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^voice$/i })).not.toBeNull(),
    );
    await user.click(screen.getByRole('button', { name: /^voice$/i }));
    await startHandsFree(user);

    expect(within(surface()).getByText(UNSUPPORTED_COPY)).toBeInTheDocument();
  });

  it('says nothing when a lock is actually held', async () => {
    const user = userEvent.setup();
    installHandlers({ realtime: true });
    renderSession();
    await chooseLiveVoice(user);
    await startConnecting(user);
    await goLive();
    await settle();

    expect(lock.held()).toBe(1);
    expect(within(surface()).queryByText(UNSUPPORTED_COPY)).toBeNull();
  });

  it('promises only what the platform can keep', async () => {
    const user = userEvent.setup();
    removeWakeLock();
    installHandlers({ realtime: true });
    renderSession();
    await chooseLiveVoice(user);
    await startConnecting(user);
    await goLive();

    const footnote = within(surface()).getByText(UNSUPPORTED_COPY);

    // The Screen Wake Lock API holds only while the document is VISIBLE — it
    // is dropped when the tab is hidden or the phone is locked. So the copy
    // asks for the one thing that helps (keep the page open) and must never
    // imply practice continues in a pocket, the way a phone call does.
    expect(footnote).toHaveTextContent(
      'This browser can’t keep the screen awake, so keep the page open while you practise.',
    );
    for (const overPromise of [
      /background/i,
      /locked/i,
      /pocket/i,
      /keeps? (?:running|going)/i,
      /like a (?:phone )?call/i,
    ]) {
      expect(footnote.textContent ?? '').not.toMatch(overPromise);
    }
  });
});

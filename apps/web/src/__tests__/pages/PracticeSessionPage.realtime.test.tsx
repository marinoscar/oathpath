/**
 * The degradation ladder, the live voice panel, and the one microphone
 * (issue #355, epic #345 / E15).
 *
 * =============================================================================
 * WHAT THIS FILE ASSERTS THAT ITS SIBLINGS CANNOT
 * =============================================================================
 *
 * `PracticeSessionPage.conversation.test.tsx` and `.voice.test.tsx` both pin
 * `realtime` UNBOUND, deliberately, so that they keep exercising the transport
 * they were written for. Nothing anywhere else renders this page with a
 * `realtime` model bound, and therefore nothing else can check the claims that
 * only exist once two spoken transports are reachable from one two-valued
 * picker:
 *
 *  1. **THE LADDER, AT ITS ONE DECISION SITE.** `resolveVoiceTransport` is
 *     exported and checked directly — six rungs, as a table — and then the page
 *     is rendered across the three deployment shapes to prove the rendered
 *     screen agrees with it.
 *  2. **THE PICKER STAYS TWO-VALUED.** `Text | Voice`, never a third button:
 *     which spoken mechanism Voice resolves to is the ladder's answer, not a
 *     choice a learner has to understand.
 *  3. **`realtime` UNBOUND RENDERS NOTHING**, not a disabled control —
 *     `voice.md` §1's hidden-not-disabled posture, reused for a third role.
 *  4. **EXACTLY ONE LIVE `getUserMedia` STREAM**, across a mode switch in
 *     either direction and across a mid-session fallback. Two hooks each
 *     opening their own device is the failure this is written against: a
 *     recorder running on one while the other transmits, and on mobile Safari a
 *     second `getUserMedia` that steals the device or fails outright.
 *  5. **A MID-SESSION FALLBACK IS SPOKEN**, not merely rendered, and the
 *     question is still on screen afterwards — progress is never lost, because
 *     none of it was ever held in the browser.
 *  6. **THE BILLING SENTENCE APPEARS ONCE**, on the control that starts the
 *     mode, and names no price.
 *
 * There is no real audio here and this suite does not pretend otherwise:
 * `docs/specs/realtime-practice.md` §12 says real speech and real barge-in are
 * verified by a person against a real deployment.
 */

import { CssBaseline, ThemeProvider } from '@mui/material';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../mocks/server';
import { mockUser } from '../utils/test-utils';
import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { AuthContext } from '../../contexts/AuthContext';
import PracticeSessionPage, {
  resolveVoiceTransport,
} from '../../pages/PracticeSessionPage';
import { MAX_RECONNECTS } from '../../hooks/useRealtimePractice';
import { VOICE_SURFACE_TITLE } from '../../components/voice/VoiceSurface';
import { lightTheme } from '../../theme';
import type {
  AiStatus,
  PracticeQuestion,
  PracticeSession,
  PracticeSessionDetail,
} from '../../types';

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

/**
 * The engine's constant instruction on every honoured result (#403).
 *
 * Present in these fixtures because a result without it is not a result the
 * API produces, and a screen test built on an unrealistic shape is a screen
 * test that keeps passing while the real thing changes.
 */
const SPEAK_VERBATIM =
  'Speak every line in say, in order, word for word, and then stop. Say nothing ' +
  'else: do not add, drop, reorder, summarise or explain a line, do not announce ' +
  'that you are calling a tool or waiting for one, and never mention the ' +
  'application, the session or its grading.';

const DETAIL: PracticeSessionDetail = {
  session: SESSION_BASE,
  nextQuestion: QUESTION_1,
  progress: { answered: 0, planned: 5 },
  attempts: [],
};

// -----------------------------------------------------------------------------
// The media environment
// -----------------------------------------------------------------------------

class FakeTrack {
  kind = 'audio';
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  addEventListener = vi.fn();
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
}

class FakeStream {
  tracks: FakeTrack[] = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

/** Every stream `getUserMedia` has ever handed out, in order. */
let handedOut: FakeStream[];
let getUserMedia: ReturnType<typeof vi.fn>;

/** How many of those streams still have a live track RIGHT NOW. */
function liveStreamCount(): number {
  return handedOut.filter((stream) =>
    stream.tracks.some((track) => track.readyState === 'live'),
  ).length;
}

/** Everything the browser's own voice was asked to say. */
let spokenAloud: string[];

function installSpeechSynthesis() {
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      cancel: vi.fn(),
      speak: vi.fn((utterance: { text: string; onend?: () => void }) => {
        spokenAloud.push(utterance.text);
        utterance.onend?.();
      }),
      getVoices: () => [],
    },
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

function installMediaEnvironment() {
  handedOut = [];
  getUserMedia = vi.fn(async () => {
    const stream = new FakeStream();
    handedOut.push(stream);
    return stream as unknown as MediaStream;
  });

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => [
        { kind: 'audioinput', deviceId: '', label: '' },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: {
      query: vi.fn(async () => ({
        state: 'granted' as PermissionState,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    },
  });
  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = class {};
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: true,
  });
}

// -----------------------------------------------------------------------------
// The realtime transport's fakes
// -----------------------------------------------------------------------------

let channelSends: Record<string, unknown>[];
let peerConnections: FakePeerConnection[];

class FakeDataChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn((payload: string) => {
    channelSends.push(JSON.parse(payload) as Record<string, unknown>);
  });
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

function channel(): FakeDataChannel {
  const pc = peerConnections[peerConnections.length - 1];
  expect(pc?.channel, 'no data channel was created').toBeTruthy();
  return pc!.channel!;
}

// -----------------------------------------------------------------------------
// The wire
// -----------------------------------------------------------------------------

let toolCalls: Record<string, unknown>[];

interface Deployment {
  realtimeBound: boolean;
  transcribeBound: boolean;
}

function installHandlers(deployment: Deployment) {
  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    unboundRoles: [
      'speak',
      ...(deployment.realtimeBound ? [] : ['realtime']),
      ...(deployment.transcribeBound ? [] : ['transcribe']),
    ],
  };

  server.use(
    http.get(`${API_BASE}/user-settings`, () =>
      HttpResponse.json({
        data: {
          theme: 'system',
          profile: { useProviderImage: true, customImageUrl: null },
          updatedAt: '2026-09-01T00:00:00.000Z',
          version: 1,
        },
      }),
    ),
    http.patch(`${API_BASE}/user-settings`, () =>
      HttpResponse.json({
        data: {
          theme: 'system',
          profile: { useProviderImage: true, customImageUrl: null },
          updatedAt: '2026-09-01T00:00:00.000Z',
          version: 2,
        },
      }),
    ),
    http.get(`${API_BASE}/ai/status`, () => HttpResponse.json({ data: status })),
    http.get(`${API_BASE}/practice/sessions/${SESSION_ID}`, () =>
      HttpResponse.json({ data: DETAIL }),
    ),
    http.post(`${API_BASE}/practice/sessions/${SESSION_ID}/realtime-session`, () =>
      HttpResponse.json({
        data: {
          status: 'ok',
          clientSecret: 'ek_ephemeral_secret_for_one_session',
          expiresAt: '2026-09-01T12:01:00.000Z',
          modelId: 'gpt-4o-realtime-preview',
        },
      }),
    ),
    http.post(
      `${API_BASE}/practice/sessions/${SESSION_ID}/realtime/tool-calls`,
      async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        toolCalls.push(body);
        if (body.tool === 'repeat_question') {
          return HttpResponse.json({
            data: {
              status: 'rejected',
              tool: 'repeat_question',
              reason: 'no_answer_outstanding',
              error: 'Nothing is waiting to be answered.',
              instruction: 'Call next_question and say what it returns.',
            },
          });
        }
        return HttpResponse.json({
          data: {
            status: 'ok',
            tool: 'next_question',
            say: [QUESTION_1.prompt],
            then: 'await_answer',
            questionId: QUESTION_1.id,
            instruction: SPEAK_VERBATIM,
            // THE COACH'S OWN QUESTION, carried out to the screen (#402). The
            // page renders this rather than re-drawing one from the session.
            question: QUESTION_1,
          },
        });
      },
    ),
    // The provider's own handshake. It goes browser ↔ provider directly, so it
    // is stubbed here rather than being an API route.
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

function voiceOption() {
  return screen.queryByRole('button', { name: /^voice$/i });
}

async function chooseVoice(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
  await waitFor(() => expect(voiceOption()).not.toBeNull());
  await user.click(voiceOption() as HTMLElement);
}

/** Press Start, and let the microphone, the mint and the handshake settle. */
async function startLiveVoice(
  user: ReturnType<typeof userEvent.setup>,
  expectedConnections = 1,
) {
  await user.click(await screen.findByRole('button', { name: /start live voice/i }));
  await waitFor(() => expect(peerConnections.length).toBe(expectedConnections));
  await act(async () => {
    const dc = channel();
    dc.readyState = 'open';
    dc.onopen?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  toolCalls = [];
  channelSends = [];
  peerConnections = [];
  spokenAloud = [];
  installSpeechSynthesis();
  installMediaEnvironment();
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
    FakePeerConnection;
});

afterEach(() => {
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
// 1. The ladder itself
// -----------------------------------------------------------------------------

describe('resolveVoiceTransport — the ladder, at its one decision site', () => {
  it('takes the live transport when `realtime` is bound', () => {
    expect(
      resolveVoiceTransport({
        realtimeBound: true,
        transcribeBound: true,
        realtimeFallback: null,
      }),
    ).toBe('realtime');
  });

  it('falls to the request/response loop when only `transcribe` is bound', () => {
    expect(
      resolveVoiceTransport({
        realtimeBound: false,
        transcribeBound: true,
        realtimeFallback: null,
      }),
    ).toBe('request_response');
  });

  it('offers no spoken transport at all when neither is bound', () => {
    expect(
      resolveVoiceTransport({
        realtimeBound: false,
        transcribeBound: false,
        realtimeFallback: null,
      }),
    ).toBeNull();
  });

  it('falls to the request/response loop when the mint was unavailable or failed', () => {
    for (const code of ['ai_unavailable', 'mint_failed'] as const) {
      expect(
        resolveVoiceTransport({
          realtimeBound: true,
          transcribeBound: true,
          realtimeFallback: code,
        }),
      ).toBe('request_response');
    }
  });

  it('falls to the request/response loop when a live connection was lost', () => {
    for (const code of ['connection_failed', 'connection_lost'] as const) {
      expect(
        resolveVoiceTransport({
          realtimeBound: true,
          transcribeBound: true,
          realtimeFallback: code,
        }),
      ).toBe('request_response');
    }
  });

  it('falls all the way to text when the MICROPHONE was refused', () => {
    // The rung that looks wrong and is not: the request/response loop needs the
    // identical device, so offering it would be offering a second control that
    // cannot work to somebody who has just been told the first one could not
    // open.
    expect(
      resolveVoiceTransport({
        realtimeBound: true,
        transcribeBound: true,
        realtimeFallback: 'microphone',
      }),
    ).toBeNull();
  });

  it('falls to text, not to a dead loop, when nothing else is bound either', () => {
    expect(
      resolveVoiceTransport({
        realtimeBound: true,
        transcribeBound: false,
        realtimeFallback: 'mint_failed',
      }),
    ).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// 2 + 3 + 6. What the screen shows for each deployment
// -----------------------------------------------------------------------------

describe('the picker stays two-valued, and Voice resolves to one transport', () => {
  it('offers the LIVE transport when `realtime` is bound — and only two buttons', async () => {
    const user = userEvent.setup();
    installHandlers({ realtimeBound: true, transcribeBound: true });
    renderSession();
    await chooseVoice(user);

    const group = screen.getByRole('group', { name: 'How you want to answer' });
    // TWO VALUES, never three: which spoken mechanism Voice resolves to is the
    // ladder's answer, not a control a learner operates.
    expect(within(group).getAllByRole('button')).toHaveLength(2);

    expect(
      await screen.findByRole('button', { name: /start live voice/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start hands-free/i })).toBeNull();
  });

  it('offers E13’s loop, unchanged, when only `transcribe` is bound', async () => {
    const user = userEvent.setup();
    installHandlers({ realtimeBound: false, transcribeBound: true });
    renderSession();
    await chooseVoice(user);

    expect(
      await screen.findByRole('button', { name: /start hands-free/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start live voice/i })).toBeNull();
  });

  it('renders NOTHING — not a disabled control — when neither role is bound', async () => {
    installHandlers({ realtimeBound: false, transcribeBound: false });
    renderSession();

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await waitFor(() =>
      expect(screen.queryByText(/answering out loud is not available yet/i)).not.toBeNull(),
    );

    expect(voiceOption()).toBeNull();
    expect(screen.queryByRole('group', { name: 'How you want to answer' })).toBeNull();
    expect(screen.queryByRole('button', { name: /start live voice/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /start hands-free/i })).toBeNull();

    // TYPING ALWAYS WORKS, in every cell of every ladder.
    expect(screen.getByLabelText(/your answer/i)).toBeEnabled();
  });

  it('says once that it runs on the learner’s own key and bills by the minute, with no price', async () => {
    const user = userEvent.setup();
    installHandlers({ realtimeBound: true, transcribeBound: true });
    const view = renderSession();
    await chooseVoice(user);
    await screen.findByRole('button', { name: /start live voice/i });

    const text = view.container.textContent ?? '';
    const billing = text.match(/billed by the minute/g) ?? [];
    expect(billing).toHaveLength(1);
    expect(text).toMatch(/your own AI key/i);

    // NO INVENTED PRICE. This application does not know what any provider
    // charges any learner, and a number here would be a confident guess about
    // somebody else's bill.
    expect(text).not.toMatch(/\$\s?\d/);
    expect(text).not.toMatch(/\d+\s*(cents?|USD)/i);

    // And the honest sentence about echo, with the headphone recommendation.
    expect(text).toMatch(/headphones/i);
    expect(text).toMatch(/echo/i);
  });
});

// -----------------------------------------------------------------------------
// 4. Exactly one live stream
// -----------------------------------------------------------------------------

describe('exactly one live `getUserMedia` stream, per page', () => {
  it('opens one for the live session, and never a second across a mode switch', async () => {
    const user = userEvent.setup();
    installHandlers({ realtimeBound: true, transcribeBound: true });
    renderSession();
    await chooseVoice(user);
    await startLiveVoice(user);

    // ONE CALL, one live stream.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(liveStreamCount()).toBe(1);

    // Back to typing: the connection ends and the microphone goes out with it.
    //
    // FROM THE VOICE SURFACE, not from the `Text` button (#381). A live session
    // is now a different screen — the picker is not on it, by design — and
    // "Type instead" is the control that leaves it. It runs the identical
    // `handleTypeInstead`, so this is the same mode switch it always was.
    await user.click(screen.getByRole('button', { name: /type instead/i }));
    await waitFor(() => expect(liveStreamCount()).toBe(0));
    expect(peerConnections[0].closed).toBe(true);

    // And back to Voice again — still never two at once.
    await user.click(await screen.findByRole('button', { name: /^voice$/i }));
    await startLiveVoice(user, 2);
    expect(liveStreamCount()).toBe(1);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('asks for `echoCancellation` on the stream this transport uses', async () => {
    const user = userEvent.setup();
    installHandlers({ realtimeBound: true, transcribeBound: true });
    renderSession();
    await chooseVoice(user);
    await startLiveVoice(user);

    // §11: the structural anti-echo guarantee is given up by design on a
    // full-duplex transport, and this constraint is what replaces it.
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({ echoCancellation: true }),
    });
  });

  it('never disables, mutes or replaces the track while the session is live', async () => {
    const user = userEvent.setup();
    installHandlers({ realtimeBound: true, transcribeBound: true });
    renderSession();
    await chooseVoice(user);
    await startLiveVoice(user);

    const track = handedOut[0].tracks[0];
    expect(peerConnections[0].addedTracks).toEqual([track]);
    expect(track.enabled).toBe(true);
    expect(track.readyState).toBe('live');
    expect(track.stop).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// 5. The mid-session fallback
// -----------------------------------------------------------------------------

describe('a mid-session fallback is spoken, and loses nothing', () => {
  it('re-mints to the bound, then says one sentence out loud and hands over to E13’s loop', async () => {
    const user = userEvent.setup();
    installHandlers({ realtimeBound: true, transcribeBound: true });
    renderSession();
    await chooseVoice(user);
    await startLiveVoice(user);

    // The conversation had actually started — the opening turn reached the
    // engine and came back.
    await waitFor(() => expect(toolCalls.length).toBeGreaterThanOrEqual(2));
    const spokenBefore = spokenAloud.length;

    // Drop it, again and again, past the bound.
    for (let attempt = 0; attempt <= MAX_RECONNECTS; attempt += 1) {
      const dc = channel();
      await act(async () => {
        dc.onclose?.();
        await Promise.resolve();
      });
      if (attempt < MAX_RECONNECTS) {
        await waitFor(() => expect(peerConnections.length).toBe(attempt + 2));
        await act(async () => {
          const next = channel();
          next.readyState = 'open';
          next.onopen?.();
          await Promise.resolve();
          await Promise.resolve();
        });
      }
    }

    // SPOKEN. A walking learner is not reading the screen, and the loop is
    // about to change character.
    await waitFor(() => expect(spokenAloud.length).toBeGreaterThan(spokenBefore));
    const said = spokenAloud[spokenAloud.length - 1];
    expect(said).toMatch(/voice connection stopped/i);

    // AND RENDERED, verbatim — one fact, two renderings.
    expect(await screen.findByText(said)).toBeInTheDocument();

    // The ladder moved a rung: E13's loop is what Voice means now.
    expect(
      await screen.findByRole('button', { name: /start hands-free/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start live voice/i })).toBeNull();

    // NOTHING WAS LOST. The question is still on screen and typing still works
    // — every attempt was a committed row, and the question, the count and the
    // progress bar are all re-read from the server.
    expect(
      screen.getByRole('heading', { level: 2, name: QUESTION_1.prompt }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/your answer/i)).toBeEnabled();

    // And the microphone did not leak across the handover: whatever streams
    // were opened, none of them is still live.
    expect(liveStreamCount()).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// 6b. The screen asks the question the coach asked — issue #402
// -----------------------------------------------------------------------------

describe('the question on screen is the question the coach was given (#402)', () => {
  it('renders the engine\u2019s served question, not the session\u2019s own fresh draw', async () => {
    // MEASURED DEFECT: over a 71-second recording the screen showed Q79, Q80,
    // Q83 and Q88 while the coach asked four entirely different questions, and
    // the first question the coach asked never appeared on screen at all.
    //
    // THE CAUSE IS NOT A RACE, IT IS TWO DRAWS. `GET /api/practice/sessions/:id`
    // resolves `nextQuestion` through `mastery/selector.ts`, which shuffles with
    // real, unseeded randomness on every read — so the page's draw and the
    // engine's draw are two different questions almost every time, with nothing
    // wrong anywhere. This fixture makes that structural fact explicit: the
    // session endpoint answers with one question and the tool-call route serves
    // another, exactly as the live selector does.
    const user = userEvent.setup();
    installHandlers({ realtimeBound: true, transcribeBound: true });

    const SPOKEN = {
      id: 'question-spoken',
      number: 79,
      prompt: 'What group of people was taken and sold as slaves?',
      categoryId: 'category-1',
      dynamicScope: 'none' as const,
    };

    server.use(
      http.post(
        `${API_BASE}/practice/sessions/${SESSION_ID}/realtime/tool-calls`,
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          toolCalls.push(body);
          if (body.tool === 'repeat_question') {
            return HttpResponse.json({
              data: {
                status: 'rejected',
                tool: 'repeat_question',
                reason: 'no_answer_outstanding',
                error: 'Nothing is waiting to be answered.',
                instruction: 'Call next_question and say what it returns.',
              },
            });
          }
          return HttpResponse.json({
            data: {
              status: 'ok',
              tool: 'next_question',
              say: [SPOKEN.prompt],
              then: 'await_answer',
              questionId: SPOKEN.id,
              instruction: SPEAK_VERBATIM,
              question: SPOKEN,
            },
          });
        },
      ),
    );

    renderSession();
    await chooseVoice(user);
    await startLiveVoice(user);
    await waitFor(() => expect(toolCalls.length).toBeGreaterThanOrEqual(2));

    // THE SPOKEN QUESTION IS ON SCREEN, with its own number.
    expect(await screen.findByText(SPOKEN.prompt)).toBeInTheDocument();
    expect(screen.getByText(/Question 79/)).toBeInTheDocument();

    // AND THE PAGE'S OWN DRAW IS NOWHERE. This is the half that matters: the
    // learner must not be able to read a question nobody is asking them.
    expect(screen.queryByText(QUESTION_1.prompt)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// 7. What the picture says the COACH is doing — issue #386
// -----------------------------------------------------------------------------

/** Deliver one provider event over the live data channel. */
async function emitProviderEvent(event: Record<string, unknown>) {
  await act(async () => {
    channel().onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('the surface says whether the COACH is speaking', () => {
  it('shows Speaking while the coach talks and Listening when it stops', async () => {
    // MEASURED DEFECT: 38 of 38 sampled frames of a 77-second session read
    // "Listening", including the seconds the coach was reading the question
    // aloud. `useRealtimePractice` has published `isCoachSpeaking` since #355
    // and this screen ignored it.
    const user = userEvent.setup();
    installHandlers({ realtimeBound: true, transcribeBound: true });
    renderSession();
    await chooseVoice(user);
    await startLiveVoice(user);

    // Nothing said yet: it is the learner's turn.
    expect(await screen.findByText('Listening')).toBeInTheDocument();

    // The coach's own words start arriving.
    await emitProviderEvent({
      type: 'response.output_audio_transcript.delta',
      item_id: 'item-1',
      delta: 'What is the supreme law ',
    });
    expect(await screen.findByText('Speaking')).toBeInTheDocument();
    expect(screen.queryByText('Listening')).toBeNull();

    // BARGE-IN IS UNCHANGED AND UNCONDITIONAL. The picture describes the
    // coach, never a gate on the microphone — the sentence beside it still
    // invites the learner to talk whenever they are ready, and the controls
    // are where they were.
    expect(
      screen.getByText(/talk to the coach whenever you are ready/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeEnabled();

    // And when the utterance finishes, it is the learner's turn again.
    await emitProviderEvent({
      type: 'response.output_audio_transcript.done',
      item_id: 'item-1',
      transcript: 'What is the supreme law of the land?',
    });
    expect(await screen.findByText('Listening')).toBeInTheDocument();
    expect(screen.queryByText('Speaking')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// 8. One continuous clock, across a question change — issue #387
// -----------------------------------------------------------------------------

describe('the elapsed clock measures the session, not the last question', () => {
  it('does not restart when the conversation moves to another question', async () => {
    // MEASURED DEFECT: 0:09 at 12s, 0:04 at 29s (Q3), 0:11 at 68s (Q5). The
    // page re-reads `GET /api/practice/sessions/:id` on every change of
    // `realtime.questionId`, and `isLoading` used to replace the whole page
    // with a spinner — unmounting the surface and remounting it, which reset a
    // clock that started at mount. It is a COST figure (epic #345, decision
    // 7): a reset systematically under-reports what a session is spending on
    // the learner's own key.
    const user = userEvent.setup();
    installHandlers({ realtimeBound: true, transcribeBound: true });

    // The engine hands out a DIFFERENT question id on the next call, which is
    // the only signal this page treats as "the conversation moved".
    let asked = 0;
    server.use(
      http.post(
        `${API_BASE}/practice/sessions/${SESSION_ID}/realtime/tool-calls`,
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          toolCalls.push(body);
          if (body.tool === 'repeat_question') {
            return HttpResponse.json({
              data: {
                status: 'rejected',
                tool: 'repeat_question',
                reason: 'no_answer_outstanding',
                error: 'Nothing is waiting to be answered.',
                instruction: 'Call next_question and say what it returns.',
              },
            });
          }
          asked += 1;
          return HttpResponse.json({
            data: {
              status: 'ok',
              tool: 'next_question',
              say: [QUESTION_1.prompt],
              then: 'await_answer',
              questionId: `question-${asked}`,
            },
          });
        },
      ),
    );

    renderSession();
    await chooseVoice(user);
    await startLiveVoice(user);
    await waitFor(() => expect(toolCalls.length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText('Elapsed 0:00')).toBeInTheDocument();

    // The exact node, so "was it remounted" is a fact rather than an
    // inference: React replaces this element if the surface is unmounted and
    // mounted again.
    const surfaceBefore = screen.getByRole('region', { name: VOICE_SURFACE_TITLE });

    // Sixty-five seconds of conversation, without waiting for them. `Date.now`
    // is moved forward rather than replaced, so it stays monotonic for
    // everything else in the render.
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 65_000);

    try {
      // The conversation moves on: a second question, a second re-read.
      await emitProviderEvent({
        type: 'response.function_call_arguments.done',
        call_id: 'call-next',
        name: 'next_question',
        arguments: '{}',
      });
      await waitFor(() => expect(toolCalls.length).toBeGreaterThanOrEqual(3));

      // THE SURFACE IS STILL THE ONE THAT WAS THERE, and the clock with it. A
      // remount would read 0:00 again, which is exactly what a learner saw.
      expect(
        await screen.findByRole('region', { name: VOICE_SURFACE_TITLE }),
      ).toBe(surfaceBefore);
      await waitFor(() =>
        expect(screen.getByText(/^Elapsed /)).toHaveTextContent('Elapsed 1:05'),
      );
      expect(screen.queryByText('Elapsed 0:00')).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});

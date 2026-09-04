/**
 * The spoken mock interview screen (`/practice/interviews/:id/voice`),
 * issue #159, epic #60 / E11.
 *
 * Driven through a stubbed `fetch`, a fake `RTCPeerConnection` and a fake
 * `getUserMedia`. There is no real audio here and this suite does not pretend
 * otherwise — `docs/specs/realtime-interview.md` §10/§13 say plainly that real
 * speech recognition and real barge-in are verified by a person against a real
 * deployment (§11's numbered checklist), because a test convincing enough to
 * stand in for them would be verifying the fake.
 *
 * What IS mechanically checkable is everything below, and every item is a
 * property whose failure would be invisible on a screen that otherwise looked
 * fine:
 *
 *  1. **THE LOAD-BEARING ONE: the learner's API key appears nowhere** — not in
 *     this screen's source, not in a request, not in browser storage. §12's
 *     second locked decision, checked against the files themselves rather than
 *     only against behaviour, because the way this regresses is somebody
 *     reaching for a key "just to make the connection work".
 *  2. **No push-to-talk gate exists**, and the session is configured for
 *     barge-in in both directions.
 *  3. **The end control is always visible and keyboard-reachable**, is never
 *     disabled while connected, and ends the session AND stops the media
 *     tracks.
 *  4. **The browser is a relay**: tool calls are posted unexamined and results
 *     — including refusals — go back verbatim.
 *  5. **The writing sentence never reaches the DOM**, by either of the two
 *     routes it could.
 *  6. **Losing the connection falls back to text with progress intact.**
 *  7. **The live transcript is announced**, politely.
 *  8. **Legible at 360px, in both themes.**
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';

import { setViewportWidth } from '../setup';
import { mockUser } from '../utils/test-utils';
import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { AuthContext } from '../../contexts/AuthContext';
import RealtimeInterviewPage from '../../pages/RealtimeInterviewPage';
import type {
  AiStatus,
  Interview,
  InterviewDetail,
  InterviewTurnRecord,
} from '../../types';

const INTERVIEW_ID = 'interview-1';
const PHONE = 360;

/** The one credential the browser is ever allowed to hold. */
const EPHEMERAL_SECRET = 'ek_ephemeral_secret_for_one_session';
const REALTIME_MODEL = 'gpt-4o-realtime-preview';

/**
 * A long-lived key, as a sentinel.
 *
 * NEVER RETURNED BY ANY STUB BELOW — it exists so the assertions can say "and
 * nothing shaped like this ever appeared", which is a different and stronger
 * claim than "the secret appeared".
 */
const LEARNER_API_KEY = 'sk-a-long-lived-key-that-must-never-be-here';

const READY: AiStatus = {
  userKeyConfigured: true,
  systemReady: true,
  enabled: true,
  providerConfigured: true,
  unboundRoles: [],
};

const INTERVIEW: Interview = {
  id: INTERVIEW_ID,
  mode: 'text',
  status: 'in_progress',
  testVersionCode: 'v2008',
  seniorExemption: false,
  transcriptRetained: false,
  startedAt: '2026-03-01T12:00:00.000Z',
  completedAt: null,
  civicsAsked: 0,
  civicsCorrect: 0,
  passedCivics: false,
};

const OPENING_TURN: InterviewTurnRecord = {
  id: 'turn-1',
  turnIndex: 0,
  role: 'officer',
  phase: 'smalltalk',
  questionId: null,
  text: 'Good morning. How are you doing today?',
  createdAt: '2026-03-01T12:00:00.000Z',
};

/** The dictated sentence. IT MUST NEVER APPEAR ON SCREEN. */
const WRITING_SENTENCE = 'The people vote for the President in November.';

// -----------------------------------------------------------------------------
// The fakes
// -----------------------------------------------------------------------------

class FakeTrack {
  kind = 'audio';
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
}

class FakeStream {
  tracks: FakeTrack[];
  constructor(count = 1) {
    this.tracks = Array.from({ length: count }, () => new FakeTrack());
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

/** Everything the connection sent down the data channel, as parsed objects. */
let channelSends: Record<string, unknown>[];

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

let peerConnections: FakePeerConnection[];

class FakePeerConnection {
  connectionState = 'new';
  channel: FakeDataChannel | null = null;
  addedTracks: FakeTrack[] = [];
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  closed = false;

  constructor() {
    peerConnections.push(this);
  }

  createDataChannel(_name: string) {
    this.channel = new FakeDataChannel();
    return this.channel;
  }
  addTrack(track: FakeTrack) {
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

// -----------------------------------------------------------------------------
// The wire
// -----------------------------------------------------------------------------

/** Every request the app made, so the key assertions can read all of them. */
let requests: { url: string; init?: RequestInit }[];
/** Every tool call posted to the relay route, in order. */
let toolCalls: Record<string, unknown>[];
/** What the relay route answers next, shifted off in order. */
let toolResults: unknown[];
let mintResponses: unknown[];
let detail: InterviewDetail;
let completeCalls: number;
let aiStatus: AiStatus;
let realFetch: typeof globalThis.fetch;
let getUserMedia: ReturnType<typeof vi.fn>;
let micStream: FakeStream;

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch() {
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requests.push({ url, init });

      if (url.startsWith('https://api.openai.com')) {
        return new Response('v=0\r\nfake-answer', {
          status: 200,
          headers: { 'Content-Type': 'application/sdp' },
        });
      }
      if (url.includes('/ai/status')) return json(aiStatus);
      if (url.includes('/realtime-session')) {
        const next = mintResponses.shift() ?? {
          status: 'ok',
          clientSecret: EPHEMERAL_SECRET,
          expiresAt: '2026-03-01T12:01:00.000Z',
          modelId: REALTIME_MODEL,
        };
        return json(next);
      }
      if (url.includes('/realtime/tool-calls')) {
        toolCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json(toolResults.shift() ?? nextQuestionResult());
      }
      if (url.includes('/complete')) {
        completeCalls += 1;
        return json({ civics: { planned: 10, asked: 1, correct: 1 } });
      }
      return json(detail);
    },
  ) as typeof globalThis.fetch;
}

// -----------------------------------------------------------------------------
// Result builders
// -----------------------------------------------------------------------------

function nextQuestionResult(overrides: Record<string, unknown> = {}) {
  return {
    tool: 'next_question',
    status: 'ok',
    text: 'Thank you. What is the supreme law of the land?',
    speakOnly: false,
    itemId: 'question-9',
    phase: 'civics',
    turnIndex: 2,
    progress: { civicsAsked: 0, civicsPlanned: 10 },
    awaitingCompletion: false,
    ...overrides,
  };
}

function rejection() {
  return {
    tool: 'end_phase',
    status: 'rejected',
    reason: 'phase_not_over',
    error: 'civics phase is not over',
    instruction: 'call next_question and continue the interview',
  };
}

// -----------------------------------------------------------------------------
// Rendering and driving
// -----------------------------------------------------------------------------

/** Reports the route the app is on, so a fallback navigation is observable. */
function TextInterviewStub() {
  const location = useLocation();
  const state = location.state as { voiceFallback?: string } | null;
  return (
    <div>
      <p>the text interview</p>
      {state?.voiceFallback && <p>{state.voiceFallback}</p>}
    </div>
  );
}

function renderVoice({ mode = 'light' as 'light' | 'dark' } = {}) {
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
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <CssBaseline />
      <AuthContext.Provider value={auth as never}>
        <MemoryRouter
          initialEntries={[`/practice/interviews/${INTERVIEW_ID}/voice`]}
        >
          <AiStatusProvider>
            <Routes>
              <Route
                path="/practice/interviews/:id/voice"
                element={<RealtimeInterviewPage />}
              />
              <Route
                path="/practice/interviews/:id"
                element={<TextInterviewStub />}
              />
              <Route
                path="/practice/interviews/:id/debrief"
                element={<div>the debrief</div>}
              />
              <Route path="/practice" element={<div>Practice destination</div>} />
            </Routes>
          </AiStatusProvider>
        </MemoryRouter>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

/** The data channel of the most recent peer connection. */
function channel(): FakeDataChannel {
  const pc = peerConnections[peerConnections.length - 1];
  expect(pc?.channel, 'no data channel was created').toBeTruthy();
  return pc!.channel!;
}

/** Press Start, and let the microphone, the mint and the handshake settle. */
async function startSession(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole('button', { name: /start the spoken interview/i }),
  );
  await waitFor(() => expect(peerConnections.length).toBeGreaterThan(0));
  await act(async () => {
    const dc = channel();
    dc.readyState = 'open';
    dc.onopen?.();
    await Promise.resolve();
  });
  await screen.findByRole('button', { name: /end this interview/i });
}

/** Deliver one provider event over the data channel. */
async function emit(event: Record<string, unknown>) {
  await act(async () => {
    channel().onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The model calls one tool. */
async function modelCalls(
  name: string,
  args: Record<string, unknown> = {},
  callId = `call-${name}`,
) {
  await emit({
    type: 'response.function_call_arguments.done',
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  });
  await waitFor(() => expect(toolCalls.length).toBeGreaterThan(0));
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  requests = [];
  toolCalls = [];
  toolResults = [];
  mintResponses = [];
  channelSends = [];
  peerConnections = [];
  completeCalls = 0;
  aiStatus = READY;
  micStream = new FakeStream();
  detail = {
    interview: INTERVIEW,
    turns: [OPENING_TURN],
    progress: { civicsAsked: 0, civicsPlanned: 10 },
    awaitingCompletion: false,
    debrief: null,
  };

  getUserMedia = vi.fn(async () => micStream as unknown as MediaStream);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: true,
  });
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
    FakePeerConnection;

  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(window, 'isSecureContext');
  Reflect.deleteProperty(globalThis, 'RTCPeerConnection');
  window.localStorage.clear();
  window.sessionStorage.clear();
  setViewportWidth(1440);
});

// =============================================================================
// 1. THE LOAD-BEARING ONE
// =============================================================================

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES = [
  'services/realtimeConnection.ts',
  'hooks/useRealtimeInterview.ts',
  'pages/RealtimeInterviewPage.tsx',
];

/** One source file, with its comments stripped. */
function code(relative: string): string {
  return readFileSync(resolve(here, '../..', relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the learner’s API key is nowhere near this screen', () => {
  it('is not named, read, or stored by any file that runs a spoken interview', () => {
    for (const file of SOURCES) {
      const source = code(file);

      // The names a long-lived key would travel under. `clientSecret` is
      // deliberately not on this list — an ephemeral, single-session secret is
      // exactly what this screen is supposed to hold.
      for (const forbidden of [
        'apiKey',
        'api_key',
        'getAiKey',
        'userKey',
        'sk-',
      ]) {
        expect(source, `${file} names ${forbidden}`).not.toContain(forbidden);
      }

      // A key cannot be read from a store that is never touched. This also
      // rules out the "cache the ephemeral secret so we can reconnect faster"
      // shortcut, which turns a 60-second credential into a persistent one.
      for (const store of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
        expect(source, `${file} touches ${store}`).not.toContain(store);
      }
    }
  });

  it('sends only the ephemeral secret to the provider, and nothing to our API', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);

    const providerCalls = requests.filter((request) =>
      request.url.startsWith('https://api.openai.com'),
    );
    expect(providerCalls).toHaveLength(1);

    const headers = providerCalls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${EPHEMERAL_SECRET}`);

    // The mint carries NO BODY of its own beyond the empty object every POST in
    // the client sends — there is nothing for a caller to configure, and a
    // field here would be the first one through which a client could ask for a
    // session that is not this interview's.
    const mint = requests.find((request) => request.url.includes('/realtime-session'));
    expect(mint).toBeDefined();
    expect(String(mint!.init?.body ?? '{}')).toBe('{}');

    // And nothing anywhere in the whole exchange looks like a long-lived key.
    const everything = JSON.stringify(requests) + JSON.stringify(channelSends);
    expect(everything).not.toContain(LEARNER_API_KEY);
    expect(everything).not.toContain('sk-');
  });

  it('writes nothing to browser storage, including the ephemeral secret', async () => {
    // Spies rather than a read of `length`: the assertion is that nothing was
    // ever WRITTEN, which is the property that matters — a credential put into
    // storage and cleared on the next render was still, briefly, a credential
    // on disk.
    const local = vi.spyOn(window.localStorage, 'setItem');
    const session = vi.spyOn(window.sessionStorage, 'setItem');

    const user = userEvent.setup();
    renderVoice();
    await startSession(user);

    expect(local).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 2. FULL DUPLEX
// =============================================================================

describe('there is no push-to-talk gate', () => {
  it('offers no control that has to be held, pressed or released to speak', async () => {
    const user = userEvent.setup();
    const { container } = renderVoice();
    await startSession(user);

    for (const label of [
      /hold to/i,
      /push to talk/i,
      /tap to speak/i,
      /press to answer/i,
      /start recording/i,
      /your turn/i,
      /mute/i,
    ]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }

    // Belt to that: not merely no BUTTON, but no such words anywhere. A
    // "hold to speak" affordance rendered as something other than a button
    // would be the same half-duplex design with a different tag name.
    expect(container.innerHTML).not.toMatch(/push to talk|hold to speak/i);
  });

  it('opens the microphone once and never disables the track while live', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const pc = peerConnections[0]!;
    expect(pc.addedTracks).toHaveLength(1);

    // The two ways a half-duplex design hides inside a full-duplex one.
    expect(micStream.tracks[0]!.enabled).toBe(true);
    expect(micStream.tracks[0]!.stop).not.toHaveBeenCalled();
  });

  it('configures barge-in in both directions, and changes nothing else about the session', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);

    const update = channelSends.find((sent) => sent.type === 'session.update');
    expect(update, 'the session was never configured for barge-in').toBeDefined();

    const session = update!.session as Record<string, unknown>;
    const audio = session.audio as Record<string, unknown>;
    const input = audio.input as Record<string, unknown>;
    const detection = input.turn_detection as Record<string, unknown>;

    // The learner may interrupt the officer.
    expect(detection.interrupt_response).toBe(true);
    // And the officer may take its turn when they stop, so a nervous pause is
    // not a dead conversation waiting on a button nobody was given.
    expect(detection.create_response).toBe(true);

    // THE ABSENCES. `session.update` can replace a session's instructions and
    // tools, both decided server-side and both the mechanism by which the model
    // has no field to invent a question or report a verdict in. A client that
    // sent either would hand that authority back, silently.
    expect(session).not.toHaveProperty('instructions');
    expect(session).not.toHaveProperty('tools');
    expect(JSON.stringify(update)).not.toContain('instructions');
    expect(JSON.stringify(update)).not.toContain('tools');
  });
});

// =============================================================================
// 3. THE END CONTROL
// =============================================================================

describe('the end control', () => {
  it('is visible and enabled from the moment the session is live', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);

    const control = screen.getByRole('button', { name: /end this interview/i });
    expect(control).toBeVisible();
    expect(control).toBeEnabled();
  });

  it('stays enabled while the officer is mid-utterance', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);

    await emit({
      type: 'response.output_audio_transcript.delta',
      item_id: 'officer-1',
      delta: 'Good morning, and ',
    });

    // The moment somebody most wants out of a rehearsal of a stressful
    // conversation is the moment it is going badly. A control that greys out
    // exactly then is a control that is not really there.
    expect(
      screen.getByRole('button', { name: /end this interview/i }),
    ).toBeEnabled();
  });

  it('is keyboard-reachable', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);

    const control = screen.getByRole('button', { name: /end this interview/i });
    control.focus();
    expect(control).toHaveFocus();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(completeCalls).toBe(1));
  });

  it('ends the session, stops every media track, and finishes the interview', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);

    await user.click(screen.getByRole('button', { name: /end this interview/i }));

    await screen.findByText('the debrief');
    expect(completeCalls).toBe(1);

    // BOTH, and the track is the one that matters: while it is live the
    // operating system shows a microphone light, and a learner who has just
    // said stop and can still see it has been told by their own machine that
    // this app is still listening.
    expect(peerConnections[0]!.closed).toBe(true);
    for (const track of micStream.tracks) {
      expect(track.stop).toHaveBeenCalled();
    }
  });

  it('stops the microphone when the learner navigates away mid-interview', async () => {
    const user = userEvent.setup();
    const { unmount } = renderVoice();
    await startSession(user);

    unmount();

    for (const track of micStream.tracks) {
      expect(track.stop).toHaveBeenCalled();
    }
  });
});

// =============================================================================
// 4. THE BROWSER IS A RELAY
// =============================================================================

describe('the relay', () => {
  it('posts the model’s tool call and hands the engine’s answer straight back', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);

    toolResults = [nextQuestionResult()];
    await modelCalls('next_question');

    expect(toolCalls[0]).toEqual({ tool: 'next_question' });

    const output = channelSends.find(
      (sent) => sent.type === 'conversation.item.create',
    );
    expect(output).toBeDefined();
    const item = output!.item as Record<string, unknown>;
    expect(item.call_id).toBe('call-next_question');
    // VERBATIM. The relay does not reshape, summarise or filter what the
    // engine decided.
    expect(JSON.parse(String(item.output))).toEqual(nextQuestionResult());
  });

  it('relays a REFUSAL as a result, with its instruction, not as an error', async () => {
    const user = userEvent.setup();
    const { container } = renderVoice();
    await startSession(user);

    toolResults = [rejection()];
    await modelCalls('end_phase', { phase: 'civics' });

    const output = channelSends.find(
      (sent) => sent.type === 'conversation.item.create',
    );
    const item = output!.item as Record<string, unknown>;
    const relayed = JSON.parse(String(item.output)) as Record<string, unknown>;

    // The `instruction` is the field that gets the interview moving again. A
    // relay that treated a refusal as a failure would leave the officer holding
    // a tool call that never resolves — a live conversation gone silent with
    // nothing on screen to say so.
    expect(relayed.status).toBe('rejected');
    expect(relayed.instruction).toBe(
      'call next_question and continue the interview',
    );

    // And the learner is told nothing about it: a refused tool call is a
    // contract event between the engine and the model.
    expect(container.innerHTML).not.toContain('phase_not_over');
    expect(container.innerHTML).not.toContain('civics phase is not over');
  });

  it('refuses a tool nobody declared without troubling the API', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);

    await emit({
      type: 'response.function_call_arguments.done',
      call_id: 'call-invented',
      name: 'grade_myself',
      arguments: '{}',
    });

    expect(toolCalls).toHaveLength(0);
    const output = channelSends.find(
      (sent) => sent.type === 'conversation.item.create',
    );
    const relayed = JSON.parse(
      String((output!.item as Record<string, unknown>).output),
    ) as Record<string, unknown>;
    expect(relayed.status).toBe('rejected');
  });

  it('shows no verdict of any kind while the interview is running', async () => {
    const user = userEvent.setup();
    const { container } = renderVoice();
    await startSession(user);

    toolResults = [
      {
        tool: 'grade_answer',
        status: 'ok',
        ack: 'Thank you.',
        recorded: true,
        phase: 'civics',
        turnIndex: 3,
        progress: { civicsAsked: 1, civicsPlanned: 10 },
        awaitingCompletion: false,
      },
    ];
    await modelCalls('grade_answer', {
      questionId: 'question-9',
      transcript: 'the constitution',
      confidence: 0.94,
    });

    // §10: the real interview gives no per-question signal, so a rehearsal that
    // did would be teaching the learner to expect reassurance the actual event
    // will never provide — and here it would arrive in a warm human voice.
    for (const word of [
      /correct/i,
      /incorrect/i,
      /well done/i,
      /right answer/i,
      /\bscore\b/i,
    ]) {
      expect(container.innerHTML).not.toMatch(word);
    }

    // Pacing IS allowed, and is what the real interview also gives.
    expect(screen.getByText(/Question 2 of 10/)).toBeInTheDocument();
  });
});

// =============================================================================
// 5. THE WRITING SENTENCE
// =============================================================================

describe('the writing test is dictated and never shown', () => {
  async function reachTheWritingSegment(
    user: ReturnType<typeof userEvent.setup>,
  ) {
    toolResults = [
      nextQuestionResult({
        text: `Now I will read a sentence and I would like you to write it down.\n\n${WRITING_SENTENCE}`,
        speakOnly: true,
        itemId: 'sentence-4',
        phase: 'writing',
      }),
    ];
    await modelCalls('next_question');
  }

  it('keeps the sentence out of the DOM entirely', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);
    await reachTheWritingSegment(user);

    // Route one: the tool result's own text.
    expect(document.body.innerHTML).not.toContain(WRITING_SENTENCE);
    expect(screen.queryByText(new RegExp(WRITING_SENTENCE, 'i'))).toBeNull();

    // Route two, and the one that would be missed: the provider transcribes the
    // officer's own audio, and that audio IS the sentence. Withholding the tool
    // result while rendering the transcript would leak it by the back door.
    await emit({
      type: 'response.output_audio_transcript.done',
      item_id: 'officer-writing',
      transcript: `Now I will read a sentence. ${WRITING_SENTENCE}`,
    });

    expect(document.body.innerHTML).not.toContain(WRITING_SENTENCE);
  });

  it('says what is happening rather than leaving a gap', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);
    await reachTheWritingSegment(user);

    expect(
      screen.getByText(/reading a sentence aloud for you to write down/i),
    ).toBeInTheDocument();
  });

  it('takes the answer through the shared dictation field and relays it', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);
    await reachTheWritingSegment(user);

    // A REAL `<label>`, and it is the writing practice screen's own.
    const field = screen.getByLabelText(/what you heard/i);
    expect(field).toBeInTheDocument();

    // The four attributes that decide what is being measured, on the real
    // element rather than on the MUI wrapper.
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).toHaveAttribute('autocorrect', 'off');
    expect(field).toHaveAttribute('autocapitalize', 'off');
    expect(field).toHaveAttribute('spellcheck', 'false');

    toolResults = [
      {
        tool: 'grade_answer',
        status: 'ok',
        ack: 'Thank you.',
        recorded: true,
        phase: 'writing',
        turnIndex: 6,
        progress: { civicsAsked: 6, civicsPlanned: 10 },
        awaitingCompletion: false,
      },
    ];

    // Reaching the segment already made one `next_question` call; this is
    // about the one the TYPED answer produces.
    toolCalls = [];

    await user.type(field, 'the people vote for the president in november');
    await user.click(
      screen.getByRole('button', { name: /give this to the officer/i }),
    );

    await waitFor(() => expect(toolCalls).toHaveLength(1));
    expect(toolCalls[0]).toEqual({
      tool: 'grade_answer',
      questionId: 'sentence-4',
      transcript: 'the people vote for the president in november',
    });

    // NO `confidence`. Nothing was recognised — they typed it — and a number
    // here would be this screen inventing a fact about audio that never
    // existed. Absent means unknown, which is the truth.
    expect(toolCalls[0]).not.toHaveProperty('confidence');
  });
});

// =============================================================================
// 6. FALLING BACK
// =============================================================================

describe('every failure ends at the text interview', () => {
  it('attempts no mint at all when the microphone is refused', async () => {
    getUserMedia.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    const user = userEvent.setup();
    renderVoice();

    await user.click(
      await screen.findByRole('button', { name: /start the spoken interview/i }),
    );

    // §7: no session is minted on a learner's own key for a conversation they
    // have no microphone to speak into.
    await screen.findByRole('link', { name: /continue by typing/i });
    expect(requests.some((request) => request.url.includes('/realtime-session'))).toBe(
      false,
    );

    // The named problem and its own remedy, from `useAudioCapture`'s six —
    // never "microphone unavailable".
    expect(
      screen.getByText(/blocking the microphone for this site/i),
    ).toBeInTheDocument();
  });

  it('renders AiNotReady naming the role when realtime is unbound', async () => {
    // Both halves of the same fact: the mint refuses, AND the cached status
    // says which role is missing. `AiNotReady` reads the status — it is the
    // shared component, unforked, and it is deliberately not told anything by
    // this screen except which role to ask about.
    aiStatus = { ...READY, unboundRoles: ['realtime'] };
    mintResponses = [
      { status: 'unavailable', cause: 'role_unbound', role: 'realtime' },
    ];
    const user = userEvent.setup();
    renderVoice();

    await user.click(
      await screen.findByRole('button', { name: /start the spoken interview/i }),
    );

    await screen.findByRole('link', { name: /continue by typing/i });
    expect(
      screen.getByText(/spoken interviews are not set up on this installation/i),
    ).toBeInTheDocument();
    // The shared component's own line. `AiNotReady` renders it for everyone;
    // the role name itself is admin-facing and gated inside that component.
    expect(
      screen.getByText(/not a problem with your key/i),
    ).toBeInTheDocument();
  });

  it('points a learner with no key of their own at the page that fixes it', async () => {
    mintResponses = [
      { status: 'unavailable', cause: 'no_user_key', role: 'realtime' },
    ];
    const user = userEvent.setup();
    renderVoice();

    await user.click(
      await screen.findByRole('button', { name: /start the spoken interview/i }),
    );

    await screen.findByRole('link', { name: /add your key/i });
    // `AiNotReady`'s "this is not a problem with your key" is not true of this
    // cause, so it is deliberately NOT rendered here.
    expect(screen.queryByText(/not a problem with your key/i)).toBeNull();
  });

  it('moves to the text interview when the connection drops and cannot be re-established', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);

    // Every re-mint fails, so the bounded retry exhausts. A failed re-mint is
    // NOT reported as "the provider refused" — the officer went silent
    // mid-conversation and that is the layer the learner is in.
    mintResponses = [
      { status: 'failed', errorCode: 'upstream', error: 'no' },
      { status: 'failed', errorCode: 'upstream', error: 'no' },
      { status: 'failed', errorCode: 'upstream', error: 'no' },
      { status: 'failed', errorCode: 'upstream', error: 'no' },
    ];

    await act(async () => {
      channel().onclose?.();
      await Promise.resolve();
    });

    await screen.findByText('the text interview', undefined, { timeout: 5000 });

    // The handoff is explained rather than silent — a learner whose officer
    // went quiet mid-question deserves one line saying what happened.
    expect(screen.getByText(/dropped and could not be re-established/i)).toBeInTheDocument();

    // AND THE PROGRESS IS INTACT: the same interview id, and the text screen
    // reads its state from the server, which never held anything in the
    // connection that just died.
    expect(
      requests.filter((request) => request.url.includes('/realtime-session')).length,
    ).toBeGreaterThan(1);
    expect(completeCalls).toBe(0);
    for (const track of micStream.tracks) {
      expect(track.stop).toHaveBeenCalled();
    }
  });

  it('re-mints before giving up, so a blip resumes rather than falls back', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);

    const before = requests.filter((r) => r.url.includes('/realtime-session')).length;

    await act(async () => {
      channel().onclose?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(peerConnections.length).toBeGreaterThan(1));
    await act(async () => {
      const dc = channel();
      dc.readyState = 'open';
      dc.onopen?.();
      await Promise.resolve();
    });

    // A fresh mint, a fresh handshake, and still on the voice screen.
    expect(
      requests.filter((r) => r.url.includes('/realtime-session')).length,
    ).toBe(before + 1);
    expect(screen.queryByText('the text interview')).toBeNull();
    expect(
      screen.getByRole('button', { name: /end this interview/i }),
    ).toBeInTheDocument();
  });

  it('offers a retry, and only where trying again could plausibly help', async () => {
    mintResponses = [
      { status: 'failed', errorCode: 'upstream_error', error: 'The provider refused.' },
    ];
    const user = userEvent.setup();
    renderVoice();

    await user.click(
      await screen.findByRole('button', { name: /start the spoken interview/i }),
    );

    await screen.findByRole('button', { name: /try the voice connection again/i });
    expect(screen.getByText('The provider refused.')).toBeInTheDocument();
  });

  it('does not offer a retry for a role nobody has bound', async () => {
    mintResponses = [
      { status: 'unavailable', cause: 'role_unbound', role: 'realtime' },
    ];
    const user = userEvent.setup();
    renderVoice();

    await user.click(
      await screen.findByRole('button', { name: /start the spoken interview/i }),
    );

    await screen.findByRole('link', { name: /continue by typing/i });
    // Offering a retry here is an invitation to press a button guaranteed to
    // fail, which reads as the product being broken.
    expect(
      screen.queryByRole('button', { name: /try the voice connection again/i }),
    ).toBeNull();
  });
});

// =============================================================================
// 7 & 8. ACCESSIBILITY AND WIDTH
// =============================================================================

describe('accessibility', () => {
  it('announces the live transcript politely, from a region mounted before its content', async () => {
    const user = userEvent.setup();
    renderVoice();
    await startSession(user);

    const region = screen.getByLabelText('Interview transcript');
    expect(region).toHaveAttribute('aria-live', 'polite');

    // ASSERTIVE WOULD BE UNUSABLE. Officer speech arrives fragment by fragment,
    // and an assertive region interrupts the reader on every one of them.
    expect(region).not.toHaveAttribute('aria-live', 'assertive');

    await emit({
      type: 'response.output_audio_transcript.delta',
      item_id: 'officer-1',
      delta: 'Good morning.',
    });

    // Busy while the words are still arriving, so the announcement waits for a
    // settled turn rather than reading half a sentence.
    expect(within(region).getByText(/Good morning\./)).toBeInTheDocument();
    expect(region).toHaveAttribute('aria-busy', 'true');

    await emit({
      type: 'response.output_audio_transcript.done',
      item_id: 'officer-1',
      transcript: 'Good morning. How are you today?',
    });
    expect(region).toHaveAttribute('aria-busy', 'false');
  });

  it('has exactly one h1 and a heading under it', async () => {
    const user = userEvent.setup();
    renderVoice();
    await screen.findByRole('heading', { level: 1, name: /spoken mock interview/i });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole('heading', { level: 2, name: /before you begin/i }),
    ).toBeInTheDocument();
    await startSession(user);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('announces a fallback', async () => {
    mintResponses = [
      { status: 'failed', errorCode: 'upstream', error: 'The provider refused.' },
    ];
    const user = userEvent.setup();
    renderVoice();
    await user.click(
      await screen.findByRole('button', { name: /start the spoken interview/i }),
    );

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The provider refused.')).toBeInTheDocument();
  });
});

describe('at 360px, in both themes', () => {
  for (const mode of ['light', 'dark'] as const) {
    it(`renders the conversation and the end control (${mode})`, async () => {
      setViewportWidth(PHONE);
      const user = userEvent.setup();
      const { container } = renderVoice({ mode });
      await startSession(user);

      expect(
        screen.getByRole('button', { name: /end this interview/i }),
      ).toBeVisible();
      expect(screen.getByLabelText('Interview transcript')).toBeInTheDocument();

      // Nothing forces the page wider than the phone it is on.
      for (const element of Array.from(container.querySelectorAll<HTMLElement>('*'))) {
        const width = element.style.width;
        if (width && width.endsWith('px')) {
          expect(Number.parseInt(width, 10)).toBeLessThanOrEqual(PHONE);
        }
      }
    });
  }
});

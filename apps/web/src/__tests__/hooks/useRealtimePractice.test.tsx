/**
 * The realtime practice relay, driven end to end — issue #355, epic #345 / E15.
 *
 * Fake `RTCPeerConnection`, fake data channel, stubbed `fetch`, and a fake
 * microphone PORT. There is no real audio here and this suite does not pretend
 * otherwise: `docs/specs/realtime-practice.md` §12 says the same thing
 * `realtime-interview.md` §10 does — real speech recognition and real barge-in
 * are verified by a person against a real deployment, because a test convincing
 * enough to stand in for them would be verifying the fake.
 *
 * What IS mechanically checkable is everything below, and every item is a
 * property whose failure would be invisible on a screen that otherwise looked
 * fine:
 *
 *  1. The relay forwards tool calls unexamined and hands results back VERBATIM,
 *     including a refusal — never an error that leaves the model waiting on a
 *     live, per-minute-billing connection.
 *  2. The microphone is BORROWED: no `getUserMedia` is called by the hook, and
 *     no track is disabled, muted or replaced for the life of the session.
 *  3. Every one of §10's four close conditions actually closes the connection.
 *  4. A drop re-mints up to `MAX_RECONNECTS` and then falls back WITH A SPOKEN
 *     sentence.
 *  5. A refused microphone means NO MINT IS ATTEMPTED AT ALL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import {
  MAX_RECONNECTS,
  REALTIME_PRACTICE_IDLE_MS,
  REALTIME_PRACTICE_PROVIDER_ERROR_LINE,
  useRealtimePractice,
  type RealtimePracticeMicrophonePort,
} from '../../hooks/useRealtimePractice';

const SESSION_ID = 'session-1';
const EPHEMERAL_SECRET = 'ek_ephemeral_secret_for_one_session';
const REALTIME_MODEL = 'gpt-4o-realtime-preview';

/**
 * A long-lived key, as a sentinel.
 *
 * NEVER RETURNED BY ANY STUB BELOW — it exists so an assertion can say "and
 * nothing shaped like this ever appeared", which is a different and stronger
 * claim than "the ephemeral secret appeared".
 */
const LEARNER_API_KEY = 'sk-a-long-lived-key-that-must-never-be-here';

// -----------------------------------------------------------------------------
// The fakes
// -----------------------------------------------------------------------------

class FakeTrack {
  kind = 'audio';
  enabled = true;
  muted = false;
  readyState: 'live' | 'ended' = 'live';
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

  createDataChannel() {
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

let requests: string[];
/** Every tool call posted to the relay route, in order. */
let toolCalls: Record<string, unknown>[];
/** What the relay route answers next, shifted off in order. */
let toolResults: unknown[];
let mintResponses: unknown[];
let realFetch: typeof globalThis.fetch;
let getUserMedia: ReturnType<typeof vi.fn>;
let micStream: FakeStream;

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The refusal a fresh session answers `repeat_question` with. */
function nothingOutstanding() {
  return {
    status: 'rejected',
    tool: 'repeat_question',
    reason: 'no_answer_outstanding',
    error: 'No question is waiting to be answered, so there is nothing to repeat.',
    instruction: 'Call next_question and say what it returns.',
  };
}

function askedResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: 'ok',
    tool: 'next_question',
    say: ['What is the supreme law of the land?'],
    then: 'await_answer',
    questionId: 'question-1',
    ...overrides,
  };
}

function stubFetch() {
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requests.push(url);

      if (url.startsWith('https://api.openai.com')) {
        return new Response('v=0\r\nfake-answer', {
          status: 200,
          headers: { 'Content-Type': 'application/sdp' },
        });
      }
      if (url.includes('/realtime-session')) {
        return json(
          mintResponses.shift() ?? {
            status: 'ok',
            clientSecret: EPHEMERAL_SECRET,
            expiresAt: '2026-03-01T12:01:00.000Z',
            modelId: REALTIME_MODEL,
          },
        );
      }
      if (url.includes('/realtime/tool-calls')) {
        toolCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json(toolResults.shift() ?? nothingOutstanding());
      }
      return json({});
    },
  ) as typeof globalThis.fetch;
}

// -----------------------------------------------------------------------------
// Rendering and driving
// -----------------------------------------------------------------------------

interface Harness {
  speak: ReturnType<typeof vi.fn>;
  microphone: RealtimePracticeMicrophonePort & {
    acquire: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}

function renderRealtime(
  options: { acquires?: (MediaStream | null)[]; hasQuestion?: boolean } = {},
) {
  const speak = vi.fn();
  const acquires = options.acquires;
  const microphone = {
    acquire: vi.fn(async () =>
      acquires ? (acquires.shift() ?? null) : (micStream as unknown as MediaStream),
    ),
    release: vi.fn(),
    problem: null as RealtimePracticeMicrophonePort['problem'],
  };

  const view = renderHook(() =>
    useRealtimePractice({
      sessionId: SESSION_ID,
      microphone,
      speak,
      hasQuestion: options.hasQuestion ?? true,
    }),
  );

  return { ...view, speak, microphone } as typeof view & Harness;
}

/** The data channel of the most recent peer connection. */
function channel(): FakeDataChannel {
  const pc = peerConnections[peerConnections.length - 1];
  expect(pc?.channel, 'no data channel was created').toBeTruthy();
  return pc!.channel!;
}

/** Let the handshake complete: open the channel the connection just created. */
async function completeHandshake(expected = 1) {
  await waitFor(() => expect(peerConnections.length).toBe(expected));
  await act(async () => {
    const dc = channel();
    dc.readyState = 'open';
    dc.onopen?.();
    await Promise.resolve();
    await Promise.resolve();
  });
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
}

/** Every `function_call_output` this browser sent back, in order. */
function toolOutputs(): { call_id: string; output: unknown }[] {
  return channelSends
    .filter((sent) => sent.type === 'conversation.item.create')
    .map((sent) => {
      const item = sent.item as { call_id: string; output: string };
      return { call_id: item.call_id, output: JSON.parse(item.output) as unknown };
    });
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  requests = [];
  toolCalls = [];
  toolResults = [];
  mintResponses = [];
  channelSends = [];
  peerConnections = [];
  micStream = new FakeStream();

  // Present so an assertion can prove the HOOK never reaches for it — the page
  // owns the one microphone and hands it over as a port.
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
  vi.useRealTimers();
  Reflect.deleteProperty(
    globalThis as unknown as Record<string, unknown>,
    'RTCPeerConnection',
  );
});

describe('the relay: unexamined out, verbatim back', () => {
  it('opens with repeat_question, follows the refusal to next_question, and speaks the engine’s own lines', async () => {
    toolResults = [nothingOutstanding(), askedResult()];
    const view = renderRealtime();

    await act(async () => {
      view.result.current.start();
    });
    await completeHandshake();
    await waitFor(() => expect(toolCalls.length).toBe(2));

    // The documented resume path: `repeat_question` writes nothing and costs
    // nothing, and its refusal's own instruction is what leads to
    // `next_question`. Opening the other way round would abandon an
    // outstanding question on every re-mint.
    expect(toolCalls[0]).toEqual({ tool: 'repeat_question' });
    expect(toolCalls[1]).toEqual({ tool: 'next_question' });

    // The engine's line, word for word, and never a sentence this hook wrote.
    const spoken = channelSends.filter((sent) => sent.type === 'response.create');
    expect(JSON.stringify(spoken)).toContain(
      'What is the supreme law of the land?',
    );
  });

  it('forwards a model tool call unexamined and hands the result back verbatim', async () => {
    toolResults = [
      nothingOutstanding(),
      askedResult(),
      {
        status: 'ok',
        tool: 'grade_answer',
        say: ['That is right.', 'Here is the next one.'],
        then: 'ask_next_question',
        questionId: null,
      },
    ];
    const view = renderRealtime();
    await act(async () => view.result.current.start());
    await completeHandshake();
    await waitFor(() => expect(toolCalls.length).toBe(2));

    await modelCalls('grade_answer', {
      questionId: 'question-1',
      transcript: 'the Constitution',
    });
    await waitFor(() => expect(toolCalls.length).toBe(3));

    // POSTED EXACTLY AS THE MODEL SAID IT — no trimming, no normalisation, and
    // no `confidence` invented on this transport (§3).
    expect(toolCalls[2]).toEqual({
      tool: 'grade_answer',
      questionId: 'question-1',
      transcript: 'the Constitution',
    });

    // AND HANDED BACK WHOLE. Not summarised, not reshaped, not filtered.
    const outputs = toolOutputs();
    expect(outputs[outputs.length - 1]).toEqual({
      call_id: 'call-grade_answer',
      output: {
        status: 'ok',
        tool: 'grade_answer',
        say: ['That is right.', 'Here is the next one.'],
        then: 'ask_next_question',
        questionId: null,
      },
    });
  });

  it('relays a REFUSAL as an ordinary result, so the conversation continues', async () => {
    const duplicate = {
      status: 'rejected',
      tool: 'grade_answer',
      reason: 'already_answered',
      error: 'That question already has a recorded answer.',
      instruction: 'Call next_question and say what it returns.',
    };
    toolResults = [nothingOutstanding(), askedResult(), duplicate];

    const view = renderRealtime();
    await act(async () => view.result.current.start());
    await completeHandshake();
    await waitFor(() => expect(toolCalls.length).toBe(2));

    await modelCalls('grade_answer', {
      questionId: 'question-1',
      transcript: 'the Constitution',
    });
    await waitFor(() => expect(toolOutputs().length).toBe(1));

    // The whole refusal, `instruction` included — that field is what gets the
    // session moving again, and a relay that treated a 200 refusal as a failure
    // would leave the coach holding a tool call that never resolves.
    expect(toolOutputs()[0].output).toEqual(duplicate);

    // AND THE SESSION IS STILL LIVE. A refusal is not an ending.
    expect(view.result.current.stage).toBe('live');
    expect(view.result.current.fallback).toBeNull();
  });

  it('answers a tool nobody declared without a round trip, and never leaves the model waiting', async () => {
    toolResults = [nothingOutstanding(), askedResult()];
    const view = renderRealtime();
    await act(async () => view.result.current.start());
    await completeHandshake();
    await waitFor(() => expect(toolCalls.length).toBe(2));

    await modelCalls('reveal_answer', { questionId: 'question-1' });

    const outputs = toolOutputs();
    expect(outputs).toHaveLength(1);
    expect(outputs[0].call_id).toBe('call-reveal_answer');
    expect(outputs[0].output).toMatchObject({
      status: 'rejected',
      reason: 'unknown_tool',
      instruction: expect.stringContaining('next_question'),
    });
    // Refused HERE, so nothing was posted: same outcome for the model, one
    // fewer round trip, and no unexplained 400 in the API's logs.
    expect(toolCalls).toHaveLength(2);
  });

  it('answers a relay that never reached the API, rather than going silent', async () => {
    toolResults = [nothingOutstanding(), askedResult()];
    const view = renderRealtime();
    await act(async () => view.result.current.start());
    await completeHandshake();
    await waitFor(() => expect(toolCalls.length).toBe(2));

    const failing = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/realtime/tool-calls')) {
        throw new Error('the network went away');
      }
      return json({});
    });
    globalThis.fetch = failing as unknown as typeof globalThis.fetch;

    await modelCalls('next_question');
    await waitFor(() => expect(toolOutputs().length).toBe(1));

    expect(toolOutputs()[0].output).toMatchObject({
      status: 'rejected',
      reason: 'relay_failed',
      instruction: expect.stringContaining('next_question'),
    });
  });
});

describe('the microphone is borrowed, and left strictly alone', () => {
  it('opens no `getUserMedia` of its own — the port supplies the one stream', async () => {
    toolResults = [nothingOutstanding(), askedResult()];
    const view = renderRealtime();
    await act(async () => view.result.current.start());
    await completeHandshake();

    expect(view.microphone.acquire).toHaveBeenCalledTimes(1);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('never disables, mutes or replaces the track for the life of the session', async () => {
    toolResults = [nothingOutstanding(), askedResult()];
    const view = renderRealtime();
    await act(async () => view.result.current.start());
    await completeHandshake();
    await waitFor(() => expect(toolCalls.length).toBe(2));

    const track = micStream.tracks[0];
    // Added to the peer connection exactly once, at handshake time.
    expect(peerConnections[0].addedTracks).toEqual([track]);

    await modelCalls('grade_answer', {
      questionId: 'question-1',
      transcript: 'the Constitution',
    });
    await modelCalls('next_question', {}, 'call-next');
    await emit({
      type: 'response.output_audio_transcript.delta',
      item_id: 'item-1',
      delta: 'Question two…',
    });

    // Still live, still enabled, still unmuted, still the same track. Every one
    // of those changing is a half-duplex design wearing a different name.
    expect(track.enabled).toBe(true);
    expect(track.muted).toBe(false);
    expect(track.readyState).toBe('live');
    expect(track.stop).not.toHaveBeenCalled();
    expect(view.result.current.stage).toBe('live');
  });

  it('gives the microphone back through its owner when the session ends', async () => {
    toolResults = [nothingOutstanding(), askedResult()];
    const view = renderRealtime();
    await act(async () => view.result.current.start());
    await completeHandshake();

    await act(async () => view.result.current.stop());

    // RELEASED THROUGH THE OWNER, and the connection's own teardown then stops
    // the tracks — so the microphone light goes out and the page's capture hook
    // is not left holding a dead stream.
    expect(view.microphone.release).toHaveBeenCalled();
    expect(micStream.tracks[0].stop).toHaveBeenCalled();
    expect(peerConnections[0].closed).toBe(true);
  });
});

describe('the session bounds (§10): close, never pause', () => {
  async function liveSession() {
    toolResults = [nothingOutstanding(), askedResult()];
    const view = renderRealtime();
    await act(async () => view.result.current.start());
    await completeHandshake();
    await waitFor(() => expect(view.result.current.stage).toBe('live'));
    return view;
  }

  it('closes when the engine says the session is complete', async () => {
    const view = await liveSession();
    toolResults = [
      {
        status: 'ok',
        tool: 'grade_answer',
        say: ['Thank you.'],
        then: 'session_complete',
        questionId: null,
      },
    ];

    await modelCalls('grade_answer', {
      questionId: 'question-1',
      transcript: 'the Constitution',
    });

    await waitFor(() => expect(view.result.current.stage).toBe('ended'));
    expect(peerConnections[0].closed).toBe(true);
    expect(view.microphone.release).toHaveBeenCalled();
    // NOT a fallback: nothing failed, so nothing falls anywhere.
    expect(view.result.current.fallback).toBeNull();
  });

  it('closes when the tab is hidden — and does not talk to an empty room', async () => {
    const view = await liveSession();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(peerConnections[0].closed).toBe(true);
    expect(view.result.current.stage).toBe('ended');
    expect(view.result.current.notice?.spoken).toBe(false);
    expect(view.speak).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  it('closes on unmount', async () => {
    const view = await liveSession();
    view.unmount();
    expect(peerConnections[0].closed).toBe(true);
    expect(view.microphone.release).toHaveBeenCalled();
    expect(micStream.tracks[0].stop).toHaveBeenCalled();
  });

  it('closes after the idle timeout, and says so out loud', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    toolResults = [nothingOutstanding(), askedResult()];
    const view = renderRealtime();
    await act(async () => view.result.current.start());
    await completeHandshake();
    await waitFor(() => expect(view.result.current.stage).toBe('live'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REALTIME_PRACTICE_IDLE_MS + 1000);
    });

    expect(peerConnections[0].closed).toBe(true);
    expect(view.result.current.stage).toBe('ended');
    // A learner who walked away is told, in the same sentence the screen shows.
    expect(view.speak).toHaveBeenCalledTimes(1);
    expect(view.speak.mock.calls[0][0]).toBe(view.result.current.notice?.message);
  });
});

describe('the degradation ladder’s client half', () => {
  it('attempts NO MINT when the microphone is refused', async () => {
    const view = renderRealtime({ acquires: [null] });
    view.microphone.problem = {
      message: 'Your browser is blocking the microphone for this site.',
      remedy: 'Allow the microphone from the icon in your address bar.',
      retryable: true,
    };

    await act(async () => view.result.current.start());
    await waitFor(() => expect(view.result.current.stage).toBe('fallback'));

    expect(view.result.current.fallback?.code).toBe('microphone');
    // §10: a mint on the learner's own key, for a session they have no
    // microphone to speak into, spends their money on nothing.
    expect(requests.some((url) => url.includes('/realtime-session'))).toBe(false);
    expect(peerConnections).toHaveLength(0);
  });

  it('mints nothing at all when the session has nothing left to ask', async () => {
    const view = renderRealtime({ hasQuestion: false });
    await act(async () => view.result.current.start());

    expect(view.microphone.acquire).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    expect(view.result.current.stage).toBe('idle');
  });

  it('falls back with the CAUSE when the mint is unavailable', async () => {
    mintResponses = [
      { status: 'unavailable', cause: 'no_user_key', role: 'realtime' },
    ];
    const view = renderRealtime();
    await act(async () => view.result.current.start());
    await waitFor(() => expect(view.result.current.stage).toBe('fallback'));

    expect(view.result.current.fallback?.code).toBe('ai_unavailable');
    expect(view.result.current.fallback?.cause).toBe('no_user_key');
    expect(view.result.current.fallback?.retryable).toBe(false);
    expect(peerConnections).toHaveLength(0);
    // Nothing was live, so nothing is said out loud: the learner is looking at
    // the screen they just pressed a button on.
    expect(view.speak).not.toHaveBeenCalled();
    expect(view.microphone.release).toHaveBeenCalled();
  });

  it('falls back, retryably, when the mint itself failed', async () => {
    mintResponses = [
      { status: 'failed', errorCode: 'provider_error', error: 'The provider refused.' },
    ];
    const view = renderRealtime();
    await act(async () => view.result.current.start());
    await waitFor(() => expect(view.result.current.stage).toBe('fallback'));

    expect(view.result.current.fallback?.code).toBe('mint_failed');
    expect(view.result.current.fallback?.retryable).toBe(true);
  });

  it('re-mints a dropped connection up to the bound, then falls back WITH A SPOKEN sentence', async () => {
    toolResults = [nothingOutstanding(), askedResult()];
    const view = renderRealtime();
    await act(async () => view.result.current.start());
    await completeHandshake();
    await waitFor(() => expect(view.result.current.stage).toBe('live'));

    // Drop it, over and over. Each drop re-mints; the last one is one too many.
    for (let attempt = 0; attempt <= MAX_RECONNECTS; attempt += 1) {
      const dc = channel();
      await act(async () => {
        dc.onclose?.();
        await Promise.resolve();
      });
      if (attempt < MAX_RECONNECTS) {
        await completeHandshake(attempt + 2);
      }
    }

    await waitFor(() => expect(view.result.current.stage).toBe('fallback'));
    expect(view.result.current.fallback?.code).toBe('connection_lost');

    // BOUNDED: the first connection plus exactly `MAX_RECONNECTS` re-mints.
    expect(peerConnections.length).toBe(MAX_RECONNECTS + 1);

    // AND SPOKEN, because a walking learner is not reading the screen. The
    // sentence said aloud is the sentence rendered — one fact, two renderings.
    expect(view.speak).toHaveBeenCalledTimes(1);
    expect(view.speak.mock.calls[0][0]).toBe(view.result.current.fallback?.message);
    expect(view.result.current.notice?.spoken).toBe(true);
    expect(view.result.current.notice?.message).toBe(
      view.result.current.fallback?.message,
    );
  });
});

// -----------------------------------------------------------------------------
// Issue #385: one call, however many shapes announce it
// -----------------------------------------------------------------------------

describe('a doubly-announced tool call is relayed once', () => {
  it('posts ONE tool call and sends ONE response.create for one call id', async () => {
    toolResults = [
      nothingOutstanding(),
      askedResult(),
      {
        status: 'ok',
        tool: 'grade_answer',
        say: ['That is right.'],
        then: 'ask_next_question',
        questionId: null,
      },
    ];
    const view = renderRealtime();
    await act(async () => view.result.current.start());
    await completeHandshake();
    await waitFor(() => expect(toolCalls.length).toBe(2));

    const beforeGrade = channelSends.length;

    // THE CURRENT REALTIME API EMITS BOTH OF THESE FOR ONE FUNCTION CALL.
    await modelCalls('grade_answer', {
      questionId: 'question-1',
      transcript: 'the Constitution',
    });
    await emit({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'call-grade_answer',
        name: 'grade_answer',
        arguments: JSON.stringify({
          questionId: 'question-1',
          transcript: 'the Constitution',
        }),
      },
    });
    await waitFor(() => expect(toolCalls.length).toBe(3));

    // ONE POST to `POST /api/practice/sessions/:id/realtime/tool-calls`. The
    // duplicate double-recorded a graded attempt against the engine.
    expect(toolCalls).toHaveLength(3);

    const afterGrade = channelSends.slice(beforeGrade);
    expect(
      afterGrade.filter((sent) => sent.type === 'conversation.item.create'),
    ).toHaveLength(1);
    // AND ONE `response.create`. The second lands while a response is active,
    // the provider rejects it, and the coach never reads the question aloud —
    // #385's measured 17.0s and 15.2s silences.
    expect(
      afterGrade.filter(
        (sent) => sent.type === 'response.create' && sent.response === undefined,
      ),
    ).toHaveLength(1);
  });

  it('tells the learner when the provider reports an error, and stays live', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      toolResults = [nothingOutstanding(), askedResult()];
      const view = renderRealtime();
      await act(async () => view.result.current.start());
      await completeHandshake();
      await waitFor(() => expect(view.result.current.stage).toBe('live'));

      await emit({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'conversation_already_has_active_response',
          message: 'Conversation already has an active response.',
        },
      });

      // RENDERED, in this hook's own code-owned words.
      expect(view.result.current.notice?.message).toBe(
        REALTIME_PRACTICE_PROVIDER_ERROR_LINE,
      );
      // NOT SPOKEN: the coach may be mid-sentence, and this describes a hiccup
      // rather than a change in the loop.
      expect(view.result.current.notice?.spoken).toBe(false);
      expect(view.speak).not.toHaveBeenCalled();

      // AND LOGGED, with the provider's own code — which the learner never sees.
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).toContain(
        'conversation_already_has_active_response',
      );

      // The session is untouched. Closing a live, working connection over an
      // error that ended one turn would be worse than the error.
      expect(view.result.current.stage).toBe('live');
      expect(view.result.current.fallback).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

// -----------------------------------------------------------------------------
// Issue #387: the session's own clock
// -----------------------------------------------------------------------------

describe('the cost clock measures the session, not a mount', () => {
  it('publishes one start, and a re-mint does not restart it', async () => {
    toolResults = [nothingOutstanding(), askedResult()];
    const view = renderRealtime();
    expect(view.result.current.startedAt).toBeNull();

    await act(async () => view.result.current.start());
    await completeHandshake();
    await waitFor(() => expect(view.result.current.stage).toBe('live'));

    const started = view.result.current.startedAt;
    expect(started).toBeTypeOf('number');

    // A DROP AND A RE-MINT ARE ONE SESSION on the learner's own key, billed as
    // one — so the clock they are reading must not go back to zero.
    await act(async () => {
      channel().onclose?.();
      await Promise.resolve();
    });
    await completeHandshake(2);
    await waitFor(() => expect(view.result.current.stage).toBe('live'));

    expect(view.result.current.startedAt).toBe(started);
  });
});

describe('the learner’s API key is nowhere near this hook', () => {
  it('sends only the ephemeral secret to the provider, and stores nothing', async () => {
    toolResults = [nothingOutstanding(), askedResult()];
    const view = renderRealtime();
    await act(async () => view.result.current.start());
    await completeHandshake();

    const everything = JSON.stringify({
      requests,
      toolCalls,
      channelSends,
      storage: { ...localStorage },
      session: { ...sessionStorage },
    });
    expect(everything).not.toContain(LEARNER_API_KEY);
    expect(everything).not.toContain(EPHEMERAL_SECRET);
    expect(view.result.current.stage).toBe('live');
  });
});

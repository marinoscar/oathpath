/**
 * The two provenance guards on the realtime mock interview — issue #400,
 * porting #399's fix, and issue #403's turn-detector widening, ported in the
 * same branch as commit `7d649d7`.
 *
 * SCOPE, DELIBERATELY NARROW. This is the first test file for
 * `useRealtimeInterview.ts`; it does not attempt `useRealtimePractice.test.tsx`'s
 * full sweep (the relay's general verbatim-forwarding contract, the microphone
 * lifecycle, the reconnect ladder, the idle timeout, #385's de-duplication).
 * None of that changed here. What changed is exactly two checks inside
 * `handleToolCall`, and this file's job is to pin them: a model-originated
 * `grade_answer` is refused locally, and never posted to
 * `POST /api/interviews/:id/realtime/tool-calls`, when the microphone produced
 * no applicant speech this turn, and when the transcript it reports is the
 * officer's own last utterance coming back.
 *
 * Same fake-provider approach `useRealtimePractice.test.tsx` uses, because it
 * is driving the identical shared module (`services/realtimeConnection.ts`):
 * a fake `RTCPeerConnection` and data channel, and a stubbed `fetch`. There is
 * no real audio here and this suite does not pretend otherwise — see that
 * file's own header and `docs/specs/realtime-interview.md` §10.
 *
 * Do NOT re-test `isLikelyCoachEcho`'s own rule here —
 * `apps/web/src/__tests__/lib/coachEcho.test.ts` owns that contract. This file
 * tests only that the hook asks the question (is this transcript the officer's
 * own words?) and acts on the answer (refuse, never post).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useRealtimeInterview } from '../../hooks/useRealtimeInterview';

const INTERVIEW_ID = 'interview-1';
const EPHEMERAL_SECRET = 'ek_ephemeral_secret_for_one_interview';
const REALTIME_MODEL = 'gpt-4o-realtime-preview';

// -----------------------------------------------------------------------------
// The fakes — identical shape to useRealtimePractice.test.tsx's, because both
// hooks drive the same `services/realtimeConnection.ts`.
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
/** Every tool call posted to `POST /api/interviews/:id/realtime/tool-calls`. */
let toolCalls: Record<string, unknown>[];
/** What the relay route answers next, shifted off in order. */
let toolResults: unknown[];
let mintResponses: unknown[];
let interviewDetail: Record<string, unknown>;
let realFetch: typeof globalThis.fetch;
let getUserMedia: ReturnType<typeof vi.fn>;
let micStream: FakeStream;

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * An honoured `next_question`, as the engine really answers one.
 *
 * `phase` defaults to `civics` — the ordinary case — and every test that cares
 * about a phase-scoped rule overrides it explicitly, so a reader never has to
 * guess which phase a given call belongs to.
 */
function askedResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ok',
    tool: 'next_question',
    phase: 'civics',
    turnIndex: 1,
    progress: { civicsAsked: 1, civicsPlanned: 10 },
    awaitingCompletion: false,
    text: 'What is the supreme law of the land?',
    speakOnly: false,
    itemId: null,
    ...overrides,
  };
}

/**
 * An honoured `grade_answer`, as the engine really answers one.
 *
 * `recorded` is a statement about the record, never about correctness (the
 * file header's own words) — defaulted `true` because nothing in this file
 * ever reads it; the guards under test fire, or don't, before a `grade_answer`
 * is posted at all.
 */
function gradedResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ok',
    tool: 'grade_answer',
    phase: 'civics',
    turnIndex: 2,
    progress: { civicsAsked: 1, civicsPlanned: 10 },
    awaitingCompletion: false,
    ack: 'Thank you.',
    recorded: true,
    ...overrides,
  };
}

function stubFetch() {
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
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
        return json(
          toolResults.shift() ?? {
            status: 'rejected',
            tool: 'grade_answer',
            reason: 'test_fixture_missing',
            error: 'No fixture was queued for this call.',
            instruction: 'call next_question and continue the interview',
          },
        );
      }
      if (method === 'GET' && url.endsWith(`/interviews/${INTERVIEW_ID}`)) {
        return json(interviewDetail);
      }
      return json({});
    },
  ) as typeof globalThis.fetch;
}

// -----------------------------------------------------------------------------
// Rendering and driving
// -----------------------------------------------------------------------------

function renderInterview() {
  return renderHook(() => useRealtimeInterview(INTERVIEW_ID));
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

/** Start the hook, wait for its own load to settle, then bring the connection live. */
async function liveInterview() {
  const view = renderInterview();
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  await act(async () => {
    view.result.current.start();
  });
  await completeHandshake();
  await waitFor(() => expect(view.result.current.stage).toBe('live'));
  return view;
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
  interviewDetail = {
    interview: {
      id: INTERVIEW_ID,
      mode: 'voice',
      status: 'in_progress',
      testVersionCode: '2008',
      seniorExemption: false,
      transcriptRetained: true,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: null,
      civicsAsked: 0,
      civicsCorrect: 0,
      passedCivics: false,
    },
    turns: [
      {
        id: 'turn-0',
        turnIndex: 0,
        role: 'officer',
        phase: 'smalltalk',
        questionId: null,
        text: 'Good morning. Please raise your right hand.',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
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
  Reflect.deleteProperty(
    globalThis as unknown as Record<string, unknown>,
    'RTCPeerConnection',
  );
});

// =============================================================================
// 1. Fails open — the regression this file exists to prevent
// =============================================================================

describe('the nothing-heard guard fails open until proven (#400)', () => {
  it('relays a grade_answer even though this connection has never observed applicant speech by any means', async () => {
    // NOT A SINGLE speech or voice-activity event is emitted anywhere in this
    // test. The deployment this connection represents may transcribe nothing
    // and report no turn-detector edges either (an older API behind a cached
    // bundle, a model that ignores both fields) — enforcing "nothing heard" on
    // absence here would refuse EVERY answer of EVERY interview on such a
    // deployment, which is worse than the bug #400 fixes.
    toolResults = [gradedResult({ ack: 'Thank you.' })];
    const view = await liveInterview();

    await modelCalls(
      'grade_answer',
      { questionId: 'question-1', transcript: 'the Constitution' },
      'call-grade-1',
    );

    // POSTED, not refused.
    await waitFor(() => expect(toolCalls.length).toBe(1));
    expect(toolCalls[0]).toEqual({
      tool: 'grade_answer',
      questionId: 'question-1',
      transcript: 'the Constitution',
    });
    expect(view.result.current.stage).toBe('live');
  });
});

// =============================================================================
// 2. The nothing-heard guard, once armed — including the turn boundary
// =============================================================================

describe('the nothing-heard guard, once armed (#400, #403)', () => {
  it('refuses a grade_answer for a turn the microphone heard nothing in, and resets on the next question', async () => {
    // Turn 1: genuine applicant speech both proves this deployment reports
    // applicant speech (arming the guard for every turn after it) and IS the
    // evidence this grade_answer needs.
    toolResults = [gradedResult({ ack: 'Correct.' })];
    const view = await liveInterview();

    await emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-learner-1',
      transcript: 'the Constitution',
    });
    await modelCalls(
      'grade_answer',
      { questionId: 'question-1', transcript: 'the Constitution' },
      'call-grade-1',
    );
    await waitFor(() => expect(toolCalls.length).toBe(1));
    expect(toolCalls[0]).toEqual({
      tool: 'grade_answer',
      questionId: 'question-1',
      transcript: 'the Constitution',
    });

    // The engine moves the interview to a second question — an honoured
    // `next_question` is the ONLY thing that begins a new turn on this
    // transport (#400: no `questionId` on the result and no `repeat_question`
    // tool to reset on, unlike practice).
    toolResults = [askedResult({ turnIndex: 2, text: 'Second question?' })];
    await modelCalls('next_question', {}, 'call-next-1');
    await waitFor(() => expect(toolCalls.length).toBe(2));

    // Turn 2 (THE BOUNDARY): nothing is transcribed and no voice-activity edge
    // fires — silence, the officer's own voice, anything. The guard is armed
    // (turn 1 proved this deployment reports applicant speech), and the
    // PREVIOUS turn having speech does not carry over — heardThisTurnRef was
    // reset by the honoured `next_question` above. Refused HERE and never
    // reaches the relay route.
    await modelCalls(
      'grade_answer',
      { questionId: 'question-2', transcript: 'a fabricated answer' },
      'call-grade-2',
    );

    // NEVER POSTED — the assertion that means "no practice_attempts row was
    // written for an answer nobody gave".
    expect(toolCalls).toHaveLength(2);

    const rejection = toolOutputs().find((o) => o.call_id === 'call-grade-2');
    expect(rejection?.output).toMatchObject({
      status: 'rejected',
      tool: 'grade_answer',
      reason: 'nothing_heard',
    });
    // The model is told what to do next (#400: this transport has no
    // `repeat_question`, so the way forward is naming `grade_answer` again).
    expect((rejection?.output as { instruction: string }).instruction).toContain(
      'grade_answer',
    );

    // AND THE INTERVIEW IS STILL LIVE. One unheard call is not a failure.
    expect(view.result.current.stage).toBe('live');
  });

  it('relays a genuine applicant answer once the microphone has heard something this turn', async () => {
    toolResults = [gradedResult({ ack: 'Thank you.' })];
    const view = await liveInterview();

    await emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-learner-1',
      transcript: 'the Constitution',
    });
    await modelCalls(
      'grade_answer',
      { questionId: 'question-1', transcript: 'the Constitution' },
      'call-grade-1',
    );

    await waitFor(() => expect(toolCalls.length).toBe(1));
    expect(toolCalls[0]).toEqual({
      tool: 'grade_answer',
      questionId: 'question-1',
      transcript: 'the Constitution',
    });

    // HANDED BACK VERBATIM — the whole honoured result, exactly as the relay
    // contract for every other tool call promises.
    const output = toolOutputs().find((o) => o.call_id === 'call-grade-1');
    expect(output?.output).toEqual(gradedResult({ ack: 'Thank you.' }));
  });

  it('a turn-detector edge alone arms and satisfies the guard (#403)', async () => {
    // ONLY the turn detector fires — no transcription event of any kind. This
    // is the ordering #403 fixes on the practice transport and #400 ports
    // here: the model's own `grade_answer` can arrive before the SEPARATE,
    // SLOWER transcription pipeline produces anything at all.
    toolResults = [gradedResult({ ack: 'Correct.' })];
    const view = await liveInterview();

    await emit({
      type: 'input_audio_buffer.speech_started',
      item_id: 'item-learner-1',
    });
    await modelCalls(
      'grade_answer',
      { questionId: 'question-1', transcript: 'the Constitution' },
      'call-grade-1',
    );

    // RELAYED — the edge alone is evidence enough, and arrives sooner than a
    // transcription would.
    await waitFor(() => expect(toolCalls.length).toBe(1));
    expect(toolCalls[0]).toEqual({
      tool: 'grade_answer',
      questionId: 'question-1',
      transcript: 'the Constitution',
    });

    // The engine moves to a new turn.
    toolResults = [askedResult({ turnIndex: 2, text: 'Second question?' })];
    await modelCalls('next_question', {}, 'call-next-1');
    await waitFor(() => expect(toolCalls.length).toBe(2));

    // Turn 2: NEITHER a transcription NOR a voice-activity event fires. If the
    // edge in turn 1 had armed some SEPARATE bypass rather than the same
    // `speechEvidenceSeenRef` a transcription event sets, this fabricated
    // answer would slip through unrefused. It does not.
    await modelCalls(
      'grade_answer',
      { questionId: 'question-2', transcript: 'a fabricated answer' },
      'call-grade-2',
    );

    expect(toolCalls).toHaveLength(2);
    const rejection = toolOutputs().find((o) => o.call_id === 'call-grade-2');
    expect(rejection?.output).toMatchObject({
      status: 'rejected',
      reason: 'nothing_heard',
    });
  });
});

// =============================================================================
// 3. The echo guard (lib/coachEcho.ts, reused unforked)
// =============================================================================

describe('the echo guard (#400, lib/coachEcho.ts)', () => {
  it('refuses a grade_answer reporting the officer’s own last words verbatim, then relays a genuine answer for the same turn', async () => {
    toolResults = [gradedResult({ ack: 'Correct.' })];
    const view = await liveInterview();

    // The officer finishes asking — its OWN transcript of its OWN output,
    // exactly what `officerSpeech` stores in `officerUtteranceRef`.
    await emit({
      type: 'response.output_audio_transcript.done',
      item_id: 'item-officer-1',
      transcript: 'Where is the Statue of Liberty?',
    });

    // The microphone DID hear something this turn — an acoustic echo of the
    // officer's own words, exactly what produces this bug. If the
    // nothing-heard guard alone were doing the work here, it would let this
    // straight through; this proves the ECHO guard is the one that fires.
    await emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-learner-1',
      transcript: 'Where is the Statue of Liberty?',
    });

    await modelCalls(
      'grade_answer',
      { questionId: 'question-1', transcript: 'Where is the Statue of Liberty?' },
      'call-echo',
    );

    // NEVER POSTED.
    expect(toolCalls).toHaveLength(0);
    const rejection = toolOutputs().find((o) => o.call_id === 'call-echo');
    expect(rejection?.output).toMatchObject({
      status: 'rejected',
      tool: 'grade_answer',
      reason: 'echoed_question',
    });
    expect((rejection?.output as { instruction: string }).instruction).toContain(
      'own voice',
    );

    // A GENUINE answer for the SAME turn (the heard flag is still armed) is
    // relayed normally — the echo guard never touches an answer that is not
    // the officer's own words coming back.
    await modelCalls(
      'grade_answer',
      { questionId: 'question-1', transcript: 'New York Harbor' },
      'call-genuine',
    );
    await waitFor(() => expect(toolCalls.length).toBe(1));
    expect(toolCalls[0]).toEqual({
      tool: 'grade_answer',
      questionId: 'question-1',
      transcript: 'New York Harbor',
    });
  });

  it('refuses a partial echo — five or more of the officer’s own words, in the officer’s own order', async () => {
    // `ECHO_MIN_CONTAINED_WORDS` (lib/coachEcho.ts) is 5. The transcript below
    // is words 3-7 of the officer's own sentence, consecutively and in order —
    // exactly the shape a clipped echo produces.
    toolResults = [];
    const view = await liveInterview();

    await emit({
      type: 'response.output_audio_transcript.done',
      item_id: 'item-officer-1',
      transcript: 'What is one right or freedom from the First Amendment?',
    });
    await emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-learner-1',
      transcript: 'one right or freedom from',
    });

    await modelCalls(
      'grade_answer',
      { questionId: 'question-1', transcript: 'one right or freedom from' },
      'call-echo-partial',
    );

    expect(toolCalls).toHaveLength(0);
    const rejection = toolOutputs().find((o) => o.call_id === 'call-echo-partial');
    expect(rejection?.output).toMatchObject({
      status: 'rejected',
      tool: 'grade_answer',
      reason: 'echoed_question',
    });
    expect(view.result.current.stage).toBe('live');
  });

  it('a delta alone cannot arm the echo check — only a completed officer utterance can', async () => {
    toolResults = [gradedResult({ ack: 'Correct.' })];
    const view = await liveInterview();

    // A DELTA ONLY — the officer is still mid-sentence, so `officerSpeech`
    // never writes to `officerUtteranceRef` (only its `done` branch does).
    await emit({
      type: 'response.output_audio_transcript.delta',
      item_id: 'item-officer-1',
      delta: 'Where is the Statue',
    });

    // The applicant answers with exactly those (half-sentence) words. There is
    // no COMPLETED officer utterance for `isLikelyCoachEcho` to compare
    // against — it returns `false` on a `null` second argument by construction
    // (lib/coachEcho.ts) — so this must not be refused as an echo.
    await emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-learner-1',
      transcript: 'Where is the Statue',
    });
    await modelCalls(
      'grade_answer',
      { questionId: 'question-1', transcript: 'Where is the Statue' },
      'call-grade-1',
    );

    // RELAYED.
    await waitFor(() => expect(toolCalls.length).toBe(1));
    expect(toolCalls[0]).toEqual({
      tool: 'grade_answer',
      questionId: 'question-1',
      transcript: 'Where is the Statue',
    });
  });

  it('a voice-activity event does not disturb the echo guard (#403)', async () => {
    // An acoustic echo reaching the microphone raises the turn detector's
    // edges exactly as a genuine answer does — that is precisely why the two
    // guards must be independent, and this pins it: satisfying the
    // nothing-heard guard via a voice-activity event must not read as "this is
    // not an echo".
    toolResults = [];
    const view = await liveInterview();

    await emit({
      type: 'response.output_audio_transcript.done',
      item_id: 'item-officer-1',
      transcript: 'Where is the Statue of Liberty?',
    });
    await emit({
      type: 'input_audio_buffer.speech_started',
      item_id: 'item-learner-1',
    });

    await modelCalls(
      'grade_answer',
      { questionId: 'question-1', transcript: 'Where is the Statue of Liberty?' },
      'call-echo',
    );

    // STILL REFUSED, as `echoed_question` — never relayed, whatever satisfied
    // the nothing-heard check.
    expect(toolCalls).toHaveLength(0);
    const rejection = toolOutputs().find((o) => o.call_id === 'call-echo');
    expect(rejection?.output).toMatchObject({
      status: 'rejected',
      reason: 'echoed_question',
    });
    expect(view.result.current.stage).toBe('live');
  });
});

// =============================================================================
// 4. The reading-phase exemption — narrow, not a disabled guard
// =============================================================================

describe('the echo guard’s reading-phase exemption (#400) — narrow, not disabled', () => {
  it('relays a grade_answer echoing the reading sentence in the reading phase, but refuses the identical transcript once the phase has moved on', async () => {
    toolResults = [
      gradedResult({ ack: 'Correct.' }), // turn 1 (civics) — arms the guard
      askedResult({
        phase: 'reading',
        turnIndex: 2,
        text: 'I am a good neighbor.',
        itemId: 'sentence-1',
      }),
      gradedResult({ phase: 'reading', turnIndex: 3, ack: 'Thank you.' }),
      askedResult({ phase: 'civics', turnIndex: 4, text: 'A third question?' }),
    ];
    const view = await liveInterview();

    // Turn 1: arm the guard with a genuine civics answer.
    await emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-learner-1',
      transcript: 'the Constitution',
    });
    await modelCalls(
      'grade_answer',
      { questionId: 'question-1', transcript: 'the Constitution' },
      'call-grade-1',
    );
    await waitFor(() => expect(toolCalls.length).toBe(1));

    // The engine moves into the reading phase — `echoGuardArmedRef` is set
    // from THIS result's own `phase`, beside the turn reset (#400).
    await modelCalls('next_question', {}, 'call-next-1');
    await waitFor(() => expect(toolCalls.length).toBe(2));

    // The officer reads the sentence aloud.
    await emit({
      type: 'response.output_audio_transcript.done',
      item_id: 'item-officer-2',
      transcript: 'I am a good neighbor.',
    });

    // The applicant reads it back — a CORRECT reading attempt IS the officer's
    // own last utterance, word for word (the file header's own argument).
    // This is exactly the shape the echo guard refuses everywhere else.
    await emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-learner-2',
      transcript: 'I am a good neighbor.',
    });
    await modelCalls(
      'grade_answer',
      { questionId: 'sentence-1', transcript: 'I am a good neighbor.' },
      'call-reading',
    );

    // RELAYED. The echo guard is disarmed in the reading phase, and only
    // there.
    await waitFor(() => expect(toolCalls.length).toBe(3));
    expect(toolCalls[2]).toEqual({
      tool: 'grade_answer',
      questionId: 'sentence-1',
      transcript: 'I am a good neighbor.',
    });
    expect(
      toolOutputs().find((o) => o.call_id === 'call-reading')?.output,
    ).toMatchObject({ status: 'ok' });

    // The phase moves back to civics — `echoGuardArmedRef` is re-armed by this
    // honoured result's own `phase !== 'reading'`.
    await modelCalls('next_question', {}, 'call-next-2');
    await waitFor(() => expect(toolCalls.length).toBe(4));

    // The SAME transcript, now heard in the new (non-reading) phase, is
    // refused — proof the exemption is scoped to the reading phase rather
    // than the guard simply being off.
    await emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-learner-3',
      transcript: 'I am a good neighbor.',
    });
    await modelCalls(
      'grade_answer',
      { questionId: 'question-4', transcript: 'I am a good neighbor.' },
      'call-echo-after-reading',
    );

    // NEVER POSTED — the call count is unchanged from the four honoured calls
    // above.
    expect(toolCalls).toHaveLength(4);
    const rejection = toolOutputs().find(
      (o) => o.call_id === 'call-echo-after-reading',
    );
    expect(rejection?.output).toMatchObject({
      status: 'rejected',
      reason: 'echoed_question',
    });
  });
});

// =============================================================================
// 5. The guard stays armed through writing — where it matters most
// =============================================================================

describe('the echo guard stays armed through the writing phase (#400)', () => {
  it('refuses a model-originated grade_answer echoing the dictated sentence', async () => {
    toolResults = [
      gradedResult({ ack: 'Correct.' }), // turn 1 (civics) — arms the guard
      askedResult({
        phase: 'writing',
        turnIndex: 2,
        text: 'The eagle is our national bird.',
        speakOnly: true,
        itemId: 'sentence-writing-1',
      }),
    ];
    const view = await liveInterview();

    await emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-learner-1',
      transcript: 'the Constitution',
    });
    await modelCalls(
      'grade_answer',
      { questionId: 'question-1', transcript: 'the Constitution' },
      'call-grade-1',
    );
    await waitFor(() => expect(toolCalls.length).toBe(1));

    // The engine moves to the writing (dictation) phase.
    await modelCalls('next_question', {}, 'call-next-1');
    await waitFor(() => expect(toolCalls.length).toBe(2));
    await waitFor(() =>
      expect(view.result.current.writingPrompt).toEqual({
        itemId: 'sentence-writing-1',
      }),
    );

    // The officer dictates the sentence aloud — captured into
    // `officerUtteranceRef` (never rendered, per the withholding rule, but
    // still kept: "writing is the one phase where the officer's spoken words
    // ARE the answer, so an echoed grade_answer would score as a perfect
    // one").
    await emit({
      type: 'response.output_audio_transcript.done',
      item_id: 'item-officer-2',
      transcript: 'The eagle is our national bird.',
    });

    // The dictation echoes straight back through the microphone — the
    // officer's own voice, not the applicant typing.
    await emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-learner-2',
      transcript: 'The eagle is our national bird.',
    });
    await modelCalls(
      'grade_answer',
      { questionId: 'sentence-writing-1', transcript: 'The eagle is our national bird.' },
      'call-echo-writing',
    );

    // NEVER POSTED — unlike reading, writing is NOT exempt.
    expect(toolCalls).toHaveLength(2);
    const rejection = toolOutputs().find((o) => o.call_id === 'call-echo-writing');
    expect(rejection?.output).toMatchObject({
      status: 'rejected',
      tool: 'grade_answer',
      reason: 'echoed_question',
    });
  });
});

// =============================================================================
// 6. submitWriting is structurally out of reach of both guards
// =============================================================================

describe('submitWriting bypasses both guards structurally (#400)', () => {
  it('relays a typed writing answer that would have been refused twice over had it gone through handleToolCall', async () => {
    toolResults = [
      gradedResult({ ack: 'Correct.' }), // turn 1 (civics) — arms the guard
      askedResult({
        phase: 'writing',
        turnIndex: 2,
        text: 'The eagle is our national bird.',
        speakOnly: true,
        itemId: 'sentence-writing-1',
      }),
      gradedResult({ phase: 'writing', turnIndex: 3, ack: 'Thank you.' }),
    ];
    const view = await liveInterview();

    // Turn 1: arm `speechEvidenceSeenRef` with genuine speech, so the
    // nothing-heard guard is no longer failing open for the rest of this
    // test.
    await emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-learner-1',
      transcript: 'the Constitution',
    });
    await modelCalls(
      'grade_answer',
      { questionId: 'question-1', transcript: 'the Constitution' },
      'call-grade-1',
    );
    await waitFor(() => expect(toolCalls.length).toBe(1));

    // The engine moves to the writing phase.
    await modelCalls('next_question', {}, 'call-next-1');
    await waitFor(() => expect(toolCalls.length).toBe(2));
    await waitFor(() =>
      expect(view.result.current.writingPrompt).toEqual({
        itemId: 'sentence-writing-1',
      }),
    );

    // The officer dictates the sentence — this is what `officerUtteranceRef`
    // now holds. NO applicant speech event is ever emitted this turn: the
    // applicant is typing, not speaking, so `heardThisTurnRef` stays false.
    // A model-originated `grade_answer` right now would be refused TWICE
    // over: `nothing_heard` (armed, unheard this turn) AND `echoed_question`
    // (armed — writing is not exempt — and this text IS the officer's last
    // utterance).
    await emit({
      type: 'response.output_audio_transcript.done',
      item_id: 'item-officer-2',
      transcript: 'The eagle is our national bird.',
    });

    // The learner TYPES the same words — exactly what a correct dictation
    // looks like — through `submitWriting`, never through the model.
    await act(async () => {
      view.result.current.submitWriting('The eagle is our national bird.');
    });

    // RELAYED. `submitWriting` calls `relay(call, null)` directly and never
    // passes through `handleToolCall` — so neither guard, though both are
    // armed and both would refuse this exact transcript, ever sees this call.
    await waitFor(() => expect(toolCalls.length).toBe(3));
    expect(toolCalls[2]).toEqual({
      tool: 'grade_answer',
      questionId: 'sentence-writing-1',
      transcript: 'The eagle is our national bird.',
    });

    // `callId: null` — there is no tool result to send back for a call the
    // model never made, so `sendToolResult` is never invoked for it. Only the
    // two EARLIER model-originated calls (`call-grade-1`, `call-next-1`) have
    // an entry here.
    const outputs = toolOutputs();
    expect(outputs.map((o) => o.call_id).sort()).toEqual(
      ['call-grade-1', 'call-next-1'].sort(),
    );

    // Instead the officer is spoken to directly, which is also what prompts
    // it to ask for the next question.
    await waitFor(() => expect(view.result.current.isSubmittingWriting).toBe(false));
  });
});

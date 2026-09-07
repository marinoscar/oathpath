/**
 * The realtime transport's own decisions — issue #159, epic #60 / E11.
 *
 * `RealtimeInterviewPage.test.tsx` covers the screen; this covers the two
 * places the transport makes a judgement of its own, both of which fail
 * silently when they are wrong:
 *
 *  1. **Which provider events mean what.** An event spelling this bundle does
 *     not recognise produces an empty transcript, or — far worse — a tool call
 *     that never arrives, on a connection that looks perfectly healthy.
 *  2. **What a malformed tool call becomes.** A `grade_answer` with half its
 *     arguments must not be posted with the missing half invented.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  createRealtimeTurnTracker,
  handleProviderEvent,
  isRealtimeToolName,
  openRealtimeConnection,
  REALTIME_CALL_URL,
  REALTIME_RESPONSE_DEFER_MS,
  REALTIME_STALL_NUDGE_MS,
  TOOL_CALL_MEMORY,
  type RealtimeConnectionHandlers,
  type RealtimeProviderError,
  type RealtimeTurnTracker,
} from '../../services/realtimeConnection';
import { toToolCallInput } from '../../hooks/useRealtimeInterview';

function handlers(): RealtimeConnectionHandlers & {
  toolCalls: unknown[];
  officer: unknown[];
  applicant: unknown[];
  errors: RealtimeProviderError[];
  /** THIS connection's memory of its own turns. One per `handlers()`. */
  turns: RealtimeTurnTracker;
} {
  const toolCalls: unknown[] = [];
  const officer: unknown[] = [];
  const applicant: unknown[] = [];
  const errors: RealtimeProviderError[] = [];
  return {
    toolCalls,
    officer,
    applicant,
    errors,
    turns: createRealtimeTurnTracker(),
    onToolCall: (call) => toolCalls.push(call),
    onOfficerSpeech: (event) => officer.push(event),
    onApplicantSpeech: (event) => applicant.push(event),
    onProviderError: (error) => errors.push(error),
    onRemoteStream: () => undefined,
    onClosed: () => undefined,
  };
}

const frame = (event: unknown) => JSON.stringify(event);

/**
 * Deliver one event, on the tracker that belongs to these handlers.
 *
 * The tracker is per-CONNECTION, so sharing one across a test is what makes
 * "the same call id announced twice" mean anything at all.
 */
function deliver(h: ReturnType<typeof handlers>, raw: unknown) {
  handleProviderEvent(raw, h, h.turns);
}

/** The two events the current Realtime API emits for ONE function call. */
function argumentsDone(callId: string, name = 'next_question', args = '{}') {
  return frame({
    type: 'response.function_call_arguments.done',
    call_id: callId,
    name,
    arguments: args,
  });
}

function outputItemDone(callId: string, name = 'next_question', args = '{}') {
  return frame({
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id: callId, name, arguments: args },
  });
}

describe('provider events', () => {
  it('surfaces a tool call only when its arguments are COMPLETE', () => {
    const h = handlers();

    // A partially-arrived argument string parses as invalid JSON or, worse, as
    // a DIFFERENT valid object than the model meant — a `grade_answer` whose
    // transcript is the first half of what the learner said would be graded as
    // though they stopped there.
    deliver(
      h,
      frame({
        type: 'response.function_call_arguments.delta',
        call_id: 'c1',
        delta: '{"questionId":"q1","transc',
      }),
    );
    expect(h.toolCalls).toHaveLength(0);

    deliver(
      h,
      frame({
        type: 'response.function_call_arguments.done',
        call_id: 'c1',
        name: 'grade_answer',
        arguments: '{"questionId":"q1","transcript":"the constitution"}',
      }),
    );
    expect(h.toolCalls).toEqual([
      {
        callId: 'c1',
        name: 'grade_answer',
        args: { questionId: 'q1', transcript: 'the constitution' },
      },
    ]);
  });

  it('accepts the other shape some model versions emit for the same call', () => {
    const h = handlers();
    deliver(
      h,
      frame({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'c2',
          name: 'next_question',
          arguments: '{}',
        },
      }),
    );
    expect(h.toolCalls).toHaveLength(1);
  });

  it('accepts both spellings of the officer’s transcript', () => {
    // Which spelling a deployment sees depends on the model an administrator
    // bound, not on this bundle. Recognising one costs a live transcript that
    // is silently empty on half the models the settings page offers.
    for (const type of [
      'response.output_audio_transcript.delta',
      'response.audio_transcript.delta',
    ]) {
      const h = handlers();
      deliver(h, frame({ type, item_id: 'i1', delta: 'Good ' }));
      expect(h.officer).toEqual([
        { itemId: 'i1', text: 'Good ', done: false },
      ]);
    }
  });

  it('reports an absent confidence as UNKNOWN, never as zero', () => {
    const h = handlers();
    deliver(
      h,
      frame({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'i2',
        transcript: 'the constitution',
      }),
    );

    // A 0 would be a confident claim that the recogniser was certain it heard
    // nothing — which the server reads as a mishearing and stamps on a
    // perfectly good answer (`voice.md` §3).
    expect(h.applicant).toEqual([
      {
        itemId: 'i2',
        text: 'the constitution',
        done: true,
        confidence: undefined,
      },
    ]);
  });

  it('ignores anything it does not recognise rather than throwing', () => {
    const h = handlers();
    for (const raw of [
      frame({ type: 'rate_limits.updated' }),
      frame({ type: 'output_audio_buffer.started' }),
      'not json at all',
      undefined,
      42,
    ]) {
      expect(() => deliver(h, raw)).not.toThrow();
    }
    expect(h.toolCalls).toHaveLength(0);
  });

  it('relays ONE call exactly once, however many shapes announce it', () => {
    // ISSUE #385, THE DEFECT ITSELF. The current Realtime API emits BOTH
    // `response.function_call_arguments.done` and `response.output_item.done`
    // for a single function call. Without a guard each one was relayed — so
    // every tool call was posted to the API twice and answered with two
    // `response.create`s, the second of which the provider rejects with
    // `conversation_already_has_active_response`. Measured on a device: the
    // coach did not read the question aloud on Q3 or Q5, 17.0s and 15.2s of
    // silence with the question on screen.
    const h = handlers();
    deliver(h, argumentsDone('call-1', 'grade_answer', '{"questionId":"q1","transcript":"x"}'));
    deliver(h, outputItemDone('call-1', 'grade_answer', '{"questionId":"q1","transcript":"x"}'));

    expect(h.toolCalls).toEqual([
      {
        callId: 'call-1',
        name: 'grade_answer',
        args: { questionId: 'q1', transcript: 'x' },
      },
    ]);
  });

  it('relays a call announced by only ONE shape, whichever shape that is', () => {
    // The guard is a de-duplication, never a deletion: some model versions
    // emit only one of the two, and dropping either branch would cost a tool
    // call that never arrives on a connection that looks perfectly healthy.
    const first = handlers();
    deliver(first, argumentsDone('only-arguments'));
    expect(first.toolCalls).toHaveLength(1);

    const second = handlers();
    deliver(second, outputItemDone('only-output-item'));
    expect(second.toolCalls).toHaveLength(1);
  });

  it('de-duplicates per CONNECTION, so a second session relays its own calls', () => {
    // The memory is the tracker's, and the tracker is created per connection.
    // A re-mint after a drop resumes the same practice session at the same
    // question — and the engine may well hand out the same shaped call again.
    const first = handlers();
    deliver(first, argumentsDone('call-1'));
    expect(first.toolCalls).toHaveLength(1);

    const second = handlers();
    deliver(second, argumentsDone('call-1'));
    expect(second.toolCalls).toHaveLength(1);
  });

  it('bounds what it remembers, so a long session cannot grow it forever', () => {
    // The bound is safe because the duplicate is ADJACENT — the two shapes for
    // one call arrive milliseconds apart, in the same response, with nothing
    // between them. `TOOL_CALL_MEMORY` is therefore dozens of turns of slack
    // over a window that only ever needs to be one.
    const h = handlers();
    const overflowed = TOOL_CALL_MEMORY + 1;
    for (let index = 0; index < overflowed; index += 1) {
      deliver(h, argumentsDone(`call-${index}`));
    }
    expect(h.toolCalls).toHaveLength(overflowed);

    // The most recent call is still remembered — which is the only window that
    // matters, because that is where a duplicate can appear.
    deliver(h, outputItemDone(`call-${overflowed - 1}`));
    expect(h.toolCalls).toHaveLength(overflowed);

    // And the set has not grown without limit: the oldest id was evicted the
    // moment the bound was passed. A provider re-announcing a call id from
    // sixty-four distinct calls ago is not something its protocol does; an
    // unbounded Set on a twenty-minute session is.
    deliver(h, argumentsDone('call-0'));
    expect(h.toolCalls).toHaveLength(overflowed + 1);
  });

  it('REPORTS a provider error rather than dropping it', () => {
    // #385's compounding failure: there was no `error` branch at all, so the
    // rejection that stalled the turn reached nobody — no notice, no log, no
    // fallback. A learner saw a question and heard nothing.
    const h = handlers();
    deliver(
      h,
      frame({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'conversation_already_has_active_response',
          message: 'Conversation already has an active response.',
        },
      }),
    );

    expect(h.errors).toEqual([
      {
        code: 'conversation_already_has_active_response',
        message: 'Conversation already has an active response.',
      },
    ]);

    // AND NOTHING WAS TORN DOWN. Most of these end one turn, not one session.
    expect(h.toolCalls).toHaveLength(0);
  });

  it('falls back to the error’s own type when it carries no code', () => {
    const h = handlers();
    deliver(
      h,
      frame({ type: 'error', error: { type: 'server_error', message: 'Oops.' } }),
    );
    expect(h.errors).toEqual([{ code: 'server_error', message: 'Oops.' }]);
  });

  it('knows the three tools and no others', () => {
    expect(isRealtimeToolName('next_question')).toBe(true);
    expect(isRealtimeToolName('grade_answer')).toBe(true);
    expect(isRealtimeToolName('end_phase')).toBe(true);
    // The one a model would invent if it could.
    expect(isRealtimeToolName('report_verdict')).toBe(false);
  });
});

describe('narrowing a tool call', () => {
  it('refuses a grade_answer missing its arguments rather than inventing them', () => {
    expect(
      toToolCallInput({ callId: 'c', name: 'grade_answer', args: { questionId: 'q' } }),
    ).toBeNull();
    expect(
      toToolCallInput({ callId: 'c', name: 'grade_answer', args: {} }),
    ).toBeNull();
    expect(
      toToolCallInput({ callId: 'c', name: 'end_phase', args: {} }),
    ).toBeNull();
  });

  it('leaves an absent confidence absent', () => {
    const call = toToolCallInput({
      callId: 'c',
      name: 'grade_answer',
      args: { questionId: 'q', transcript: 'x' },
    });
    expect(call).toEqual({
      tool: 'grade_answer',
      questionId: 'q',
      transcript: 'x',
      confidence: undefined,
    });
  });
});

describe('the handshake', () => {
  it('stops every microphone track when it cannot complete', async () => {
    const stop = vi.fn();
    const track = { kind: 'audio', enabled: true, stop };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream;

    class DeadPeerConnection {
      createDataChannel() {
        return { readyState: 'connecting', send: vi.fn(), close: vi.fn() };
      }
      addTrack() {}
      getReceivers() {
        return [];
      }
      async createOffer() {
        return { type: 'offer', sdp: 'v=0' };
      }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      close() {}
    }
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      DeadPeerConnection;

    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('', { status: 401 }));

    const onClosed = vi.fn();
    await expect(
      openRealtimeConnection({
        clientSecret: 'ek_expired',
        modelId: 'gpt-4o-realtime-preview',
        stream,
        handlers: { ...handlers(), onClosed },
      }),
    ).rejects.toThrow();

    // The learner's microphone must not stay live because a handshake failed.
    expect(stop).toHaveBeenCalled();

    // AND `onClosed` IS NOT FIRED. The rejection already told the caller; a
    // second report would have it handling one failure twice — once as
    // "reconnect and resume" and once as "fall back" — racing each other.
    expect(onClosed).not.toHaveBeenCalled();

    globalThis.fetch = realFetch;
    Reflect.deleteProperty(globalThis, 'RTCPeerConnection');
  });

  it('names the model on the provider URL, not in a body a caller controls', () => {
    // The secret was minted against exactly one model, so the handshake has to
    // agree with the mint — which is why `modelId` comes back on the mint
    // response rather than being re-derived on this side, where it could be
    // stale.
    expect(REALTIME_CALL_URL).toMatch(/^https:\/\//);
    expect(new URL(REALTIME_CALL_URL).origin).toBe('https://api.openai.com');
  });
});

// -----------------------------------------------------------------------------
// One relayed call, one `response.create` — issue #385
// -----------------------------------------------------------------------------

class FakeChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  /** Everything this browser put on the wire, parsed. */
  sent: Record<string, unknown>[] = [];
  send(payload: string) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }
  close() {
    this.readyState = 'closed';
  }
}

let liveChannel: FakeChannel | null = null;

class LivePeerConnection {
  connectionState = 'new';
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  createDataChannel() {
    liveChannel = new FakeChannel();
    return liveChannel;
  }
  addTrack() {}
  getReceivers() {
    return [];
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\nfake-offer' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {}
}

/** Open a connection whose data channel is a recorder. */
async function openLive(h: ReturnType<typeof handlers>) {
  const track = { kind: 'audio', enabled: true, stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;

  const pending = openRealtimeConnection({
    clientSecret: 'ek_ephemeral',
    modelId: 'gpt-realtime',
    stream,
    handlers: h,
  });

  // `createDataChannel` — and therefore `onopen` — is wired synchronously,
  // before the handshake's first `await`.
  const dc = liveChannel as FakeChannel;
  dc.readyState = 'open';
  dc.onopen?.();

  return { connection: await pending, dc };
}

/** Every `response.create` this browser sent, in order. */
function responseCreates(dc: FakeChannel) {
  return dc.sent.filter((sent) => sent.type === 'response.create');
}

describe('one relayed call is one response.create', () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    liveChannel = null;
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response('v=0\r\nfake-answer', {
          status: 200,
          headers: { 'Content-Type': 'application/sdp' },
        }),
    ) as typeof globalThis.fetch;
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      LivePeerConnection;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    Reflect.deleteProperty(
      globalThis as unknown as Record<string, unknown>,
      'RTCPeerConnection',
    );
  });

  it('answers a doubly-announced call with ONE item and ONE response.create', async () => {
    const h = handlers();
    let connection: Awaited<ReturnType<typeof openLive>>['connection'] | null = null;
    const record = h.onToolCall;
    h.onToolCall = (call) => {
      record(call);
      // Exactly what both hooks do with a relayed call.
      connection?.sendToolResult(call.callId, { status: 'ok', tool: call.name });
    };

    const live = await openLive(h);
    connection = live.connection;

    // ONE function call, announced the way the current API announces it.
    live.dc.onmessage?.({ data: argumentsDone('call-1') } as MessageEvent);
    live.dc.onmessage?.({ data: outputItemDone('call-1') } as MessageEvent);

    expect(h.toolCalls).toHaveLength(1);

    const items = live.dc.sent.filter(
      (sent) => sent.type === 'conversation.item.create',
    );
    expect(items).toHaveLength(1);

    // THE LINE #385 IS ABOUT. A second `response.create` lands while the first
    // response is still active, the provider rejects it, and the turn goes
    // silent — which is what a learner experienced as "it did not read the
    // question aloud".
    expect(responseCreates(live.dc)).toHaveLength(1);
  });

  it('nudges a turn that produced nothing at all, exactly once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const h = handlers();
    const live = await openLive(h);
    live.connection.sendToolResult('call-1', { status: 'ok' });
    expect(responseCreates(live.dc)).toHaveLength(1);

    // Nothing came back: no response, no audio, no transcript, no further tool
    // call. That is a dead turn, and there is nothing running to talk over.
    vi.advanceTimersByTime(REALTIME_STALL_NUDGE_MS + 1);
    expect(responseCreates(live.dc)).toHaveLength(2);

    // AND ONLY ONCE. A loop here would spend a learner's own key poking a
    // connection that is not answering.
    vi.advanceTimersByTime(REALTIME_STALL_NUDGE_MS * 5);
    expect(responseCreates(live.dc)).toHaveLength(2);
  });

  it('never nudges when the model has begun a response — no double-speak', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const h = handlers();
    const live = await openLive(h);
    live.connection.sendToolResult('call-1', { status: 'ok' });

    // The provider acknowledged the request and the coach is about to talk.
    live.dc.onmessage?.({
      data: frame({ type: 'response.created' }),
    } as MessageEvent);

    vi.advanceTimersByTime(REALTIME_STALL_NUDGE_MS * 5);
    expect(responseCreates(live.dc)).toHaveLength(1);
  });

  it('does not nudge after the connection has been closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const h = handlers();
    const live = await openLive(h);
    live.connection.sendToolResult('call-1', { status: 'ok' });
    live.connection.close();

    vi.advanceTimersByTime(REALTIME_STALL_NUDGE_MS * 5);
    expect(responseCreates(live.dc)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Issue #399: a response.create is queued, never dropped, while one is active
  // ---------------------------------------------------------------------------
  //
  // The harness gap the implementer flagged: none of the tests above ever
  // deliver `response.done`, so none of them ever leave a response "active"
  // long enough for a second `response.create` to have anywhere to queue.
  // Every test below drives the full `response.created` → `response.done`
  // lifecycle explicitly, on the same `FakeChannel`/`LivePeerConnection`
  // harness this describe block already sets up — no second harness.
  describe('the response queue (#399)', () => {
    /** The provider announces that a response has begun. */
    function responseCreated(dc: FakeChannel) {
      dc.onmessage?.({
        data: frame({ type: 'response.created' }),
      } as MessageEvent);
    }

    /** The provider announces that the active response is over. */
    function responseDone(dc: FakeChannel) {
      dc.onmessage?.({ data: frame({ type: 'response.done' }) } as MessageEvent);
    }

    it('queues the SECOND line of a multi-line speakVerbatim opening, and releases it on response.done', async () => {
      // THE HIGHEST-VALUE CASE (per the issue): the opening turn speaks each
      // of the engine's `say` lines as its own `response.create`. Before this
      // fix, the second line's `response.create` was sent immediately, landed
      // on top of the first (still active) response, and the provider
      // rejected it — the second line of code-owned copy was silently lost
      // before the learner had said a word.
      const h = handlers();
      const live = await openLive(h);

      live.connection.speakVerbatim('Welcome to your practice session.');
      expect(responseCreates(live.dc)).toHaveLength(1);

      // The provider begins responding to the first line.
      responseCreated(live.dc);

      live.connection.speakVerbatim('Here is your first question.');
      // NOT SENT YET — a response is active, so the second line waits.
      expect(responseCreates(live.dc)).toHaveLength(1);

      // The first line finishes.
      responseDone(live.dc);

      expect(responseCreates(live.dc)).toHaveLength(2);
      const second = responseCreates(live.dc)[1] as {
        response?: { instructions?: string };
      };
      expect(second.response?.instructions).toContain(
        'Here is your first question.',
      );
    });

    it('queues a tool result’s response.create while one is active, and sends it once response.done arrives', async () => {
      // The ordinary case #399 names: a function call arrives INSIDE a
      // response, so the tool result answering it is almost always sent
      // while that very response is still running.
      const h = handlers();
      const live = await openLive(h);

      live.connection.sendToolResult('call-1', { status: 'ok' });
      expect(responseCreates(live.dc)).toHaveLength(1);

      responseCreated(live.dc);

      live.connection.sendToolResult('call-2', { status: 'ok' });
      // NOT SENT YET — this is the assertion that means "no
      // conversation_already_has_active_response, and no silence".
      expect(responseCreates(live.dc)).toHaveLength(1);

      responseDone(live.dc);
      expect(responseCreates(live.dc)).toHaveLength(2);
    });

    it('releases only ONE queued response.create per response.done, never both at once', async () => {
      const h = handlers();
      const live = await openLive(h);

      live.connection.speakVerbatim('Line one.');
      responseCreated(live.dc);
      live.connection.speakVerbatim('Line two.');
      live.connection.speakVerbatim('Line three.');
      expect(responseCreates(live.dc)).toHaveLength(1);

      // The first response ends — releasing exactly the NEXT one, which then
      // becomes the new "active" response, so the third stays queued.
      responseDone(live.dc);
      expect(responseCreates(live.dc)).toHaveLength(2);

      responseCreated(live.dc);
      expect(responseCreates(live.dc)).toHaveLength(2);

      responseDone(live.dc);
      expect(responseCreates(live.dc)).toHaveLength(3);
    });

    it('force-releases a queued response.create after REALTIME_RESPONSE_DEFER_MS when response.done never arrives', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const h = handlers();
      const live = await openLive(h);

      live.connection.speakVerbatim('Line one.');
      responseCreated(live.dc);
      live.connection.speakVerbatim('Line two.');
      expect(responseCreates(live.dc)).toHaveLength(1);

      // response.done never arrives — a dropped event, a shape a later API
      // version stops emitting. Sending late is recoverable; waiting forever
      // is a live, per-minute-billing connection in which the coach never
      // speaks again.
      vi.advanceTimersByTime(REALTIME_RESPONSE_DEFER_MS - 1);
      expect(responseCreates(live.dc)).toHaveLength(1);

      vi.advanceTimersByTime(2);
      expect(responseCreates(live.dc)).toHaveLength(2);
    });

    it('empties the queue on teardown, and a response.done arriving after close does not resurrect it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const h = handlers();
      const live = await openLive(h);

      live.connection.speakVerbatim('Line one.');
      responseCreated(live.dc);
      live.connection.speakVerbatim('Line two.');
      expect(responseCreates(live.dc)).toHaveLength(1);

      live.connection.close();

      // Well past the valve. If the queue survived teardown, this would fire.
      vi.advanceTimersByTime(REALTIME_RESPONSE_DEFER_MS * 5);
      expect(responseCreates(live.dc)).toHaveLength(1);

      // A response.done for the closed connection's own last response,
      // arriving late, must not release anything either.
      responseDone(live.dc);
      expect(responseCreates(live.dc)).toHaveLength(1);
    });

    it('sends the FIRST response.create immediately when nothing is active — no needless queueing', async () => {
      const h = handlers();
      const live = await openLive(h);

      live.connection.speakVerbatim('Line one.');
      expect(responseCreates(live.dc)).toHaveLength(1);
    });
  });
});

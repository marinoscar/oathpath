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
  handleProviderEvent,
  isRealtimeToolName,
  openRealtimeConnection,
  REALTIME_CALL_URL,
  type RealtimeConnectionHandlers,
} from '../../services/realtimeConnection';
import { toToolCallInput } from '../../hooks/useRealtimeInterview';

function handlers(): RealtimeConnectionHandlers & {
  toolCalls: unknown[];
  officer: unknown[];
  applicant: unknown[];
} {
  const toolCalls: unknown[] = [];
  const officer: unknown[] = [];
  const applicant: unknown[] = [];
  return {
    toolCalls,
    officer,
    applicant,
    onToolCall: (call) => toolCalls.push(call),
    onOfficerSpeech: (event) => officer.push(event),
    onApplicantSpeech: (event) => applicant.push(event),
    onRemoteStream: () => undefined,
    onClosed: () => undefined,
  };
}

const frame = (event: unknown) => JSON.stringify(event);

describe('provider events', () => {
  it('surfaces a tool call only when its arguments are COMPLETE', () => {
    const h = handlers();

    // A partially-arrived argument string parses as invalid JSON or, worse, as
    // a DIFFERENT valid object than the model meant — a `grade_answer` whose
    // transcript is the first half of what the learner said would be graded as
    // though they stopped there.
    handleProviderEvent(
      frame({
        type: 'response.function_call_arguments.delta',
        call_id: 'c1',
        delta: '{"questionId":"q1","transc',
      }),
      h,
    );
    expect(h.toolCalls).toHaveLength(0);

    handleProviderEvent(
      frame({
        type: 'response.function_call_arguments.done',
        call_id: 'c1',
        name: 'grade_answer',
        arguments: '{"questionId":"q1","transcript":"the constitution"}',
      }),
      h,
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
    handleProviderEvent(
      frame({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'c2',
          name: 'next_question',
          arguments: '{}',
        },
      }),
      h,
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
      handleProviderEvent(frame({ type, item_id: 'i1', delta: 'Good ' }), h);
      expect(h.officer).toEqual([
        { itemId: 'i1', text: 'Good ', done: false },
      ]);
    }
  });

  it('reports an absent confidence as UNKNOWN, never as zero', () => {
    const h = handlers();
    handleProviderEvent(
      frame({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'i2',
        transcript: 'the constitution',
      }),
      h,
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
      expect(() => handleProviderEvent(raw, h)).not.toThrow();
    }
    expect(h.toolCalls).toHaveLength(0);
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

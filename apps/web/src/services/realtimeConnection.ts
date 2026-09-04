/**
 * The browser's own realtime connection to the AI provider — issue #159,
 * epic #60 / E11.
 *
 * =============================================================================
 * THE API IS NOT IN THIS CONNECTION'S DATA PATH, AND THAT IS THE DESIGN
 * =============================================================================
 *
 * Audio goes browser ↔ provider directly, over WebRTC, on an ephemeral secret
 * this application minted server-side. `docs/specs/realtime-interview.md` §13
 * rejects proxying it through our own API by name: a relay hop lands directly
 * on the barge-in latency §11's checklist measures, and it would mean this
 * process's memory briefly holds a learner's raw voice — the exact liability
 * `voice.md` §4 rules out for a stored buffer, reintroduced as a transient one.
 *
 * What DOES go through the API is every decision: the three tool calls this
 * module surfaces to its caller are relayed to
 * `POST /api/interviews/:id/realtime/tool-calls`, and the engine's answer comes
 * back down the same data channel. This module transports; it decides nothing.
 *
 * =============================================================================
 * THE ONLY CREDENTIAL IN THIS FILE IS THE EPHEMERAL SECRET
 * =============================================================================
 *
 * `clientSecret` is minted per session, expires in about a minute, and is
 * scoped to one interview's own instructions and tools. It is used once, on the
 * handshake below, and is never written to `localStorage`, `sessionStorage`, a
 * cookie, or a module-level variable that outlives the connection.
 *
 * THE LEARNER'S OWN API KEY IS NOT HERE AND CANNOT BE. It does not leave the
 * API process on any code path (`docs/specs/ai-settings.md` §4.2), there is no
 * endpoint that returns it, and nothing in this module reads a store. §12's
 * second locked decision states the cost of the alternative: a long-lived key
 * visible to browser JavaScript is visible in the network tab and in browser
 * history, and it keeps working until a human revokes it.
 *
 * =============================================================================
 * FULL DUPLEX. THERE IS NO PUSH-TO-TALK GATE AND THERE MUST NEVER BE ONE.
 * =============================================================================
 *
 * The microphone track is added to the peer connection once, at handshake time,
 * and stays enabled until the session ends. Nothing in this module disables a
 * track, replaces it with a null track, or exposes a mute — because every one
 * of those is a half-duplex design wearing a different name, and issue #60
 * states what a half-duplex rehearsal costs: "the user should feel like they
 * are speaking with a patient human coach, not operating a voice command
 * interface." An officer who cannot be interrupted mid-sentence rehearses
 * nothing like the real event, where an applicant who mishears says so
 * immediately and the officer stops.
 *
 * {@link TURN_DETECTION} is the other half of that, and it is the ONLY thing
 * this module ever sends in a `session.update` — see its own comment.
 */

import type { RealtimeToolName } from '../types';

/**
 * Where the browser opens its realtime call.
 *
 * OpenAI's WebRTC entry point: an SDP offer in, an SDP answer out,
 * authenticated with the ephemeral secret. The model is named on the query
 * string because the secret was minted against exactly one model and the
 * handshake has to agree with the mint — which is why `modelId` comes back on
 * the mint response rather than being re-derived from the settings row on this
 * side, where it could be stale.
 *
 * ONE PROVIDER IS SPELLED HERE, and that is honest rather than tidy:
 * `AI_PROVIDER_KINDS` is `['openai']`, this URL is not a value any endpoint
 * returns, and a second provider would need its own handshake shape anyway —
 * not merely its own host. A deployment that reaches this URL also needs it in
 * the CSP's `connect-src` (`infra/nginx/csp.conf`).
 */
export const REALTIME_CALL_URL = 'https://api.openai.com/v1/realtime/calls';

/**
 * The data channel the provider delivers its events on. Its name is part of
 * the provider's protocol, not a choice.
 */
const EVENT_CHANNEL = 'oai-events';

/**
 * Turn detection, and the ONLY session field this client ever sets.
 *
 * `interrupt_response: true` is what makes barge-in work in the direction that
 * matters most: the learner speaking over the officer stops the officer's audio
 * rather than being talked through. `create_response: true` lets the officer
 * take its turn when the learner stops, so a nervous pause is not a dead
 * conversation waiting on a button nobody was given.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS OBJECT IS A CONSTANT AND WHY IT CONTAINS ONLY AUDIO FIELDS
 * -----------------------------------------------------------------------------
 *
 * `session.update` can, on the provider's own protocol, replace a session's
 * `instructions` and `tools`. Both were decided server-side at mint time from
 * this interview's state, and both are the mechanism by which the model has no
 * field to invent a question or report a verdict in
 * (`realtime-tools.ts`'s header). A client that sent either would be handing
 * the model back the authority the whole epic exists to take away from it — and
 * it would do so silently, because a session whose tools were widened still
 * behaves normally right up until the model uses the widened one.
 *
 * So the payload is a frozen constant with no interpolation and no caller
 * input, and a test asserts that what goes on the wire names neither
 * `instructions` nor `tools`.
 */
const TURN_DETECTION = Object.freeze({
  type: 'semantic_vad' as const,
  interrupt_response: true,
  create_response: true,
});

/** One function call the model emitted, as the relay receives it. */
export interface RealtimeToolCallEvent {
  /** The provider's own id for this call. The tool result must name it back. */
  callId: string;
  /** Which tool. Narrowed by the caller against the three the contract declares. */
  name: string;
  /** The arguments, already parsed. `{}` when the model sent none. */
  args: Record<string, unknown>;
}

/** One party's words, as the provider transcribes them. */
export interface RealtimeSpeechEvent {
  /** The provider's item id — stable across the deltas of one utterance. */
  itemId: string;
  /** The text so far, or the whole utterance when `done`. */
  text: string;
  /** True on the last event for this item. */
  done: boolean;
  /**
   * The recogniser's own confidence, when it reported one.
   *
   * ABSENT MEANS UNKNOWN, NEVER LOW. It feeds the identical
   * `ASR_CONFIDENCE_THRESHOLD` comparison the request/response voice path uses,
   * server-side; defaulting it here would turn every interview on a provider
   * that reports no confidence into one where every answer reads as misheard.
   */
  confidence?: number;
}

/** Why the connection ended. */
export type RealtimeCloseReason =
  /** {@link RealtimeConnection.close} was called. Nothing went wrong. */
  | 'closed'
  /** The peer connection failed or the channel went away mid-session. */
  | 'dropped';

export interface RealtimeConnectionHandlers {
  /** The model wants a tool call relayed. The engine answers it, never this. */
  onToolCall: (call: RealtimeToolCallEvent) => void;
  /** The officer's spoken words, as text. */
  onOfficerSpeech: (event: RealtimeSpeechEvent) => void;
  /** The applicant's spoken words, as the provider heard them. */
  onApplicantSpeech: (event: RealtimeSpeechEvent) => void;
  /** The officer's voice. Attach it to an audio element and play it. */
  onRemoteStream: (stream: MediaStream) => void;
  /** The connection ended. Fired at most once. */
  onClosed: (reason: RealtimeCloseReason) => void;
}

export interface OpenRealtimeConnectionOptions {
  /** The ephemeral secret from the mint. Used once, stored nowhere. */
  clientSecret: string;
  /** The model the secret was minted against. */
  modelId: string;
  /** The learner's live microphone. Its tracks stay enabled for the session. */
  stream: MediaStream;
  handlers: RealtimeConnectionHandlers;
  /** Abort the handshake. A learner who leaves mid-handshake is not waiting. */
  signal?: AbortSignal;
}

export interface RealtimeConnection {
  /**
   * Hand the engine's answer to one tool call back to the model.
   *
   * `result` is forwarded VERBATIM and is never inspected here — including a
   * `rejected` result, whose `instruction` field is the thing that gets the
   * interview moving again.
   */
  sendToolResult: (callId: string, result: unknown) => void;

  /**
   * Have the officer say one line, word for word.
   *
   * FOR THE LINES NO TOOL RESULT CAN CARRY, of which there are exactly two.
   *
   * The OPENING TURN, which `POST /api/interviews` already returned and which
   * the tool-call route therefore never serves — #158 flagged this explicitly.
   * Without it the interview opens in silence while the model, told to say what
   * `next_question` returns, waits for a result the engine has no reason to
   * produce.
   *
   * And the acknowledgement for a TYPED writing answer, which the model never
   * heard and so never reported: the engine graded it, and this is how the
   * officer finds out the interview moved.
   */
  speakVerbatim: (text: string) => void;

  /**
   * End the session and STOP EVERY MEDIA TRACK — the microphone's included.
   *
   * Idempotent. Stopping the tracks is not resource hygiene: while a track is
   * live the browser shows its own recording indicator and the operating system
   * shows a microphone light, and a learner who has ended a rehearsal of a
   * stressful conversation and can still see that light has been told, by their
   * own machine, that this app is still listening. `useAudioCapture`'s header
   * makes the same point for push-to-talk; it is more acute here, where the
   * microphone has been open for twenty minutes.
   */
  close: () => void;
}

/**
 * Open the realtime connection, or reject.
 *
 * REJECTS RATHER THAN RETURNING A FAILURE STATE, unlike almost everything else
 * in this codebase's AI surfaces, and the difference is deliberate: an
 * `unavailable` mint is a typed product state a screen renders, whereas a
 * handshake that did not complete has no partial result to render — there is
 * either a connection or there is not. The caller's recovery is §7's, and it is
 * the same one for every transport failure: the text interview, same interview
 * id, no loss of progress.
 */
export async function openRealtimeConnection(
  options: OpenRealtimeConnectionOptions,
): Promise<RealtimeConnection> {
  const { clientSecret, modelId, stream, handlers, signal } = options;

  if (typeof RTCPeerConnection === 'undefined') {
    throw new Error('This browser cannot open a live voice connection.');
  }

  const pc = new RTCPeerConnection();
  let closed = false;

  /**
   * Has the handshake finished?
   *
   * UNTIL IT HAS, A TEARDOWN REPORTS NOTHING. A handshake that fails already
   * tells its caller by rejecting, and firing `onClosed` as well would have the
   * caller handling one failure twice — once as "the connection dropped, re-mint
   * and resume" and once as "it never opened, fall back" — which is a reconnect
   * attempt racing a fallback for the same event.
   */
  let handshakeDone = false;

  /**
   * Tear everything down exactly once.
   *
   * `reason` reaches the caller only on the FIRST call, so a drop that also
   * closes the channel and the peer connection is reported once rather than
   * three times — and a learner is moved to the text interview once rather
   * than three times.
   */
  const teardown = (reason: RealtimeCloseReason) => {
    if (closed) return;
    closed = true;

    // The tracks first, and before any awaiting: the microphone light goes out
    // when the session ends, not when a promise settles. See `close`.
    for (const track of stream.getTracks()) track.stop();
    for (const receiver of safeReceivers(pc)) receiver.track?.stop();

    try {
      pc.close();
    } catch {
      // Already closed. Nothing to do and nothing to tell anybody.
    }

    if (handshakeDone) handlers.onClosed(reason);
  };

  pc.ontrack = (event) => {
    const remote = event.streams[0];
    if (remote) handlers.onRemoteStream(remote);
  };

  pc.onconnectionstatechange = () => {
    // `disconnected` is deliberately NOT in this list: it is a transient state
    // an ordinary network blip enters and recovers from, and tearing a live
    // interview down on one would move a learner to the text transport for a
    // hiccup they never noticed. `failed` is the terminal one.
    if (pc.connectionState === 'failed') teardown('dropped');
  };

  // THE MICROPHONE, ADDED ONCE AND LEFT ALONE. See the file header — there is
  // no gate, no mute, and nothing that disables this track before `close`.
  for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

  const channel = pc.createDataChannel(EVENT_CHANNEL);
  const send = (payload: unknown) => {
    if (channel.readyState !== 'open') return;
    channel.send(JSON.stringify(payload));
  };

  channel.onmessage = (event: MessageEvent) => {
    handleProviderEvent(event.data, handlers);
  };
  channel.onclose = () => teardown('dropped');
  channel.onerror = () => teardown('dropped');

  const opened = new Promise<void>((resolve, reject) => {
    channel.onopen = () => resolve();
    signal?.addEventListener('abort', () =>
      reject(new DOMException('Aborted', 'AbortError')),
    );
  });

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // NO `credentials: 'include'`. This request goes to the provider, not to
    // our API, and sending this application's session cookie to a third party
    // would be a cookie leak in exchange for nothing — the ephemeral secret is
    // the whole authentication of this call.
    const response = await fetch(
      `${REALTIME_CALL_URL}?model=${encodeURIComponent(modelId)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp ?? '',
        signal,
      },
    );

    if (!response.ok) {
      // The provider's body is not shown to a learner: an expired secret and a
      // revoked key produce different prose neither of which they can act on,
      // and §7's answer to both is the same — the text interview.
      throw new Error(
        `The voice connection could not be opened (${response.status}).`,
      );
    }

    await pc.setRemoteDescription({
      type: 'answer',
      sdp: await response.text(),
    });

    await opened;
  } catch (error) {
    teardown('dropped');
    throw error;
  }

  handshakeDone = true;

  // BARGE-IN, ENABLED THE MOMENT THE CHANNEL IS OPEN. Audio fields only — see
  // `TURN_DETECTION` for why this payload may never grow an `instructions` or
  // a `tools` key.
  send({
    type: 'session.update',
    session: { audio: { input: { turn_detection: TURN_DETECTION } } },
  });

  return {
    sendToolResult: (callId, result) => {
      send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          // Stringified because the provider's protocol carries a tool result
          // as a string. The object is passed through untouched — this relay
          // does not reshape, summarise or filter what the engine decided.
          output: JSON.stringify(result),
        },
      });
      // The model has the result; ask it to take its turn with it. Without
      // this the officer holds the answer and says nothing.
      send({ type: 'response.create' });
    },

    speakVerbatim: (text) => {
      send({
        type: 'response.create',
        response: {
          // VERBATIM, and said as an instruction rather than as a conversation
          // item, because an item added to the transcript is context the model
          // paraphrases from — and this line is code-owned copy the officer is
          // supposed to deliver as written.
          instructions:
            'Say this to the applicant now, word for word, and say nothing ' +
            `else:\n\n${text}`,
        },
      });
    },

    close: () => teardown('closed'),
  };
}

/**
 * Every receiver on a peer connection, or none.
 *
 * Guarded because `getReceivers` is absent on the minimal `RTCPeerConnection`
 * stubs a unit test supplies, and a teardown that threw there would leave the
 * microphone running in exactly the test that asserts it does not.
 */
function safeReceivers(pc: RTCPeerConnection): RTCRtpReceiver[] {
  return typeof pc.getReceivers === 'function' ? pc.getReceivers() : [];
}

/**
 * Turn one provider event into a call on the handlers.
 *
 * -----------------------------------------------------------------------------
 * TWO SPELLINGS ARE ACCEPTED FOR THE SAME EVENT, DELIBERATELY
 * -----------------------------------------------------------------------------
 *
 * The realtime API renamed several of its output events between preview and
 * GA (`response.audio_transcript.delta` → `response.output_audio_transcript.delta`),
 * and which spelling a deployment sees depends on the model an administrator
 * bound rather than on this bundle. Accepting both costs one `||` per event;
 * accepting one costs a live transcript that is silently empty on half the
 * models the settings page offers, with nothing on screen to say why.
 *
 * ANYTHING UNRECOGNISED IS IGNORED. A realtime session emits dozens of event
 * types this screen has no use for, and throwing on one would end an interview
 * over a message that was never addressed to us.
 */
export function handleProviderEvent(
  raw: unknown,
  handlers: RealtimeConnectionHandlers,
): void {
  if (typeof raw !== 'string') return;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const type = typeof event.type === 'string' ? event.type : '';

  // ---- The model asked for a tool -----------------------------------------
  //
  // Only the `.done` event, never the deltas: a partially-arrived argument
  // string parses as invalid JSON or, worse, as a DIFFERENT valid object than
  // the model meant — a `grade_answer` whose transcript is the first half of
  // what the learner said would be graded as though they stopped there.
  if (type === 'response.function_call_arguments.done') {
    const callId = stringField(event, 'call_id');
    const name = stringField(event, 'name');
    if (!callId) return;
    handlers.onToolCall({
      callId,
      name,
      args: parseArguments(event.arguments),
    });
    return;
  }

  // The same call, on the shape some model versions emit instead.
  if (type === 'response.output_item.done') {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item || item.type !== 'function_call') return;
    const callId = stringField(item, 'call_id');
    if (!callId) return;
    handlers.onToolCall({
      callId,
      name: stringField(item, 'name'),
      args: parseArguments(item.arguments),
    });
    return;
  }

  // ---- The officer's own words --------------------------------------------
  if (
    type === 'response.output_audio_transcript.delta' ||
    type === 'response.audio_transcript.delta'
  ) {
    handlers.onOfficerSpeech({
      itemId: stringField(event, 'item_id'),
      text: stringField(event, 'delta'),
      done: false,
    });
    return;
  }

  if (
    type === 'response.output_audio_transcript.done' ||
    type === 'response.audio_transcript.done'
  ) {
    handlers.onOfficerSpeech({
      itemId: stringField(event, 'item_id'),
      text: stringField(event, 'transcript'),
      done: true,
    });
    return;
  }

  // ---- The applicant's own words ------------------------------------------
  //
  // The provider's transcription of the learner's audio, which is also what a
  // `grade_answer` call reports. Rendered so the learner can see they were
  // heard — never so this screen can decide anything about it.
  if (type === 'conversation.item.input_audio_transcription.delta') {
    handlers.onApplicantSpeech({
      itemId: stringField(event, 'item_id'),
      text: stringField(event, 'delta'),
      done: false,
    });
    return;
  }

  if (type === 'conversation.item.input_audio_transcription.completed') {
    handlers.onApplicantSpeech({
      itemId: stringField(event, 'item_id'),
      text: stringField(event, 'transcript'),
      done: true,
      confidence: numberField(event, 'confidence'),
    });
  }
}

/** One string field, or `''`. Never `undefined` leaking into rendered text. */
function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

/**
 * One number field, or `undefined`.
 *
 * `undefined` rather than 0, and the distinction is the whole of
 * `voice.md` §3: absent means the recogniser reported no confidence, and a 0
 * would be a confident claim that it was certain it heard nothing.
 */
function numberField(
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = source[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * A tool call's arguments, as an object.
 *
 * `{}` for anything unparseable, which is the right answer for the one tool
 * that genuinely takes none (`next_question`) and is caught by the API's own
 * validation for the two that do — a `grade_answer` posted with no
 * `questionId` is a 400 naming the field, which is a great deal more useful
 * than this function guessing one.
 */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Is this one of the three tools the contract declares?
 *
 * A NARROWING GUARD RATHER THAN A CAST, so a model that invents a fourth tool
 * name is refused here instead of being posted to the relay route and refused
 * there as a 400 — which would cost a round trip and put an unexplained error
 * in the API's logs for something the browser could see was wrong.
 */
export function isRealtimeToolName(name: string): name is RealtimeToolName {
  return (
    name === 'next_question' || name === 'grade_answer' || name === 'end_phase'
  );
}

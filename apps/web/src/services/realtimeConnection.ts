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

/**
 * One error the provider reported over the data channel.
 *
 * A REPORT, NEVER A TEARDOWN. The provider raises `error` for things that end
 * a session (an expired secret) and for things that end a single TURN
 * (`conversation_already_has_active_response`, issue #385's own symptom), and
 * the difference is not legible from the payload — so this module hands the
 * whole thing to its caller and closes nothing. Dropping them, which is what
 * this file did until #385, is how a turn goes silent with nothing on screen
 * and nothing in the console to say why.
 */
export interface RealtimeProviderError {
  /** The provider's own machine-readable code, or `''` when it sent none. */
  code: string;
  /**
   * The provider's own prose, FOR A DEVELOPER.
   *
   * Never rendered to a learner verbatim, for the same reason the handshake's
   * failure body is not: an expired secret and a rejected response produce
   * different sentences neither of which a learner can act on.
   */
  message: string;
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
  /**
   * The provider reported an error. The connection is still open.
   *
   * REQUIRED, deliberately: an optional handler is one a caller can forget,
   * and the failure mode of forgetting is exactly the one #385 recorded — a
   * rejected `response.create`, a coach that says nothing for fifteen seconds,
   * and a screen still reading "Listening". A missing implementation is a
   * compile error instead.
   */
  onProviderError: (error: RealtimeProviderError) => void;
  /** The connection ended. Fired at most once. */
  onClosed: (reason: RealtimeCloseReason) => void;
}

/**
 * How many call ids one connection remembers having relayed.
 *
 * BOUNDED because a session runs for as long as a learner keeps talking, and
 * an unbounded set is a leak that grows with the length of exactly the sessions
 * we most want to survive. The bound is safe because the duplicate this exists
 * to catch is ADJACENT: the two event shapes that announce one function call
 * arrive milliseconds apart, in the same response, with nothing between them.
 * Sixty-four is therefore dozens of turns of slack over a window that only ever
 * needs to be one, and the only way an evicted id could be relayed twice is a
 * provider re-announcing a call id it first used sixty-four distinct calls ago
 * — which its own protocol, where a call id names one call, does not do.
 */
export const TOOL_CALL_MEMORY = 64;

/**
 * How long the model may sit on a tool result before it is nudged once.
 *
 * See {@link RealtimeConnection.sendToolResult}. Long enough that an ordinary
 * think-and-speak is never interrupted; short enough that #385's measured
 * 15-17 second dead turns cannot happen in silence.
 */
export const REALTIME_STALL_NUDGE_MS = 6_000;

/**
 * How long a deferred `response.create` waits for the in-flight response to
 * finish before it is sent anyway.
 *
 * ISSUE #399, AND IT IS A SAFETY VALVE RATHER THAN A TUNING KNOB. The queue
 * below waits for `response.done`, which is the provider's own statement that
 * the active response is over. A response we were told STARTED and are never
 * told FINISHED about — a dropped event, a shape a later API version stops
 * emitting — would otherwise park every subsequent tool result forever, which
 * is precisely the silent-coach failure the queue exists to prevent, arrived
 * at from the other direction.
 *
 * SENDING LATE IS RECOVERABLE; WAITING FOREVER IS NOT. The worst case of
 * releasing early is one more `conversation_already_has_active_response`, which
 * this module now reports and the practice hook now clears on the next
 * honoured result. The worst case of waiting is a live, per-minute-billing
 * connection in which the coach never speaks again.
 *
 * Longer than {@link REALTIME_STALL_NUDGE_MS} on purpose: an ordinary spoken
 * response is seconds, so this only ever fires on a turn that has already gone
 * wrong.
 */
export const REALTIME_RESPONSE_DEFER_MS = 10_000;

/**
 * One connection's memory of its own turns.
 *
 * THREE FACTS, ONE OWNER, because all three are per-connection and all three
 * are read by {@link handleProviderEvent}, which is otherwise stateless:
 *
 *  1. **Which call ids have already been relayed.** The current Realtime API
 *     announces one function call with BOTH `response.function_call_arguments.done`
 *     AND `response.output_item.done`, and older model versions emit only one
 *     of the two — so both shapes must be accepted and only one of them may
 *     reach `onToolCall`. Issue #385: without this, every tool call was posted
 *     to the API twice and answered with two `response.create`s, the second of
 *     which the provider rejects with `conversation_already_has_active_response`
 *     — and the turn goes silent.
 *  2. **How many times the model has been observed producing something**, which
 *     is the only signal the stall nudge below trusts. A counter rather than a
 *     boolean, so a watcher can ask "has anything happened SINCE this moment"
 *     without owning a flag somebody has to reset.
 *  3. **Whether a response is in flight right now.** Issue #399. There are
 *     three independent senders of `response.create` on this connection — the
 *     PROVIDER's own, via `TURN_DETECTION`'s `create_response`, which fires
 *     when the learner stops speaking; a tool result's, which fires when the
 *     engine has answered; and the stall nudge's. All three are legitimate and
 *     none may be removed, but a second one landing while a response is active
 *     is rejected with `conversation_already_has_active_response` — and the
 *     turn that was supposed to read the question aloud produces silence.
 *     Knowing whether one is active is what lets a sender WAIT instead of
 *     being refused, and it has to live here because
 *     {@link handleProviderEvent} is the only thing that sees
 *     `response.created` and `response.done`.
 */
export interface RealtimeTurnTracker {
  /**
   * Claim one call id. `true` the FIRST time it is seen, `false` ever after.
   *
   * The name is "claim" rather than "has" because asking and recording must be
   * one step: two callers that checked and then recorded could both be told
   * they were first.
   */
  claimToolCall: (callId: string) => boolean;
  /** The model is producing something — a response, audio, or a transcript. */
  noteModelActivity: () => void;
  /** How many activity signals this connection has seen. Monotonic. */
  activityCount: () => number;

  /** A response has started (`response.created`). Idempotent. */
  beginResponse: () => void;
  /**
   * The in-flight response has finished (`response.done`).
   *
   * Runs every {@link onResponseIdle} listener, ONCE PER TRANSITION: a
   * `response.done` for a response nobody saw start must not release a queue
   * that is waiting on a different one.
   */
  endResponse: () => void;
  /** Is a response in flight? Nothing may send `response.create` while it is. */
  isResponseActive: () => boolean;
  /**
   * Run this when the connection goes from busy to idle.
   *
   * A LISTENER RATHER THAN A POLL, because the release has to happen on the
   * transition itself: draining a queue on "any event where nothing is active"
   * would send a second `response.create` in the window after the first went
   * out and before the provider's `response.created` came back, which is the
   * same collision one layer along.
   */
  onResponseIdle: (listener: () => void) => void;
}

export function createRealtimeTurnTracker(
  memory: number = TOOL_CALL_MEMORY,
): RealtimeTurnTracker {
  // Insertion-ordered by specification, which is what makes eviction of the
  // OLDEST id a `values().next()` rather than a second data structure.
  const seen = new Set<string>();
  let activity = 0;
  let responseActive = false;
  const idleListeners: (() => void)[] = [];

  return {
    beginResponse: () => {
      responseActive = true;
    },
    endResponse: () => {
      if (!responseActive) return;
      responseActive = false;
      for (const listener of idleListeners) listener();
    },
    isResponseActive: () => responseActive,
    onResponseIdle: (listener) => {
      idleListeners.push(listener);
    },
    claimToolCall: (callId) => {
      if (seen.has(callId)) return false;
      seen.add(callId);
      if (seen.size > memory) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
    noteModelActivity: () => {
      activity += 1;
    },
    activityCount: () => activity,
  };
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
   * This connection's own memory of its turns. See {@link RealtimeTurnTracker}.
   *
   * OWNED HERE, so the de-duplication cannot be bypassed by a future third
   * event shape: `handleProviderEvent` takes the tracker as a required
   * argument and every branch that produces a tool call goes through the one
   * `relayToolCall` helper inside it.
   */
  const turns = createRealtimeTurnTracker();

  /** The one pending stall check. See {@link watchForStall}. */
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const clearStallTimer = () => {
    if (stallTimer === null) return;
    clearTimeout(stallTimer);
    stallTimer = null;
  };

  /**
   * Nudge the model ONCE if handing it a tool result produced nothing at all.
   *
   * -------------------------------------------------------------------------
   * WHY THIS CANNOT DOUBLE-SPEAK
   * -------------------------------------------------------------------------
   *
   * It fires only when the connection has observed NO model activity of any
   * kind since the tool result went out — no `response.created`, no audio
   * buffer starting, no audio delta, no transcript delta, and no further tool
   * call (see `MODEL_ACTIVITY_EVENTS` and the tool-call branch). Every one of
   * those precedes a spoken word, so "the coach is about to talk" and "the
   * coach is talking" both cancel it; what is left is a turn in which the model
   * was handed an answer and did not begin a response, which is not a turn that
   * can be interrupted because there is nothing running to interrupt.
   *
   * It is also bounded to ONE attempt: the timer is cleared and re-armed by the
   * next tool result, so a genuinely dead connection is nudged once and then
   * left to `onClosed` and the caller's own idle bound rather than being poked
   * on a loop that spends a learner's key.
   */
  const watchForStall = () => {
    clearStallTimer();
    const activityBefore = turns.activityCount();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (closed) return;
      if (turns.activityCount() !== activityBefore) return;
      // THROUGH THE ONE DOOR (#399), like every other `response.create` here.
      // In practice this always sends immediately — an active response is
      // activity, and activity cancels the nudge above — but a third sender
      // that could bypass the queue is a third sender that could collide, and
      // "it cannot happen today" is not the same as "it cannot happen".
      requestResponse({ type: 'response.create' }, false);
    }, REALTIME_STALL_NUDGE_MS);
  };

  // ---------------------------------------------------------------------------
  // ONE DOOR FOR `response.create` (issue #399)
  // ---------------------------------------------------------------------------
  //
  // `TURN_DETECTION.create_response` means the PROVIDER creates a response the
  // moment it decides the learner stopped speaking, and a tool result needs an
  // explicit `response.create` of its own or the coach holds the engine's
  // answer and says nothing. Both are needed and neither may be removed; what
  // was missing is that neither checked whether a response was already in
  // flight. The measured cost was `conversation_already_has_active_response` —
  // and it is the ORDINARY case, not a rare race: a function call arrives
  // inside a response, so the tool result answering it is almost always sent
  // while that very response is still running.
  //
  // THE ANSWER IS TO WAIT, NEVER TO DROP. Dropping a rejected
  // `response.create` reintroduces exactly the silent coach that line exists to
  // prevent, so a request that arrives at a busy moment is queued and sent when
  // `response.done` says the connection is idle again.
  //
  // IT CANNOT DOUBLE-FIRE: an entry is removed from the queue before it is
  // dispatched, `dispatchResponse` is the only thing that puts a
  // `response.create` on the wire, and the queue is drained ONE ENTRY PER
  // `response.done` rather than all at once — draining two would put the second
  // on the wire while the first was still starting.
  //
  // IT CANNOT LEAK ACROSS A TEARDOWN: `teardown` empties the queue and cancels
  // the release timer, and every path here returns early once `closed`.

  /** One `response.create` waiting its turn. */
  interface PendingResponse {
    payload: unknown;
    /** Whether dispatching it should arm the stall watch. */
    watch: boolean;
  }

  const pendingResponses: PendingResponse[] = [];

  /** The one pending release. See {@link REALTIME_RESPONSE_DEFER_MS}. */
  let deferTimer: ReturnType<typeof setTimeout> | null = null;

  const clearDeferTimer = () => {
    if (deferTimer === null) return;
    clearTimeout(deferTimer);
    deferTimer = null;
  };

  /** Arm the safety valve, but only while something is actually waiting. */
  const armDeferTimer = () => {
    clearDeferTimer();
    if (pendingResponses.length === 0) return;
    deferTimer = setTimeout(() => {
      deferTimer = null;
      if (closed) return;
      // Forcing the tracker idle rather than sending directly, so the release
      // takes the SAME path a real `response.done` takes and the flag is left
      // in a state later requests can also get out of.
      turns.endResponse();
    }, REALTIME_RESPONSE_DEFER_MS);
  };

  const dispatchResponse = (entry: PendingResponse) => {
    send(entry.payload);
    if (entry.watch) watchForStall();
  };

  /**
   * Ask for a response — now if the connection is idle, later if it is not.
   *
   * The queue is checked as well as the flag: between dispatching an entry and
   * the provider's `response.created` coming back, nothing is "active" yet and
   * a new request that jumped the queue would arrive on top of the one just
   * sent.
   */
  const requestResponse = (payload: unknown, watch: boolean) => {
    if (closed) return;
    if (turns.isResponseActive() || pendingResponses.length > 0) {
      pendingResponses.push({ payload, watch });
      armDeferTimer();
      return;
    }
    dispatchResponse({ payload, watch });
  };

  /** Send the next waiting request, if any. Runs on every busy → idle edge. */
  const releaseNextResponse = () => {
    clearDeferTimer();
    if (closed) {
      pendingResponses.length = 0;
      return;
    }
    const next = pendingResponses.shift();
    if (!next) return;
    dispatchResponse(next);
    // Whatever is still waiting now waits on THIS response — including the
    // valve, which is re-armed against the new wait rather than the old one.
    armDeferTimer();
  };

  turns.onResponseIdle(releaseNextResponse);

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
    clearStallTimer();
    // NOTHING SURVIVES THE TEARDOWN (#399). A queued `response.create` released
    // after the connection ended would be a send on a dead channel at best, and
    // on a re-mint a request belonging to a session that is over.
    clearDeferTimer();
    pendingResponses.length = 0;

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
    handleProviderEvent(event.data, handlers, turns);
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
      //
      // EXACTLY ONE PER CALL ID, which is a property of the DE-DUPLICATION
      // above rather than of this line: one function call relayed once is one
      // result handed back once. Issue #385 measured the alternative — a
      // second `response.create` arriving while the first response is still
      // active is rejected with `conversation_already_has_active_response`,
      // and the turn that was supposed to read the question aloud produces
      // silence.
      //
      // AND EXACTLY ONE AT A TIME (#399): de-duplication makes this the only
      // request for THIS call, but the provider's own turn detection is a
      // separate sender, and a function call arrives inside a response that is
      // still running. `requestResponse` waits for that response rather than
      // being refused by it — the stall watch is armed when the request
      // actually goes out, not when it is queued, so a legitimate wait is never
      // mistaken for a dead turn.
      requestResponse({ type: 'response.create' }, true);
    },

    speakVerbatim: (text) => {
      // THROUGH THE QUEUE TOO (#399), and this one was colliding with ITSELF:
      // the opening turn speaks each of the engine's `say` lines as its own
      // `response.create`, so a two-line opening sent the second while the
      // first was still being spoken and the provider refused it — a line of
      // code-owned copy silently lost before a learner had said a word. Queued,
      // the lines are spoken in order, all of them.
      requestResponse({
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
      }, false);
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
 * The event types that mean THE MODEL IS PRODUCING SOMETHING.
 *
 * The cancel set for {@link REALTIME_STALL_NUDGE_MS}'s nudge, and the reason
 * that nudge cannot talk over a coach who is already speaking. Every member
 * precedes or accompanies audible speech; a tool call counts too and says so at
 * its own branch.
 *
 * `response.done` is DELIBERATELY ABSENT. It is the end of a response, not the
 * start of one, and the response it most often ends is the one that emitted the
 * function call we are about to answer — so counting it would cancel the check
 * for the exact turn the check exists for.
 *
 * Both spellings of the transcript events are here for the same reason they are
 * accepted below: which one a deployment sees depends on the model an
 * administrator bound.
 */
const MODEL_ACTIVITY_EVENTS = new Set([
  'response.created',
  'response.output_item.added',
  'response.content_part.added',
  'output_audio_buffer.started',
  'response.output_audio.delta',
  'response.audio.delta',
  'response.output_audio_transcript.delta',
  'response.audio_transcript.delta',
]);

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
 * -----------------------------------------------------------------------------
 * TWO SHAPES ANNOUNCE ONE TOOL CALL, AND ONLY ONE OF THEM MAY BE RELAYED
 * -----------------------------------------------------------------------------
 *
 * Issue #385. Both `response.function_call_arguments.done` and
 * `response.output_item.done` (with a `function_call` item) are accepted — some
 * model versions emit only one, and dropping either costs a tool call that
 * never arrives on a connection that looks perfectly healthy. The current API
 * emits BOTH, so acceptance without de-duplication cost the opposite: every
 * call posted to the relay route twice, and two `response.create`s for one
 * result, the second of which the provider rejects with
 * `conversation_already_has_active_response` — measured on a device as a
 * 17-second silence with the question on screen and the surface still saying
 * "Listening".
 *
 * `tracker.claimToolCall` is therefore the single choke point every shape goes
 * through, inside `relayToolCall` below. A THIRD spelling added later gets the
 * guard by construction, because building the event object is the only way to
 * reach `onToolCall` and `relayToolCall` is the only thing that builds one.
 *
 * ANYTHING UNRECOGNISED IS IGNORED. A realtime session emits dozens of event
 * types this screen has no use for, and throwing on one would end an interview
 * over a message that was never addressed to us. An `error`, since #385, is NOT
 * one of them — see its branch.
 */
export function handleProviderEvent(
  raw: unknown,
  handlers: RealtimeConnectionHandlers,
  tracker: RealtimeTurnTracker,
): void {
  if (typeof raw !== 'string') return;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const type = typeof event.type === 'string' ? event.type : '';

  if (MODEL_ACTIVITY_EVENTS.has(type)) tracker.noteModelActivity();

  // ---- A response started, and then finished ------------------------------
  //
  // ISSUE #399. The two edges of the one fact every `response.create` sender on
  // this connection has to respect. `response.done` is the provider's own
  // statement that the turn is over, and it arrives for an INTERRUPTED response
  // as well as a completed one — which is what keeps barge-in from parking the
  // queue: a learner talking over the coach ends the coach's response, and the
  // waiting request goes out on that edge like any other.
  if (type === 'response.created') {
    tracker.beginResponse();
    return;
  }

  if (type === 'response.done') {
    tracker.endResponse();
    return;
  }

  // ---- The provider refused something -------------------------------------
  //
  // REPORTED, NEVER SWALLOWED (#385). This branch did not exist, so the
  // rejection that stalled a turn reached nobody: not the learner, who saw a
  // question on screen and heard nothing, and not a developer, who had no line
  // in the console to start from. Nothing is torn down here — most of these
  // end one turn, not one session — and the caller decides what to say.
  if (type === 'error') {
    const detail = (event.error as Record<string, unknown> | undefined) ?? event;
    handlers.onProviderError({
      code: stringField(detail, 'code') || stringField(detail, 'type'),
      message: stringField(detail, 'message'),
    });
    return;
  }

  /**
   * Relay one function call — the ONE door, and the one guard.
   *
   * Every announcement shape ends here, so a call id that has already been
   * relayed is dropped no matter which event carried it. See the header.
   */
  const relayToolCall = (
    callId: string,
    name: string,
    args: unknown,
  ): void => {
    if (!callId) return;
    // The model is producing, whichever shape said so: a tool call cancels the
    // stall nudge exactly as speech does.
    tracker.noteModelActivity();
    if (!tracker.claimToolCall(callId)) return;
    handlers.onToolCall({ callId, name, args: parseArguments(args) });
  };

  // ---- The model asked for a tool -----------------------------------------
  //
  // Only the `.done` event, never the deltas: a partially-arrived argument
  // string parses as invalid JSON or, worse, as a DIFFERENT valid object than
  // the model meant — a `grade_answer` whose transcript is the first half of
  // what the learner said would be graded as though they stopped there.
  if (type === 'response.function_call_arguments.done') {
    relayToolCall(
      stringField(event, 'call_id'),
      stringField(event, 'name'),
      event.arguments,
    );
    return;
  }

  // The same call, on the shape some model versions emit instead — and, on the
  // current API, on the shape it emits AS WELL. Kept rather than deleted: a
  // model version that emits only this one must still be able to call a tool.
  if (type === 'response.output_item.done') {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item || item.type !== 'function_call') return;
    relayToolCall(
      stringField(item, 'call_id'),
      stringField(item, 'name'),
      item.arguments,
    );
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

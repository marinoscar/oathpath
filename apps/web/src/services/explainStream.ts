/**
 * The client half of `POST /api/civics/questions/:id/explain` (issue #125, E4).
 *
 * The endpoint answers with `text/event-stream`, and this file is the one place
 * that knows its frame names and payload shapes. It is to `streamSseRequest`
 * what `notificationStream.ts` is to `connectSse`: the transport is generic,
 * this is the endpoint's own vocabulary, and nothing above it should be reading
 * `frame.data` strings.
 *
 * =============================================================================
 * THE FRAME NAMES ARE THE API'S, NOT GUESSES
 * =============================================================================
 *
 * Read from `apps/api/src/civics/civics-explain.service.ts`
 * (`CivicsExplainFrame`) and the controller's documented wire format:
 *
 *   `: connected`      an opening COMMENT, so the headers flush immediately.
 *                      Never dispatched as a frame — `SseParser` drops it, and
 *                      it is the reason the panel can show "connecting" for a
 *                      real moment rather than for however long the model
 *                      takes to produce its first token.
 *   `delta`            `{ "text": "…" }` — a chunk. Never empty. Any number.
 *   `done`             `{ "usage": {…} }` — TERMINAL. The explanation is whole.
 *   `unavailable`      `{ "cause": … }` — TERMINAL. No call was attempted.
 *   `state_required`   `{ "answerResolution": "state_required" }` — TERMINAL.
 *   `error`            `{ "errorCode": …, "error": … }` — TERMINAL.
 *
 * **Exactly one terminal frame, always last.** That is the API's contract
 * (`CivicsExplainFrame`'s header) and it is what lets a consumer stop waiting:
 * a client that never sees a terminal frame holds a request open forever on a
 * conversation that is over.
 *
 * =============================================================================
 * `usage` IS PARSED AND DROPPED
 * =============================================================================
 *
 * `done` carries the provider's token counts. Nothing on a learner's screen
 * renders them — `ai-settings.md` is emphatic that recorded usage is not a
 * bill, and putting a token count under an explanation would invite exactly
 * that reading. The server has already written the `ai_usage_events` row; the
 * caller's own usage page is where that belongs.
 *
 * =============================================================================
 * AN UNRECOGNISED FRAME IS IGNORED, NOT AN ERROR
 * =============================================================================
 *
 * A newer server talking to an older bundle is not a fault, and neither is a
 * malformed payload: a `delta` whose JSON will not parse contributes no text
 * and the stream carries on to its terminal frame. The alternative — turning a
 * parse failure into a visible error — would replace a whole, readable
 * explanation with a red box because one chunk arrived badly.
 */

import { API_BASE_URL, api } from './api';
import { streamSseRequest } from './sse';
import type { AiUnavailableCause } from '../types';

/** The endpoint, for one question id. */
export function explainUrl(questionId: string): string {
  return `${API_BASE_URL}/civics/questions/${encodeURIComponent(questionId)}/explain`;
}

/**
 * One decoded frame.
 *
 * A DISCRIMINATED UNION rather than `{ event, data }`, for the reason the API's
 * own type gives: the terminal frames have no `text`, so a consumer that
 * appends `frame.text` unconditionally fails to compile instead of appending
 * `undefined` to a learner's explanation.
 */
export type ExplainFrame =
  | { event: 'delta'; text: string }
  | { event: 'done' }
  | { event: 'unavailable'; cause: AiUnavailableCause }
  | { event: 'state_required' }
  | { event: 'error'; errorCode: string; error: string };

/** The four frames after which nothing else arrives. */
export function isTerminalFrame(frame: ExplainFrame): boolean {
  return frame.event !== 'delta';
}

export interface ExplainStreamOptions {
  /** What the learner finds confusing, ≤200 characters. Optional. */
  focus?: string;
  /**
   * Ends the generation. REQUIRED — see `streamSseRequest`: an abandoned
   * stream keeps being billed to the learner's own key.
   */
  signal: AbortSignal;
  /** Headers arrived; the server is answering. */
  onOpen?: () => void;
  /** One decoded frame, in order. */
  onFrame: (frame: ExplainFrame) => void;
}

/**
 * Stream one explanation. Resolves when the stream ends; rejects on transport
 * failure or abort.
 *
 * NO USER ID AND NO STATE CODE IS SENT, and there is no parameter that could
 * carry one: the learner is the bearer of the token and their state comes from
 * their own `learner_profiles` row. The body is `{ focus }` or nothing at all —
 * the API's DTO is a `strictObject`, so an invented key is a 400 rather than
 * something silently ignored.
 */
export async function streamCivicsExplanation(
  questionId: string,
  options: ExplainStreamOptions,
): Promise<void> {
  const focus = options.focus?.trim();

  return streamSseRequest({
    url: explainUrl(questionId),
    method: 'POST',
    // Omitted entirely when there is no focus. `POST` with no body is the
    // documented ordinary call — the DTO defaults to `{}` precisely so that
    // sending `{}` to ask a plain question is not a required ceremony.
    body: focus ? JSON.stringify({ focus }) : undefined,

    authorization: () => {
      const token = api.getAccessToken();
      return token ? `Bearer ${token}` : null;
    },
    reauthenticate: () => api.refreshToken(),

    signal: options.signal,
    onOpen: options.onOpen,

    onFrame: (raw) => {
      const frame = decodeFrame(raw.event, raw.data);
      if (frame) options.onFrame(frame);
    },
  });
}

/**
 * One wire frame -> one {@link ExplainFrame}, or `null` to ignore it.
 *
 * Every field is checked before it is trusted. The payloads come from our own
 * API, but they arrive as text over a stream that a proxy can truncate, and
 * `undefined` appended to an explanation is a silent corruption of the one
 * thing this feature produces.
 */
function decodeFrame(event: string, data: string): ExplainFrame | null {
  const payload = parseJson(data);

  switch (event) {
    case 'delta': {
      const text = readString(payload, 'text');
      // An empty delta is dropped rather than appended: the API says a delta is
      // never empty, so an empty one is a frame that arrived wrong.
      return text ? { event: 'delta', text } : null;
    }

    case 'done':
      // `usage` deliberately unread — see the file header.
      return { event: 'done' };

    case 'unavailable': {
      const cause = readString(payload, 'cause');
      // An unrecognised cause is still `unavailable`, and still not an error.
      // `capability_unsupported` is the honest default here: it is the cause
      // whose remedy — an administrator finishing configuration — is the one
      // shared by every member of the union except `no_user_key`, and guessing
      // `no_user_key` would send a learner to replace a key that is fine.
      return {
        event: 'unavailable',
        cause: isUnavailableCause(cause) ? cause : 'capability_unsupported',
      };
    }

    case 'state_required':
      return { event: 'state_required' };

    case 'error':
      return {
        event: 'error',
        errorCode: readString(payload, 'errorCode') ?? 'unknown_error',
        error: readString(payload, 'error') ?? '',
      };

    default:
      // A newer server's frame. Ignored, never rendered — see the file header.
      return null;
  }
}

function parseJson(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readString(
  payload: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = payload?.[key];
  return typeof value === 'string' ? value : null;
}

const UNAVAILABLE_CAUSES: readonly string[] = [
  'no_user_key',
  'ai_disabled',
  'role_unbound',
  'capability_unsupported',
];

function isUnavailableCause(value: string | null): value is AiUnavailableCause {
  return value !== null && UNAVAILABLE_CAUSES.includes(value);
}

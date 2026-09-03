/**
 * The client half of `POST /api/interviews/:id/turns` (issue #140, epic #57 / E8).
 *
 * The endpoint answers with `text/event-stream`, and this file is the one place
 * that knows its frame names and payload shapes. It is to `streamSseRequest`
 * what `explainStream.ts` is to the same function: the transport is generic,
 * this is the endpoint's own vocabulary, and nothing above it should be reading
 * `frame.data` strings.
 *
 * =============================================================================
 * THE FRAME NAMES ARE THE API'S, NOT GUESSES
 * =============================================================================
 *
 * Read from `apps/api/src/interviews/interviews.service.ts`
 * (`InterviewTurnFrame`, `InterviewTurnOutcome`) and the controller's own
 * documented wire format:
 *
 *   `: connected`   an opening COMMENT, so the headers flush immediately. Never
 *                   dispatched as a frame — `SseParser` drops it — and it is
 *                   why a learner sees "the officer is answering" the moment
 *                   they submit rather than after the model's first token.
 *   `delta`         `{ "text": "…" }` — a chunk of the officer's
 *                   acknowledgement. Never empty. Any number.
 *   `done`          TERMINAL. The officer's turn is whole.
 *   `unavailable`   TERMINAL, plus `{ "cause": … }`. No call was attempted.
 *   `error`         TERMINAL, plus `{ "errorCode": …, "error": … }`. A call was
 *                   attempted and did not finish.
 *
 * **Exactly one terminal frame, always last.** That is the API's contract, and
 * it is what lets a consumer stop waiting.
 *
 * =============================================================================
 * THE DIFFERENCE FROM THE EXPLAIN STREAM: EVERY TERMINAL FRAME CARRIES THE TURN
 * =============================================================================
 *
 * `explainStream.ts`'s `unavailable` and `error` are dead ends — no explanation
 * was produced, and the panel says so. **Here they are not.** All three
 * terminal frames carry the same {@link InterviewTurnOutcome}: the officer
 * turns this exchange produced, the phase the interview is now in, the turn
 * index, the civics progress, and whether the only remaining action is
 * `complete`.
 *
 * That follows from `docs/specs/mock-interview.md` §5.2, which is the whole
 * engine/model boundary in one sentence: **the model supplies phrasing, never
 * content.** When the dispatcher is unavailable or fails, the engine
 * substitutes a fixed, code-owned neutral officer line and proceeds
 * identically — same next question, same grading, same stop evaluation. The
 * interview really advanced; only the wording is plainer.
 *
 * So a client that rendered nothing on `unavailable`, or an error alert in
 * place of the turn, would be DROPPING A TURN THAT ACTUALLY HAPPENED — the
 * screen would sit on a question the server has already moved past, and the
 * learner's next answer would be graded against a question they were never
 * shown. That is why {@link InterviewTurnFrame} puts `outcome` on all three
 * terminal members rather than on `done` alone: a consumer that forgets to
 * apply it fails to compile instead.
 *
 * =============================================================================
 * A TERMINAL FRAME WHOSE OUTCOME WILL NOT DECODE CARRIES `outcome: null`
 * =============================================================================
 *
 * Every field is checked before it is trusted. The payloads come from our own
 * API, but they arrive as text over a stream a proxy can truncate, and an
 * `undefined` phase applied to an interview screen is a silent corruption of
 * the one thing this feature is.
 *
 * `null` is not a failure to report to the learner, though, and it must not be
 * rendered as one: the turn was persisted server-side before a single byte was
 * written (`InterviewsController.submitTurn` awaits the whole thing first), so
 * the honest recovery is to RE-READ `GET /api/interviews/:id` rather than to
 * show an error over an interview that is fine. `useMockInterview` does exactly
 * that, and the same path covers a stream that closes with no terminal frame at
 * all.
 *
 * =============================================================================
 * AN UNRECOGNISED FRAME IS IGNORED, NOT AN ERROR
 * =============================================================================
 *
 * A newer server talking to an older bundle is not a fault, and neither is a
 * malformed payload: a `delta` whose JSON will not parse contributes no text
 * and the stream carries on to its terminal frame.
 */

import { API_BASE_URL, api } from './api';
import { streamSseRequest } from './sse';
import type {
  AiUnavailableCause,
  InterviewPhase,
  InterviewProgress,
  InterviewTurnRecord,
} from '../types';

/** The endpoint, for one interview id. */
export function interviewTurnsUrl(interviewId: string): string {
  return `${API_BASE_URL}/interviews/${encodeURIComponent(interviewId)}/turns`;
}

/**
 * What every terminal frame carries: the turn that happened.
 *
 * Mirrors `InterviewTurnOutcome` on the API field for field. Note what is NOT
 * on it — no outcome, no score, no correct count. §10: the engine knew whether
 * the answer was right the moment it graded it and deliberately does not send
 * it, so there is nowhere on this shape for a verdict to arrive.
 */
export interface InterviewTurnOutcome {
  /** The officer turns this exchange produced, in order. Usually one. */
  officerTurns: InterviewTurnRecord[];
  /** The phase the interview is in NOW — after this turn, not before it. */
  phase: InterviewPhase;
  /** The index of the last turn written. */
  turnIndex: number;
  progress: InterviewProgress;
  /** True once the only remaining action is `complete`. */
  awaitingCompletion: boolean;
}

/**
 * One decoded frame.
 *
 * A DISCRIMINATED UNION rather than `{ event, data }`, for the reason the API's
 * own type gives: the terminal frames have no `text`, so a consumer that
 * appends `frame.text` unconditionally fails to compile instead of appending
 * `undefined` to the officer's words. And `outcome` is on all three terminal
 * members for the reason this file's header gives at length.
 */
export type InterviewTurnFrame =
  | { event: 'delta'; text: string }
  | { event: 'done'; outcome: InterviewTurnOutcome | null }
  | {
      event: 'unavailable';
      outcome: InterviewTurnOutcome | null;
      cause: AiUnavailableCause;
    }
  | {
      event: 'error';
      outcome: InterviewTurnOutcome | null;
      errorCode: string;
      error: string;
    };

/** The three frames after which nothing else arrives. */
export function isTerminalFrame(frame: InterviewTurnFrame): boolean {
  return frame.event !== 'delta';
}

export interface InterviewTurnStreamOptions {
  /**
   * Ends the generation. REQUIRED — see `streamSseRequest`: the officer's
   * phrasing is generated on the learner's OWN AI key, so an abandoned stream
   * is a charge on somebody's card for words nobody will read. The server
   * aborts its upstream call when this end closes the socket, and the turn is
   * still persisted either way.
   */
  signal: AbortSignal;
  /** Headers arrived; the officer is answering. */
  onOpen?: () => void;
  /** One decoded frame, in order. */
  onFrame: (frame: InterviewTurnFrame) => void;
}

/**
 * Take one turn, and stream the officer's reply. Resolves when the stream ends;
 * rejects on transport failure or abort.
 *
 * THE BODY IS `{ text }` AND NOTHING ELSE, and the omissions are the contract:
 * no `questionId` (which question this answers is the engine's own state — a
 * client that could name one could answer a question it was never asked), no
 * `phase`, no `skipped`, no `revealed`, no `hintUsed`. None of the practice
 * screen's affordances exists inside a rehearsal, and the API's DTO is a
 * `strictObject`, so an invented key is a 400 rather than something silently
 * ignored.
 *
 * An EMPTY `text` is deliberately allowed through rather than short-circuited
 * here. An applicant who says nothing has still taken their turn: the officer
 * acknowledges and moves on, exactly as at the real event. Refusing to send it
 * would make "I don't know" the one thing this rehearsal will not let a nervous
 * person say.
 */
export async function streamInterviewTurn(
  interviewId: string,
  text: string,
  options: InterviewTurnStreamOptions,
): Promise<void> {
  return streamSseRequest({
    url: interviewTurnsUrl(interviewId),
    method: 'POST',
    body: JSON.stringify({ text }),

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

/** One wire frame -> one {@link InterviewTurnFrame}, or `null` to ignore it. */
function decodeFrame(event: string, data: string): InterviewTurnFrame | null {
  const payload = parseJson(data);

  switch (event) {
    case 'delta': {
      const text = readString(payload, 'text');
      // An empty delta is dropped rather than appended: the API says a delta is
      // never empty, so an empty one is a frame that arrived wrong.
      return text ? { event: 'delta', text } : null;
    }

    case 'done':
      return { event: 'done', outcome: decodeOutcome(payload) };

    case 'unavailable': {
      const cause = readString(payload, 'cause');
      // An unrecognised cause is still `unavailable`, and still not an error.
      // `capability_unsupported` is the honest default: its remedy — an
      // administrator finishing configuration — is the one shared by every
      // member of the union except `no_user_key`, and guessing `no_user_key`
      // would send a learner to replace a key that is fine.
      return {
        event: 'unavailable',
        outcome: decodeOutcome(payload),
        cause: isUnavailableCause(cause) ? cause : 'capability_unsupported',
      };
    }

    case 'error':
      return {
        event: 'error',
        outcome: decodeOutcome(payload),
        errorCode: readString(payload, 'errorCode') ?? 'unknown_error',
        error: readString(payload, 'error') ?? '',
      };

    default:
      // A newer server's frame. Ignored, never rendered — see the file header.
      return null;
  }
}

/**
 * The turn outcome carried by a terminal frame, or `null` when the payload is
 * not one this bundle can trust.
 *
 * Strict on the three fields the screen actually steers on — `phase`,
 * `progress`, `officerTurns` — because a wrong value in any of them puts the
 * learner on a different question from the one the server is grading against.
 * `turnIndex` and `awaitingCompletion` are read defensively rather than
 * strictly: neither can desynchronise the interview on its own, and refusing a
 * whole turn over a missing integer would be the "recovery worse than the
 * fault" trade this decoder exists to avoid.
 */
function decodeOutcome(
  payload: Record<string, unknown> | null,
): InterviewTurnOutcome | null {
  if (!payload) return null;

  const phase = readString(payload, 'phase');
  if (!isInterviewPhase(phase)) return null;

  const progress = readProgress(payload.progress);
  if (!progress) return null;

  const officerTurns = readOfficerTurns(payload.officerTurns);
  if (!officerTurns) return null;

  return {
    officerTurns,
    phase,
    turnIndex:
      typeof payload.turnIndex === 'number' ? payload.turnIndex : officerTurns.length,
    progress,
    awaitingCompletion: payload.awaitingCompletion === true,
  };
}

function readProgress(value: unknown): InterviewProgress | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const civicsAsked = raw.civicsAsked;
  const civicsPlanned = raw.civicsPlanned;
  if (typeof civicsAsked !== 'number' || typeof civicsPlanned !== 'number') {
    return null;
  }
  return { civicsAsked, civicsPlanned };
}

/**
 * The officer turns on a terminal frame.
 *
 * An EMPTY ARRAY IS VALID and must not be treated as a decode failure — the
 * API's own documented `done` example carries `"officerTurns":[]`. What is not
 * valid is a non-array, or an entry missing the two fields this screen renders.
 */
function readOfficerTurns(value: unknown): InterviewTurnRecord[] | null {
  if (!Array.isArray(value)) return null;

  const turns: InterviewTurnRecord[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const raw = entry as Record<string, unknown>;
    const phase = readString(raw, 'phase');
    if (typeof raw.text !== 'string' || !isInterviewPhase(phase)) return null;

    turns.push({
      id: readString(raw, 'id') ?? `${raw.turnIndex ?? turns.length}`,
      turnIndex: typeof raw.turnIndex === 'number' ? raw.turnIndex : turns.length,
      // Every turn on this array is the officer's, by the field's name and by
      // the API's own type. Defaulted rather than rejected so a role this
      // bundle has never heard of cannot blank an interview screen.
      role: raw.role === 'applicant' ? 'applicant' : 'officer',
      phase,
      questionId: readString(raw, 'questionId'),
      text: raw.text,
      createdAt: readString(raw, 'createdAt') ?? '',
    });
  }

  return turns;
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

const INTERVIEW_PHASES: readonly string[] = [
  'smalltalk',
  'n400',
  'civics',
  'reading',
  'writing',
  'closing',
];

function isInterviewPhase(value: string | null): value is InterviewPhase {
  return value !== null && INTERVIEW_PHASES.includes(value);
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

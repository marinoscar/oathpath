import type { z } from 'zod';

import type { AiCapabilityFamily } from './ai-model-roles';

// =============================================================================
// AI provider types (issue #28, epic #25)
// =============================================================================
//
// The wire format between "something that wants a model to do a job" and
// "something that calls a provider's API". Deliberately free of Nest, Prisma
// and the OpenAI SDK: a settings test and a usage-recording test should be
// able to build a request and assert on a result without standing up DI or
// mocking an HTTP client.
//
// Modelled on `email/email.types.ts`, which draws the same boundary for mail.
// =============================================================================

/**
 * One model as the provider describes it, after classification.
 *
 * WHY THIS IS NOT JUST A STRING ID: `GET /v1/models` returns a flat, unordered
 * list mixing chat, reasoning, realtime, transcription, TTS, embedding, image
 * and moderation models, plus fine-tunes and long-deprecated ids. Handing that
 * raw to an admin binding a `grader` is not a usable surface — the shape below
 * is what makes it one.
 */
export interface AiModelDescriptor {
  /** The provider's own model id, exactly as it must be sent back. */
  id: string;

  /**
   * Which family this id was classified into.
   *
   * `'other'` is the deliberate escape hatch for an id the classifier does not
   * recognise. Such a model is SURFACED under the show-all view rather than
   * dropped: a model we cannot classify is not the same thing as a model that
   * does not exist, and treating them alike turns an upstream rename into an
   * admin with an empty dropdown and no workaround.
   */
  family: AiCapabilityFamily;

  /**
   * The parsed generation, when one can be determined. `null` otherwise.
   *
   * A NUMBER, not a string: `'5.10' < '5.4'` lexicographically, and that
   * comparison silently hides a newer model from the dropdown.
   *
   * `null` means "could not be parsed", never "old". A null-generation model
   * is never silently filtered out — see `family` above.
   */
  generation: number | null;

  /** Provider-reported creation time, when it supplies one. Used for ordering. */
  createdAt: Date | null;
}

/**
 * The outcome of fetching a provider's model catalog.
 *
 * A RESULT TYPE RATHER THAN A THROWN ERROR, for the reason
 * {@link AiProvider} gives: every provider method is never-throw, so "no key
 * configured" and "the provider refused" both arrive here as data an admin
 * page can render.
 */
export interface AiModelCatalogResult {
  /** Did the provider answer? */
  success: boolean;

  /** The classified catalog. Empty on failure — never partial-and-unmarked. */
  models: AiModelDescriptor[];

  /**
   * Why it failed, verbatim from the provider after redaction and the length
   * cap. Null on success.
   *
   * Not a category, not a rewritten sentence: an expired key, a revoked org
   * and a network timeout are different problems, and flattening them
   * discards the only information the admin came for.
   */
  error: string | null;

  /**
   * True when nothing was attempted because no credential is stored.
   *
   * DISTINCT FROM `error`, and the distinction matters: this is the state of
   * every fresh install, and reporting it as a failure would make a brand-new
   * system look broken. `getSecret` returns `null` for an absent credential by
   * design, and this flag is that fact reaching the UI intact.
   */
  notConfigured: boolean;
}

/**
 * A request to check that one model is actually usable on a given key.
 *
 * The admin binds model ids using the SERVER key; a user's personal key may
 * sit in a different organisation or tier with no access to those models. This
 * is the shape of the question "can THIS key reach THAT model?".
 */
export interface AiReachabilityRequest {
  /** The role the model is bound to, for reporting. */
  roleKey: string;

  /** The bound model id to probe. */
  modelId: string;

  /** The capability family the model must serve, which decides how to probe. */
  family: AiCapabilityFamily;
}

/**
 * Whether one bound model is reachable on the key that was tested.
 *
 * PER ROLE, NOT ONE BOOLEAN. A key can authenticate perfectly and still have
 * no access to the `grader` model — testing only `GET /v1/models` would pass
 * for a key that cannot run a single request the app actually makes, which is
 * the entire failure the test endpoints exist to catch.
 */
export interface AiReachabilityResult {
  roleKey: string;

  /** The model id that was probed. Echoed so the UI can name it. */
  modelId: string;

  reachable: boolean;

  /**
   * Why not, verbatim after redaction. Null when reachable.
   */
  error: string | null;
}

/**
 * The outcome of testing a key end to end: does it authenticate, and can it
 * reach each model the app would use it for?
 */
export interface AiConnectionTestResult {
  /**
   * Did the key authenticate AND reach every model it was asked about?
   *
   * A conjunction on purpose. A key that authenticates but cannot reach the
   * `grader` model does not work for this application, and reporting it as a
   * success is how a user finishes onboarding into a product that then fails
   * on their first practice answer.
   */
  success: boolean;

  /** Did the key itself authenticate? Separates "bad key" from "no access". */
  authenticated: boolean;

  /** One entry per role probed. Empty when authentication itself failed. */
  roles: AiReachabilityResult[];

  /**
   * The provider's verbatim message, after redaction and the length cap.
   * Null on success.
   */
  error: string | null;
}

/**
 * Token usage for one call, as the provider reported it.
 *
 * EVERY FIELD IS NULLABLE, AND THAT IS THE POINT. A call that fails mid-stream
 * yields partial or no usage, and recording `0` there would be a claim — a
 * false one that understates consumption. `null` means "unknown"; the caller's
 * `success` and `errorCode` are what distinguish the two.
 *
 * For a STREAMED response OpenAI emits usage only when the request sets
 * `stream_options: { include_usage: true }`. Omitting that silently records
 * zero for every streaming call, which is the most likely way usage
 * accounting ends up quietly wrong — see #37.
 */
export interface AiUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

// -----------------------------------------------------------------------------
// Inference (issue #37, epic #25)
// -----------------------------------------------------------------------------
//
// The minimum surface needed for usage accounting to be real rather than
// theoretical. Epic #25 ships no AI FEATURE — no tutor, no grader — but it
// does ship the path a feature will call, because the accounting decisions
// (stream_options, null-not-zero) are only testable against a real request
// builder, and their failure modes are silent.

/** One turn in a completion request. */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * A request for one completion, on one caller's key.
 *
 * `roleKey` is carried so the usage row records WHICH JOB the call served,
 * not merely which model. An admin who rebinds `grader` later must still be
 * able to read last month's rows correctly — see `ai_usage_events`.
 */
export interface AiCompletionRequest {
  /** The model role this call serves: 'tutor', 'grader', … */
  roleKey: string;

  /** The bound model id. Resolved by the caller from the settings row. */
  modelId: string;

  messages: AiMessage[];

  /**
   * Stream the response.
   *
   * NOTE FOR IMPLEMENTERS: OpenAI emits `usage` on a streamed response ONLY
   * when the request sets `stream_options: { include_usage: true }`. Omitting
   * it silently records zero for every streaming call — the most likely way
   * usage accounting ends up quietly wrong, because nothing fails.
   */
  stream?: boolean;

  maxTokens?: number;
}

/**
 * The outcome of one completion.
 *
 * NEVER THROWN, always returned — `BaseAiProvider` holds the same never-throw
 * contract here as everywhere else.
 */
export interface AiCompletionResult {
  success: boolean;

  /** The assistant text, on success. Null on failure. */
  text: string | null;

  /**
   * Token counts as the provider reported them.
   *
   * EVERY FIELD MAY BE NULL, including on a successful call. See {@link AiUsage}.
   */
  usage: AiUsage;

  /**
   * A short, stable classification of the failure, for the usage row. Null on
   * success.
   *
   * A CODE, NOT A MESSAGE: `ai_usage_events.error_code` is written on every
   * failed call and is meant to be GROUPed by, which free text cannot be. The
   * diagnosable text goes in `error`.
   */
  errorCode: string | null;

  /** The provider's verbatim message, redacted. Null on success. */
  error: string | null;
}

// -----------------------------------------------------------------------------
// Structured output and streaming (issue #96, epic #53)
// -----------------------------------------------------------------------------
//
// Epic #25 shipped one inference shape: ask for text, get text back, record the
// row. That is enough for accounting and not enough for a product. The two
// shapes below are what E4's features actually need, and each exists because
// doing it at the call site would be done wrong:
//
//   * STRUCTURED OUTPUT. A grader must return a verdict an application can
//     branch on, not a paragraph a regular expression is pointed at. Asking a
//     model nicely for JSON and parsing the reply is the version that fails in
//     production — a fenced code block, a preamble, a trailing apology, a field
//     renamed on a whim — so the schema is sent to the provider as a
//     constraint AND re-validated on the way back, and a reply that satisfies
//     neither is a FAILED RESULT rather than a partially-populated object that
//     flows onward as if it were a grade.
//
//   * STREAMING. A tutor explanation that appears a paragraph at a time reads
//     as fast; the same explanation delivered whole after eight seconds reads
//     as broken. The interesting part is not the deltas, it is what happens
//     when the stream does not finish — see {@link AiStreamEvent}.

/**
 * A completion that has already been recorded, carrying its row id.
 *
 * WHY THE ID IS CARRIED OUT rather than left in the table: issue #110 adds
 * `practice_attempts.ai_usage_event_id`, a foreign key from a graded attempt
 * to the call that graded it. The alternative — finding the row afterwards by
 * user, model and timestamp — is a guess that races the learner's own next
 * answer, and it is wrong exactly when they are answering quickly.
 */
export interface AiRecordedCompletionResult extends AiCompletionResult {
  /**
   * The `ai_usage_events` row written for this call, or `null` when the write
   * failed.
   *
   * `null` IS NOT "no row was needed" — every call writes one. It means the
   * write did not succeed, and a caller holding a nullable FK stores null and
   * carries on rather than failing a user's request over bookkeeping.
   */
  usageEventId: string | null;
}

/**
 * A request for one completion whose reply must satisfy a schema.
 *
 * The schema is used TWICE, from this single field, and that is the point: it
 * is converted to JSON Schema and sent to the provider as a hard constraint,
 * and it validates the reply that comes back. Two declarations — one for the
 * provider, one for the parse — would drift, and the drift would present as a
 * model that "stopped following instructions".
 */
export interface AiStructuredCompletionRequest<T> extends AiCompletionRequest {
  /**
   * The JSON-schema name sent to the provider
   * (`response_format.json_schema.name`).
   *
   * A stable identifier for the SHAPE, not for the call. It is also the only
   * part of the schema that reaches a span attribute — see
   * `BaseAiProvider.completeStructured`.
   */
  schemaName: string;

  /**
   * The zod (v4) schema the reply must satisfy.
   *
   * `z.toJSONSchema(schema)` builds the provider payload AND `schema.safeParse`
   * validates the reply, so the constraint the model was given and the
   * contract the caller relies on are the same object.
   */
  schema: z.ZodType<T>;
}

/**
 * The outcome of one structured completion.
 *
 * NEVER THROWN, always returned — the same never-throw contract every other
 * result type on this surface carries.
 */
export interface AiStructuredCompletionResult<T> {
  success: boolean;

  /**
   * The parsed AND schema-validated value. `null` on any failure.
   *
   * NEVER A PARTIAL OBJECT. A reply that parsed as JSON but did not satisfy
   * the schema is a failure, not a half-answer to be salvaged: a grader result
   * missing its verdict field is not a lenient grade, it is no grade, and
   * letting it through is how a learner is told they were wrong by a field
   * that was never there.
   */
  data: T | null;

  /** Token counts as the provider reported them. See {@link AiUsage}. */
  usage: AiUsage;

  /**
   * A short, stable classification of the failure, for the usage row. Null on
   * success.
   *
   * Beyond the codes a thrown provider error is classified into, this surface
   * adds two of its own:
   *
   *   * `'invalid_json'` — the reply was not JSON at all (or was empty).
   *   * `'schema_validation_failed'` — it was JSON, and it did not match.
   *
   * Distinct because the remedies are: the first says the provider ignored or
   * could not honour `response_format`, the second says our schema and the
   * model's idea of it disagree.
   */
  errorCode: string | null;

  /**
   * A diagnosable message, redacted. Null on success.
   *
   * NEVER THE MODEL'S REPLY. See `BaseAiProvider.completeStructured` — the
   * text this result was built from is content about a learner's answer, and
   * an error string is the one field on this type that reaches a log.
   */
  error: string | null;

  /** The `ai_usage_events` row for this call. See {@link AiRecordedCompletionResult}. */
  usageEventId: string | null;
}

/**
 * One event from a streamed completion.
 *
 * -----------------------------------------------------------------------------
 * A DISCRIMINATED UNION, NOT A BAG OF OPTIONAL FIELDS
 * -----------------------------------------------------------------------------
 *
 * `{ text?, usage?, error? }` would compile at every call site and be wrong at
 * most of them: a consumer would read `text` off the terminal event, append
 * `undefined` to the transcript, and ship. Here the terminal events have no
 * `text` to read, so the compiler asks the question instead of the incident
 * report.
 *
 * -----------------------------------------------------------------------------
 * EXACTLY ONE TERMINAL EVENT, ALWAYS LAST. THIS IS A CONTRACT.
 * -----------------------------------------------------------------------------
 *
 * Every stream ends with exactly one `done` OR exactly one `error`, and
 * nothing follows it. Not "usually", not "on the happy path": a provider
 * timeout, a revoked key, an aborted request and a bug in the SDK all arrive
 * as an `error` event, because the consumer on the other end is an SSE
 * endpoint and a browser connection that never sees a terminal event stays
 * open forever — a tab spinning on a response that already failed, and a
 * server holding a socket for a request that is over.
 */
export type AiStreamEvent =
  /** A chunk of assistant text. Never empty — empty chunks are dropped. */
  | { type: 'delta'; text: string }
  /** The stream completed. Usage is whatever the provider reported. */
  | { type: 'done'; usage: AiUsage; usageEventId: string | null }
  /**
   * The stream failed. The deltas already yielded stand — they were really
   * received — but the completion is not whole and must not be presented as
   * one.
   *
   * `usage` here is what the provider had told us BEFORE the failure, which is
   * usually all-null. NEVER ZERO: see {@link AiUsage}.
   */
  | {
      type: 'error';
      errorCode: string;
      error: string;
      usage: AiUsage;
      usageEventId: string | null;
    };

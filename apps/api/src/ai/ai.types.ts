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

// -----------------------------------------------------------------------------
// Speech (issue #88, epic #58 — E9 "Voice foundation")
// -----------------------------------------------------------------------------
//
// Two more shapes on the same never-throw surface: audio in, text out, and text
// in, audio out. They are separate from {@link AiCompletionRequest} rather than
// a `messages` variant of it because nothing about them is a conversation —
// there is no turn structure, no assistant role, no streamed delta, and the
// payload is bytes.
//
// WHAT THESE TYPES CARRY IS A LEARNER'S RECORDED VOICE AND WHAT THEY SAID, so
// two rules apply to every field below, and both are enforced in
// `base-ai.provider.ts` rather than left to a call site:
//
//   * NO FIELD HERE MAY REACH A LOG LINE OR A SPAN ATTRIBUTE, with the single
//     exception of the redacted `error`. Byte length and content type are
//     diagnosable; the audio and the transcript are the material a trace
//     backend has no business holding. `ai_usage_events` has no column for
//     either, and that is not an oversight to work around.
//
//   * THE TRANSCRIBE PATH DOES NOT CARRY THE AUDIO BACK. The caller handed the
//     buffer in and still holds it; echoing it into the result would only
//     create a second reference for something downstream to persist by
//     accident. `AiTranscriptionResult` has no `audio` field for that reason,
//     and adding one is a decision, not a convenience.

/**
 * A request to turn one recording into text, on one caller's key.
 *
 * `roleKey` is carried for the same reason {@link AiCompletionRequest} carries
 * it: the `ai_usage_events` row records WHICH JOB the call served, so an admin
 * who rebinds `transcribe` later can still read last month's rows correctly.
 */
export interface AiTranscriptionRequest {
  /** The model role this call serves: `'transcribe'`. */
  roleKey: string;

  /** The bound model id. Resolved by the caller from the settings row. */
  modelId: string;

  /**
   * The recording itself.
   *
   * IN MEMORY, NEVER A PATH OR A STREAM. A recording of a learner's answer is
   * transient by design: it exists to be turned into text and then to be
   * dropped, and a temporary file is a copy that outlives the request and that
   * somebody has to remember to delete. Practice answers are minutes of speech
   * at most, so holding one buffer is affordable; if that ever stops being
   * true, the fix is a size limit at the edge, not a file on disk.
   */
  audio: Buffer;

  /** The recording's MIME type, e.g. `'audio/webm'`. */
  contentType: string;

  /**
   * A file name for the upload.
   *
   * REQUIRED BECAUSE THE PROVIDER SDK INFERS THE AUDIO FORMAT FROM IT. A
   * buffer with no name is uploaded as an unnamed blob and rejected as an
   * unsupported format, which presents as "transcription is broken" rather
   * than as the missing metadata it is. It is a wire detail, not a stored
   * filename — nothing writes it anywhere.
   */
  fileName: string;

  /**
   * An optional ISO-639-1 hint, e.g. `'en'`.
   *
   * A HINT, NOT A CONSTRAINT: a learner practising for a US civics interview
   * speaks English with an accent the recogniser may or may not place, and
   * pinning the language improves accuracy without forbidding anything.
   * Omitted means "let the provider decide".
   */
  languageHint?: string;
}

/**
 * The outcome of one transcription.
 *
 * NEVER THROWN, always returned — the same never-throw contract every result
 * type on this surface carries.
 */
export interface AiTranscriptionResult {
  success: boolean;

  /**
   * What was heard, on success. `null` on failure.
   *
   * NEVER `''` STANDING IN FOR A FAILURE. An empty string is a legitimate
   * result — a recording of silence, a learner who pressed record and said
   * nothing — and a caller must be able to tell that apart from "the provider
   * refused". `success` and `errorCode` are what distinguish them, and they
   * only can if the failure path does not also produce `''`.
   */
  text: string | null;

  /**
   * How sure the recogniser was, in `[0, 1]`.
   *
   * -------------------------------------------------------------------------
   * `null` MEANS UNKNOWN. IT IS NEVER DEFAULTED TO 0.
   * -------------------------------------------------------------------------
   *
   * The identical rule every {@link AiUsage} field carries, for the identical
   * reason — a stored zero is a false claim — but the false claim here is
   * worse than a wrong token count. `confidence: 0` asserts "the recogniser
   * was certain it heard nothing". Downstream, that is exactly the signal a
   * caller uses to decide an answer was MISHEARD rather than wrong, so a
   * defaulted zero turns "we do not know how well this was heard" into "this
   * learner said nothing intelligible" — on an answer they may well have got
   * right, and with the transcript sitting right there saying otherwise.
   *
   * `null` is a normal, expected value: not every model reports a confidence
   * signal at all (see `OpenAiProvider.runTranscription`, where the
   * `gpt-4o-transcribe` family cannot). A caller that needs a number must
   * decide what to do when there is none — it must not read one that was
   * invented for it.
   */
  confidence: number | null;

  /**
   * Token counts as the provider reported them.
   *
   * ALL-NULL IS THE ORDINARY CASE HERE, not a failure: the speech APIs bill by
   * audio duration and report no token usage at all for most models. See
   * {@link AiUsage} — `null` is the honest reading of "we were not told".
   */
  usage: AiUsage;

  /**
   * A short, stable classification of the failure, for the usage row. Null on
   * success. A CODE, NOT A MESSAGE — see {@link AiCompletionResult.errorCode}.
   */
  errorCode: string | null;

  /**
   * The provider's verbatim message, redacted and truncated. Null on success.
   *
   * THE ONLY FIELD ON THIS TYPE THAT MAY REACH A LOG. It never contains the
   * transcript or the audio — see the section header above.
   */
  error: string | null;
}

/**
 * Below this, a transcription is treated as a likely MISHEARING rather than as
 * a wrong answer (`docs/specs/voice.md` §3).
 *
 * -----------------------------------------------------------------------------
 * ONE NUMBER, IN ONE PLACE, BECAUSE IT IS A PRODUCT DECISION
 * -----------------------------------------------------------------------------
 *
 * It answers "how much doubt is too much doubt to trust a transcript
 * unexamined?", which is a judgement about fairness to a learner with an
 * accent — not a tuning constant. Named for the same reason
 * `STREAK_FREEZE_MAX` and `SYSTEM_STATUS_TTL_MS` are named rather than typed
 * inline: a second call site repeating the literal `0.6` is a second call site
 * that can drift from this one silently on the next edit, and the two would
 * then disagree about whether the same recording was heard well enough — with
 * nothing failing to say so.
 *
 * The one consumer today is `PracticeService.recordAttempt`, which maps a
 * confidence strictly below this onto `practice_attempts.failure_cause =
 * 'misheard'` for any outcome that is not `correct`. It lives here, beside
 * {@link AiTranscriptionResult.confidence}, because this is the type that
 * produces the value being compared — a reader who has just been told that
 * `null` means unknown finds, in the same file, what a KNOWN low value means.
 *
 * STRICTLY BELOW, never at-or-below: `0.6` exactly is trusted. The boundary
 * has to fall on one side, and trusting the transcript is the side that cannot
 * invent a mishearing that did not happen.
 *
 * A `null` confidence NEVER reaches this comparison — see the same field's
 * doc above. Unknown is not low.
 */
export const ASR_CONFIDENCE_THRESHOLD = 0.6;

/**
 * A request to read one piece of text aloud, on one caller's key.
 *
 * The text is ours, not a learner's: a civics question, an explanation, an
 * officer's interview turn. That is why there is no confidence analogue on the
 * way back — synthesis either produced audio or it did not.
 */
export interface AiSynthesisRequest {
  /** The model role this call serves: `'speak'`. */
  roleKey: string;

  /** The bound model id. Resolved by the caller from the settings row. */
  modelId: string;

  /** What to say. */
  text: string;

  /**
   * The provider's voice id, e.g. `'alloy'`.
   *
   * OPTIONAL, WITH THE DEFAULT CHOSEN BY THE PROVIDER IMPLEMENTATION rather
   * than by each caller. A voice is a product decision made once; letting
   * every call site pick one is how the same application ends up reading
   * questions in one voice and explanations in another.
   */
  voice?: string;

  /**
   * The container to synthesise into. `'mp3'` when omitted.
   *
   * A string rather than a union: the accepted set is the PROVIDER's, and
   * hard-coding OpenAI's list into this provider-independent type is the kind
   * of coupling this file exists without.
   */
  format?: string;
}

/**
 * The outcome of one synthesis.
 *
 * NEVER THROWN, always returned.
 */
export interface AiSynthesisResult {
  success: boolean;

  /**
   * The synthesised audio, on success. `null` on failure.
   *
   * A `Buffer`, in memory, for the same reason {@link AiTranscriptionRequest}
   * takes one: this is a response body on its way to a caller, not a file.
   */
  audio: Buffer | null;

  /**
   * The MIME type of {@link audio}, e.g. `'audio/mpeg'`. `null` on failure.
   *
   * RETURNED RATHER THAN ASSUMED. A caller streaming this to a browser must
   * set a `Content-Type`, and deriving it from the requested `format` at that
   * call site means the derivation is written once per caller and can disagree
   * with what the provider actually sent back.
   */
  contentType: string | null;

  /**
   * Token counts as the provider reported them. All-null is ordinary here too
   * — see {@link AiTranscriptionResult.usage}.
   */
  usage: AiUsage;

  /** A short, stable classification of the failure. Null on success. */
  errorCode: string | null;

  /** The provider's verbatim message, redacted. Null on success. */
  error: string | null;
}

// -----------------------------------------------------------------------------
// Realtime sessions (issue #156, epic #60 — E11 "Realtime voice interview")
// -----------------------------------------------------------------------------
//
// One more shape on the same never-throw surface, and the odd one out: nothing
// below carries a prompt, a recording or a completion, because this surface
// does not run inference at all. It MINTS PERMISSION for a browser to run it.
// The learner's own machine opens the realtime connection and speaks to the
// model directly; this process only asks the provider for a short-lived
// credential scoped to a session configuration we authored, and hands that
// credential back.
//
// WHY THAT SHAPE AT ALL, RATHER THAN PROXYING THE AUDIO: a speech-to-speech
// interview is a bidirectional stream that has to interrupt and be interrupted
// within a few hundred milliseconds. Relaying it through this API would add a
// hop in both directions to every packet and would put a learner's live voice
// through a server that, per `docs/specs/voice.md` §4, deliberately stores no
// audio and has no reason to handle any.
//
// THE CONSEQUENCE IS THE ONE RULE THIS SECTION EXISTS TO ENFORCE: something
// that reaches a browser is being minted here. A long-lived OpenAI key — the
// learner's own, or worse the server key — handed to a browser is a credential
// with no expiry, no scope and no revocation short of rotating it, sitting in
// a tab's memory where any script on the page can read it. So the boundary is
// drawn IN THE TYPE below rather than in a call site's discipline.

/**
 * One tool a realtime session may call.
 *
 * SEPARATE FROM `AiCompletionRequest`'s message list because a realtime tool
 * is part of the SESSION's configuration, not of a turn: it is fixed when the
 * client secret is minted and cannot be renegotiated mid-conversation without
 * a new session. Declaring it here keeps the request type honest about what
 * the provider actually needs at mint time.
 *
 * `parameters` is a JSON Schema object, typed as a record rather than as a zod
 * schema: unlike {@link AiStructuredCompletionRequest}, nothing on this path
 * ever validates a reply — the tool call is answered by the browser, over the
 * realtime connection, and never passes through this process.
 */
export interface AiRealtimeTool {
  /** The function name the model calls. */
  name: string;

  /**
   * When to call it and what to say while calling, in the model's terms.
   *
   * Carried rather than left to the instructions because the provider gives a
   * tool its own description field and models weight it: folding the guidance
   * into the system prompt instead is how a tool ends up never being called
   * for a reason nothing in the transcript explains.
   */
  description: string;

  /** The call's parameters, as a JSON Schema object. */
  parameters: Record<string, unknown>;
}

/**
 * A request to mint one realtime session credential, on one caller's key.
 *
 * EVERY FIELD IS OURS. The instructions are the officer's system prompt this
 * application authors, the tools are the ones it implements, and the model id
 * comes from the admin's binding for the `realtime` role — exactly as
 * {@link AiSynthesisRequest} resolves its own. Nothing a learner typed or said
 * appears here, and there is no field for the caller's credential: the key is
 * a parameter of the provider METHOD, resolved from the credential store, and
 * never a property of a request object that a future caller could populate by
 * hand.
 */
export interface AiRealtimeSessionRequest {
  /** The model role this call serves: `'realtime'`. */
  roleKey: string;

  /** The bound model id. Resolved by the caller from the settings row. */
  modelId: string;

  /**
   * The session's system prompt — the officer's standing instructions.
   *
   * REQUIRED, NOT OPTIONAL. A realtime session created without instructions
   * gets the provider's own defaults (a generic, cheerful assistant), which on
   * this surface means a learner rehearsing a naturalization interview would
   * be talking to something that is not conducting one. An empty prompt is a
   * bug that presents as a strange conversation, not as an error, so the type
   * refuses to let a caller omit it by accident.
   */
  instructions: string;

  /**
   * The tools this session may call. Empty is legitimate — a conversation with
   * no structured actions is still a conversation.
   *
   * REQUIRED, NOT OPTIONAL, for the opposite reason to `instructions`: `[]`
   * says "this session deliberately has none", and an absent field would let
   * "I forgot to pass the tools" look identical to it at the one call site
   * that decides what the model can do.
   */
  tools: AiRealtimeTool[];

  /**
   * The provider's voice id, e.g. `'alloy'`.
   *
   * OPTIONAL, WITH THE DEFAULT CHOSEN BY THE PROVIDER IMPLEMENTATION rather
   * than by each caller — the same rule, and the same reason, as
   * {@link AiSynthesisRequest.voice}: a voice is a product decision made once,
   * and letting every call site pick one is how the same application ends up
   * conducting interviews in one voice and reading questions in another.
   */
  voice?: string;

  /**
   * How long the minted credential stays usable, in seconds.
   *
   * A LIFETIME, NOT AN EXPIRY INSTANT: the caller cannot know the instant the
   * provider will stamp on the secret (it is anchored to the provider's own
   * clock, at the moment of minting), so asking for a duration is the only
   * request that can be honoured exactly. Omitted means the provider's own
   * default, which is short by design.
   *
   * SHORTER IS SAFER HERE AND COSTS NOTHING. The secret only has to survive
   * long enough for the browser to open its connection; a session already
   * under way is not cut off when it expires. See
   * {@link AiRealtimeSessionResult} for what the number is bounding.
   */
  expiresInSeconds?: number;
}

/**
 * The outcome of minting one realtime session credential.
 *
 * NEVER THROWN, always returned — the same never-throw contract every result
 * type on this surface carries.
 *
 * -----------------------------------------------------------------------------
 * THE EPHEMERAL / LONG-LIVED BOUNDARY IS ENFORCED BY THIS TYPE'S SHAPE
 * -----------------------------------------------------------------------------
 *
 * What comes back from here is destined for a browser. That makes this the one
 * result type in the AI module whose success payload is a credential, and the
 * distinction between the two kinds of credential in this application is the
 * whole of its security story:
 *
 *   * the LONG-LIVED key — the learner's own OpenAI key, or the server key at
 *     `('ai', 'openai')` — lives encrypted in the credential store, is read
 *     only inside `AiDispatchService` and the provider methods, and can spend
 *     without limit until a human revokes it;
 *   * the EPHEMERAL secret below is minted per session, expires in minutes,
 *     and is scoped to the session configuration we asked for.
 *
 * THERE IS NO FIELD HERE A LONG-LIVED KEY COULD TRAVEL IN, AND THAT IS
 * DELIBERATE. Not `apiKey`, not a generic `credential`, not a `session` blob
 * echoing back what the provider was sent — one named string whose name says
 * what it is. A compile-time proof of the absence sits at the bottom of this
 * file ({@link AI_REALTIME_CARRIES_NO_LONG_LIVED_KEY}), because the mistake
 * this forecloses is not exotic: "just send the key, the browser needs to
 * talk to OpenAI" is the shortest path to a working prototype, and it is
 * indistinguishable from correct code in every test that only checks whether
 * the audio flows.
 *
 * -----------------------------------------------------------------------------
 * `clientSecret` IS NEVER LOGGED, NEVER A SPAN ATTRIBUTE, AND NEVER REDACTED
 * INTO AN ERROR STRING
 * -----------------------------------------------------------------------------
 *
 * Short-lived is not harmless: for the minutes it is valid, this string is a
 * bearer credential that can open a realtime session and spend the learner's
 * quota. A trace backend and a log aggregator both retain far longer than that
 * window, and both are read by people who have no business holding it.
 *
 * `BaseAiProvider.createRealtimeSession` therefore registers it with the
 * request's `SecretRedactor` THE MOMENT IT EXISTS, so that an error
 * raised after minting — while writing the usage row, say — cannot quote it
 * back the way a provider's own error text can quote an API key. The span
 * carries the model id and the role and nothing else, exactly as the speech
 * spans carry shape rather than content.
 */
export interface AiRealtimeSessionResult {
  success: boolean;

  /**
   * The ephemeral client secret, on success. `null` on failure.
   *
   * NEVER `''` STANDING IN FOR A FAILURE, for the same reason
   * {@link AiTranscriptionResult.text} is not: a caller must be able to tell
   * "no session" from "a session whose secret is empty", and only `success`
   * and `errorCode` can make that distinction if the failure path does not
   * also produce a string.
   */
  clientSecret: string | null;

  /**
   * When {@link clientSecret} stops being usable. `null` on failure.
   *
   * A `Date`, NOT THE PROVIDER'S EPOCH SECONDS. The provider reports a unix
   * timestamp in seconds; every other instant in this codebase is a `Date`,
   * and a bare number that is seconds where the platform's own is
   * milliseconds is the error that produces an expiry a thousandfold wrong in
   * whichever direction nobody checked. Converting once, here, means no call
   * site gets the chance.
   *
   * RETURNED RATHER THAN RE-DERIVED FROM `expiresInSeconds`: the provider
   * anchors the expiry to its own clock at mint time, so a caller computing
   * `now + requested` would disagree with the truth by whatever the round trip
   * and the clock skew came to — in the direction that matters, telling a
   * browser it still has time it does not have.
   */
  expiresAt: Date | null;

  /**
   * The model the session was actually minted for. `null` on failure.
   *
   * ECHOED BACK RATHER THAN ASSUMED BY THE CALLER. The browser has to name a
   * model when it opens the connection, and deriving it from the settings row
   * a second time on the client is a second place the answer can be stale —
   * an admin who rebinds `realtime` between the mint and the connect would
   * otherwise have the browser connect to a model the secret was not minted
   * against, which fails at the provider with an error about neither.
   */
  modelId: string | null;

  /**
   * Token counts as the provider reported them.
   *
   * ALL-NULL IS THE ORDINARY CASE, and here it is not even "we were not told":
   * minting a credential runs no inference and consumes no tokens. The tokens
   * this session goes on to spend are billed against the learner's key by
   * conversation the browser holds and this process never sees — which is a
   * real gap in per-user accounting, named here rather than papered over with
   * an invented number. See {@link AiUsage}: `0` would claim we know the
   * session cost nothing.
   */
  usage: AiUsage;

  /**
   * A short, stable classification of the failure, for the usage row. Null on
   * success. A CODE, NOT A MESSAGE — see {@link AiCompletionResult.errorCode}.
   */
  errorCode: string | null;

  /**
   * The provider's verbatim message, redacted and truncated. Null on success.
   *
   * THE ONLY FIELD ON THIS TYPE THAT MAY REACH A LOG, and the redaction
   * covering it includes the minted secret as well as the API key — see the
   * type's own header.
   */
  error: string | null;
}

// -----------------------------------------------------------------------------
// Compile-time proof that no long-lived credential can travel on this surface
// -----------------------------------------------------------------------------
//
// The same technique `ai-settings.schema.ts` uses to keep a secret out of the
// settings blob, pointed at the opposite risk: not a secret going INTO storage
// but a secret coming OUT to a browser. Adding any of the names below to
// either realtime type makes `AiRealtimeCarriesNoLongLivedKey` resolve to
// `never` and this file stops compiling.
//
// `clientSecret` is deliberately NOT in the forbidden list, and the omission is
// the point: the ephemeral secret is what this surface exists to produce. What
// must never appear beside it is a field a long-lived key would naturally be
// put in — the request growing an `apiKey` so a caller can "pass its own", or
// the result growing a `key`/`token` because the provider's own payload had
// one.
//
// If you are here because this line went red: you are about to hand a
// browser a credential that does not expire. The provider mints an ephemeral
// one; use that.

type LongLivedKeyFieldNames =
  | 'apiKey'
  | 'openaiApiKey'
  | 'userApiKey'
  | 'key'
  | 'password'
  | 'secret'
  | 'token'
  | 'credential'
  | 'authorization'
  | 'accessKeyId'
  | 'secretAccessKey';

export type AiRealtimeCarriesNoLongLivedKey =
  Extract<
    keyof AiRealtimeSessionResult | keyof AiRealtimeSessionRequest,
    LongLivedKeyFieldNames
  > extends never
    ? true
    : never;

export const AI_REALTIME_CARRIES_NO_LONG_LIVED_KEY: AiRealtimeCarriesNoLongLivedKey =
  true;

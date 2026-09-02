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

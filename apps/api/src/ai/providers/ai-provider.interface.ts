import type { AiCapabilityFamily } from '../ai-model-roles';
import type { AiProviderKind } from '../ai-settings.schema';
import type {
  AiCompletionRequest,
  AiConnectionTestResult,
  AiModelCatalogResult,
  AiReachabilityRequest,
  AiRecordedCompletionResult,
  AiStreamEvent,
  AiStructuredCompletionRequest,
  AiStructuredCompletionResult,
  AiSynthesisRequest,
  AiSynthesisResult,
  AiTranscriptionRequest,
  AiTranscriptionResult,
} from '../ai.types';

// =============================================================================
// AiProvider (issue #28, epic #25)
// =============================================================================
//
// One interface, one implementation today (OpenAI), so nothing above it knows
// which provider is configured. Anthropic, Kimi and Qwen are on the roadmap;
// if the OpenAI integration were written as a concrete service, adding the
// second provider would mean reshaping the settings surface, the test endpoint
// and the admin page all at once. The email module solved this exact shape for
// mail — see `email/providers/email-provider.interface.ts`.
//
// -----------------------------------------------------------------------------
// NO METHOD ON THIS INTERFACE MAY THROW. Ever. For any reason.
// -----------------------------------------------------------------------------
//
// Every failure — an expired key, a revoked organisation, a model the key
// cannot reach, a DNS failure, a corrupt stored configuration, a bug in the
// SDK — comes back as a result object with `success: false` and a verbatim,
// redacted `error`.
//
// WHY, concretely and specifically here: two of the three DIAGNOSTIC callers
// are exactly that. `POST /api/ai-settings/test` and `POST /api/ai/key/test`
// exist to answer "why is this not working", and this app's error envelope
// (`HttpExceptionFilter`) suppresses detail in production while the web client
// funnels a non-2xx into generic failure handling. A thrown error would
// therefore discard the one fact the endpoint exists to produce. The third is
// the model-catalog fetch behind an admin page, where a throw takes down the
// only screen capable of fixing the problem.
//
// THE INFERENCE METHODS INHERIT THE SAME RULE FOR A DIFFERENT REASON (#96).
// `complete`, `completeStructured` and `stream` run on a LEARNER's key during
// ordinary use, and every way they fail is ordinary: an expired key, a
// quota, a model the account cannot reach, a dropped connection. Each of those
// must reach the user as a sentence they can act on, and each must leave an
// `ai_usage_events` row behind — a throw skips the row, so the one call the
// user was actually billed for is the one call the accounting does not know
// about.
//
// `stream` CARRIES THE RULE ONE STEP FURTHER: it may not reject, AND its
// iterator may not throw. A failure mid-stream is the terminal `error` event
// (see `AiStreamEvent`), never an exception, because the consumer on the far
// end is an SSE endpoint — a throw out of the iterator skips the terminal
// event, and a browser waiting for one holds the connection open forever.
//
// THIS IS NOT ENFORCED BY DOCUMENTATION. Implementations extend
// `../base-ai.provider.BaseAiProvider`, which implements each public method
// once as a `try`/`catch` around a `protected` abstract counterpart. A
// subclass has no public method to get wrong. If you are writing a provider
// that implements this interface directly, you are about to reintroduce the
// bug this note exists to prevent.
// =============================================================================

/**
 * Which model roles a provider can serve at all.
 *
 * LOAD-BEARING, NOT DECORATIVE. Anthropic, Kimi and Qwen offer chat but no
 * TTS, transcription or realtime surface. Without this, an admin could bind
 * the `speak` role to a provider that has no speech API, save successfully,
 * and discover the mistake only when a learner pressed "read this aloud".
 *
 * A `ReadonlySet` rather than an array so the membership test every consumer
 * makes is not a linear scan written slightly differently at each call site,
 * and so a caller cannot mutate a provider's declared capabilities in place.
 */
export type AiCapabilitySet = ReadonlySet<AiCapabilityFamily>;

/**
 * A concrete AI provider.
 *
 * @see the header for the never-throw contract every method below inherits.
 */
export interface AiProvider {
  /**
   * Which provider kind this is, matching `AI_PROVIDER_KINDS`.
   *
   * Declared on the instance rather than inferred from the class name so the
   * settings row's `provider` value and the registered implementation are
   * matched by a value the compiler checks.
   */
  readonly kind: AiProviderKind;

  /**
   * The capability families this provider can serve. See
   * {@link AiCapabilitySet}.
   */
  readonly capabilities: AiCapabilitySet;

  /**
   * Can this provider serve `family` at all?
   *
   * The gate a settings write consults before storing a binding. Implemented
   * once in the base class over {@link capabilities}; a provider does not
   * write its own.
   */
  supports(family: AiCapabilityFamily): boolean;

  /**
   * Fetch and classify the provider's model catalog using the SERVER key.
   *
   * @returns the classified catalog, or a `notConfigured` result when no
   *          server credential is stored — which is the state of every fresh
   *          install and must not read as a failure. NEVER rejects.
   */
  listModels(): Promise<AiModelCatalogResult>;

  /**
   * Prove a key works: authenticate it, then check each requested model is
   * actually reachable on it.
   *
   * @param apiKey the key to test. Passed in rather than looked up, so the
   *        SAME method serves the admin's server-key test and a user's
   *        personal-key test with no branch that could read the wrong
   *        credential — and so this interface has no way to reach into the
   *        credential store on its own.
   * @param probes one per role whose binding should be verified. Empty is a
   *        valid request: it asks only whether the key authenticates.
   * @returns per-role reachability. NEVER rejects.
   */
  testConnection(
    apiKey: string,
    probes: AiReachabilityRequest[],
  ): Promise<AiConnectionTestResult>;

  /**
   * Run one completion on the CALLER's key, and record it.
   *
   * On the interface rather than only on the base class (#96): it has been
   * implemented since #37, and leaving it off meant a caller holding an
   * `AiProvider` could not reach the one method the whole abstraction exists
   * to serve — the type said "a provider lists models and tests keys", which
   * is the settings surface, not the product.
   *
   * @param userId whose `ai_usage_events` row is written. The caller, always:
   *        there is no path here that runs one user's inference against
   *        another's accounting.
   * @param apiKey the caller's own key, PASSED IN for the same reason
   *        {@link testConnection} takes one — nothing under `providers/` reads
   *        the credential store, so no provider method can reach for the
   *        server key when it should be using a user's.
   * @returns the completion, plus the id of the row recorded for it. NEVER
   *        rejects; a failure is `{ success: false, errorCode, error }`.
   */
  complete(
    userId: string,
    apiKey: string,
    request: AiCompletionRequest,
  ): Promise<AiRecordedCompletionResult>;

  /**
   * Run one completion whose reply must satisfy a schema, and record it.
   *
   * The schema is sent to the provider as a constraint AND re-validated on the
   * way back. A reply that fails either step is a FAILED RESULT with
   * `data: null` — never a partial object, and never a throw.
   *
   * @returns the validated value, or a failure carrying `'invalid_json'` /
   *        `'schema_validation_failed'`. NEVER rejects.
   */
  completeStructured<T>(
    userId: string,
    apiKey: string,
    request: AiStructuredCompletionRequest<T>,
  ): Promise<AiStructuredCompletionResult<T>>;

  /**
   * Stream one completion on the caller's key, and record it.
   *
   * NEITHER REJECTS NOR THROWS FROM THE ITERATOR. Exactly one terminal event
   * (`done` or `error`) is emitted, always last — see {@link AiStreamEvent}
   * for why an SSE consumer makes that a contract rather than a courtesy.
   *
   * @param signal aborts the upstream request. A consumer that stops iterating
   *        — a closed browser tab — must still leave a usage row behind: the
   *        tokens were spent whether or not anyone read them.
   */
  stream(
    userId: string,
    apiKey: string,
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AiStreamEvent>;

  /**
   * Turn one recording into text on the CALLER's key, and record the call.
   *
   * NEVER REJECTS — the same rule every method above carries, and it bites
   * harder here than anywhere else on this interface. This runs while a
   * learner is waiting to find out whether their spoken answer was right, and
   * every ordinary way it fails (a codec the model will not accept, a quota, a
   * dropped upload) must reach them as a sentence and leave an
   * `ai_usage_events` row behind. A throw skips the row, so the call the user
   * was billed for is the one the accounting does not know about.
   *
   * A PROVIDER THAT CANNOT TRANSCRIBE RETURNS A FAILURE, NOT AN EXCEPTION. The
   * base class checks {@link capabilities} first and answers
   * `errorCode: 'capability_unsupported'` without calling out at all, so a
   * chat-only provider behaves like a refusing one rather than like a bug.
   *
   * @param userId whose `ai_usage_events` row is written. The caller, always —
   *        there is no path here that runs one user's inference against
   *        another's accounting.
   * @param apiKey the caller's own key, PASSED IN for the same reason
   *        {@link complete} takes one: nothing under `providers/` reads the
   *        credential store, so no provider method can reach for the server
   *        key when it should be using a user's. That server key exists for
   *        the catalog and the admin's connection test; an inference call on
   *        it silently bills the administrator for a learner's usage.
   * @returns the transcript and a confidence that MAY BE `null` — see
   *        {@link AiTranscriptionResult.confidence}, which is never 0 for
   *        "unknown".
   */
  transcribe(
    userId: string,
    apiKey: string,
    request: AiTranscriptionRequest,
  ): Promise<AiTranscriptionResult>;

  /**
   * Read one piece of text aloud on the CALLER's key, and record the call.
   *
   * NEVER REJECTS, and a provider with no speech API returns
   * `errorCode: 'capability_unsupported'` rather than throwing — exactly as
   * {@link transcribe} does, and for the same reason: an admin cannot bind
   * `speak` to a provider that lacks it (see {@link AiCapabilitySet}), but a
   * settings row written before a provider was swapped can still name one.
   *
   * @param userId whose usage row is written; @param apiKey the caller's own
   *        key, passed in — see {@link transcribe} for both.
   * @returns the audio bytes and the content type actually produced. NEVER
   *        rejects.
   */
  synthesize(
    userId: string,
    apiKey: string,
    request: AiSynthesisRequest,
  ): Promise<AiSynthesisResult>;
}

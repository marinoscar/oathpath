import type { Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';

import {
  SecretRedactor,
  truncateProviderError,
} from '../common/crypto/secret-redactor';
import type { AiCapabilityFamily } from './ai-model-roles';
import type { AiProviderKind } from './ai-settings.schema';
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiConnectionTestResult,
  AiModelCatalogResult,
  AiReachabilityRequest,
  AiRealtimeSessionRequest,
  AiRealtimeSessionResult,
  AiRecordedCompletionResult,
  AiStreamEvent,
  AiStructuredCompletionRequest,
  AiStructuredCompletionResult,
  AiSynthesisRequest,
  AiSynthesisResult,
  AiTranscriptionRequest,
  AiTranscriptionResult,
  AiUsage,
  AiVoiceDescriptor,
} from './ai.types';
import type { AiUsageService } from './ai-usage.service';
import type {
  AiCapabilitySet,
  AiProvider,
} from './providers/ai-provider.interface';

// =============================================================================
// BaseAiProvider — the never-throw guarantee, implemented once (issue #28)
// =============================================================================
//
// `AiProvider`'s methods must never throw (see providers/ai-provider.interface
// .ts for the argument). A comment saying so is not a guarantee: a concrete
// provider does a credential decrypt, a DNS resolution, a TLS handshake and an
// SDK call, and any of them can throw or reject. One `try` block that someone
// later narrows to "just the API call" while refactoring is all it takes.
//
// So the public methods are implemented HERE, once, `final` by convention, and
// subclasses implement `fetchModels` / `probeConnection` / `runCompletion` /
// `runStructuredCompletion` / `openStream` / `runTranscription` /
// `runSynthesis` / `runRealtimeSession` instead. A subclass has no public
// method to get wrong; the entire never-throw contract is this file.
//
// A hook may still contain a `try` — `OpenAiProvider.probeTextModel` and
// `runTranscription` both do — but never as a never-throw guard: each catches
// one recognised rejection to retry a differently-shaped request, and rethrows
// everything else untouched. A `catch` in a hook that swallows generally is a
// `catch` that turns a revoked key into a silently degraded result.
//
// -----------------------------------------------------------------------------
// `stream` IS THE HARD ONE, AND IT IS WHY THE PATTERN WAS WORTH KEEPING (#96)
// -----------------------------------------------------------------------------
//
// A `Promise`-returning method has one exit; an async generator has four, and
// three of them are easy to miss. It can throw before the first chunk, throw
// between chunks, complete normally — or be ABANDONED, when the consumer stops
// iterating because a browser tab closed mid-answer. The tokens were spent in
// every one of those cases, so a usage row is owed in every one of them, and
// only the `finally` of a generator sees the fourth. Writing that per provider
// is writing it wrong once per provider.
//
// The catches are deliberately bare `catch` over EVERYTHING — not
// `catch (e: Error)`, not a filtered rethrow. There is no error class from
// which the right answer is "let it propagate": a bug in the OpenAI SDK and a
// revoked API key are the same thing to an admin staring at a settings page,
// namely "AI is not working, and here is what it said".
//
// -----------------------------------------------------------------------------
// OBSERVABILITY: WHY `@Trace()` IS NOT USED HERE
// -----------------------------------------------------------------------------
//
// `common/decorators/trace.decorator.ts` sets `SpanStatusCode.OK` on any call
// that RETURNS, and records an exception only when one is thrown. This class
// is never-throw by design, so every failure returns normally — and `@Trace()`
// would mark all of them `OK`. That is worse than no instrumentation, because
// it looks like data: a dashboard would show a 100% success rate for a
// provider that has not completed a single call.
//
// So spans are opened explicitly below and their status is set from the
// RESULT, not from whether control reached the end of the method.
//
// SPAN ATTRIBUTES CARRY NO KEY, and no prompt or completion content. Model
// ids, role keys, token counts and a boolean are diagnosable; the rest is
// exactly the material that makes a trace backend a liability.
// =============================================================================

/**
 * Tracer for the AI providers.
 *
 * Reads `OTEL_SERVICE_NAME` with the same fallback as
 * `common/decorators/trace.decorator.ts`, so a renamed service renames this
 * instrumentation scope too — the split that decorator's own comment describes
 * is invisible until someone filters a trace by name and finds half of it.
 */
const tracer = trace.getTracer(process.env.OTEL_SERVICE_NAME || 'oathpath-api');

/**
 * Usage for a call whose consumption we were never told.
 *
 * ALL NULL, NEVER ZERO. See `ai_usage_events` and {@link BaseAiProvider.complete}:
 * a throw mid-stream may follow real consumption the provider never reported,
 * and recording `0` would state that it did not.
 */
const EMPTY_USAGE = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
} as const;

/**
 * A short, stable code for a thrown value, for `ai_usage_events.error_code`.
 *
 * DELIBERATELY COARSE. The column is written on every failed call and is meant
 * to be GROUPed by; the diagnosable text lives in the result's `error`, which
 * is verbatim and redacted. A code derived from the provider's message would
 * be as unGROUPable as the message itself.
 *
 * Matching on the message rather than on an SDK error class keeps this file
 * free of a provider dependency — it is the base class, and a second provider
 * must not have to be an OpenAI error to be classified.
 */
function classifyThrow(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const lower = message.toLowerCase();

  if (lower.includes('rate limit') || lower.includes('429')) return 'rate_limit';
  if (lower.includes('timeout') || lower.includes('etimedout')) return 'timeout';
  if (lower.includes('401') || lower.includes('incorrect api key')) {
    return 'invalid_key';
  }
  if (lower.includes('does not exist') || lower.includes('404')) {
    return 'model_not_found';
  }
  if (lower.includes('insufficient_quota') || lower.includes('quota')) {
    return 'quota_exceeded';
  }

  return 'error';
}

/**
 * Base class for every AI provider in this app.
 *
 * Subclasses implement {@link fetchModels} and {@link probeConnection}; they do
 * not implement `listModels` or `testConnection` and must not override them.
 */
export abstract class BaseAiProvider implements AiProvider {
  /** Subclass's logger, so failures are attributed to the real provider. */
  protected abstract readonly logger: Logger;

  /**
   * Where a completed call is recorded (#37).
   *
   * DECLARED HERE RATHER THAN INJECTED, because this is an abstract class and
   * not a Nest provider — the concrete subclass injects the service and
   * exposes it, the same shape `logger` already uses. That keeps the recording
   * obligation on the base class, where the never-throw wrapper is, rather
   * than on each provider's own call sites, where it is one forgotten line
   * away from a user's consumption going unrecorded.
   */
  protected abstract readonly usage: AiUsageService;

  /** Which provider this is. Matches a member of `AI_PROVIDER_KINDS`. */
  abstract readonly kind: AiProviderKind;

  /**
   * The families this provider can serve.
   *
   * See `AiCapabilitySet` — this is the reason a future Anthropic provider
   * cannot be bound to the `speak` role by an admin who did not know it has no
   * speech API.
   */
  abstract readonly capabilities: AiCapabilitySet;

  /**
   * Short provider name for log lines and error prefixes: 'OpenAI'.
   *
   * Separate from {@link kind}, which is the persisted enum value. This one is
   * shown to a human.
   */
  protected abstract readonly providerName: string;

  /**
   * The voices this provider can speak in, as it hard-codes them (#283).
   *
   * A `readonly` FIELD RATHER THAN A `run*` HOOK, and the naming is the tell:
   * every `protected abstract` method below is prefixed `run` because it MAY
   * THROW and is wrapped by a never-throw public counterpart. This one cannot
   * throw — it is a literal array — so borrowing that prefix would advertise a
   * hazard that is not there and imply a wrapper that does not exist.
   *
   * A provider with no `tts` capability declares `[]`. It may also declare a
   * list and simply not declare the capability; {@link listVoices} answers `[]`
   * for it either way, so the two cannot disagree on the wire.
   */
  protected abstract readonly speechVoices: readonly AiVoiceDescriptor[];

  /**
   * The id {@link BaseAiProvider.synthesize} falls back to when a request names
   * no voice, or `null` for a provider with no voices.
   *
   * MUST BE THE SAME CONSTANT THE SUBCLASS'S OWN `runSynthesis` DEFAULTS TO.
   * That is the whole point of the member existing: the picker's "this is what
   * you hear now" and the synthesiser's actual fallback are one value, so a
   * provider cannot end up telling a learner they are hearing Alloy while
   * speaking as Nova.
   */
  protected abstract readonly defaultSpeechVoice: string | null;

  /**
   * Can this provider serve `family`?
   *
   * Implemented once here rather than per provider: a subclass writing its own
   * membership test is a subclass that can get it subtly wrong while
   * `capabilities` says otherwise.
   */
  supports(family: AiCapabilityFamily): boolean {
    return this.capabilities.has(family);
  }

  /**
   * The provider's voices, or `[]` when it cannot speak at all (#283).
   *
   * IMPLEMENTED ONCE HERE, for the same reason {@link supports} is: the
   * capability check is the part a subclass would get subtly wrong — most
   * plausibly by omitting it and returning a list a chat-only provider can
   * never speak in — and the base class already owns that check for every
   * other capability-gated method on this surface.
   *
   * NO `try`/`catch`, deliberately, where {@link transcribe} and
   * {@link synthesize} both have one. There is nothing here to catch: no key,
   * no client, no I/O, no subclass code that runs. Wrapping it anyway would
   * suggest a failure mode readers should account for.
   *
   * A COPY IS RETURNED, so a caller that sorts or splices the list in place —
   * a picker rendering it alphabetically, say — cannot mutate the provider's
   * own declaration for every later request in the process.
   */
  listVoices(): AiVoiceDescriptor[] {
    if (!this.supports('tts')) return [];

    return [...this.speechVoices];
  }

  /**
   * The voice a synthesis request with no `voice` gets. See
   * {@link AiProvider.defaultVoice}.
   *
   * Gated on the capability for the same reason {@link listVoices} is: a
   * provider that cannot speak has no default to name, and `null` there says
   * exactly what `[]` says beside it.
   */
  defaultVoice(): string | null {
    if (!this.supports('tts')) return null;

    return this.defaultSpeechVoice;
  }

  // ---------------------------------------------------------------------------
  // Subclass surface — MAY THROW FREELY
  // ---------------------------------------------------------------------------

  /**
   * Fetch and classify the catalog using the server credential.
   *
   * MAY THROW FREELY — that is the point. Throwing here is how a subclass
   * reports "this cannot be done", and {@link listModels} turns it into a
   * result. A subclass therefore needs no try/catch, and adding one only makes
   * the error message worse than what this class already produces.
   *
   * @param redact register the API key here, IMMEDIATELY on obtaining it and
   *        before anything that can throw while holding it, so an error raised
   *        later cannot carry it out of the process.
   * @returns the catalog, or `null` to mean "no credential is stored" — which
   *        is not a failure and must not be reported as one.
   */
  protected abstract fetchModels(
    redact: SecretRedactor,
  ): Promise<AiModelCatalogResult | null>;

  /**
   * Authenticate `apiKey` and probe each requested model on it.
   *
   * MAY THROW FREELY, as {@link fetchModels} may.
   *
   * @param apiKey the key under test. The caller has already registered it
   *        with `redact`; a subclass need not, though doing so again is
   *        harmless.
   */
  protected abstract probeConnection(
    apiKey: string,
    probes: AiReachabilityRequest[],
    redact: SecretRedactor,
  ): Promise<AiConnectionTestResult>;

  /**
   * Run one completion on the caller's key.
   *
   * MAY THROW FREELY, as the other two hooks may. {@link complete} turns a
   * throw into a recorded failure with NULL token counts.
   *
   * @param redact the key is already registered by {@link complete}.
   */
  protected abstract runCompletion(
    apiKey: string,
    request: AiCompletionRequest,
    redact: SecretRedactor,
  ): Promise<AiCompletionResult>;

  /**
   * Run one completion constrained to a JSON schema, on the caller's key.
   *
   * MAY THROW FREELY, as every hook above may. {@link completeStructured}
   * turns a throw into a recorded failure with NULL token counts.
   *
   * RETURNS THE RAW TEXT, NOT A PARSED OBJECT. Parsing and validating happen
   * once in {@link completeStructured}, because they are where two of this
   * surface's three failure modes live (`invalid_json`,
   * `schema_validation_failed`) and a provider that parsed its own reply is a
   * provider that can classify those differently from the next one. It is also
   * the only place that knows the raw text must not reach an error string.
   *
   * @param jsonSchema `request.schema` already converted, so a subclass never
   *        touches zod and cannot convert it with different options than the
   *        validation on the way back was built from.
   * @param redact the key is already registered by {@link completeStructured}.
   * @returns the model's reply verbatim (`null` when it sent no content), and
   *        whatever usage the provider reported.
   */
  protected abstract runStructuredCompletion(
    apiKey: string,
    request: AiStructuredCompletionRequest<unknown>,
    jsonSchema: Record<string, unknown>,
    redact: SecretRedactor,
  ): Promise<{ raw: string | null; usage: AiUsage }>;

  /**
   * Open a streamed completion on the caller's key.
   *
   * MAY THROW FREELY, AND MAY THROW MID-ITERATION — which is the case that
   * matters, because a stream fails after it has started far more often than
   * before. {@link stream} catches both and turns them into the single
   * terminal `error` event.
   *
   * The yielded shape is deliberately loose (`{ delta?, usage? }`) rather than
   * the public {@link AiStreamEvent}: a provider reports fragments of a
   * response, and the terminal-event contract — exactly one, always last — is
   * not a fragment. Letting a subclass emit `done` would hand it the one
   * invariant this class exists to keep.
   *
   * @param request carries `stream: true` already; {@link stream} sets it, so
   *        a subclass cannot forget and silently issue a non-streamed call.
   * @param signal the caller's abort signal. Pass it to the provider's request
   *        options: without it an abandoned response keeps being generated and
   *        billed after the reader is gone.
   */
  protected abstract openStream(
    apiKey: string,
    request: AiCompletionRequest,
    redact: SecretRedactor,
    signal?: AbortSignal,
  ): AsyncIterable<{ delta?: string; usage?: AiUsage }>;

  /**
   * Turn one recording into text, on the caller's key.
   *
   * MAY THROW FREELY, as every hook above may. {@link transcribe} turns a
   * throw into a recorded failure with a NULL confidence and NULL token
   * counts — never a `confidence` of 0, which would assert the recogniser was
   * certain it heard nothing.
   *
   * ONLY CALLED WHEN THE PROVIDER DECLARES `'transcribe'`. The public method
   * checks {@link capabilities} first, so a subclass need not — and must not
   * answer the question a second time, differently.
   *
   * @param redact the key is already registered by {@link transcribe}.
   */
  protected abstract runTranscription(
    apiKey: string,
    request: AiTranscriptionRequest,
    redact: SecretRedactor,
  ): Promise<AiTranscriptionResult>;

  /**
   * Read one piece of text aloud, on the caller's key.
   *
   * MAY THROW FREELY. Only called when the provider declares `'tts'` — see
   * {@link runTranscription}.
   *
   * @param redact the key is already registered by {@link synthesize}.
   */
  protected abstract runSynthesis(
    apiKey: string,
    request: AiSynthesisRequest,
    redact: SecretRedactor,
  ): Promise<AiSynthesisResult>;

  /**
   * Mint one ephemeral realtime session credential on the caller's key.
   *
   * MAY THROW FREELY. Only called when the provider declares `'realtime'` —
   * see {@link runTranscription}.
   *
   * RETURN THE SECRET AND LET THE PUBLIC METHOD REGISTER IT. A hook that
   * called `redact.protect` on its own result would be doing the right thing
   * twice; one that forgot would leave a live bearer credential quotable in
   * any error raised after minting. {@link createRealtimeSession} registers it
   * the instant the result comes back, so a subclass has nothing to forget.
   *
   * @param redact the key is already registered by
   *        {@link createRealtimeSession}; the MINTED SECRET is registered
   *        there too, as soon as this hook returns it.
   */
  protected abstract runRealtimeSession(
    apiKey: string,
    request: AiRealtimeSessionRequest,
    redact: SecretRedactor,
  ): Promise<AiRealtimeSessionResult>;

  // ---------------------------------------------------------------------------
  // Public surface — NEVER THROWS. Do not override.
  // ---------------------------------------------------------------------------

  /**
   * Fetch the model catalog. NEVER throws.
   *
   * @see ./providers/ai-provider.interface.ts for why this contract exists.
   */
  async listModels(): Promise<AiModelCatalogResult> {
    const redact = new SecretRedactor();
    const span = tracer.startSpan(`${this.providerName}.listModels`);

    try {
      // `await` inside the try, not a returned promise: returning
      // `this.fetchModels(...)` would resolve the try block before the promise
      // settles, and a rejection would escape this catch entirely. This is the
      // single most likely way for someone to break the contract while
      // "simplifying" this method.
      const result = await this.fetchModels(redact);

      // `null` is the subclass's way of saying "no credential is stored".
      // NOT an error: this is the state of every fresh install, and reporting
      // it as a failure makes a brand-new system look broken.
      if (result === null) {
        span.setAttribute('ai.not_configured', true);
        span.setStatus({ code: SpanStatusCode.OK });
        return {
          success: false,
          models: [],
          error: null,
          notConfigured: true,
        };
      }

      // Normalise a malformed return. A subclass that falls off the end of a
      // branch yields `undefined`, and a caller reading `.models` on it throws
      // a TypeError one stack frame outside this try — a never-throw violation
      // with this class's name on it. Cheap to rule out here.
      if (typeof result !== 'object' || !Array.isArray(result.models)) {
        this.logger.error(
          `${this.providerName} provider returned no catalog object; treating as a failure`,
        );
        return this.failedCatalog(
          span,
          `${this.providerName} returned no catalog.`,
        );
      }

      if (!result.success) {
        // A subclass-authored failure still goes through redaction and
        // truncation, so there is exactly one exit path for error text.
        return this.failedCatalog(
          span,
          this.formatError(result.error ?? 'Unknown error.', redact),
        );
      }

      // STATUS FROM THE RESULT, not from reaching this line. See the header.
      span.setAttribute('ai.model_count', result.models.length);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      return this.failedCatalog(span, this.formatCaught(err, redact));
    } finally {
      span.end();
    }
  }

  /**
   * Test a key and its reachable models. NEVER throws.
   *
   * @see ./providers/ai-provider.interface.ts.
   */
  async testConnection(
    apiKey: string,
    probes: AiReachabilityRequest[],
  ): Promise<AiConnectionTestResult> {
    const redact = new SecretRedactor();

    // REGISTERED BEFORE ANYTHING THAT CAN THROW. The key is in hand right
    // here; every line after this one — the client construction, the DNS
    // lookup, the TLS handshake, the SDK's own error formatting — can raise a
    // string we did not author while holding it.
    redact.protect(apiKey);

    const span = tracer.startSpan(`${this.providerName}.testConnection`);
    span.setAttribute('ai.probe_count', probes.length);

    try {
      const result = await this.probeConnection(apiKey, probes, redact);

      if (typeof result !== 'object' || result === null) {
        this.logger.error(
          `${this.providerName} provider returned no test result; treating as a failure`,
        );
        return this.failedTest(
          span,
          `${this.providerName} returned no result.`,
          false,
        );
      }

      if (!result.success) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'connection test failed',
        });
        span.setAttribute('ai.authenticated', result.authenticated);

        return {
          ...result,
          // Every role error goes through the same single exit path, so a
          // subclass cannot emit an unredacted string by building one itself.
          roles: result.roles.map((role) => ({
            ...role,
            error: role.error ? this.formatError(role.error, redact) : null,
          })),
          error: this.formatError(result.error ?? 'Unknown error.', redact),
        };
      }

      span.setAttribute('ai.authenticated', true);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      return this.failedTest(span, this.formatCaught(err, redact), false);
    } finally {
      span.end();
    }
  }

  /**
   * Run one completion, and record it. NEVER throws.
   *
   * -------------------------------------------------------------------------
   * ONE ROW PER CALL, ON SUCCESS AND ON FAILURE ALIKE
   * -------------------------------------------------------------------------
   *
   * Recording lives HERE rather than at each provider's call sites, so a new
   * provider inherits it. A provider that recorded its own usage is a provider
   * that can forget to, and the symptom of forgetting is a user whose
   * consumption is simply missing — with nothing failing to draw attention to
   * it.
   *
   * -------------------------------------------------------------------------
   * NULL TOKEN COUNTS ARE PRESERVED. THEY ARE NOT ZEROED.
   * -------------------------------------------------------------------------
   *
   * A call that fails mid-stream yields partial or no usage. Writing `0` there
   * would be a claim — a false one that understates consumption, and an
   * invisible one, because zero is a perfectly plausible value. `null` means
   * "unknown", and `success`/`errorCode` are what distinguish the two.
   *
   * -------------------------------------------------------------------------
   * THE ROW ID COMES BACK OUT (#96)
   * -------------------------------------------------------------------------
   *
   * `usageEventId` is the `ai_usage_events` row this call wrote, so a caller
   * can point a foreign key at it — issue #110's
   * `practice_attempts.ai_usage_event_id`. `null` means the write failed, not
   * that none was attempted; the completion is returned either way, because
   * the user asked for an answer and not for bookkeeping.
   *
   * @param userId the caller whose key this runs on and whose row is written.
   */
  async complete(
    userId: string,
    apiKey: string,
    request: AiCompletionRequest,
  ): Promise<AiRecordedCompletionResult> {
    const redact = new SecretRedactor();

    // REGISTERED BEFORE ANYTHING THAT CAN THROW WHILE HOLDING IT.
    redact.protect(apiKey);

    const span = tracer.startSpan(`${this.providerName}.complete`);
    span.setAttribute('ai.model', request.modelId);
    span.setAttribute('ai.role', request.roleKey);
    span.setAttribute('ai.stream', request.stream === true);

    const startedAt = Date.now();
    let result: AiCompletionResult;

    try {
      result = await this.runCompletion(apiKey, request, redact);

      if (typeof result !== 'object' || result === null) {
        this.logger.error(
          `${this.providerName} provider returned no completion result; treating as a failure`,
        );
        result = {
          success: false,
          text: null,
          usage: EMPTY_USAGE,
          errorCode: 'malformed_result',
          error: `${this.providerName} returned no result.`,
        };
      } else if (!result.success) {
        // A subclass-authored failure still goes through the single exit path
        // for error text.
        result = {
          ...result,
          error: this.formatError(result.error ?? 'Unknown error.', redact),
        };
      }
    } catch (err) {
      result = {
        success: false,
        text: null,
        // UNKNOWN, not zero. A throw mid-stream may follow real consumption we
        // were never told about.
        usage: EMPTY_USAGE,
        errorCode: classifyThrow(err),
        error: this.formatCaught(err, redact),
      };
    }

    const latencyMs = Date.now() - startedAt;

    if (result.success) {
      span.setStatus({ code: SpanStatusCode.OK });
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'completion failed' });
      this.logger.warn(
        `${this.providerName} completion failed for user ${userId} (${request.roleKey}/${request.modelId}): ${result.error}`,
      );
    }

    // Token counts on the span too, so a trace answers "what did that cost"
    // without a database query. Only when known — an attribute of 0 would be
    // the same lie the column refuses.
    if (result.usage.totalTokens !== null) {
      span.setAttribute('ai.total_tokens', result.usage.totalTokens);
    }
    span.end();

    const usageEventId = await this.recordUsage(
      userId,
      request,
      result.usage,
      latencyMs,
      result.success,
      result.errorCode,
    );

    return { ...result, usageEventId };
  }

  /**
   * Run one schema-constrained completion, and record it. NEVER throws.
   *
   * -------------------------------------------------------------------------
   * THE SCHEMA IS A CONSTRAINT ON THE WAY OUT AND A CHECK ON THE WAY BACK
   * -------------------------------------------------------------------------
   *
   * `z.toJSONSchema` sends it to the provider, which will not emit a reply
   * violating it; `safeParse` then validates the reply anyway. That is not
   * belt-and-braces for its own sake — `response_format` is honoured by the
   * models we bind today and is not a property of every model an admin can
   * bind tomorrow, and the failure it prevents is silent: a reply shaped like
   * `{ "verdict": "maybe" }` flowing into a grader that branches on
   * `correct`/`incorrect` does not error, it grades wrongly.
   *
   * A reply that fails EITHER step is a failure with `data: null`. Never a
   * partial object — see {@link AiStructuredCompletionResult.data}.
   *
   * -------------------------------------------------------------------------
   * THE MODEL'S REPLY NEVER REACHES `error`, A LOG LINE OR A SPAN
   * -------------------------------------------------------------------------
   *
   * It is tempting: "expected JSON, got: <the reply>" is the single most useful
   * thing to see when this fails. It is also, in this application, a model's
   * commentary on what a learner typed during interview practice — the exact
   * material `ai_usage_events` was designed to have no column for. So the
   * failure messages below describe the SHAPE of the problem (not JSON; N zod
   * issues, of these kinds) and never quote the content. `ai.schema` on the
   * span is the schema's NAME for the same reason.
   */
  async completeStructured<T>(
    userId: string,
    apiKey: string,
    request: AiStructuredCompletionRequest<T>,
  ): Promise<AiStructuredCompletionResult<T>> {
    const redact = new SecretRedactor();

    // REGISTERED BEFORE ANYTHING THAT CAN THROW WHILE HOLDING IT.
    redact.protect(apiKey);

    const span = tracer.startSpan(`${this.providerName}.completeStructured`);
    span.setAttribute('ai.model', request.modelId);
    span.setAttribute('ai.role', request.roleKey);
    // THE NAME, NEVER THE SCHEMA ITSELF. A schema is a description of the
    // reply we are asking for, and on this surface that is a description of
    // what we ask a model to say about a learner.
    span.setAttribute('ai.schema', request.schemaName);

    const startedAt = Date.now();

    let data: T | null = null;
    let usage: AiUsage = EMPTY_USAGE;
    let errorCode: string | null = null;
    let error: string | null = null;

    try {
      // INSIDE THE TRY. `z.toJSONSchema` throws on a schema it cannot
      // represent — a transform, a custom refinement, a lazy cycle — and that
      // is a perfectly ordinary mistake for a caller to make. Built outside,
      // it would be the one line in this method that can take the process's
      // never-throw guarantee away.
      const jsonSchema = z.toJSONSchema(request.schema, {
        target: 'draft-7',
      }) as Record<string, unknown>;

      const outcome = await this.runStructuredCompletion(
        apiKey,
        request as AiStructuredCompletionRequest<unknown>,
        jsonSchema,
        redact,
      );

      if (typeof outcome !== 'object' || outcome === null) {
        // The same malformed-return guard the other public methods carry: a
        // subclass that falls off the end of a branch yields `undefined`, and
        // reading `.usage` off it throws one frame outside this try.
        this.logger.error(
          `${this.providerName} provider returned no structured result; treating as a failure`,
        );
        errorCode = 'malformed_result';
        error = `${this.providerName} returned no result.`;
      } else {
        usage = outcome.usage ?? EMPTY_USAGE;

        const parsed = parseJson(outcome.raw);

        if (!parsed.ok) {
          // An absent or empty body lands here too, and deliberately shares
          // the code: "the provider did not return the JSON we constrained it
          // to" is one operational problem with one remedy, and splitting it
          // in the usage table would only make the group smaller, not the
          // diagnosis better.
          errorCode = 'invalid_json';
          error = this.formatError(
            outcome.raw === null || outcome.raw.length === 0
              ? `The model returned no content for schema ${request.schemaName}.`
              : `The model's reply for schema ${request.schemaName} was not valid JSON.`,
            redact,
          );
        } else {
          const validated = request.schema.safeParse(parsed.value);

          if (validated.success) {
            data = validated.data;
          } else {
            errorCode = 'schema_validation_failed';
            error = this.formatError(
              `The model's reply did not match schema ${request.schemaName} (${describeIssues(
                validated.error,
              )}).`,
              redact,
            );
          }
        }
      }
    } catch (err) {
      // UNKNOWN USAGE, not zero — `usage` is left at whatever we were told
      // before the throw, which is all-null unless the provider had already
      // reported. See `complete`.
      errorCode = classifyThrow(err);
      error = this.formatCaught(err, redact);
    }

    const latencyMs = Date.now() - startedAt;
    const success = errorCode === null;

    if (success) {
      span.setStatus({ code: SpanStatusCode.OK });
    } else {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'structured completion failed',
      });
      this.logger.warn(
        `${this.providerName} structured completion failed for user ${userId} (${request.roleKey}/${request.modelId}, schema ${request.schemaName}): ${error}`,
      );
    }

    // Only when known. An attribute of 0 would be the same lie the column
    // refuses.
    if (usage.totalTokens !== null) {
      span.setAttribute('ai.total_tokens', usage.totalTokens);
    }
    span.end();

    const usageEventId = await this.recordUsage(
      userId,
      request,
      usage,
      latencyMs,
      success,
      errorCode,
    );

    return { success, data, usage, errorCode, error, usageEventId };
  }

  /**
   * Stream one completion, and record it. NEVER throws, and NEVER THROWS FROM
   * THE ITERATOR EITHER.
   *
   * -------------------------------------------------------------------------
   * EXACTLY ONE TERMINAL EVENT, ALWAYS LAST
   * -------------------------------------------------------------------------
   *
   * Every path out of this generator that a consumer can observe ends in one
   * `done` or one `error`. The consumer is an SSE endpoint: a throw out of the
   * iterator would skip the terminal event, and a browser waiting for one
   * holds the connection open forever — a tab spinning on a response that
   * already failed, and a server holding a socket for a request that is over.
   *
   * -------------------------------------------------------------------------
   * A MID-STREAM FAILURE RECORDS NULL, NEVER ZERO
   * -------------------------------------------------------------------------
   *
   * `usage` is assigned ONLY from a usage-bearing chunk, so a stream that
   * breaks before the provider reported anything records all-null: we were
   * never told what it cost, and `0` would state that it cost nothing. A
   * streamed call reports usage at all only because the provider side sets
   * `stream_options: { include_usage: true }` — omit that and every streamed
   * call records nothing, with no error and no warning to notice (#37). That
   * is why {@link openStream} is the single place a streaming request is
   * built, and why a test asserts the flag rather than trusting this comment.
   *
   * -------------------------------------------------------------------------
   * A CLIENT DISCONNECT STILL WRITES THE ROW (#120)
   * -------------------------------------------------------------------------
   *
   * A consumer that stops iterating — `break` out of a `for await`, a closed
   * tab, an aborted SSE response — calls the generator's `return()`, which
   * runs the `finally` below. The tokens were spent whether or not anyone read
   * them, so the row is written there. `recorded` is what makes it exactly
   * once: the normal and failing paths write it themselves, and the `finally`
   * only covers the abandoned one.
   *
   * @param signal aborts the upstream request, so an abandoned generation
   *        stops being produced and billed rather than running to completion
   *        into nobody.
   */
  async *stream(
    userId: string,
    apiKey: string,
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<AiStreamEvent, void, undefined> {
    const redact = new SecretRedactor();

    // REGISTERED BEFORE ANYTHING THAT CAN THROW WHILE HOLDING IT. Inside the
    // generator body rather than before it, because a generator's body does
    // not run until the first `next()` — a `protect` written above this line
    // would not have run yet when the first chunk is requested.
    redact.protect(apiKey);

    const span = tracer.startSpan(`${this.providerName}.stream`);
    span.setAttribute('ai.model', request.modelId);
    span.setAttribute('ai.role', request.roleKey);
    span.setAttribute('ai.stream', true);

    const startedAt = Date.now();

    // Assigned ONLY from a usage-bearing chunk. All-null until then, which is
    // the honest reading of "the provider has not told us".
    let usage: AiUsage = EMPTY_USAGE;
    let recorded = false;

    /** Write the row, at most once, whichever way this generator ends. */
    const recordOnce = async (
      success: boolean,
      errorCode: string | null,
    ): Promise<string | null> => {
      if (recorded) return null;
      recorded = true;

      return this.recordUsage(
        userId,
        request,
        usage,
        Date.now() - startedAt,
        success,
        errorCode,
      );
    };

    try {
      // `stream: true` IS SET HERE, not left to the caller and not left to the
      // subclass. A streamed call issued without it is a non-streamed call
      // that happens to work, and it would record its usage under the
      // streaming path's assumptions.
      const upstream = this.openStream(
        apiKey,
        { ...request, stream: true },
        redact,
        signal,
      );

      for await (const chunk of upstream) {
        if (chunk.usage) usage = chunk.usage;

        // Empty deltas are dropped rather than forwarded: the provider emits
        // role-only and finish-only chunks, and an SSE consumer appending
        // those is an SSE consumer sending empty frames to a browser.
        if (typeof chunk.delta === 'string' && chunk.delta.length > 0) {
          yield { type: 'delta', text: chunk.delta };
        }
      }

      const usageEventId = await recordOnce(true, null);

      if (usage.totalTokens !== null) {
        span.setAttribute('ai.total_tokens', usage.totalTokens);
      }
      span.setStatus({ code: SpanStatusCode.OK });

      yield { type: 'done', usage, usageEventId };
    } catch (err) {
      // ANY throw: from opening the stream, from the middle of the iteration,
      // from an `AbortError` raised by `signal`. All of them are the same
      // thing to the reader — the answer is not whole — and all of them leave
      // by the one terminal event.
      const errorCode = classifyThrow(err);
      const error = this.formatCaught(err, redact);
      const usageEventId = await recordOnce(false, errorCode);

      span.setStatus({ code: SpanStatusCode.ERROR, message: 'stream failed' });
      this.logger.warn(
        `${this.providerName} stream failed for user ${userId} (${request.roleKey}/${request.modelId}): ${error}`,
      );

      yield { type: 'error', errorCode, error, usage, usageEventId };
    } finally {
      // THE ABANDONED PATH (#120). Reached when the consumer called `return()`
      // on this generator before a terminal event — a `break`, a closed tab —
      // in which case neither branch above ran. Nothing is yielded here: a
      // generator being closed has no reader left to yield to.
      //
      // `success: false` because the completion did not finish, and a distinct
      // code so an operator reading the table can tell an abandoned stream
      // from a failed one. They are different problems: one is a user leaving,
      // the other is the provider.
      if (!recorded) {
        await recordOnce(false, 'client_disconnected');
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'stream abandoned by the consumer',
        });
      }

      span.end();
    }
  }

  /**
   * Turn one recording into text, and record it. NEVER throws.
   *
   * Built exactly as {@link complete} is, deliberately and line for line: the
   * key registered before anything that can throw, the `await` INSIDE the
   * `try`, the span's status taken from the RESULT rather than from reaching
   * the end of the method, every error string through {@link formatError}, and
   * one `ai_usage_events` row on success and on failure alike. A second,
   * hand-rolled version of that shape here would be a second place for the
   * never-throw guarantee to be narrowed by a later refactor.
   *
   * -------------------------------------------------------------------------
   * THE CAPABILITY GATE COMES FIRST, AND IT DOES NOT CALL OUT
   * -------------------------------------------------------------------------
   *
   * A provider that does not declare `'transcribe'` returns a failure carrying
   * `'capability_unsupported'` without a network call and WITHOUT a usage row:
   * nothing was attempted, and `ai_usage_events` records calls that happened.
   * An admin cannot normally bind `transcribe` to such a provider — the
   * settings write consults `supports()` — but a settings row written before a
   * deployment swapped providers still names one, and that must read as a
   * refusal rather than as a crash inside an SDK that has no such method.
   *
   * -------------------------------------------------------------------------
   * NOTHING HERE LOGS THE AUDIO OR THE TRANSCRIPT
   * -------------------------------------------------------------------------
   *
   * The span carries the model, the role, the byte length and the content
   * type — enough to diagnose "uploads are being rejected" or "the recordings
   * are all 44 bytes" — and nothing else. The recording is a learner's voice
   * and the transcript is what they said; neither has a column in
   * `ai_usage_events`, and neither belongs in a trace backend or a log line.
   * The only text this method emits is the redacted `error`.
   */
  async transcribe(
    userId: string,
    apiKey: string,
    request: AiTranscriptionRequest,
  ): Promise<AiTranscriptionResult> {
    const redact = new SecretRedactor();

    // REGISTERED BEFORE ANYTHING THAT CAN THROW WHILE HOLDING IT.
    redact.protect(apiKey);

    const span = tracer.startSpan(`${this.providerName}.transcribe`);
    span.setAttribute('ai.model', request.modelId);
    span.setAttribute('ai.role', request.roleKey);
    // SHAPE ONLY, NEVER CONTENT. See the doc comment.
    span.setAttribute('ai.audio_bytes', byteLength(request.audio));
    span.setAttribute('ai.audio_content_type', request.contentType ?? '');

    if (!this.supports('transcribe')) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'capability unsupported',
      });
      span.end();

      return {
        ...this.unsupported('speech recognition'),
        text: null,
        confidence: null,
      };
    }

    const startedAt = Date.now();
    let result: AiTranscriptionResult;

    try {
      // `await` INSIDE the try. Returning the promise would resolve this block
      // before it settled and let a rejection escape the catch entirely.
      result = await this.runTranscription(apiKey, request, redact);

      if (typeof result !== 'object' || result === null) {
        // A subclass that falls off the end of a branch yields `undefined`,
        // and a caller reading `.usage` off it throws one frame outside this
        // try — a never-throw violation with this class's name on it.
        this.logger.error(
          `${this.providerName} provider returned no transcription result; treating as a failure`,
        );
        result = {
          success: false,
          text: null,
          confidence: null,
          usage: EMPTY_USAGE,
          errorCode: 'malformed_result',
          error: `${this.providerName} returned no result.`,
        };
      } else if (!result.success) {
        // A subclass-authored failure still goes through the single exit path
        // for error text, and is forced back onto the null-not-zero contract:
        // a failed call knows nothing about what was heard.
        result = {
          ...result,
          text: null,
          confidence: null,
          error: this.formatError(result.error ?? 'Unknown error.', redact),
        };
      }
    } catch (err) {
      result = {
        success: false,
        text: null,
        // UNKNOWN, not 0. A confidence of 0 asserts the recogniser was certain
        // it heard nothing — see `AiTranscriptionResult.confidence`.
        confidence: null,
        usage: EMPTY_USAGE,
        errorCode: classifyThrow(err),
        error: this.formatCaught(err, redact),
      };
    }

    const latencyMs = Date.now() - startedAt;

    if (result.success) {
      span.setStatus({ code: SpanStatusCode.OK });
    } else {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'transcription failed',
      });
      // THE ERROR, NEVER THE TRANSCRIPT. `result.error` is already redacted
      // and truncated — it is the only kind of text this class emits.
      this.logger.warn(
        `${this.providerName} transcription failed for user ${userId} (${request.roleKey}/${request.modelId}): ${result.error}`,
      );
    }

    if (result.usage.totalTokens !== null) {
      span.setAttribute('ai.total_tokens', result.usage.totalTokens);
    }
    span.end();

    // THE ROW IS WRITTEN, THE ID IS NOT SURFACED. `recordUsage` returns it
    // because `complete` needs it for `practice_attempts.ai_usage_event_id`;
    // no caller stores a foreign key to a speech call today, so
    // `AiTranscriptionResult` carries no `usageEventId` field to put it in.
    // Add one when a caller needs the FK — not before, because a nullable id
    // nobody reads is a field every future caller has to decide about.
    await this.recordUsage(
      userId,
      request,
      result.usage,
      latencyMs,
      result.success,
      result.errorCode,
    );

    return result;
  }

  /**
   * Read one piece of text aloud, and record it. NEVER throws.
   *
   * The same construction as {@link transcribe}, with the same capability gate
   * (on `'tts'`) and the same usage-row obligation. The span carries the model,
   * the role and the produced byte count; it does not carry the text, which on
   * this surface is ours rather than a learner's but is still content with no
   * diagnostic value.
   */
  async synthesize(
    userId: string,
    apiKey: string,
    request: AiSynthesisRequest,
  ): Promise<AiSynthesisResult> {
    const redact = new SecretRedactor();

    // REGISTERED BEFORE ANYTHING THAT CAN THROW WHILE HOLDING IT.
    redact.protect(apiKey);

    const span = tracer.startSpan(`${this.providerName}.synthesize`);
    span.setAttribute('ai.model', request.modelId);
    span.setAttribute('ai.role', request.roleKey);
    // LENGTH, NOT THE TEXT.
    span.setAttribute('ai.text_length', request.text?.length ?? 0);

    if (!this.supports('tts')) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'capability unsupported',
      });
      span.end();

      return {
        ...this.unsupported('speech synthesis'),
        audio: null,
        contentType: null,
      };
    }

    const startedAt = Date.now();
    let result: AiSynthesisResult;

    try {
      result = await this.runSynthesis(apiKey, request, redact);

      if (typeof result !== 'object' || result === null) {
        this.logger.error(
          `${this.providerName} provider returned no synthesis result; treating as a failure`,
        );
        result = {
          success: false,
          audio: null,
          contentType: null,
          usage: EMPTY_USAGE,
          errorCode: 'malformed_result',
          error: `${this.providerName} returned no result.`,
        };
      } else if (!result.success) {
        result = {
          ...result,
          audio: null,
          contentType: null,
          error: this.formatError(result.error ?? 'Unknown error.', redact),
        };
      }
    } catch (err) {
      result = {
        success: false,
        audio: null,
        contentType: null,
        usage: EMPTY_USAGE,
        errorCode: classifyThrow(err),
        error: this.formatCaught(err, redact),
      };
    }

    const latencyMs = Date.now() - startedAt;

    if (result.success) {
      span.setAttribute('ai.audio_bytes', byteLength(result.audio));
      span.setStatus({ code: SpanStatusCode.OK });
    } else {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'synthesis failed',
      });
      this.logger.warn(
        `${this.providerName} synthesis failed for user ${userId} (${request.roleKey}/${request.modelId}): ${result.error}`,
      );
    }

    if (result.usage.totalTokens !== null) {
      span.setAttribute('ai.total_tokens', result.usage.totalTokens);
    }
    span.end();

    // As in `transcribe`: the row is written, the id is not surfaced.
    await this.recordUsage(
      userId,
      request,
      result.usage,
      latencyMs,
      result.success,
      result.errorCode,
    );

    return result;
  }

  /**
   * Mint one ephemeral realtime session credential, and record it. NEVER
   * throws (#156, epic #60).
   *
   * The same construction as {@link synthesize}, line for line, with the same
   * capability gate (on `'realtime'`) and the same usage-row obligation. The
   * span carries the model and the role; it does not carry the instructions,
   * the tool list, or — emphatically — the minted secret.
   *
   * -------------------------------------------------------------------------
   * THE MINTED SECRET IS REGISTERED WITH THE REDACTOR THE MOMENT IT EXISTS
   * -------------------------------------------------------------------------
   *
   * Everywhere else on this class, the only thing worth redacting arrives
   * BEFORE the call — the API key, registered on the first line. Here a second
   * credential comes back FROM it, and it is a live bearer token for as long
   * as it is valid: anything that throws afterwards (the usage write, a
   * logger, a future edit between here and the return) could otherwise quote
   * it into an error string that reaches a log aggregator which retains far
   * longer than the secret's own lifetime.
   *
   * So `redact.protect(result.clientSecret)` runs the instant the hook
   * returns — on the failure branch as well as the success one, because a hook
   * that minted a secret and then failed may name it in its own error text,
   * and `formatError` is the last thing that reads that text. It costs nothing
   * when there is no secret to register, and it is the difference between a
   * short-lived credential and a logged one when there is.
   */
  async createRealtimeSession(
    userId: string,
    apiKey: string,
    request: AiRealtimeSessionRequest,
  ): Promise<AiRealtimeSessionResult> {
    const redact = new SecretRedactor();

    // REGISTERED BEFORE ANYTHING THAT CAN THROW WHILE HOLDING IT.
    redact.protect(apiKey);

    const span = tracer.startSpan(`${this.providerName}.createRealtimeSession`);
    span.setAttribute('ai.model', request.modelId);
    span.setAttribute('ai.role', request.roleKey);
    // NO OTHER ATTRIBUTE. Not the instructions (our officer prompt, but still
    // content), not the tool names, and never the secret this call produces —
    // see the doc comment.

    if (!this.supports('realtime')) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'capability unsupported',
      });
      span.end();

      return {
        ...this.unsupported('realtime sessions'),
        clientSecret: null,
        expiresAt: null,
        modelId: null,
      };
    }

    const startedAt = Date.now();
    let result: AiRealtimeSessionResult;

    try {
      result = await this.runRealtimeSession(apiKey, request, redact);

      if (typeof result !== 'object' || result === null) {
        this.logger.error(
          `${this.providerName} provider returned no realtime session result; treating as a failure`,
        );
        result = {
          success: false,
          clientSecret: null,
          expiresAt: null,
          modelId: null,
          usage: EMPTY_USAGE,
          errorCode: 'malformed_result',
          error: `${this.providerName} returned no result.`,
        };
      } else {
        // THE LINE THIS METHOD HAS THAT `synthesize` DOES NOT, and it runs on
        // BOTH branches. On success it is the point after which no error
        // string can quote the live secret back; on a subclass-authored
        // failure it covers the case of a hook that minted a secret and then
        // decided the call had failed, whose own error text may well name what
        // it was holding — `formatError` below is the last thing that reads
        // that text, so the registration has to come first.
        //
        // `protect` ignores null and empty, so the ordinary failure path — no
        // secret at all — costs nothing.
        redact.protect(result.clientSecret);

        if (!result.success) {
          // A subclass-authored failure goes through the single exit path for
          // error text and is forced back onto the null payload: a failed mint
          // has no session, whatever fields it thought to populate.
          result = {
            ...result,
            clientSecret: null,
            expiresAt: null,
            modelId: null,
            error: this.formatError(result.error ?? 'Unknown error.', redact),
          };
        }
      }
    } catch (err) {
      result = {
        success: false,
        clientSecret: null,
        expiresAt: null,
        modelId: null,
        usage: EMPTY_USAGE,
        errorCode: classifyThrow(err),
        error: this.formatCaught(err, redact),
      };
    }

    const latencyMs = Date.now() - startedAt;

    if (result.success) {
      span.setStatus({ code: SpanStatusCode.OK });
    } else {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'realtime session failed',
      });
      this.logger.warn(
        `${this.providerName} realtime session failed for user ${userId} (${request.roleKey}/${request.modelId}): ${result.error}`,
      );
    }

    if (result.usage.totalTokens !== null) {
      span.setAttribute('ai.total_tokens', result.usage.totalTokens);
    }
    span.end();

    // As in `transcribe` and `synthesize`: the row is written, the id is not
    // surfaced. The row records that a session was MINTED — the tokens the
    // conversation then spends are billed to the learner's key by a browser
    // this process never hears from, which is why `usage` here is all-null
    // rather than a number this class could invent.
    await this.recordUsage(
      userId,
      request,
      result.usage,
      latencyMs,
      result.success,
      result.errorCode,
    );

    return result;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Write the `ai_usage_events` row for one call, and hand back its id.
   *
   * -------------------------------------------------------------------------
   * A FAILED USAGE WRITE MUST NEVER FAIL THE USER'S REQUEST
   * -------------------------------------------------------------------------
   *
   * `AiUsageService.record` already swallows internally, and this catch is
   * deliberately belt-and-braces on top of that rather than redundant: the
   * guarantee belongs to THIS class, which is what the user's request runs
   * through. Trusting the recorder alone means a different recorder — a test
   * double, a future implementation, an injected decorator — silently takes
   * the guarantee away, and the symptom would be a user losing a tutor
   * explanation because an accounting row could not be written.
   *
   * SHARED BY ALL THREE PUBLIC INFERENCE METHODS (#96) rather than repeated
   * three times. Recording is the obligation that has no symptom when it is
   * skipped — nothing fails, a user's consumption is simply absent — so the
   * version of this code that gets forgotten in one branch is the version that
   * is never noticed.
   *
   * @returns the row id, or `null` when the write failed. `null` is not "no
   *        row was needed": every call writes one.
   */
  private async recordUsage(
    userId: string,
    // STRUCTURAL, NOT `AiCompletionRequest`. The row is built from exactly two
    // of its fields, and the speech surfaces (#88) carry those two while
    // carrying no `messages` at all — a chat-shaped parameter here would have
    // forced a speech request to invent an empty message list to satisfy a
    // type that never reads it.
    request: { roleKey: string; modelId: string },
    usage: AiUsage,
    latencyMs: number,
    success: boolean,
    errorCode: string | null,
  ): Promise<string | null> {
    try {
      return await this.usage.record({
        userId,
        provider: this.kind,
        model: request.modelId,
        roleKey: request.roleKey,
        usage,
        latencyMs,
        success,
        errorCode,
      });
    } catch (err) {
      // The user id and the model are enough to find the gap. Nothing about
      // the content of the call is available here to leak.
      this.logger.error(
        `Failed to record AI usage for user ${userId} (${request.modelId}/${request.roleKey}): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );

      return null;
    }
  }

  /**
   * The common half of a "this provider cannot do that" failure.
   *
   * SHARED BY THE TWO SPEECH METHODS AND BY {@link createRealtimeSession} so
   * the code, the usage shape and the wording cannot drift apart into three
   * subtly different refusals. Each caller spreads
   * it and adds its own null payload fields, because those differ by surface.
   *
   * ALL-NULL USAGE, and here that is not the usual "we were not told" — it is
   * "there was nothing to tell": no request left this process. No row is
   * written for it either; see {@link transcribe}.
   *
   * @param capability the human name of the missing capability, so the message
   *        an admin reads names the thing to fix.
   */
  private unsupported(capability: string): {
    success: false;
    usage: AiUsage;
    errorCode: string;
    error: string;
  } {
    return {
      success: false,
      usage: EMPTY_USAGE,
      errorCode: 'capability_unsupported',
      // Not run through `formatError`: this sentence is authored here, holds
      // nothing to redact, and already names the provider.
      error: `${this.providerName} does not support ${capability}.`,
    };
  }

  /**
   * One place a failed catalog is built, so the span, the log line and the
   * result shape can never disagree.
   */
  private failedCatalog(
    span: ReturnType<typeof tracer.startSpan>,
    error: string,
  ): AiModelCatalogResult {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'catalog failed' });

    // `warn`, not `error`: a misconfigured provider is an operator problem the
    // operator is actively looking at, not a fault of this service. The text
    // is already redacted — it is the only kind this class emits.
    this.logger.warn(`${this.providerName} catalog fetch failed: ${error}`);

    return { success: false, models: [], error, notConfigured: false };
  }

  /** The same, for a failed connection test. */
  private failedTest(
    span: ReturnType<typeof tracer.startSpan>,
    error: string,
    authenticated: boolean,
  ): AiConnectionTestResult {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'test failed' });
    span.setAttribute('ai.authenticated', authenticated);

    this.logger.warn(`${this.providerName} connection test failed: ${error}`);

    return { success: false, authenticated, roles: [], error };
  }

  /**
   * Turn a caught value into a redacted, truncated, labelled string.
   *
   * Never `JSON.stringify(err)`: a thrown object could be an SDK request
   * context holding the credentials it was built with.
   */
  private formatCaught(err: unknown, redact: SecretRedactor): string {
    return this.formatError(
      err instanceof Error
        ? err.message || err.name
        : typeof err === 'string'
          ? err
          : `Non-Error value of type ${typeof err} thrown.`,
      redact,
    );
  }

  /**
   * Single choke point for every error string this class emits: redact, then
   * truncate, then label with the provider.
   *
   * ORDER MATTERS. Truncating before redacting could cut a secret in half and
   * leave the tail intact in the message.
   */
  private formatError(raw: string, redact: SecretRedactor): string {
    // Always prefixed with the provider: an admin page shows this text with no
    // other context, and "Invalid API key" means something different depending
    // on which provider said it.
    return `${this.providerName}: ${truncateProviderError(redact.apply(raw))}`;
  }
}

// -----------------------------------------------------------------------------
// Structured-reply helpers
// -----------------------------------------------------------------------------

/**
 * Parse a model's reply, reporting failure as a value rather than a throw.
 *
 * A separate function so `completeStructured`'s own `try` keeps meaning "the
 * provider call failed". A `JSON.parse` inside it would land in the same catch
 * and be classified by {@link classifyThrow}, turning "the model did not
 * answer in JSON" into the generic `error` code — the one distinction the
 * `invalid_json` code exists to preserve.
 *
 * THE PARSED VALUE IS RETURNED, NOT LOGGED. Nothing here touches the text
 * beyond parsing it; see `completeStructured` for why the reply must not reach
 * an error string.
 */
function parseJson(
  raw: string | null,
): { ok: true; value: unknown } | { ok: false } {
  if (raw === null || raw.length === 0) return { ok: false };

  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Describe a validation failure WITHOUT quoting anything the model wrote.
 *
 * This is narrower than it looks, on purpose. The obvious message —
 * "expected string at `verdict`, received 42" — is the useful one and is not
 * available: zod's own issue messages can quote received values, and even an
 * issue PATH is model-derived when the schema contains a `z.record()`, whose
 * keys come from the reply. On this surface the reply is a model's commentary
 * on what a learner typed during interview practice, and an error string is
 * the one field of the result that reaches a log.
 *
 * So what is emitted is the part that provably comes from OUR schema and not
 * from the model: how many issues there were, and which KINDS of issue they
 * were. `2 issues: invalid_type, too_small` says "the reply is the wrong
 * shape, in these ways" — which is what an operator watching this fail
 * repeatedly needs — while carrying nothing to redact.
 */
function describeIssues(error: z.ZodError): string {
  const kinds = [...new Set(error.issues.map((issue) => issue.code))].sort();
  const count = error.issues.length;

  return `${count} ${count === 1 ? 'issue' : 'issues'}: ${kinds.join(', ')}`;
}

/**
 * The size of a buffer that may not be one.
 *
 * A span attribute is the ONE thing derived from audio on these paths (see
 * `BaseAiProvider.transcribe`), and a caller handing in `undefined` — or a
 * subclass returning a malformed result — must not turn that attribute into a
 * TypeError inside the class whose entire promise is that it does not throw.
 */
function byteLength(buffer: Buffer | null | undefined): number {
  return Buffer.isBuffer(buffer) ? buffer.length : 0;
}

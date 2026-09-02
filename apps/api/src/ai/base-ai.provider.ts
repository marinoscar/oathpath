import type { Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';

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
// subclasses implement `fetchModels` / `probeConnection` instead. A provider
// subclass contains no try/catch at all and has no public method to get wrong;
// the entire never-throw contract is this file.
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
   * Can this provider serve `family`?
   *
   * Implemented once here rather than per provider: a subclass writing its own
   * membership test is a subclass that can get it subtly wrong while
   * `capabilities` says otherwise.
   */
  supports(family: AiCapabilityFamily): boolean {
    return this.capabilities.has(family);
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
   * @param userId the caller whose key this runs on and whose row is written.
   */
  async complete(
    userId: string,
    apiKey: string,
    request: AiCompletionRequest,
  ): Promise<AiCompletionResult> {
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

    // A FAILED USAGE WRITE MUST NEVER FAIL THE USER'S REQUEST.
    //
    // `AiUsageService.record` already swallows internally, and this catch is
    // deliberately belt-and-braces on top of that rather than redundant: the
    // guarantee belongs to THIS method, which is the one the user's request
    // runs through. Trusting the recorder alone means a different recorder — a
    // test double, a future implementation, an injected decorator — silently
    // takes the guarantee away, and the symptom would be a user losing a tutor
    // explanation because an accounting row could not be written.
    try {
      await this.usage.record({
        userId,
        provider: this.kind,
        model: request.modelId,
        roleKey: request.roleKey,
        usage: result.usage,
        latencyMs,
        success: result.success,
        errorCode: result.errorCode,
      });
    } catch (err) {
      // The user id and the model are enough to find the gap. Nothing about
      // the content of the call is available here to leak.
      this.logger.error(
        `Failed to record AI usage for user ${userId} (${request.modelId}/${request.roleKey}): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

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

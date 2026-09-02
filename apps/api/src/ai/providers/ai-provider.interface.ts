import type { AiCapabilityFamily } from '../ai-model-roles';
import type { AiProviderKind } from '../ai-settings.schema';
import type {
  AiConnectionTestResult,
  AiModelCatalogResult,
  AiReachabilityRequest,
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
// WHY, concretely and specifically here: two of the three callers are
// DIAGNOSTIC endpoints. `POST /api/ai-settings/test` and
// `POST /api/ai/key/test` exist to answer "why is this not working", and this
// app's error envelope (`HttpExceptionFilter`) suppresses detail in production
// while the web client funnels a non-2xx into generic failure handling. A
// thrown error would therefore discard the one fact the endpoint exists to
// produce. The third caller is the model-catalog fetch behind an admin page,
// where a throw takes down the only screen capable of fixing the problem.
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
}

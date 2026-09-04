import { Logger } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { z } from 'zod';

import type { SecretRedactor } from '../common/crypto/secret-redactor';
import { MAX_PROVIDER_ERROR_LENGTH } from '../common/crypto/secret-redactor';
import { BaseAiProvider } from './base-ai.provider';
import type { AiProviderKind } from './ai-settings.schema';
import type { AiCapabilityFamily } from './ai-model-roles';
import type { AiCapabilitySet } from './providers/ai-provider.interface';
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiConnectionTestResult,
  AiModelCatalogResult,
  AiReachabilityRequest,
  AiRealtimeSessionRequest,
  AiRealtimeSessionResult,
  AiStreamEvent,
  AiStructuredCompletionRequest,
  AiSynthesisRequest,
  AiSynthesisResult,
  AiTranscriptionRequest,
  AiTranscriptionResult,
  AiUsage,
} from './ai.types';
import type { AiUsageService } from './ai-usage.service';
// Imported for its VALUE, not its type: the constant is `true` only while the
// compile-time proof in ai.types.ts resolves, so naming it here is what turns
// that proof into a test this suite runs. See the realtime section below.
import { AI_REALTIME_CARRIES_NO_LONG_LIVED_KEY } from './ai.types';

// =============================================================================
// BaseAiProvider (issue #28, epic #25)
// =============================================================================
//
// This class exists for one guarantee — no public method throws — and the
// tests below are almost entirely about the ways a subclass might otherwise
// break it: throwing, rejecting, returning nothing, or returning a
// hand-built failure whose error text never went through redaction.
//
// The other two claims tested here are capability gating (a provider that does
// not declare a family cannot be selected for it) and that a key registered
// with the redactor cannot escape in any error string this class emits.
//
// -----------------------------------------------------------------------------
// #96 ADDS TWO MORE SURFACES WITH THE SAME GUARANTEE AND HARDER SHAPES
// -----------------------------------------------------------------------------
//
// `completeStructured` has two failure modes that are not throws at all — a
// reply that is not JSON, and a reply that is JSON of the wrong shape — and the
// claim tested here is that neither becomes an exception and neither yields a
// half-populated `data`.
//
// `stream` is an async generator, which has four exits rather than one: a throw
// before the first chunk, a throw between chunks, normal completion, and being
// ABANDONED when the consumer stops iterating. The tests below cover all four,
// and assert the two invariants that make an SSE endpoint safe to build on top
// — exactly one terminal event, always last, and exactly one usage row.
// =============================================================================

/** The inference hooks, supplied only by the tests that exercise them. */
interface InferenceHooks {
  onStructured?: (
    apiKey: string,
    request: AiStructuredCompletionRequest<unknown>,
    jsonSchema: Record<string, unknown>,
    redact: SecretRedactor,
  ) => Promise<{ raw: string | null; usage: AiUsage }>;

  onStream?: (
    apiKey: string,
    request: AiCompletionRequest,
    redact: SecretRedactor,
    signal?: AbortSignal,
  ) => AsyncIterable<{ delta?: string; usage?: AiUsage }>;

  /** The speech hooks (#88, epic #58). */
  onTranscribe?: (
    apiKey: string,
    request: AiTranscriptionRequest,
    redact: SecretRedactor,
  ) => Promise<AiTranscriptionResult>;

  onSynthesize?: (
    apiKey: string,
    request: AiSynthesisRequest,
    redact: SecretRedactor,
  ) => Promise<AiSynthesisResult>;

  /** The realtime mint hook (#156, epic #60). */
  onRealtime?: (
    apiKey: string,
    request: AiRealtimeSessionRequest,
    redact: SecretRedactor,
  ) => Promise<AiRealtimeSessionResult>;
}

/** A stub whose subclass hooks are supplied per test. */
class StubProvider extends BaseAiProvider {
  protected readonly logger = new Logger('StubProvider');
  readonly kind: AiProviderKind = 'openai';
  protected readonly providerName = 'Stub';

  /**
   * The recorder, exposed so a test can assert on the row this class writes.
   *
   * Returning an id rather than `undefined` because that is what
   * `AiUsageService.record` returns since #96 — a test double that returned
   * nothing would let `usageEventId` be silently dropped everywhere.
   */
  readonly record = jest.fn().mockResolvedValue('usage-row-1');
  protected readonly usage = {
    record: this.record,
  } as unknown as AiUsageService;

  constructor(
    readonly capabilities: AiCapabilitySet,
    private readonly onFetch: (
      redact: SecretRedactor,
    ) => Promise<AiModelCatalogResult | null>,
    private readonly onProbe: (
      apiKey: string,
      probes: AiReachabilityRequest[],
      redact: SecretRedactor,
    ) => Promise<AiConnectionTestResult>,
    private readonly hooks: InferenceHooks = {},
  ) {
    super();
  }

  protected fetchModels(redact: SecretRedactor) {
    return this.onFetch(redact);
  }

  protected probeConnection(
    apiKey: string,
    probes: AiReachabilityRequest[],
    redact: SecretRedactor,
  ) {
    return this.onProbe(apiKey, probes, redact);
  }

  protected async runCompletion(): Promise<AiCompletionResult> {
    throw new Error('not exercised here — see ai-usage.spec.ts');
  }

  protected runStructuredCompletion(
    apiKey: string,
    request: AiStructuredCompletionRequest<unknown>,
    jsonSchema: Record<string, unknown>,
    redact: SecretRedactor,
  ): Promise<{ raw: string | null; usage: AiUsage }> {
    if (!this.hooks.onStructured) {
      throw new Error('this test did not supply a structured hook');
    }
    return this.hooks.onStructured(apiKey, request, jsonSchema, redact);
  }

  protected openStream(
    apiKey: string,
    request: AiCompletionRequest,
    redact: SecretRedactor,
    signal?: AbortSignal,
  ): AsyncIterable<{ delta?: string; usage?: AiUsage }> {
    if (!this.hooks.onStream) {
      throw new Error('this test did not supply a stream hook');
    }
    return this.hooks.onStream(apiKey, request, redact, signal);
  }

  /**
   * How many times each speech hook was entered.
   *
   * Counted rather than inferred from a result, because the capability tests
   * below assert that the hook was NOT REACHED AT ALL — a failure result on
   * its own cannot tell "refused before calling out" from "called out and
   * failed", and those are the two things that gate has to distinguish.
   */
  readonly speechHookCalls = { transcribe: 0, synthesize: 0, realtime: 0 };

  protected runTranscription(
    apiKey: string,
    request: AiTranscriptionRequest,
    redact: SecretRedactor,
  ): Promise<AiTranscriptionResult> {
    this.speechHookCalls.transcribe += 1;

    if (!this.hooks.onTranscribe) {
      throw new Error('this test did not supply a transcription hook');
    }
    return this.hooks.onTranscribe(apiKey, request, redact);
  }

  protected runSynthesis(
    apiKey: string,
    request: AiSynthesisRequest,
    redact: SecretRedactor,
  ): Promise<AiSynthesisResult> {
    this.speechHookCalls.synthesize += 1;

    if (!this.hooks.onSynthesize) {
      throw new Error('this test did not supply a synthesis hook');
    }
    return this.hooks.onSynthesize(apiKey, request, redact);
  }

  protected runRealtimeSession(
    apiKey: string,
    request: AiRealtimeSessionRequest,
    redact: SecretRedactor,
  ): Promise<AiRealtimeSessionResult> {
    this.speechHookCalls.realtime += 1;

    if (!this.hooks.onRealtime) {
      throw new Error('this test did not supply a realtime hook');
    }
    return this.hooks.onRealtime(apiKey, request, redact);
  }
}

const ALL: AiCapabilitySet = new Set<AiCapabilityFamily>([
  'text',
  'realtime',
  'transcribe',
  'tts',
  'embedding',
  'other',
]);

const TEXT_ONLY: AiCapabilitySet = new Set<AiCapabilityFamily>(['text']);

function provider(
  onFetch: (r: SecretRedactor) => Promise<AiModelCatalogResult | null>,
  onProbe: (
    k: string,
    p: AiReachabilityRequest[],
    r: SecretRedactor,
  ) => Promise<AiConnectionTestResult> = async () => ({
    success: true,
    authenticated: true,
    roles: [],
    error: null,
  }),
  capabilities: AiCapabilitySet = ALL,
  hooks: InferenceHooks = {},
) {
  return new StubProvider(capabilities, onFetch, onProbe, hooks);
}

/** A provider whose only interesting hook is the structured one. */
function structuredProvider(onStructured: InferenceHooks['onStructured']) {
  return provider(async () => OK_CATALOG, undefined, ALL, { onStructured });
}

/** A provider whose only interesting hook is the streaming one. */
function streamProvider(onStream: InferenceHooks['onStream']) {
  return provider(async () => OK_CATALOG, undefined, ALL, { onStream });
}

/** A provider whose only interesting hook is the transcription one (#88). */
function transcribeProvider(
  onTranscribe: InferenceHooks['onTranscribe'],
  capabilities: AiCapabilitySet = ALL,
) {
  return provider(async () => OK_CATALOG, undefined, capabilities, {
    onTranscribe,
  });
}

/** A provider whose only interesting hook is the synthesis one (#88). */
function synthesizeProvider(
  onSynthesize: InferenceHooks['onSynthesize'],
  capabilities: AiCapabilitySet = ALL,
) {
  return provider(async () => OK_CATALOG, undefined, capabilities, {
    onSynthesize,
  });
}

/** A provider whose only interesting hook is the realtime one (#156). */
function realtimeProvider(
  onRealtime: InferenceHooks['onRealtime'],
  capabilities: AiCapabilitySet = ALL,
) {
  return provider(async () => OK_CATALOG, undefined, capabilities, {
    onRealtime,
  });
}

const OK_CATALOG: AiModelCatalogResult = {
  success: true,
  models: [],
  error: null,
  notConfigured: false,
};

beforeAll(() => {
  // The class logs a warning on every failure path, which is correct
  // behaviour and noise in a test run.
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('BaseAiProvider — never-throw', () => {
  it('turns a thrown Error into a failure result', () => {
    const p = provider(async () => {
      throw new Error('the sky fell');
    });

    return expect(p.listModels()).resolves.toEqual({
      success: false,
      models: [],
      error: 'Stub: the sky fell',
      notConfigured: false,
    });
  });

  it('turns a rejected promise into a failure result', async () => {
    // The `await`-inside-the-try case. Returning `this.fetchModels(...)`
    // instead would resolve the try block before the promise settled and let
    // this rejection escape.
    const p = provider(() => Promise.reject(new Error('async boom')));

    await expect(p.listModels()).resolves.toMatchObject({
      success: false,
      error: 'Stub: async boom',
    });
  });

  it('turns a thrown non-Error into a failure result without stringifying it', async () => {
    // Never `JSON.stringify(err)`: a thrown object could be an SDK request
    // context holding the credentials it was built with.
    const leaky = { apiKey: 'sk-should-never-appear' };
    const p = provider(async () => {
      throw leaky;
    });

    const result = await p.listModels();
    expect(result.success).toBe(false);
    expect(result.error).toBe('Stub: Non-Error value of type object thrown.');
    expect(result.error).not.toContain('sk-should-never-appear');
  });

  it('turns a malformed subclass return into a failure result', async () => {
    // A subclass that falls off the end of a branch yields `undefined`, and a
    // caller reading `.models` on it throws one frame outside the try.
    const p = provider(async () => undefined as unknown as AiModelCatalogResult);

    // Authored by this class, not by the provider — so it carries no
    // provider prefix and needs no redaction, matching how
    // `BaseEmailProvider` reports the same malformed-return case.
    await expect(p.listModels()).resolves.toMatchObject({
      success: false,
      error: 'Stub returned no catalog.',
      notConfigured: false,
    });
  });

  it('never throws from testConnection either', async () => {
    const p = provider(
      async () => OK_CATALOG,
      async () => {
        throw new Error('probe exploded');
      },
    );

    await expect(p.testConnection('sk-x', [])).resolves.toEqual({
      success: false,
      authenticated: false,
      roles: [],
      error: 'Stub: probe exploded',
    });
  });
});

describe('BaseAiProvider — "not configured" is not a failure', () => {
  it('reports notConfigured when the subclass returns null', async () => {
    // The state of every fresh install. Reporting it as an error would make a
    // brand-new system look broken.
    const p = provider(async () => null);

    await expect(p.listModels()).resolves.toEqual({
      success: false,
      models: [],
      error: null,
      notConfigured: true,
    });
  });

  it('distinguishes it from a real failure, which carries an error', async () => {
    const p = provider(async () => ({
      success: false,
      models: [],
      error: 'key revoked',
      notConfigured: false,
    }));

    const result = await p.listModels();
    expect(result.notConfigured).toBe(false);
    expect(result.error).toBe('Stub: key revoked');
  });
});

describe('BaseAiProvider — redaction', () => {
  it('scrubs a key registered by the subclass out of a thrown message', async () => {
    const key = 'sk-live-abcdefghijklmnop';
    const p = provider(async (redact) => {
      // Registered at the instant it is obtained, BEFORE anything that throws.
      redact.protect(key);
      throw new Error(`Request failed with Authorization: Bearer ${key}`);
    });

    const result = await p.listModels();
    expect(result.error).not.toContain(key);
    expect(result.error).toContain('[redacted]');
  });

  it('scrubs the tested key without the subclass having to register it', async () => {
    // `testConnection` protects the key itself, before the client is even
    // built — the one place the base class can guarantee the ordering.
    const key = 'sk-user-zyxwvutsrqponml';
    const p = provider(
      async () => OK_CATALOG,
      async () => {
        throw new Error(`401 Incorrect API key provided: ${key}`);
      },
    );

    const result = await p.testConnection(key, []);
    expect(result.error).not.toContain(key);
    expect(result.error).toContain('[redacted]');
  });

  it('scrubs a subclass-authored failure string too', async () => {
    // A hand-built `{ success: false, error }` must not bypass the exit path.
    const key = 'sk-authored-1234567890';
    const p = provider(async (redact) => {
      redact.protect(key);
      return {
        success: false,
        models: [],
        error: `rejected key ${key}`,
        notConfigured: false,
      };
    });

    const result = await p.listModels();
    expect(result.error).not.toContain(key);
  });

  it('scrubs per-role errors on a failed connection test', async () => {
    // Each role's message goes through the same single exit path, so a
    // subclass cannot emit an unredacted string by building one itself.
    const key = 'sk-per-role-987654321';
    const p = provider(
      async () => OK_CATALOG,
      async () => ({
        success: false,
        authenticated: true,
        roles: [
          {
            roleKey: 'grader',
            modelId: 'gpt-5.4-mini',
            reachable: false,
            error: `no access for ${key}`,
          },
        ],
        error: 'one or more models are unreachable',
      }),
    );

    const result = await p.testConnection(key, []);
    expect(result.roles[0].error).not.toContain(key);
    expect(result.roles[0].error).toContain('[redacted]');
    // The rest of the role result survives — this is a scrub, not a discard.
    expect(result.roles[0].roleKey).toBe('grader');
    expect(result.roles[0].modelId).toBe('gpt-5.4-mini');
    expect(result.authenticated).toBe(true);
  });

  it('truncates an oversized provider message', async () => {
    const p = provider(async () => {
      throw new Error('x'.repeat(MAX_PROVIDER_ERROR_LENGTH + 500));
    });

    const result = await p.listModels();
    expect(result.error).toContain('… (truncated)');
    // Prefix + cap + marker, comfortably under the raw length.
    expect(result.error!.length).toBeLessThan(MAX_PROVIDER_ERROR_LENGTH + 100);
  });

  it('labels every error with the provider name', async () => {
    // An admin page shows this text with no other context, and "Invalid API
    // key" means something different depending on which provider said it.
    const p = provider(async () => {
      throw new Error('Invalid API key');
    });

    await expect(p.listModels()).resolves.toMatchObject({
      error: 'Stub: Invalid API key',
    });
  });
});

describe('BaseAiProvider — capability gating', () => {
  it('reports only the families it declares', () => {
    const p = provider(async () => OK_CATALOG, undefined, TEXT_ONLY);

    expect(p.supports('text')).toBe(true);
    expect(p.supports('tts')).toBe(false);
    expect(p.supports('realtime')).toBe(false);
  });

  it('is the gate that stops a role being bound to a provider that cannot serve it', () => {
    // A future Anthropic provider offers chat but no speech API. Without this,
    // an admin could bind `speak` to it, save successfully, and find out when a
    // learner pressed "read this aloud".
    const chatOnly = provider(async () => OK_CATALOG, undefined, TEXT_ONLY);

    expect(chatOnly.supports('tts')).toBe(false);
  });
});

// =============================================================================
// completeStructured (issue #96, epic #53)
// =============================================================================
//
// Three ways this can fail and only one of them is a throw. The other two — a
// reply that is not JSON, and a reply that is JSON of the wrong shape — are
// exactly the failures a hand-rolled `JSON.parse(response.text)` at a call site
// turns into an exception or, worse, into a partially-populated object that
// flows onward as if it were a grade.
// =============================================================================

const ALICE = '11111111-1111-4111-8111-111111111111';
const USER_KEY = 'sk-user-abcdefghijklmnopqrst';

/** The shape a grader would ask for: two required fields, no optionals. */
const VERDICT = z.object({
  correct: z.boolean(),
  reason: z.string(),
});

function verdictRequest(): AiStructuredCompletionRequest<
  z.infer<typeof VERDICT>
> {
  return {
    roleKey: 'grader',
    modelId: 'gpt-5.4',
    messages: [{ role: 'user', content: 'grade this' }],
    schemaName: 'civics_verdict',
    schema: VERDICT,
  };
}

const KNOWN_USAGE: AiUsage = {
  promptTokens: 11,
  completionTokens: 3,
  totalTokens: 14,
};

describe('BaseAiProvider.completeStructured — the happy path', () => {
  it('returns the parsed, validated value', async () => {
    const p = structuredProvider(async () => ({
      raw: '{"correct":true,"reason":"named the right war"}',
      usage: KNOWN_USAGE,
    }));

    const result = await p.completeStructured(ALICE, USER_KEY, verdictRequest());

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      correct: true,
      reason: 'named the right war',
    });
    expect(result.errorCode).toBeNull();
    expect(result.error).toBeNull();
  });

  it('sends the schema to the provider as JSON Schema, converted once', async () => {
    // Converted by the base class, not by the subclass: two conversions with
    // different options would mean the constraint the model was given and the
    // contract the caller relies on are not the same object.
    let seen: Record<string, unknown> | null = null;
    const p = structuredProvider(async (_key, _request, jsonSchema) => {
      seen = jsonSchema;
      return { raw: '{"correct":true,"reason":"x"}', usage: KNOWN_USAGE };
    });

    await p.completeStructured(ALICE, USER_KEY, verdictRequest());

    expect(seen).toMatchObject({
      type: 'object',
      properties: {
        correct: { type: 'boolean' },
        reason: { type: 'string' },
      },
    });
  });

  it('records one row and hands back its id', async () => {
    // Issue #110 writes this id into `practice_attempts.ai_usage_event_id`. An
    // id the provider discarded cannot be recovered without guessing at the
    // most recent row, which races the learner's own next answer.
    const p = structuredProvider(async () => ({
      raw: '{"correct":true,"reason":"x"}',
      usage: KNOWN_USAGE,
    }));

    const result = await p.completeStructured(ALICE, USER_KEY, verdictRequest());

    expect(result.usageEventId).toBe('usage-row-1');
    expect(p.record).toHaveBeenCalledTimes(1);
    expect(p.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ALICE,
        model: 'gpt-5.4',
        roleKey: 'grader',
        success: true,
        usage: KNOWN_USAGE,
      }),
    );
  });

  it('reports a null usageEventId when the write failed, without failing the call', async () => {
    // The user asked for a grade, not for bookkeeping. A nullable FK is the
    // caller's half of the same trade.
    const p = structuredProvider(async () => ({
      raw: '{"correct":true,"reason":"x"}',
      usage: KNOWN_USAGE,
    }));
    p.record.mockRejectedValue(new Error('database is down'));

    const result = await p.completeStructured(ALICE, USER_KEY, verdictRequest());

    expect(result.success).toBe(true);
    expect(result.data).not.toBeNull();
    expect(result.usageEventId).toBeNull();
  });
});

describe('BaseAiProvider.completeStructured — a bad reply is a result, not a throw', () => {
  it('reports invalid_json when the reply is not JSON at all', async () => {
    const p = structuredProvider(async () => ({
      raw: 'Sure! Here is the verdict:\n```json\n{"correct":true}\n```',
      usage: KNOWN_USAGE,
    }));

    const result = await p.completeStructured(ALICE, USER_KEY, verdictRequest());

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('invalid_json');
    // NEVER a partial object. A half-parsed grade is not a lenient grade.
    expect(result.data).toBeNull();
  });

  it('reports invalid_json when the model returned no content at all', async () => {
    // Shares the code deliberately: "the provider did not return the JSON we
    // constrained it to" is one operational problem with one remedy.
    const p = structuredProvider(async () => ({
      raw: null,
      usage: KNOWN_USAGE,
    }));

    const result = await p.completeStructured(ALICE, USER_KEY, verdictRequest());

    expect(result.errorCode).toBe('invalid_json');
    expect(result.data).toBeNull();
  });

  it('reports schema_validation_failed when the reply is JSON of the wrong shape', async () => {
    // The failure `response_format` is supposed to prevent, and which a
    // provider or a model that does not honour it will produce anyway.
    const p = structuredProvider(async () => ({
      raw: '{"correct":"maybe"}',
      usage: KNOWN_USAGE,
    }));

    const result = await p.completeStructured(ALICE, USER_KEY, verdictRequest());

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('schema_validation_failed');
    expect(result.data).toBeNull();
  });

  it('names the schema and the KINDS of issue, and nothing the model wrote', async () => {
    // The obvious message quotes the received value, and on this surface the
    // received value is a model's commentary on what a learner typed.
    const p = structuredProvider(async () => ({
      raw: '{"correct":"the learner said something private","reason":7}',
      usage: KNOWN_USAGE,
    }));

    const result = await p.completeStructured(ALICE, USER_KEY, verdictRequest());

    expect(result.error).toContain('civics_verdict');
    expect(result.error).toContain('invalid_type');
    expect(result.error).not.toContain('the learner said something private');
  });

  it('never quotes the reply into the error for an unparseable one either', async () => {
    const p = structuredProvider(async () => ({
      raw: 'I think the learner meant to say the Civil War, which is private',
      usage: KNOWN_USAGE,
    }));

    const result = await p.completeStructured(ALICE, USER_KEY, verdictRequest());

    expect(result.error).not.toContain('the learner meant');
    expect(result.error).not.toContain('Civil War');
  });

  it('records the failed call, with the usage the provider did report', async () => {
    const p = structuredProvider(async () => ({
      raw: 'not json',
      usage: KNOWN_USAGE,
    }));

    await p.completeStructured(ALICE, USER_KEY, verdictRequest());

    expect(p.record).toHaveBeenCalledTimes(1);
    expect(p.record).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'invalid_json',
        usage: KNOWN_USAGE,
      }),
    );
  });
});

describe('BaseAiProvider.completeStructured — never throws', () => {
  it('turns a thrown hook into a classified failure result', async () => {
    const p = structuredProvider(async () => {
      throw new Error('429 rate limit exceeded');
    });

    const result = await p.completeStructured(ALICE, USER_KEY, verdictRequest());

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('rate_limit');
    expect(result.error).toBe('Stub: 429 rate limit exceeded');
    expect(result.data).toBeNull();
  });

  it('turns a rejected hook into a failure result', async () => {
    const p = structuredProvider(() => Promise.reject(new Error('async boom')));

    await expect(
      p.completeStructured(ALICE, USER_KEY, verdictRequest()),
    ).resolves.toMatchObject({ success: false, error: 'Stub: async boom' });
  });

  it('turns a malformed hook return into a failure result', async () => {
    const p = structuredProvider(
      async () => undefined as unknown as { raw: string | null; usage: AiUsage },
    );

    await expect(
      p.completeStructured(ALICE, USER_KEY, verdictRequest()),
    ).resolves.toMatchObject({
      success: false,
      errorCode: 'malformed_result',
      data: null,
    });
  });

  it('turns a schema zod cannot convert into a failure result, not a crash', async () => {
    // `z.toJSONSchema` throws on a transform. Built outside the try it would be
    // the one line in the method that can take the never-throw guarantee away.
    const p = structuredProvider(async () => ({
      raw: '{"correct":true,"reason":"x"}',
      usage: KNOWN_USAGE,
    }));

    const result = await p.completeStructured(ALICE, USER_KEY, {
      ...verdictRequest(),
      schema: z.string().transform((v) => v) as unknown as typeof VERDICT,
    });

    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toContain('Stub:');
  });

  it('records NULL token counts, not zeros, when the hook throws', async () => {
    // A throw may follow real consumption the provider never reported. Zero
    // would state that it did not.
    const p = structuredProvider(async () => {
      throw new Error('exploded');
    });

    await p.completeStructured(ALICE, USER_KEY, verdictRequest());

    expect(p.record).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: {
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
        },
      }),
    );
  });

  it('lets no key reach the error string', async () => {
    const p = structuredProvider(async () => {
      throw new Error(`401 Incorrect API key provided: ${USER_KEY}`);
    });

    const result = await p.completeStructured(ALICE, USER_KEY, verdictRequest());

    expect(result.error).not.toContain(USER_KEY);
    expect(result.error).toContain('[redacted]');
  });
});

// =============================================================================
// stream (issue #96, epic #53)
// =============================================================================
//
// An async generator has four exits and three of them are easy to miss. The
// invariant every test below is protecting is the one an SSE endpoint is built
// on: exactly one terminal event, always last, and exactly one usage row.
// =============================================================================

/** An upstream stream built from a plain script of chunks. */
function chunksOf(chunks: Array<{ delta?: string; usage?: AiUsage }>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** An upstream stream that throws partway, as a dropped connection does. */
function chunksThenThrow(
  chunks: Array<{ delta?: string; usage?: AiUsage }>,
  err: unknown,
) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
      throw err;
    },
  };
}

const STREAM_REQUEST: AiCompletionRequest = {
  roleKey: 'tutor',
  modelId: 'gpt-5.4',
  messages: [{ role: 'user', content: 'why?' }],
};

/** Drain a stream into an array, so the ORDER of events can be asserted. */
async function drain(
  events: AsyncIterable<AiStreamEvent>,
): Promise<AiStreamEvent[]> {
  const out: AiStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('BaseAiProvider.stream — the happy path', () => {
  it('yields each delta, then exactly one done event, last', async () => {
    const p = streamProvider(() =>
      chunksOf([
        { delta: 'The ' },
        { delta: 'Civil ' },
        { delta: 'War.' },
        { usage: KNOWN_USAGE },
      ]),
    );

    const events = await drain(p.stream(ALICE, USER_KEY, STREAM_REQUEST));

    expect(events.map((e) => e.type)).toEqual([
      'delta',
      'delta',
      'delta',
      'done',
    ]);
    expect(events.filter((e) => e.type !== 'delta')).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      type: 'done',
      usage: KNOWN_USAGE,
      usageEventId: 'usage-row-1',
    });
  });

  it('drops empty deltas rather than forwarding them', async () => {
    // The provider emits role-only and finish-only chunks; an SSE consumer
    // appending those sends empty frames to a browser.
    const p = streamProvider(() =>
      chunksOf([{ delta: '' }, { delta: 'hi' }, {}, { usage: KNOWN_USAGE }]),
    );

    const events = await drain(p.stream(ALICE, USER_KEY, STREAM_REQUEST));

    expect(events.filter((e) => e.type === 'delta')).toEqual([
      { type: 'delta', text: 'hi' },
    ]);
  });

  it('passes stream: true down to the provider hook', async () => {
    // Set by this class, not left to the caller and not left to the subclass: a
    // streamed call issued without it is a non-streamed call that happens to
    // work, recorded under the streaming path's assumptions.
    let seen: AiCompletionRequest | null = null;
    const p = streamProvider((_key, request) => {
      seen = request;
      return chunksOf([{ delta: 'hi' }, { usage: KNOWN_USAGE }]);
    });

    await drain(p.stream(ALICE, USER_KEY, STREAM_REQUEST));

    expect(seen).toMatchObject({ stream: true, modelId: 'gpt-5.4' });
  });

  it('hands the abort signal through to the provider', async () => {
    // An abort that only breaks our loop leaves the provider generating — and
    // billing — the rest of a response nobody will read.
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const p = streamProvider((_key, _request, _redact, signal) => {
      seen = signal;
      return chunksOf([{ delta: 'hi' }, { usage: KNOWN_USAGE }]);
    });

    await drain(
      p.stream(ALICE, USER_KEY, STREAM_REQUEST, controller.signal),
    );

    expect(seen).toBe(controller.signal);
  });

  it('records exactly one row, with the usage the provider reported', async () => {
    const p = streamProvider(() =>
      chunksOf([{ delta: 'hi' }, { usage: KNOWN_USAGE }]),
    );

    await drain(p.stream(ALICE, USER_KEY, STREAM_REQUEST));

    expect(p.record).toHaveBeenCalledTimes(1);
    expect(p.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ALICE,
        roleKey: 'tutor',
        success: true,
        usage: KNOWN_USAGE,
      }),
    );
  });

  it('records NULL, not zero, when the stream ends with no usage chunk', async () => {
    // The shape of the bug `stream_options: { include_usage: true }` prevents.
    // Even here the row is honest: we were not told, so we do not claim.
    const p = streamProvider(() => chunksOf([{ delta: 'hi' }]));

    const events = await drain(p.stream(ALICE, USER_KEY, STREAM_REQUEST));

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      },
    });
    expect(p.record).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: {
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
        },
      }),
    );
  });
});

describe('BaseAiProvider.stream — a failure is an event, never a throw', () => {
  it('ends a mid-stream failure with exactly one error event, last', async () => {
    const p = streamProvider(() =>
      chunksThenThrow([{ delta: 'The ' }], new Error('stream aborted')),
    );

    const events = await drain(p.stream(ALICE, USER_KEY, STREAM_REQUEST));

    // The deltas already yielded stand — they were really received — but the
    // completion is not whole and must not be presented as one.
    expect(events.map((e) => e.type)).toEqual(['delta', 'error']);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      errorCode: 'error',
      error: 'Stub: stream aborted',
    });
  });

  it('does not reject when the hook throws before the first chunk', async () => {
    // A generator's body does not run until the first `next()`, so this is the
    // exit a `try` written around the call site would never see.
    const p = streamProvider(() => {
      throw new Error('401 Incorrect API key provided');
    });

    const events = await drain(p.stream(ALICE, USER_KEY, STREAM_REQUEST));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      errorCode: 'invalid_key',
    });
  });

  it('reports an aborted request as the terminal error event', async () => {
    const controller = new AbortController();
    const p = streamProvider(() =>
      chunksThenThrow(
        [{ delta: 'The ' }],
        Object.assign(new Error('Request was aborted.'), {
          name: 'AbortError',
        }),
      ),
    );
    controller.abort();

    const events = await drain(
      p.stream(ALICE, USER_KEY, STREAM_REQUEST, controller.signal),
    );

    expect(events.at(-1)!.type).toBe('error');
    expect(p.record).toHaveBeenCalledTimes(1);
  });

  it('classifies the failure into a groupable code', async () => {
    const p = streamProvider(() =>
      chunksThenThrow([], new Error('429 rate limit exceeded')),
    );

    const events = await drain(p.stream(ALICE, USER_KEY, STREAM_REQUEST));

    expect(events[0]).toMatchObject({ errorCode: 'rate_limit' });
    expect(p.record).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errorCode: 'rate_limit' }),
    );
  });

  it('lets no key reach the terminal error event', async () => {
    const p = streamProvider(() =>
      chunksThenThrow(
        [],
        new Error(`Request failed with Authorization: Bearer ${USER_KEY}`),
      ),
    );

    const events = await drain(p.stream(ALICE, USER_KEY, STREAM_REQUEST));
    const terminal = events[0] as Extract<AiStreamEvent, { type: 'error' }>;

    expect(terminal.error).not.toContain(USER_KEY);
    expect(terminal.error).toContain('[redacted]');
  });

  it('records the counts it had been told, and nothing it had not', async () => {
    // "Counts seen so far" — all-null unless the provider had already reported,
    // never zero.
    const p = streamProvider(() =>
      chunksThenThrow([{ delta: 'The ' }], new Error('boom')),
    );

    await drain(p.stream(ALICE, USER_KEY, STREAM_REQUEST));

    expect(p.record).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: {
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
        },
      }),
    );
  });
});

describe('BaseAiProvider.stream — an abandoned stream still records (#120)', () => {
  it('writes the usage row when the consumer breaks out early', async () => {
    // A closed browser tab. The tokens were spent whether or not anyone read
    // them, and only the generator's `finally` sees this exit.
    const p = streamProvider(() =>
      chunksOf([
        { delta: 'The ' },
        { delta: 'Civil ' },
        { delta: 'War.' },
        { usage: KNOWN_USAGE },
      ]),
    );

    for await (const event of p.stream(ALICE, USER_KEY, STREAM_REQUEST)) {
      if (event.type === 'delta') break;
    }

    expect(p.record).toHaveBeenCalledTimes(1);
    expect(p.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ALICE,
        success: false,
        errorCode: 'client_disconnected',
      }),
    );
  });

  it('distinguishes an abandoned stream from a failed one in the row', async () => {
    // Different problems: one is a user leaving, the other is the provider.
    const p = streamProvider(() =>
      chunksThenThrow([{ delta: 'hi' }], new Error('boom')),
    );

    await drain(p.stream(ALICE, USER_KEY, STREAM_REQUEST));

    expect(p.record).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'error' }),
    );
    expect(p.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'client_disconnected' }),
    );
  });

  it('writes exactly one row when the consumer breaks AFTER the terminal event', async () => {
    // The `recorded` flag: the normal path wrote the row already, and the
    // `finally` must not write a second.
    const p = streamProvider(() =>
      chunksOf([{ delta: 'hi' }, { usage: KNOWN_USAGE }]),
    );

    for await (const event of p.stream(ALICE, USER_KEY, STREAM_REQUEST)) {
      if (event.type === 'done') break;
    }

    expect(p.record).toHaveBeenCalledTimes(1);
    expect(p.record).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it('never fails the abandoned path when the usage write rejects', async () => {
    const p = streamProvider(() => chunksOf([{ delta: 'hi' }, { delta: 'ho' }]));
    p.record.mockRejectedValue(new Error('database is down'));

    await expect(
      (async () => {
        for await (const event of p.stream(ALICE, USER_KEY, STREAM_REQUEST)) {
          if (event.type === 'delta') break;
        }
      })(),
    ).resolves.toBeUndefined();
  });
});

// =============================================================================
// transcribe / synthesize (issue #88, epic #58 — E9 "Voice foundation")
// =============================================================================
//
// Two more public methods carrying the same never-throw guarantee, and the
// tests below are the same three subclass failures the rest of this file covers
// — a hook that throws, one that returns nothing, one that returns a hand-built
// failure — plus the one thing that is new here: a CAPABILITY GATE that must
// answer without calling out at all.
//
// The gate matters because a settings row written before a deployment swapped
// providers can still name a `speak` binding on a provider with no speech API.
// The right outcome is a refusal a caller can render, not a TypeError from
// inside an SDK that has no such method.
// =============================================================================

const TRANSCRIBE_REQUEST: AiTranscriptionRequest = {
  roleKey: 'transcribe',
  modelId: 'whisper-1',
  audio: Buffer.from('not really audio'),
  contentType: 'audio/webm',
  fileName: 'answer.webm',
};

const SYNTHESIZE_REQUEST: AiSynthesisRequest = {
  roleKey: 'speak',
  modelId: 'tts-1-hd',
  text: 'Who is the President of the United States?',
};

/** Every family EXCEPT the speech ones, i.e. a chat-only provider. */
const NO_SPEECH: AiCapabilitySet = new Set<AiCapabilityFamily>([
  'text',
  'embedding',
]);

describe('BaseAiProvider.transcribe — never-throw', () => {
  it('turns a thrown hook into a well-formed failure result', async () => {
    const p = transcribeProvider(async () => {
      throw new Error('the upload was refused');
    });

    const result = await p.transcribe(ALICE, USER_KEY, TRANSCRIBE_REQUEST);

    expect(result).toEqual({
      success: false,
      text: null,
      // UNKNOWN, not 0. A zero here asserts the recogniser was certain it
      // heard nothing, which downstream becomes "misheard" on an answer the
      // learner may have got right.
      confidence: null,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      errorCode: 'error',
      error: 'Stub: the upload was refused',
    });
  });

  it('turns a hook that returns undefined into a failure rather than a TypeError', async () => {
    // A subclass that falls off the end of a branch yields `undefined`, and a
    // caller reading `.usage` off it throws one frame outside the try.
    const p = transcribeProvider(
      async () => undefined as unknown as AiTranscriptionResult,
    );

    await expect(
      p.transcribe(ALICE, USER_KEY, TRANSCRIBE_REQUEST),
    ).resolves.toMatchObject({
      success: false,
      text: null,
      confidence: null,
      errorCode: 'malformed_result',
      error: 'Stub returned no result.',
    });
  });

  it('routes a hook-authored failure through redaction, and nulls its payload', async () => {
    const p = transcribeProvider(async () => ({
      success: false,
      // A subclass that filled these in anyway must not have them believed: a
      // failed call knows nothing about what was heard.
      text: 'something it should not claim to have heard',
      confidence: 0.9,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      errorCode: 'quota_exceeded',
      error: `the key ${USER_KEY} is out of quota`,
    }));

    const result = await p.transcribe(ALICE, USER_KEY, TRANSCRIBE_REQUEST);

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.errorCode).toBe('quota_exceeded');
    expect(result.error).not.toContain(USER_KEY);
    expect(result.error).toContain('Stub:');
  });

  it('never lets the API key reach the error string when the SDK echoes it', async () => {
    const p = transcribeProvider(async () => {
      throw new Error(`401 Incorrect API key provided: ${USER_KEY}`);
    });

    const result = await p.transcribe(ALICE, USER_KEY, TRANSCRIBE_REQUEST);

    expect(result.error).not.toContain(USER_KEY);
    expect(result.errorCode).toBe('invalid_key');
  });

  it('records a usage row on success AND on failure', async () => {
    const ok = transcribeProvider(async () => ({
      success: true,
      text: 'the president',
      confidence: 0.9,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      errorCode: null,
      error: null,
    }));

    await ok.transcribe(ALICE, USER_KEY, TRANSCRIBE_REQUEST);

    expect(ok.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ALICE,
        // The ROLE, not merely the model: an admin who rebinds `transcribe`
        // later must still be able to read last month's rows correctly.
        roleKey: 'transcribe',
        model: 'whisper-1',
        success: true,
      }),
    );

    const failed = transcribeProvider(async () => {
      throw new Error('boom');
    });

    await failed.transcribe(ALICE, USER_KEY, TRANSCRIBE_REQUEST);

    expect(failed.record).toHaveBeenCalledWith(
      expect.objectContaining({ roleKey: 'transcribe', success: false }),
    );
  });

  it('passes a successful transcript through unchanged', async () => {
    const p = transcribeProvider(async () => ({
      success: true,
      text: 'the president',
      confidence: 0.83,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      errorCode: null,
      error: null,
    }));

    await expect(
      p.transcribe(ALICE, USER_KEY, TRANSCRIBE_REQUEST),
    ).resolves.toMatchObject({
      success: true,
      text: 'the president',
      confidence: 0.83,
    });
  });
});

describe('BaseAiProvider.transcribe — the capability gate', () => {
  it('refuses without calling the hook when the provider cannot transcribe', async () => {
    const hook = jest.fn();
    const p = transcribeProvider(hook, NO_SPEECH);

    const result = await p.transcribe(ALICE, USER_KEY, TRANSCRIBE_REQUEST);

    expect(result).toMatchObject({
      success: false,
      text: null,
      confidence: null,
      errorCode: 'capability_unsupported',
    });
    // Names the provider AND the capability, because this message is read by
    // an admin deciding what to fix.
    expect(result.error).toBe('Stub does not support speech recognition.');

    expect(hook).not.toHaveBeenCalled();
    expect(p.speechHookCalls.transcribe).toBe(0);
  });

  it('writes no usage row for a call that never happened', async () => {
    // `ai_usage_events` records calls that were made. Nothing left the process
    // here, so a row would be a phantom entry in a learner's usage table.
    const p = transcribeProvider(jest.fn(), NO_SPEECH);

    await p.transcribe(ALICE, USER_KEY, TRANSCRIBE_REQUEST);

    expect(p.record).not.toHaveBeenCalled();
  });
});

describe('BaseAiProvider.synthesize — never-throw', () => {
  it('turns a thrown hook into a well-formed failure result', async () => {
    const p = synthesizeProvider(async () => {
      throw new Error('the voice is not available');
    });

    const result = await p.synthesize(ALICE, USER_KEY, SYNTHESIZE_REQUEST);

    expect(result).toEqual({
      success: false,
      audio: null,
      contentType: null,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      errorCode: 'error',
      error: 'Stub: the voice is not available',
    });
  });

  it('turns a hook that returns undefined into a failure rather than a TypeError', async () => {
    const p = synthesizeProvider(
      async () => undefined as unknown as AiSynthesisResult,
    );

    await expect(
      p.synthesize(ALICE, USER_KEY, SYNTHESIZE_REQUEST),
    ).resolves.toMatchObject({
      success: false,
      audio: null,
      contentType: null,
      errorCode: 'malformed_result',
      error: 'Stub returned no result.',
    });
  });

  it('routes a hook-authored failure through redaction, and drops its payload', async () => {
    const p = synthesizeProvider(async () => ({
      success: false,
      audio: Buffer.from('half an mp3'),
      contentType: 'audio/mpeg',
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      errorCode: 'rate_limit',
      error: `slow down, ${USER_KEY}`,
    }));

    const result = await p.synthesize(ALICE, USER_KEY, SYNTHESIZE_REQUEST);

    expect(result.success).toBe(false);
    // Partial audio is not an early draft of a spoken sentence.
    expect(result.audio).toBeNull();
    expect(result.contentType).toBeNull();
    expect(result.error).not.toContain(USER_KEY);
    expect(result.error).toContain('Stub:');
  });

  it('never lets the API key reach the error string', async () => {
    const p = synthesizeProvider(async () => {
      throw new Error(`401 Incorrect API key provided: ${USER_KEY}`);
    });

    const result = await p.synthesize(ALICE, USER_KEY, SYNTHESIZE_REQUEST);

    expect(result.error).not.toContain(USER_KEY);
  });

  it('records a usage row against the speak role', async () => {
    const p = synthesizeProvider(async () => ({
      success: true,
      audio: Buffer.from([0xff, 0xfb]),
      contentType: 'audio/mpeg',
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      errorCode: null,
      error: null,
    }));

    const result = await p.synthesize(ALICE, USER_KEY, SYNTHESIZE_REQUEST);

    expect(result.success).toBe(true);
    expect(result.contentType).toBe('audio/mpeg');
    expect(p.record).toHaveBeenCalledWith(
      expect.objectContaining({
        roleKey: 'speak',
        model: 'tts-1-hd',
        success: true,
      }),
    );
  });
});

describe('BaseAiProvider.synthesize — the capability gate', () => {
  it('refuses without calling the hook when the provider has no speech API', async () => {
    // The concrete case: a chat-only provider an admin swapped to, with a
    // `speak` binding still in the settings row.
    const hook = jest.fn();
    const p = synthesizeProvider(hook, NO_SPEECH);

    const result = await p.synthesize(ALICE, USER_KEY, SYNTHESIZE_REQUEST);

    expect(result).toMatchObject({
      success: false,
      audio: null,
      contentType: null,
      errorCode: 'capability_unsupported',
    });
    expect(result.error).toBe('Stub does not support speech synthesis.');

    expect(hook).not.toHaveBeenCalled();
    expect(p.speechHookCalls.synthesize).toBe(0);
    expect(p.record).not.toHaveBeenCalled();
  });
});

// =============================================================================
// createRealtimeSession (issue #156, epic #60 — E11 "Realtime voice interview")
// =============================================================================
//
// A fourth public inference method with the same never-throw guarantee, so the
// first three tests here are the same three subclass failures the rest of this
// file covers — a hook that throws, one that returns nothing, one that returns
// a hand-built failure — plus the capability gate, which on this surface reads
// `'realtime'`.
//
// WHAT IS GENUINELY NEW IS THE SECOND SECRET. Everywhere else on this class the
// only credential in play arrives before the call; here one comes back FROM it,
// and for the minutes it is valid it is a bearer token that can open a session
// and spend a learner's quota. A log aggregator and a trace backend both retain
// far longer than that window, so the tests below assert the negative directly:
// the minted secret reaches the caller and reaches nothing else.
// =============================================================================

const REALTIME_REQUEST: AiRealtimeSessionRequest = {
  roleKey: 'realtime',
  modelId: 'gpt-4o-realtime-preview',
  instructions: 'You are a USCIS officer conducting a naturalization interview.',
  tools: [
    {
      name: 'record_civics_answer',
      description: 'Record the applicant’s answer to the civics question asked.',
      parameters: { type: 'object', properties: {} },
    },
  ],
};

/** A minted secret, distinctive enough to find anywhere it should not be. */
const MINTED_SECRET = 'ek_test_secret_that_must_not_leak';

const MINTED: AiRealtimeSessionResult = {
  success: true,
  clientSecret: MINTED_SECRET,
  expiresAt: new Date('2099-01-01T00:10:00.000Z'),
  modelId: 'gpt-4o-realtime-preview',
  usage: { promptTokens: null, completionTokens: null, totalTokens: null },
  errorCode: null,
  error: null,
};

/** Every family EXCEPT realtime, i.e. a provider with no session API. */
const NO_REALTIME: AiCapabilitySet = new Set<AiCapabilityFamily>([
  'text',
  'transcribe',
  'tts',
  'embedding',
]);

describe('BaseAiProvider.createRealtimeSession — never-throw', () => {
  it('turns a thrown hook into a well-formed failure result', async () => {
    const p = realtimeProvider(async () => {
      throw new Error('the organisation has no realtime access');
    });

    const result = await p.createRealtimeSession(
      ALICE,
      USER_KEY,
      REALTIME_REQUEST,
    );

    expect(result).toEqual({
      success: false,
      clientSecret: null,
      expiresAt: null,
      modelId: null,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      errorCode: 'error',
      error: 'Stub: the organisation has no realtime access',
    });
  });

  it('turns a hook that returns undefined into a failure rather than a TypeError', async () => {
    // A subclass that falls off the end of a branch yields `undefined`, and a
    // caller reading `.usage` off it throws one frame outside the try.
    const p = realtimeProvider(
      async () => undefined as unknown as AiRealtimeSessionResult,
    );

    await expect(
      p.createRealtimeSession(ALICE, USER_KEY, REALTIME_REQUEST),
    ).resolves.toMatchObject({
      success: false,
      clientSecret: null,
      expiresAt: null,
      modelId: null,
      errorCode: 'malformed_result',
      error: 'Stub returned no result.',
    });
  });

  it('routes a hook-authored failure through redaction, and drops its payload', async () => {
    // A failed mint has no session, whatever fields the subclass populated: a
    // secret returned beside `success: false` is a credential a caller has no
    // basis to use and every reason to log by accident.
    const p = realtimeProvider(async () => ({
      success: false,
      clientSecret: MINTED_SECRET,
      expiresAt: new Date('2099-01-01T00:10:00.000Z'),
      modelId: 'gpt-4o-realtime-preview',
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      errorCode: 'rate_limit',
      error: `slow down, ${USER_KEY}`,
    }));

    const result = await p.createRealtimeSession(
      ALICE,
      USER_KEY,
      REALTIME_REQUEST,
    );

    expect(result.success).toBe(false);
    expect(result.clientSecret).toBeNull();
    expect(result.expiresAt).toBeNull();
    expect(result.modelId).toBeNull();
    expect(result.error).not.toContain(USER_KEY);
    expect(result.error).toContain('Stub:');
  });

  it('never lets the API key reach the error string', async () => {
    const p = realtimeProvider(async () => {
      throw new Error(`401 Incorrect API key provided: ${USER_KEY}`);
    });

    const result = await p.createRealtimeSession(
      ALICE,
      USER_KEY,
      REALTIME_REQUEST,
    );

    expect(result.error).not.toContain(USER_KEY);
    expect(result.errorCode).toBe('invalid_key');
  });

  it('returns the minted session and records a row against the realtime role', async () => {
    const p = realtimeProvider(async () => MINTED);

    const result = await p.createRealtimeSession(
      ALICE,
      USER_KEY,
      REALTIME_REQUEST,
    );

    expect(result.success).toBe(true);
    expect(result.clientSecret).toBe(MINTED_SECRET);
    expect(result.expiresAt).toEqual(new Date('2099-01-01T00:10:00.000Z'));
    expect(result.modelId).toBe('gpt-4o-realtime-preview');
    // ALL-NULL USAGE IS THE ORDINARY CASE: minting runs no inference. A zero
    // would claim we know the session cost nothing.
    expect(result.usage).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
    expect(p.record).toHaveBeenCalledWith(
      expect.objectContaining({
        roleKey: 'realtime',
        model: 'gpt-4o-realtime-preview',
        success: true,
      }),
    );
  });
});

describe('BaseAiProvider.createRealtimeSession — the capability gate', () => {
  it('refuses without calling the hook when the provider has no realtime API', async () => {
    // The concrete case: a chat-only provider an admin swapped to, with a
    // `realtime` binding still in the settings row. A refusal an admin can
    // read, never a TypeError from inside an SDK that has no such method.
    const hook = jest.fn();
    const p = realtimeProvider(hook, NO_REALTIME);

    const result = await p.createRealtimeSession(
      ALICE,
      USER_KEY,
      REALTIME_REQUEST,
    );

    expect(result).toMatchObject({
      success: false,
      clientSecret: null,
      expiresAt: null,
      modelId: null,
      errorCode: 'capability_unsupported',
    });
    expect(result.error).toBe('Stub does not support realtime sessions.');

    expect(hook).not.toHaveBeenCalled();
    expect(p.speechHookCalls.realtime).toBe(0);
  });

  it('writes no usage row for a call that never happened', async () => {
    // `ai_usage_events` records calls that were made. Nothing left the process
    // here, so a row would be a phantom entry in a learner's usage table.
    const p = realtimeProvider(jest.fn(), NO_REALTIME);

    await p.createRealtimeSession(ALICE, USER_KEY, REALTIME_REQUEST);

    expect(p.record).not.toHaveBeenCalled();
  });
});

describe('BaseAiProvider.createRealtimeSession — the minted secret goes nowhere else', () => {
  /**
   * Every span attribute set during one test, so the assertions below can be
   * about what was RECORDED rather than about what the code appears to record.
   *
   * The API's `trace.getTracer` hands back a proxy that resolves its delegate
   * lazily, so registering this provider after the class under test has
   * already captured its tracer still works.
   */
  const attributes: Array<[string, unknown]> = [];

  const recordingSpan = {
    setAttribute(key: string, value: unknown) {
      attributes.push([key, value]);
      return this;
    },
    setAttributes() {
      return this;
    },
    setStatus() {
      return this;
    },
    addEvent() {
      return this;
    },
    recordException() {
      return this;
    },
    updateName() {
      return this;
    },
    isRecording() {
      return true;
    },
    end() {},
    spanContext() {
      return { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 1 };
    },
  };

  beforeAll(() => {
    trace.setGlobalTracerProvider({
      getTracer: () =>
        ({ startSpan: () => recordingSpan }) as unknown as ReturnType<
          typeof trace.getTracer
        >,
    });
  });

  afterAll(() => {
    trace.disable();
  });

  beforeEach(() => {
    attributes.length = 0;
  });

  it('puts the model and the role on the span, and nothing else', async () => {
    const p = realtimeProvider(async () => MINTED);

    await p.createRealtimeSession(ALICE, USER_KEY, REALTIME_REQUEST);

    expect(attributes).toEqual([
      ['ai.model', 'gpt-4o-realtime-preview'],
      ['ai.role', 'realtime'],
    ]);
    // Stated separately from the equality above so a future attribute added
    // for a good reason fails on the list, not on this: a span carrying the
    // secret is a credential in a trace backend that outlives it.
    for (const [, value] of attributes) {
      expect(String(value)).not.toContain(MINTED_SECRET);
    }
    // Nor the instructions or the tool list, which are content rather than
    // shape — the same rule the speech spans follow.
    for (const [, value] of attributes) {
      expect(String(value)).not.toContain('USCIS officer');
      expect(String(value)).not.toContain('record_civics_answer');
    }
  });

  it('registers the minted secret with the redactor the moment it exists', async () => {
    // The line this method has that `synthesize` does not. The hook is handed
    // the same redactor the public method will format every error string
    // through; after the hook returns a secret, that redactor must already
    // know about it — so an error raised later, by a usage write or by the
    // next edit to this method, cannot quote a live credential into a log.
    let captured: SecretRedactor | null = null;

    const p = realtimeProvider(async (_key, _request, redact) => {
      captured = redact;
      return MINTED;
    });

    const result = await p.createRealtimeSession(
      ALICE,
      USER_KEY,
      REALTIME_REQUEST,
    );

    expect(result.clientSecret).toBe(MINTED_SECRET);

    const scrubbed = (captured as unknown as SecretRedactor).apply(
      `boom while holding ${MINTED_SECRET}`,
    );
    expect(scrubbed).not.toContain(MINTED_SECRET);
    expect(scrubbed).toContain('[redacted]');
  });

  it('scrubs a secret a FAILING hook quoted in its own error text', async () => {
    // The other half of registering on both branches: a hook that minted a
    // secret and then decided the call had failed may name what it was holding
    // in its own message, and `formatError` is the last thing that reads that
    // message.
    const p = realtimeProvider(async () => ({
      ...MINTED,
      success: false,
      errorCode: 'rate_limit',
      error: `minted ${MINTED_SECRET} then hit the rate limit`,
    }));

    const failure = await p.createRealtimeSession(
      ALICE,
      USER_KEY,
      REALTIME_REQUEST,
    );

    expect(failure.clientSecret).toBeNull();
    expect(failure.error).not.toContain(MINTED_SECRET);
    expect(failure.error).toContain('[redacted]');
  });

  it('logs nothing containing the secret, on success or on failure', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const error = jest.spyOn(Logger.prototype, 'error');
    warn.mockClear();
    error.mockClear();

    await realtimeProvider(async () => MINTED).createRealtimeSession(
      ALICE,
      USER_KEY,
      REALTIME_REQUEST,
    );
    await realtimeProvider(async () => ({
      ...MINTED,
      success: false,
      errorCode: 'rate_limit',
      error: `refused while holding ${MINTED_SECRET}`,
    })).createRealtimeSession(ALICE, USER_KEY, REALTIME_REQUEST);

    const logged = [...warn.mock.calls, ...error.mock.calls]
      .flat()
      .map((arg) => String(arg))
      .join('\n');

    expect(logged).not.toContain(MINTED_SECRET);
  });
});

describe('the realtime types carry no long-lived credential', () => {
  it('holds the compile-time proof', () => {
    // THE ASSERTION IS THE IMPORT. `AI_REALTIME_CARRIES_NO_LONG_LIVED_KEY` is
    // typed `true` only while neither realtime type has a field named like a
    // long-lived key (`apiKey`, `key`, `token`, …); adding one makes the type
    // resolve to `never`, and ai.types.ts stops compiling — which fails this
    // suite too, since it imports the value. The `expect` below is what makes
    // the failure legible; the protection is the type.
    expect(AI_REALTIME_CARRIES_NO_LONG_LIVED_KEY).toBe(true);
  });
});

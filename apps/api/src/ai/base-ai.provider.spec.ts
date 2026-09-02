import { Logger } from '@nestjs/common';

import type { SecretRedactor } from '../common/crypto/secret-redactor';
import { MAX_PROVIDER_ERROR_LENGTH } from '../common/crypto/secret-redactor';
import { BaseAiProvider } from './base-ai.provider';
import type { AiProviderKind } from './ai-settings.schema';
import type { AiCapabilityFamily } from './ai-model-roles';
import type { AiCapabilitySet } from './providers/ai-provider.interface';
import type {
  AiConnectionTestResult,
  AiModelCatalogResult,
  AiReachabilityRequest,
} from './ai.types';

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
// =============================================================================

/** A stub whose two subclass hooks are supplied per test. */
class StubProvider extends BaseAiProvider {
  protected readonly logger = new Logger('StubProvider');
  readonly kind: AiProviderKind = 'openai';
  protected readonly providerName = 'Stub';

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
) {
  return new StubProvider(capabilities, onFetch, onProbe);
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

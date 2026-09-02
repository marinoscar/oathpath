import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { AiDispatchService } from './ai-dispatch.service';
import {
  AI_SYSTEM_CREDENTIAL_NAME,
  AI_SYSTEM_CREDENTIAL_PURPOSE,
  AI_USER_CREDENTIAL_PURPOSE,
} from './ai-credential.constants';
import { DEFAULT_AI_SETTINGS } from './ai-settings.schema';
import type { AiSettings } from './ai-settings.schema';
import type { AiSettingsService } from './ai-settings.service';
import type { CredentialsService } from '../credentials/credentials.service';
import type {
  AiRecordedCompletionResult,
  AiStreamEvent,
  AiStructuredCompletionResult,
  AiUsage,
} from './ai.types';
import type { AiProvider } from './providers/ai-provider.interface';

// =============================================================================
// AiDispatchService — tests (issue #100, epic #53)
// =============================================================================
//
// Three properties are worth a test here, and they are not the same kind of
// property:
//
//   1. BEHAVIOUR. Each of the four `unavailable` causes is produced by its own
//      condition and is distinguishable by the caller; a provider failure is
//      `failed`, not `unavailable`; a success surfaces `usageEventId` and
//      `modelId`; and none of the three public methods ever rejects.
//
//   2. ORDERING. The deployment-wide causes are reported ahead of the caller's
//      own missing key, so a caller facing both is told the thing an
//      administrator has to fix. That is only visible in a test that sets up
//      BOTH failures at once — a per-cause test cannot see it.
//
//   3. AN ABSENCE. This service may never read the organisation's key. There
//      is no runtime assertion that can express "and it never will": a
//      behavioural test can only prove that the paths it happens to exercise
//      did not, and the fallback that `ai-evaluation.md` §5 warns about would
//      be added on the ONE path a test forgot — `no_user_key`, the path whose
//      whole point is that no key was found. So the last block reads this
//      service's own source and asserts the server-key constants do not appear
//      in it at all, which is a claim about every path including the ones
//      nobody wrote a test for. Precedent: `ai-user-key.controller.spec.ts`
//      makes the same kind of negative claim the same way.
// =============================================================================

const ALICE = '11111111-1111-4111-8111-111111111111';

const USAGE: AiUsage = {
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
};

/** Settings for a deployment that is fully configured. */
function readySettings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    ...DEFAULT_AI_SETTINGS,
    provider: 'openai',
    enabled: true,
    models: {
      ...DEFAULT_AI_SETTINGS.models,
      // Both WIRED roles bound: `tutor` is the streaming case below, and a
      // fixture that bound only the grader would make every stream test fail
      // as `role_unbound` for a reason that has nothing to do with streaming.
      tutor: 'gpt-5.4-mini',
      grader: 'gpt-5.4-mini',
    },
    ...overrides,
  };
}

function settingsReturning(settings: AiSettings): AiSettingsService {
  return { get: jest.fn().mockResolvedValue(settings) } as unknown as AiSettingsService;
}

function credentialsReturning(secret: string | null): CredentialsService {
  return {
    getSecret: jest.fn().mockResolvedValue(secret),
  } as unknown as CredentialsService;
}

/**
 * A provider double.
 *
 * NOT `FakeAiProvider`. That class is a real `BaseAiProvider` and would drag
 * usage recording, spans and its own grading fixture into tests about
 * resolution; here the provider is the thing being ISOLATED from, so the
 * double returns exactly what each case needs and records how it was called.
 */
function providerDouble(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    kind: 'openai',
    capabilities: new Set(['text']),
    supports: jest.fn().mockReturnValue(true),
    listModels: jest.fn(),
    testConnection: jest.fn(),
    complete: jest.fn().mockResolvedValue({
      success: true,
      text: 'an answer',
      usage: USAGE,
      errorCode: null,
      error: null,
      usageEventId: 'usage-row-1',
    } satisfies AiRecordedCompletionResult),
    completeStructured: jest.fn().mockResolvedValue({
      success: true,
      data: { verdict: 'correct' },
      usage: USAGE,
      errorCode: null,
      error: null,
      usageEventId: 'usage-row-1',
    } satisfies AiStructuredCompletionResult<{ verdict: string }>),
    stream: jest.fn(),
    ...overrides,
  } as AiProvider;
}

function build(
  settings: AiSettings,
  secret: string | null,
  provider: AiProvider = providerDouble(),
) {
  const settingsService = settingsReturning(settings);
  const credentials = credentialsReturning(secret);
  const service = new AiDispatchService(settingsService, credentials, provider);

  return { service, settingsService, credentials, provider };
}

/** Drain a stream into an array. Every stream here is finite by contract. */
async function collect(events: AsyncIterable<AiStreamEvent>) {
  const collected: AiStreamEvent[] = [];
  for await (const event of events) collected.push(event);

  return collected;
}

const USER_KEY = 'sk-alice-abcdefghijklmnopqrst';
const MESSAGES = [{ role: 'user' as const, content: 'why is this the answer?' }];

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('AiDispatchService — unavailable causes', () => {
  it('reports ai_disabled when the master switch is off', async () => {
    const { service } = build(readySettings({ enabled: false }), USER_KEY);

    const result = await service.run(ALICE, 'grader', { messages: MESSAGES });

    expect(result).toEqual({ status: 'unavailable', cause: 'ai_disabled' });
  });

  it('reports role_unbound when no model is bound to the role', async () => {
    const settings = readySettings({
      models: { ...DEFAULT_AI_SETTINGS.models, grader: null },
    });
    const { service } = build(settings, USER_KEY);

    const result = await service.run(ALICE, 'grader', { messages: MESSAGES });

    expect(result).toEqual({ status: 'unavailable', cause: 'role_unbound' });
  });

  it('treats a blank binding as unbound, not as a model named ""', async () => {
    // An older client can write `''` where a newer one writes `null`. A blank
    // model id sent to a provider is a 404 the user pays for.
    const settings = readySettings({
      models: { ...DEFAULT_AI_SETTINGS.models, grader: '   ' },
    });
    const { service } = build(settings, USER_KEY);

    expect(await service.run(ALICE, 'grader', { messages: MESSAGES })).toEqual({
      status: 'unavailable',
      cause: 'role_unbound',
    });
  });

  it('reports capability_unsupported when the provider cannot serve the family', async () => {
    // Unreachable in production today — OpenAI declares all six families — and
    // tested anyway, because the cause exists for the day a provider declares
    // a subset and this is the branch that will run then.
    const provider = providerDouble({ supports: jest.fn().mockReturnValue(false) });
    const { service } = build(readySettings(), USER_KEY, provider);

    expect(await service.run(ALICE, 'grader', { messages: MESSAGES })).toEqual({
      status: 'unavailable',
      cause: 'capability_unsupported',
    });
  });

  it('reports capability_unsupported when no provider is configured', async () => {
    // Same cause, deliberately: from a caller's seat "no provider chosen" and
    // "the provider cannot do this" are one sentence — an administrator has
    // not finished setting this deployment up — and the cause set is closed at
    // four so every consumer's exhaustive branch stays valid.
    const { service } = build(readySettings({ provider: null }), USER_KEY);

    expect(await service.run(ALICE, 'grader', { messages: MESSAGES })).toEqual({
      status: 'unavailable',
      cause: 'capability_unsupported',
    });
  });

  it('reports capability_unsupported for a role the registry does not declare', async () => {
    // A role key arrives as a persisted string — a settings row or a queued
    // job written before a role was removed — so an unknown one must be a
    // result and not a throw.
    const { service } = build(readySettings(), USER_KEY);

    expect(
      await service.run(ALICE, 'a-role-that-was-removed', { messages: MESSAGES }),
    ).toEqual({ status: 'unavailable', cause: 'capability_unsupported' });
  });

  it('reports no_user_key when the caller has stored none', async () => {
    const { service } = build(readySettings(), null);

    expect(await service.run(ALICE, 'grader', { messages: MESSAGES })).toEqual({
      status: 'unavailable',
      cause: 'no_user_key',
    });
  });

  it('reads the caller`s own credential address, and only that one', async () => {
    const { service, credentials } = build(readySettings(), USER_KEY);

    await service.run(ALICE, 'grader', { messages: MESSAGES });

    expect(credentials.getSecret).toHaveBeenCalledTimes(1);
    expect(credentials.getSecret).toHaveBeenCalledWith(
      AI_USER_CREDENTIAL_PURPOSE,
      ALICE,
    );
    // The organisation's address is never reached for. See the source-reading
    // block at the bottom for the version of this claim that covers the paths
    // this test does not exercise.
    expect(credentials.getSecret).not.toHaveBeenCalledWith(
      AI_SYSTEM_CREDENTIAL_PURPOSE,
      AI_SYSTEM_CREDENTIAL_NAME,
    );
  });

  it('reports the administrator`s gap ahead of the caller`s missing key', async () => {
    // BOTH are true here. Telling this caller `no_user_key` would send them
    // off to store a key that still would not work, because AI is switched
    // off for everybody. See `ai-evaluation.md` §4.
    const { service, credentials } = build(
      readySettings({ enabled: false }),
      null,
    );

    expect(await service.run(ALICE, 'grader', { messages: MESSAGES })).toEqual({
      status: 'unavailable',
      cause: 'ai_disabled',
    });
    // And the key was never decrypted for a call that was never going to run.
    expect(credentials.getSecret).not.toHaveBeenCalled();
  });

  it('never reaches the provider on an unavailable result', async () => {
    const provider = providerDouble();
    const { service } = build(readySettings({ enabled: false }), USER_KEY, provider);

    await service.run(ALICE, 'grader', { messages: MESSAGES });
    await service.runStructured(ALICE, 'grader', {
      messages: MESSAGES,
      schemaName: 'grade',
      schema: z.object({ verdict: z.string() }),
    });
    await service.runStream(ALICE, 'grader', { messages: MESSAGES });

    expect(provider.complete).not.toHaveBeenCalled();
    expect(provider.completeStructured).not.toHaveBeenCalled();
    expect(provider.stream).not.toHaveBeenCalled();
  });
});

describe('AiDispatchService.run', () => {
  it('surfaces the text, the usage row id and the model on success', async () => {
    const { service } = build(readySettings(), USER_KEY);

    const result = await service.run(ALICE, 'grader', { messages: MESSAGES });

    expect(result).toEqual({
      status: 'ok',
      text: 'an answer',
      usage: USAGE,
      // The FK a caller stores — issue #110's
      // `practice_attempts.ai_usage_event_id`. Dropping it here would leave a
      // graded attempt unable to point at the call that graded it.
      usageEventId: 'usage-row-1',
      modelId: 'gpt-5.4-mini',
    });
  });

  it('passes the caller`s id, key, role and the RESOLVED model to the provider', async () => {
    const { service, provider } = build(readySettings(), USER_KEY);

    await service.run(ALICE, 'grader', { messages: MESSAGES, maxTokens: 64 });

    expect(provider.complete).toHaveBeenCalledWith(ALICE, USER_KEY, {
      roleKey: 'grader',
      // FROM THE SETTINGS ROW, never from the caller: `AiRunRequest` has no
      // field a caller could name a model with, which is what stops a cheap
      // role binding itself to the expensive role's model.
      modelId: 'gpt-5.4-mini',
      messages: MESSAGES,
      maxTokens: 64,
    });
  });

  it('reports a provider failure as failed, carrying its code and usage row', async () => {
    const provider = providerDouble({
      complete: jest.fn().mockResolvedValue({
        success: false,
        text: null,
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        errorCode: 'rate_limit',
        error: 'OpenAI: rate limited.',
        // A FAILED CALL STILL WROTE A ROW. The tokens were spent.
        usageEventId: 'usage-row-2',
      } satisfies AiRecordedCompletionResult),
    });
    const { service } = build(readySettings(), USER_KEY, provider);

    expect(await service.run(ALICE, 'grader', { messages: MESSAGES })).toEqual({
      status: 'failed',
      errorCode: 'rate_limit',
      error: 'OpenAI: rate limited.',
      usageEventId: 'usage-row-2',
      modelId: 'gpt-5.4-mini',
    });
  });

  it('treats an empty completion as a failure with its own code', async () => {
    // `AiRunOk.text` is a `string`, not `string | null`: a caller rendering an
    // explanation has nothing to do with an empty one, and making every call
    // site check is how an empty tutor bubble ships.
    const provider = providerDouble({
      complete: jest.fn().mockResolvedValue({
        success: true,
        text: '',
        usage: USAGE,
        errorCode: null,
        error: null,
        usageEventId: 'usage-row-3',
      } satisfies AiRecordedCompletionResult),
    });
    const { service } = build(readySettings(), USER_KEY, provider);
    const result = await service.run(ALICE, 'grader', { messages: MESSAGES });

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'empty_completion',
      usageEventId: 'usage-row-3',
    });
  });

  it('never rejects when the settings row cannot be read', async () => {
    // `AiSettingsService.get` throws on a stored-but-invalid row rather than
    // substituting defaults. That fault must arrive as `failed` — NOT as
    // `unavailable`, which would report a broken deployment as one an
    // administrator deliberately switched off, indefinitely and invisibly.
    const settings = {
      get: jest.fn().mockRejectedValue(new Error('Stored AI settings are invalid at: models')),
    } as unknown as AiSettingsService;
    const service = new AiDispatchService(
      settings,
      credentialsReturning(USER_KEY),
      providerDouble(),
    );

    const result = await service.run(ALICE, 'grader', { messages: MESSAGES });

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'dispatch_error',
      usageEventId: null,
      modelId: '',
    });
  });

  it('never rejects when the provider itself throws', async () => {
    // The provider contract says it cannot, and this service does not take
    // that on trust: a double, a decorator or a future implementation can all
    // break it, and the symptom would be a rejected promise in a learner's
    // request path.
    const provider = providerDouble({
      complete: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const { service } = build(readySettings(), USER_KEY, provider);

    await expect(
      service.run(ALICE, 'grader', { messages: MESSAGES }),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'dispatch_error' });
  });
});

describe('AiDispatchService.runStructured', () => {
  const schema = z.object({ verdict: z.string() });

  it('returns the validated value on success', async () => {
    const { service } = build(readySettings(), USER_KEY);

    const result = await service.runStructured(ALICE, 'grader', {
      messages: MESSAGES,
      schemaName: 'grade',
      schema,
    });

    expect(result).toEqual({
      status: 'ok',
      data: { verdict: 'correct' },
      usage: USAGE,
      usageEventId: 'usage-row-1',
      modelId: 'gpt-5.4-mini',
    });
  });

  it('forwards the schema and its name to the provider unchanged', async () => {
    const { service, provider } = build(readySettings(), USER_KEY);

    await service.runStructured(ALICE, 'grader', {
      messages: MESSAGES,
      schemaName: 'grade',
      schema,
    });

    expect(provider.completeStructured).toHaveBeenCalledWith(ALICE, USER_KEY, {
      roleKey: 'grader',
      modelId: 'gpt-5.4-mini',
      messages: MESSAGES,
      maxTokens: undefined,
      schemaName: 'grade',
      schema,
    });
  });

  it('reports a reply that did not satisfy the schema as failed', async () => {
    // Rung 3 of the grading ladder: a schema-invalid result falls back exactly
    // as an unavailable one does, so `data` is never a partial object a caller
    // could mistake for a grade.
    const provider = providerDouble({
      completeStructured: jest.fn().mockResolvedValue({
        success: false,
        data: null,
        usage: USAGE,
        errorCode: 'schema_validation_failed',
        error: 'OpenAI: the reply did not match schema grade (1 issue: invalid_type).',
        usageEventId: 'usage-row-4',
      } satisfies AiStructuredCompletionResult<unknown>),
    });
    const { service } = build(readySettings(), USER_KEY, provider);

    expect(
      await service.runStructured(ALICE, 'grader', {
        messages: MESSAGES,
        schemaName: 'grade',
        schema,
      }),
    ).toMatchObject({
      status: 'failed',
      errorCode: 'schema_validation_failed',
      usageEventId: 'usage-row-4',
    });
  });

  it('never rejects', async () => {
    const provider = providerDouble({
      completeStructured: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const { service } = build(readySettings(), USER_KEY, provider);

    await expect(
      service.runStructured(ALICE, 'grader', {
        messages: MESSAGES,
        schemaName: 'grade',
        schema,
      }),
    ).resolves.toMatchObject({ status: 'failed' });
  });
});

describe('AiDispatchService.runStream', () => {
  async function* twoEvents(): AsyncGenerator<AiStreamEvent, void, undefined> {
    yield { type: 'delta', text: 'hello ' };
    yield { type: 'done', usage: USAGE, usageEventId: 'usage-row-5' };
  }

  it('hands back the provider`s own event stream', async () => {
    const provider = providerDouble({ stream: jest.fn().mockReturnValue(twoEvents()) });
    const { service } = build(readySettings(), USER_KEY, provider);

    const result = await service.runStream(ALICE, 'tutor', { messages: MESSAGES });

    if (result.status !== 'ok') throw new Error('expected an open stream');
    expect(result.modelId).toBe('gpt-5.4-mini');
    expect(await collect(result.events)).toEqual([
      { type: 'delta', text: 'hello ' },
      { type: 'done', usage: USAGE, usageEventId: 'usage-row-5' },
    ]);
  });

  it('passes the abort signal through to the provider', async () => {
    // Without it an abandoned generation keeps being produced and billed after
    // the reader is gone.
    const provider = providerDouble({ stream: jest.fn().mockReturnValue(twoEvents()) });
    const { service } = build(readySettings(), USER_KEY, provider);
    const controller = new AbortController();

    await service.runStream(ALICE, 'tutor', { messages: MESSAGES }, controller.signal);

    expect(provider.stream).toHaveBeenCalledWith(
      ALICE,
      USER_KEY,
      expect.objectContaining({ roleKey: 'tutor', modelId: 'gpt-5.4-mini' }),
      controller.signal,
    );
  });

  it('reports a resolution fault as a one-event error stream, not a second shape', async () => {
    // `AiStreamRunResult` has no `failed` variant: an SSE consumer's terminal
    // event handling IS its failure handling, and a second shape means one of
    // the two paths gets written badly.
    const settings = {
      get: jest.fn().mockRejectedValue(new Error('Stored AI settings are invalid')),
    } as unknown as AiSettingsService;
    const service = new AiDispatchService(
      settings,
      credentialsReturning(USER_KEY),
      providerDouble(),
    );

    const result = await service.runStream(ALICE, 'tutor', { messages: MESSAGES });

    if (result.status !== 'ok') throw new Error('expected an open stream');

    const events = await collect(result.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      errorCode: 'dispatch_error',
      // NULL, NEVER ZERO: nothing was spent, so nothing is claimed.
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      usageEventId: null,
    });
  });

  it('still returns unavailable rather than an error stream when nothing was attempted', async () => {
    // `unavailable` is not a failure — no call was made, no tokens were spent,
    // and the caller renders a configuration message rather than a broken
    // answer.
    const { service } = build(readySettings({ enabled: false }), USER_KEY);

    expect(
      await service.runStream(ALICE, 'tutor', { messages: MESSAGES }),
    ).toEqual({ status: 'unavailable', cause: 'ai_disabled' });
  });
});

// =============================================================================
// The absence: this service cannot read the organisation's key
// =============================================================================
//
// A RUNTIME ASSERTION CANNOT EXPRESS THIS CLAIM. The strongest behavioural
// version — "on the `no_user_key` path, `getSecret` was not called with the
// server address" — proves something about one execution of one path. The
// property that matters is universal: NO path, including paths added next
// year, may reach the organisation's credential. And the fallback
// `ai-evaluation.md` §5 warns about would be added exactly where a
// behavioural test is weakest: inside the `no_user_key` branch, whose whole
// premise is that the caller's own key was not found, where "just fall back to
// the server key" reads like a fix rather than a policy change.
//
// So the assertion is made against the SOURCE. It cannot be satisfied by a
// path that happens not to run, and it cannot be quietly relaxed: adding the
// fallback means deleting a test whose name says why it exists.
// =============================================================================

/**
 * The service's own source.
 *
 * NOT COMMENT-STRIPPED, unlike `ai-user-key.controller.spec.ts`'s equivalent.
 * There the file's header quotes the very decorators the rule forbids, so
 * matching them would fail the test for documenting itself. Here the opposite
 * discipline applies and is stated in the file's own header: the service must
 * not NAME the server-key constants even in prose, because a comment
 * mentioning them is a comment one copy-paste away from a call site using
 * them.
 */
const DISPATCH_SOURCE = readFileSync(
  join(__dirname, 'ai-dispatch.service.ts'),
  'utf8',
);

describe('AiDispatchService — the server key is unreachable from this file', () => {
  it('does not name the server credential constants at all', () => {
    // One assertion covering both constants: they share a prefix, and a file
    // that names either has already lost the property.
    expect(DISPATCH_SOURCE).not.toContain('AI_SYSTEM_CREDENTIAL');
  });

  it('does not spell the server credential address literally', () => {
    // The constants could be bypassed by writing the strings out. The address
    // is `('ai', 'openai')` — see `ai-credential.constants.ts`.
    expect(DISPATCH_SOURCE).not.toContain(`'${AI_SYSTEM_CREDENTIAL_PURPOSE}'`);
    expect(DISPATCH_SOURCE).not.toContain(`"${AI_SYSTEM_CREDENTIAL_PURPOSE}"`);
    expect(DISPATCH_SOURCE).not.toContain(`'${AI_SYSTEM_CREDENTIAL_NAME}'`);
    expect(DISPATCH_SOURCE).not.toContain(`"${AI_SYSTEM_CREDENTIAL_NAME}"`);
  });

  it('reads exactly one credential address, the caller`s own', () => {
    // A second `getSecret` call is the shape a fallback takes. One call site,
    // and the test above says which one it is not.
    const calls = DISPATCH_SOURCE.match(/getSecret\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});

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
  AiRealtimeSessionResult,
  AiRecordedCompletionResult,
  AiStreamEvent,
  AiStructuredCompletionResult,
  AiSynthesisResult,
  AiTranscriptionResult,
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

/**
 * Usage as the SPEECH surface really reports it: all-null.
 *
 * The speech APIs bill by audio duration and report no token counts, so a
 * fixture with plausible numbers would let these tests be written against
 * figures production never sends. See `AiTranscriptionResult.usage`.
 */
const SPEECH_USAGE: AiUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
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
    transcribe: jest.fn().mockResolvedValue({
      success: true,
      text: 'the president',
      confidence: 0.92,
      usage: SPEECH_USAGE,
      errorCode: null,
      error: null,
    } satisfies AiTranscriptionResult),
    synthesize: jest.fn().mockResolvedValue({
      success: true,
      audio: Buffer.from([0x49, 0x44, 0x33]),
      contentType: 'audio/mpeg',
      usage: SPEECH_USAGE,
      errorCode: null,
      error: null,
    } satisfies AiSynthesisResult),
    createRealtimeSession: jest.fn().mockResolvedValue({
      success: true,
      clientSecret: MINTED_SECRET,
      expiresAt: SECRET_EXPIRY,
      modelId: 'gpt-4o-realtime-preview',
      // ALL-NULL, and here it is not even "we were not told": minting a
      // credential runs no inference. See `AiRealtimeSessionResult.usage`.
      usage: SPEECH_USAGE,
      errorCode: null,
      error: null,
    } satisfies AiRealtimeSessionResult),
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

/**
 * What a realtime mint hands back.
 *
 * LONG ENOUGH TO BE REDACTABLE rather than withheld whole: `SecretRedactor`
 * replaces a secret in place only past a minimum length, and a short fixture
 * would exercise the "withhold the entire message" branch instead of the one
 * production takes.
 */
const MINTED_SECRET = 'ek_realtime_abcdefghijklmnopqrstuvwxyz';
const SECRET_EXPIRY = new Date('2026-06-01T12:01:00Z');
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
// =============================================================================
// The two speech methods (issue #95, epic #58)
// =============================================================================
//
// They are siblings of `run`, not variants of it, so what is worth testing is
// exactly what they SHARE with it and what they deliberately do not:
//
//   * They resolve through the same private `resolve` — same five checks, same
//     order, the caller's own key last. Tested by producing each of the four
//     causes through the speech methods and by the both-broken ordering case.
//   * They pass the role's own key through to the provider, so the usage row
//     `BaseAiProvider` writes is attributed to `transcribe`/`speak` and not to
//     whatever role happened to be nearby.
//   * An empty transcript is a SUCCESS and empty audio is a FAILURE. These
//     look inconsistent until you read what each one means about the input,
//     which is why both have a test.
// =============================================================================

const AUDIO = Buffer.from('fake webm bytes');

/** Settings with both speech roles bound. */
function speechSettings(overrides: Partial<AiSettings> = {}): AiSettings {
  return readySettings({
    models: {
      ...DEFAULT_AI_SETTINGS.models,
      tutor: 'gpt-5.4-mini',
      grader: 'gpt-5.4-mini',
      transcribe: 'gpt-4o-transcribe',
      speak: 'gpt-4o-mini-tts',
    },
    ...overrides,
  });
}

const TRANSCRIBE_REQUEST = {
  audio: AUDIO,
  contentType: 'audio/webm',
  fileName: 'recording.webm',
};

describe('AiDispatchService.transcribe', () => {
  it('returns the transcript, the confidence and the bound model', async () => {
    const { service } = build(speechSettings(), USER_KEY);

    expect(await service.transcribe(ALICE, TRANSCRIBE_REQUEST)).toEqual({
      status: 'ok',
      text: 'the president',
      confidence: 0.92,
      usage: SPEECH_USAGE,
      modelId: 'gpt-4o-transcribe',
    });
  });

  it('runs on the caller`s own key and names the transcribe role to the provider', async () => {
    // The role key is what `BaseAiProvider.recordUsage` writes to
    // `ai_usage_events.roleKey`. Asserted here, at the one place this service
    // chooses it, rather than only end-to-end.
    const { service, provider } = build(speechSettings(), USER_KEY);

    await service.transcribe(ALICE, TRANSCRIBE_REQUEST);

    expect(provider.transcribe).toHaveBeenCalledWith(
      ALICE,
      USER_KEY,
      expect.objectContaining({
        roleKey: 'transcribe',
        modelId: 'gpt-4o-transcribe',
        audio: AUDIO,
        contentType: 'audio/webm',
        fileName: 'recording.webm',
      }),
    );
  });

  it('passes a null confidence through rather than coalescing it to 0', async () => {
    // The whole reason the field is nullable: a 0 asserts the recogniser was
    // certain it heard nothing, on the signal a caller uses to decide an
    // answer was MISHEARD rather than wrong.
    const provider = providerDouble({
      transcribe: jest.fn().mockResolvedValue({
        success: true,
        text: 'the president',
        confidence: null,
        usage: SPEECH_USAGE,
        errorCode: null,
        error: null,
      } satisfies AiTranscriptionResult),
    });
    const { service } = build(speechSettings(), USER_KEY, provider);

    const result = await service.transcribe(ALICE, TRANSCRIBE_REQUEST);

    expect(result).toMatchObject({ status: 'ok', confidence: null });
  });

  it('treats an empty transcript as a success, unlike an empty completion', async () => {
    // A recording of silence really did transcribe to nothing. `run` calls an
    // empty completion a failure; this must not inherit that.
    const provider = providerDouble({
      transcribe: jest.fn().mockResolvedValue({
        success: true,
        text: '',
        confidence: 0.1,
        usage: SPEECH_USAGE,
        errorCode: null,
        error: null,
      } satisfies AiTranscriptionResult),
    });
    const { service } = build(speechSettings(), USER_KEY, provider);

    expect(await service.transcribe(ALICE, TRANSCRIBE_REQUEST)).toMatchObject({
      status: 'ok',
      text: '',
    });
  });

  it('reports a provider failure as failed, not unavailable', async () => {
    const provider = providerDouble({
      transcribe: jest.fn().mockResolvedValue({
        success: false,
        text: null,
        confidence: null,
        usage: SPEECH_USAGE,
        errorCode: 'unsupported_format',
        error: 'The audio format is not supported.',
      } satisfies AiTranscriptionResult),
    });
    const { service } = build(speechSettings(), USER_KEY, provider);

    expect(await service.transcribe(ALICE, TRANSCRIBE_REQUEST)).toEqual({
      status: 'failed',
      errorCode: 'unsupported_format',
      error: 'The audio format is not supported.',
      usageEventId: null,
      modelId: 'gpt-4o-transcribe',
    });
  });

  it('reports a success with no transcript at all as failed', async () => {
    // `null`, not `''` — a provider contract violation rather than silence.
    const provider = providerDouble({
      transcribe: jest.fn().mockResolvedValue({
        success: true,
        text: null,
        confidence: null,
        usage: SPEECH_USAGE,
        errorCode: null,
        error: null,
      } satisfies AiTranscriptionResult),
    });
    const { service } = build(speechSettings(), USER_KEY, provider);

    expect(await service.transcribe(ALICE, TRANSCRIBE_REQUEST)).toMatchObject({
      status: 'failed',
      errorCode: 'empty_transcription',
    });
  });

  it('never rejects when the provider throws', async () => {
    const provider = providerDouble({
      transcribe: jest.fn().mockRejectedValue(new Error('socket hang up')),
    });
    const { service } = build(speechSettings(), USER_KEY, provider);

    await expect(
      service.transcribe(ALICE, TRANSCRIBE_REQUEST),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'dispatch_error' });
  });
});

describe('AiDispatchService.synthesize', () => {
  it('returns the audio, the provider`s content type and the bound model', async () => {
    const { service } = build(speechSettings(), USER_KEY);

    const result = await service.synthesize(ALICE, { text: 'Who is the President?' });

    expect(result).toMatchObject({
      status: 'ok',
      contentType: 'audio/mpeg',
      modelId: 'gpt-4o-mini-tts',
    });
    expect((result as { audio: Buffer }).audio).toEqual(
      Buffer.from([0x49, 0x44, 0x33]),
    );
  });

  it('runs on the caller`s own key and names the speak role to the provider', async () => {
    const { service, provider } = build(speechSettings(), USER_KEY);

    await service.synthesize(ALICE, { text: 'Hello', voice: 'alloy', format: 'mp3' });

    expect(provider.synthesize).toHaveBeenCalledWith(
      ALICE,
      USER_KEY,
      expect.objectContaining({
        roleKey: 'speak',
        modelId: 'gpt-4o-mini-tts',
        text: 'Hello',
        voice: 'alloy',
        format: 'mp3',
      }),
    );
  });

  it('treats zero-length audio as a failure, unlike an empty transcript', async () => {
    // There is no text whose honest synthesis is no sound, so this direction
    // of the asymmetry is deliberate.
    const provider = providerDouble({
      synthesize: jest.fn().mockResolvedValue({
        success: true,
        audio: Buffer.alloc(0),
        contentType: 'audio/mpeg',
        usage: SPEECH_USAGE,
        errorCode: null,
        error: null,
      } satisfies AiSynthesisResult),
    });
    const { service } = build(speechSettings(), USER_KEY, provider);

    expect(await service.synthesize(ALICE, { text: 'Hello' })).toMatchObject({
      status: 'failed',
      errorCode: 'empty_synthesis',
      error: 'The provider reported success and returned no audio.',
    });
  });

  it('treats audio with no content type as a failure, and says which half was missing', async () => {
    const provider = providerDouble({
      synthesize: jest.fn().mockResolvedValue({
        success: true,
        audio: Buffer.from([1, 2, 3]),
        contentType: null,
        usage: SPEECH_USAGE,
        errorCode: null,
        error: null,
      } satisfies AiSynthesisResult),
    });
    const { service } = build(speechSettings(), USER_KEY, provider);

    expect(await service.synthesize(ALICE, { text: 'Hello' })).toMatchObject({
      status: 'failed',
      errorCode: 'empty_synthesis',
      error: 'The provider reported success and returned no content type.',
    });
  });

  it('never rejects when the provider throws', async () => {
    const provider = providerDouble({
      synthesize: jest.fn().mockRejectedValue(new Error('socket hang up')),
    });
    const { service } = build(speechSettings(), USER_KEY, provider);

    await expect(
      service.synthesize(ALICE, { text: 'Hello' }),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'dispatch_error' });
  });
});

// =============================================================================
// Realtime session minting (issue #157, epic #60 — E11)
// =============================================================================
//
// The same three kinds of property the speech block covers, plus one this
// surface is the only place in the file that has: the thing that comes BACK is
// itself a credential. So there is a test that a throw raised after the mint
// cannot quote it, and the file-level "the server key is unreachable" block at
// the bottom already covers the other half — a browser-facing secret minted on
// the organisation's key would be the most expensive instance of exactly the
// failure that block exists to forbid.
// =============================================================================

/** Settings with the realtime role bound. */
function realtimeSettings(overrides: Partial<AiSettings> = {}): AiSettings {
  return readySettings({
    models: {
      ...DEFAULT_AI_SETTINGS.models,
      tutor: 'gpt-5.4-mini',
      grader: 'gpt-5.4-mini',
      realtime: 'gpt-4o-realtime-preview',
    },
    ...overrides,
  });
}

const REALTIME_REQUEST = {
  instructions: 'You are an immigration officer conducting a practice interview.',
  tools: [
    {
      name: 'next_question',
      description: 'Ask for the next thing to say.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
};

describe('AiDispatchService.createRealtimeSession', () => {
  it('returns the ephemeral secret, its expiry and the bound model', async () => {
    const { service } = build(realtimeSettings(), USER_KEY);

    expect(await service.createRealtimeSession(ALICE, REALTIME_REQUEST)).toEqual({
      status: 'ok',
      clientSecret: MINTED_SECRET,
      expiresAt: SECRET_EXPIRY,
      modelId: 'gpt-4o-realtime-preview',
    });
  });

  it('returns nothing else — no usage, no key, no echo of the configuration', async () => {
    // What reaches a browser is bounded by what this method returns. A `usage`
    // field of three nulls would be read as this session's cost, which is the
    // one thing it is not; anything echoing the request back is a second copy
    // of the officer's prompt on a path that does not need one.
    const result = await build(realtimeSettings(), USER_KEY).service.createRealtimeSession(
      ALICE,
      REALTIME_REQUEST,
    );

    expect(Object.keys(result).sort()).toEqual([
      'clientSecret',
      'expiresAt',
      'modelId',
      'status',
    ]);
  });

  it('runs on the caller`s own key and names the realtime role to the provider', async () => {
    // The role key is what `BaseAiProvider.recordUsage` writes to
    // `ai_usage_events.roleKey`. Asserted at the one place this service
    // chooses it.
    const { service, provider } = build(realtimeSettings(), USER_KEY);

    await service.createRealtimeSession(ALICE, {
      ...REALTIME_REQUEST,
      voice: 'alloy',
      expiresInSeconds: 60,
    });

    expect(provider.createRealtimeSession).toHaveBeenCalledWith(
      ALICE,
      USER_KEY,
      {
        roleKey: 'realtime',
        modelId: 'gpt-4o-realtime-preview',
        instructions: REALTIME_REQUEST.instructions,
        tools: REALTIME_REQUEST.tools,
        voice: 'alloy',
        expiresInSeconds: 60,
      },
    );
  });

  it('reports the resolved binding as `modelId`, not the provider`s echo', async () => {
    // Every other `ok` result in this file means "the model this dispatcher
    // chose" by that name. A provider that echoed something else would
    // otherwise make this one method's field mean a different thing.
    const provider = providerDouble({
      createRealtimeSession: jest.fn().mockResolvedValue({
        success: true,
        clientSecret: MINTED_SECRET,
        expiresAt: SECRET_EXPIRY,
        modelId: 'something-the-provider-substituted',
        usage: SPEECH_USAGE,
        errorCode: null,
        error: null,
      } satisfies AiRealtimeSessionResult),
    });
    const { service } = build(realtimeSettings(), USER_KEY, provider);

    expect(
      await service.createRealtimeSession(ALICE, REALTIME_REQUEST),
    ).toMatchObject({ modelId: 'gpt-4o-realtime-preview' });
  });

  it('treats a success with no client secret as a failure with its own code', async () => {
    const provider = providerDouble({
      createRealtimeSession: jest.fn().mockResolvedValue({
        success: true,
        clientSecret: null,
        expiresAt: SECRET_EXPIRY,
        modelId: 'gpt-4o-realtime-preview',
        usage: SPEECH_USAGE,
        errorCode: null,
        error: null,
      } satisfies AiRealtimeSessionResult),
    });
    const { service } = build(realtimeSettings(), USER_KEY, provider);

    expect(
      await service.createRealtimeSession(ALICE, REALTIME_REQUEST),
    ).toMatchObject({
      status: 'failed',
      errorCode: 'empty_realtime_session',
      error: 'The provider reported success and returned no client secret.',
    });
  });

  it('treats a success with no expiry as a failure too, and says which half', async () => {
    // A secret a browser cannot date is a browser that cannot know when to
    // re-mint — `realtime-interview.md` §3's own resume rule needs the number.
    const provider = providerDouble({
      createRealtimeSession: jest.fn().mockResolvedValue({
        success: true,
        clientSecret: MINTED_SECRET,
        expiresAt: null,
        modelId: 'gpt-4o-realtime-preview',
        usage: SPEECH_USAGE,
        errorCode: null,
        error: null,
      } satisfies AiRealtimeSessionResult),
    });
    const { service } = build(realtimeSettings(), USER_KEY, provider);

    expect(
      await service.createRealtimeSession(ALICE, REALTIME_REQUEST),
    ).toMatchObject({
      status: 'failed',
      errorCode: 'empty_realtime_session',
      error: 'The provider reported success and returned no expiry.',
    });
  });

  it('reports a provider failure as failed, not unavailable', async () => {
    const provider = providerDouble({
      createRealtimeSession: jest.fn().mockResolvedValue({
        success: false,
        clientSecret: null,
        expiresAt: null,
        modelId: null,
        usage: SPEECH_USAGE,
        errorCode: 'rate_limited',
        error: 'Too many requests.',
      } satisfies AiRealtimeSessionResult),
    });
    const { service } = build(realtimeSettings(), USER_KEY, provider);

    expect(
      await service.createRealtimeSession(ALICE, REALTIME_REQUEST),
    ).toMatchObject({
      status: 'failed',
      errorCode: 'rate_limited',
      error: 'Too many requests.',
    });
  });

  it('never rejects when the provider throws', async () => {
    const provider = providerDouble({
      createRealtimeSession: jest.fn().mockRejectedValue(new Error('socket hang up')),
    });
    const { service } = build(realtimeSettings(), USER_KEY, provider);

    await expect(
      service.createRealtimeSession(ALICE, REALTIME_REQUEST),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'dispatch_error' });
  });

  it('never quotes the minted secret in an error raised after the mint', async () => {
    // CONTRIVED ON PURPOSE, and the contrivance is the point. The getter below
    // stands in for a future edit between the mint and the return that raises
    // while the secret is in scope — the one path `BaseAiProvider`'s own
    // redactor does not cover, because the string being formatted is this
    // file's, not the provider's. Without `redact.protect(result.clientSecret)`
    // this assertion fails and a live bearer credential reaches a log.
    const provider = providerDouble({
      createRealtimeSession: jest.fn().mockResolvedValue({
        success: true,
        clientSecret: MINTED_SECRET,
        get expiresAt(): Date {
          throw new Error(`the session ${MINTED_SECRET} could not be read`);
        },
        modelId: 'gpt-4o-realtime-preview',
        usage: SPEECH_USAGE,
        errorCode: null,
        error: null,
      }),
    });
    const { service } = build(realtimeSettings(), USER_KEY, provider);

    const result = await service.createRealtimeSession(ALICE, REALTIME_REQUEST);

    expect(result).toMatchObject({ status: 'failed', errorCode: 'dispatch_error' });
    expect(JSON.stringify(result)).not.toContain(MINTED_SECRET);
  });

  it.each([
    ['no key stored', realtimeSettings(), null, 'no_user_key'],
    ['the master switch off', realtimeSettings({ enabled: false }), USER_KEY, 'ai_disabled'],
    [
      'the role unbound',
      readySettings({ models: { ...DEFAULT_AI_SETTINGS.models, realtime: null } }),
      USER_KEY,
      'role_unbound',
    ],
  ] as const)(
    'shares `resolve` with `run`: reports %s as its own cause',
    async (_case, settings, secret, cause) => {
      const { service, provider } = build(settings, secret);

      expect(
        await service.createRealtimeSession(ALICE, REALTIME_REQUEST),
      ).toEqual({ status: 'unavailable', cause });

      // NO MINT WAS ATTEMPTED. `unavailable` is a call that never ran.
      expect(provider.createRealtimeSession).not.toHaveBeenCalled();
    },
  );

  it('reports capability_unsupported when the provider has no realtime surface', async () => {
    // The first cause this codebase can produce in production, on the day a
    // text-only provider is configured: OpenAI declares all six families.
    const provider = providerDouble({
      capabilities: new Set(['text']),
      supports: jest.fn((family: string) => family === 'text'),
    } as Partial<AiProvider>);
    const { service } = build(realtimeSettings(), USER_KEY, provider);

    expect(
      await service.createRealtimeSession(ALICE, REALTIME_REQUEST),
    ).toEqual({ status: 'unavailable', cause: 'capability_unsupported' });
  });

  it('reports the administrator`s gap before the caller`s missing key', async () => {
    const { service } = build(realtimeSettings({ enabled: false }), null);

    expect(
      await service.createRealtimeSession(ALICE, REALTIME_REQUEST),
    ).toEqual({ status: 'unavailable', cause: 'ai_disabled' });
  });

  it('does not decrypt the caller`s key for a mint an unbound role would refuse', async () => {
    const settings = readySettings({
      models: { ...DEFAULT_AI_SETTINGS.models, realtime: null },
    });
    const { service, credentials } = build(settings, USER_KEY);

    await service.createRealtimeSession(ALICE, REALTIME_REQUEST);

    expect(credentials.getSecret).not.toHaveBeenCalled();
  });
});

describe('the speech methods share `resolve` with `run`', () => {
  it.each([
    ['no key stored', speechSettings(), null, 'no_user_key'],
    ['the master switch off', speechSettings({ enabled: false }), USER_KEY, 'ai_disabled'],
    [
      'the role unbound',
      readySettings({
        models: { ...DEFAULT_AI_SETTINGS.models, transcribe: null, speak: null },
      }),
      USER_KEY,
      'role_unbound',
    ],
  ] as const)(
    'reports %s as its own cause, for both methods',
    async (_case, settings, secret, cause) => {
      const { service, provider } = build(settings, secret);

      expect(await service.transcribe(ALICE, TRANSCRIBE_REQUEST)).toEqual({
        status: 'unavailable',
        cause,
      });
      expect(await service.synthesize(ALICE, { text: 'Hello' })).toEqual({
        status: 'unavailable',
        cause,
      });

      // NO CALL WAS ATTEMPTED. `unavailable` is not a failure that happened,
      // it is a call that never ran — and a learner's key must not be spent
      // finding that out.
      expect(provider.transcribe).not.toHaveBeenCalled();
      expect(provider.synthesize).not.toHaveBeenCalled();
    },
  );

  it('reports capability_unsupported when the provider has no speech surface', async () => {
    // The FIRST cause this codebase can produce in production: a text-only
    // provider (Anthropic, Kimi, Qwen) declares no `transcribe`/`tts` family
    // at all, while OpenAI declares all six.
    const provider = providerDouble({
      capabilities: new Set(['text']),
      supports: jest.fn((family: string) => family === 'text'),
    } as Partial<AiProvider>);
    const { service } = build(speechSettings(), USER_KEY, provider);

    expect(await service.transcribe(ALICE, TRANSCRIBE_REQUEST)).toEqual({
      status: 'unavailable',
      cause: 'capability_unsupported',
    });
    expect(await service.synthesize(ALICE, { text: 'Hello' })).toEqual({
      status: 'unavailable',
      cause: 'capability_unsupported',
    });
  });

  it('reports the administrator`s gap before the caller`s missing key', async () => {
    // Both broken at once. Telling the caller about their own missing key
    // would send them to store one that still would not work — the ordering
    // `run` already guarantees, inherited here rather than re-implemented.
    const { service } = build(speechSettings({ enabled: false }), null);

    expect(await service.transcribe(ALICE, TRANSCRIBE_REQUEST)).toEqual({
      status: 'unavailable',
      cause: 'ai_disabled',
    });
  });

  it('does not decrypt the caller`s key for a call an unbound role would refuse', async () => {
    // The reason the key lookup is step five: the refusal costs one settings
    // read, not a trip through the cipher.
    const settings = readySettings({
      models: { ...DEFAULT_AI_SETTINGS.models, transcribe: null },
    });
    const { service, credentials } = build(settings, USER_KEY);

    await service.transcribe(ALICE, TRANSCRIBE_REQUEST);

    expect(credentials.getSecret).not.toHaveBeenCalled();
  });
});

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

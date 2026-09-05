import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { Logger } from '@nestjs/common';
import { z } from 'zod';

import {
  DEFAULT_SPEECH_VOICE,
  OpenAiProvider,
  deriveConfidence,
  describeModel,
  isOutputLimitOutcome,
  isUnsupportedParameterError,
  isUnsupportedResponseFormatError,
  readSessionModel,
  realtimeExpiry,
  wantsVerboseTranscription,
} from './openai.provider';
import {
  AI_SYSTEM_CREDENTIAL_NAME,
  AI_SYSTEM_CREDENTIAL_PURPOSE,
} from '../ai-credential.constants';
import type { CredentialsService } from '../../credentials/credentials.service';
import type { AiUsageService } from '../ai-usage.service';
import type { AiStreamEvent } from '../ai.types';

// =============================================================================
// OpenAiProvider (issue #29, epic #25)
// =============================================================================
//
// The classification rules themselves are tested against a real-id fixture in
// model-classifier.spec.ts. What is left here is everything that touches the
// credential store, the SDK, or the cache:
//
//   * a missing server credential is "not configured", never a crash;
//   * the catalog is cached, and the cache does NOT survive a key change;
//   * the key reaches no result, error, or log line;
//   * `testConnection` separates "bad key" from "no access to that model".
//
// The SDK is mocked at the module boundary rather than over HTTP: the thing
// under test is this class's control flow, and a fake transport would only add
// a second place for the shape of an OpenAI response to be wrong.
// =============================================================================

const listMock = jest.fn();
const chatCreateMock = jest.fn();
const embeddingsCreateMock = jest.fn();
const retrieveMock = jest.fn();
const transcriptionsCreateMock = jest.fn();
const speechCreateMock = jest.fn();
const clientSecretsCreateMock = jest.fn();
const constructedWith: Array<Record<string, unknown>> = [];

jest.mock('openai', () => {
  return {
    __esModule: true,
    default: class FakeOpenAI {
      models = { list: listMock, retrieve: retrieveMock };
      chat = { completions: { create: chatCreateMock } };
      embeddings = { create: embeddingsCreateMock };
      audio = {
        transcriptions: { create: transcriptionsCreateMock },
        speech: { create: speechCreateMock },
      };
      realtime = { clientSecrets: { create: clientSecretsCreateMock } };
      constructor(opts: Record<string, unknown>) {
        constructedWith.push(opts);
      }
    },
  };
});

/** An async-iterable page of catalog entries, as the SDK's `list()` returns. */
function catalogOf(ids: Array<{ id: string; created?: number }>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const entry of ids) yield entry;
    },
  };
}

const SERVER_KEY = 'sk-server-abcdefghijklmnopqrst';

/**
 * Recording is exercised in ai-usage.spec.ts; here it only has to exist.
 *
 * It returns a row id because `AiUsageService.record` does since #96 — a
 * double that returned nothing would let `usageEventId` be dropped silently.
 */
function usageStub() {
  return {
    record: jest.fn().mockResolvedValue('usage-row-1'),
  } as unknown as AiUsageService;
}

function credentialsReturning(secret: string | null): CredentialsService {
  return {
    getSecret: jest.fn().mockResolvedValue(secret),
  } as unknown as CredentialsService;
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

beforeEach(() => {
  listMock.mockReset();
  chatCreateMock.mockReset();
  embeddingsCreateMock.mockReset();
  retrieveMock.mockReset();
  transcriptionsCreateMock.mockReset();
  speechCreateMock.mockReset();
  clientSecretsCreateMock.mockReset();
  constructedWith.length = 0;
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('OpenAiProvider — identity', () => {
  it('declares itself as the openai kind', () => {
    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    expect(p.kind).toBe('openai');
  });

  it('declares every capability family, unlike a chat-only provider would', () => {
    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    for (const family of [
      'text',
      'realtime',
      'transcribe',
      'tts',
      'embedding',
    ] as const) {
      expect(p.supports(family)).toBe(true);
    }
  });
});

describe('OpenAiProvider.listModels', () => {
  it('reports "not configured" when no server key is stored, without calling the SDK', async () => {
    // The state of every fresh install. `getSecret` returns null for an absent
    // credential by design, and reporting that as a failure would make a
    // brand-new system look broken.
    const p = new OpenAiProvider(credentialsReturning(null), usageStub());

    await expect(p.listModels()).resolves.toEqual({
      success: false,
      models: [],
      error: null,
      notConfigured: true,
    });
    expect(listMock).not.toHaveBeenCalled();
  });

  it('reads the server credential from the documented address', async () => {
    const credentials = credentialsReturning(SERVER_KEY);
    listMock.mockReturnValue(catalogOf([{ id: 'gpt-5.4', created: 1_700_000_000 }]));

    await new OpenAiProvider(credentials, usageStub()).listModels();

    expect(credentials.getSecret).toHaveBeenCalledWith(
      AI_SYSTEM_CREDENTIAL_PURPOSE,
      AI_SYSTEM_CREDENTIAL_NAME,
    );
  });

  it('classifies every entry it fetches', async () => {
    listMock.mockReturnValue(
      catalogOf([
        { id: 'gpt-5.4', created: 3 },
        { id: 'whisper-1', created: 2 },
        { id: 'some-future-model', created: 1 },
      ]),
    );

    const result = await new OpenAiProvider(
      credentialsReturning(SERVER_KEY),
      usageStub(),
    ).listModels();

    expect(result.success).toBe(true);
    expect(result.models.map((m) => [m.id, m.family])).toEqual(
      expect.arrayContaining([
        ['gpt-5.4', 'text'],
        ['whisper-1', 'transcribe'],
        // Surfaced, not dropped.
        ['some-future-model', 'other'],
      ]),
    );
  });

  it('walks every page rather than truncating to the first', async () => {
    // A catalog longer than one page silently cut short presents to an admin
    // as "that model does not exist".
    listMock.mockReturnValue(
      catalogOf(
        Array.from({ length: 40 }, (_, i) => ({ id: `gpt-5.4-v${i}`, created: i })),
      ),
    );

    const result = await new OpenAiProvider(
      credentialsReturning(SERVER_KEY),
      usageStub(),
    ).listModels();

    expect(result.models).toHaveLength(40);
  });

  it('turns an SDK failure into a diagnosable result, not a throw', async () => {
    listMock.mockImplementation(() => {
      throw new Error('401 Incorrect API key provided');
    });

    const result = await new OpenAiProvider(
      credentialsReturning(SERVER_KEY),
      usageStub(),
    ).listModels();

    expect(result.success).toBe(false);
    expect(result.notConfigured).toBe(false);
    expect(result.error).toContain('401 Incorrect API key provided');
  });

  it('never lets the key reach the error string', async () => {
    // The SDK builds its own error text and may quote the request it made.
    listMock.mockImplementation(() => {
      throw new Error(`Request failed: Authorization: Bearer ${SERVER_KEY}`);
    });

    const result = await new OpenAiProvider(
      credentialsReturning(SERVER_KEY),
      usageStub(),
    ).listModels();

    expect(result.error).not.toContain(SERVER_KEY);
    expect(result.error).toContain('[redacted]');
  });

  it('does not stringify a thrown SDK object, which can hold the key', async () => {
    listMock.mockImplementation(() => {
      // Shaped like an SDK request context.
      throw { request: { headers: { authorization: `Bearer ${SERVER_KEY}` } } };
    });

    const result = await new OpenAiProvider(
      credentialsReturning(SERVER_KEY),
      usageStub(),
    ).listModels();

    expect(result.error).not.toContain(SERVER_KEY);
    expect(result.error).toContain('Non-Error value of type object thrown');
  });
});

describe('OpenAiProvider — catalog cache', () => {
  it('serves a second call from cache', async () => {
    listMock.mockReturnValue(catalogOf([{ id: 'gpt-5.4' }]));
    const p = new OpenAiProvider(credentialsReturning(SERVER_KEY), usageStub());

    await p.listModels();
    await p.listModels();

    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT leak between differing key configurations', async () => {
    // An admin who rotates to a key in a different organisation, with a
    // different model tier, must not keep seeing the old catalog.
    const getSecret = jest
      .fn()
      .mockResolvedValueOnce('sk-org-one-aaaaaaaaaaaaaaa')
      .mockResolvedValueOnce('sk-org-two-bbbbbbbbbbbbbbb');
    const p = new OpenAiProvider(
      { getSecret } as unknown as CredentialsService,
      usageStub(),
    );

    listMock.mockReturnValueOnce(catalogOf([{ id: 'gpt-5.4' }]));
    listMock.mockReturnValueOnce(catalogOf([{ id: 'gpt-5.6' }]));

    const first = await p.listModels();
    const second = await p.listModels();

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(first.models[0].id).toBe('gpt-5.4');
    expect(second.models[0].id).toBe('gpt-5.6');
  });

  it('is dropped by invalidateCatalogCache', async () => {
    // The settings service calls this on every write.
    listMock.mockReturnValue(catalogOf([{ id: 'gpt-5.4' }]));
    const p = new OpenAiProvider(credentialsReturning(SERVER_KEY), usageStub());

    await p.listModels();
    p.invalidateCatalogCache();
    await p.listModels();

    expect(listMock).toHaveBeenCalledTimes(2);
  });
});

describe('OpenAiProvider.testConnection', () => {
  const USER_KEY = 'sk-user-zyxwvutsrqponmlkjih';

  it('reports authentication failure without probing any model', async () => {
    listMock.mockRejectedValue(new Error('401 Incorrect API key provided'));

    const result = await new OpenAiProvider(
      credentialsReturning(null),
      usageStub(),
    ).testConnection(USER_KEY, [
      { roleKey: 'grader', modelId: 'gpt-5.4-mini', family: 'text' },
    ]);

    expect(result.authenticated).toBe(false);
    expect(result.success).toBe(false);
    expect(result.roles).toEqual([]);
    expect(chatCreateMock).not.toHaveBeenCalled();
  });

  it('reports per-role reachability, not a single boolean', async () => {
    // The whole reason this endpoint exists: a key can authenticate perfectly
    // and still have no access to the model the admin bound.
    listMock.mockResolvedValue({ data: [] });
    chatCreateMock
      .mockResolvedValueOnce({ id: 'ok' })
      .mockRejectedValueOnce(new Error('The model `gpt-5.4` does not exist'));

    const result = await new OpenAiProvider(
      credentialsReturning(null),
      usageStub(),
    ).testConnection(USER_KEY, [
      { roleKey: 'tutor', modelId: 'gpt-5.4-mini', family: 'text' },
      { roleKey: 'grader', modelId: 'gpt-5.4', family: 'text' },
    ]);

    expect(result.authenticated).toBe(true);
    expect(result.success).toBe(false);
    expect(result.roles).toHaveLength(2);
    expect(result.roles[0]).toMatchObject({ roleKey: 'tutor', reachable: true });
    expect(result.roles[1]).toMatchObject({
      roleKey: 'grader',
      reachable: false,
    });
    expect(result.roles[1].error).toContain('does not exist');
  });

  it('names the failing role in the summary message', async () => {
    listMock.mockResolvedValue({ data: [] });
    chatCreateMock.mockRejectedValue(new Error('no access'));

    const result = await new OpenAiProvider(
      credentialsReturning(null),
      usageStub(),
    ).testConnection(USER_KEY, [
      { roleKey: 'grader', modelId: 'gpt-5.4', family: 'text' },
    ]);

    expect(result.error).toContain('grader');
  });

  it('succeeds only when every probed model is reachable', async () => {
    listMock.mockResolvedValue({ data: [] });
    chatCreateMock.mockResolvedValue({ id: 'ok' });

    const result = await new OpenAiProvider(
      credentialsReturning(null),
      usageStub(),
    ).testConnection(USER_KEY, [
      { roleKey: 'tutor', modelId: 'gpt-5.4', family: 'text' },
    ]);

    expect(result).toMatchObject({
      success: true,
      authenticated: true,
      error: null,
    });
  });

  it('treats an empty probe list as "does this key authenticate"', async () => {
    listMock.mockResolvedValue({ data: [] });

    const result = await new OpenAiProvider(
      credentialsReturning(null),
      usageStub(),
    ).testConnection(USER_KEY, []);

    expect(result).toMatchObject({ success: true, authenticated: true });
  });

  it('probes an embedding role through the embeddings API, not chat', async () => {
    listMock.mockResolvedValue({ data: [] });
    embeddingsCreateMock.mockResolvedValue({ data: [] });

    await new OpenAiProvider(credentialsReturning(null), usageStub()).testConnection(
      USER_KEY,
      [
        {
          roleKey: 'embed',
          modelId: 'text-embedding-3-small',
          family: 'embedding',
        },
      ],
    );

    expect(embeddingsCreateMock).toHaveBeenCalled();
    expect(chatCreateMock).not.toHaveBeenCalled();
  });

  it('carries on probing after one role fails', async () => {
    // One unreachable model must not abandon the remaining probes and leave
    // the user with a partial report they cannot tell is partial.
    listMock.mockResolvedValue({ data: [] });
    chatCreateMock
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce({ id: 'ok' });

    const result = await new OpenAiProvider(
      credentialsReturning(null),
      usageStub(),
    ).testConnection(USER_KEY, [
      { roleKey: 'tutor', modelId: 'a', family: 'text' },
      { roleKey: 'grader', modelId: 'b', family: 'text' },
    ]);

    expect(result.roles).toHaveLength(2);
    expect(result.roles[1].reachable).toBe(true);
  });

  it('never lets the tested key reach a per-role error', async () => {
    listMock.mockResolvedValue({ data: [] });
    chatCreateMock.mockRejectedValue(
      new Error(`Incorrect API key provided: ${USER_KEY}`),
    );

    const result = await new OpenAiProvider(
      credentialsReturning(null),
      usageStub(),
    ).testConnection(USER_KEY, [
      { roleKey: 'grader', modelId: 'gpt-5.4', family: 'text' },
    ]);

    expect(result.roles[0].error).not.toContain(USER_KEY);
    expect(JSON.stringify(result)).not.toContain(USER_KEY);
  });

  it('bounds the probe with a timeout so a black-holed key fails fast', async () => {
    listMock.mockResolvedValue({ data: [] });

    await new OpenAiProvider(credentialsReturning(null), usageStub()).testConnection(
      USER_KEY,
      [],
    );

    expect(constructedWith.at(-1)).toMatchObject({
      timeout: expect.any(Number),
    });
  });
});

// =============================================================================
// The probe's request shape (issue #176)
// =============================================================================
//
// The bug: the probe asked for ONE completion token, a reasoning model spent it
// on hidden reasoning, OpenAI answered `400 ... model output limit was
// reached`, and a working key was reported as unable to reach the model it is
// bound to. Rotating the key — the only remedy the message suggests — could
// not have helped.
//
// Three claims are tested here, and two of them are about model shapes that do
// not exist yet: the request is built from the model's traits, an output-limit
// outcome IS a reachable model, and a parameter the model does not know costs
// exactly one stripped retry rather than a false negative.
// =============================================================================

describe('OpenAiProvider.testConnection — the probe request', () => {
  const USER_KEY = 'sk-user-zyxwvutsrqponmlkjih';

  /** The verbatim 400 from #176. */
  const OUTPUT_LIMIT_400 =
    '400 Could not finish the message because max_tokens or model output limit was reached. Please try again with higher max_tokens.';

  function probe(modelId: string) {
    return new OpenAiProvider(
      credentialsReturning(null),
      usageStub(),
    ).testConnection(USER_KEY, [
      { roleKey: 'tutor', modelId, family: 'text' as const },
    ]);
  }

  beforeEach(() => {
    listMock.mockResolvedValue({ data: [] });
  });

  it('gives a reasoning model room to finish reasoning, and NEVER asks for one token', async () => {
    chatCreateMock.mockResolvedValue({ id: 'ok' });

    await probe('gpt-5.4-mini');

    const body = chatCreateMock.mock.calls[0][0] as {
      max_completion_tokens: number;
      reasoning_effort?: string;
    };
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(2048);
    expect(body.max_completion_tokens).not.toBe(1);
    // Cheapest tier the model admits: the probe is buying proof, not an answer.
    expect(body.reasoning_effort).toBe('minimal');
  });

  it('uses the o-series effort floor rather than the gpt-5 one', async () => {
    // `minimal` is an `unsupported_value` on the o-series, not a cheaper
    // request.
    chatCreateMock.mockResolvedValue({ id: 'ok' });

    await probe('o3-mini');

    expect(chatCreateMock.mock.calls[0][0]).toMatchObject({
      reasoning_effort: 'low',
    });
  });

  it('sends NO reasoning_effort to a plain chat model, which rejects it', async () => {
    chatCreateMock.mockResolvedValue({ id: 'ok' });

    await probe('gpt-4o');

    expect(chatCreateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ reasoning_effort: expect.anything() }),
    );
  });

  it('sends the probe as a USER turn, the one role every chat shape accepts', async () => {
    // `o1-mini` rejects both `system` and `developer`; the probe tests the key,
    // not the model's instruction handling.
    chatCreateMock.mockResolvedValue({ id: 'ok' });

    await probe('o1-mini');

    expect(chatCreateMock.mock.calls[0][0]).toMatchObject({
      messages: [{ role: 'user', content: 'ping' }],
    });
  });

  it('reports a model that hit the OUTPUT LIMIT as REACHABLE', async () => {
    // THE bug. That error is proof the request reached the model, was
    // authorised, and ran — which is exactly what reachability asks.
    chatCreateMock.mockRejectedValue(new Error(OUTPUT_LIMIT_400));

    const result = await probe('gpt-5.4');

    expect(result.roles[0]).toMatchObject({ reachable: true, error: null });
    expect(result.success).toBe(true);
  });

  it('reads a `length` finish reason on a thrown SDK error the same way', async () => {
    chatCreateMock.mockRejectedValue(
      Object.assign(new Error('the request ran out of budget'), {
        code: 'length',
      }),
    );

    expect((await probe('gpt-5.4')).roles[0].reachable).toBe(true);
  });

  it('accepts a successful but EMPTY completion, asserting nothing about content', async () => {
    // A reasoning model can return with `finish_reason: 'length'` and no
    // visible text. Proof of reach was the whole question; a visible token was
    // never part of it.
    chatCreateMock.mockResolvedValue({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    });

    expect((await probe('gpt-5.4')).roles[0].reachable).toBe(true);
  });

  it('still reports a genuinely unreachable model as unreachable', async () => {
    // The output-limit rule must not swallow the failure the probe exists to
    // find.
    chatCreateMock.mockRejectedValue(
      new Error('404 The model `gpt-5.4` does not exist or you do not have access'),
    );

    const result = await probe('gpt-5.4');

    expect(result.roles[0].reachable).toBe(false);
    expect(result.roles[0].error).toContain('does not exist');
  });

  it('retries EXACTLY ONCE, with a bare body, when a parameter is not supported', async () => {
    // Model naming and parameter surfaces are not ours to control. Reporting a
    // working key as broken because we sent a flag a new model has not adopted
    // is the same failure as #176 itself.
    chatCreateMock
      .mockRejectedValueOnce(
        new Error("400 Unrecognized request argument supplied: reasoning_effort"),
      )
      .mockResolvedValueOnce({ id: 'ok' });

    const result = await probe('gpt-5.4');

    expect(result.roles[0].reachable).toBe(true);
    expect(chatCreateMock).toHaveBeenCalledTimes(2);
    // Nothing optional left: a model and messages, and that is all.
    expect(chatCreateMock.mock.calls[1][0]).toEqual({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'ping' }],
    });
  });

  it('reports the RETRY’s outcome, including its own output-limit reading', async () => {
    chatCreateMock
      .mockRejectedValueOnce(
        new Error('400 Unsupported parameter: reasoning_effort'),
      )
      .mockRejectedValueOnce(new Error(OUTPUT_LIMIT_400));

    expect((await probe('gpt-5.4')).roles[0].reachable).toBe(true);
    expect(chatCreateMock).toHaveBeenCalledTimes(2);
  });

  it('reports the retry’s failure when the stripped request fails too', async () => {
    chatCreateMock
      .mockRejectedValueOnce(
        new Error('400 Unsupported parameter: reasoning_effort'),
      )
      .mockRejectedValueOnce(new Error('401 Incorrect API key provided'));

    const result = await probe('gpt-5.4');

    expect(result.roles[0].reachable).toBe(false);
    expect(result.roles[0].error).toContain('Incorrect API key');
  });

  it('does NOT loop: a second unsupported-parameter error is reported, not retried again', async () => {
    // A loop here is a way to spend someone's money on a diagnostic, and the
    // stripped request has nothing left to strip.
    chatCreateMock.mockRejectedValue(
      new Error('400 Unsupported parameter: messages'),
    );

    const result = await probe('gpt-5.4');

    expect(chatCreateMock).toHaveBeenCalledTimes(2);
    expect(result.roles[0].reachable).toBe(false);
  });

  it('does not retry a failure that has nothing to do with our parameters', async () => {
    chatCreateMock.mockRejectedValue(new Error('429 Rate limit reached'));

    await probe('gpt-5.4');

    expect(chatCreateMock).toHaveBeenCalledTimes(1);
  });
});

describe('isOutputLimitOutcome', () => {
  it.each([
    '400 Could not finish the message because max_tokens or model output limit was reached.',
    'Max_tokens or model output limit was reached',
  ])('recognises %p', (message) => {
    expect(isOutputLimitOutcome(new Error(message))).toBe(true);
  });

  it('recognises the code on a nested SDK error body', () => {
    expect(isOutputLimitOutcome({ error: { code: 'length' } })).toBe(true);
  });

  it('requires an EXACT `length` code, not a substring', () => {
    // `content_length_exceeded` is a different failure and must not be read as
    // a reachable model.
    expect(isOutputLimitOutcome({ code: 'content_length_exceeded' })).toBe(false);
  });

  it.each([
    new Error('401 Incorrect API key provided'),
    new Error('The model `gpt-5.4` does not exist'),
    null,
    undefined,
    42,
  ])('does not claim reachability for %p', (err) => {
    expect(isOutputLimitOutcome(err)).toBe(false);
  });

  it('survives a self-referential error chain', () => {
    // The SDK's nested error shape makes one cheap to construct by accident.
    const cyclic: Record<string, unknown> = { message: 'boom' };
    cyclic.error = cyclic;

    expect(isOutputLimitOutcome(cyclic)).toBe(false);
  });
});

describe('isUnsupportedParameterError', () => {
  it.each([
    '400 Unsupported parameter: reasoning_effort is not supported with this model',
    '400 Unrecognized request argument supplied: reasoning_effort',
    'unsupported_value',
  ])('recognises %p', (message) => {
    expect(isUnsupportedParameterError(new Error(message))).toBe(true);
  });

  it('recognises the code on a nested SDK error body', () => {
    expect(
      isUnsupportedParameterError({
        error: { code: 'unsupported_parameter', param: 'reasoning_effort' },
      }),
    ).toBe(true);
  });

  it.each([
    new Error('401 Incorrect API key provided'),
    new Error('429 Rate limit reached'),
    null,
  ])('does not retry for %p', (err) => {
    expect(isUnsupportedParameterError(err)).toBe(false);
  });
});

// =============================================================================
// The completion request shape (issues #37, #176)
// =============================================================================
//
// Same builder as the probe, so the two cannot drift into disagreeing about
// what a `gpt-5` request looks like — a probe that keeps passing on a model the
// real call cannot use would be a worse version of #176 rather than a fix.
// =============================================================================

describe('OpenAiProvider.runCompletion — the request shape', () => {
  const ALICE = '11111111-1111-4111-8111-111111111111';
  const USER_KEY = 'sk-user-zyxwvutsrqponmlkjih';

  function provider() {
    return new OpenAiProvider(credentialsReturning(null), usageStub());
  }

  function completionOf(text: string) {
    return {
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  const SYSTEM_TURN = {
    role: 'system' as const,
    content: 'You are a tutor.',
  };

  it('sends a system turn as `developer` to a reasoning model', async () => {
    // `system` is a 400 on the o-series and the gpt-5 line.
    chatCreateMock.mockResolvedValue(completionOf('hi'));

    await provider().complete(ALICE, USER_KEY, {
      roleKey: 'tutor',
      modelId: 'gpt-5.4',
      messages: [SYSTEM_TURN, { role: 'user', content: 'why?' }],
    });

    expect(chatCreateMock.mock.calls[0][0]).toMatchObject({
      messages: [
        { role: 'developer', content: 'You are a tutor.' },
        { role: 'user', content: 'why?' },
      ],
    });
  });

  it('sends a system turn as `user` to o1-mini, which accepts neither other role', async () => {
    chatCreateMock.mockResolvedValue(completionOf('hi'));

    await provider().complete(ALICE, USER_KEY, {
      roleKey: 'tutor',
      modelId: 'o1-mini',
      messages: [SYSTEM_TURN],
    });

    expect(chatCreateMock.mock.calls[0][0]).toMatchObject({
      messages: [{ role: 'user', content: 'You are a tutor.' }],
    });
  });

  it('leaves a system turn as `system` on the gpt-4 line', async () => {
    chatCreateMock.mockResolvedValue(completionOf('hi'));

    await provider().complete(ALICE, USER_KEY, {
      roleKey: 'tutor',
      modelId: 'gpt-4o',
      messages: [SYSTEM_TURN],
    });

    expect(chatCreateMock.mock.calls[0][0]).toMatchObject({
      messages: [{ role: 'system', content: 'You are a tutor.' }],
    });
  });

  it('floors a caller’s small budget on a reasoning model', async () => {
    // A cap below the reasoning pass is a silent empty-completion generator: a
    // successful response, no error, no text.
    chatCreateMock.mockResolvedValue(completionOf('hi'));

    await provider().complete(ALICE, USER_KEY, {
      roleKey: 'tutor',
      modelId: 'gpt-5.4',
      messages: [{ role: 'user', content: 'why?' }],
      maxTokens: 32,
    });

    const body = chatCreateMock.mock.calls[0][0] as {
      max_completion_tokens: number;
    };
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(2048);
  });

  it('respects a caller’s budget when it already clears the floor', async () => {
    chatCreateMock.mockResolvedValue(completionOf('hi'));

    await provider().complete(ALICE, USER_KEY, {
      roleKey: 'tutor',
      modelId: 'gpt-5.4',
      messages: [{ role: 'user', content: 'why?' }],
      maxTokens: 9000,
    });

    expect(chatCreateMock.mock.calls[0][0]).toMatchObject({
      max_completion_tokens: 9000,
    });
  });

  it('does not raise a plain chat model’s budget, which needs no reasoning pass', async () => {
    chatCreateMock.mockResolvedValue(completionOf('hi'));

    await provider().complete(ALICE, USER_KEY, {
      roleKey: 'tutor',
      modelId: 'gpt-4o',
      messages: [{ role: 'user', content: 'why?' }],
      maxTokens: 32,
    });

    expect(chatCreateMock.mock.calls[0][0]).toMatchObject({
      max_completion_tokens: 32,
    });
  });

  it('sends no budget at all when the caller asked for none', async () => {
    chatCreateMock.mockResolvedValue(completionOf('hi'));

    await provider().complete(ALICE, USER_KEY, {
      roleKey: 'tutor',
      modelId: 'gpt-5.4',
      messages: [{ role: 'user', content: 'why?' }],
    });

    expect(chatCreateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        max_completion_tokens: expect.anything(),
      }),
    );
  });

  it('pins NO reasoning_effort on a real completion, unlike the probe', async () => {
    // The probe buys proof at the cheapest tier; a completion takes the
    // model's own default, which is what the role was bound for.
    chatCreateMock.mockResolvedValue(completionOf('hi'));

    await provider().complete(ALICE, USER_KEY, {
      roleKey: 'tutor',
      modelId: 'gpt-5.4',
      messages: [{ role: 'user', content: 'why?' }],
    });

    expect(chatCreateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ reasoning_effort: expect.anything() }),
    );
  });

  it('sends no sampling parameters, which is what makes the call portable', async () => {
    chatCreateMock.mockResolvedValue(completionOf('hi'));

    await provider().complete(ALICE, USER_KEY, {
      roleKey: 'tutor',
      modelId: 'gpt-4o',
      messages: [{ role: 'user', content: 'why?' }],
    });

    expect(chatCreateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ temperature: expect.anything() }),
    );
    expect(chatCreateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ top_p: expect.anything() }),
    );
  });

  it('STILL sets stream_options: { include_usage: true } on a streamed request', async () => {
    // Restated here because the traits rewrite passes through this exact
    // request builder. Omit the flag and every streaming call records zero
    // tokens, with no error and no warning — see ai-usage.spec.ts.
    chatCreateMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: 'hi' } }] };
      },
    });

    await provider().complete(ALICE, USER_KEY, {
      roleKey: 'tutor',
      modelId: 'gpt-5.4',
      messages: [{ role: 'user', content: 'why?' }],
      stream: true,
    });

    expect(chatCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: true,
        stream_options: { include_usage: true },
      }),
    );
  });
});

describe('describeModel', () => {
  it('converts the provider unix-seconds timestamp', () => {
    expect(describeModel('gpt-5.4', 1_700_000_000).createdAt).toEqual(
      new Date(1_700_000_000 * 1000),
    );
  });

  it('tolerates a missing or nonsense timestamp', () => {
    expect(describeModel('gpt-5.4').createdAt).toBeNull();
    expect(describeModel('gpt-5.4', Number.NaN).createdAt).toBeNull();
  });
});

// =============================================================================
// The structured-completion request shape (issue #96, epic #53)
// =============================================================================
//
// One extra field on the same chat request, and the whole value of the feature
// is in that field being exactly right. `strict: true` is what turns
// `response_format` from a strong hint into a decoding constraint, and the
// difference does not show up in testing — a capable model follows the hint
// most of the time. It shows up as a grader that works for weeks and then
// returns a field that is not there.
// =============================================================================

describe('OpenAiProvider.runStructuredCompletion — the request shape', () => {
  const ALICE = '11111111-1111-4111-8111-111111111111';
  const USER_KEY = 'sk-user-zyxwvutsrqponmlkjih';

  const VERDICT = z.object({ correct: z.boolean(), reason: z.string() });

  function provider(credentials = credentialsReturning(null)) {
    return new OpenAiProvider(credentials, usageStub());
  }

  function request() {
    return {
      roleKey: 'grader',
      modelId: 'gpt-5.4',
      messages: [{ role: 'user' as const, content: 'grade this' }],
      schemaName: 'civics_verdict',
      schema: VERDICT,
    };
  }

  function structuredReply(json: string) {
    return {
      choices: [{ message: { content: json } }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    };
  }

  it('sends response_format with the schema NAME and strict: true', async () => {
    chatCreateMock.mockResolvedValue(
      structuredReply('{"correct":true,"reason":"x"}'),
    );

    await provider().completeStructured(ALICE, USER_KEY, request());

    expect(chatCreateMock.mock.calls[0][0]).toMatchObject({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'civics_verdict',
          // WITHOUT THIS the schema is advice the model may take. With it,
          // decoding cannot produce a reply that violates it.
          strict: true,
          schema: expect.objectContaining({ type: 'object' }),
        },
      },
    });
  });

  it('sends the JSON Schema the base class converted, not a second conversion', async () => {
    chatCreateMock.mockResolvedValue(
      structuredReply('{"correct":true,"reason":"x"}'),
    );

    await provider().completeStructured(ALICE, USER_KEY, request());

    const body = chatCreateMock.mock.calls[0][0] as {
      response_format: { json_schema: { schema: Record<string, unknown> } };
    };
    expect(body.response_format.json_schema.schema).toMatchObject({
      properties: {
        correct: { type: 'boolean' },
        reason: { type: 'string' },
      },
    });
  });

  it('NEVER streams a structured reply', async () => {
    // A structured reply is parsed and validated as a whole; a half-decoded
    // object is not an early draft of a grade.
    chatCreateMock.mockResolvedValue(
      structuredReply('{"correct":true,"reason":"x"}'),
    );

    await provider().completeStructured(ALICE, USER_KEY, request());

    expect(chatCreateMock.mock.calls[0][0]).toMatchObject({ stream: false });
    expect(chatCreateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ stream_options: expect.anything() }),
    );
  });

  it('uses the SAME request builder as the probe and the plain completion', async () => {
    // `system` is a 400 on the gpt-5 line. A structured call with its own
    // request shape is how that knowledge comes to disagree between the two.
    chatCreateMock.mockResolvedValue(
      structuredReply('{"correct":true,"reason":"x"}'),
    );

    await provider().completeStructured(ALICE, USER_KEY, {
      ...request(),
      messages: [
        { role: 'system', content: 'You are a grader.' },
        { role: 'user', content: 'grade this' },
      ],
    });

    expect(chatCreateMock.mock.calls[0][0]).toMatchObject({
      messages: [
        { role: 'developer', content: 'You are a grader.' },
        { role: 'user', content: 'grade this' },
      ],
    });
  });

  it('returns the validated value and the reported usage', async () => {
    chatCreateMock.mockResolvedValue(
      structuredReply('{"correct":false,"reason":"wrong war"}'),
    );

    const result = await provider().completeStructured(
      ALICE,
      USER_KEY,
      request(),
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ correct: false, reason: 'wrong war' });
    expect(result.usage).toEqual({
      promptTokens: 11,
      completionTokens: 3,
      totalTokens: 14,
    });
    expect(result.usageEventId).toBe('usage-row-1');
  });

  it('reads NULL, not zero, when the provider reported no usage', async () => {
    chatCreateMock.mockResolvedValue({
      choices: [{ message: { content: '{"correct":true,"reason":"x"}' } }],
    });

    const result = await provider().completeStructured(
      ALICE,
      USER_KEY,
      request(),
    );

    expect(result.usage).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
  });

  it('turns an SDK failure into a diagnosable result, not a throw', async () => {
    chatCreateMock.mockRejectedValue(new Error('429 rate limit exceeded'));

    const result = await provider().completeStructured(
      ALICE,
      USER_KEY,
      request(),
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('rate_limit');
    expect(result.data).toBeNull();
  });

  it('never lets the caller’s key reach the error string', async () => {
    chatCreateMock.mockRejectedValue(
      new Error(`401 Incorrect API key provided: ${USER_KEY}`),
    );

    const result = await provider().completeStructured(
      ALICE,
      USER_KEY,
      request(),
    );

    expect(result.error).not.toContain(USER_KEY);
    expect(result.error).toContain('[redacted]');
  });

  it('runs on the key it was PASSED, never on the stored server credential', async () => {
    // Epic #25, decision 4: every inference call runs on the calling user's own
    // key. A hook that reached for the server key would still work, which is
    // exactly why nothing but a test would notice.
    const credentials = credentialsReturning('sk-server-must-not-be-used');
    chatCreateMock.mockResolvedValue(
      structuredReply('{"correct":true,"reason":"x"}'),
    );

    await provider(credentials).completeStructured(ALICE, USER_KEY, request());

    expect(credentials.getSecret).not.toHaveBeenCalled();
    expect(constructedWith[0]).toMatchObject({ apiKey: USER_KEY });
  });
});

// =============================================================================
// The streaming request shape (issue #96, epic #53)
// =============================================================================
//
// `stream_options: { include_usage: true }` is the one line in this provider
// whose omission has no symptom of its own: no error, no warning, just a
// consumption figure that is quietly always zero (#37). It is asserted here
// rather than trusted to a comment.
// =============================================================================

describe('OpenAiProvider.openStream — the streaming request', () => {
  const ALICE = '11111111-1111-4111-8111-111111111111';
  const USER_KEY = 'sk-user-zyxwvutsrqponmlkjih';

  const REQUEST = {
    roleKey: 'tutor',
    modelId: 'gpt-5.4',
    messages: [{ role: 'user' as const, content: 'why?' }],
  };

  function provider(credentials = credentialsReturning(null)) {
    return new OpenAiProvider(credentials, usageStub());
  }

  /** A streamed response: content chunks, then the usage-only chunk. */
  function streamOf(
    chunks: Array<{ text?: string; usage?: Record<string, number> }>,
  ) {
    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield {
            choices: chunk.text ? [{ delta: { content: chunk.text } }] : [],
            usage: chunk.usage
              ? {
                  prompt_tokens: chunk.usage.prompt,
                  completion_tokens: chunk.usage.completion,
                  total_tokens: chunk.usage.total,
                }
              : undefined,
          };
        }
      },
    };
  }

  async function drain(events: AsyncIterable<AiStreamEvent>) {
    const out: AiStreamEvent[] = [];
    for await (const event of events) out.push(event);
    return out;
  }

  it('SETS stream_options: { include_usage: true } on every streamed request', async () => {
    // THE test in this describe. Omit the flag and every streamed call records
    // zero tokens, with nothing to notice in production.
    chatCreateMock.mockResolvedValue(
      streamOf([{ text: 'hi' }, { usage: { prompt: 5, completion: 2, total: 7 } }]),
    );

    await drain(provider().stream(ALICE, USER_KEY, REQUEST));

    expect(chatCreateMock.mock.calls[0][0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('passes the abort signal in the SDK request options, where it reaches the socket', async () => {
    // An abort that only breaks our loop leaves OpenAI generating — and
    // billing — the rest of a response nobody will read.
    const controller = new AbortController();
    chatCreateMock.mockResolvedValue(
      streamOf([{ text: 'hi' }, { usage: { prompt: 5, completion: 2, total: 7 } }]),
    );

    await drain(
      provider().stream(ALICE, USER_KEY, REQUEST, controller.signal),
    );

    expect(chatCreateMock.mock.calls[0][1]).toEqual({
      signal: controller.signal,
    });
  });

  it('yields the deltas and ends with one done event carrying the usage', async () => {
    chatCreateMock.mockResolvedValue(
      streamOf([
        { text: 'The ' },
        { text: 'Civil War.' },
        { usage: { prompt: 5, completion: 2, total: 7 } },
      ]),
    );

    const events = await drain(provider().stream(ALICE, USER_KEY, REQUEST));

    expect(events).toEqual([
      { type: 'delta', text: 'The ' },
      { type: 'delta', text: 'Civil War.' },
      {
        type: 'done',
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        usageEventId: 'usage-row-1',
      },
    ]);
  });

  it('records NULL, not zero, when the stream ends with no usage chunk', async () => {
    chatCreateMock.mockResolvedValue(streamOf([{ text: 'hi' }]));

    const events = await drain(provider().stream(ALICE, USER_KEY, REQUEST));

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      },
    });
  });

  it('turns an SDK failure into the terminal error event, never a rejection', async () => {
    chatCreateMock.mockRejectedValue(new Error('401 Incorrect API key provided'));

    const events = await drain(provider().stream(ALICE, USER_KEY, REQUEST));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      errorCode: 'invalid_key',
    });
  });

  it('never lets the caller’s key reach the terminal error event', async () => {
    chatCreateMock.mockRejectedValue(
      new Error(`Request failed with Authorization: Bearer ${USER_KEY}`),
    );

    const events = await drain(provider().stream(ALICE, USER_KEY, REQUEST));
    const terminal = events[0] as Extract<AiStreamEvent, { type: 'error' }>;

    expect(terminal.error).not.toContain(USER_KEY);
    expect(terminal.error).toContain('[redacted]');
  });

  it('runs on the key it was PASSED, never on the stored server credential', async () => {
    const credentials = credentialsReturning('sk-server-must-not-be-used');
    chatCreateMock.mockResolvedValue(
      streamOf([{ text: 'hi' }, { usage: { prompt: 5, completion: 2, total: 7 } }]),
    );

    await drain(provider(credentials).stream(ALICE, USER_KEY, REQUEST));

    expect(credentials.getSecret).not.toHaveBeenCalled();
    expect(constructedWith[0]).toMatchObject({ apiKey: USER_KEY });
  });
});

// =============================================================================
// Speech (issue #88, epic #58 — E9 "Voice foundation")
// =============================================================================
//
// Three things are worth testing here and nothing else is: the CONFIDENCE
// DERIVATION, because it is the only signal OpenAI exposes and it is arithmetic
// that can be silently wrong; the `verbose_json` FALLBACK, because the
// `gpt-4o-transcribe` family cannot produce that shape and a model an admin
// bound must not simply never work; and that an SDK throw becomes a failure
// RESULT, because the never-throw contract is what every caller is written
// against.
// =============================================================================

const AUDIO = Buffer.from('pretend this is a webm recording');

function transcribeRequest(modelId: string) {
  return {
    roleKey: 'transcribe',
    modelId,
    audio: AUDIO,
    contentType: 'audio/webm',
    fileName: 'answer.webm',
  };
}

const USER_KEY = 'sk-user-abcdefghijklmnopqrst';
const CALLER = '11111111-1111-4111-8111-111111111111';

describe('deriveConfidence', () => {
  it('maps a mean avg_logprob to a probability with Math.exp', () => {
    // The whole derivation: mean of the segment log-probabilities,
    // exponentiated. An approximation, and the only one available — see the
    // function's own note on why pretending to more precision is worse.
    const confidence = deriveConfidence({
      segments: [{ avg_logprob: -0.2 }, { avg_logprob: -0.4 }],
    });

    expect(confidence).toBeCloseTo(Math.exp(-0.3), 10);
  });

  it('scores a clear recording near 1 and a poor one visibly lower', () => {
    // The property callers actually rely on: the numbers ORDER recordings
    // sensibly, even though they are not calibrated probabilities.
    const clear = deriveConfidence({ segments: [{ avg_logprob: -0.05 }] });
    const mumbled = deriveConfidence({ segments: [{ avg_logprob: -1.6 }] });

    expect(clear).toBeGreaterThan(0.9);
    expect(mumbled).toBeLessThan(0.3);
    expect(mumbled).toBeGreaterThan(0);
  });

  it('returns NULL when there are no segments — never a guessed number', () => {
    // A model that ignored `verbose_json`, a changed response shape, an empty
    // recording. All of them mean "we do not know", and an invented default
    // would be indistinguishable from a measured value at every call site.
    expect(deriveConfidence({ text: 'hello' })).toBeNull();
    expect(deriveConfidence({ segments: [] })).toBeNull();
    expect(deriveConfidence(undefined)).toBeNull();
  });

  it('returns null when segments carry no usable avg_logprob', () => {
    expect(deriveConfidence({ segments: [{ start: 0, end: 1 }] })).toBeNull();
  });

  it('clamps to [0, 1] rather than reporting more than certainty', () => {
    // `Math.exp` of a positive logprob would otherwise hand a caller a
    // "confidence" above 1.
    expect(deriveConfidence({ segments: [{ avg_logprob: 0.5 }] })).toBe(1);
  });
});

describe('wantsVerboseTranscription', () => {
  it('asks for verbose_json on whisper, which can produce it', () => {
    expect(wantsVerboseTranscription('whisper-1')).toBe(true);
  });

  it('skips it for the gpt-4o-transcribe family, which cannot', () => {
    // Requesting it there is a guaranteed 400, so the ordinary case must not
    // pay for a rejected upload of a learner's whole recording.
    expect(wantsVerboseTranscription('gpt-4o-transcribe')).toBe(false);
    expect(wantsVerboseTranscription('gpt-4o-mini-transcribe')).toBe(false);
  });

  it('defaults to asking for the richer shape on an unknown model', () => {
    // Getting this wrong costs one retried request. Defaulting the other way
    // would silently drop the confidence signal for every future model.
    expect(wantsVerboseTranscription('some-new-speech-model')).toBe(true);
  });
});

describe('isUnsupportedResponseFormatError', () => {
  it('recognises the real rejection verbatim', () => {
    expect(
      isUnsupportedResponseFormatError(
        new Error(
          "400 response_format 'verbose_json' is not compatible with model 'gpt-4o-transcribe'",
        ),
      ),
    ).toBe(true);
  });

  it('still recognises an unsupported-parameter phrasing', () => {
    expect(
      isUnsupportedResponseFormatError({ code: 'unsupported_value' }),
    ).toBe(true);
  });

  it('does NOT swallow an unrelated failure', () => {
    // A revoked key must stay a failure rather than trigger a retry that
    // fails the same way and doubles the latency.
    expect(
      isUnsupportedResponseFormatError(new Error('401 Incorrect API key')),
    ).toBe(false);
  });
});

describe('OpenAiProvider.transcribe', () => {
  it('asks for verbose_json and derives the confidence from its segments', async () => {
    transcriptionsCreateMock.mockResolvedValue({
      text: 'the president',
      segments: [{ avg_logprob: -0.1 }, { avg_logprob: -0.3 }],
    });

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    const result = await p.transcribe(
      CALLER,
      USER_KEY,
      transcribeRequest('whisper-1'),
    );

    expect(result.success).toBe(true);
    expect(result.text).toBe('the president');
    expect(result.confidence).toBeCloseTo(Math.exp(-0.2), 10);

    const body = transcriptionsCreateMock.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(body.response_format).toBe('verbose_json');
    expect(body.model).toBe('whisper-1');
    // The upload is NAMED: OpenAI infers the container format from the
    // extension, and an unnamed blob is rejected as an unsupported format.
    expect((body.file as File).name).toBe('answer.webm');
  });

  it('reports all-null token counts, because the endpoint sends none', async () => {
    // `null` is the honest reading of "we were not told" — `0` would claim the
    // call consumed nothing. Same contract as every other usage field.
    transcriptionsCreateMock.mockResolvedValue({ text: 'x', segments: [] });

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    const result = await p.transcribe(
      CALLER,
      USER_KEY,
      transcribeRequest('whisper-1'),
    );

    expect(result.usage).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
  });

  it('skips verbose_json entirely for the gpt-4o-transcribe family', async () => {
    transcriptionsCreateMock.mockResolvedValue({ text: 'the president' });

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    const result = await p.transcribe(
      CALLER,
      USER_KEY,
      transcribeRequest('gpt-4o-transcribe'),
    );

    expect(transcriptionsCreateMock).toHaveBeenCalledTimes(1);
    expect(
      (transcriptionsCreateMock.mock.calls[0][0] as Record<string, unknown>)
        .response_format,
    ).toBe('json');
    expect(result.success).toBe(true);
    expect(result.text).toBe('the president');
    // NOT a guessed number. There is no signal in a plain `json` reply.
    expect(result.confidence).toBeNull();
  });

  it('falls back to json once when a model rejects verbose_json unexpectedly', async () => {
    // The case the name check cannot know about: a renamed line, a new one, a
    // third-party OpenAI-compatible endpoint.
    transcriptionsCreateMock
      .mockRejectedValueOnce(
        new Error(
          "400 response_format 'verbose_json' is not compatible with this model",
        ),
      )
      .mockResolvedValueOnce({ text: 'the president' });

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    const result = await p.transcribe(
      CALLER,
      USER_KEY,
      transcribeRequest('some-new-speech-model'),
    );

    expect(transcriptionsCreateMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.text).toBe('the president');
    expect(result.confidence).toBeNull();
  });

  it('retries exactly once — a second rejection is a failure, not a loop', async () => {
    // A loop here spends someone's money re-uploading audio that was already
    // refused.
    transcriptionsCreateMock.mockRejectedValue(
      new Error("400 response_format 'verbose_json' is not compatible"),
    );

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    const result = await p.transcribe(
      CALLER,
      USER_KEY,
      transcribeRequest('some-new-speech-model'),
    );

    expect(transcriptionsCreateMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
  });

  it('turns an SDK throw into a failure result rather than rejecting', async () => {
    transcriptionsCreateMock.mockRejectedValue(
      new Error('429 Rate limit reached'),
    );

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    const result = await p.transcribe(
      CALLER,
      USER_KEY,
      transcribeRequest('whisper-1'),
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('rate_limit');
    expect(result.text).toBeNull();
    // UNKNOWN, not 0: a zero would assert the recogniser was certain it heard
    // nothing, on an answer the learner may well have got right.
    expect(result.confidence).toBeNull();
  });

  it('never lets the key reach the error, and never touches the server credential', async () => {
    const credentials = credentialsReturning('sk-server-should-not-be-read');
    transcriptionsCreateMock.mockRejectedValue(
      new Error(`401 Incorrect API key provided: ${USER_KEY}`),
    );

    const p = new OpenAiProvider(credentials, usageStub());
    const result = await p.transcribe(
      CALLER,
      USER_KEY,
      transcribeRequest('whisper-1'),
    );

    expect(result.error).not.toContain(USER_KEY);
    // Inference runs on the CALLER's key. A call on the server key would bill
    // the administrator for a learner's usage, silently.
    expect(credentials.getSecret).not.toHaveBeenCalled();
    expect(constructedWith[0]).toEqual({ apiKey: USER_KEY });
  });
});

describe('OpenAiProvider.synthesize', () => {
  /** The SDK hands back a raw fetch `Response`; the bytes come from it. */
  function audioResponse(bytes: number[]) {
    return {
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
    };
  }

  it('returns the bytes with the MIME type for the requested container', async () => {
    speechCreateMock.mockResolvedValue(audioResponse([0xff, 0xfb, 0x90]));

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    const result = await p.synthesize(CALLER, USER_KEY, {
      roleKey: 'speak',
      modelId: 'tts-1-hd',
      text: 'Who was the first President?',
    });

    expect(result.success).toBe(true);
    expect(result.audio).toEqual(Buffer.from([0xff, 0xfb, 0x90]));
    // `audio/mpeg`, never `audio/mp3` — a browser handed the latter may refuse
    // to play it with no visible error.
    expect(result.contentType).toBe('audio/mpeg');
    expect(result.usage).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
  });

  it('defaults the voice and the format so callers cannot drift apart', async () => {
    speechCreateMock.mockResolvedValue(audioResponse([1, 2, 3]));

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    await p.synthesize(CALLER, USER_KEY, {
      roleKey: 'speak',
      modelId: 'tts-1-hd',
      text: 'hello',
    });

    expect(speechCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'tts-1-hd',
        voice: 'alloy',
        input: 'hello',
        response_format: 'mp3',
      }),
    );
  });

  it('honours an explicit voice and format', async () => {
    speechCreateMock.mockResolvedValue(audioResponse([1]));

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    const result = await p.synthesize(CALLER, USER_KEY, {
      roleKey: 'speak',
      modelId: 'tts-1-hd',
      text: 'hello',
      voice: 'nova',
      format: 'wav',
    });

    expect(speechCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ voice: 'nova', response_format: 'wav' }),
    );
    expect(result.contentType).toBe('audio/wav');
  });

  it('turns an SDK throw into a failure result rather than rejecting', async () => {
    speechCreateMock.mockRejectedValue(
      new Error('insufficient_quota: you exceeded your quota'),
    );

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    const result = await p.synthesize(CALLER, USER_KEY, {
      roleKey: 'speak',
      modelId: 'tts-1-hd',
      text: 'hello',
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('quota_exceeded');
    expect(result.audio).toBeNull();
    expect(result.contentType).toBeNull();
  });
});

// =============================================================================
// Realtime sessions (issue #156, epic #60 — E11)
// =============================================================================
//
// What is worth testing here is what this class DECIDES, not what the SDK
// does with it: that the session configuration sent is ours (our instructions,
// our tools, our voice default), that the expiry is read back rather than
// computed, and that an SDK throw becomes a failure RESULT — the never-throw
// contract every caller is written against.
// =============================================================================

const REALTIME_MODEL = 'gpt-4o-realtime-preview';

/** `POST /v1/realtime/client_secrets`'s shape, as the SDK returns it. */
function mintedSecret(overrides: Record<string, unknown> = {}) {
  return {
    value: 'ek_live_abcdefghijklmnop',
    // Unix SECONDS, which is the whole reason `realtimeExpiry` exists.
    expires_at: Math.floor(Date.UTC(2099, 0, 1) / 1000),
    session: { type: 'realtime', model: REALTIME_MODEL },
    ...overrides,
  };
}

function sessionRequest(overrides: Record<string, unknown> = {}) {
  return {
    roleKey: 'realtime',
    modelId: REALTIME_MODEL,
    instructions: 'You are a USCIS officer conducting an interview.',
    tools: [
      {
        name: 'record_civics_answer',
        description: 'Record the answer the applicant gave.',
        parameters: { type: 'object', properties: {} },
      },
    ],
    ...overrides,
  } as Parameters<OpenAiProvider['createRealtimeSession']>[2];
}

describe('realtimeExpiry', () => {
  it('reads the provider\'s unix SECONDS as milliseconds', () => {
    // `new Date(seconds)` is a date in January 1970, which every comparison
    // downstream reads as "already expired" — a bug that presents as a feature
    // that never works rather than as an error.
    expect(realtimeExpiry(1_800_000_000)).toEqual(
      new Date(1_800_000_000_000),
    );
  });

  it('refuses anything that is not a finite, positive number', () => {
    // A mock, a proxy, or a future API version can all produce these, and a
    // caller handed `null` turns it into a refusal rather than into a session
    // with an unknown deadline.
    expect(realtimeExpiry(undefined)).toBeNull();
    expect(realtimeExpiry(0)).toBeNull();
    expect(realtimeExpiry(-1)).toBeNull();
    expect(realtimeExpiry(Number.NaN)).toBeNull();
    expect(realtimeExpiry('1800000000')).toBeNull();
  });
});

describe('readSessionModel', () => {
  it('reads the model off a realtime session response', () => {
    expect(readSessionModel({ model: REALTIME_MODEL })).toBe(REALTIME_MODEL);
  });

  it('returns null for the arm of the union that carries none', () => {
    // The response's `session` is a union — realtime or transcription — and
    // only one arm has a model. A narrowing cast would compile and then be
    // `undefined` at runtime on the other.
    expect(readSessionModel({ type: 'transcription' })).toBeNull();
    expect(readSessionModel(undefined)).toBeNull();
    expect(readSessionModel({ model: '' })).toBeNull();
  });
});

describe('OpenAiProvider.createRealtimeSession', () => {
  it('returns the ephemeral secret, its expiry and the minted model', async () => {
    clientSecretsCreateMock.mockResolvedValue(mintedSecret());

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    const result = await p.createRealtimeSession(
      CALLER,
      USER_KEY,
      sessionRequest(),
    );

    expect(result.success).toBe(true);
    expect(result.clientSecret).toBe('ek_live_abcdefghijklmnop');
    expect(result.expiresAt).toEqual(new Date('2099-01-01T00:00:00.000Z'));
    expect(result.modelId).toBe(REALTIME_MODEL);
    // Minting runs no inference — see `EMPTY_REALTIME_USAGE`.
    expect(result.usage).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
  });

  it('sends OUR session configuration: model, instructions, tools and a default voice', async () => {
    clientSecretsCreateMock.mockResolvedValue(mintedSecret());

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    await p.createRealtimeSession(CALLER, USER_KEY, sessionRequest());

    expect(clientSecretsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          type: 'realtime',
          model: REALTIME_MODEL,
          instructions: 'You are a USCIS officer conducting an interview.',
          audio: { output: { voice: 'alloy' } },
          tools: [
            {
              type: 'function',
              name: 'record_civics_answer',
              description: 'Record the answer the applicant gave.',
              parameters: { type: 'object', properties: {} },
            },
          ],
        }),
      }),
    );
  });

  it('omits the expiry request entirely when the caller asked for no lifetime', async () => {
    // So an omitted lifetime means the PROVIDER's own short default, rather
    // than a number this file invented on the caller's behalf.
    clientSecretsCreateMock.mockResolvedValue(mintedSecret());

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    await p.createRealtimeSession(CALLER, USER_KEY, sessionRequest());

    expect(clientSecretsCreateMock.mock.calls[0][0]).not.toHaveProperty(
      'expires_after',
    );
  });

  it('asks for the requested lifetime, anchored to the mint', async () => {
    clientSecretsCreateMock.mockResolvedValue(mintedSecret());

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    await p.createRealtimeSession(
      CALLER,
      USER_KEY,
      sessionRequest({ expiresInSeconds: 120 }),
    );

    expect(clientSecretsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expires_after: { anchor: 'created_at', seconds: 120 },
      }),
    );
  });

  it('honours an explicit voice', async () => {
    clientSecretsCreateMock.mockResolvedValue(mintedSecret());

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    await p.createRealtimeSession(
      CALLER,
      USER_KEY,
      sessionRequest({ voice: 'verse' }),
    );

    expect(clientSecretsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          audio: { output: { voice: 'verse' } },
        }),
      }),
    );
  });

  it('falls back to the requested model when the response names none', async () => {
    // A transcription-shaped session response carries no model at all. What we
    // asked for is the honest answer then — never a guess.
    clientSecretsCreateMock.mockResolvedValue(
      mintedSecret({ session: { type: 'transcription' } }),
    );

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    const result = await p.createRealtimeSession(
      CALLER,
      USER_KEY,
      sessionRequest(),
    );

    expect(result.modelId).toBe(REALTIME_MODEL);
  });

  it('REFUSES a secret it cannot read an expiry off', async () => {
    // A credential with no readable deadline is worse than none: the browser
    // would hold something nothing can decide is stale, and every downstream
    // "is it still good?" check would have to invent an answer.
    clientSecretsCreateMock.mockResolvedValue(
      mintedSecret({ expires_at: undefined }),
    );

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    const result = await p.createRealtimeSession(
      CALLER,
      USER_KEY,
      sessionRequest(),
    );

    expect(result.success).toBe(false);
    expect(result.clientSecret).toBeNull();
    expect(result.expiresAt).toBeNull();
    expect(result.errorCode).toBe('malformed_result');
  });

  it('turns an SDK throw into a failure result rather than rejecting', async () => {
    clientSecretsCreateMock.mockRejectedValue(
      new Error('404 The model `gpt-4o-realtime-preview` does not exist'),
    );

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    const result = await p.createRealtimeSession(
      CALLER,
      USER_KEY,
      sessionRequest(),
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('model_not_found');
    expect(result.clientSecret).toBeNull();
    expect(result.expiresAt).toBeNull();
    expect(result.modelId).toBeNull();
  });

  it('never lets the caller\'s key reach the error string', async () => {
    clientSecretsCreateMock.mockRejectedValue(
      new Error(`401 Incorrect API key provided: ${USER_KEY}`),
    );

    const p = new OpenAiProvider(credentialsReturning(null), usageStub());
    const result = await p.createRealtimeSession(
      CALLER,
      USER_KEY,
      sessionRequest(),
    );

    expect(result.error).not.toContain(USER_KEY);
    expect(result.errorCode).toBe('invalid_key');
  });

  it('runs on the CALLER\'s key, never on the server key', async () => {
    // The rule the whole BYOK design rests on (epic #25, decision 4): a
    // realtime session minted on the organisation's key spends the
    // administrator's quota for the length of a learner's conversation, with
    // nothing in the result to say it happened.
    clientSecretsCreateMock.mockResolvedValue(mintedSecret());
    const credentials = credentialsReturning(SERVER_KEY);

    const p = new OpenAiProvider(credentials, usageStub());
    await p.createRealtimeSession(CALLER, USER_KEY, sessionRequest());

    expect(constructedWith).toEqual([{ apiKey: USER_KEY }]);
    expect(credentials.getSecret).not.toHaveBeenCalled();
  });
});

// =============================================================================
// The voice catalog (#283, epic #280)
// =============================================================================
//
// Two properties, and the second is the reason this block is here at all.
//
// 1. EVERY ID THE PICKER OFFERS IS ONE THE SYNTHESIS DTO ACCEPTS. That is the
//    real coupling in this feature: `aiSynthesizeRequestSchema` validates a
//    voice id's SHAPE and deliberately not its membership, so a voice this
//    endpoint advertises but that DTO refuses would be a 400 the learner
//    cannot explain — produced by choosing from a list the application handed
//    them.
//
// 2. THE LIST LIVES IN EXACTLY ONE SOURCE FILE. A copy in the web bundle, or a
//    second copy in a DTO, is correct the day it is written and silently wrong
//    the day OpenAI adds or renames a voice. `ai-model-roles.ts` makes the same
//    argument for the role registry; this asserts it rather than restating it.
// =============================================================================

/** The charset `aiSynthesizeRequestSchema`'s `voice` field accepts. */
const VOICE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The longest voice id that schema will accept. */
const VOICE_ID_MAX_LENGTH = 64;

describe('OpenAiProvider.listVoices', () => {
  const p = () => new OpenAiProvider(credentialsReturning(null), usageStub());

  it('returns a non-empty list', () => {
    expect(p().listVoices().length).toBeGreaterThan(0);
  });

  it('gives every voice a non-empty id, label and description', () => {
    // A blank description is worse than none: a picker renders an empty line
    // and the learner is back to auditioning every voice to tell them apart.
    for (const voice of p().listVoices()) {
      expect(voice.id.trim()).not.toBe('');
      expect(voice.label.trim()).not.toBe('');
      expect(voice.description.trim()).not.toBe('');
    }
  });

  it('gives every voice an id the synthesize DTO would accept', () => {
    for (const voice of p().listVoices()) {
      expect(voice.id).toMatch(VOICE_ID_PATTERN);
      expect(voice.id.length).toBeLessThanOrEqual(VOICE_ID_MAX_LENGTH);
    }
  });

  it('has no duplicate ids', () => {
    const ids = p().listVoices().map((voice) => voice.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports a default that is one of the voices it offers', () => {
    // The drift this forbids is a settings screen marking a voice "default"
    // that the synthesiser does not actually fall back to.
    const provider = p();

    expect(provider.defaultVoice()).toBe(DEFAULT_SPEECH_VOICE);
    expect(provider.listVoices().map((voice) => voice.id)).toContain(
      DEFAULT_SPEECH_VOICE,
    );
  });

  it('does not call the SDK or read a credential', () => {
    // Static, provider-authored data — see `AiProvider.listVoices`. A future
    // implementation that fetched the list would fail here, which is the point
    // of the method being synchronous in the first place.
    const credentials = credentialsReturning(SERVER_KEY);

    new OpenAiProvider(credentials, usageStub()).listVoices();

    expect(credentials.getSecret).not.toHaveBeenCalled();
    expect(constructedWith).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// The one-source-file assertion
// -----------------------------------------------------------------------------

/** The repository roots a copy of the list could plausibly be hiding in. */
const SOURCE_ROOTS = [
  join(__dirname, '..', '..'), // apps/api/src
  join(__dirname, '..', '..', '..', '..', 'web', 'src'), // apps/web/src
];

/**
 * Every `.ts`/`.tsx` file under `dir` that is not itself a test.
 *
 * TESTS ARE EXCLUDED because this file is one: it names the ids in its own
 * assertions, and a scan that counted them would fail for documenting the rule
 * it enforces — the same trap `ai-user-key.controller.spec.ts` avoids by
 * stripping comments before asserting on a source.
 */
function sourceFiles(dir: string): string[] {
  let entries: string[];

  try {
    entries = readdirSync(dir);
  } catch {
    // A root that is not present in this checkout is not a failure: the API's
    // own tree is the one that must be scanned, and `apps/web` is a bonus when
    // it is there.
    return [];
  }

  const found: string[] = [];

  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;

    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }

    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(spec|test)\.tsx?$/.test(entry)) continue;

    found.push(full);
  }

  return found;
}

/**
 * A file's source with comments removed.
 *
 * COMMENTS ARE STRIPPED for the reason `ai-user-key.controller.spec.ts` gives:
 * the assertion is about what the code does, and `ai.types.ts` quite properly
 * writes "the provider's voice id, e.g. `'alloy'`" in a doc comment. Matching
 * that would fail the test for explaining itself. The stripper is crude and
 * that is safe here — over-stripping can only hide a copy this test would have
 * caught, never invent one.
 */
function strippedSource(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('OpenAI`s voice list lives in exactly one source file', () => {
  const scanned = SOURCE_ROOTS.flatMap((root) =>
    sourceFiles(root).map((path) => ({ path, source: strippedSource(path) })),
  );

  const voiceIds = new OpenAiProvider(credentialsReturning(null), usageStub())
    .listVoices()
    .map((voice) => voice.id);

  it('scans a real tree', () => {
    // A guard on the guard: a broken path would make every assertion below
    // pass over an empty list.
    expect(scanned.length).toBeGreaterThan(100);
  });

  it.each(voiceIds)('names "%s" in one file only', (id) => {
    const owners = scanned
      .filter(
        ({ source }) =>
          source.includes(`'${id}'`) || source.includes(`"${id}"`),
      )
      .map(({ path }) => relative(join(__dirname, '..', '..', '..'), path));

    // The failure this catches by name: a hand-copied list in
    // `apps/web/src/config`, correct the day it is written and silently wrong
    // the day OpenAI adds or renames a voice. The web reads
    // `GET /api/ai/speech/voices` instead.
    expect(owners).toEqual(['src/ai/providers/openai.provider.ts']);
  });
});

import { Logger } from '@nestjs/common';

import {
  OpenAiProvider,
  describeModel,
  isOutputLimitOutcome,
  isUnsupportedParameterError,
} from './openai.provider';
import {
  AI_SYSTEM_CREDENTIAL_NAME,
  AI_SYSTEM_CREDENTIAL_PURPOSE,
} from '../ai-credential.constants';
import type { CredentialsService } from '../../credentials/credentials.service';
import type { AiUsageService } from '../ai-usage.service';

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
const constructedWith: Array<Record<string, unknown>> = [];

jest.mock('openai', () => {
  return {
    __esModule: true,
    default: class FakeOpenAI {
      models = { list: listMock, retrieve: retrieveMock };
      chat = { completions: { create: chatCreateMock } };
      embeddings = { create: embeddingsCreateMock };
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

/** Recording is exercised in ai-usage.spec.ts; here it only has to exist. */
function usageStub() {
  return { record: jest.fn().mockResolvedValue(undefined) } as unknown as AiUsageService;
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

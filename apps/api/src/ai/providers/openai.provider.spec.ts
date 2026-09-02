import { Logger } from '@nestjs/common';

import { OpenAiProvider, describeModel } from './openai.provider';
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

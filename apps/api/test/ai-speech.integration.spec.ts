import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { Prisma } from '@prisma/client';
import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from './helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from './mocks/prisma.mock';
import { setupBaseMocks } from './fixtures/mock-setup.helper';
import {
  createMockViewerUser,
  authHeader,
  TestUser,
} from './helpers/auth-mock.helper';
import { AiDispatchService } from '../src/ai/ai-dispatch.service';
import { AiUsageService } from '../src/ai/ai-usage.service';
import { Clock } from '../src/common/clock/clock';
import { CredentialsService } from '../src/credentials/credentials.service';
import { FakeAiProvider } from '../src/ai/providers/fake-ai.provider';
import { OpenAiProvider } from '../src/ai/providers/openai.provider';
import {
  AI_SYSTEM_CREDENTIAL_NAME,
  AI_SYSTEM_CREDENTIAL_PURPOSE,
  AI_USER_CREDENTIAL_PURPOSE,
} from '../src/ai/ai-credential.constants';
import {
  MAX_TRANSCRIBE_AUDIO_BYTES,
  MAX_TRANSCRIBE_BYTES,
} from '../src/ai/ai-speech.service';
import { MAX_SYNTHESIS_TEXT_LENGTH } from '../src/ai/dto/ai-speech.dto';
import type { AiCapabilityFamily } from '../src/ai/ai-model-roles';
import type { AiCapabilitySet } from '../src/ai/providers/ai-provider.interface';
import { STORAGE_PROVIDER } from '../src/storage/providers/storage-provider.interface';
import type { PrismaService } from '../src/prisma/prisma.service';

// =============================================================================
// Speech API (integration) — issue #95, epic #58 "Voice foundation"
// =============================================================================
//
// Both routes asserted over real HTTP through `createTestApp`, with Prisma
// mocked — the shape `civics.integration.spec.ts` and
// `practice.integration.spec.ts` established. The unit specs cover the
// decisions; this file covers that they survive the wire, where the guards, the
// global Zod pipe, the response envelope and — uniquely on this surface — the
// real `@fastify/multipart` parser are all in the path. The upload caps in
// particular cannot be tested anywhere else: they are enforced by the parser,
// mid-stream, and a unit test of the service never meets it.
//
// -----------------------------------------------------------------------------
// TWO WIRINGS, ON PURPOSE
// -----------------------------------------------------------------------------
//
// Most blocks stand the app up with `AiDispatchService` replaced by a double,
// because the property under test is that the DISPATCHER WAS NEVER REACHED —
// and "never reached" is only observable on something that records being
// called. The last block instead wires the REAL dispatcher over a real
// `BaseAiProvider` (the `FakeAiProvider`, no network) and a stub credential
// store, because the properties under test there — an `ai_usage_events` row
// carrying the right `roleKey`, and the organisation's key never being read —
// live below the dispatcher and would be mocked away by the double.
//
// No test in this repository touches a database (docs/TESTING.md).
// =============================================================================

const AUDIO = Buffer.from('fake webm bytes for a spoken answer');

/** A settings row for a deployment with both speech roles bound. */
const READY_AI_SETTINGS = {
  provider: 'openai',
  enabled: true,
  minModelGeneration: 4,
  models: {
    tutor: 'gpt-5.4-mini',
    grader: 'gpt-5.4-mini',
    transcribe: 'gpt-4o-transcribe',
    speak: 'gpt-4o-mini-tts',
    realtime: null,
    embed: null,
  },
};

/**
 * Point `systemSettings.findUnique` at the AI row for the `ai` key only.
 *
 * `setupBaseMocks` answers every key with the same generic row, which
 * `aiSettingsSchema` rejects — and `AiSettingsService.get` THROWS on a
 * stored-but-invalid row rather than substituting defaults, so without this
 * every speech call would come back `failed` for a reason that has nothing to
 * do with speech.
 */
function setupAiSettings(settings: Record<string, unknown> = READY_AI_SETTINGS) {
  const base = (prismaMock.systemSettings.findUnique as jest.Mock)
    .getMockImplementation();

  (prismaMock.systemSettings.findUnique as jest.Mock).mockImplementation(
    async (args: { where?: { key?: string } }) => {
      if (args?.where?.key === 'ai') return { value: settings };

      return base ? base(args) : { key: args?.where?.key, value: {} };
    },
  );
}

// =============================================================================
// The caps, the guards and the typed `unavailable` payload
// =============================================================================

describe('Speech API — with the dispatcher replaced by a double', () => {
  let context: TestContext;
  let learner: TestUser;

  const dispatch = {
    transcribe: jest.fn(),
    synthesize: jest.fn(),
  };

  const server = () => context.app.getHttpServer();

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: AiDispatchService, useValue: dispatch }],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    setupAiSettings();

    dispatch.transcribe.mockReset();
    dispatch.synthesize.mockReset();
    dispatch.transcribe.mockResolvedValue({
      status: 'ok',
      text: 'the President',
      confidence: 0.91,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      modelId: 'gpt-4o-transcribe',
    });
    dispatch.synthesize.mockResolvedValue({
      status: 'ok',
      audio: Buffer.from([0x49, 0x44, 0x33, 0x04]),
      contentType: 'audio/mpeg',
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      modelId: 'gpt-4o-mini-tts',
    });

    // A VIEWER, deliberately — the least-privileged seeded role. Every
    // assertion below about what a caller may do is an assertion about the
    // role that would be locked out if these routes were gated.
    learner = await createMockViewerUser(context, 'learner@example.com');
  });

  // ---------------------------------------------------------------------------
  // The permission posture
  // ---------------------------------------------------------------------------

  describe('authentication and permissions', () => {
    it('rejects an unauthenticated transcription', async () => {
      await request(server())
        .post('/api/ai/speech/transcribe')
        .attach('audio', AUDIO, {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(401);

      expect(dispatch.transcribe).not.toHaveBeenCalled();
    });

    it('rejects an unauthenticated synthesis', async () => {
      await request(server())
        .post('/api/ai/speech/synthesize')
        .send({ text: 'Who is the President?' })
        .expect(401);

      expect(dispatch.synthesize).not.toHaveBeenCalled();
    });

    it('lets a Viewer transcribe — voice adds no permission string', async () => {
      // The whole argument in `voice.md` §10: gating this would leave the
      // DEFAULT role unable to practise, which is the product, not a
      // restriction.
      await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .attach('audio', AUDIO, {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(200);
    });

    it('lets a Viewer synthesize', async () => {
      await request(server())
        .post('/api/ai/speech/synthesize')
        .set(authHeader(learner.accessToken))
        .send({ text: 'Who is the President?' })
        .expect(200);
    });

    it('takes the learner only from the session, never from the request', async () => {
      // There is no user-id parameter to send, so the assertion is that the
      // id the dispatcher was handed is the AUTHENTICATED one and not
      // anything the body or the query said.
      await request(server())
        .post('/api/ai/speech/transcribe?userId=someone-else')
        .set(authHeader(learner.accessToken))
        .field('userId', 'someone-else')
        .attach('audio', AUDIO, {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(200);

      expect(dispatch.transcribe).toHaveBeenCalledWith(
        learner.id,
        expect.anything(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // The caps — every one of these must cost the learner nothing
  // ---------------------------------------------------------------------------

  describe('upload limits, all enforced before any provider call', () => {
    it('rejects an upload past the byte cap, at the parser', async () => {
      // One byte past 10 MB. The parser refuses this mid-stream, so the
      // process never holds the whole body — and the answer is a 400 naming
      // the limit, not the 413 the plugin would otherwise produce.
      const response = await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .attach('audio', Buffer.alloc(MAX_TRANSCRIBE_BYTES + 1), {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(400);

      expect(response.body.message).toMatch(/too large/i);
      expect(dispatch.transcribe).not.toHaveBeenCalled();
    });

    it('rejects an upload past the duration bound', async () => {
      const response = await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .attach('audio', Buffer.alloc(MAX_TRANSCRIBE_AUDIO_BYTES + 1), {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(400);

      expect(response.body.message).toMatch(/seconds or less/i);
      expect(dispatch.transcribe).not.toHaveBeenCalled();
    });

    it('rejects a recording the client itself declares as over-long', async () => {
      await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .field('durationSeconds', '300')
        .attach('audio', AUDIO, {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(400);

      expect(dispatch.transcribe).not.toHaveBeenCalled();
    });

    it('rejects an empty file', async () => {
      await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .attach('audio', Buffer.alloc(0), {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(400);

      expect(dispatch.transcribe).not.toHaveBeenCalled();
    });

    it('rejects a content type that is not audio', async () => {
      await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .attach('audio', Buffer.from('%PDF-1.7'), {
          filename: 'notes.pdf',
          contentType: 'application/pdf',
        })
        .expect(400);

      expect(dispatch.transcribe).not.toHaveBeenCalled();
    });

    it('rejects a second file rather than silently transcribing the first', async () => {
      // `files: 1` is set at the plugin registration; iterating the parts is
      // what turns the parser's own limit into an answer rather than a
      // truncated upload nobody was told about.
      await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .attach('audio', AUDIO, {
          filename: 'one.webm',
          contentType: 'audio/webm',
        })
        .attach('audio', AUDIO, {
          filename: 'two.webm',
          contentType: 'audio/webm',
        })
        .expect(400);

      expect(dispatch.transcribe).not.toHaveBeenCalled();
    });

    it('rejects a request with no file at all', async () => {
      await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .field('languageHint', 'en')
        .expect(400);

      expect(dispatch.transcribe).not.toHaveBeenCalled();
    });

    it('rejects a malformed language hint', async () => {
      await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .field('languageHint', 'English')
        .attach('audio', AUDIO, {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(400);

      expect(dispatch.transcribe).not.toHaveBeenCalled();
    });

    it('accepts a browser recording labelled with its codec', async () => {
      await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .field('languageHint', 'en')
        .attach('audio', AUDIO, {
          filename: 'recording.webm',
          contentType: 'audio/webm;codecs=opus',
        })
        .expect(200);

      expect(dispatch.transcribe).toHaveBeenCalledWith(
        learner.id,
        expect.objectContaining({ contentType: 'audio/webm', languageHint: 'en' }),
      );
    });
  });

  describe('synthesis request validation', () => {
    it('rejects text past the character cap before any provider call', async () => {
      await request(server())
        .post('/api/ai/speech/synthesize')
        .set(authHeader(learner.accessToken))
        .send({ text: 'a'.repeat(MAX_SYNTHESIS_TEXT_LENGTH + 1) })
        .expect(400);

      expect(dispatch.synthesize).not.toHaveBeenCalled();
    });

    it('rejects an empty text', async () => {
      await request(server())
        .post('/api/ai/speech/synthesize')
        .set(authHeader(learner.accessToken))
        .send({ text: '   ' })
        .expect(400);

      expect(dispatch.synthesize).not.toHaveBeenCalled();
    });

    it('rejects an unknown key rather than dropping it', async () => {
      // `modelId` specifically: a client that could name a model would bind
      // itself to whatever the admin configured for a costlier role, and a
      // silently ignored field would let it believe it had.
      await request(server())
        .post('/api/ai/speech/synthesize')
        .set(authHeader(learner.accessToken))
        .send({ text: 'Hello', modelId: 'gpt-4o' })
        .expect(400);

      expect(dispatch.synthesize).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // The responses
  // ---------------------------------------------------------------------------

  describe('successful responses', () => {
    it('returns the transcript and the confidence, and nothing else', async () => {
      const response = await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .attach('audio', AUDIO, {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(200);

      // `toEqual` on the envelope's `data`: the assertion is about what is
      // ABSENT — no model id, no usage, no usage-event id, and above all no
      // audio and no URL to any.
      expect(response.body.data).toEqual({
        status: 'ok',
        text: 'the President',
        confidence: 0.91,
      });
    });

    it('reports an unscored transcription as null, never as 0', async () => {
      dispatch.transcribe.mockResolvedValue({
        status: 'ok',
        text: 'the President',
        confidence: null,
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        modelId: 'gpt-4o-transcribe',
      });

      const response = await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .attach('audio', AUDIO, {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(200);

      expect(response.body.data.confidence).toBeNull();
    });

    it('returns synthesised audio with the provider`s own content type', async () => {
      const response = await request(server())
        .post('/api/ai/speech/synthesize')
        .set(authHeader(learner.accessToken))
        .send({ text: 'Who is the President?' })
        // `responseType('blob')` so superagent buffers the bytes instead of
        // trying to parse an unknown media type into an object.
        .responseType('blob')
        .expect(200)
        .expect('Content-Type', 'audio/mpeg');

      expect(Buffer.from(response.body)).toEqual(
        Buffer.from([0x49, 0x44, 0x33, 0x04]),
      );
      // Generated on the CALLER's own key: a shared cache holding it would
      // serve one learner's paid-for audio to another.
      expect(response.headers['cache-control']).toBe('no-store');
    });
  });

  describe('`unavailable` is a typed payload naming the role, never an exception', () => {
    const CAUSES = [
      'no_user_key',
      'ai_disabled',
      'role_unbound',
      'capability_unsupported',
    ] as const;

    it.each(CAUSES)('transcribe reports %s as a 200 with the cause', async (cause) => {
      dispatch.transcribe.mockResolvedValue({ status: 'unavailable', cause });

      const response = await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .attach('audio', AUDIO, {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(200);

      expect(response.body.data).toEqual({
        status: 'unavailable',
        cause,
        role: 'transcribe',
      });
    });

    it.each(CAUSES)('synthesize reports %s as JSON, not audio', async (cause) => {
      dispatch.synthesize.mockResolvedValue({ status: 'unavailable', cause });

      const response = await request(server())
        .post('/api/ai/speech/synthesize')
        .set(authHeader(learner.accessToken))
        .send({ text: 'Who is the President?' })
        .expect(200);

      // TOLD APART BY `Content-Type`, which is why the JSON half must declare
      // one a client can branch on.
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body.data).toEqual({
        status: 'unavailable',
        cause,
        role: 'speak',
      });
    });

    it('keeps a provider failure distinct from an unavailable one', async () => {
      dispatch.transcribe.mockResolvedValue({
        status: 'failed',
        errorCode: 'rate_limited',
        error: 'Too many requests.',
        usageEventId: null,
        modelId: 'gpt-4o-transcribe',
      });

      const response = await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .attach('audio', AUDIO, {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(200);

      expect(response.body.data).toEqual({
        status: 'failed',
        errorCode: 'rate_limited',
        error: 'Too many requests.',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // The audio is never stored
  // ---------------------------------------------------------------------------

  describe('the recording is never persisted', () => {
    it('writes no storage_objects row for a transcribed upload', async () => {
      await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .attach('audio', AUDIO, {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(200);

      expect(prismaMock.storageObject.create).not.toHaveBeenCalled();
      expect(prismaMock.storageObject.upsert).not.toHaveBeenCalled();
      expect(prismaMock.storageObjectChunk.create).not.toHaveBeenCalled();
    });

    it('writes no storage row even for an upload that was refused', async () => {
      await request(server())
        .post('/api/ai/speech/transcribe')
        .set(authHeader(learner.accessToken))
        .attach('audio', Buffer.alloc(MAX_TRANSCRIBE_AUDIO_BYTES + 1), {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(400);

      expect(prismaMock.storageObject.create).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// No temp file, and no path from here into storage
// =============================================================================
//
// This block reads the two speech source files instead of exercising them, for
// the reason `ai-dispatch.service.spec.ts`'s own last block gives: a
// behavioural test proves only that the paths it happens to run did not write
// a file, and the write that matters would be added on the path nobody wrote a
// test for.
//
// TWO RUNTIME ALTERNATIVES WERE TRIED AND REJECTED, both because they would be
// flaky rather than wrong. Diffing `os.tmpdir()` around a request sees files
// belonging to OTHER jest workers, which run concurrently in the same
// directory. Spying on `fs.createWriteStream` never fires either, because
// `@fastify/multipart` destructures it at module load, long before any spy is
// installed. What is actually load-bearing is that this code never calls
// `saveRequestFiles` — the plugin's only temp-file path — and never reaches
// the filesystem or the storage module at all, and that is a claim about the
// source.

const SPEECH_SOURCES = ['ai-speech.controller.ts', 'ai-speech.service.ts'].map(
  (file) => ({
    file,
    source: readFileSync(join(__dirname, '..', 'src', 'ai', file), 'utf8'),
  }),
);

describe('the speech surface cannot write the recording anywhere', () => {
  it.each(SPEECH_SOURCES)('$file never asks for a file on disk', ({ source }) => {
    // `saveRequestFiles` is `@fastify/multipart`'s ONLY temp-file path, and
    // `tmpUploads` is where it records what it wrote. Naming either is the
    // shape this regression takes.
    expect(source).not.toContain('saveRequestFiles');
    expect(source).not.toContain('tmpUploads');
    expect(source).not.toContain('writeFile');
    expect(source).not.toContain('createWriteStream');
  });

  it.each(SPEECH_SOURCES)('$file imports no filesystem module', ({ source }) => {
    expect(source).not.toMatch(/from ['"]node:fs['"]/);
    expect(source).not.toMatch(/from ['"]fs['"]/);
    expect(source).not.toMatch(/require\(['"]node:fs['"]\)/);
  });

  it.each(SPEECH_SOURCES)('$file has no path into the storage module', ({ source }) => {
    // `voice.md` §4: "there is no code path from the speech controller into
    // the storage module at all." An IMPORT, not the word — both files talk
    // ABOUT storage at length, saying what they do not do with it, and a test
    // that failed on the prose would be deleted rather than obeyed.
    expect(source).not.toMatch(/from ['"][^'"]*\/storage[^'"]*['"]/);
    expect(source).not.toMatch(/require\(['"][^'"]*\/storage[^'"]*['"]\)/);
    expect(source).not.toContain('StorageObjectsService');
  });
});

// =============================================================================
// The real dispatcher: usage accounting, and whose key pays for it
// =============================================================================

describe('Speech API — over the real dispatcher and a real provider', () => {
  let context: TestContext;
  let learner: TestUser;

  const getSecret = jest.fn();

  const server = () => context.app.getHttpServer();

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        // A REAL `BaseAiProvider` — `FakeAiProvider` — rather than a hand-made
        // double, because the property under test lives in the base class: the
        // `ai_usage_events` write every public provider method owes, on
        // success and on failure alike. A double would satisfy the dispatcher
        // and record nothing.
        {
          provide: OpenAiProvider,
          useValue: new FakeAiProvider(
            new AiUsageService(prismaMock as unknown as PrismaService, new Clock()),
          ),
        },
        { provide: CredentialsService, useValue: { getSecret } },
      ],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    setupAiSettings();

    getSecret.mockReset();
    getSecret.mockResolvedValue('sk-learner-abcdefghijklmnopqrst');

    (prismaMock.aiUsageEvent.create as jest.Mock).mockResolvedValue({
      id: 'usage-row-1',
    });

    learner = await createMockViewerUser(context, 'learner@example.com');
  });

  it('records an ai_usage_events row with roleKey "transcribe"', async () => {
    await request(server())
      .post('/api/ai/speech/transcribe')
      .set(authHeader(learner.accessToken))
      .attach('audio', AUDIO, {
        filename: 'recording.webm',
        contentType: 'audio/webm',
      })
      .expect(200);

    expect(prismaMock.aiUsageEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: learner.id,
          roleKey: 'transcribe',
          model: 'gpt-4o-transcribe',
          success: true,
          // ALL-NULL TOKEN COUNTS ARE THE ORDINARY CASE on this surface: the
          // speech APIs bill by audio duration and report none. `null` is the
          // honest reading of "we were not told" — never 0.
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
        }),
      }),
    );
  });

  it('records an ai_usage_events row with roleKey "speak"', async () => {
    await request(server())
      .post('/api/ai/speech/synthesize')
      .set(authHeader(learner.accessToken))
      .send({ text: 'Who is the President?' })
      .expect(200);

    expect(prismaMock.aiUsageEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: learner.id,
          roleKey: 'speak',
          model: 'gpt-4o-mini-tts',
          success: true,
        }),
      }),
    );
  });

  it('reads only the caller`s own credential, never the organisation`s', async () => {
    // The failure this forbids is silent: `ai_usage_events.userId` would still
    // name the learner while the money came out of the administrator's
    // account, with nothing in the result shape to tell the two apart.
    await request(server())
      .post('/api/ai/speech/transcribe')
      .set(authHeader(learner.accessToken))
      .attach('audio', AUDIO, {
        filename: 'recording.webm',
        contentType: 'audio/webm',
      })
      .expect(200);

    await request(server())
      .post('/api/ai/speech/synthesize')
      .set(authHeader(learner.accessToken))
      .send({ text: 'Who is the President?' })
      .expect(200);

    expect(getSecret).toHaveBeenCalledWith(
      AI_USER_CREDENTIAL_PURPOSE,
      expect.stringContaining(learner.id),
    );
    expect(getSecret).not.toHaveBeenCalledWith(
      AI_SYSTEM_CREDENTIAL_PURPOSE,
      AI_SYSTEM_CREDENTIAL_NAME,
    );
  });

  it('reports no stored key as `unavailable`, without calling the provider', async () => {
    getSecret.mockResolvedValue(null);

    const response = await request(server())
      .post('/api/ai/speech/transcribe')
      .set(authHeader(learner.accessToken))
      .attach('audio', AUDIO, {
        filename: 'recording.webm',
        contentType: 'audio/webm',
      })
      .expect(200);

    expect(response.body.data).toEqual({
      status: 'unavailable',
      cause: 'no_user_key',
      role: 'transcribe',
    });
    // NOTHING RAN, so nothing is owed and no row was written.
    expect(prismaMock.aiUsageEvent.create).not.toHaveBeenCalled();
  });
});

// =============================================================================
// GET /api/ai/speech/voices (integration) — issue #283, epic #280
// =============================================================================
//
// The route the voice picker reads instead of a hand-copied list in
// `apps/web/src/config`. Three properties, over real HTTP:
//
//   * a VIEWER — the least-privileged seeded role — gets a 200, because voice
//     adds no permission string (`docs/specs/voice.md` §10) and gating this
//     would leave the default role unable to choose a voice at all;
//   * an unbound `speak` role is `speakBound: false` AND STILL A 200 WITH A
//     POPULATED LIST, because "which voices does this provider have" and "has
//     an administrator bound a model" are different questions and the picker
//     renders them differently;
//   * a provider with no `tts` capability is `voices: []` — `capability_unsupported`
//     expressed as an empty list rather than an error, since the browser's own
//     `speechSynthesis` still reads every question aloud.
//
// A REAL `FakeAiProvider` rather than a dispatcher double, because the answer
// comes from the provider's own declaration and a double would be asserting
// against a list written in this file.
// =============================================================================

/** The fake's capabilities, minus `tts`. */
const NO_TTS_CAPABILITIES: AiCapabilitySet = new Set<AiCapabilityFamily>([
  'text',
  'realtime',
  'transcribe',
  'embedding',
  'other',
]);

/**
 * The fake with its speech capability removed.
 *
 * A SUBCLASS RATHER THAN A HAND-WRITTEN DOUBLE, so the `[]` under test comes
 * from `BaseAiProvider.listVoices`' real capability gate over a provider that
 * genuinely does declare voices — which is the only way to tell that gate apart
 * from "this double had no voices to return".
 */
class NoTtsFakeProvider extends FakeAiProvider {
  readonly capabilities = NO_TTS_CAPABILITIES;
}

describe('GET /api/ai/speech/voices — over a real provider', () => {
  let context: TestContext;
  let learner: TestUser;

  const getSecret = jest.fn();

  const server = () => context.app.getHttpServer();

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        {
          provide: OpenAiProvider,
          useValue: new FakeAiProvider(
            new AiUsageService(prismaMock as unknown as PrismaService, new Clock()),
          ),
        },
        { provide: CredentialsService, useValue: { getSecret } },
      ],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    setupAiSettings();

    getSecret.mockReset();
    getSecret.mockResolvedValue('sk-learner-abcdefghijklmnopqrst');

    learner = await createMockViewerUser(context, 'learner@example.com');
  });

  it('rejects an unauthenticated caller', async () => {
    await request(server()).get('/api/ai/speech/voices').expect(401);
  });

  it('lets a Viewer read it — voice adds no permission string', async () => {
    const response = await request(server())
      .get('/api/ai/speech/voices')
      .set(authHeader(learner.accessToken))
      .expect(200);

    expect(response.body.data.voices.length).toBeGreaterThan(0);
    expect(response.body.data.speakBound).toBe(true);
    expect(response.body.data.defaultVoice).toEqual(expect.any(String));
  });

  it('returns every voice with an id, a label and a description', async () => {
    const response = await request(server())
      .get('/api/ai/speech/voices')
      .set(authHeader(learner.accessToken))
      .expect(200);

    for (const voice of response.body.data.voices) {
      expect(voice).toEqual({
        id: expect.any(String),
        label: expect.any(String),
        description: expect.any(String),
      });
    }
  });

  it('names a default that is one of the voices it returned', async () => {
    const response = await request(server())
      .get('/api/ai/speech/voices')
      .set(authHeader(learner.accessToken))
      .expect(200);

    expect(
      response.body.data.voices.map((voice: { id: string }) => voice.id),
    ).toContain(response.body.data.defaultVoice);
  });

  it('reads no credential — nobody`s key is spent to list voices', async () => {
    await request(server())
      .get('/api/ai/speech/voices')
      .set(authHeader(learner.accessToken))
      .expect(200);

    expect(getSecret).not.toHaveBeenCalled();
    expect(prismaMock.aiUsageEvent.create).not.toHaveBeenCalled();
  });

  it('is `speakBound: false` with an unbound role, and still a 200 with voices', async () => {
    // THE DISTINCTION THE PICKER RENDERS. An unbound `speak` is the state of
    // every fresh install: the provider still has voices, the premium path is
    // simply not configured, and nothing about that is an error — the browser
    // reads the question aloud either way (`docs/specs/voice.md` §2).
    setupAiSettings({
      ...READY_AI_SETTINGS,
      models: { ...READY_AI_SETTINGS.models, speak: null },
    });

    const response = await request(server())
      .get('/api/ai/speech/voices')
      .set(authHeader(learner.accessToken))
      .expect(200);

    expect(response.body.data.speakBound).toBe(false);
    expect(response.body.data.voices.length).toBeGreaterThan(0);
  });

  it('is `speakBound: false` without ever being a `status` union', async () => {
    // Every other route on this controller answers with `{ status, … }`. This
    // one never does, and a client written against a union would branch on a
    // field that is not there.
    setupAiSettings({
      ...READY_AI_SETTINGS,
      models: { ...READY_AI_SETTINGS.models, speak: null },
    });

    const response = await request(server())
      .get('/api/ai/speech/voices')
      .set(authHeader(learner.accessToken))
      .expect(200);

    expect(response.body.data).not.toHaveProperty('status');
    expect(response.body.data).not.toHaveProperty('cause');
  });

  it('is an empty list when no provider is configured', async () => {
    setupAiSettings({ ...READY_AI_SETTINGS, provider: null });

    const response = await request(server())
      .get('/api/ai/speech/voices')
      .set(authHeader(learner.accessToken))
      .expect(200);

    expect(response.body.data.voices).toEqual([]);
    expect(response.body.data.defaultVoice).toBeNull();
  });

  it('still lists voices when the master switch is off', async () => {
    // Reading a static array spends nothing, so `enabled: false` is not a
    // reason to empty the picker — what such a deployment cannot do is
    // synthesise, which `POST /ai/speech/synthesize` answers with
    // `cause: 'ai_disabled'`.
    setupAiSettings({ ...READY_AI_SETTINGS, enabled: false });

    const response = await request(server())
      .get('/api/ai/speech/voices')
      .set(authHeader(learner.accessToken))
      .expect(200);

    expect(response.body.data.voices.length).toBeGreaterThan(0);
  });

  it('is an empty list, not a 500, when the settings row is unreadable', async () => {
    // `AiSettingsService.get` throws on a stored-but-invalid row. A picker is
    // not the surface that should surface that: it has nothing to offer, which
    // is what an empty list says.
    setupAiSettings({ provider: 'not-a-provider' });

    const response = await request(server())
      .get('/api/ai/speech/voices')
      .set(authHeader(learner.accessToken))
      .expect(200);

    expect(response.body.data.voices).toEqual([]);
  });
});

describe('GET /api/ai/speech/voices — on a provider with no tts capability', () => {
  let context: TestContext;
  let learner: TestUser;

  const server = () => context.app.getHttpServer();

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        {
          provide: OpenAiProvider,
          useValue: new NoTtsFakeProvider(
            new AiUsageService(prismaMock as unknown as PrismaService, new Clock()),
          ),
        },
      ],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    setupAiSettings();

    learner = await createMockViewerUser(context, 'learner@example.com');
  });

  it('answers 200 with an empty list, never an error', async () => {
    // `capability_unsupported` expressed as an empty list. The picker then
    // offers the browser's own voices, which is the CORRECT outcome — a
    // deployment on a chat-only provider is a smaller product, not a broken
    // one.
    const response = await request(server())
      .get('/api/ai/speech/voices')
      .set(authHeader(learner.accessToken))
      .expect(200);

    expect(response.body.data.voices).toEqual([]);
    expect(response.body.data.defaultVoice).toBeNull();
  });
});

// =============================================================================
// The shared civics audio cache — GET /api/ai/speech/audio (#284, epic #280)
// =============================================================================
//
// WIRED OVER THE REAL DISPATCHER AND A REAL `BaseAiProvider`, like the block
// above and unlike the two-dozen tests below the first one — because the
// property this route exists for is not "the dispatcher was called with the
// right arguments". It is that the SECOND request for a clip writes no
// `ai_usage_events` row at all, and a usage row is written inside
// `BaseAiProvider`, below the dispatcher a double would replace. Asserting on a
// mock's call count instead would prove the code did not call a function; the
// row is what proves nobody's key was spent.
//
// The storage provider is a fake that keeps objects in a `Map`. The
// `StorageProvider` PORT is what this cache injects (`STORAGE_PROVIDER`), never
// the storage module's object service, so the fake is a complete stand-in for
// the only storage surface this code path can reach.
//
// No test in this repository touches a database (docs/TESTING.md).
// =============================================================================

/** A question whose prompt never changes. */
const Q_BRANCH = '11111111-1111-4111-8111-111111111111';
/** A `state`-scope question: no answer at all without a state on the profile. */
const Q_GOVERNOR = '22222222-2222-4222-8222-222222222222';
/** A `national`-scope question whose answer an admin can correct. */
const Q_PRESIDENT = '33333333-3333-4333-8333-333333333333';

const CIVICS_CATEGORY = {
  id: '44444444-4444-4444-8444-444444444444',
  testVersionCode: 'v2008',
  section: 'American Government',
  code: 'A',
  name: 'Principles of American Democracy',
  sortOrder: 0,
};

const CIVICS_QUESTIONS = [
  {
    id: Q_BRANCH,
    number: 13,
    prompt: 'Name one branch or part of the government.',
    categoryId: CIVICS_CATEGORY.id,
    testVersionCode: 'v2008',
    seniorEligible: true,
    dynamicScope: 'none',
  },
  {
    id: Q_GOVERNOR,
    number: 43,
    prompt: 'Who is the Governor of your state now?',
    categoryId: CIVICS_CATEGORY.id,
    testVersionCode: 'v2008',
    seniorEligible: false,
    dynamicScope: 'state',
  },
  {
    id: Q_PRESIDENT,
    number: 28,
    prompt: 'What is the name of the President of the United States now?',
    categoryId: CIVICS_CATEGORY.id,
    testVersionCode: 'v2008',
    seniorEligible: true,
    dynamicScope: 'national',
  },
];

/**
 * The `civics_answers` rows, MUTABLE for the duration of one test.
 *
 * One test corrects the President's answer mid-flight, which is the whole point
 * of hashing the text into the cache key: the corrected wording must resolve to
 * a different asset with no invalidation code anywhere.
 */
let civicsAnswers: Array<{
  id: string;
  questionId: string;
  text: string;
  sort: number;
  stateCode: string | null;
  verifiedAt: Date;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  sourceNote: string | null;
}>;

/** The `learner_profiles` table, for the duration of one test. */
let civicsProfiles: Map<string, { stateCode: string | null; testVersionCode: string | null }>;

/** The object store, for the duration of one test. */
let storedObjects: Map<string, Buffer>;

/** The `speech_audio_assets` table, for the duration of one test. */
let speechAssets: Map<string, Record<string, unknown>>;

/** The unique key `@@unique([scope, refId, voice, modelId, format, contentSha256])` names. */
function assetKey(row: {
  scope: string;
  refId: string;
  voice: string;
  modelId: string;
  format: string;
  contentSha256: string;
}): string {
  return [
    row.scope,
    row.refId,
    row.voice,
    row.modelId,
    row.format,
    row.contentSha256,
  ].join('|');
}

/**
 * An in-memory `StorageProvider`.
 *
 * Only four of the interface's methods can be reached from this code path, and
 * the rest throw rather than returning a plausible-looking value: a cache that
 * started calling `initMultipartUpload` for a 12-byte clip would be a change
 * worth failing a test over, not one to absorb silently.
 */
function createFakeStorage() {
  const unreachable = (name: string) => async () => {
    throw new Error(`The audio cache must not call StorageProvider.${name}`);
  };

  return {
    upload: jest.fn(async (key: string, stream: any) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      storedObjects.set(key, Buffer.concat(chunks));
      return { key, bucket: 'test', location: `memory://${key}` };
    }),
    download: jest.fn(async (key: string) => {
      const found = storedObjects.get(key);
      if (!found) throw new Error(`No object at ${key}`);
      return Readable.from(found);
    }),
    exists: jest.fn(async (key: string) => storedObjects.has(key)),
    getBucket: () => 'test',
    delete: jest.fn(async (key: string) => {
      storedObjects.delete(key);
    }),
    initMultipartUpload: unreachable('initMultipartUpload'),
    getSignedUploadUrl: unreachable('getSignedUploadUrl'),
    completeMultipartUpload: unreachable('completeMultipartUpload'),
    abortMultipartUpload: unreachable('abortMultipartUpload'),
    getSignedDownloadUrl: unreachable('getSignedDownloadUrl'),
    getMetadata: unreachable('getMetadata'),
    setMetadata: unreachable('setMetadata'),
  };
}

/** Wire the civics tables and the asset table into the shared Prisma mock. */
function setupCivicsAudioMocks(): void {
  civicsProfiles = new Map();
  storedObjects = new Map();
  speechAssets = new Map();
  civicsAnswers = [
    {
      id: 'aaaaaaaa-0001-4000-8000-000000000001',
      questionId: Q_BRANCH,
      text: 'Congress',
      sort: 0,
      stateCode: null,
      verifiedAt: new Date('2026-05-01T00:00:00Z'),
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      effectiveTo: null,
      sourceNote: null,
    },
    {
      id: 'aaaaaaaa-0002-4000-8000-000000000002',
      questionId: Q_BRANCH,
      text: 'the President',
      sort: 1,
      stateCode: null,
      verifiedAt: new Date('2026-05-01T00:00:00Z'),
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      effectiveTo: null,
      sourceNote: null,
    },
    {
      id: 'aaaaaaaa-0003-4000-8000-000000000003',
      questionId: Q_GOVERNOR,
      text: 'The Governor of Texas',
      sort: 0,
      stateCode: 'TX',
      verifiedAt: new Date('2026-05-01T00:00:00Z'),
      effectiveFrom: new Date('2023-01-17T00:00:00Z'),
      effectiveTo: null,
      sourceNote: null,
    },
    {
      id: 'aaaaaaaa-0004-4000-8000-000000000004',
      questionId: Q_PRESIDENT,
      text: 'The current President',
      sort: 0,
      stateCode: null,
      verifiedAt: new Date('2026-05-01T00:00:00Z'),
      effectiveFrom: new Date('2021-01-20T00:00:00Z'),
      effectiveTo: null,
      sourceNote: null,
    },
  ];

  (prismaMock.learnerProfile.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => civicsProfiles.get(where.userId) ?? null,
  );

  (prismaMock.civicsQuestion.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      const found = CIVICS_QUESTIONS.find((q) => q.id === where.id);

      return found ? { ...found, category: CIVICS_CATEGORY } : null;
    },
  );

  (prismaMock.civicsAnswer.findMany as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      const now: Date = where.effectiveFrom.lte;

      return civicsAnswers
        .filter((a) => {
          if (a.questionId !== where.questionId) return false;
          if ((a.stateCode ?? null) !== (where.stateCode ?? null)) return false;
          if (a.effectiveFrom.getTime() > now.getTime()) return false;
          if (a.effectiveTo !== null && a.effectiveTo.getTime() <= now.getTime()) {
            return false;
          }
          return true;
        })
        .sort((x, y) => x.sort - y.sort);
    },
  );

  (prismaMock.speechAudioAsset.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) =>
      speechAssets.get(
        assetKey(where.scope_refId_voice_modelId_format_contentSha256),
      ) ?? null,
  );

  (prismaMock.speechAudioAsset.create as jest.Mock).mockImplementation(
    async ({ data }: any) => {
      const key = assetKey(data);

      if (speechAssets.has(key)) {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          { code: 'P2002', clientVersion: 'test' },
        );
      }

      speechAssets.set(key, data);

      return { id: `asset-${speechAssets.size}`, ...data };
    },
  );
}

describe('Civics audio cache — GET /api/ai/speech/audio', () => {
  let context: TestContext;
  let learner: TestUser;
  let otherLearner: TestUser;

  const getSecret = jest.fn();
  const storage = createFakeStorage();

  const server = () => context.app.getHttpServer();

  /** How many `ai_usage_events` rows have been written so far. */
  const usageRows = () =>
    (prismaMock.aiUsageEvent.create as jest.Mock).mock.calls.length;

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        {
          provide: OpenAiProvider,
          useValue: new FakeAiProvider(
            new AiUsageService(prismaMock as unknown as PrismaService),
          ),
        },
        { provide: CredentialsService, useValue: { getSecret } },
        // THE PORT, which is the only storage surface this cache can reach.
        { provide: STORAGE_PROVIDER, useValue: storage },
      ],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    setupAiSettings();
    setupCivicsAudioMocks();

    storage.upload.mockClear();
    storage.download.mockClear();

    getSecret.mockReset();
    getSecret.mockResolvedValue('sk-learner-abcdefghijklmnopqrst');

    (prismaMock.aiUsageEvent.create as jest.Mock).mockResolvedValue({
      id: 'usage-row-1',
    });

    learner = await createMockViewerUser(context, 'learner@example.com');
    otherLearner = await createMockViewerUser(context, 'second@example.com');

    civicsProfiles.set(learner.id, { stateCode: 'TX', testVersionCode: 'v2008' });
    civicsProfiles.set(otherLearner.id, {
      stateCode: 'TX',
      testVersionCode: 'v2008',
    });
  });

  const play = (user: TestUser, query: string) =>
    request(server())
      .get(`/api/ai/speech/audio?${query}`)
      .set(authHeader(user.accessToken))
      .responseType('blob');

  // ---------------------------------------------------------------------------
  // The permission posture — unchanged by this route
  // ---------------------------------------------------------------------------

  it('rejects an unauthenticated request', async () => {
    await request(server())
      .get(`/api/ai/speech/audio?scope=civics_question&refId=${Q_BRANCH}`)
      .expect(401);

    expect(usageRows()).toBe(0);
  });

  it('lets a Viewer play a question — this route adds no permission string', async () => {
    await play(learner, `scope=civics_question&refId=${Q_BRANCH}`).expect(200);
  });

  // ---------------------------------------------------------------------------
  // The cache itself
  // ---------------------------------------------------------------------------

  it('synthesises once, stores the bytes, and writes one asset row and one usage row', async () => {
    const response = await play(
      learner,
      `scope=civics_question&refId=${Q_BRANCH}`,
    )
      .expect(200)
      .expect('Content-Type', 'audio/mpeg');

    expect(Buffer.from(response.body).length).toBeGreaterThan(0);

    expect(speechAssets.size).toBe(1);
    expect(storedObjects.size).toBe(1);
    expect(usageRows()).toBe(1);

    // On the CALLER's own key, under the `speak` role — the same accounting
    // `POST /ai/speech/synthesize` produces, because it is the same dispatch.
    expect(prismaMock.aiUsageEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: learner.id,
          roleKey: 'speak',
          model: 'gpt-4o-mini-tts',
          success: true,
        }),
      }),
    );

    const [row] = [...speechAssets.values()] as any[];
    expect(row.scope).toBe('civics_question');
    expect(row.refId).toBe(Q_BRANCH);
    expect(row.generatedByUserId).toBe(learner.id);
    // The key is a pure function of the cache key — see `buildStorageKey`.
    expect(row.storageKey).toContain('speech/civics/civics_question/');
    expect([...storedObjects.keys()]).toEqual([row.storageKey]);
  });

  it('serves a second learner the same bytes with NO ai_usage_events row', async () => {
    const first = await play(learner, `scope=civics_question&refId=${Q_BRANCH}`)
      .expect(200);

    expect(usageRows()).toBe(1);

    // THE ASSERTION THAT MATTERS. Not "the dispatcher was not called" — the
    // absence of a usage row is what says no key was spent, and it is the fact
    // a learner would otherwise be billed for.
    (prismaMock.aiUsageEvent.create as jest.Mock).mockClear();

    const second = await play(
      otherLearner,
      `scope=civics_question&refId=${Q_BRANCH}`,
    )
      .expect(200)
      .expect('Content-Type', 'audio/mpeg');

    expect(usageRows()).toBe(0);
    expect(Buffer.from(second.body)).toEqual(Buffer.from(first.body));
    // Still one row and one object: the second learner read the first's.
    expect(speechAssets.size).toBe(1);
    expect(storedObjects.size).toBe(1);
  });

  it('treats a different voice as a different clip', async () => {
    await play(learner, `scope=civics_question&refId=${Q_BRANCH}`).expect(200);
    await play(
      learner,
      `scope=civics_question&refId=${Q_BRANCH}&voice=fake-bright`,
    ).expect(200);

    // Two assets, two objects, two synthesis calls: two voices reading the same
    // sentence are two different recordings, not one.
    expect(speechAssets.size).toBe(2);
    expect(storedObjects.size).toBe(2);
    expect(usageRows()).toBe(2);
  });

  it('misses after a corrected answer, and leaves the old asset untouched', async () => {
    await play(learner, `scope=civics_answer&refId=${Q_PRESIDENT}`).expect(200);

    expect(speechAssets.size).toBe(1);
    const beforeKeys = [...speechAssets.keys()];

    // The admin correction (`PUT /api/civics/dynamic-answers`) as this test can
    // express it: the currently-open row now says something else.
    civicsAnswers = civicsAnswers.map((answer) =>
      answer.questionId === Q_PRESIDENT
        ? { ...answer, text: 'The newly sworn-in President' }
        : answer,
    );

    await play(learner, `scope=civics_answer&refId=${Q_PRESIDENT}`).expect(200);

    // A NEW row for the new wording, and the old one still exactly where it
    // was — nothing expires it, because nothing addresses it any more.
    expect(speechAssets.size).toBe(2);
    expect([...speechAssets.keys()]).toEqual(
      expect.arrayContaining(beforeKeys),
    );
    expect(usageRows()).toBe(2);
  });

  it('reads the first accepted answer, not all of them joined', async () => {
    await play(learner, `scope=civics_answer&refId=${Q_BRANCH}`).expect(200);

    const [row] = [...speechAssets.values()] as any[];
    // "Congress" — 8 characters. The three-answer question would be far longer
    // if every alternative were read aloud.
    expect(row.charCount).toBe('Congress'.length);
  });

  // ---------------------------------------------------------------------------
  // The states that synthesise nothing
  // ---------------------------------------------------------------------------

  it('reports state_required for a state answer with no state set, and synthesises nothing', async () => {
    civicsProfiles.set(learner.id, { stateCode: null, testVersionCode: 'v2008' });

    const response = await request(server())
      .get(`/api/ai/speech/audio?scope=civics_answer&refId=${Q_GOVERNOR}`)
      .set(authHeader(learner.accessToken))
      .expect(200);

    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body.data).toEqual({ status: 'state_required' });

    expect(usageRows()).toBe(0);
    expect(speechAssets.size).toBe(0);
    expect(storedObjects.size).toBe(0);
  });

  it('still reads the QUESTION aloud for a learner with no state', async () => {
    // The prompt is not state-specific — only the answer is. Refusing both
    // would withhold something we can perfectly well say.
    civicsProfiles.set(learner.id, { stateCode: null, testVersionCode: 'v2008' });

    await play(learner, `scope=civics_question&refId=${Q_GOVERNOR}`).expect(200);

    expect(speechAssets.size).toBe(1);
  });

  it('reports an unbound `speak` role as a 200 with the cause, and writes nothing', async () => {
    setupAiSettings({
      ...READY_AI_SETTINGS,
      models: { ...READY_AI_SETTINGS.models, speak: null },
    });

    const response = await request(server())
      .get(`/api/ai/speech/audio?scope=civics_question&refId=${Q_BRANCH}`)
      .set(authHeader(learner.accessToken))
      .expect(200);

    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body.data).toEqual({
      status: 'unavailable',
      cause: 'role_unbound',
      role: 'speak',
    });

    expect(speechAssets.size).toBe(0);
    expect(storedObjects.size).toBe(0);
    expect(usageRows()).toBe(0);
  });

  it('answers 404 for a question id that does not exist', async () => {
    // NOT a `status` member. The question genuinely is not there, which is a
    // different problem with a different owner than "AI is not configured".
    await request(server())
      .get(
        '/api/ai/speech/audio?scope=civics_question&refId=99999999-9999-4999-8999-999999999999',
      )
      .set(authHeader(learner.accessToken))
      .expect(404);

    expect(speechAssets.size).toBe(0);
    expect(usageRows()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // The double-miss race
  // ---------------------------------------------------------------------------

  it('serves the loser of a double miss its audio, leaving one asset row', async () => {
    // The other request won between this one's lookup and its insert: the row
    // now exists, so the `create` raises `P2002`.
    (prismaMock.speechAudioAsset.create as jest.Mock).mockImplementation(
      async ({ data }: any) => {
        speechAssets.set(assetKey(data), data);

        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          { code: 'P2002', clientVersion: 'test' },
        );
      },
    );

    const response = await play(
      learner,
      `scope=civics_question&refId=${Q_BRANCH}`,
    )
      .expect(200)
      .expect('Content-Type', 'audio/mpeg');

    // The learner still hears their question — the synthesis was paid for
    // either way, and failing on top of that would take their money and their
    // answer.
    expect(Buffer.from(response.body).length).toBeGreaterThan(0);
    expect(speechAssets.size).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Caching headers
  // ---------------------------------------------------------------------------

  it('lets a browser keep a fixed question, in a named voice, for a long time', async () => {
    const response = await play(
      learner,
      `scope=civics_question&refId=${Q_BRANCH}&voice=fake-warm`,
    ).expect(200);

    // What `POST /ai/speech/synthesize` may not do, and why — see the route's
    // own doc comment.
    expect(response.headers['cache-control']).toMatch(/^private, max-age=\d+/);
    expect(response.headers['cache-control']).not.toContain('no-store');

    const maxAge = Number(
      /max-age=(\d+)/.exec(response.headers['cache-control'] ?? '')?.[1],
    );
    expect(maxAge).toBeGreaterThan(60 * 60 * 24);
  });

  it('will not claim a long life for a URL that did not name its voice', async () => {
    // Without `voice` the URL resolves through the learner's own preference, so
    // it does not address these bytes: changing that preference must not leave
    // them hearing last month's voice out of their own cache.
    const response = await play(
      learner,
      `scope=civics_question&refId=${Q_BRANCH}`,
    ).expect(200);

    const maxAge = Number(
      /max-age=(\d+)/.exec(response.headers['cache-control'] ?? '')?.[1],
    );
    expect(maxAge).toBeLessThanOrEqual(3600);
  });

  it('keeps a correctable answer out of a long-lived browser cache', async () => {
    const response = await play(
      learner,
      `scope=civics_answer&refId=${Q_PRESIDENT}&voice=fake-warm`,
    ).expect(200);

    const maxAge = Number(
      /max-age=(\d+)/.exec(response.headers['cache-control'] ?? '')?.[1],
    );

    // Minutes, not a year, even with the voice pinned: the server-side key is
    // content-addressed, a browser cache is URL-addressed, and this URL names a
    // question rather than the answer's text.
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(3600);
  });

  // ---------------------------------------------------------------------------
  // What the request may not say
  // ---------------------------------------------------------------------------

  it('refuses a caller-supplied text rather than dropping it', async () => {
    // The one input that would break the shared cache: text a client chose,
    // stored permanently under a hash it also chose.
    await request(server())
      .get(
        `/api/ai/speech/audio?scope=civics_question&refId=${Q_BRANCH}&text=say%20anything`,
      )
      .set(authHeader(learner.accessToken))
      .expect(400);

    expect(usageRows()).toBe(0);
  });

  it('refuses a caller-supplied model id', async () => {
    await request(server())
      .get(
        `/api/ai/speech/audio?scope=civics_question&refId=${Q_BRANCH}&modelId=gpt-4o`,
      )
      .set(authHeader(learner.accessToken))
      .expect(400);

    expect(usageRows()).toBe(0);
  });

  it('has no state parameter — the state is the caller`s own profile', async () => {
    civicsProfiles.set(learner.id, { stateCode: null, testVersionCode: 'v2008' });

    await request(server())
      .get(
        `/api/ai/speech/audio?scope=civics_answer&refId=${Q_GOVERNOR}&stateCode=TX`,
      )
      .set(authHeader(learner.accessToken))
      .expect(400);
  });

  it('reads only the caller`s own credential, never the organisation`s', async () => {
    await play(learner, `scope=civics_question&refId=${Q_BRANCH}`).expect(200);

    expect(getSecret).toHaveBeenCalledWith(
      AI_USER_CREDENTIAL_PURPOSE,
      expect.stringContaining(learner.id),
    );
    expect(getSecret).not.toHaveBeenCalledWith(
      AI_SYSTEM_CREDENTIAL_PURPOSE,
      AI_SYSTEM_CREDENTIAL_NAME,
    );
  });

  it('creates no storage_objects row for a cached clip', async () => {
    await play(learner, `scope=civics_question&refId=${Q_BRANCH}`).expect(200);

    // The bytes live behind the port, addressed by `storageKey`. A row here
    // would drag in the ownership model that refuses every learner but the one
    // who generated the clip.
    expect(prismaMock.storageObject.create).not.toHaveBeenCalled();
    expect(prismaMock.storageObject.upsert).not.toHaveBeenCalled();
  });
});

// =============================================================================
// The cache reaches object storage through the PORT, and nothing else
// =============================================================================
//
// A source assertion, for the reason `ai-dispatch.service.spec.ts`'s own last
// block gives about the server credential: a behavioural test proves only that
// the paths it happens to run did not reach the object service, and the reach
// that matters would be added on the path nobody wrote a test for.
//
// The failure this forbids is specific. `ObjectsService.getObjectWithAuthCheck`
// refuses any caller who did not upload the object, with no admin bypass — the
// correct rule for a learner's own file and the exact wrong one for a civics
// clip every learner must be able to hear. `CLAUDE.md` warns that threading a
// second rule through that shared helper "would make it a read and write bypass
// in the same edit", so the cache must not be able to arrive there at all.

const AUDIO_CACHE_SOURCE = readFileSync(
  join(__dirname, '..', 'src', 'ai', 'speech-audio.service.ts'),
  'utf8',
);

describe('the audio cache cannot reach the storage object service', () => {
  it('imports the provider port and nothing else from storage', () => {
    expect(AUDIO_CACHE_SOURCE).toMatch(
      /from '\.\.\/storage\/providers\/storage-provider\.interface'/,
    );

    // Every OTHER storage import, by path. The objects subtree is where the
    // ownership model lives; the module barrel would drag it in wholesale.
    expect(AUDIO_CACHE_SOURCE).not.toMatch(
      /from '[^']*storage\/objects[^']*'/,
    );
    expect(AUDIO_CACHE_SOURCE).not.toMatch(/from '[^']*storage\/storage\.module'/);
  });

  it('never names the object service or its table', () => {
    // An IDENTIFIER, not the words: this file discusses the object service at
    // length in its header, saying precisely what it does not do with it, and a
    // test that failed on the prose would be deleted rather than obeyed.
    expect(AUDIO_CACHE_SOURCE).not.toContain('StorageObjectsService');
    expect(AUDIO_CACHE_SOURCE).not.toMatch(/prisma\.storageObject\b/);
    expect(AUDIO_CACHE_SOURCE).not.toMatch(/getObjectWithAuthCheck/);
  });
});

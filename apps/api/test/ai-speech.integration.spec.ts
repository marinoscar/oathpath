import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
            new AiUsageService(prismaMock as unknown as PrismaService),
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
            new AiUsageService(prismaMock as unknown as PrismaService),
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

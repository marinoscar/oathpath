import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { AiDispatchService } from './ai-dispatch.service';
import type { AiSettingsService } from './ai-settings.service';
import type { CivicsService } from '../civics/civics.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { UserSettingsService } from '../settings/user-settings/user-settings.service';
import type { StorageProvider } from '../storage/providers/storage-provider.interface';
import { MAX_SYNTHESIS_TEXT_LENGTH } from './dto/ai-speech.dto';
import {
  SPEECH_AUDIO_KEY_PREFIX,
  SpeechAudioService,
} from './speech-audio.service';

// =============================================================================
// SpeechAudioService — tests (issue #284, epic #280)
// =============================================================================
//
// Three properties carry this file, and each of them is a thing that would cost
// somebody money or teach somebody a wrong answer if it broke:
//
//   1. THE TEXT COMES FROM `CivicsService`, NEVER FROM THE REQUEST. Every
//      assertion about what was synthesized is an assertion about a string this
//      service was never handed.
//   2. A HIT SPENDS NOTHING. `expect(dispatch.synthesize).not.toHaveBeenCalled()`
//      is the unit-level shadow of the integration suite's stronger assertion
//      (no `ai_usage_events` row), which lives there because the row is written
//      below the dispatcher a double replaces.
//   3. A REFUSAL LEAVES NO TRACE. An `unavailable` synthesis must write no row
//      and no object: an entry pointing at bytes that were never uploaded is
//      worse than no entry, because the NEXT learner gets a failure where this
//      one got a legible cause.
//
// The doubles are hand-made rather than `jest-mock-extended` proxies, matching
// `ai-speech.service.spec.ts` next door: what each dependency returns is part of
// the scenario being described, so it belongs in the test's own text.
// =============================================================================

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const QUESTION_ID = '33333333-3333-4333-8333-333333333333';

const PROMPT = 'Name one branch or part of the government.';
const FIRST_ANSWER = 'Congress';

const AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x64]);

/** sha256 of the exact string, which is what the lookup key holds. */
const sha = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

function questionDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: QUESTION_ID,
    number: 13,
    prompt: PROMPT,
    categoryId: 'cat-1',
    testVersionCode: 'v2008',
    seniorEligible: true,
    dynamicScope: 'none',
    category: {
      id: 'cat-1',
      section: 'American Government',
      code: 'A',
      name: 'System of Government',
      sortOrder: 0,
    },
    answerResolution: 'resolved',
    resolvedForStateCode: null,
    verifiedAt: null,
    answers: [
      { id: 'a1', text: FIRST_ANSWER, sort: 0, stateCode: null, verifiedAt: '', sourceNote: null },
      { id: 'a2', text: 'the President', sort: 1, stateCode: null, verifiedAt: '', sourceNote: null },
      { id: 'a3', text: 'the courts', sort: 2, stateCode: null, verifiedAt: '', sourceNote: null },
    ],
    ...overrides,
  };
}

interface Harness {
  service: SpeechAudioService;
  dispatch: { synthesize: jest.Mock; listVoices: jest.Mock };
  storage: { upload: jest.Mock; download: jest.Mock };
  asset: { findUnique: jest.Mock; create: jest.Mock };
  objects: Map<string, Buffer>;
}

function harness(
  options: {
    question?: Record<string, unknown> | Error;
    synthesis?: Record<string, unknown>;
    speakModel?: string | null;
    settingsThrows?: boolean;
    preferredVoice?: string;
    defaultVoice?: string | null;
    existingAsset?: { storageKey: string } | null;
    createThrows?: unknown;
  } = {},
): Harness {
  const objects = new Map<string, Buffer>();

  const dispatch = {
    synthesize: jest.fn().mockResolvedValue(
      options.synthesis ?? {
        status: 'ok',
        audio: AUDIO,
        contentType: 'audio/mpeg',
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        modelId: 'gpt-4o-mini-tts',
      },
    ),
    listVoices: jest.fn().mockResolvedValue({
      voices: [],
      defaultVoice:
        options.defaultVoice === undefined ? 'alloy' : options.defaultVoice,
    }),
  };

  const aiSettings = {
    get: jest.fn(async () => {
      if (options.settingsThrows) throw new Error('stored settings are invalid');

      return {
        models: {
          speak:
            options.speakModel === undefined ? 'gpt-4o-mini-tts' : options.speakModel,
        },
      };
    }),
  };

  const civics = {
    getQuestion: jest.fn(async () => {
      if (options.question instanceof Error) throw options.question;

      return questionDetail(options.question ?? {});
    }),
  };

  const userSettings = {
    readVoicePreferences: jest.fn(async () =>
      options.preferredVoice === undefined
        ? undefined
        : { preferredVoice: options.preferredVoice },
    ),
  };

  const asset = {
    findUnique: jest.fn().mockResolvedValue(options.existingAsset ?? null),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (options.createThrows) throw options.createThrows;

      return { id: 'asset-1', ...data };
    }),
  };

  const storage = {
    upload: jest.fn(async (key: string, stream: Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      objects.set(key, Buffer.concat(chunks));
      return { key, bucket: 'test', location: `memory://${key}` };
    }),
    download: jest.fn(async (key: string) => {
      const found = objects.get(key);
      if (!found) throw new Error(`no object at ${key}`);
      return Readable.from(found);
    }),
  };

  const service = new SpeechAudioService(
    { speechAudioAsset: asset } as unknown as PrismaService,
    dispatch as unknown as AiDispatchService,
    aiSettings as unknown as AiSettingsService,
    civics as unknown as CivicsService,
    userSettings as unknown as UserSettingsService,
    storage as unknown as StorageProvider,
  );

  return { service, dispatch, storage, asset, objects };
}

const questionQuery = {
  scope: 'civics_question' as const,
  refId: QUESTION_ID,
};

const answerQuery = { scope: 'civics_answer' as const, refId: QUESTION_ID };

describe('SpeechAudioService', () => {
  describe('what gets read aloud', () => {
    it('synthesizes the question prompt, which the caller never sent', async () => {
      const { service, dispatch } = harness();

      const result = await service.getCivicsAudio(ALICE, questionQuery);

      expect(result.status).toBe('ok');
      expect(dispatch.synthesize).toHaveBeenCalledWith(
        ALICE,
        expect.objectContaining({ text: PROMPT }),
      );
    });

    it('synthesizes only the FIRST accepted answer', async () => {
      // Three simultaneously-correct answers; one of them is a pass, and
      // reading the list aloud would be a paragraph nobody asked to hear.
      const { service, dispatch } = harness();

      await service.getCivicsAudio(ALICE, answerQuery);

      expect(dispatch.synthesize).toHaveBeenCalledWith(
        ALICE,
        expect.objectContaining({ text: FIRST_ANSWER }),
      );
    });

    it('reports state_required for an unresolvable answer, and synthesizes nothing', async () => {
      const { service, dispatch, asset, storage } = harness({
        question: { dynamicScope: 'state', answerResolution: 'state_required', answers: [] },
      });

      const result = await service.getCivicsAudio(ALICE, answerQuery);

      expect(result).toEqual({ status: 'state_required' });
      expect(dispatch.synthesize).not.toHaveBeenCalled();
      expect(asset.create).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('still reads the QUESTION aloud when the answer is unresolvable', async () => {
      // The prompt is not state-specific. Refusing it too would withhold
      // something this application can perfectly well say.
      const { service, dispatch } = harness({
        question: { dynamicScope: 'state', answerResolution: 'state_required', answers: [] },
      });

      const result = await service.getCivicsAudio(ALICE, questionQuery);

      expect(result.status).toBe('ok');
      expect(dispatch.synthesize).toHaveBeenCalled();
    });

    it('lets an unknown question id stay a 404', async () => {
      // NOT converted into a `status` member: "that question does not exist" is
      // a different problem, with a different owner, than "AI is not set up".
      const { service } = harness({
        question: new NotFoundException('Civics question "x" not found'),
      });

      await expect(service.getCivicsAudio(ALICE, questionQuery)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('fails rather than crashing when there is no open answer row', async () => {
      const { service, dispatch } = harness({ question: { answers: [] } });

      const result = await service.getCivicsAudio(ALICE, answerQuery);

      expect(result).toMatchObject({ status: 'failed', errorCode: 'no_resolved_text' });
      expect(dispatch.synthesize).not.toHaveBeenCalled();
    });

    it('fails rather than paying for text past the shared character cap', async () => {
      // THE SAME CAP the synthesis route applies, not a second number: TTS is
      // billed per character, and "it came from our own database" is a reason
      // to trust the text, not to stop bounding it.
      const { service, dispatch } = harness({
        question: { prompt: 'a'.repeat(MAX_SYNTHESIS_TEXT_LENGTH + 1) },
      });

      const result = await service.getCivicsAudio(ALICE, questionQuery);

      expect(result).toMatchObject({ status: 'failed', errorCode: 'text_too_long' });
      expect(dispatch.synthesize).not.toHaveBeenCalled();
    });
  });

  describe('the cache key', () => {
    it('hashes the exact text and names every part of the key in the object path', async () => {
      const { service, asset } = harness();

      await service.getCivicsAudio(ALICE, questionQuery);

      expect(asset.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            scope_refId_voice_modelId_format_contentSha256: {
              scope: 'civics_question',
              refId: QUESTION_ID,
              voice: 'alloy',
              modelId: 'gpt-4o-mini-tts',
              format: 'mp3',
              contentSha256: sha(PROMPT),
            },
          },
        }),
      );

      const { data } = asset.create.mock.calls[0][0];
      expect(data.storageKey).toBe(
        `${SPEECH_AUDIO_KEY_PREFIX}/civics_question/${QUESTION_ID}/alloy/gpt-4o-mini-tts/${sha(
          PROMPT,
        )}.mp3`,
      );
      // Attribution, not ownership: nothing reads this to decide who may listen.
      expect(data.generatedByUserId).toBe(ALICE);
      expect(data.byteSize).toBe(AUDIO.length);
      expect(data.charCount).toBe(PROMPT.length);
    });

    it('keys a different voice to a different row', async () => {
      const { service, asset } = harness();

      await service.getCivicsAudio(ALICE, { ...questionQuery, voice: 'nova' });

      const where =
        asset.findUnique.mock.calls[0][0].where
          .scope_refId_voice_modelId_format_contentSha256;
      expect(where.voice).toBe('nova');
    });

    it('prefers the request, then the learner`s own setting, then the provider default', async () => {
      const requested = harness({ preferredVoice: 'saved' });
      await requested.service.getCivicsAudio(ALICE, {
        ...questionQuery,
        voice: 'asked',
      });
      expect(
        requested.asset.findUnique.mock.calls[0][0].where
          .scope_refId_voice_modelId_format_contentSha256.voice,
      ).toBe('asked');

      const saved = harness({ preferredVoice: 'saved' });
      await saved.service.getCivicsAudio(ALICE, questionQuery);
      expect(
        saved.asset.findUnique.mock.calls[0][0].where
          .scope_refId_voice_modelId_format_contentSha256.voice,
      ).toBe('saved');

      const fallback = harness();
      await fallback.service.getCivicsAudio(ALICE, questionQuery);
      expect(
        fallback.asset.findUnique.mock.calls[0][0].where
          .scope_refId_voice_modelId_format_contentSha256.voice,
      ).toBe('alloy');
    });

    it('does not look up or store anything when there is no voice to key on', async () => {
      // A provider with no text-to-speech at all. Inventing a placeholder voice
      // would key a row nothing could ever match again — and would be sent to a
      // provider as an id it does not know.
      const { service, asset, dispatch } = harness({ defaultVoice: null });

      await service.getCivicsAudio(ALICE, questionQuery);

      expect(asset.findUnique).not.toHaveBeenCalled();
      expect(asset.create).not.toHaveBeenCalled();
      expect(dispatch.synthesize).toHaveBeenCalled();
    });

    it('does not look up or store anything when `speak` is unbound', async () => {
      const { service, asset, dispatch } = harness({ speakModel: null });
      dispatch.synthesize.mockResolvedValue({
        status: 'unavailable',
        cause: 'role_unbound',
      });

      const result = await service.getCivicsAudio(ALICE, questionQuery);

      expect(result).toEqual({
        status: 'unavailable',
        cause: 'role_unbound',
        role: 'speak',
      });
      expect(asset.findUnique).not.toHaveBeenCalled();
      expect(asset.create).not.toHaveBeenCalled();
    });

    it('survives an unreadable settings row without throwing', async () => {
      const { service, dispatch } = harness({ settingsThrows: true });
      dispatch.synthesize.mockResolvedValue({
        status: 'failed',
        errorCode: 'settings_invalid',
        error: 'Stored AI settings are invalid.',
      });

      const result = await service.getCivicsAudio(ALICE, questionQuery);

      expect(result).toMatchObject({ status: 'failed' });
    });
  });

  describe('a hit spends nothing', () => {
    it('serves stored bytes with no dispatch call at all', async () => {
      const { service, dispatch, storage, asset, objects } = harness();

      // Fill the cache the way the first request would.
      await service.getCivicsAudio(ALICE, questionQuery);
      const [storedKey] = [...objects.keys()];

      const second = harness({ existingAsset: { storageKey: storedKey } });
      // The second harness starts with an empty object store; seed it with the
      // first one's bytes, which is the state storage would really be in.
      second.objects.set(storedKey, objects.get(storedKey)!);

      const result = await second.service.getCivicsAudio(BOB, questionQuery);

      expect(result).toMatchObject({ status: 'ok', cacheHit: true });
      expect(result.status === 'ok' && result.audio).toEqual(AUDIO);
      // NOBODY'S KEY WAS TOUCHED. The integration suite asserts the stronger
      // version of this — no `ai_usage_events` row — below the dispatcher.
      expect(second.dispatch.synthesize).not.toHaveBeenCalled();
      expect(second.asset.create).not.toHaveBeenCalled();

      expect(dispatch.synthesize).toHaveBeenCalledTimes(1);
      expect(storage.upload).toHaveBeenCalledTimes(1);
    });

    it('re-synthesizes when the row survives but its object does not', async () => {
      // A bucket emptied by hand. Failing the request over a state this service
      // can repair would be worse than paying for one call.
      const { service, dispatch, asset } = harness({
        existingAsset: { storageKey: 'speech/civics/gone' },
      });

      const result = await service.getCivicsAudio(ALICE, questionQuery);

      expect(result).toMatchObject({ status: 'ok', cacheHit: false });
      expect(dispatch.synthesize).toHaveBeenCalled();
      // The row is already there — repaired, not duplicated.
      expect(asset.create).not.toHaveBeenCalled();
    });
  });

  describe('a refusal leaves nothing behind', () => {
    it('writes no row and no object for an `unavailable` synthesis', async () => {
      const { service, asset, storage } = harness({
        synthesis: { status: 'unavailable', cause: 'no_user_key' },
      });

      const result = await service.getCivicsAudio(ALICE, questionQuery);

      expect(result).toEqual({
        status: 'unavailable',
        cause: 'no_user_key',
        role: 'speak',
      });
      expect(asset.create).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('writes no row and no object for a `failed` synthesis', async () => {
      const { service, asset, storage } = harness({
        synthesis: {
          status: 'failed',
          errorCode: 'rate_limited',
          error: 'Too many requests.',
        },
      });

      const result = await service.getCivicsAudio(ALICE, questionQuery);

      expect(result).toEqual({
        status: 'failed',
        errorCode: 'rate_limited',
        error: 'Too many requests.',
      });
      expect(asset.create).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('writes no row when the upload itself fails', async () => {
      const { service, storage, asset } = harness();
      storage.upload.mockRejectedValue(new Error('bucket unreachable'));

      const result = await service.getCivicsAudio(ALICE, questionQuery);

      // The learner still hears their question; the cache simply misses again
      // next time, which is where the deployment already was.
      expect(result).toMatchObject({ status: 'ok' });
      // A row pointing at bytes that were never written would make every later
      // request pay for a failed download first.
      expect(asset.create).not.toHaveBeenCalled();
    });
  });

  describe('the double-miss race', () => {
    it('serves the loser its audio instead of failing the request', async () => {
      const { service, asset } = harness({
        createThrows: new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          { code: 'P2002', clientVersion: 'test' },
        ),
      });

      const result = await service.getCivicsAudio(ALICE, questionQuery);

      // The synthesis was paid for either way. Failing on top of that would
      // take the learner's money and their question.
      expect(result).toMatchObject({ status: 'ok' });
      expect(result.status === 'ok' && result.audio).toEqual(AUDIO);
      expect(asset.create).toHaveBeenCalledTimes(1);
    });

    it('still answers when the insert fails for some other reason', async () => {
      const { service } = harness({ createThrows: new Error('connection lost') });

      const result = await service.getCivicsAudio(ALICE, questionQuery);

      expect(result).toMatchObject({ status: 'ok' });
    });
  });

  describe('cache lifetime', () => {
    it('lets a fixed prompt in a NAMED voice be held for a long time', async () => {
      const { service } = harness();

      const result = await service.getCivicsAudio(ALICE, {
        ...questionQuery,
        voice: 'alloy',
      });

      expect(result.status === 'ok' && result.maxAgeSeconds).toBeGreaterThan(
        60 * 60 * 24,
      );
    });

    it('keeps a correctable answer short-lived in a browser cache', async () => {
      // The server-side key is content-addressed and can never serve a
      // superseded answer; a BROWSER cache is keyed by URL, and this URL names
      // a question rather than a hash.
      const { service } = harness({ question: { dynamicScope: 'national' } });

      const result = await service.getCivicsAudio(ALICE, {
        ...answerQuery,
        voice: 'alloy',
      });

      expect(result.status === 'ok' && result.maxAgeSeconds).toBeLessThanOrEqual(
        60 * 60,
      );
    });

    it('keeps an UNNAMED voice short-lived too, even for a fixed prompt', async () => {
      // Without `voice` the URL resolves through the learner's own setting, so
      // it does not determine the bytes: a learner who changes their voice
      // would keep hearing the old one out of their own cache.
      const { service } = harness({ preferredVoice: 'saved' });

      const result = await service.getCivicsAudio(ALICE, questionQuery);

      expect(result.status === 'ok' && result.maxAgeSeconds).toBeLessThanOrEqual(
        60 * 60,
      );
    });
  });
});

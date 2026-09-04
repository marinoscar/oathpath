import { BadRequestException, Logger } from '@nestjs/common';

import type { AiDispatchService } from './ai-dispatch.service';
import {
  AiSpeechService,
  MAX_AUDIO_BYTES_PER_SECOND,
  MAX_TRANSCRIBE_AUDIO_BYTES,
  MAX_TRANSCRIBE_BYTES,
  MAX_TRANSCRIBE_SECONDS,
} from './ai-speech.service';
import type { TranscribeUpload } from './ai-speech.service';
import type { AiUsage } from './ai.types';

// =============================================================================
// AiSpeechService — tests (issue #95, epic #58)
// =============================================================================
//
// One property carries most of this file: EVERY REFUSAL HAPPENS BEFORE THE
// DISPATCHER IS TOUCHED. A cap that runs after the call is a receipt, not a
// cap, and the assertion that proves the difference is not on the status code
// — it is `expect(dispatch.transcribe).not.toHaveBeenCalled()`, on a learner's
// own key that was never spent.
//
// The rest is the mapping from the dispatcher's three-way result to the wire
// shape, including the two places the shape is deliberately narrow: an `ok`
// transcription carries `text` and `confidence` and nothing else, and a `null`
// confidence survives the trip as `null`.
// =============================================================================

const ALICE = '11111111-1111-4111-8111-111111111111';

const SPEECH_USAGE: AiUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
};

function dispatchDouble(overrides: Partial<AiDispatchService> = {}) {
  return {
    transcribe: jest.fn().mockResolvedValue({
      status: 'ok',
      text: 'the president',
      confidence: 0.92,
      usage: SPEECH_USAGE,
      modelId: 'gpt-4o-transcribe',
    }),
    synthesize: jest.fn().mockResolvedValue({
      status: 'ok',
      audio: Buffer.from([1, 2, 3]),
      contentType: 'audio/mpeg',
      usage: SPEECH_USAGE,
      modelId: 'gpt-4o-mini-tts',
    }),
    ...overrides,
  } as unknown as AiDispatchService;
}

function build(overrides: Partial<AiDispatchService> = {}) {
  const dispatch = dispatchDouble(overrides);

  return { service: new AiSpeechService(dispatch), dispatch };
}

function upload(over: Partial<TranscribeUpload> = {}): TranscribeUpload {
  return {
    audio: Buffer.from('fake webm bytes'),
    contentType: 'audio/webm',
    fileName: 'recording.webm',
    ...over,
  };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

describe('AiSpeechService — the caps are checked before any provider call', () => {
  it('refuses an empty recording without dispatching', async () => {
    const { service, dispatch } = build();

    await expect(
      service.transcribe(ALICE, upload({ audio: Buffer.alloc(0) })),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(dispatch.transcribe).not.toHaveBeenCalled();
  });

  it('refuses an over-long recording without dispatching', async () => {
    // One byte past the duration bound. Nothing here decodes the audio — see
    // MAX_AUDIO_BYTES_PER_SECOND — so this asserts the arithmetic that stands
    // in for a decode, not a measurement.
    const { service, dispatch } = build();

    await expect(
      service.transcribe(
        ALICE,
        upload({ audio: Buffer.alloc(MAX_TRANSCRIBE_AUDIO_BYTES + 1) }),
      ),
    ).rejects.toThrow(new RegExp(`${MAX_TRANSCRIBE_SECONDS} seconds or less`));

    expect(dispatch.transcribe).not.toHaveBeenCalled();
  });

  it('accepts a recording exactly at the duration bound', async () => {
    // The boundary belongs to the caller, not to the cap: `> limit` and
    // `>= limit` differ by one legitimate request, and the test says which.
    const { service, dispatch } = build();

    await service.transcribe(
      ALICE,
      upload({ audio: Buffer.alloc(MAX_TRANSCRIBE_AUDIO_BYTES) }),
    );

    expect(dispatch.transcribe).toHaveBeenCalled();
  });

  it('refuses a client-declared duration over the cap without weighing the bytes', async () => {
    // A tiny file that admits to three minutes is refused on its own claim: a
    // hint can only make a request MORE restricted.
    const { service, dispatch } = build();

    await expect(
      service.transcribe(
        ALICE,
        upload({ declaredDurationSeconds: MAX_TRANSCRIBE_SECONDS + 1 }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(dispatch.transcribe).not.toHaveBeenCalled();
  });

  it('does not let a small declared duration excuse an over-long upload', async () => {
    // The other direction, which is the one that matters: if a declared `1`
    // could waive the byte bound, the duration cap would be a form field.
    const { service, dispatch } = build();

    await expect(
      service.transcribe(
        ALICE,
        upload({
          audio: Buffer.alloc(MAX_TRANSCRIBE_AUDIO_BYTES + 1),
          declaredDurationSeconds: 1,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(dispatch.transcribe).not.toHaveBeenCalled();
  });

  it('refuses a content type that is not audio without dispatching', async () => {
    const { service, dispatch } = build();

    await expect(
      service.transcribe(ALICE, upload({ contentType: 'application/pdf' })),
    ).rejects.toThrow(/Unsupported audio content type/);

    expect(dispatch.transcribe).not.toHaveBeenCalled();
  });

  it('accepts a browser recording that carries codec parameters', async () => {
    // `MediaRecorder` sends `audio/webm;codecs=opus`. An allowlist compared
    // against the raw header would reject the single most likely real request
    // this endpoint ever receives.
    const { service, dispatch } = build();

    await service.transcribe(
      ALICE,
      upload({ contentType: 'audio/webm;codecs=opus' }),
    );

    expect(dispatch.transcribe).toHaveBeenCalledWith(
      ALICE,
      expect.objectContaining({ contentType: 'audio/webm' }),
    );
  });

  it('keeps the byte cap and the duration cap as separate, ordered rules', () => {
    // Both are real and the tighter one binds. If the derived bound ever rose
    // above the parser's byte cap, the duration rule would become unreachable
    // and this test would say so before a reviewer had to notice.
    expect(MAX_TRANSCRIBE_AUDIO_BYTES).toBe(
      MAX_TRANSCRIBE_SECONDS * MAX_AUDIO_BYTES_PER_SECOND,
    );
    expect(MAX_TRANSCRIBE_AUDIO_BYTES).toBeLessThanOrEqual(MAX_TRANSCRIBE_BYTES);
  });
});

describe('AiSpeechService — transcription responses', () => {
  it('returns the transcript and the confidence, and nothing else', async () => {
    // `toEqual`, not `toMatchObject`: the assertion is about what is ABSENT.
    // No model id, no usage, no usage-event id — `voice.md` §9.
    const { service } = build();

    expect(await service.transcribe(ALICE, upload())).toEqual({
      status: 'ok',
      text: 'the president',
      confidence: 0.92,
    });
  });

  it('passes a null confidence through as null', async () => {
    const { service } = build({
      transcribe: jest.fn().mockResolvedValue({
        status: 'ok',
        text: 'the president',
        confidence: null,
        usage: SPEECH_USAGE,
        modelId: 'gpt-4o-transcribe',
      }),
    } as unknown as Partial<AiDispatchService>);

    expect(await service.transcribe(ALICE, upload())).toEqual({
      status: 'ok',
      text: 'the president',
      confidence: null,
    });
  });

  it.each([
    'no_user_key',
    'ai_disabled',
    'role_unbound',
    'capability_unsupported',
  ] as const)('returns a typed payload naming the role for %s', async (cause) => {
    // A VALUE, NOT AN EXCEPTION, for each of the four — so the web can render
    // "voice is not set up here" instead of a spinner or a generic error.
    const { service } = build({
      transcribe: jest.fn().mockResolvedValue({ status: 'unavailable', cause }),
    } as unknown as Partial<AiDispatchService>);

    await expect(service.transcribe(ALICE, upload())).resolves.toEqual({
      status: 'unavailable',
      cause,
      role: 'transcribe',
    });
  });

  it('reports a provider failure as failed, distinctly from unavailable', async () => {
    const { service } = build({
      transcribe: jest.fn().mockResolvedValue({
        status: 'failed',
        errorCode: 'rate_limited',
        error: 'Too many requests.',
        usageEventId: null,
        modelId: 'gpt-4o-transcribe',
      }),
    } as unknown as Partial<AiDispatchService>);

    expect(await service.transcribe(ALICE, upload())).toEqual({
      status: 'failed',
      errorCode: 'rate_limited',
      error: 'Too many requests.',
    });
  });

  it('hands the dispatcher the audio and no model id', async () => {
    // The one-door rule at this call site: a caller that could name a model
    // could bind itself to whatever the admin configured for a costlier role.
    const { service, dispatch } = build();
    const audio = Buffer.from('bytes');

    await service.transcribe(
      ALICE,
      upload({ audio, languageHint: 'en', fileName: 'answer.webm' }),
    );

    expect(dispatch.transcribe).toHaveBeenCalledWith(ALICE, {
      audio,
      contentType: 'audio/webm',
      fileName: 'answer.webm',
      languageHint: 'en',
    });
  });
});

describe('AiSpeechService — synthesis responses', () => {
  it('returns the bytes and the provider`s own content type', async () => {
    const { service } = build();

    expect(await service.synthesize(ALICE, { text: 'Hello' })).toEqual({
      status: 'ok',
      audio: Buffer.from([1, 2, 3]),
      contentType: 'audio/mpeg',
    });
  });

  it.each([
    'no_user_key',
    'ai_disabled',
    'role_unbound',
    'capability_unsupported',
  ] as const)('returns a typed payload naming the speak role for %s', async (cause) => {
    const { service } = build({
      synthesize: jest.fn().mockResolvedValue({ status: 'unavailable', cause }),
    } as unknown as Partial<AiDispatchService>);

    await expect(service.synthesize(ALICE, { text: 'Hello' })).resolves.toEqual({
      status: 'unavailable',
      cause,
      role: 'speak',
    });
  });

  it('passes the voice and format through and names no model', async () => {
    const { service, dispatch } = build();

    await service.synthesize(ALICE, {
      text: 'Who is the President?',
      voice: 'alloy',
      format: 'mp3',
    });

    expect(dispatch.synthesize).toHaveBeenCalledWith(ALICE, {
      text: 'Who is the President?',
      voice: 'alloy',
      format: 'mp3',
    });
  });
});

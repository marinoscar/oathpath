/**
 * `transcribeAudio` / `synthesizeSpeech` — issue #99, epic #58 / E9.
 *
 * Three things here are load-bearing and all three fail QUIETLY when they
 * break, which is why each has a test of its own:
 *
 *   1. A `FormData` body must carry NO `Content-Type`. Only the browser knows
 *      the multipart boundary it generated, and it fills the header in only
 *      when one is not already set. `ApiService.request` sets
 *      `application/json` on every body it sees, so without the affordance
 *      added for this endpoint the upload arrives as a body no server can
 *      parse — reported at the other end as a missing field rather than as the
 *      header problem it is.
 *   2. That body has to survive the 401-refresh-and-retry, which every long
 *      session eventually takes. The retry used to build its headers from a
 *      second hand-written literal that hard-coded the JSON content type.
 *   3. `confidence: null` must arrive as `null`. A consumer that reads it as
 *      `0` marks a perfectly good answer `misheard` — see `SpeechTranscription`.
 */

import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { server } from '../mocks/server';
import {
  api,
  defaultAudioFileName,
  synthesizeSpeech,
  transcribeAudio,
} from '../../services/api';

function recording(type = 'audio/webm'): Blob {
  return new Blob(['pretend-opus-bytes'], { type });
}

/**
 * `instanceof Blob` IS THE WRONG TEST HERE, and quietly so.
 *
 * The request MSW hands a handler is built in undici's realm, whose `Blob` and
 * `File` are different constructors from the jsdom globals this suite sees — so
 * a perfectly good file part fails `instanceof` and the assertion "the audio
 * arrived" reads as "it did not". Duck-type instead.
 */
function isBlobLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Blob).size === 'number' &&
    typeof (value as Blob).arrayBuffer === 'function'
  );
}

beforeEach(() => api.setAccessToken(null));
afterEach(() => api.setAccessToken(null));

describe('transcribeAudio', () => {
  it('posts multipart, and never overrides the browser\'s content type', async () => {
    let contentType: string | null = 'unset';
    let filePresent = false;

    server.use(
      http.post('*/api/ai/speech/transcribe', async ({ request }) => {
        contentType = request.headers.get('content-type');
        const form = await request.formData();
        filePresent = isBlobLike(form.get('audio'));
        return HttpResponse.json({ data: { text: 'George Washington', confidence: 0.94 } });
      }),
    );

    const result = await transcribeAudio(recording());

    expect(result).toEqual({ text: 'George Washington', confidence: 0.94 });
    // The boundary is the whole point: `application/json` here is unparseable.
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(filePresent).toBe(true);
  });

  it('names the part after the blob\'s own type, so a provider can decode it', () => {
    // Asserted on the helper rather than through a round trip: this test stack
    // re-creates the multipart body across realms (jsdom's `FormData`, undici's
    // serializer) and loses the per-part filename on the way, so a round-trip
    // assertion here would be testing the harness, not the code.
    //
    // Safari records mp4. A fixed `answer.webm` over one is rejected as a
    // corrupt webm — a failure that reads as "your recording was bad" on the
    // one browser where nothing was wrong with it.
    expect(defaultAudioFileName(new Blob([], { type: 'audio/mp4' }))).toBe('answer.mp4');
    expect(
      defaultAudioFileName(new Blob([], { type: 'audio/webm;codecs=opus' })),
    ).toBe('answer.webm');
    expect(defaultAudioFileName(new Blob([], { type: 'audio/mpeg' }))).toBe('answer.mp3');
    // An unrecognised (or absent) type still has to produce a usable name.
    expect(defaultAudioFileName(new Blob([]))).toBe('answer.webm');
  });

  it('keeps `confidence: null` as null — UNKNOWN IS NOT ZERO', async () => {
    server.use(
      http.post('*/api/ai/speech/transcribe', () =>
        HttpResponse.json({ data: { text: 'the president', confidence: null } }),
      ),
    );

    const result = await transcribeAudio(recording());

    expect(result.confidence).toBeNull();
    expect(result.confidence).not.toBe(0);
  });

  it('survives the 401 refresh-and-retry with its file intact', async () => {
    // The ordinary case after fifteen idle minutes, and the one where a
    // hand-written retry header set would send JSON's content type over
    // multipart.
    let attempts = 0;
    let retryContentType: string | null = null;
    let retryHadFile = false;

    server.use(
      http.post('*/api/auth/refresh', () =>
        HttpResponse.json({ data: { accessToken: 'fresh-token' } }),
      ),
      http.post('*/api/ai/speech/transcribe', async ({ request }) => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json({ message: 'Unauthorized' }, { status: 401 });
        }
        retryContentType = request.headers.get('content-type');
        retryHadFile = isBlobLike((await request.formData()).get('audio'));
        return HttpResponse.json({ data: { text: 'retried', confidence: null } });
      }),
    );

    api.setAccessToken('expired-token');
    const result = await transcribeAudio(recording());

    expect(attempts).toBe(2);
    expect(result.text).toBe('retried');
    expect(retryContentType).toMatch(/^multipart\/form-data; boundary=/);
    // A `FormData` is re-serialized per send, so the second attempt carries the
    // same audio. (A raw stream body could not — which is why none is used.)
    expect(retryHadFile).toBe(true);
  });
});

describe('synthesizeSpeech', () => {
  it('returns bytes, not a JSON envelope', async () => {
    server.use(
      http.post('*/api/ai/speech/synthesize', async ({ request }) => {
        expect(await request.json()).toEqual({ text: 'Hello' });
        return HttpResponse.arrayBuffer(new ArrayBuffer(16), {
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      }),
    );

    const blob = await synthesizeSpeech('Hello');

    expect(isBlobLike(blob)).toBe(true);
    expect(blob.size).toBe(16);
    expect(blob.type).toBe('audio/mpeg');
  });

  it('rejects when `speak` is unbound, for the caller to shrug off', async () => {
    server.use(
      http.post('*/api/ai/speech/synthesize', () =>
        HttpResponse.json({ message: 'Not available' }, { status: 404 }),
      ),
    );

    // A 404-shaped "not available", never a 500 — voice.md §9. `QuestionAudio`
    // treats this as "use the browser voice" and shows nobody anything.
    await expect(synthesizeSpeech('Hello')).rejects.toMatchObject({ status: 404 });
  });
});

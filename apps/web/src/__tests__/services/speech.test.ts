/**
 * `transcribeAudio` / `synthesizeSpeech` — issue #99, epic #58 / E9; the
 * `status`-union contract fixed by issue #277.
 *
 * Four things here are load-bearing and all four fail QUIETLY when they
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
 *      `0` marks a perfectly good answer `misheard` — see
 *      `SpeechTranscriptionOk`.
 *   4. BOTH ROUTES ANSWER A `status` UNION, ALWAYS AT HTTP 200 — `ok`,
 *      `unavailable`, `failed` — and neither promise ever rejects for one of
 *      those causes. Issue #277: every fixture in this file used to encode
 *      `{ data: { text, confidence } }` with no `status` at all, which is not
 *      what the API sends and is why the suite never caught the web client
 *      reading `text` unconditionally and crashing on `.trim()` for any
 *      non-`ok` result. The regression test below asserts directly against
 *      that shape: a non-`ok` member must carry no `text` property, because
 *      `text` being `undefined` is exactly what broke.
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
import type { TranscribeResponse } from '../../types';

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
        return HttpResponse.json({
          data: { status: 'ok', text: 'George Washington', confidence: 0.94 },
        });
      }),
    );

    const result = await transcribeAudio(recording());

    expect(result).toEqual({ status: 'ok', text: 'George Washington', confidence: 0.94 });
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
        HttpResponse.json({
          data: { status: 'ok', text: 'the president', confidence: null },
        }),
      ),
    );

    const result = await transcribeAudio(recording());

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
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
        return HttpResponse.json({
          data: { status: 'ok', text: 'retried', confidence: null },
        });
      }),
    );

    api.setAccessToken('expired-token');
    const result = await transcribeAudio(recording());

    expect(attempts).toBe(2);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.text).toBe('retried');
    expect(retryContentType).toMatch(/^multipart\/form-data; boundary=/);
    // A `FormData` is re-serialized per send, so the second attempt carries the
    // same audio. (A raw stream body could not — which is why none is used.)
    expect(retryHadFile).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // The two non-`ok` members — both HTTP 200, and the regression test.
  // ---------------------------------------------------------------------------

  it('resolves (never rejects) to `unavailable`, with `cause` and `role` intact', async () => {
    server.use(
      http.post('*/api/ai/speech/transcribe', () =>
        HttpResponse.json({
          data: { status: 'unavailable', cause: 'role_unbound', role: 'transcribe' },
        }),
      ),
    );

    const result = await transcribeAudio(recording());

    expect(result).toEqual({
      status: 'unavailable',
      cause: 'role_unbound',
      role: 'transcribe',
    });
  });

  it('resolves (never rejects) to `failed`, with `errorCode` and `error` intact', async () => {
    server.use(
      http.post('*/api/ai/speech/transcribe', () =>
        HttpResponse.json({
          data: {
            status: 'failed',
            errorCode: 'provider_timeout',
            error: 'upstream request to the provider timed out',
          },
        }),
      ),
    );

    const result = await transcribeAudio(recording());

    expect(result).toEqual({
      status: 'failed',
      errorCode: 'provider_timeout',
      error: 'upstream request to the provider timed out',
    });
  });

  it.each([
    ['unavailable', { status: 'unavailable', cause: 'role_unbound', role: 'transcribe' }],
    ['failed', { status: 'failed', errorCode: 'provider_timeout', error: 'timed out' }],
  ] as const)(
    'THE REGRESSION TEST — a %s result carries no `text` property at all',
    async (_label, body) => {
      // This is the exact shape whose `undefined` `text` a caller used to run
      // `.trim()` on, throwing `TypeError: Cannot read properties of undefined
      // (reading 'trim')` in front of a learner (issue #277). Asserted against
      // the union itself, not against a page, so it fails here first.
      server.use(
        http.post('*/api/ai/speech/transcribe', () => HttpResponse.json({ data: body })),
      );

      const result: TranscribeResponse = await transcribeAudio(recording());

      expect(result.status).not.toBe('ok');
      expect('text' in result).toBe(false);
      expect((result as { text?: unknown }).text).toBeUndefined();
    },
  );
});

describe('synthesizeSpeech', () => {
  it('returns `{status: "ok", audio}`, not a bare blob', async () => {
    server.use(
      http.post('*/api/ai/speech/synthesize', async ({ request }) => {
        expect(await request.json()).toEqual({ text: 'Hello' });
        return HttpResponse.arrayBuffer(new ArrayBuffer(16), {
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      }),
    );

    const result = await synthesizeSpeech('Hello');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(isBlobLike(result.audio)).toBe(true);
    expect(result.audio.size).toBe(16);
    expect(result.audio.type).toBe('audio/mpeg');
  });

  it('resolves — never rejects — a 200 JSON `unavailable` body to the `unavailable` member', async () => {
    // A `speak`-unbound deployment is HTTP 200 with `application/json`, told
    // apart from a real audio success only by `Content-Type` — voice.md §9.
    // The earlier version of this test asserted the WRONG contract (a
    // rejected promise on a 404); issue #277 is that assertion, corrected.
    server.use(
      http.post('*/api/ai/speech/synthesize', () =>
        HttpResponse.json({
          data: { status: 'unavailable', cause: 'role_unbound', role: 'speak' },
        }),
      ),
    );

    const result = await synthesizeSpeech('Hello');

    expect(result).toEqual({ status: 'unavailable', cause: 'role_unbound', role: 'speak' });
  });

  it('resolves a malformed/non-JSON-parseable body to `failed`, never throwing', async () => {
    // Not valid JSON at all, but still labelled `application/json` — the
    // defensive branch `parseSynthesisEnvelope` exists for. Nothing in
    // `synthesizeSpeech` may throw for an AI reason; every caller treats any
    // non-`ok` member the same way (fall back to the browser voice).
    server.use(
      http.post('*/api/ai/speech/synthesize', () =>
        HttpResponse.text('not actually json', {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const result = await synthesizeSpeech('Hello');

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.errorCode).toBe('malformed_response');
  });

  it('still REJECTS with `ApiError` on a genuine non-2xx transport failure', async () => {
    server.use(
      http.post('*/api/ai/speech/synthesize', () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
      ),
    );

    await expect(synthesizeSpeech('Hello')).rejects.toMatchObject({ status: 401 });
  });
});

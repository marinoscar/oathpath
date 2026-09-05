/**
 * `useVoicePrefs` — the `voice` namespace, resolved (#288, epic #280).
 *
 * TWO CLAIMS, and both are load-bearing:
 *
 *   1. A STORED VALUE IS HONOURED, and an absent one resolves to the built-in
 *      default WITHOUT being written back. `voice` deliberately ships with no
 *      `.default()` on the server, so a client that materialises today's
 *      defaults pins a learner to them forever — see the namespace's own
 *      header. The absence of a PATCH is therefore an assertion here, not an
 *      omission.
 *   2. A VALUE THIS BUILD WILL NOT HONOUR FALLS BACK. The namespace comes out
 *      of a user-writable JSONB column, so a `speechRate` of `12` or a
 *      `preferredVoice` of `"; DROP"` is reachable — and a `NaN` reaching
 *      `utterance.rate` is unintelligible audio rather than a preference.
 *
 * `useUserSettings` is REAL, and `GET /api/user-settings` is a recorded MSW
 * handler, because the point of this hook is that it reads the SAME document
 * the rest of the app reads rather than fetching its own.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import {
  DEFAULT_VOICE_CONVERSATION_MODE,
  DEFAULT_VOICE_SPEECH_RATE,
  resolveVoicePreferences,
  useVoicePrefs,
} from '../../hooks/useVoicePrefs';
import type { UserSettings } from '../../types';

const API_BASE = '*/api';

let patchCount: number;

function mockSettings(voice?: UserSettings['voice']) {
  patchCount = 0;
  const stored: UserSettings = {
    theme: 'system',
    profile: { useProviderImage: true },
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
    ...(voice ? { voice } : {}),
  };

  server.use(
    http.get(`${API_BASE}/user-settings`, () => HttpResponse.json({ data: stored })),
    http.patch(`${API_BASE}/user-settings`, () => {
      patchCount += 1;
      return HttpResponse.json({ data: stored });
    }),
  );
}

describe('useVoicePrefs (#288)', () => {
  beforeEach(() => {
    mockSettings();
  });

  it('resolves the built-in defaults for an untouched account, and writes nothing', async () => {
    // NO `ThemeContextProvider` ANYWHERE IN THIS TEST, deliberately: the hook
    // opts out of theme syncing precisely so a practice screen can mount it
    // without carrying theme chrome it has no other use for. If that opt-out
    // regressed, this render would throw rather than merely disagree.
    const { result } = renderHook(() => useVoicePrefs());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.voice).toEqual({
      autoSubmitSpoken: true,
      preferPremiumVoice: true,
      preferredVoice: undefined,
      speechRate: DEFAULT_VOICE_SPEECH_RATE,
      readQuestionsAloud: false,
      readAnswersAloud: false,
      conversationMode: false,
    });
    expect(DEFAULT_VOICE_SPEECH_RATE).toBe(0.95);
    // Hands-free Voice mode is opt-in (#307, epic #304), exactly as autoplay
    // is — and, like every default here, resolved rather than written back.
    expect(DEFAULT_VOICE_CONVERSATION_MODE).toBe(false);
    expect(patchCount).toBe(0);
  });

  it('honours a stored preferredVoice and speechRate', async () => {
    mockSettings({ preferredVoice: 'nova', speechRate: 1.4 });

    const { result } = renderHook(() => useVoicePrefs());
    await waitFor(() => expect(result.current.voice.preferredVoice).toBe('nova'));

    expect(result.current.voice.speechRate).toBe(1.4);
    // The fields the document does not name keep their built-in defaults, and
    // are still not written back.
    expect(result.current.voice.autoSubmitSpoken).toBe(true);
    expect(patchCount).toBe(0);
  });

  it('honours a stored conversationMode without writing anything back', async () => {
    mockSettings({ conversationMode: true });

    const { result } = renderHook(() => useVoicePrefs());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.voice.conversationMode).toBe(true);
    // The other six keep their built-in defaults, and nothing is stored to
    // say so — the same sparse contract the whole namespace ships with.
    expect(result.current.voice.readQuestionsAloud).toBe(false);
    expect(patchCount).toBe(0);
  });

  it('honours a stored `false` — an explicit opt-out is not an absence', async () => {
    mockSettings({ autoSubmitSpoken: false, preferPremiumVoice: false });

    const { result } = renderHook(() => useVoicePrefs());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.voice.autoSubmitSpoken).toBe(false);
    expect(result.current.voice.preferPremiumVoice).toBe(false);
  });
});

describe('resolveVoicePreferences — values this build will not honour', () => {
  it('falls back on an out-of-range, non-finite or wrong-typed speechRate', () => {
    for (const bad of [12, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1.2', null]) {
      expect(
        resolveVoicePreferences({ speechRate: bad as never }).speechRate,
      ).toBe(DEFAULT_VOICE_SPEECH_RATE);
    }

    // …and keeps the ones inside the API's own bounds.
    expect(resolveVoicePreferences({ speechRate: 0.5 }).speechRate).toBe(0.5);
    expect(resolveVoicePreferences({ speechRate: 2 }).speechRate).toBe(2);
  });

  it('drops a preferredVoice that is not identifier-shaped', () => {
    for (const bad of ['', '   ', 'not a voice', 'a'.repeat(65), 42, null]) {
      expect(
        resolveVoicePreferences({ preferredVoice: bad as never }).preferredVoice,
      ).toBeUndefined();
    }

    // Shape checked, MEMBERSHIP NOT: a voice id this build has never heard of
    // still goes out, because the accepted set belongs to the provider.
    expect(
      resolveVoicePreferences({ preferredVoice: 'some_future-voice9' })
        .preferredVoice,
    ).toBe('some_future-voice9');
  });

  it('falls back on a wrong-typed conversationMode, and honours a real boolean', () => {
    // Out of a user-writable JSONB column: a string, a number or a null is
    // reachable, and none of them is a learner asking for hands-free mode.
    for (const bad of ['true', 1, 0, null, {}, []]) {
      expect(
        resolveVoicePreferences({ conversationMode: bad as never })
          .conversationMode,
      ).toBe(DEFAULT_VOICE_CONVERSATION_MODE);
    }

    expect(
      resolveVoicePreferences({ conversationMode: true }).conversationMode,
    ).toBe(true);
    // A stored `false` is a real opt-out, not an absence — it happens to
    // equal the default today, which is exactly why it must not be written.
    expect(
      resolveVoicePreferences({ conversationMode: false }).conversationMode,
    ).toBe(false);
  });

  it('resolves an entirely absent namespace without throwing', () => {
    expect(resolveVoicePreferences(undefined).speechRate).toBe(
      DEFAULT_VOICE_SPEECH_RATE,
    );
    expect(resolveVoicePreferences(undefined).preferredVoice).toBeUndefined();
    expect(resolveVoicePreferences(undefined).conversationMode).toBe(false);
  });
});

/**
 * `QuestionAudio` — the learner's stored voice and speed reach the audio
 * (#288, epic #280).
 *
 * A sibling suite to `QuestionAudio.test.tsx` rather than an addition to it,
 * because it is about ONE narrow thing that file has no opinion on: the two
 * props #288 added, and which of the component's two playback paths each one
 * lands on. Everything else about the component — the browser-first
 * preference, the absent-not-disabled control, the `onPlayed`-only-when-audio-
 * starts rule — is that file's, and is untouched.
 *
 * THE SPLIT IS DELIBERATE AND IS THE POINT OF THIS FILE:
 *
 *   `rate`  -> the BROWSER path only (`utterance.rate`). The provider's
 *              synthesis endpoint has no speed control this application uses,
 *              which `docs/specs/voice-hands-free.md` §5 names as a real,
 *              acknowledged gap rather than papering over it.
 *   `voice` -> the PREMIUM path only (the request's `voice` field). The
 *              browser's `speechSynthesis` keys its own voices by BCP-47 name,
 *              so applying a provider's id there would be a coincidence, not a
 *              match.
 *
 * A regression that swapped them would still "work" on both paths and be
 * silently wrong on both, which is exactly why each direction is asserted
 * rather than only the pair being present.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import { http, HttpResponse } from 'msw';

import { QuestionAudio, DEFAULT_SPEECH_RATE } from '../../../components/voice/QuestionAudio';
import { AiStatusProvider } from '../../../contexts/AiStatusContext';
import { lightTheme } from '../../../theme';
import type { AiStatus } from '../../../types';
import { server } from '../../mocks/server';

const QUESTION = 'Who is in charge of the executive branch?';

interface FakeUtterance {
  text: string;
  rate: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

let spoken: FakeUtterance[] = [];
let synthesizeBodies: Array<Record<string, unknown>> = [];
let statusCalls = 0;

function installSpeechSynthesis() {
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      cancel: vi.fn(),
      speak: vi.fn((utterance: FakeUtterance) => {
        spoken.push(utterance);
        utterance.onstart?.();
      }),
    },
    configurable: true,
  });
  (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    class {
      text: string;
      rate = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    };
}

function mockStatus(overrides: Partial<AiStatus> = {}) {
  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    unboundRoles: [],
    ...overrides,
  };
  server.use(
    http.get('*/api/ai/status', () => {
      statusCalls += 1;
      return HttpResponse.json({ data: status });
    }),
    http.post('*/api/ai/speech/synthesize', async ({ request }) => {
      synthesizeBodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.arrayBuffer(new ArrayBuffer(8), {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),
  );
}

function renderIt(props: Parameters<typeof QuestionAudio>[0]) {
  return render(
    <ThemeProvider theme={lightTheme}>
      <AiStatusProvider>
        <QuestionAudio {...props} />
      </AiStatusProvider>
    </ThemeProvider>,
  );
}

function play() {
  fireEvent.click(screen.getByRole('button', { name: /read the question aloud/i }));
}

/** A fake `Audio` — jsdom implements no media playback at all. */
function installAudio() {
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public src: string) {}
    play() {
      return Promise.resolve();
    }
    pause() {}
    removeAttribute() {}
  }
  const real = (window as unknown as { Audio?: unknown }).Audio;
  (window as unknown as { Audio: unknown }).Audio = FakeAudio;
  return real;
}

describe('QuestionAudio — the stored voice and speed (#288)', () => {
  let realAudio: unknown;

  beforeEach(() => {
    spoken = [];
    synthesizeBodies = [];
    statusCalls = 0;
    installSpeechSynthesis();
    realAudio = installAudio();
  });

  afterEach(() => {
    (window as unknown as { Audio?: unknown }).Audio = realAudio;
  });

  // ===========================================================================
  // `rate` -> the browser utterance
  // ===========================================================================

  it("uses the learner's stored speed on the browser voice", async () => {
    mockStatus();
    renderIt({ text: QUESTION, rate: 1.4 });
    await waitFor(() => expect(statusCalls).toBe(1));

    play();

    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0].rate).toBe(1.4);
    expect(spoken[0].text).toBe(QUESTION);
  });

  it('keeps 0.95 as the default for a caller that passes no rate', async () => {
    mockStatus();
    renderIt({ text: QUESTION });
    await waitFor(() => expect(statusCalls).toBe(1));

    play();

    await waitFor(() => expect(spoken).toHaveLength(1));
    // The literal this component used to hard-code, now the default rather than
    // a new number — see `DEFAULT_SPEECH_RATE`'s own comment.
    expect(spoken[0].rate).toBe(0.95);
    expect(DEFAULT_SPEECH_RATE).toBe(0.95);
  });

  // ===========================================================================
  // `voice` -> the synthesis request
  // ===========================================================================

  it("sends the learner's stored voice id on the premium path", async () => {
    mockStatus({ unboundRoles: [] });
    renderIt({ text: QUESTION, premiumVoice: true, voice: 'nova', rate: 1.4 });
    await waitFor(() => expect(statusCalls).toBe(1));

    play();

    await waitFor(() => expect(synthesizeBodies).toHaveLength(1));
    expect(synthesizeBodies[0]).toEqual({ text: QUESTION, voice: 'nova' });
  });

  it('omits the voice key entirely when the learner has expressed no preference', async () => {
    mockStatus({ unboundRoles: [] });
    renderIt({ text: QUESTION, premiumVoice: true });
    await waitFor(() => expect(statusCalls).toBe(1));

    play();

    await waitFor(() => expect(synthesizeBodies).toHaveLength(1));
    // NOT `voice: ''`, and not `voice: undefined` serialised as `null`:
    // `aiSynthesizeRequestSchema` is `.strict()` with `voice` optional, so an
    // absent key is "the provider chooses" and anything else is a 400.
    expect(synthesizeBodies[0]).toEqual({ text: QUESTION });
    expect('voice' in synthesizeBodies[0]).toBe(false);
  });

  it('does not spend the key at all when the learner has not asked for the premium voice', async () => {
    mockStatus({ unboundRoles: [] });
    // `preferPremiumVoice: false` is what a learner who turned the toggle off
    // on `/settings/voice` produces — a stored voice id must not resurrect the
    // paid path they opted out of.
    renderIt({ text: QUESTION, premiumVoice: false, voice: 'nova' });
    await waitFor(() => expect(statusCalls).toBe(1));

    play();

    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(synthesizeBodies).toEqual([]);
  });
});

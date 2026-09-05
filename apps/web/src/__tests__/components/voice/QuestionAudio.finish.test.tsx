/**
 * `QuestionAudio` — the END of playback, and cutting it off (#311, epic #304).
 *
 * A sibling suite to `QuestionAudio.test.tsx` and `QuestionAudio.prefs.test.tsx`
 * rather than an addition to either, for the same reason the prefs suite is one:
 * it is about the two things E13 added and nothing else — `onFinished` and the
 * `stop()` handle. The browser-first preference, the absent-not-disabled
 * control and the `onPlayed`-only-when-audio-starts rule are the first file's,
 * and are untouched here.
 *
 * WHAT THIS SUITE IS REALLY GUARDING is the difference between an end and a
 * cancel. A conversation loop advances on `onFinished`, so:
 *
 *   - firing it for a barge-in would drive over the learner who just
 *     interrupted, and
 *   - NOT firing it when a premium clip dies mid-playback would hang the loop
 *     forever on an end that is never coming.
 *
 * Both directions are asserted, on both playback paths, because a component
 * that got either one right and the other wrong would look correct in casual
 * use and be broken exactly when somebody speaks over it.
 */

import { ThemeProvider } from '@mui/material/styles';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  QuestionAudio,
  type QuestionAudioFinished,
  type QuestionAudioHandle,
} from '../../../components/voice/QuestionAudio';
import { AiStatusProvider } from '../../../contexts/AiStatusContext';
import { lightTheme } from '../../../theme';
import type { AiStatus } from '../../../types';
import { server } from '../../mocks/server';

const QUESTION = 'Who is in charge of the executive branch?';

// ---------------------------------------------------------------------------
// The browser's speech engine, faked — and deliberately NOT self-completing.
//
// The engine in `QuestionAudio.test.tsx` fires `onstart` and stops there, which
// is all that file needs. This one additionally keeps the "live" utterances so
// a test can end one by hand, and reports a `cancel()` through `onerror` with
// `canceled` exactly as a real engine does — which is what makes "a cancel is
// not a completion" a claim about the component rather than about this fake.
// ---------------------------------------------------------------------------

interface FakeUtterance {
  text: string;
  rate: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

let spoken: FakeUtterance[] = [];
let live: FakeUtterance[] = [];
let cancels = 0;

function installSpeechSynthesis() {
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      cancel: vi.fn(() => {
        cancels += 1;
        const interrupted = live;
        live = [];
        for (const utterance of interrupted) utterance.onerror?.({ error: 'canceled' });
      }),
      speak: vi.fn((utterance: FakeUtterance) => {
        spoken.push(utterance);
        live.push(utterance);
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

/** End the utterance that is currently speaking, as a real engine would. */
function endBrowserPlayback(utterance: FakeUtterance) {
  live = live.filter((one) => one !== utterance);
  act(() => utterance.onend?.());
}

// ---------------------------------------------------------------------------
// The premium element, faked. jsdom implements no media playback at all.
// ---------------------------------------------------------------------------

interface FakeAudioElement {
  src: string;
  paused: boolean;
  onplay: (() => void) | null;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

let audios: FakeAudioElement[] = [];
/** Whether `play()` resolves. `false` is an autoplay block — sound never starts. */
let audioCanPlay = true;
let realAudio: unknown;

function installAudio() {
  class FakeAudio implements FakeAudioElement {
    paused = false;
    onplay: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public src: string) {
      audios.push(this);
    }
    play() {
      if (!audioCanPlay) return Promise.reject(new Error('NotAllowedError'));
      this.onplay?.();
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    removeAttribute() {
      this.src = '';
    }
  }
  realAudio = (window as unknown as { Audio?: unknown }).Audio;
  (window as unknown as { Audio: unknown }).Audio = FakeAudio;
}

// ---------------------------------------------------------------------------

let statusCalls = 0;

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
    http.post('*/api/ai/speech/synthesize', () =>
      HttpResponse.arrayBuffer(new ArrayBuffer(8), {
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
    ),
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

function pressPlay() {
  fireEvent.click(screen.getByRole('button', { name: /read the question aloud/i }));
}

beforeEach(() => {
  spoken = [];
  live = [];
  audios = [];
  cancels = 0;
  statusCalls = 0;
  audioCanPlay = true;
  installSpeechSynthesis();
  installAudio();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
  (window as unknown as { Audio?: unknown }).Audio = realAudio;
  vi.restoreAllMocks();
});

// ===========================================================================
// A genuine end, on both paths
// ===========================================================================

describe('`onFinished` fires once, at a genuine end', () => {
  it('reports the browser voice reaching the end of the question', async () => {
    mockStatus({ unboundRoles: ['speak'] });
    const finished: QuestionAudioFinished[] = [];
    renderIt({ text: QUESTION, onFinished: (event) => finished.push(event) });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    pressPlay();
    await waitFor(() => expect(spoken).toHaveLength(1));
    // Started, not finished: `onPlayed`'s moment is not `onFinished`'s.
    expect(finished).toEqual([]);

    endBrowserPlayback(spoken[0]);

    expect(finished).toEqual([{ reason: 'ended', source: 'browser' }]);
    // And the control is back at rest, as it was before #311.
    expect(
      screen.getByRole('button', { name: /read the question aloud/i }),
    ).toBeInTheDocument();
  });

  it('reports the premium clip reaching its end', async () => {
    mockStatus({ unboundRoles: [] });
    const finished: QuestionAudioFinished[] = [];
    renderIt({
      text: QUESTION,
      premiumVoice: true,
      onFinished: (event) => finished.push(event),
    });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    pressPlay();
    await waitFor(() => expect(audios).toHaveLength(1));
    expect(finished).toEqual([]);

    act(() => audios[0].onended?.());

    expect(finished).toEqual([{ reason: 'ended', source: 'premium' }]);
    // The browser voice never spoke: one play, one end, one source.
    expect(spoken).toHaveLength(0);
  });

  it('reports ONE end when a premium clip that never started falls through', async () => {
    // THE DOUBLE-FIRE THIS GUARDS: the premium element is blocked by the
    // autoplay policy, the browser voice reads the same sentence, and a driver
    // that heard two ends for one play would advance twice.
    mockStatus({ unboundRoles: [] });
    audioCanPlay = false;
    const finished: QuestionAudioFinished[] = [];
    renderIt({
      text: QUESTION,
      premiumVoice: true,
      onFinished: (event) => finished.push(event),
    });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    pressPlay();
    // The premium attempt failed BEFORE any sound, so nothing is reported for
    // it — and the browser voice took over.
    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(finished).toEqual([]);

    endBrowserPlayback(spoken[0]);

    expect(finished).toEqual([{ reason: 'ended', source: 'browser' }]);
  });
});

// ===========================================================================
// A cancel is NOT an end
// ===========================================================================

describe('a cancelled play reports nothing', () => {
  it('stays silent when the caller stops it through the ref', async () => {
    mockStatus({ unboundRoles: ['speak'] });
    const ref = createRef<QuestionAudioHandle>();
    const finished: QuestionAudioFinished[] = [];
    renderIt({ text: QUESTION, ref, onFinished: (event) => finished.push(event) });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    pressPlay();
    await waitFor(() => expect(spoken).toHaveLength(1));

    act(() => ref.current?.stop());

    // The engine was cancelled — which reports the interrupted utterance as an
    // error — and NOTHING was reported as finished. This is the barge-in case.
    expect(cancels).toBeGreaterThan(0);
    expect(finished).toEqual([]);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /read the question aloud/i }),
      ).toBeInTheDocument(),
    );
  });

  it('stays silent when the learner presses the stop button', async () => {
    mockStatus({ unboundRoles: ['speak'] });
    const finished: QuestionAudioFinished[] = [];
    renderIt({ text: QUESTION, onFinished: (event) => finished.push(event) });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    pressPlay();
    await waitFor(() => expect(spoken).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: /stop reading/i }));

    expect(finished).toEqual([]);
  });

  it('stays silent when ANOTHER player takes the voice (`stopOtherPlayers`)', async () => {
    // Two mounted instances, exactly as the practice screen has had since #287.
    mockStatus({ unboundRoles: ['speak'] });
    const finished: QuestionAudioFinished[] = [];
    render(
      <ThemeProvider theme={lightTheme}>
        <AiStatusProvider>
          <QuestionAudio text={QUESTION} onFinished={(event) => finished.push(event)} />
          <QuestionAudio
            text="the Constitution"
            copy={{ play: 'Read the answer aloud', stop: 'Stop the answer' }}
          />
        </AiStatusProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /read the question aloud/i }));
    await waitFor(() => expect(spoken).toHaveLength(1));

    // The ANSWER starts, which silences the question.
    fireEvent.click(screen.getByRole('button', { name: /read the answer aloud/i }));
    await waitFor(() => expect(spoken).toHaveLength(2));

    // The question was interrupted, not completed.
    expect(finished).toEqual([]);
  });

  it("stays silent for an engine's own `interrupted` report", async () => {
    // The same discrimination, arriving WITHOUT this component having asked for
    // it — so the `requestRef` guard is not what saves us and the explicit
    // `canceled`/`interrupted` branch is under test on its own.
    mockStatus({ unboundRoles: ['speak'] });
    const finished: QuestionAudioFinished[] = [];
    renderIt({ text: QUESTION, onFinished: (event) => finished.push(event) });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    pressPlay();
    await waitFor(() => expect(spoken).toHaveLength(1));

    act(() => spoken[0].onerror?.({ error: 'interrupted' }));

    expect(finished).toEqual([]);
    // And nothing was explained to the learner either — an interruption is not
    // a failure of the product.
    expect(
      screen.queryByText(/could not be read aloud/i),
    ).toBeNull();
  });
});

// ===========================================================================
// A failure still ends the wait
// ===========================================================================

describe('a failure is reported as one, and never as an end', () => {
  it('reports `failed` when the premium clip dies MID-playback', async () => {
    // The case the `audio.onerror = ctx.onEnd` aliasing used to swallow into a
    // completion. The browser fall-through is out of reach by now — `playBlob`
    // resolved `true` — so silence here would hang a driver forever.
    mockStatus({ unboundRoles: [] });
    const finished: QuestionAudioFinished[] = [];
    renderIt({
      text: QUESTION,
      premiumVoice: true,
      onFinished: (event) => finished.push(event),
    });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    pressPlay();
    await waitFor(() => expect(audios).toHaveLength(1));

    act(() => audios[0].onerror?.());

    expect(finished).toEqual([{ reason: 'failed', source: 'premium' }]);
    // NOT a second reading: the fall-through belongs to a clip that never
    // started, and this one did.
    expect(spoken).toHaveLength(0);
  });

  it('reports `failed` when the browser engine genuinely errors', async () => {
    mockStatus({ unboundRoles: ['speak'] });
    const finished: QuestionAudioFinished[] = [];
    renderIt({ text: QUESTION, onFinished: (event) => finished.push(event) });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    pressPlay();
    await waitFor(() => expect(spoken).toHaveLength(1));

    act(() => spoken[0].onerror?.({ error: 'synthesis-failed' }));

    expect(finished).toEqual([{ reason: 'failed', source: 'browser' }]);
    // And this one IS said out loud, unlike the cancel above.
    expect(await screen.findByText(/could not be read aloud/i)).toBeInTheDocument();
  });

  it('reports `failed` with no source when neither voice could speak', async () => {
    // No `speechSynthesis` at all (the browser cannot speak), `speak` bound and
    // asked for, and the endpoint answering the 200-JSON `unavailable` union.
    // Nothing plays — and the one failure mode with no symptom is a driver
    // still waiting on it.
    Reflect.deleteProperty(window, 'speechSynthesis');
    Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
    mockStatus({ unboundRoles: [] });
    server.use(
      http.post('*/api/ai/speech/synthesize', () =>
        HttpResponse.json({
          data: { status: 'unavailable', cause: 'role_unbound', role: 'speak' },
        }),
      ),
    );
    const finished: QuestionAudioFinished[] = [];
    renderIt({
      text: QUESTION,
      premiumVoice: true,
      onFinished: (event) => finished.push(event),
    });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    pressPlay();

    await waitFor(() =>
      expect(finished).toEqual([{ reason: 'failed', source: null }]),
    );
  });
});

// ===========================================================================
// The handle
// ===========================================================================

describe('the `stop()` handle', () => {
  it('halts the browser voice immediately, and is idempotent', async () => {
    mockStatus({ unboundRoles: ['speak'] });
    const ref = createRef<QuestionAudioHandle>();
    const finished: QuestionAudioFinished[] = [];
    renderIt({ text: QUESTION, ref, onFinished: (event) => finished.push(event) });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    pressPlay();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /stop reading/i })).toBeInTheDocument(),
    );

    act(() => ref.current?.stop());
    const after = cancels;

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /read the question aloud/i }),
      ).toBeInTheDocument(),
    );

    // AGAIN, and again with nothing playing: no throw, no second life, and
    // still no completion reported.
    act(() => ref.current?.stop());
    act(() => ref.current?.stop());

    expect(cancels).toBeGreaterThan(after - 1);
    expect(finished).toEqual([]);
    expect(spoken).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: /read the question aloud/i }),
    ).toBeInTheDocument();
  });

  it('halts the premium element immediately, and is idempotent', async () => {
    mockStatus({ unboundRoles: [] });
    const ref = createRef<QuestionAudioHandle>();
    const finished: QuestionAudioFinished[] = [];
    renderIt({
      text: QUESTION,
      premiumVoice: true,
      ref,
      onFinished: (event) => finished.push(event),
    });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    pressPlay();
    await waitFor(() => expect(audios).toHaveLength(1));

    act(() => ref.current?.stop());
    act(() => ref.current?.stop());

    // Paused, detached from its bytes, and reported to nobody.
    expect(audios[0].paused).toBe(true);
    expect(audios[0].src).toBe('');
    expect(finished).toEqual([]);
    expect(audios).toHaveLength(1);
  });

  it('is optional, exactly like `onFinished`', async () => {
    // A caller that passes neither — every call site that predates #311 — still
    // plays, still stops, and never reaches for a handle that is not there.
    mockStatus({ unboundRoles: ['speak'] });
    renderIt({ text: QUESTION });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    pressPlay();
    await waitFor(() => expect(spoken).toHaveLength(1));

    endBrowserPlayback(spoken[0]);

    expect(
      screen.getByRole('button', { name: /read the question aloud/i }),
    ).toBeInTheDocument();
  });
});

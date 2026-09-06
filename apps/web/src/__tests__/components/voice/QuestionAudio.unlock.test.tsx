/**
 * `QuestionAudio` — the press primes, and the autoplay path must not (#389).
 *
 * A sibling suite to `QuestionAudio.test.tsx`, `QuestionAudio.prefs.test.tsx`
 * and `QuestionAudio.finish.test.tsx`, for the same reason each of those is
 * one: it is about a single decision this component makes and nothing else.
 *
 * WHAT THIS SUITE IS REALLY GUARDING is an ASYMMETRY that is easy to read as
 * an oversight and delete:
 *
 *   - THE BUTTON PRIMES. A mobile browser only plays audio through an element
 *     that was itself started during a user gesture, and synthesizing is a
 *     network round trip — so the premium element this component used to build
 *     in the continuation was one the press never touched, and every mobile
 *     browser refused its `play()`. The learner still heard the question, in
 *     the free browser voice, while paying their own key for the premium one.
 *     Silently, for ever.
 *   - THE AUTOPLAY PATH PRIMES NOTHING, AND MUST NOT. When
 *     `voice.readQuestionsAloud` starts a question with no tap there is no
 *     gesture to prime from: a `play()` in an effect is refused whether an
 *     element was primed or not, so priming there would unlock nothing and
 *     read, to the next person, as a promise this component cannot keep. The
 *     browser-voice fall-through is the correct design on that path
 *     (`docs/specs/voice.md` §1, §5.2).
 *
 * The third test is the one that makes the first two safe to trust: the
 * fall-through and issue #311's `onError(started)` split are asserted here
 * too, because the cheapest way to "fix" a failing priming test would be to
 * change how a refusal is reported, and that would break a conversation loop
 * rather than this file.
 */

import { ThemeProvider } from '@mui/material/styles';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  QuestionAudio,
  type QuestionAudioFinished,
} from '../../../components/voice/QuestionAudio';
import { AiStatusProvider } from '../../../contexts/AiStatusContext';
import { lightTheme } from '../../../theme';
import { server } from '../../mocks/server';
import { installFakeAudio, type FakeAudioHandle } from '../../utils/fake-audio';
import type { AiStatus } from '../../../types';

const QUESTION = 'Who is in charge of the executive branch?';

// ---------------------------------------------------------------------------
// The browser's speech engine, faked. It is the fall-through under test in the
// third block, and it must exist for the control to render at all.
// ---------------------------------------------------------------------------

interface FakeUtterance {
  text: string;
  rate: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

let spoken: FakeUtterance[] = [];

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
  (
    window as unknown as { SpeechSynthesisUtterance: unknown }
  ).SpeechSynthesisUtterance = class {
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

// ---------------------------------------------------------------------------

let statusCalls = 0;
let synthesizeCalls = 0;
let installedAudio: FakeAudioHandle | null = null;

function installAudio(
  options: Parameters<typeof installFakeAudio>[0] = {},
): FakeAudioHandle {
  installedAudio = installFakeAudio(options);
  return installedAudio;
}

/** `speak` bound, and a synthesis that answers with bytes unless gated. */
function mockApi(options: { gate?: Promise<void> } = {}) {
  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    unboundRoles: [],
  };
  server.use(
    http.get('*/api/ai/status', () => {
      statusCalls += 1;
      return HttpResponse.json({ data: status });
    }),
    http.post('*/api/ai/speech/synthesize', async () => {
      synthesizeCalls += 1;
      if (options.gate) await options.gate;
      return HttpResponse.arrayBuffer(new ArrayBuffer(8), {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),
  );
}

function renderIt(props: Parameters<typeof QuestionAudio>[0]) {
  const tree = (next: Parameters<typeof QuestionAudio>[0]) => (
    <ThemeProvider theme={lightTheme}>
      <AiStatusProvider>
        <QuestionAudio {...next} />
      </AiStatusProvider>
    </ThemeProvider>
  );
  const view = render(tree(props));
  return {
    ...view,
    setProps: (next: Parameters<typeof QuestionAudio>[0]) =>
      view.rerender(tree(next)),
  };
}

/**
 * Autoplay a question with the PREMIUM path genuinely reachable.
 *
 * `autoPlay` is passed as `false` first and flipped once `GET /api/ai/status`
 * has landed, which is what the prop's own documentation describes a host
 * doing ("it passes `false` until…") and is the only way to reach the premium
 * branch from the autoplay effect at all: the effect deliberately does not
 * re-run when the AI status resolves — `playRef` exists precisely so a
 * question is never re-spoken by a re-render — so a component mounted with
 * `autoPlay` already true speaks in the browser voice before `speak` is known
 * to be bound, and the assertion would be vacuous.
 */
async function autoPlayWithPremium(
  props: Parameters<typeof QuestionAudio>[0],
) {
  const view = renderIt({ ...props, autoPlay: false });
  await waitFor(() => expect(statusCalls).toBeGreaterThan(0));
  view.setProps({ ...props, autoPlay: true });
  return view;
}

beforeEach(() => {
  spoken = [];
  statusCalls = 0;
  synthesizeCalls = 0;
  installSpeechSynthesis();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
  installedAudio?.restore();
  installedAudio = null;
  vi.restoreAllMocks();
});

// ===========================================================================
// The press
// ===========================================================================

describe('press-to-play', () => {
  it('primes the audio element INSIDE the click, before the synthesis resolves', async () => {
    const audio = installAudio();

    // A synthesis call that does not answer until this test says so. The whole
    // question here is what has already happened while it is still in flight.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockApi({ gate });

    renderIt({ text: QUESTION, premiumVoice: true });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    fireEvent.click(
      screen.getByRole('button', { name: /read the question aloud/i }),
    );

    // THE ASSERTION THIS TEST EXISTS FOR, and it is deliberately made with NO
    // `await` between it and the click: the element must have been built and
    // played inside the activation window the press opened. Move
    // `acquireAndPrimeAudio` into `runPlay` — after `synthesizeSpeech` — and
    // this is empty here while every other test in these four files passes.
    expect(audio.elements).toHaveLength(1);
    expect(audio.primed).toHaveLength(1);
    expect(audio.primed[0].startsWith('data:audio/')).toBe(true);

    // And priming is silent in the other sense too: no clip has played yet.
    expect(audio.played).toEqual([]);

    release();
    await waitFor(() => expect(audio.played).toHaveLength(1));
    expect(audio.played[0].startsWith('data:')).toBe(false);

    // ONE element for both: the primed one is the one that played, which is the
    // entire fix. A second element would have been a fresh lock nothing opened.
    expect(audio.elements).toHaveLength(1);
  });

  it('does not build or prime an element when the premium path is not taken', async () => {
    const audio = installAudio();
    mockApi();

    // `premiumVoice` defaults to false, so this press will never touch an
    // `<audio>` element at all — and unlocking one would be a promise about a
    // path this press does not take.
    renderIt({ text: QUESTION });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    fireEvent.click(
      screen.getByRole('button', { name: /read the question aloud/i }),
    );

    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(audio.elements).toEqual([]);
    expect(audio.primed).toEqual([]);
    expect(synthesizeCalls).toBe(0);
  });
});

// ===========================================================================
// Autoplay — the invariant this epic explicitly protects
// ===========================================================================

describe('autoplay', () => {
  it('primes NOTHING when a question starts itself', async () => {
    const audio = installAudio();
    mockApi();

    // `voice.readQuestionsAloud` — the host passes `autoPlay`, no tap happens,
    // and the premium path is still taken because `speak` is bound and the
    // learner asked for it.
    await autoPlayWithPremium({ text: QUESTION, premiumVoice: true });

    // Playback really did run, so this is an absence WITHIN a path that
    // executed rather than an absence because nothing happened.
    await waitFor(() => expect(audio.played).toHaveLength(1));

    // THE ASSERTION THE ISSUE EXPLICITLY PROTECTS. There is no gesture on this
    // path to spend: a `play()` in an effect is refused whether an element was
    // primed or not, so priming here would unlock nothing and would read as a
    // promise this component cannot keep. `docs/specs/voice.md` §1, §5.2.
    expect(audio.primed).toEqual([]);
    expect(audio.played[0].startsWith('data:')).toBe(false);
  });

  it('still primes nothing when the autoplayed premium clip is refused', async () => {
    // The case a well-meaning "fix" would reach for: autoplay was blocked, so
    // surely it should have been primed. It could not have been — there was no
    // gesture — and the browser voice below is the answer, not a workaround.
    const audio = installAudio({
      play: () => Promise.reject(new Error('NotAllowedError')),
    });
    mockApi();

    await autoPlayWithPremium({ text: QUESTION, premiumVoice: true });

    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(audio.played).toHaveLength(1);
    expect(audio.primed).toEqual([]);
  });
});

// ===========================================================================
// The fall-through, and #311's split, both unchanged
// ===========================================================================

describe('the browser-voice fall-through', () => {
  it('reads the question when the primed premium clip is refused, and reports no end', async () => {
    // A `play()` that resolves for the silent unlock and rejects for the clip —
    // a muted phone, or an autoplay policy the priming could not satisfy.
    const audio = installAudio({
      play: (src) =>
        src.startsWith('data:')
          ? Promise.resolve()
          : Promise.reject(new Error('NotAllowedError')),
    });
    const finished: QuestionAudioFinished[] = [];
    mockApi();

    renderIt({
      text: QUESTION,
      premiumVoice: true,
      onFinished: (event) => finished.push(event),
    });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    fireEvent.click(
      screen.getByRole('button', { name: /read the question aloud/i }),
    );

    // The priming happened, the clip was still refused, and the learner hears
    // the question anyway. That fall-through is correct and #389 left it alone.
    await waitFor(() => expect(audio.primed).toHaveLength(1));
    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0].text).toBe(QUESTION);

    // #311: a clip that NEVER STARTED reports nothing, because the browser
    // voice is about to speak the same sentence and report its own end. One
    // play, one `onFinished`.
    expect(finished).toEqual([]);

    // Nothing went wrong from the learner's side, so nothing says otherwise.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports `failed` when a primed clip dies AFTER it started', async () => {
    const audio = installAudio();
    const finished: QuestionAudioFinished[] = [];
    mockApi();

    renderIt({
      text: QUESTION,
      premiumVoice: true,
      onFinished: (event) => finished.push(event),
    });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    fireEvent.click(
      screen.getByRole('button', { name: /read the question aloud/i }),
    );
    await waitFor(() => expect(audio.played).toHaveLength(1));

    // Sound had begun. The browser fall-through is out of reach by now, so
    // silence here would hang a driver forever on an end that is not coming.
    audio.last()?.onerror?.();

    await waitFor(() =>
      expect(finished).toEqual([{ reason: 'failed', source: 'premium' }]),
    );
    expect(spoken).toHaveLength(0);
  });
});

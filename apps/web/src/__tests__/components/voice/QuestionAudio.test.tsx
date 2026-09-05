/**
 * `QuestionAudio` — the browser's own voice is the default, not a fallback.
 *
 * Issue #99, epic #58 / E9. `docs/specs/voice.md` §2 (decision 1) is the whole
 * subject of this suite: "hear this question aloud" must work on a fresh
 * install with no model bound, no key, no admin action and no per-call cost.
 *
 * The two ways that promise gets broken are both tested directly:
 *
 *   1. Inverting the preference — reaching for the paid `speak` route first —
 *      which spends a learner's own key on something their browser does for
 *      nothing, and makes the ordinary state of every fresh install look like a
 *      failure recovery.
 *   2. Explaining the absence — rendering `AiNotReady`-shaped copy over an
 *      unbound `speak` — which tells somebody the product is broken while it is
 *      reading their question to them.
 */

import { ThemeProvider } from '@mui/material/styles';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QuestionAudio } from '../../../components/voice/QuestionAudio';
import { AiStatusProvider } from '../../../contexts/AiStatusContext';
import { darkTheme, lightTheme } from '../../../theme';
import type { AiStatus } from '../../../types';
import { server } from '../../mocks/server';
import { resetViewportWidth, setViewportWidth } from '../../setup';

const QUESTION = 'Who is in charge of the executive branch?';

// ---------------------------------------------------------------------------
// The browser's speech engine, faked. jsdom ships none.
// ---------------------------------------------------------------------------

interface FakeUtterance {
  text: string;
  rate: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

let spoken: FakeUtterance[] = [];
let speakImpl: (utterance: FakeUtterance) => void = (utterance) => {
  // A real engine fires `start` when sound actually begins.
  utterance.onstart?.();
};

function installSpeechSynthesis() {
  const cancel = vi.fn();
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      cancel,
      speak: vi.fn((utterance: FakeUtterance) => {
        spoken.push(utterance);
        speakImpl(utterance);
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
  return { cancel };
}

// ---------------------------------------------------------------------------

let synthesizeCalls = 0;
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
    http.post('*/api/ai/speech/synthesize', () => {
      synthesizeCalls += 1;
      return HttpResponse.arrayBuffer(new ArrayBuffer(8), {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),
  );
}

function renderIt(
  props: Parameters<typeof QuestionAudio>[0],
  { withProvider = true, theme = lightTheme } = {},
): RenderResult {
  const element = <QuestionAudio {...props} />;
  return render(
    <ThemeProvider theme={theme}>
      {withProvider ? <AiStatusProvider>{element}</AiStatusProvider> : element}
    </ThemeProvider>,
  );
}

beforeEach(() => {
  spoken = [];
  synthesizeCalls = 0;
  statusCalls = 0;
  speakImpl = (utterance) => utterance.onstart?.();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
  resetViewportWidth();
  vi.restoreAllMocks();
});

describe('with `speak` unbound — every fresh install', () => {
  it('SPEAKS ANYWAY, using the browser, and calls no endpoint', async () => {
    installSpeechSynthesis();
    mockStatus({ systemReady: false, unboundRoles: ['speak'] });

    const onPlayed = vi.fn();
    renderIt({ text: QUESTION, premiumVoice: true, onPlayed });

    // Wait for the status to be known, so "did not call the endpoint" is a
    // decision this component made rather than a race it happened to win.
    await waitFor(() => expect(statusCalls).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /read the question aloud/i }));

    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0].text).toBe(QUESTION);
    expect(synthesizeCalls).toBe(0);
    // ACTUALLY spoken — the caller can record `prompt_mode = 'heard'`.
    expect(onPlayed).toHaveBeenCalledWith('browser');
  });

  it('says nothing about the missing binding', async () => {
    installSpeechSynthesis();
    mockStatus({ systemReady: false, unboundRoles: ['speak'] });

    renderIt({ text: QUESTION });
    await waitFor(() => expect(statusCalls).toBe(1));

    // No `AiNotReady`, no warning, no "not available yet". §2: nothing is
    // missing, so nothing explains itself.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/not available yet/i)).toBeNull();
    expect(screen.queryByText(/administrator/i)).toBeNull();
  });

  it('speaks with no AI status provider above it at all', async () => {
    installSpeechSynthesis();

    renderIt({ text: QUESTION, premiumVoice: true }, { withProvider: false });
    fireEvent.click(screen.getByRole('button', { name: /read the question aloud/i }));

    // A point-of-use control inside a screen that knows nothing about AI. An
    // unknown binding resolves to the voice that always works.
    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(synthesizeCalls).toBe(0);
  });
});

describe('the premium voice is opt-in, on top', () => {
  it('is NOT used just because `speak` is bound', async () => {
    installSpeechSynthesis();
    mockStatus({ unboundRoles: [] });

    renderIt({ text: QUESTION }); // premiumVoice defaults to false
    await waitFor(() => expect(statusCalls).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /read the question aloud/i }));

    await waitFor(() => expect(spoken).toHaveLength(1));
    // The learner never asked for it, and their key is not spent on a voice
    // their browser already provides.
    expect(synthesizeCalls).toBe(0);
  });

  it('is used when it is bound AND asked for', async () => {
    installSpeechSynthesis();
    mockStatus({ unboundRoles: [] });

    const played: string[] = [];
    class FakeAudio {
      onplay: (() => void) | null = null;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {}
      play() {
        this.onplay?.();
        return Promise.resolve();
      }
      pause() {}
      removeAttribute() {}
    }
    (window as unknown as { Audio: unknown }).Audio = FakeAudio;

    renderIt({
      text: QUESTION,
      premiumVoice: true,
      onPlayed: (source) => played.push(source),
    });
    await waitFor(() => expect(statusCalls).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /read the question aloud/i }));

    await waitFor(() => expect(synthesizeCalls).toBe(1));
    await waitFor(() => expect(played).toEqual(['premium']));
    expect(spoken).toHaveLength(0);
  });

  it('falls back to the browser voice, silently, on a genuine transport failure', async () => {
    installSpeechSynthesis();
    mockStatus({ unboundRoles: [] });
    server.use(
      // A REAL non-2xx (401, a dropped connection, …) — `synthesizeSpeech`
      // still rejects with `ApiError` for one of these, unchanged by issue
      // #277. This is the `catch` branch's job now, not the `speak`-unbound
      // shape, which is JSON at HTTP 200 and is covered separately below.
      http.post('*/api/ai/speech/synthesize', () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
      ),
    );

    renderIt({ text: QUESTION, premiumVoice: true });
    await waitFor(() => expect(statusCalls).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /read the question aloud/i }));

    await waitFor(() => expect(spoken).toHaveLength(1));
    // Nothing went wrong from the learner's side: they asked to hear the
    // question and they heard it.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('falls back to the browser voice, silently, on a 200 JSON `unavailable` body', async () => {
    // Issue #277: this is the path that used to be "right for the wrong
    // reason" — a JSON envelope handed straight to an `<audio>` element,
    // reaching this same fallback only because the resulting play error
    // landed in a `catch`. It is now reached by decision: `synthesizeSpeech`
    // inspects `Content-Type`, resolves to the `unavailable` member, and
    // `QuestionAudio` branches on `result.status` before ever touching
    // `playBlob`. Nothing is shown to the learner either way — an unbound
    // `speak` is not a degraded state (`docs/specs/voice.md` §2).
    installSpeechSynthesis();
    mockStatus({ unboundRoles: [] });
    server.use(
      http.post('*/api/ai/speech/synthesize', () =>
        HttpResponse.json({
          data: { status: 'unavailable', cause: 'role_unbound', role: 'speak' },
        }),
      ),
    );

    renderIt({ text: QUESTION, premiumVoice: true });
    await waitFor(() => expect(statusCalls).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /read the question aloud/i }));

    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0].text).toBe(QUESTION);
    // NO MESSAGE TO THE LEARNER — the whole point of the union reaching this
    // component at all rather than the play() call failing on its own.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/not available yet/i)).toBeNull();
    expect(screen.queryByText(/administrator/i)).toBeNull();
  });

  it('falls back to the browser voice, silently, on a 200 JSON `failed` body', async () => {
    // THE THIRD MEMBER, asserted on directly rather than assumed to share the
    // `unavailable` test's fate above. Both are branched over the SAME
    // `if (result.status === 'ok')` in `QuestionAudio`'s `play()` — so this is
    // one line of code either way — but issue #277 is precisely the case
    // where a client handled one non-`ok` member and silently crashed or
    // mis-rendered on the other, and a suite that only ever sent `unavailable`
    // would never have caught it.
    installSpeechSynthesis();
    mockStatus({ unboundRoles: [] });
    server.use(
      http.post('*/api/ai/speech/synthesize', () =>
        HttpResponse.json({
          data: {
            status: 'failed',
            errorCode: 'provider_error',
            error: 'The provider refused the request.',
          },
        }),
      ),
    );

    renderIt({ text: QUESTION, premiumVoice: true });
    await waitFor(() => expect(statusCalls).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /read the question aloud/i }));

    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0].text).toBe(QUESTION);
    // Same silence as `unavailable` — a provider failure is not the learner's
    // problem, and the browser voice already read the question.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/not available yet/i)).toBeNull();
    expect(screen.queryByText(/administrator/i)).toBeNull();
    expect(screen.queryByText(/provider refused/i)).toBeNull();
  });
});

describe('a browser that cannot speak at all', () => {
  it('renders no control, and errors at nothing', () => {
    // jsdom has no `speechSynthesis`, which is exactly the case under test.
    const { container } = renderIt({ text: QUESTION }, { withProvider: false });

    expect(container).toBeEmptyDOMElement();
    // The question text itself is rendered by the page, not by this component,
    // so it is still on screen — there is nothing here to degrade.
  });
});

describe('announcing, and both themes at 360px', () => {
  it('puts the reading state in a live region', async () => {
    installSpeechSynthesis();

    renderIt({ text: QUESTION }, { withProvider: false });
    fireEvent.click(screen.getByRole('button', { name: /read the question aloud/i }));

    const status = await screen.findByRole('status');
    await waitFor(() =>
      expect(status).toHaveTextContent(/reading the question aloud/i),
    );
    expect(status).toHaveAttribute('aria-live', 'polite');
    // And the control becomes its own opposite rather than disappearing.
    expect(screen.getByRole('button', { name: /stop reading/i })).toBeInTheDocument();
  });

  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ] as const)('renders in %s on a 360px phone', (_name, theme) => {
    installSpeechSynthesis();
    setViewportWidth(360);

    renderIt({ text: QUESTION }, { withProvider: false, theme });

    expect(
      screen.getByRole('button', { name: /read the question aloud/i }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Issue #109, epic #58 / E9 — the degradation rule, row 2.
//
// The two tests above ("SPEAKS ANYWAY" and "says nothing about the missing
// binding") already hold each half of this. It is asserted once more as a
// SINGLE claim because the two halves are only worth anything together: a
// silent component that stopped speaking would pass the second test, and a
// speaking component that grew an explanation would pass the first. `voice.md`
// §1's table says both at once — "no warning renders anywhere AND the question
// still plays" — so one test says both at once.
// ---------------------------------------------------------------------------

describe('`speak` unbound is NOT a degraded state', () => {
  it('plays the question and explains nothing, on a system that is otherwise ready', async () => {
    installSpeechSynthesis();
    // A READY deployment that simply has no premium voice bound — which since
    // E9 narrowed `systemReady` to the text roles is the ordinary state of
    // every fresh install, not a misconfiguration.
    mockStatus({ systemReady: true, unboundRoles: ['speak'] });

    const onPlayed = vi.fn();
    renderIt({ text: QUESTION, premiumVoice: true, onPlayed });
    await waitFor(() => expect(statusCalls).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /read the question aloud/i }));

    // It played.
    await waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0].text).toBe(QUESTION);
    expect(onPlayed).toHaveBeenCalledWith('browser');
    expect(synthesizeCalls).toBe(0);

    // And nothing explained itself. Nothing is missing: the learner asked to
    // hear the question and heard it. An `AiNotReady`-shaped message here —
    // including the "not a problem with your key" sentence, which is correct
    // everywhere it belongs and wrong here — would tell somebody the product
    // is broken while it is reading their question to them.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/not available yet/i)).toBeNull();
    expect(screen.queryByText(/administrator/i)).toBeNull();
    expect(screen.queryByText(/not a problem with your key/i)).toBeNull();
    expect(screen.queryByText(/speak/i)).toBeNull();
  });
});

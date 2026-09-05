/**
 * `/settings/voice` — the six voice preferences and the voice picker (#288,
 * epic #280).
 *
 * `useUserSettings` is REAL here, `UserSettingsSection` is real,
 * `VoiceSettings` is real, and `GET`/`PATCH /api/user-settings`,
 * `GET /api/ai/speech/voices` and `POST /api/ai/speech/synthesize` are all
 * recorded MSW handlers. This suite is about the REQUESTS — what is on the
 * wire, and, for two of the tests that matter most, what is not.
 *
 * WHAT THESE PIN, in order of what it would cost to get wrong:
 *
 *   1. PREVIEW SPENDS THE LEARNER'S OWN KEY, so it fires on an explicit press
 *      and on nothing else. Rendering the list, focusing a button, and
 *      arrowing through the radio group must all synthesize NOTHING — a picker
 *      that speaks as you scroll bills you for scrolling.
 *   2. AN UNBOUND `speak` IS NOT A FAILURE. `docs/specs/voice.md` §2: it is the
 *      ordinary state of a fresh install, the browser reads everything, and
 *      nothing may say otherwise. So the assertion is an ABSENCE — no
 *      `AiNotReady`, no alert, no warning — which is the kind of regression
 *      that arrives as a well-meaning "helpful" banner and is invisible to
 *      every test that only checks what IS on screen.
 *   3. RENDERING WRITES NOTHING, and returning a control to its default sends a
 *      NULL-DELETE. `voice` has no `.default()` on the server for a reason; a
 *      client that saves the default it renders pins a learner to today's
 *      value forever, invisibly.
 *   4. A `failed` synthesis is handled rather than assumed away — issue #277,
 *      the shipped bug where a client read the `ok` member without switching.
 *   5. Every control has a real accessible label, and the Preview control names
 *      the VOICE rather than being six identical "Preview" buttons.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import { AiStatusProvider } from '../../contexts/AiStatusContext';
import VoiceSettingsPage from '../../pages/VoiceSettingsPage';
import { VOICE_PREVIEW_SENTENCE } from '../../components/settings/VoiceSettings';
import type { AiStatus, UserSettings } from '../../types';

const API_BASE = '*/api';

/** The stored document, mutated by the PATCH handler so a reload can see it. */
let stored: UserSettings;

/** Every `PATCH /user-settings` body, in order. THE SPY THIS SUITE TURNS ON. */
let patchBodies: Array<Record<string, unknown>>;

/** Every `POST /ai/speech/synthesize` body, in order. THE OTHER SPY. */
let synthesizeBodies: Array<Record<string, unknown>>;

interface Options {
  /** Has an admin bound `speak`? Defaults to yes. */
  speakBound?: boolean;
  /** Does the learner have their own key? Defaults to yes. */
  userKeyConfigured?: boolean;
  /** What `POST /ai/speech/synthesize` answers. Defaults to audio bytes. */
  synthesis?: 'audio' | 'failed' | 'no_user_key' | 'role_unbound';
  /** A pre-existing `voice` namespace. Absent is the normal case. */
  voice?: UserSettings['voice'];
}

function mockApi(options: Options = {}) {
  stored = {
    theme: 'system',
    profile: { useProviderImage: true },
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
    ...(options.voice ? { voice: options.voice } : {}),
  };
  patchBodies = [];
  synthesizeBodies = [];

  const speakBound = options.speakBound ?? true;

  const status: AiStatus = {
    userKeyConfigured: options.userKeyConfigured ?? true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    unboundRoles: speakBound ? [] : ['speak'],
  };

  server.use(
    http.get(`${API_BASE}/ai/status`, () => HttpResponse.json({ data: status })),

    http.get(`${API_BASE}/ai/speech/voices`, () =>
      HttpResponse.json({
        data: {
          // An empty catalog when nothing is bound, exactly as the endpoint
          // answers: a provider with no `speak` binding has no voices to offer,
          // and that is not an error (`voice.md` §2).
          voices: speakBound
            ? [
                { id: 'alloy', label: 'Alloy', description: 'Even and neutral.' },
                { id: 'nova', label: 'Nova', description: 'Warm and bright.' },
              ]
            : [],
          speakBound,
          defaultVoice: speakBound ? 'alloy' : null,
        },
      }),
    ),

    http.post(`${API_BASE}/ai/speech/synthesize`, async ({ request }) => {
      synthesizeBodies.push((await request.json()) as Record<string, unknown>);

      // HTTP 200 CARRYING A CAUSE, never a 4xx for an AI reason — the shape
      // `AiSpeechController` actually answers with, and the whole point of
      // issue #277's lesson. `Content-Type` is the only thing that tells the
      // audio and the envelope apart.
      if (options.synthesis === 'failed') {
        return HttpResponse.json({
          data: {
            status: 'failed',
            errorCode: 'provider_error',
            error: 'The provider refused the request.',
          },
        });
      }
      if (options.synthesis === 'no_user_key' || options.synthesis === 'role_unbound') {
        return HttpResponse.json({
          data: { status: 'unavailable', cause: options.synthesis, role: 'speak' },
        });
      }

      // `arrayBuffer`, not a `Blob` body: `Content-Type` is the ONLY thing
      // that tells synthesized audio apart from a JSON envelope on this route
      // (issue #277), so the fixture has to set it the way the real response
      // does.
      return HttpResponse.arrayBuffer(new ArrayBuffer(8), {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),

    http.get(`${API_BASE}/user-settings`, () => HttpResponse.json({ data: stored })),

    http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patchBodies.push(body);

      // Field-wise merge with `null` as DELETE — what `mergeVoice` does on the
      // server. Modelled rather than shortcut to `{...stored, ...body}` so a
      // test that sends a null-delete gets the ABSENCE back on the next read,
      // exactly as it would from the real API.
      if ('voice' in body) {
        const patch = body.voice as Record<string, unknown> | null;
        if (patch === null) {
          delete stored.voice;
        } else {
          const next = { ...(stored.voice ?? {}) } as Record<string, unknown>;
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) delete next[key];
            else next[key] = value;
          }
          stored.voice =
            Object.keys(next).length > 0
              ? (next as UserSettings['voice'])
              : undefined;
        }
      }

      stored = { ...stored, version: stored.version + 1 };
      return HttpResponse.json({ data: stored });
    }),
  );
}

function renderPage() {
  return render(
    <AiStatusProvider>
      <VoiceSettingsPage />
    </AiStatusProvider>,
  );
}

/** Resolves once the settings document has loaded and the controls are up. */
async function findAutoSubmit(): Promise<HTMLInputElement> {
  return (await screen.findByLabelText(
    'Submit my spoken answer straight away',
  )) as HTMLInputElement;
}

/** A fake `Audio` whose playback is observable — jsdom implements none. */
function installAudio() {
  const played: string[] = [];
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public src: string) {}
    play() {
      played.push(this.src);
      return Promise.resolve();
    }
    pause() {}
    removeAttribute() {}
  }
  (window as unknown as { Audio: unknown }).Audio = FakeAudio;
  return played;
}

describe('VoiceSettingsPage (#288)', () => {
  const realAudio = (window as unknown as { Audio?: unknown }).Audio;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi();
  });

  afterEach(() => {
    (window as unknown as { Audio?: unknown }).Audio = realAudio;
  });

  // ===========================================================================
  // Every control, with a real label
  // ===========================================================================

  it('renders all six controls, each reachable by its accessible label', async () => {
    renderPage();

    expect(await findAutoSubmit()).toBeInTheDocument();
    expect(
      screen.getByLabelText('Read questions to me automatically'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Read the answer to me automatically'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Use the high-quality voice when it is available'),
    ).toBeInTheDocument();
    // The rate slider takes its accessible name from the heading it points at,
    // which is what a slider can have instead of a `<label>`.
    expect(screen.getByRole('slider', { name: 'Speaking speed' })).toBeInTheDocument();

    // The voice picker, once the catalog has landed.
    const group = await screen.findByRole('radiogroup', { name: 'Voice' });
    expect(within(group).getByRole('radio', { name: /Alloy/ })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: /Nova/ })).toBeInTheDocument();
  });

  it('puts the page under a single h1 that matches the registry card', async () => {
    renderPage();
    await findAutoSubmit();

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Voice');

    // The sections below it are h2s, not a second h1 and not a jump to h4.
    expect(
      screen.getByRole('heading', { level: 2, name: 'Answering out loud' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Reading aloud' }),
    ).toBeInTheDocument();
  });

  it('shows the built-in defaults for an untouched account without storing them', async () => {
    renderPage();

    expect(await findAutoSubmit()).toBeChecked();
    expect(
      screen.getByLabelText('Use the high-quality voice when it is available'),
    ).toBeChecked();
    expect(
      screen.getByLabelText('Read questions to me automatically'),
    ).not.toBeChecked();
    expect(
      screen.getByLabelText('Read the answer to me automatically'),
    ).not.toBeChecked();
    expect(
      (screen.getByRole('slider', { name: 'Speaking speed' }) as HTMLInputElement)
        .value,
    ).toBe('0.95');

    await screen.findByRole('radiogroup', { name: 'Voice' });

    // THE ASSERTION THIS TEST EXISTS FOR. A defaulted local object that a later
    // save serialises, or a save-on-mount, would show up here and nowhere else.
    expect(patchBodies).toEqual([]);
    expect(stored.voice).toBeUndefined();
  });

  // ===========================================================================
  // Round-tripping a change
  // ===========================================================================

  it('round-trips a toggle through PATCH /user-settings and shows it after a reload', async () => {
    const user = userEvent.setup();
    const first = renderPage();

    await user.click(await findAutoSubmit());

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    // ONE FIELD ON THE WIRE, never the whole namespace.
    expect(patchBodies[0]).toEqual({ voice: { autoSubmitSpoken: false } });
    expect(stored.voice).toEqual({ autoSubmitSpoken: false });

    // The control shows what the SERVER answered with, not an optimistic
    // overlay — the section re-renders from the PATCH response.
    await waitFor(async () =>
      expect(await findAutoSubmit()).not.toBeChecked(),
    );

    // A fresh mount reads it back, so the choice survived rather than only
    // having been displayed.
    first.unmount();
    renderPage();
    expect(await findAutoSubmit()).not.toBeChecked();
  });

  it('sends a NULL-DELETE when a control goes back to its built-in default', async () => {
    const user = userEvent.setup();
    mockApi({ voice: { readQuestionsAloud: true } });
    renderPage();

    const readQuestions = await screen.findByLabelText(
      'Read questions to me automatically',
    );
    expect(readQuestions).toBeChecked();

    await user.click(readQuestions);

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    // `null`, NOT `false`. Writing today's default back pins the learner to it
    // forever, including after a later release moves it.
    expect(patchBodies[0]).toEqual({ voice: { readQuestionsAloud: null } });
    expect(stored.voice).toBeUndefined();
  });

  it('stores a chosen voice, and deletes the field when the standard voice is chosen again', async () => {
    const user = userEvent.setup();
    renderPage();

    const group = await screen.findByRole('radiogroup', { name: 'Voice' });
    await user.click(within(group).getByRole('radio', { name: /Nova/ }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ voice: { preferredVoice: 'nova' } });

    await user.click(within(group).getByRole('radio', { name: /Standard/ }));
    await waitFor(() => expect(patchBodies).toHaveLength(2));
    expect(patchBodies[1]).toEqual({ voice: { preferredVoice: null } });
  });

  it('announces the result of a save in a region assistive technology reads', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await findAutoSubmit());

    // `UserSettingsSection`'s success snackbar. MUI's `SnackbarContent` carries
    // `role="alert"`, so the confirmation is announced rather than only shown.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Voice preferences updated',
    );
  });

  // ===========================================================================
  // Preview: an explicit press, and only an explicit press
  // ===========================================================================

  it('names the voice in the Preview control, not just "Preview"', async () => {
    renderPage();
    await screen.findByRole('radiogroup', { name: 'Voice' });

    expect(
      screen.getByRole('button', { name: 'Preview the Nova voice' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Preview the Alloy voice' }),
    ).toBeInTheDocument();
  });

  it('synthesizes on an explicit press, sending that voice id, and plays the result', async () => {
    const played = installAudio();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('radiogroup', { name: 'Voice' });
    await user.click(screen.getByRole('button', { name: 'Preview the Nova voice' }));

    await waitFor(() => expect(synthesizeBodies).toHaveLength(1));
    expect(synthesizeBodies[0]).toEqual({
      text: VOICE_PREVIEW_SENTENCE,
      voice: 'nova',
    });
    // A REAL CIVICS QUESTION, so the sample demonstrates the thing they will
    // actually hear.
    expect(VOICE_PREVIEW_SENTENCE).toBe(
      'Who is in charge of the executive branch?',
    );

    // Audio was produced, not merely requested.
    await waitFor(() => expect(played).toHaveLength(1));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Playing a sample in the Nova voice.',
    );
  });

  it('omits the voice key entirely for the standard-voice row', async () => {
    installAudio();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('radiogroup', { name: 'Voice' });
    await user.click(
      screen.getByRole('button', { name: 'Preview the Standard voice' }),
    );

    await waitFor(() => expect(synthesizeBodies).toHaveLength(1));
    // NOT `voice: ''` — `aiSynthesizeRequestSchema` is `.strict()` with `voice`
    // optional, so an empty string is a 400 while an absent key is "you choose".
    expect(synthesizeBodies[0]).toEqual({ text: VOICE_PREVIEW_SENTENCE });
  });

  it('synthesizes NOTHING on render, on focus, or on arrowing through the list', async () => {
    installAudio();
    const user = userEvent.setup();
    renderPage();

    const group = await screen.findByRole('radiogroup', { name: 'Voice' });

    // Rendering the list.
    expect(synthesizeBodies).toEqual([]);

    // Focusing a Preview button — the gesture a keyboard user makes on the way
    // past it.
    const novaPreview = screen.getByRole('button', {
      name: 'Preview the Nova voice',
    });
    novaPreview.focus();
    expect(document.activeElement).toBe(novaPreview);
    expect(synthesizeBodies).toEqual([]);

    // Arrowing through the radio group, which MOVES THE SELECTION and therefore
    // saves a preference — and must still make no audio.
    within(group).getByRole('radio', { name: /Standard/ }).focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(patchBodies.length).toBeGreaterThan(0));

    // THE ASSERTION THIS TEST EXISTS FOR. A picker that synthesizes as you move
    // through it is a picker that bills you for moving through it.
    expect(synthesizeBodies).toEqual([]);
  });

  it('does not fire twice when the Preview control is pressed twice in the same tick', async () => {
    installAudio();
    renderPage();

    await screen.findByRole('radiogroup', { name: 'Voice' });
    const preview = screen.getByRole('button', { name: 'Preview the Alloy voice' });

    // `fireEvent` TWICE WITH NO AWAIT BETWEEN, deliberately — that is the
    // window the ref guard exists for, and the one `userEvent` cannot
    // reproduce because it yields between clicks (long enough here for a
    // mocked round trip to complete, which a real one never would). The
    // `disabled` attribute covers everything slower than this; the ref covers
    // the double-fire that lands before React has re-rendered.
    fireEvent.click(preview);
    fireEvent.click(preview);

    await waitFor(() => expect(synthesizeBodies).toHaveLength(1));
    expect(synthesizeBodies).toHaveLength(1);
    expect(synthesizeBodies[0]).toEqual({
      text: VOICE_PREVIEW_SENTENCE,
      voice: 'alloy',
    });
  });

  it('handles a `failed` synthesis without crashing — the #277 lesson', async () => {
    installAudio();
    const user = userEvent.setup();
    mockApi({ synthesis: 'failed' });
    renderPage();

    await screen.findByRole('radiogroup', { name: 'Voice' });
    await user.click(screen.getByRole('button', { name: 'Preview the Nova voice' }));

    // Said plainly, in the live region, and the page is still standing: every
    // control still responds.
    expect(await screen.findByRole('status')).toHaveTextContent(
      /couldn't play the Nova sample/i,
    );
    expect(await findAutoSubmit()).toBeEnabled();

    await user.click(await findAutoSubmit());
    await waitFor(() => expect(patchBodies).toHaveLength(1));
  });

  // ===========================================================================
  // `speak` unbound is NOT a degraded state
  // ===========================================================================

  it('renders, keeps every toggle working, and shows NO warning when `speak` is unbound', async () => {
    const user = userEvent.setup();
    mockApi({ speakBound: false });
    renderPage();

    const autoSubmit = await findAutoSubmit();
    expect(autoSubmit).toBeEnabled();

    // The plain sentence, which is a statement of fact rather than a complaint.
    expect(
      screen.getByText(/No high-quality voice is set up on this deployment/i),
    ).toBeInTheDocument();

    // THE ABSENCE THIS TEST EXISTS FOR, asserted BEFORE any save — the success
    // snackbar is itself a `role="alert"`, so checking after a click would be
    // checking the wrong thing. `docs/specs/voice.md` §2: an unbound `speak` is
    // the ordinary state of a fresh install, so nothing may render as a
    // failure. `AiNotReady` names an administrator; a warning alert says
    // something is wrong. Neither is true here.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/administrator/i)).toBeNull();
    expect(screen.queryByText(/hasn't finished setting/i)).toBeNull();
    expect(document.querySelector('.MuiAlert-root')).toBeNull();

    // And no picker, because there is genuinely nothing to choose between.
    expect(screen.queryByRole('radiogroup', { name: 'Voice' })).toBeNull();

    // The toggles above still work, and still apply to the browser voice.
    await user.click(autoSubmit);
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ voice: { autoSubmitSpoken: false } });
  });

  // ===========================================================================
  // No user key — the ONE honest "you can fix this"
  // ===========================================================================

  it('offers to add a key when the learner has none, and links to the key page', async () => {
    mockApi({ userKeyConfigured: false });
    renderPage();

    await findAutoSubmit();

    const copy = await screen.findByText(/there is no key saved on your account yet/i);
    expect(copy).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'add a key' });
    expect(link).toHaveAttribute('href', '/settings/ai');

    // STILL NOT AN ERROR. Everything on the page keeps working — the browser
    // voice never needed a key.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await findAutoSubmit()).toBeEnabled();
  });

  it('says the same thing when a preview comes back `no_user_key`', async () => {
    installAudio();
    const user = userEvent.setup();
    mockApi({ synthesis: 'no_user_key' });
    renderPage();

    await screen.findByRole('radiogroup', { name: 'Voice' });
    await user.click(screen.getByRole('button', { name: 'Preview the Alloy voice' }));

    const status = await screen.findByRole('status');
    await waitFor(() =>
      expect(status).toHaveTextContent(/no key saved on your account yet/i),
    );
    expect(within(status).getByRole('link', { name: 'Add a key' })).toHaveAttribute(
      'href',
      '/settings/ai',
    );
  });

  it('says nothing remediable for an `unavailable` cause the learner cannot fix', async () => {
    installAudio();
    const user = userEvent.setup();
    mockApi({ synthesis: 'role_unbound' });
    renderPage();

    await screen.findByRole('radiogroup', { name: 'Voice' });
    await user.click(screen.getByRole('button', { name: 'Preview the Alloy voice' }));

    const status = await screen.findByRole('status');
    await waitFor(() =>
      expect(status).toHaveTextContent(/not available here/i),
    );
    // No remedy offered for something that is not theirs to remedy, and no
    // alert: the browser still reads everything aloud.
    expect(within(status).queryByRole('link')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

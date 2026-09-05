/**
 * `/settings/coach` — the persona picker and the reactions switch (#322,
 * epic #305).
 *
 * `useUserSettings` is REAL here, `UserSettingsSection` is real,
 * `CoachSettings` is real, and `GET`/`PATCH /api/user-settings`,
 * `GET /api/ai/coach/personas`, `GET /api/ai/speech/voices` and
 * `POST /api/ai/speech/synthesize` are all recorded MSW handlers. This suite
 * is about the REQUESTS — what is on the wire, and, for the tests that matter
 * most, what is not.
 *
 * WHAT THESE PIN, in order of what it would cost to get wrong:
 *
 *   1. HEARING A SAMPLE SPENDS THE LEARNER'S OWN KEY, so it fires on an
 *      explicit press and on nothing else. Rendering the list, focusing a
 *      button and arrowing through the radio group must synthesize NOTHING —
 *      a picker that speaks as you scroll bills you for scrolling.
 *   2. RENDERING WRITES NOTHING, and returning to `supportive` sends a
 *      NULL-DELETE. `coach` has no `.default()` on the server for a reason: a
 *      client that saves the default it renders pins a learner to today's
 *      value forever, invisibly, and only the people who actively chose it
 *      would be left behind if the default ever moved.
 *   3. EVERY SAMPLE IS READABLE WITHOUT A PRESS. For `unfiltered` in
 *      particular that is the difference between choosing a blunt coach and
 *      discovering one mid-session.
 *   4. AN UNBOUND `speak` IS NOT A FAILURE — the Hear controls are simply
 *      absent and everything else works. The assertion is an ABSENCE, the kind
 *      of regression that arrives as a well-meaning warning banner.
 *   5. A `failed`/`unavailable` synthesis is handled by switching on `status`
 *      rather than assumed away — issue #277, the shipped bug where a client
 *      read the `ok` member without checking.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import CoachSettingsPage from '../../pages/CoachSettingsPage';
import type { UserSettings } from '../../types';

const API_BASE = '*/api';

/** The stored document, mutated by the PATCH handler so a reload can see it. */
let stored: UserSettings;

/** Every `PATCH /user-settings` body, in order. THE SPY THIS SUITE TURNS ON. */
let patchBodies: Array<Record<string, unknown>>;

/** Every `POST /ai/speech/synthesize` body, in order. THE OTHER SPY. */
let synthesizeBodies: Array<Record<string, unknown>>;

/**
 * The four personas as the endpoint serves them — FOUR FIELDS, never five.
 * The fixture omits `promptFragment` because the real response does; a
 * fixture that carried it would let a leak pass unnoticed here.
 */
const PERSONAS = [
  {
    key: 'supportive' as const,
    label: 'Supportive',
    description: 'Warm, specific, and honest.',
    sampleLine: 'Not quite right — but you can get it next time.',
  },
  {
    key: 'academic' as const,
    label: 'Academic',
    description: 'Precise and formal.',
    sampleLine: 'Not accepted. Compare your response with the recorded answer.',
  },
  {
    key: 'playful' as const,
    label: 'Playful',
    description: 'Light and quick, with a sense of humour.',
    sampleLine: 'Nope! Bold answer though.',
  },
  {
    key: 'unfiltered' as const,
    label: 'Unfiltered',
    description: 'Blunt and irreverent.',
    sampleLine: 'That answer was a mess. The right one is on the screen.',
  },
];

interface Options {
  /** Has an admin bound `speak`? Defaults to yes. */
  speakBound?: boolean;
  /** What `POST /ai/speech/synthesize` answers. Defaults to audio bytes. */
  synthesis?: 'audio' | 'failed' | 'no_user_key' | 'role_unbound';
  /** A pre-existing `coach` namespace. Absent is the normal case. */
  coach?: UserSettings['coach'];
  /** Make `GET /ai/coach/personas` fail outright. */
  personasFail?: boolean;
}

function mockApi(options: Options = {}) {
  stored = {
    theme: 'system',
    profile: { useProviderImage: true },
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
    ...(options.coach ? { coach: options.coach } : {}),
  };
  patchBodies = [];
  synthesizeBodies = [];

  const speakBound = options.speakBound ?? true;

  server.use(
    http.get(`${API_BASE}/ai/coach/personas`, () =>
      options.personasFail
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.json({ data: { personas: PERSONAS } }),
    ),

    http.get(`${API_BASE}/ai/speech/voices`, () =>
      HttpResponse.json({
        data: {
          voices: speakBound
            ? [{ id: 'alloy', label: 'Alloy', description: 'Even and neutral.' }]
            : [],
          speakBound,
          defaultVoice: speakBound ? 'alloy' : null,
        },
      }),
    ),

    http.post(`${API_BASE}/ai/speech/synthesize`, async ({ request }) => {
      synthesizeBodies.push((await request.json()) as Record<string, unknown>);

      // HTTP 200 CARRYING A CAUSE, never a 4xx for an AI reason — the shape
      // the controller actually answers with, and the point of #277's lesson.
      if (options.synthesis === 'failed') {
        return HttpResponse.json({
          data: {
            status: 'failed',
            errorCode: 'provider_error',
            error: 'The provider refused the request.',
          },
        });
      }
      if (
        options.synthesis === 'no_user_key' ||
        options.synthesis === 'role_unbound'
      ) {
        return HttpResponse.json({
          data: { status: 'unavailable', cause: options.synthesis, role: 'speak' },
        });
      }

      return HttpResponse.arrayBuffer(new ArrayBuffer(8), {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),

    http.get(`${API_BASE}/user-settings`, () =>
      HttpResponse.json({ data: stored }),
    ),

    http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patchBodies.push(body);

      // Field-wise merge with `null` as DELETE — what `mergeCoach` does on the
      // server. Modelled rather than shortcut to a spread, so a test that
      // sends a null-delete gets the ABSENCE back on the next read exactly as
      // it would from the real API.
      if ('coach' in body) {
        const patch = body.coach as Record<string, unknown> | null;
        if (patch === null) {
          delete stored.coach;
        } else {
          const next = { ...(stored.coach ?? {}) } as Record<string, unknown>;
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) delete next[key];
            else next[key] = value;
          }
          stored.coach =
            Object.keys(next).length > 0
              ? (next as UserSettings['coach'])
              : undefined;
        }
      }

      stored = { ...stored, version: stored.version + 1 };
      return HttpResponse.json({ data: stored });
    }),
  );
}

function renderPage() {
  return render(<CoachSettingsPage />);
}

/**
 * The reactions switch.
 *
 * BY LABEL TEXT, not by role and name — the convention
 * `VoiceSettingsPage.test.tsx` already uses for every switch on that page.
 * MUI associates a `FormControlLabel`'s text with the control it wraps in a
 * way `getByLabelText` resolves and a role+name query does not.
 */
async function findReactionsToggle(): Promise<HTMLInputElement> {
  return (await screen.findByLabelText(
    'Show a line from your coach',
  )) as HTMLInputElement;
}

/** Resolves once the four persona cards are on screen. */
async function waitForPersonas() {
  await waitFor(() => {
    expect(screen.getByRole('radio', { name: /Supportive/ })).toBeInTheDocument();
  });
}

describe('CoachSettingsPage', () => {
  beforeEach(() => {
    mockApi();
  });

  describe('the persona picker', () => {
    it('renders every persona, each reachable by its own label', async () => {
      renderPage();
      await waitForPersonas();

      for (const persona of PERSONAS) {
        expect(
          screen.getByRole('radio', { name: new RegExp(persona.label) }),
        ).toBeInTheDocument();
      }
    });

    it('selects supportive for an untouched account, and stores nothing for it', async () => {
      renderPage();
      await waitForPersonas();

      expect(screen.getByRole('radio', { name: /Supportive/ })).toBeChecked();

      // RENDERING WRITES NOTHING. A page that saved the default it displayed
      // would materialise a preference nobody chose.
      expect(patchBodies).toEqual([]);
      expect(stored.coach).toBeUndefined();
    });

    it('shows every sample line without any press at all', async () => {
      renderPage();
      await waitForPersonas();

      for (const persona of PERSONAS) {
        expect(
          screen.getByText(new RegExp(persona.sampleLine.slice(0, 20))),
        ).toBeInTheDocument();
      }

      // And reading them cost nothing.
      expect(synthesizeBodies).toEqual([]);
    });

    it('saves a chosen persona', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitForPersonas();

      await user.click(screen.getByRole('radio', { name: /Playful/ }));

      await waitFor(() => {
        expect(patchBodies).toEqual([{ coach: { persona: 'playful' } }]);
      });
    });

    it('sends a null-delete when returning to supportive', async () => {
      const user = userEvent.setup();
      mockApi({ coach: { persona: 'unfiltered' } });
      renderPage();
      await waitForPersonas();

      expect(screen.getByRole('radio', { name: /Unfiltered/ })).toBeChecked();

      await user.click(screen.getByRole('radio', { name: /Supportive/ }));

      // `null`, NEVER `'supportive'`. Writing the default explicitly would
      // pin this learner to it even after a future change moved it.
      await waitFor(() => {
        expect(patchBodies).toEqual([{ coach: { persona: null } }]);
      });

      // And the namespace collapsed back to absent, as the server does.
      await waitFor(() => expect(stored.coach).toBeUndefined());
    });

    it('falls back to supportive for a stored persona this build does not know', async () => {
      // A newer build may have written a fifth key into the JSONB column. The
      // page must still render rather than showing an empty radio group.
      mockApi({
        coach: { persona: 'sardonic' as unknown as 'supportive' },
      });
      renderPage();
      await waitForPersonas();

      expect(screen.getByRole('radio', { name: /Supportive/ })).toBeChecked();
    });
  });

  describe('hearing a sample', () => {
    it('synthesizes NOTHING on render, on focus, or on arrowing through the list', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitForPersonas();

      // Rendering.
      expect(synthesizeBodies).toEqual([]);

      // Focus.
      const hearButtons = screen.getAllByRole('button', { name: /^Hear the/ });
      hearButtons[0].focus();
      expect(synthesizeBodies).toEqual([]);

      // Arrowing through the group — a picker that spoke here would bill a
      // learner for scrolling.
      screen.getByRole('radio', { name: /Supportive/ }).focus();
      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');
      expect(synthesizeBodies).toEqual([]);
    });

    it('synthesizes exactly the persona’s sample line on an explicit press', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitForPersonas();

      await user.click(
        screen.getByRole('button', { name: 'Hear the Playful sample' }),
      );

      await waitFor(() => expect(synthesizeBodies).toHaveLength(1));
      expect(synthesizeBodies[0]).toMatchObject({
        text: PERSONAS[2].sampleLine,
      });
    });

    it('names the persona in each button’s accessible name', async () => {
      renderPage();
      await waitForPersonas();

      // "Hear" alone would be four identical buttons to somebody listening to
      // the page rather than looking at it.
      for (const persona of PERSONAS) {
        expect(
          screen.getByRole('button', { name: `Hear the ${persona.label} sample` }),
        ).toBeInTheDocument();
      }
    });

    it('says something useful when the learner has no key', async () => {
      const user = userEvent.setup();
      mockApi({ synthesis: 'no_user_key' });
      renderPage();
      await waitForPersonas();

      await user.click(
        screen.getByRole('button', { name: 'Hear the Academic sample' }),
      );

      const status = await screen.findByRole('status');
      await waitFor(() => {
        expect(status).toHaveTextContent(/no key saved on your account/i);
      });
      // And it points somewhere the learner can act.
      expect(screen.getByRole('link', { name: 'Add a key' })).toBeInTheDocument();
    });

    it('handles an unavailable role without claiming the page is broken', async () => {
      const user = userEvent.setup();
      mockApi({ synthesis: 'role_unbound' });
      renderPage();
      await waitForPersonas();

      await user.click(
        screen.getByRole('button', { name: 'Hear the Supportive sample' }),
      );

      const status = await screen.findByRole('status');
      await waitFor(() => {
        expect(status).toHaveTextContent(/not available here/i);
      });
      // The written coach still works, and the copy says so.
      expect(status).toHaveTextContent(/still/i);
    });

    it('handles a failed synthesis', async () => {
      const user = userEvent.setup();
      mockApi({ synthesis: 'failed' });
      renderPage();
      await waitForPersonas();

      await user.click(
        screen.getByRole('button', { name: 'Hear the Playful sample' }),
      );

      const status = await screen.findByRole('status');
      await waitFor(() => {
        expect(status).toHaveTextContent(/couldn’t play the Playful sample/i);
      });
    });
  });

  describe('when `speak` is unbound', () => {
    it('omits the Hear controls and keeps everything else working', async () => {
      const user = userEvent.setup();
      mockApi({ speakBound: false });
      renderPage();
      await waitForPersonas();

      // ABSENT, not disabled: a control a learner cannot act on is worse than
      // no control, and the page is complete without it.
      expect(screen.queryByRole('button', { name: /^Hear the/ })).toBeNull();

      // NOT AN ERROR. `voice.md` §2 — an unbound `speak` is the ordinary
      // state of a fresh install, so nothing may say otherwise.
      expect(screen.queryByRole('alert')).toBeNull();

      // Every sample is still readable.
      expect(
        screen.getByText(new RegExp(PERSONAS[3].sampleLine.slice(0, 20))),
      ).toBeInTheDocument();

      // And choosing still saves.
      await user.click(screen.getByRole('radio', { name: /Academic/ }));
      await waitFor(() => {
        expect(patchBodies).toEqual([{ coach: { persona: 'academic' } }]);
      });
    });
  });

  describe('when the persona list cannot be loaded', () => {
    it('says so, rather than showing an empty choice', async () => {
      mockApi({ personasFail: true });
      renderPage();

      // Reported, unlike the voice list: with no personas there is nothing to
      // choose from, and an empty group would read as "this account has no
      // options" rather than "we could not load them".
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/couldn’t load the coach voices/i);
      expect(alert).toHaveTextContent(/still works/i);
    });
  });

  describe('the reactions switch', () => {
    it('is on for an untouched account and stores nothing', async () => {
      renderPage();
      await waitForPersonas();

      expect(
        await findReactionsToggle(),
      ).toBeChecked();
      expect(patchBodies).toEqual([]);
    });

    it('round-trips off and back to on, the second write being a null-delete', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitForPersonas();

      const toggle = await findReactionsToggle();

      await user.click(toggle);
      await waitFor(() => {
        expect(patchBodies).toEqual([{ coach: { reactions: false } }]);
      });
      await waitFor(() => expect(stored.coach).toEqual({ reactions: false }));

      await user.click(await findReactionsToggle());
      await waitFor(() => {
        expect(patchBodies).toEqual([
          { coach: { reactions: false } },
          { coach: { reactions: null } },
        ]);
      });
      await waitFor(() => expect(stored.coach).toBeUndefined());
    });

    it('keeps the persona when the switch changes', async () => {
      const user = userEvent.setup();
      mockApi({ coach: { persona: 'playful' } });
      renderPage();
      await waitForPersonas();

      await user.click(await findReactionsToggle());

      // ONE FIELD PER WRITE — the request names `reactions` only, and the
      // server's field-wise merge leaves `persona` exactly as it was.
      await waitFor(() => {
        expect(patchBodies).toEqual([{ coach: { reactions: false } }]);
      });
      await waitFor(() =>
        expect(stored.coach).toEqual({ persona: 'playful', reactions: false }),
      );
    });
  });

  describe('the page itself', () => {
    it('states that the choice does not affect scoring', async () => {
      renderPage();
      await waitForPersonas();

      // The sentence a learner most needs and is least likely to assume.
      expect(
        screen.getByText(/never changes whether an answer counts as correct/i),
      ).toBeInTheDocument();
    });

    it('does not preselect or recommend unfiltered', async () => {
      renderPage();
      await waitForPersonas();

      expect(screen.getByRole('radio', { name: /Unfiltered/ })).not.toBeChecked();

      // It is one card among four, in registry order, and it is last.
      const radios = screen.getAllByRole('radio');
      expect(radios).toHaveLength(4);
      expect(radios[0]).toBeChecked();
      expect(
        within(radios[3].closest('label')?.parentElement ?? document.body).getByText(
          /Blunt and irreverent/,
        ),
      ).toBeInTheDocument();
    });
  });
});

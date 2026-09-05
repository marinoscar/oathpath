/**
 * The voice degradation matrix (issue #289, epic #280 / E12).
 *
 * =============================================================================
 * WHY THIS FILE, WHEN `useVoiceAvailability.test.tsx` AND
 * `PracticeSessionPage.voice.test.tsx` ALREADY EXIST
 * =============================================================================
 *
 * Neither sibling proves the CROSS PRODUCT. `useVoiceAvailability.test.tsx`
 * proves the hook reads `unboundRoles` correctly in isolation, with
 * `userKeyConfigured` never varied at all (the hook does not read it — see its
 * own header, "AN UNKNOWN STATUS RESOLVES TO..."). `PracticeSessionPage.voice.test.tsx`
 * exercises `transcribeBound: false` and a `no_user_key` transcription result
 * as SEPARATE scenarios. Nothing anywhere renders the actual page across all
 * eight combinations of (`transcribe` bound/unbound) x (`speak` bound/unbound)
 * x (a learner's own key present/absent) and checks the three claims together:
 *
 *   1. The microphone is HIDDEN, never a disabled button, when `transcribe`
 *      is unbound — in every cell, regardless of `speak` or the learner's key.
 *   2. NOTHING WARNS about an unbound `speak` — not in any cell. `voice.md`
 *      §2 is explicit that this is not a degraded state, and the shared
 *      `VoiceUnavailableNotice` is hard-coded to `role="transcribe"` with no
 *      way to spell a `speak` equivalent (see that component's own header) —
 *      this file is the assertion that guards the CONSEQUENCE of that
 *      hard-coding at the one screen that renders it.
 *   3. TYPING ALWAYS WORKS. The answer field is present and accepts input in
 *      every one of the eight cells — a learner is never left with no way to
 *      answer at all.
 *
 * `userKeyConfigured` is included as a full axis even though
 * `RequireAiKey` (`App.tsx`) ordinarily keeps a keyless learner from ever
 * reaching this page in production: the claim under test is about what THIS
 * PAGE does with the `AiStatus` it is handed, not about how a learner comes to
 * hold one, and a hook/page that silently started keying the microphone's
 * visibility off `userKeyConfigured` would be a real regression this route
 * guard does not protect against (a stale status cached from before the
 * learner added a key, for instance).
 *
 * `AI_PROVIDER_FAKE` is not used here: every claim under test is about how the
 * PAGE renders a given `AiStatus`, not about the dispatcher or a provider
 * behind it — exactly the boundary the rest of this suite already draws
 * between `apps/api/test/ai-speech.integration.spec.ts` (the server, for
 * real) and this file (the client, against a mocked status).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CssBaseline, ThemeProvider } from '@mui/material';

import { server } from '../mocks/server';
import { mockUser } from '../utils/test-utils';
import { AuthContext } from '../../contexts/AuthContext';
import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { lightTheme } from '../../theme';
import PracticeSessionPage from '../../pages/PracticeSessionPage';
import type {
  AiStatus,
  PracticeQuestion,
  PracticeSession,
  PracticeSessionDetail,
} from '../../types';

// -----------------------------------------------------------------------------
// A fake browser voice, installed for every test in this file.
// -----------------------------------------------------------------------------
//
// LOAD-BEARING FOR THE `speak`-TOGGLING TESTS BELOW, not incidental. Without
// it jsdom has no `speechSynthesis` at all, `QuestionAudio`'s own
// `browserSpeechAvailable()` is false, and its read-aloud button then renders
// or vanishes as a SIDE EFFECT of `speakBound` (that component derives
// `usePremium = premiumVoice && speakBound` itself, and "neither voice
// available" is exactly the absent-control rule its own header states) —
// which would make the "toggling `speak` changes nothing" test below fail for
// a reason that has nothing to do with a WARNING and everything to do with an
// environment missing a browser API every real deployment has. Installing the
// fake keeps the browser path always reachable, which is what isolates the
// actual claim: with a working browser voice on both sides, `speakBound`
// toggling the PREMIUM path on or off must render no visible difference at
// all — no alert, no notice, not even the read-aloud button changing shape.
function installSpeechSynthesis() {
  Object.defineProperty(window, 'speechSynthesis', {
    value: { cancel: () => {}, speak: () => {} },
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

const API_BASE = '*/api';
const SESSION_ID = 'session-1';

const QUESTION_1: PracticeQuestion = {
  id: 'question-1',
  number: 1,
  prompt: 'What is the supreme law of the land?',
  categoryId: 'category-1',
  dynamicScope: 'none',
};

const SESSION_BASE: PracticeSession = {
  id: SESSION_ID,
  kind: 'quick',
  status: 'in_progress',
  testVersionCode: 'v2008',
  categoryId: null,
  plannedCount: 5,
  startedAt: '2026-03-01T12:00:00.000Z',
  completedAt: null,
  summary: null,
};

const DETAIL: PracticeSessionDetail = {
  session: SESSION_BASE,
  nextQuestion: QUESTION_1,
  progress: { answered: 0, planned: 5 },
  attempts: [],
};

interface Cell {
  transcribeBound: boolean;
  speakBound: boolean;
  userKeyConfigured: boolean;
}

function renderPage(cell: Cell) {
  const unboundRoles: string[] = [
    ...(cell.transcribeBound ? [] : ['transcribe']),
    ...(cell.speakBound ? [] : ['speak']),
  ];

  const status: AiStatus = {
    userKeyConfigured: cell.userKeyConfigured,
    // Deliberately independent of the cell — `systemReady` is a statement
    // about the TEXT roles (`tutor`/`grader`) only, and `useVoiceAvailability`
    // ignores it entirely (see the hook's own header).
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    unboundRoles,
  };

  server.use(
    http.get(`${API_BASE}/user-settings`, () =>
      HttpResponse.json({
        data: {
          theme: 'system',
          profile: { useProviderImage: true, customImageUrl: null },
          updatedAt: '2026-03-01T00:00:00.000Z',
          version: 1,
        },
      }),
    ),
    http.get(`${API_BASE}/ai/status`, () => HttpResponse.json({ data: status })),
    http.get(`${API_BASE}/practice/sessions/${SESSION_ID}`, () =>
      HttpResponse.json({ data: DETAIL }),
    ),
  );

  const auth = {
    user: mockUser,
    isLoading: false,
    isAuthenticated: true,
    providers: [],
    login: () => {},
    logout: () => {},
    refreshUser: () => Promise.resolve(),
  };

  return render(
    <ThemeProvider theme={lightTheme}>
      <CssBaseline />
      <AuthContext.Provider value={auth as never}>
        <AiStatusProvider>
          <MemoryRouter initialEntries={[`/practice/sessions/${SESSION_ID}`]}>
            <Routes>
              <Route path="/practice/sessions/:id" element={<PracticeSessionPage />} />
            </Routes>
          </MemoryRouter>
        </AiStatusProvider>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  installSpeechSynthesis();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
});

// Every one of the eight cells, named so a failure reads as a fact rather
// than an index.
const CELLS: Array<[string, Cell]> = [
  ['transcribe bound, speak bound, key present', { transcribeBound: true, speakBound: true, userKeyConfigured: true }],
  ['transcribe bound, speak bound, key absent', { transcribeBound: true, speakBound: true, userKeyConfigured: false }],
  ['transcribe bound, speak unbound, key present', { transcribeBound: true, speakBound: false, userKeyConfigured: true }],
  ['transcribe bound, speak unbound, key absent', { transcribeBound: true, speakBound: false, userKeyConfigured: false }],
  ['transcribe unbound, speak bound, key present', { transcribeBound: false, speakBound: true, userKeyConfigured: true }],
  ['transcribe unbound, speak bound, key absent', { transcribeBound: false, speakBound: true, userKeyConfigured: false }],
  ['transcribe unbound, speak unbound, key present', { transcribeBound: false, speakBound: false, userKeyConfigured: true }],
  ['transcribe unbound, speak unbound, key absent', { transcribeBound: false, speakBound: false, userKeyConfigured: false }],
];

describe('the voice degradation matrix — all eight (transcribe x speak x key) cells', () => {
  it.each(CELLS)('%s: mic follows transcribeBound alone', async (_label, cell) => {
    renderPage(cell);

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });

    // `Voice` since #313 (epic #304 / E13) — the session-wide picker replaced
    // the per-question `Type | Speak` toggle. The claim under test is unchanged
    // and is the one `conversation-mode.md` §10's degradation row states: with
    // `transcribe` unbound the option is ABSENT, never a disabled button.
    const speakButton = screen.queryByRole('button', { name: /^voice$/i });

    if (cell.transcribeBound) {
      // PRESENT, not merely enabled — the claim is that the control exists at
      // all, exactly as `PracticeSessionPage.tsx`'s own comment states: a Voice
      // option on a deployment with no `transcribe` model bound would be a dead
      // affordance beside a notice explaining that it is dead.
      expect(speakButton).not.toBeNull();
      expect(speakButton).toBeEnabled();
    } else {
      // ABSENT, never a disabled button sitting there unusable.
      expect(speakButton).toBeNull();
    }
  });

  // `transcribeBound` legitimately renders a notice when it is false (the
  // shared `AiNotReady`/`VoiceUnavailableNotice` copy, covered by
  // `PracticeSessionPage.voice.test.tsx` and `VoiceUnavailableNotice.test.tsx`
  // already) — that alert is about `transcribe`, and this test must not
  // mistake it for a `speak` warning. So the claim under test is stated as a
  // DIFFERENCE, not an absolute: holding `transcribeBound` and
  // `userKeyConfigured` fixed, toggling `speakBound` must change NOTHING on
  // the page — no new alert, no new text, nothing. That is a stronger and
  // more direct proof that "nothing warns about `speak`" than grepping for
  // words the copy happens to use today.
  const TRANSCRIBE_KEY_PAIRS: Array<[string, boolean, boolean]> = [
    ['transcribe bound, key present', true, true],
    ['transcribe bound, key absent', true, false],
    ['transcribe unbound, key present', false, true],
    ['transcribe unbound, key absent', false, false],
  ];

  it.each(TRANSCRIBE_KEY_PAIRS)(
    '%s: toggling `speak` bound/unbound renders byte-identical text',
    async (_label, transcribeBound, userKeyConfigured) => {
      const bound = renderPage({ transcribeBound, userKeyConfigured, speakBound: true });
      await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
      const boundText = bound.container.textContent;
      bound.unmount();

      const unbound = renderPage({ transcribeBound, userKeyConfigured, speakBound: false });
      await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
      const unboundText = unbound.container.textContent;
      unbound.unmount();

      expect(unboundText).toEqual(boundText);
    },
  );

  it.each(CELLS)('%s: no alert ever names `speak`', async (_label, cell) => {
    renderPage(cell);

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });

    // The one alert this page can show at mount is `transcribe`'s own —
    // asserted on directly rather than assumed absent, so this test still
    // means something in the cells where it legitimately renders.
    for (const alert of screen.queryAllByRole('alert')) {
      expect(alert.textContent).not.toMatch(/speak/i);
      expect(alert.textContent).not.toMatch(/premium voice/i);
    }
  });

  it.each(CELLS)('%s: typing still works', async (_label, cell) => {
    const user = userEvent.setup();
    renderPage(cell);

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });

    const field = screen.getByLabelText(/your answer/i) as HTMLInputElement;
    expect(field).toBeEnabled();

    await user.type(field, 'the Constitution');

    expect(field.value).toBe('the Constitution');
  });
});

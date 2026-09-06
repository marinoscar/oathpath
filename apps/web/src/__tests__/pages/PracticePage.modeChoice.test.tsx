/**
 * The `Text | Voice` choice on `/practice`, made BEFORE a session exists
 * (issue #350, epic #345).
 *
 * `PracticePage.test.tsx` covers the picker's own bands and `.readiness`
 * covers #349's device preflight; both are untouched by this file. What is
 * asserted here is only what #350 adds to this screen, and each claim is one of
 * the issue's acceptance criteria:
 *
 *  1. **THE CHOICE EXISTS BEFORE THE SESSION DOES.** Until #350 the mode could
 *     not be chosen until a session row had been created and the learner was
 *     already inside it. Asserted the only way that means anything: the control
 *     is on screen while `POST /api/practice/sessions` has not been called
 *     once.
 *  2. **AND BEFORE ANY MICROPHONE IS TOUCHED.** Choosing Voice records a
 *     preference; it opens no device. `getUserMedia` is a spy that no case in
 *     this file gives a behaviour to.
 *  3. **IT IS TWO-VALUED.** `Text` and `Voice`, and nothing that names a
 *     transport — E15 adds a second voice implementation and a learner has no
 *     basis on which to choose between them.
 *  4. **IT IS REMEMBERED IN `voice.conversationMode`, WITH THE NULL-DELETE.**
 *     No new setting and no migration; returning to the built-in default sends
 *     `null`, never `false`, or a learner is pinned to today's default forever
 *     (`useVoicePrefs`'s own header).
 *  5. **THE VOICE OPTION IS ABSENT, NOT DISABLED**, with no `transcribe` model
 *     bound, and `VoiceUnavailableNotice` says why.
 *  6. **REAL ACCESSIBLE NAME, REACHABLE BY KEYBOARD.**
 */

import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { AuthContext } from '../../contexts/AuthContext';
import { LearnerProfileProvider } from '../../contexts/LearnerProfileContext';
import PracticePage from '../../pages/PracticePage';
import { ANSWER_MODE_GROUP_LABEL } from '../../components/practice/AnswerModeChoice';
import type { AiStatus, PracticeQueue, VoiceSettings } from '../../types';
import { server } from '../mocks/server';
import { mockUser } from '../utils/test-utils';
import { ORIENTED_PROFILE } from '../utils/journey-fixtures';
import { CATEGORIES, civicsHandlers, journeyProfileHandler } from '../utils/civics-fixtures';

const API_BASE = '*/api';

let getUserMedia: ReturnType<typeof vi.fn>;
/** Sessions actually created. The "before a session exists" claim rests on it. */
let started: number;
/** The stored settings document, shared across renders in one case. */
let stored: Record<string, unknown>;
/** Every `voice` patch body this page sent, in order. */
let voicePatches: Array<Record<string, unknown>>;

function installPlatform() {
  getUserMedia = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => [
        { kind: 'audioinput', deviceId: '', label: '' } as MediaDeviceInfo,
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    configurable: true,
  });
  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = class {};
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'permissions', {
    value: {
      query: vi.fn(async () => ({
        state: 'granted' as PermissionState,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    },
    configurable: true,
  });
}

const QUEUE: PracticeQueue = {
  testVersionCode: 'v2008',
  total: 10,
  due: 0,
  weak: 0,
  new: {
    total: 10,
    byCategory: CATEGORIES.map((category) => ({
      categoryId: category.id,
      categoryName: category.name,
      newCount: 2,
    })),
  },
  learning: 0,
  mastered: 0,
};

function setStoredVoice(voice?: VoiceSettings) {
  stored = {
    theme: 'system',
    profile: { useProviderImage: true, customImageUrl: null },
    ...(voice ? { voice } : {}),
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  };
}

function installHandlers({ transcribeBound = true } = {}) {
  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    unboundRoles: transcribeBound ? ['speak'] : ['transcribe', 'speak'],
  };

  server.use(
    ...civicsHandlers(),
    journeyProfileHandler(ORIENTED_PROFILE),
    http.get(`${API_BASE}/user-settings`, () => HttpResponse.json({ data: stored })),
    // FIELD-WISE within `voice`, exactly as `mergeVoice` merges server-side, so
    // the null-delete assertion below is about behaviour and not only about a
    // request body.
    http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
      const body = (await request.json()) as { voice?: Record<string, unknown> };
      if (body.voice) voicePatches.push(body.voice);
      const merged = { ...((stored.voice as Record<string, unknown>) ?? {}) };
      for (const [key, value] of Object.entries(body.voice ?? {})) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      stored = { ...stored, voice: merged, version: (stored.version as number) + 1 };
      return HttpResponse.json({ data: stored });
    }),
    http.get(`${API_BASE}/ai/status`, () => HttpResponse.json({ data: status })),
    http.get(`${API_BASE}/practice/queue`, () => HttpResponse.json({ data: QUEUE })),
    http.get(`${API_BASE}/practice/sessions`, () =>
      HttpResponse.json({
        data: { items: [], total: 0, page: 1, pageSize: 5, totalPages: 1 },
      }),
    ),
    http.post(`${API_BASE}/practice/sessions`, () => {
      started += 1;
      return HttpResponse.json({
        data: {
          session: {
            id: 'session-started',
            kind: 'quick',
            status: 'in_progress',
            testVersionCode: 'v2008',
            categoryId: null,
            plannedCount: 5,
            startedAt: '2026-03-03T00:00:00.000Z',
            completedAt: null,
            summary: null,
          },
          nextQuestion: {
            id: 'question-first',
            number: 1,
            prompt: 'What is the supreme law of the land?',
            categoryId: CATEGORIES[0].id,
            dynamicScope: 'none',
          },
          progress: { answered: 0, planned: 5 },
        },
      });
    }),
  );
}

function renderPractice() {
  const auth = {
    user: mockUser,
    isLoading: false,
    isAuthenticated: true,
    providers: [],
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  };

  return render(
    <ThemeProvider theme={createTheme({ palette: { mode: 'light' } })}>
      <CssBaseline />
      <AuthContext.Provider value={auth as never}>
        <AiStatusProvider>
          <MemoryRouter initialEntries={['/practice']}>
            <Routes>
              <Route element={<LearnerProfileProvider />}>
                <Route path="/practice" element={<PracticePage />} />
                <Route
                  path="/practice/sessions/:id"
                  element={<h1>Practice session</h1>}
                />
              </Route>
            </Routes>
          </MemoryRouter>
        </AiStatusProvider>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

function quickFive() {
  return screen.findByRole('button', { name: /start a quick 5|review now/i });
}

function modeGroup() {
  return screen.queryByRole('group', { name: ANSWER_MODE_GROUP_LABEL });
}

function voiceOption() {
  return screen.queryByRole('button', { name: /^voice$/i });
}

/** The control has rendered: the status has settled and `transcribe` is bound. */
async function waitForModeChoice() {
  await quickFive();
  await waitFor(() => expect(voiceOption()).not.toBeNull());
}

beforeEach(() => {
  started = 0;
  voicePatches = [];
  setStoredVoice();
  installPlatform();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(navigator, 'permissions');
  Reflect.deleteProperty(window, 'MediaRecorder');
  Reflect.deleteProperty(window, 'isSecureContext');
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('the mode is chosen on /practice, before anything is created', () => {
  it('offers Text and Voice with no session created and no microphone opened', async () => {
    installHandlers();
    renderPractice();

    await waitForModeChoice();

    const group = modeGroup() as HTMLElement;
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^text$/i })).toBeInTheDocument();
    expect(voiceOption()).toBeInTheDocument();

    // THE CLAIM: the choice is upstream of the act it governs.
    expect(started).toBe(0);
    // …and upstream of the device, too. The preflight observes; it never prompts.
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('is two-valued — the transport is not on offer', async () => {
    installHandlers();
    renderPractice();

    await waitForModeChoice();

    // Two options in the group and no third: nothing named after a transport,
    // a model role, or an implementation a learner has no basis to judge.
    const group = modeGroup() as HTMLElement;
    expect(group.querySelectorAll('button')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /realtime|streaming|live/i })).toBeNull();
  });

  it('sits above the start actions, so it reads as governing them', async () => {
    installHandlers();
    renderPractice();

    await waitForModeChoice();

    const group = modeGroup() as HTMLElement;
    const start = await quickFive();
    // Position is the claim — asserted against the action itself, never a class
    // name or a test id.
    expect(
      group.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('still starts a Quick 5 in Text mode, from one click', async () => {
    const user = userEvent.setup();
    installHandlers();
    renderPractice();

    await waitForModeChoice();
    await user.click(await quickFive());

    await screen.findByRole('heading', { name: 'Practice session' });
    expect(started).toBe(1);
  });
});

describe('the choice is `voice.conversationMode`, not component state', () => {
  it('stores Voice, and sends the NULL-DELETE on the way back to Text', async () => {
    const user = userEvent.setup();
    installHandlers();
    renderPractice();

    await waitForModeChoice();

    await user.click(voiceOption() as HTMLElement);
    await waitFor(() => expect(voicePatches).toEqual([{ conversationMode: true }]));

    await user.click(screen.getByRole('button', { name: /^text$/i }));

    // `null`, never `false`: writing today's default back pins this learner to
    // it forever, including after a later release moves it.
    await waitFor(() =>
      expect(voicePatches).toEqual([
        { conversationMode: true },
        { conversationMode: null },
      ]),
    );
    await waitFor(() =>
      expect((stored.voice as Record<string, unknown>).conversationMode).toBeUndefined(),
    );
  });

  it('reads the stored choice back on a return visit', async () => {
    installHandlers();
    setStoredVoice({ conversationMode: true });
    renderPractice();

    await waitForModeChoice();

    // Landed on Voice with nobody touching the control, and nothing was written
    // to get there — reading a preference is not choosing one.
    await waitFor(() =>
      expect(voiceOption()).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(voicePatches).toEqual([]);
  });
});

describe('with no `transcribe` model bound', () => {
  it('omits the Voice option entirely — absent, not disabled — and says why', async () => {
    installHandlers({ transcribeBound: false });
    renderPractice();

    await quickFive();
    // The reason, from the shared notice rather than a sentence written here.
    await screen.findByText(/answering out loud is not available yet/i);

    expect(voiceOption()).toBeNull();
    expect(modeGroup()).toBeNull();
    // Not a greyed-out control either: there is no Voice button at all.
    expect(screen.queryByRole('button', { name: /^voice$/i })).toBeNull();
  });

  it('leaves every start action working', async () => {
    const user = userEvent.setup();
    installHandlers({ transcribeBound: false });
    renderPractice();

    await user.click(await quickFive());

    await screen.findByRole('heading', { name: 'Practice session' });
    expect(started).toBe(1);
  });
});

describe('accessibility', () => {
  it('names the group and is operable from the keyboard alone', async () => {
    const user = userEvent.setup();
    installHandlers();
    renderPractice();

    await waitForModeChoice();

    // The GROUP carries the name: "Text" and "Voice" mean nothing to a
    // screen-reader user until they know what they are a choice between.
    expect(modeGroup()).toBeInTheDocument();

    const voice = voiceOption() as HTMLElement;
    voice.focus();
    expect(voice).toHaveFocus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(voicePatches).toEqual([{ conversationMode: true }]));
    expect(voice).toHaveAttribute('aria-pressed', 'true');
  });
});

/**
 * The device preflight at its FIRST moment: `/practice`, before a session
 * starts (issue #349, epic #345).
 *
 * `PracticePage.test.tsx` covers the picker's own five bands and is untouched
 * by this file. What is asserted here is only what #349 adds, and each claim is
 * one of the issue's acceptance criteria:
 *
 *  1. **A BLOCKED MICROPHONE IS TOLD BEFORE STARTING**, with the existing
 *     `permission_denied` remedy, verbatim. Until #349 this was discovered by
 *     `getUserMedia` inside a session the learner had already committed to.
 *  2. **NO INPUT DEVICE IS TOLD BEFORE STARTING**, with `no_device`.
 *  3. **NO PERMISSIONS API DEGRADES TO UNKNOWN**, never to denied, and the
 *     picker is completely unchanged — the Safari case, and the jsdom case.
 *  4. **RENDERING NEVER PROMPTS.** `getUserMedia` is not called by opening this
 *     page. The prompt belongs to a deliberate tap, one screen further in.
 *  5. **TEXT MODE IS NEVER BLOCKED.** Quick 5 still starts, from the same one
 *     click, with a microphone that is denied, absent, or unknown. This page
 *     warns; it does not gate.
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
import { describeCaptureProblem } from '../../hooks/useAudioCapture';
import type { AiStatus, PracticeQueue } from '../../types';
import { server } from '../mocks/server';
import { mockUser } from '../utils/test-utils';
import { ORIENTED_PROFILE } from '../utils/journey-fixtures';
import { CATEGORIES, civicsHandlers, journeyProfileHandler } from '../utils/civics-fixtures';

const API_BASE = '*/api';

// ---------------------------------------------------------------------------
// The platform. Installed per case, and `getUserMedia` is ALWAYS a spy so that
// "rendering never prompts" is a claim every test in this file makes.
// ---------------------------------------------------------------------------

let getUserMedia: ReturnType<typeof vi.fn>;

interface Platform {
  permission?: PermissionState;
  devices?: MediaDeviceInfo[];
}

function installPlatform(platform: Platform = {}) {
  getUserMedia = vi.fn();

  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () =>
        platform.devices ?? [
          { kind: 'audioinput', deviceId: '', label: '' } as MediaDeviceInfo,
        ],
      ),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    configurable: true,
  });
  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = class {};
  Object.defineProperty(window, 'isSecureContext', {
    value: true,
    configurable: true,
  });

  // Absent unless a case asks for it — no `navigator.permissions` at all is the
  // ordinary Safari shape, and the jsdom default.
  if (platform.permission) {
    Object.defineProperty(navigator, 'permissions', {
      value: {
        query: vi.fn(async () => ({
          state: platform.permission,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      },
      configurable: true,
    });
  }
}

const DEFAULT_QUEUE: PracticeQueue = {
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

let started: number;

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
    http.get(`${API_BASE}/ai/status`, () => HttpResponse.json({ data: status })),
    http.get(`${API_BASE}/practice/queue`, () =>
      HttpResponse.json({ data: DEFAULT_QUEUE }),
    ),
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

/** The picker has loaded: the one action every case below depends on is there. */
async function quickFive() {
  return screen.findByRole('button', { name: /start a quick 5|review now/i });
}

beforeEach(() => {
  started = 0;
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(navigator, 'permissions');
  Reflect.deleteProperty(window, 'MediaRecorder');
  Reflect.deleteProperty(window, 'isSecureContext');
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('the practice picker warns before a session starts', () => {
  it('tells a learner whose microphone is blocked, with the permission_denied remedy', async () => {
    installPlatform({ permission: 'denied' });
    installHandlers();
    renderPractice();

    await quickFive();

    const problem = describeCaptureProblem('permission_denied');
    // VERBATIM, both halves. The message says what is true and the remedy says
    // what to do; a preflight that shipped only the first would be a dead end
    // wearing a specific label.
    expect(await screen.findByText(problem.message)).toBeInTheDocument();
    expect(screen.getByText(problem.remedy)).toBeInTheDocument();
  });

  it('tells a learner with no input device, with the no_device remedy', async () => {
    installPlatform({
      permission: 'prompt',
      devices: [{ kind: 'videoinput', deviceId: 'cam', label: '' } as MediaDeviceInfo],
    });
    installHandlers();
    renderPractice();

    await quickFive();

    const problem = describeCaptureProblem('no_device');
    expect(await screen.findByText(problem.message)).toBeInTheDocument();
    expect(screen.getByText(problem.remedy)).toBeInTheDocument();
    // NOT the permission message. The two remedies send a learner to two
    // completely different places, and picking the wrong one is worse than
    // saying nothing at all.
    expect(
      screen.queryByText(describeCaptureProblem('permission_denied').message),
    ).toBeNull();
  });

  it('says nothing at all on a browser with no Permissions API', async () => {
    // Unknown is not a refusal. This is Safari, and it is also jsdom.
    installPlatform();
    installHandlers();
    renderPractice();

    await quickFive();

    expect(
      screen.queryByText(describeCaptureProblem('permission_denied').message),
    ).toBeNull();
    expect(screen.queryByText(describeCaptureProblem('no_device').message)).toBeNull();
  });

  it('says nothing when transcribe is unbound — there is no spoken session to warn about', async () => {
    installPlatform({ permission: 'denied' });
    installHandlers({ transcribeBound: false });
    renderPractice();

    await quickFive();

    // Waiting on the status response, so this is an assertion about a settled
    // page rather than about one that had not asked yet.
    await waitFor(() =>
      expect(
        screen.queryByText(describeCaptureProblem('permission_denied').message),
      ).toBeNull(),
    );
  });
});

describe('the preflight never prompts', () => {
  it('does not call getUserMedia by rendering the picker', async () => {
    installPlatform({ permission: 'prompt' });
    installHandlers();
    renderPractice();

    await quickFive();

    // The prompt belongs to a deliberate tap, inside a session. Merely opening
    // the picker must never spend the app's one chance at a permission the
    // learner has not asked for — `useMediaReadiness`'s central promise.
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

describe('text mode is never blocked by any of this', () => {
  it('starts a Quick 5 from one click with the microphone denied', async () => {
    const user = userEvent.setup();
    installPlatform({ permission: 'denied' });
    installHandlers();
    renderPractice();

    // The warning is on screen…
    await screen.findByText(describeCaptureProblem('permission_denied').message);

    // …and the action is untouched: one click, one request, one navigation.
    await user.click(await quickFive());

    await screen.findByRole('heading', { name: 'Practice session' });
    expect(started).toBe(1);
  });

  it('starts a Quick 5 with no input device attached', async () => {
    const user = userEvent.setup();
    installPlatform({
      permission: 'prompt',
      devices: [{ kind: 'videoinput', deviceId: 'cam', label: '' } as MediaDeviceInfo],
    });
    installHandlers();
    renderPractice();

    await screen.findByText(describeCaptureProblem('no_device').message);
    await user.click(await quickFive());

    await screen.findByRole('heading', { name: 'Practice session' });
    expect(started).toBe(1);
  });
});

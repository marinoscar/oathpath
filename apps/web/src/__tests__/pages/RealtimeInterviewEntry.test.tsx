/**
 * How a learner reaches a SPOKEN interview — issue #159, epic #60 / E11.
 *
 * The start screen (`/practice/interviews`) is the entry point, and what it
 * offers depends on one per-deployment fact: whether an administrator has
 * bound a model to the `realtime` role.
 *
 * WHAT THESE TESTS PROTECT:
 *
 *  1. **With `realtime` unbound the spoken option is HIDDEN, not disabled**,
 *     the text interview is still one press away, and `AiNotReady` names the
 *     role. `voice.md` §1's posture for an unbound speech role: a greyed-out
 *     control is an affordance for an action that cannot succeed, which reads
 *     as the product being broken rather than as unfinished setup — and here
 *     pressing it would ask for the learner's microphone first.
 *  2. **While the status is unknown, nothing spoken is offered.** Resolving an
 *     unknown to "available" hands a learner a button that cannot work; the
 *     text interview always works, so the safe direction costs nothing.
 *  3. **Both start buttons create the interview the same way** — one
 *     `POST /api/interviews`, no `mode` field, and the retention choice
 *     honoured either way. What the choice picks is which SCREEN opens.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';

import { server } from '../mocks/server';
import { mockUser } from '../utils/test-utils';
import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { AuthContext } from '../../contexts/AuthContext';
import InterviewStartPage from '../../pages/InterviewStartPage';
import type { AiStatus } from '../../types';

const API_BASE = '*/api';
const INTERVIEW_ID = 'interview-1';

const READY: AiStatus = {
  userKeyConfigured: true,
  systemReady: true,
  enabled: true,
  providerConfigured: true,
  unboundRoles: [],
};

interface EntryOptions {
  status?: AiStatus;
  /** Never answer the status request, so the "unknown" branch is exercised. */
  statusPending?: boolean;
  onCreate?: (body: { transcriptRetained?: boolean }) => void;
}

function renderEntry({ status = READY, statusPending, onCreate }: EntryOptions = {}) {
  server.use(
    http.get(`${API_BASE}/ai/status`, async () => {
      if (statusPending) await new Promise(() => undefined);
      return HttpResponse.json({ data: status });
    }),
    http.get(`${API_BASE}/interviews`, () =>
      HttpResponse.json({
        data: { items: [], total: 0, page: 1, pageSize: 5, totalPages: 1 },
      }),
    ),
    http.post(`${API_BASE}/interviews`, async ({ request }) => {
      onCreate?.((await request.json()) as { transcriptRetained?: boolean });
      return HttpResponse.json(
        {
          data: {
            interview: { id: INTERVIEW_ID },
            officerTurns: [],
            progress: { civicsAsked: 0, civicsPlanned: 10 },
            awaitingCompletion: false,
          },
        },
        { status: 201 },
      );
    }),
  );

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
    <ThemeProvider theme={createTheme()}>
      <CssBaseline />
      <AuthContext.Provider value={auth as never}>
        <MemoryRouter initialEntries={['/practice/interviews']}>
          <AiStatusProvider>
            <Routes>
              <Route path="/practice/interviews" element={<InterviewStartPage />} />
              <Route
                path="/practice/interviews/:id"
                element={<div>the text interview screen</div>}
              />
              <Route
                path="/practice/interviews/:id/voice"
                element={<div>the spoken interview screen</div>}
              />
            </Routes>
          </AiStatusProvider>
        </MemoryRouter>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

describe('with a realtime model bound', () => {
  it('offers the spoken interview first, and the text one beside it', async () => {
    renderEntry();

    const spoken = await screen.findByRole('button', {
      name: /start a spoken interview/i,
    });
    expect(spoken).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /start by typing instead/i }),
    ).toBeEnabled();

    // Nothing is broken here, so nothing says so.
    expect(screen.queryByText(/not available yet/i)).toBeNull();
  });

  it('goes to the spoken screen, honouring the retention choice', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    renderEntry({ onCreate });

    await user.click(
      screen.getByRole('switch', { name: /keep a transcript of this interview/i }),
    );
    await user.click(
      await screen.findByRole('button', { name: /start a spoken interview/i }),
    );

    await screen.findByText('the spoken interview screen');
    // ONE `POST /api/interviews` FOR BOTH TRANSPORTS, and no `mode` field —
    // the interview is recorded as `voice` server-side by the first successful
    // realtime mint, never by anything a client claims.
    expect(onCreate).toHaveBeenCalledWith({ transcriptRetained: true });
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('mode');
  });

  it('still goes to the text screen when the learner picks typing', async () => {
    const user = userEvent.setup();
    renderEntry();

    await user.click(
      await screen.findByRole('button', { name: /start by typing instead/i }),
    );
    await screen.findByText('the text interview screen');
  });
});

describe('with realtime unbound', () => {
  const UNBOUND: AiStatus = { ...READY, unboundRoles: ['realtime'] };

  it('hides the spoken option rather than disabling it', async () => {
    renderEntry({ status: UNBOUND });

    // The text interview is still one press away, and it is the primary
    // action rather than a consolation.
    const text = await screen.findByRole('button', { name: /^start the interview$/i });
    expect(text).toBeEnabled();

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /spoken interview/i }),
      ).toBeNull(),
    );
  });

  it('renders the shared AiNotReady, naming the role', async () => {
    renderEntry({ status: UNBOUND });

    // The shared component's own copy — never a bespoke message.
    expect(
      await screen.findByText(/A spoken interview is not available yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not a problem with your key/i),
    ).toBeInTheDocument();
  });
});

describe('while the status is unknown', () => {
  it('offers only the text interview, and explains nothing', async () => {
    renderEntry({ statusPending: true });

    await screen.findByRole('button', { name: /^start the interview$/i });

    // Neither the control that cannot work nor the notice that is not yet
    // true: `realtimeUnbound` is a separate field from `!realtimeBound`
    // precisely so this message does not flash on every page load of a
    // perfectly configured deployment.
    expect(screen.queryByRole('button', { name: /spoken interview/i })).toBeNull();
    expect(screen.queryByText(/not available yet/i)).toBeNull();
  });
});

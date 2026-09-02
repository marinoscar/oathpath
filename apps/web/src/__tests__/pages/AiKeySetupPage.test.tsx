/**
 * `/setup/ai-key` — the gate's destination (issue #39, epic #25).
 *
 * The chrome here is minimal and #41 replaces it. What these tests pin is the
 * BEHAVIOUR that must survive that rewrite:
 *
 *   * saving a key releases the gate without a page reload;
 *   * the status is refreshed BEFORE navigating, or the user bounces straight
 *     back and the save looks like it failed;
 *   * a blocked user can always sign out.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import AiKeySetupPage from '../../pages/AiKeySetupPage';
import { RequireAiKey } from '../../components/common/RequireAiKey';
import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { AuthContext } from '../../contexts/AuthContext';
import { mockUser } from '../utils/test-utils';
import type { AiKeyStatus, AiStatus, AiTestResult } from '../../types';

const VALID_KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';

const KEYLESS: AiStatus = {
  userKeyConfigured: false,
  systemReady: true,
  enabled: true,
  providerConfigured: true,
  unboundRoles: [],
};

const savedStatus: AiKeyStatus = {
  configured: true,
  hint: '••••6789',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const SUCCESS: AiTestResult = {
  success: true,
  authenticated: true,
  roles: [
    { roleKey: 'tutor', modelId: 'gpt-5.4', reachable: true, error: null },
  ],
  providerKind: 'openai',
  error: null,
};

const logout = vi.fn();

function renderApp(initial = '/setup/ai-key') {
  const auth = {
    user: mockUser,
    isLoading: false,
    isAuthenticated: true,
    providers: [],
    login: vi.fn(),
    logout,
    refreshUser: vi.fn(),
  };

  return render(
    <AuthContext.Provider value={auth as never}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route element={<AiStatusProvider />}>
            <Route path="/setup/ai-key" element={<AiKeySetupPage />} />
            <Route element={<RequireAiKey />}>
              <Route path="/" element={<div>HOME</div>} />
              <Route path="/settings/tokens" element={<div>TOKENS</div>} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  logout.mockClear();
  let keyConfigured = false;

  server.use(
    // The status flips once a key is saved — as the real endpoint does.
    http.get('*/api/ai/status', () =>
      HttpResponse.json({ data: { ...KEYLESS, userKeyConfigured: keyConfigured } }),
    ),
    http.get('*/api/ai/key', () =>
      HttpResponse.json({
        data: keyConfigured
          ? savedStatus
          : { configured: false, hint: null, updatedAt: null },
      }),
    ),
    http.put('*/api/ai/key', () => {
      keyConfigured = true;
      return HttpResponse.json({ data: savedStatus });
    }),
    http.post('*/api/ai/key/test', () => HttpResponse.json({ data: SUCCESS })),
  );
});

describe('AiKeySetupPage', () => {
  it('explains why a key is needed, in the user\'s terms', async () => {
    renderApp();

    expect(
      await screen.findByText(/your usage is yours/i),
    ).toBeInTheDocument();
  });

  it('RELEASES THE GATE after a key verifies, with no page reload', async () => {
    // The acceptance criterion, end to end: paste, save, test, and land in the
    // app — through the same gate that redirected here a moment ago.
    const user = userEvent.setup();
    renderApp();

    await user.type(await screen.findByLabelText(/OpenAI API key/i), VALID_KEY);
    await user.click(screen.getByRole('button', { name: /Save and test/i }));

    expect(await screen.findByText('HOME', {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('returns the user where they were heading', async () => {
    // Someone who arrived via a shared link should resume it, not be dropped
    // on the home page.
    const user = userEvent.setup();
    renderApp('/settings/tokens');

    // The gate redirects here first, recording where they were going.
    await screen.findByLabelText(/OpenAI API key/i);

    await user.type(screen.getByLabelText(/OpenAI API key/i), VALID_KEY);
    await user.click(screen.getByRole('button', { name: /Save and test/i }));

    expect(await screen.findByText('TOKENS', {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('lets a blocked user sign out', async () => {
    // This is the only screen they can reach; without this they are trapped.
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole('button', { name: /Sign out/i }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });
});

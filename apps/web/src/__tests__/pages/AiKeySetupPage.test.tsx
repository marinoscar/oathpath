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
import { mockAdminUser, mockUser } from '../utils/test-utils';
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

function renderApp(initial = '/setup/ai-key', user = mockUser) {
  const auth = {
    user,
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
              <Route path="/admin/settings/ai" element={<div>ADMIN AI</div>} />
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

describe('AiKeySetupPage — the onboarding content', () => {
  it('welcomes the user and says what is about to happen', async () => {
    // This is the first screen of the product. Landing on a form with no
    // framing is the failure this issue exists to prevent.
    renderApp();

    expect(
      await screen.findByRole('heading', { level: 1, name: /Welcome to OathPath/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/you only do it once/i)).toBeInTheDocument();
  });

  it('explains WHY a key is needed, in the user\'s terms', async () => {
    // Not the architecture's terms. The reader has almost certainly never
    // heard of an API key.
    renderApp();

    expect(
      await screen.findByText(/a long password that connects OathPath/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/the usage is yours/i)).toBeInTheDocument();
  });

  it('frames the reason as CONTROL rather than as a bill', async () => {
    // True, the actual reason for the design, and it does not open by telling
    // someone they are about to be charged.
    renderApp();

    expect(
      await screen.findByText(/remove your key from OathPath whenever you like/i),
    ).toBeInTheDocument();
  });

  it('gives numbered steps that assume the reader has never seen the console', async () => {
    renderApp();

    expect(
      await screen.findByText(/Open the OpenAI website and sign in/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Choose "Create new secret key"/i)).toBeInTheDocument();
    // The one that actually bites: OpenAI shows the key once.
    expect(screen.getByText(/shows it only once/i)).toBeInTheDocument();
  });

  it('links to the real OpenAI key page, safely, in a new tab', async () => {
    renderApp();

    const link = (await screen.findAllByRole('link', { name: /OpenAI/i }))[0];
    expect(link).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
    expect(link).toHaveAttribute('target', '_blank');
    // `noopener` so the linked page gets no `window.opener` handle.
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('says the link opens in a new tab, so the page is not lost', async () => {
    renderApp();

    expect(
      await screen.findByText(/so you do not lose this page/i),
    ).toBeInTheDocument();
  });

  it('says the key is never shown again — including to its owner', async () => {
    renderApp();

    expect(await screen.findByText(/not even to you/i)).toBeInTheDocument();
  });

  it('does not congratulate the reader for pasting a string', async () => {
    // VISION.md names manufactured enthusiasm as the thing to avoid:
    // encouragement must be specific and earned.
    renderApp();

    await screen.findByRole('heading', { level: 1 });
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/amazing|awesome|great job|you're doing great/i);
  });

  it('is not the settings chrome — nothing to navigate away into', async () => {
    // Mounted outside `Layout` on purpose: no rail, no bottom bar, no admin
    // furniture. A first-run screen with a navigation shell invites the user
    // to wander off into an app that does nothing yet.
    renderApp();

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

describe('AiKeySetupPage — behaviour', () => {

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

  it('lets a keyless ADMIN reach admin settings from here', async () => {
    // The fresh-install deadlock `RequireAiKey`'s exemption 3 prevents is only
    // half-solved if the first admin cannot find their way there.
    const user = userEvent.setup();
    renderApp('/setup/ai-key', mockAdminUser);

    await user.click(
      await screen.findByRole('link', { name: /Administrator settings/i }),
    );

    expect(await screen.findByText('ADMIN AI')).toBeInTheDocument();
  });

  it('does not offer administrator settings to a non-admin', async () => {
    renderApp();

    await screen.findByRole('heading', { level: 1 });
    expect(
      screen.queryByRole('link', { name: /Administrator settings/i }),
    ).not.toBeInTheDocument();
  });
});

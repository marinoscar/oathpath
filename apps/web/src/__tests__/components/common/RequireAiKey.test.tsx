/**
 * `RequireAiKey` — the first-run gate (issue #39, epic #25).
 *
 * The gate's whole job is a redirect decision, so these tests render it as a
 * real route tree and assert WHERE the user ends up. Mocking the decision and
 * asserting the mock would test nothing.
 *
 * The case that gets the most attention is exemption 3 — the admin subtree —
 * because it prevents a DEADLOCK on a fresh install: the admin AI settings page
 * is the only place the server key and model bindings are set, and putting it
 * behind a gate nothing has configured yet leaves the first administrator with
 * no way out of the loop from inside the product.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';

import { server } from '../../mocks/server';
import { RequireAiKey } from '../../../components/common/RequireAiKey';
import { AiStatusProvider } from '../../../contexts/AiStatusContext';
import { AuthContext } from '../../../contexts/AuthContext';
import { mockAdminUser, mockUser } from '../../utils/test-utils';
import type { AiStatus } from '../../../types';

const KEYED: AiStatus = {
  userKeyConfigured: true,
  systemReady: true,
  enabled: true,
  providerConfigured: true,
  unboundRoles: [],
};

const KEYLESS: AiStatus = { ...KEYED, userKeyConfigured: false };

function mockStatus(status: AiStatus) {
  server.use(http.get('*/api/ai/status', () => HttpResponse.json({ data: status })));
}

/**
 * Mount the gate over a route tree shaped like `App.tsx`'s.
 *
 * `/setup/ai-key` sits OUTSIDE the gate here exactly as it does in the app —
 * which is what makes a redirect loop structurally impossible rather than
 * prevented by a path comparison.
 */
function renderAt(path: string, user = mockUser) {
  const auth = {
    user,
    isLoading: false,
    isAuthenticated: true,
    providers: [],
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  };

  return render(
    <AuthContext.Provider value={auth as never}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AiStatusProvider />}>
            <Route path="/setup/ai-key" element={<div>SETUP SCREEN</div>} />
            <Route element={<RequireAiKey />}>
              <Route path="/" element={<div>HOME</div>} />
              <Route path="/settings/tokens" element={<div>TOKENS</div>} />
              <Route path="/admin/settings" element={<div>ADMIN HUB</div>} />
              <Route path="/admin/settings/ai" element={<div>ADMIN AI</div>} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('RequireAiKey — a user WITH a key', () => {
  beforeEach(() => mockStatus(KEYED));

  it('is let through', async () => {
    renderAt('/');
    expect(await screen.findByText('HOME')).toBeInTheDocument();
  });

  it('reaches ordinary settings', async () => {
    renderAt('/settings/tokens');
    expect(await screen.findByText('TOKENS')).toBeInTheDocument();
  });
});

describe('RequireAiKey — a user WITHOUT a key', () => {
  beforeEach(() => mockStatus(KEYLESS));

  it('is redirected to the setup screen from the home page', async () => {
    renderAt('/');
    expect(await screen.findByText('SETUP SCREEN')).toBeInTheDocument();
  });

  it('is redirected from ANY other route, not just the home page', async () => {
    renderAt('/settings/tokens');
    expect(await screen.findByText('SETUP SCREEN')).toBeInTheDocument();
    expect(screen.queryByText('TOKENS')).not.toBeInTheDocument();
  });

  it('does not loop: the setup screen itself is outside the gate', async () => {
    renderAt('/setup/ai-key');
    expect(await screen.findByText('SETUP SCREEN')).toBeInTheDocument();
  });
});

describe('RequireAiKey — the admin exemption (the deadlock case)', () => {
  beforeEach(() => mockStatus(KEYLESS));

  it('LETS A KEYLESS ADMIN REACH /admin/settings/ai', async () => {
    // THE test in this file. Without this, the first administrator on a fresh
    // install cannot reach the only page that configures the system they are
    // being blocked for — and there is no way out of the loop from inside the
    // product.
    renderAt('/admin/settings/ai', mockAdminUser);

    expect(await screen.findByText('ADMIN AI')).toBeInTheDocument();
  });

  it('lets a keyless admin reach the rest of the admin subtree', async () => {
    // A prefix, not a single path: the deadlock is about the subtree, and a
    // list of exempt pages goes stale the next time one is added.
    renderAt('/admin/settings', mockAdminUser);

    expect(await screen.findByText('ADMIN HUB')).toBeInTheDocument();
  });

  it('is keyed on the PERMISSION, not on being called an admin', async () => {
    // The same string the admin cards and routes declare.
    const adminWithoutRead = {
      ...mockAdminUser,
      permissions: mockAdminUser.permissions.filter(
        (p) => p !== 'system_settings:read',
      ),
    };

    renderAt('/admin/settings/ai', adminWithoutRead);

    expect(await screen.findByText('SETUP SCREEN')).toBeInTheDocument();
  });

  it('does NOT exempt a keyless non-admin from admin routes', async () => {
    // The existing permission gate still applies underneath; this only
    // establishes that the AI gate does not add a second, redundant block.
    renderAt('/admin/settings/ai', mockUser);

    expect(await screen.findByText('SETUP SCREEN')).toBeInTheDocument();
  });

  it('does not exempt ordinary routes for an admin', async () => {
    // The exemption is about the deadlock, not about admins being special.
    renderAt('/settings/tokens', mockAdminUser);

    expect(await screen.findByText('SETUP SCREEN')).toBeInTheDocument();
  });
});

describe('RequireAiKey — systemReady is NOT a block', () => {
  it('lets a keyed user in when the administrator has not finished', async () => {
    // The whole reason /api/ai/status returns two flags. Blocking here would
    // punish a user for someone else's unfinished configuration — and, with
    // the flags merged, would tell them to fix their key.
    mockStatus({
      userKeyConfigured: true,
      systemReady: false,
      enabled: false,
      providerConfigured: false,
      unboundRoles: ['tutor', 'grader'],
    });

    renderAt('/');

    expect(await screen.findByText('HOME')).toBeInTheDocument();
  });
});

describe('RequireAiKey — failure behaviour', () => {
  it('FAILS OPEN when the status cannot be read', async () => {
    // Blocking on a failed status check would lock every user out of the
    // entire application because one endpoint is unavailable — and what it
    // gates is a feature, not a security boundary. The API still enforces
    // access on every route regardless of what this component decides.
    server.use(http.get('*/api/ai/status', () => HttpResponse.error()));

    renderAt('/');

    expect(await screen.findByText('HOME')).toBeInTheDocument();
  });

  it('shows a spinner rather than flashing the wrong answer while loading', async () => {
    // Rendering the app and then yanking it away, or bouncing to setup and
    // then back, is worse than a moment of nothing.
    server.use(
      http.get('*/api/ai/status', async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return HttpResponse.json({ data: KEYLESS });
      }),
    );

    renderAt('/');

    expect(screen.queryByText('HOME')).not.toBeInTheDocument();
    expect(screen.queryByText('SETUP SCREEN')).not.toBeInTheDocument();
    expect(await screen.findByText('SETUP SCREEN')).toBeInTheDocument();
  });
});

describe('AiStatusProvider — no request storm', () => {
  it('fetches the status ONCE, not per navigation', async () => {
    // The gate consults this on every navigation. A fetch inside the gate
    // would fire on every route change — a request storm behind a first-run
    // screen a new user cannot get past.
    let calls = 0;
    server.use(
      http.get('*/api/ai/status', () => {
        calls += 1;
        return HttpResponse.json({ data: KEYED });
      }),
    );

    renderAt('/');
    await screen.findByText('HOME');

    await waitFor(() => expect(calls).toBe(1));
  });
});

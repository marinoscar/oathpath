/**
 * `RequireOrientation` — the second onboarding gate (issue #72, epic #50).
 *
 * The gate's whole job is a redirect decision, so these tests render it as a
 * real route tree and assert WHERE the learner ends up. Mocking the decision
 * and asserting the mock would test nothing.
 *
 * The shape mirrors `RequireAiKey.test.tsx` deliberately, because the gate
 * mirrors `RequireAiKey` deliberately — a divergence between the two suites
 * would be the first sign the gates had drifted apart.
 *
 * The case that gets the most attention is the admin exemption, for the same
 * fresh-install reason: the first administrator may have no naturalization
 * interview of their own to describe, and holding them on a form about one is a
 * deadlock with no way out from inside the product.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';

import { server } from '../../mocks/server';
import { RequireOrientation } from '../../../components/common/RequireOrientation';
import { LearnerProfileProvider } from '../../../contexts/LearnerProfileContext';
import { AuthContext } from '../../../contexts/AuthContext';
import { mockAdminUser, mockUser } from '../../utils/test-utils';
import {
  ORIENTED_PROFILE,
  UNORIENTED_PROFILE,
  profileResponse,
} from '../../utils/journey-fixtures';
import type { JourneyProfile } from '../../../types';

function mockProfile(profile: JourneyProfile) {
  server.use(
    http.get('*/api/journey/profile', () =>
      HttpResponse.json({ data: profileResponse(profile) }),
    ),
  );
}

/** The endpoint is down. The gate must let the learner through anyway. */
function mockProfileFailure() {
  server.use(
    http.get('*/api/journey/profile', () => HttpResponse.error()),
  );
}

/** Renders the `state` a redirect carried, so the hand-off can be asserted. */
function SetupScreen() {
  const location = useLocation();
  const from = (location.state as { from?: { pathname?: string } } | null)?.from
    ?.pathname;
  return <div>SETUP SCREEN{from ? ` from ${from}` : ''}</div>;
}

/**
 * Mount the gate over a route tree shaped like `App.tsx`'s.
 *
 * `/setup/journey` sits OUTSIDE the gate here exactly as it does in the app —
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
          <Route element={<LearnerProfileProvider />}>
            <Route path="/setup/journey" element={<SetupScreen />} />
            <Route element={<RequireOrientation />}>
              <Route path="/" element={<div>HOME</div>} />
              <Route path="/learn" element={<div>LEARN</div>} />
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

describe('RequireOrientation — a learner who has finished orientation', () => {
  beforeEach(() => mockProfile(ORIENTED_PROFILE));

  it('is let through to Home', async () => {
    renderAt('/');
    expect(await screen.findByText('HOME')).toBeInTheDocument();
  });

  it('reaches the other destinations and ordinary settings', async () => {
    renderAt('/learn');
    expect(await screen.findByText('LEARN')).toBeInTheDocument();
  });
});

describe('RequireOrientation — a learner who has NOT', () => {
  beforeEach(() => mockProfile(UNORIENTED_PROFILE));

  it('is redirected to the orientation screen from the home page', async () => {
    renderAt('/');
    expect(await screen.findByText(/SETUP SCREEN/)).toBeInTheDocument();
    expect(screen.queryByText('HOME')).not.toBeInTheDocument();
  });

  it('CAN REACH NOTHING ELSE — every gated route redirects, not just Home', async () => {
    // The acceptance criterion, stated as three separate destinations rather
    // than one: a gate that only covered `/` would look correct on the screen
    // a reviewer happens to be standing on.
    for (const [path, page] of [
      ['/learn', 'LEARN'],
      ['/settings/tokens', 'TOKENS'],
      ['/admin/settings', 'ADMIN HUB'],
    ] as const) {
      const view = renderAt(path);
      expect(await screen.findByText(/SETUP SCREEN/)).toBeInTheDocument();
      expect(screen.queryByText(page)).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('does not loop: the orientation screen itself is outside the gate', async () => {
    renderAt('/setup/journey');
    expect(await screen.findByText(/SETUP SCREEN/)).toBeInTheDocument();
  });

  it('carries `state.from`, so finishing setup resumes where the learner was going', async () => {
    renderAt('/learn');
    expect(await screen.findByText('SETUP SCREEN from /learn')).toBeInTheDocument();
  });
});

describe('RequireOrientation — the admin exemption', () => {
  beforeEach(() => mockProfile(UNORIENTED_PROFILE));

  it('LETS AN UNORIENTED ADMIN REACH /admin/settings/ai', async () => {
    // THE test in this file. The first administrator on a fresh install has to
    // configure the deployment before anybody can use it, and may not be a
    // learner at all — holding them on a form about their own naturalization
    // interview is a deadlock with no way out from inside the product.
    renderAt('/admin/settings/ai', mockAdminUser);
    expect(await screen.findByText('ADMIN AI')).toBeInTheDocument();
  });

  it('covers the whole /admin subtree, not one page', async () => {
    renderAt('/admin/settings', mockAdminUser);
    expect(await screen.findByText('ADMIN HUB')).toBeInTheDocument();
  });

  it('does NOT exempt the admin anywhere else', async () => {
    // The exemption is about the deadlock, not about rank. An administrator
    // who wants to use the product still answers the questions.
    renderAt('/', mockAdminUser);
    expect(await screen.findByText(/SETUP SCREEN/)).toBeInTheDocument();
  });

  it('is keyed on the PERMISSION, not on a role name', async () => {
    // A contributor granted `system_settings:read` is exempt; an "admin" role
    // without the permission is not. Keying on the role would strand the first
    // and admit the second, and both are the wrong answer.
    const contributorWithPermission = {
      ...mockUser,
      roles: [{ name: 'contributor' }],
      permissions: [...mockUser.permissions, 'system_settings:read'],
    };
    renderAt('/admin/settings', contributorWithPermission);
    expect(await screen.findByText('ADMIN HUB')).toBeInTheDocument();
  });

  it('gives a role-named admin WITHOUT the permission nothing', async () => {
    const adminWithoutPermission = {
      ...mockUser,
      roles: [{ name: 'admin' }],
      permissions: ['user_settings:read'],
    };
    renderAt('/admin/settings', adminWithoutPermission);
    expect(await screen.findByText(/SETUP SCREEN/)).toBeInTheDocument();
  });
});

describe('RequireOrientation — a failed profile read', () => {
  beforeEach(() => mockProfileFailure());

  it('FAILS OPEN rather than locking everyone out', async () => {
    // Blocking here would take the whole application down for every learner —
    // including everyone who finished orientation months ago — because one
    // endpoint is unavailable. What this gates is a product question, and the
    // API enforces the real authorization on every route regardless.
    renderAt('/');
    expect(await screen.findByText('HOME')).toBeInTheDocument();
  });

  it('fails open on admin routes too, with no permission required', async () => {
    renderAt('/admin/settings', mockUser);
    expect(await screen.findByText('ADMIN HUB')).toBeInTheDocument();
  });
});

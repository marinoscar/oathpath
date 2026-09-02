/**
 * The two onboarding gates, against the REAL `App.tsx` (issue #72, epic #50).
 *
 * `RequireAiKey.test.tsx` and `RequireOrientation.test.tsx` each render a
 * hand-built route tree, which is right for testing what one gate decides. It
 * is exactly the wrong thing for testing how the two COMPOSE: a hand-built tree
 * proves only that the tree the test wrote behaves as the test expected, and
 * the failure this file exists to catch is a gate wired into the wrong place in
 * the file that actually ships.
 *
 * So these render `App` itself, and everything asserted here is a property of
 * `App.tsx`'s route tree:
 *
 *   * ORDER — a keyless, unoriented learner meets `/setup/ai-key` first;
 *   * NON-INTERFERENCE — each setup screen is reachable while the OTHER gate
 *     is the one blocking, because each is mounted outside its own gate and
 *     inside the other's cleared region;
 *   * THE ADMIN EXEMPTION reaching a real `/admin/settings/*` route through
 *     both gates and `RequirePermission` underneath.
 *
 * `/api/journey/profile` has no default handler in `mocks/handlers.ts`, on
 * purpose: an unhandled request makes both providers fail open, which is what
 * keeps every other suite in this repository testing its own subject rather
 * than this one's. Each test here installs the handler it needs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import App from '../../App';
import {
  ORIENTED_PROFILE,
  UNORIENTED_PROFILE,
  profileResponse,
} from '../utils/journey-fixtures';
import type { AiStatus, JourneyProfile } from '../../types';

const API_BASE = '*/api';

const KEYED: AiStatus = {
  userKeyConfigured: true,
  systemReady: true,
  enabled: true,
  providerConfigured: true,
  unboundRoles: [],
};

const KEYLESS: AiStatus = { ...KEYED, userKeyConfigured: false };

/** How many times the profile was read, so the count survives a full App render. */
let profileReads = 0;

function mockOnboarding(status: AiStatus, profile: JourneyProfile) {
  profileReads = 0;
  server.use(
    http.get(`${API_BASE}/ai/status`, () => HttpResponse.json({ data: status })),
    http.get(`${API_BASE}/journey/profile`, () => {
      profileReads += 1;
      return HttpResponse.json({ data: profileResponse(profile) });
    }),
  );
}

/** Overrides `GET /auth/me`, so the route tree sees this user. */
function signInAs(permissions: string[], roles: string[] = ['viewer']) {
  server.use(
    http.get(`${API_BASE}/auth/me`, () =>
      HttpResponse.json({
        data: {
          id: 'test-user-id',
          email: 'test@example.com',
          displayName: 'Test User',
          profileImageUrl: null,
          roles: roles.map((name) => ({ name })),
          permissions,
          isActive: true,
          createdAt: new Date().toISOString(),
        },
      }),
    ),
  );
}

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const LEARNER_PERMISSIONS = ['user_settings:read', 'user_settings:write'];
const ADMIN_PERMISSIONS = [...LEARNER_PERMISSIONS, 'system_settings:read'];

beforeEach(() => signInAs(LEARNER_PERMISSIONS));

describe('the gates in order', () => {
  it('sends a keyless, unoriented learner to the AI key screen FIRST', async () => {
    // THE ordering assertion. Orientation is a product question — what test do
    // you take, when is your interview — and asking it of someone who cannot
    // use the AI-driven parts of the product at all is work spent before the
    // gate that actually blocks them has cleared.
    mockOnboarding(KEYLESS, UNORIENTED_PROFILE);
    renderApp('/');

    expect(
      await screen.findByRole('heading', { name: /welcome to oathpath/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /let's set up your plan/i }),
    ).not.toBeInTheDocument();
  });

  it('sends a KEYED, unoriented learner to orientation', async () => {
    mockOnboarding(KEYED, UNORIENTED_PROFILE);
    renderApp('/');

    expect(
      await screen.findByRole('heading', { name: /let's set up your plan/i }),
    ).toBeInTheDocument();
  });

  it('lets a keyed, oriented learner through to Home', async () => {
    mockOnboarding(KEYED, ORIENTED_PROFILE);
    renderApp('/');

    expect(await screen.findByText(/welcome back/i)).toBeInTheDocument();
  });

  it('lets a keyed, oriented learner reach the other destinations', async () => {
    mockOnboarding(KEYED, ORIENTED_PROFILE);
    renderApp('/learn');

    expect(await screen.findByRole('heading', { name: 'Learn' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /let's set up your plan/i }),
    ).not.toBeInTheDocument();
  });
});

describe('the gates never fight', () => {
  it('leaves /setup/ai-key reachable while orientation is the blocker', async () => {
    mockOnboarding(KEYED, UNORIENTED_PROFILE);
    renderApp('/setup/ai-key');

    expect(
      await screen.findByRole('heading', { name: /welcome to oathpath/i }),
    ).toBeInTheDocument();
  });

  it('leaves /setup/journey reachable, with no loop, while orientation is the blocker', async () => {
    // The structural claim: `/setup/journey` is mounted OUTSIDE
    // `RequireOrientation`, so the gate cannot redirect to a route it is
    // itself blocking.
    mockOnboarding(KEYED, UNORIENTED_PROFILE);
    renderApp('/setup/journey');

    expect(
      await screen.findByRole('heading', { name: /let's set up your plan/i }),
    ).toBeInTheDocument();
  });

  it('sends a keyless learner off /setup/journey to the key screen', async () => {
    // `/setup/journey` sits INSIDE `RequireAiKey`, which is what keeps the
    // order from being reversible by visiting the second screen directly.
    mockOnboarding(KEYLESS, UNORIENTED_PROFILE);
    renderApp('/setup/journey');

    expect(
      await screen.findByRole('heading', { name: /welcome to oathpath/i }),
    ).toBeInTheDocument();
  });

  it('offers sign-out on both setup screens, so no learner is ever trapped', async () => {
    mockOnboarding(KEYED, UNORIENTED_PROFILE);
    renderApp('/setup/journey');

    await screen.findByRole('heading', { name: /let's set up your plan/i });
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});

describe('the admin exemption, through both gates', () => {
  it('lets an unoriented admin reach a real /admin/settings route', async () => {
    // Through `RequireAiKey`'s exemption, `RequireOrientation`'s exemption, AND
    // `RequirePermission` underneath — all three on the same
    // `system_settings:read` string, and no new permission anywhere.
    signInAs(ADMIN_PERMISSIONS, ['admin']);
    mockOnboarding(KEYED, UNORIENTED_PROFILE);
    renderApp('/admin/settings');

    expect(
      await screen.findByRole('heading', { name: 'Settings' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /let's set up your plan/i }),
    ).not.toBeInTheDocument();
  });

  it('still holds that admin at orientation everywhere else', async () => {
    signInAs(ADMIN_PERMISSIONS, ['admin']);
    mockOnboarding(KEYED, UNORIENTED_PROFILE);
    renderApp('/learn');

    expect(
      await screen.findByRole('heading', { name: /let's set up your plan/i }),
    ).toBeInTheDocument();
  });

  it('holds an unoriented NON-admin at orientation on /admin/settings too', async () => {
    mockOnboarding(KEYED, UNORIENTED_PROFILE);
    renderApp('/admin/settings');

    expect(
      await screen.findByRole('heading', { name: /let's set up your plan/i }),
    ).toBeInTheDocument();
  });
});

describe('the profile is read once for the whole app', () => {
  it('reads it once, not once per gate consultation', async () => {
    // The provider is mounted above the gate in `App.tsx`; a fetch inside the
    // gate would fire on every navigation instead. Asserted here as well as in
    // `LearnerProfileContext.test.tsx` because this is the composition that
    // actually ships.
    mockOnboarding(KEYED, ORIENTED_PROFILE);
    renderApp('/');

    expect(await screen.findByText(/welcome back/i)).toBeInTheDocument();
    await waitFor(() => expect(profileReads).toBe(1));
  });

  it('does not read it at all before the AI key gate has cleared', async () => {
    // The provider sits INSIDE `RequireAiKey`, so a keyless learner never pays
    // for a profile read they cannot use — and a first-run screen fires one
    // request, not two.
    mockOnboarding(KEYLESS, UNORIENTED_PROFILE);
    renderApp('/');

    await screen.findByRole('heading', { name: /welcome to oathpath/i });
    expect(profileReads).toBe(0);
  });
});

/**
 * `LearnerProfileContext` — fetched once, read everywhere (issue #72, epic #50).
 *
 * =============================================================================
 * THE REQUEST COUNT IS THE POINT OF THIS FILE
 * =============================================================================
 *
 * "The profile is fetched once, not per navigation" is a property no rendering
 * assertion can see: a provider that refetched on every route change would look
 * absolutely identical on screen, and would only reveal itself in production as
 * a request storm behind a first-run screen a new learner cannot get past —
 * which is the worst possible page to put one behind.
 *
 * So the test counts. `requests` below is incremented by the MSW handler
 * itself, the tree is navigated several times through real links, and the count
 * is asserted to still be one. That is the only form of evidence this
 * particular criterion accepts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import {
  LearnerProfileProvider,
  useLearnerProfile,
} from '../../contexts/LearnerProfileContext';
import { RequireOrientation } from '../../components/common/RequireOrientation';
import { AuthContext } from '../../contexts/AuthContext';
import { mockUser } from '../utils/test-utils';
import {
  ORIENTED_PROFILE,
  UNORIENTED_PROFILE,
  profileResponse,
} from '../utils/journey-fixtures';
import type { JourneyProfile } from '../../types';

/** How many times `GET /api/journey/profile` was actually called. */
let requests = 0;

function mockProfile(profile: JourneyProfile) {
  requests = 0;
  server.use(
    http.get('*/api/journey/profile', () => {
      requests += 1;
      return HttpResponse.json({ data: profileResponse(profile) });
    }),
  );
}

/** A page that both names itself and reports what the context holds. */
function Page({ name }: { name: string }) {
  const { profile, testVersions, states } = useLearnerProfile();
  return (
    <div>
      <h1>{name}</h1>
      <p data-testid="stage">{profile?.stage ?? 'none'}</p>
      <p data-testid="versions">{testVersions.length}</p>
      <p data-testid="states">{states.length}</p>
      <nav>
        <Link to="/">Home</Link>
        <Link to="/learn">Learn</Link>
        <Link to="/practice">Practice</Link>
        <Link to="/settings">Settings</Link>
      </nav>
    </div>
  );
}

function renderTree(initial = '/') {
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
    <AuthContext.Provider value={auth as never}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          {/* The provider is a LAYOUT route, exactly as in `App.tsx`. That is
              what makes "fetched on mount" mean "once per session" rather than
              "once per page": react-router keeps a layout element mounted while
              its children swap. */}
          <Route element={<LearnerProfileProvider />}>
            <Route element={<RequireOrientation />}>
              <Route path="/" element={<Page name="Home" />} />
              <Route path="/learn" element={<Page name="Learn" />} />
              <Route path="/practice" element={<Page name="Practice" />} />
              <Route path="/settings" element={<Page name="Settings" />} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('LearnerProfileContext — fetched once, not per navigation', () => {
  beforeEach(() => mockProfile(ORIENTED_PROFILE));

  it('READS THE PROFILE EXACTLY ONCE ACROSS FOUR NAVIGATIONS', async () => {
    const user = userEvent.setup();
    renderTree('/');

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    await waitFor(() => expect(requests).toBe(1));

    await user.click(screen.getByRole('link', { name: 'Learn' }));
    expect(await screen.findByRole('heading', { name: 'Learn' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Practice' }));
    expect(await screen.findByRole('heading', { name: 'Practice' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Home' }));
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();

    // FOUR route changes later, and the gate consulted on every one of them.
    expect(requests).toBe(1);
  });

  it('serves the same answer to every consumer, without a second request', async () => {
    renderTree('/learn');

    expect(await screen.findByRole('heading', { name: 'Learn' })).toBeInTheDocument();
    expect(screen.getByTestId('stage')).toHaveTextContent('oriented');
    // The two reference lists ride along on the same response — three round
    // trips would be three loading states for one form, and their answers could
    // disagree.
    expect(screen.getByTestId('versions')).toHaveTextContent('2');
    expect(screen.getByTestId('states')).toHaveTextContent('5');
    expect(requests).toBe(1);
  });
});

describe('LearnerProfileContext — a failed read', () => {
  beforeEach(() => {
    requests = 0;
    server.use(
      http.get('*/api/journey/profile', () => {
        requests += 1;
        return HttpResponse.error();
      }),
    );
  });

  it('fails open, and does not retry on every navigation either', async () => {
    const user = userEvent.setup();
    renderTree('/');

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByTestId('stage')).toHaveTextContent('none');

    await user.click(screen.getByRole('link', { name: 'Learn' }));
    expect(await screen.findByRole('heading', { name: 'Learn' })).toBeInTheDocument();

    // A failed read that retried per navigation would be a request storm during
    // exactly the outage it is meant to survive.
    expect(requests).toBe(1);
  });
});

describe('LearnerProfileContext — releasing the gate without a reload', () => {
  it('adopts a saved response in place, with no second GET', async () => {
    // What `applyProfile` is for. The `PUT` replies with the same payload the
    // `GET` returns, so re-reading it would spend a round trip learning what
    // the server has just said — and, until it landed, the gate would still be
    // holding a learner who has finished.
    mockProfile(UNORIENTED_PROFILE);

    function Saver() {
      const { profile, applyProfile } = useLearnerProfile();
      return (
        <div>
          <p data-testid="completed">
            {profile?.orientationCompletedAt ?? 'not yet'}
          </p>
          <button
            type="button"
            onClick={() => applyProfile(profileResponse(ORIENTED_PROFILE))}
          >
            Save
          </button>
        </div>
      );
    }

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LearnerProfileProvider>
          <Saver />
        </LearnerProfileProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('completed')).toHaveTextContent('not yet');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.getByTestId('completed')).toHaveTextContent(
        '2026-09-02T10:00:00.000Z',
      ),
    );
    expect(requests).toBe(1);
  });
});

describe('useLearnerProfile outside its provider', () => {
  it('throws rather than answering null', () => {
    // A silent null would make the gate fail open everywhere and look like it
    // was working — the worst possible failure mode for a wiring bug.
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    function Orphan() {
      useLearnerProfile();
      return null;
    }

    expect(() => render(<Orphan />)).toThrow(
      /must be used within a LearnerProfileProvider/,
    );

    consoleError.mockRestore();
  });
});

/**
 * `AiNotReady` — the point-of-use blocked state (issue #43, epic #25).
 *
 * The component exists for one sentence — "This is not a problem with your
 * key" — and that sentence is why `/api/ai/status` returns two flags rather
 * than one. Without it, a user with a perfectly good key is sent to check the
 * only thing they can imagine being wrong, replaces a working credential, and
 * watches the same failure happen again.
 *
 * So the first test asserts that sentence directly, and the rest guard the
 * ways it could stop being true: the component rendering nothing, rendering
 * for the wrong reason, or growing an admin-only detail that leaks to
 * everyone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';

import { server } from '../../mocks/server';
import { AiNotReady } from '../../../components/ai/AiNotReady';
import { AiStatusProvider } from '../../../contexts/AiStatusContext';
import { AuthContext } from '../../../contexts/AuthContext';
import { mockAdminUser, mockUser } from '../../utils/test-utils';
import type { AiStatus } from '../../../types';

const READY: AiStatus = {
  userKeyConfigured: true,
  systemReady: true,
  enabled: true,
  providerConfigured: true,
  unboundRoles: [],
};

const UNBOUND: AiStatus = {
  ...READY,
  systemReady: false,
  unboundRoles: ['tutor', 'grader'],
};

function mockStatus(status: AiStatus) {
  server.use(http.get('*/api/ai/status', () => HttpResponse.json({ data: status })));
}

function renderIt(props: { feature?: string } = {}, user = mockUser) {
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
      <MemoryRouter>
        <AiStatusProvider>
          <AiNotReady {...props} />
        </AiStatusProvider>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('AiNotReady — the sentence it exists for', () => {
  beforeEach(() => mockStatus(UNBOUND));

  it('SAYS THE USER\'S KEY IS FINE', async () => {
    // The entire reason /api/ai/status returns two flags. Without this the
    // user replaces a working credential and hits the same failure again.
    renderIt();

    expect(
      await screen.findByText(/This is not a problem with your key/i),
    ).toBeInTheDocument();
  });

  it('says nothing is wrong on the user\'s side', async () => {
    renderIt();

    expect(
      await screen.findByText(/Nothing is wrong on your side/i),
    ).toBeInTheDocument();
  });

  it('is calm — info, never an error', async () => {
    // VISION.md: calm, specific, never blaming the user. From the reader's
    // point of view the product is not finished being set up, which is a wait,
    // not a fault.
    renderIt();

    const alert = await screen.findByRole('alert');
    expect(alert.className).toMatch(/Info|info/);
    expect(alert.className).not.toMatch(/Error|error/);
  });

  it('names what is unavailable when the surface says so', async () => {
    // "AI explanations aren't available yet" beats "AI isn't available yet",
    // and the surface is the only thing that knows which is true.
    renderIt({ feature: 'AI explanations' });

    expect(
      await screen.findByText(/AI explanations is not available yet/i),
    ).toBeInTheDocument();
  });
});

describe('AiNotReady — when it renders at all', () => {
  it('renders NOTHING when the system is ready', async () => {
    // Consumers mount it unconditionally above their own content, so this is
    // what makes "every AI surface shows this" cheap enough to actually do.
    mockStatus(READY);
    const { container } = renderIt();

    // Give the status request a chance to settle before asserting emptiness.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the status is unknown', async () => {
    // A spinner here would put a loading state above every AI surface for a
    // fact that is already cached.
    server.use(
      http.get('*/api/ai/status', async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return HttpResponse.json({ data: UNBOUND });
      }),
    );
    const { container } = renderIt();

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the status could not be read', async () => {
    // The gate fails open; so does this. Claiming the administrator has not
    // finished, on no evidence, would be a worse guess than saying nothing.
    server.use(http.get('*/api/ai/status', () => HttpResponse.error()));
    const { container } = renderIt();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('AiNotReady — the admin variant', () => {
  it('gives an admin a link to fix it', async () => {
    // An admin who lands here should be one click from fixing it.
    mockStatus(UNBOUND);
    renderIt({}, mockAdminUser);

    const link = await screen.findByRole('link', { name: /Open AI settings/i });
    expect(link).toHaveAttribute('href', '/admin/settings/ai');
  });

  it('NAMES the unbound roles rather than saying "some models"', async () => {
    // "Which one?" is the question an admin would otherwise have to go and
    // answer for themselves.
    mockStatus(UNBOUND);
    renderIt({}, mockAdminUser);

    expect(await screen.findByText(/tutor and grader/i)).toBeInTheDocument();
  });

  it('names the master switch when that is the actual problem', async () => {
    // Three different problems, three different remedies. "AI is not set up"
    // for all of them would send an admin looking in the wrong place.
    mockStatus({
      ...READY,
      systemReady: false,
      enabled: false,
      unboundRoles: [],
    });
    renderIt({}, mockAdminUser);

    expect(
      await screen.findByText(/the master switch is turned off/i),
    ).toBeInTheDocument();
  });

  it('names a missing provider when that is the actual problem', async () => {
    mockStatus({
      ...READY,
      systemReady: false,
      providerConfigured: false,
      unboundRoles: [],
    });
    renderIt({}, mockAdminUser);

    expect(
      await screen.findByText(/no AI provider has been chosen yet/i),
    ).toBeInTheDocument();
  });

  it('does NOT show the link or the detail to a non-admin', async () => {
    // A non-admin cannot act on it, and telling them which roles are unbound
    // is deployment configuration they have no business seeing.
    mockStatus(UNBOUND);
    renderIt();

    await screen.findByRole('alert');
    expect(
      screen.queryByRole('link', { name: /Open AI settings/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/tutor and grader/i)).not.toBeInTheDocument();
  });

  it('still tells a non-admin their key is fine', async () => {
    // The part that is for everyone.
    mockStatus(UNBOUND);
    renderIt();

    expect(
      await screen.findByText(/This is not a problem with your key/i),
    ).toBeInTheDocument();
  });
});

describe('AiNotReady — role formatting', () => {
  it('joins one role plainly', async () => {
    mockStatus({ ...UNBOUND, unboundRoles: ['grader'] });
    renderIt({}, mockAdminUser);

    expect(await screen.findByText('grader')).toBeInTheDocument();
  });

  it('joins three with commas and an "and"', async () => {
    // The difference between a sentence and a log line.
    mockStatus({ ...UNBOUND, unboundRoles: ['tutor', 'grader', 'speak'] });
    renderIt({}, mockAdminUser);

    expect(await screen.findByText('tutor, grader and speak')).toBeInTheDocument();
  });
});

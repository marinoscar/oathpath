/**
 * `/settings/reset` — the "Danger zone" page (issue #270).
 *
 * `useAccountReset` is mocked (it powers the real `ResetAccountDialog` this
 * page renders — see that dialog's own suite for its internals), and so are
 * the three contexts `handleReset` refreshes: `AuthContext`, `LearnerProfileContext`
 * and `AiStatusContext`. That is what lets these tests assert the one thing
 * that is actually this PAGE's own logic and not the dialog's or a context's:
 * refresh-then-navigate, IN ORDER, per scope — see `UserDataResetPage.tsx`'s
 * own header on why the order is not interchangeable ("REFRESH THE CONTEXTS
 * BEFORE NAVIGATING, NEVER THE REVERSE").
 *
 * Call order is tracked with a shared array rather than three independent
 * `toHaveBeenCalled` assertions, because independent assertions cannot tell a
 * correct sequence from an accidentally-correct one (e.g. all three firing in
 * parallel would still make each one individually true).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Call-order tracking
// ---------------------------------------------------------------------------

let callOrder: string[] = [];

const mockNavigate = vi.fn((to: string) => {
  callOrder.push(`navigate:${to}`);
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockRefreshUser = vi.fn(async () => {
  callOrder.push('refreshUser');
});

vi.mock('../../contexts/AuthContext', async () => {
  const actual = await vi.importActual<typeof import('../../contexts/AuthContext')>(
    '../../contexts/AuthContext',
  );
  return {
    ...actual,
    useAuth: () => ({
      user: null,
      isLoading: false,
      isAuthenticated: true,
      providers: [],
      login: vi.fn(),
      logout: vi.fn(),
      refreshUser: mockRefreshUser,
    }),
  };
});

const mockRefreshLearnerProfile = vi.fn(async () => {
  callOrder.push('refreshLearnerProfile');
});

vi.mock('../../contexts/LearnerProfileContext', () => ({
  useLearnerProfile: () => ({
    profile: null,
    testVersions: [],
    states: [],
    isLoading: false,
    hasError: false,
    refresh: mockRefreshLearnerProfile,
    applyProfile: vi.fn(),
  }),
}));

const mockRefreshAiStatus = vi.fn(async () => {
  callOrder.push('refreshAiStatus');
});

vi.mock('../../contexts/AiStatusContext', () => ({
  useAiStatus: () => ({
    status: null,
    isLoading: false,
    hasError: false,
    refresh: mockRefreshAiStatus,
  }),
}));

// ---------------------------------------------------------------------------
// `useAccountReset` — the hook the real `ResetAccountDialog` this page
// renders is built on. Mocked here for the same reason
// `ResetAccountDialog.test.tsx` mocks it: this page's own suite is not the
// place to re-prove the dialog's summary/phrase logic.
// ---------------------------------------------------------------------------

vi.mock('../../hooks/useAccountReset', () => ({
  useAccountReset: vi.fn(),
}));

import { useAccountReset } from '../../hooks/useAccountReset';
import UserDataResetPage from '../../pages/UserDataResetPage';
import type { AccountDataSummary, AccountResetResult, AccountResetScope } from '../../types';

const mockUseAccountReset = vi.mocked(useAccountReset);

const SUMMARY: AccountDataSummary = {
  counts: { practice_attempts: 42 },
  phrases: {
    data: 'DELETE MY DATA',
    data_and_key: 'DELETE EVERYTHING',
  },
};

const mockReset = vi.fn();

function resultFor(scope: AccountResetScope): AccountResetResult {
  return {
    scope,
    deleted: { practice_attempts: 42 },
    aiKeyRemoved: scope === 'data_and_key',
  };
}

function renderPage() {
  return render(<UserDataResetPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  callOrder = [];
  mockUseAccountReset.mockReturnValue({
    summary: SUMMARY,
    isLoading: false,
    loadError: null,
    isResetting: false,
    resetError: null,
    reset: mockReset,
    refresh: vi.fn(),
    clearResetError: vi.fn(),
  });
});

describe('UserDataResetPage — the two actions', () => {
  it('renders both buttons with their own copy', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'Reset my data' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Reset everything, including my AI key' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset my data' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset everything' })).toBeInTheDocument();
  });

  it('opens the dialog with scope "data" from the first button', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Reset my data' }));

    expect(await screen.findByRole('heading', { name: 'Reset your data?' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Type DELETE MY DATA to confirm/)).toBeInTheDocument();
    // The "data" scope keeps the AI key — the dialog says so.
    expect(screen.getByText('Your saved AI key stays.')).toBeInTheDocument();
  });

  it('opens the dialog with scope "data_and_key" from the second button', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Reset everything' }));

    expect(await screen.findByRole('heading', { name: 'Reset everything?' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Type DELETE EVERYTHING to confirm/)).toBeInTheDocument();
    expect(screen.queryByText('Your saved AI key stays.')).not.toBeInTheDocument();
  });
});

describe('UserDataResetPage — scope "data": refresh order then navigate', () => {
  it('awaits refreshUser, then refreshLearnerProfile, BEFORE navigating to /setup/journey — and never touches AI status', async () => {
    mockReset.mockResolvedValue(resultFor('data'));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Reset my data' }));
    await user.type(
      await screen.findByLabelText(/Type DELETE MY DATA to confirm/),
      'DELETE MY DATA',
    );
    await user.click(screen.getByRole('button', { name: 'Erase my data' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());

    expect(callOrder).toEqual([
      'refreshUser',
      'refreshLearnerProfile',
      'navigate:/setup/journey',
    ]);
    expect(mockNavigate).toHaveBeenCalledWith('/setup/journey', { replace: true });
    expect(mockRefreshAiStatus).not.toHaveBeenCalled();
  });
});

describe('UserDataResetPage — scope "data_and_key": refresh order then navigate', () => {
  it('awaits refreshUser, refreshLearnerProfile, THEN refreshAiStatus, BEFORE navigating to /setup/ai-key', async () => {
    mockReset.mockResolvedValue(resultFor('data_and_key'));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Reset everything' }));
    await user.type(
      await screen.findByLabelText(/Type DELETE EVERYTHING to confirm/),
      'DELETE EVERYTHING',
    );
    await user.click(screen.getByRole('button', { name: 'Erase my data' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());

    expect(callOrder).toEqual([
      'refreshUser',
      'refreshLearnerProfile',
      'refreshAiStatus',
      'navigate:/setup/ai-key',
    ]);
    expect(mockNavigate).toHaveBeenCalledWith('/setup/ai-key', { replace: true });
  });
});

describe('UserDataResetPage — a failed reset', () => {
  it('does not refresh anything or navigate when the dialog never calls onReset', async () => {
    // The hook contract: a failed reset() resolves undefined and sets
    // resetError; the dialog does not fire onReset in that case (see
    // ResetAccountDialog.test.tsx). Nothing on this page should run either.
    mockReset.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Reset my data' }));
    await user.type(
      await screen.findByLabelText(/Type DELETE MY DATA to confirm/),
      'DELETE MY DATA',
    );
    await user.click(screen.getByRole('button', { name: 'Erase my data' }));

    await waitFor(() => expect(mockReset).toHaveBeenCalled());

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockRefreshUser).not.toHaveBeenCalled();
    expect(mockRefreshLearnerProfile).not.toHaveBeenCalled();
  });
});

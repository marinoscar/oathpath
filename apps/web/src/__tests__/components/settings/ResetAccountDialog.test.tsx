/**
 * `ResetAccountDialog` — the typed-confirmation dialog behind both
 * "Danger zone" actions (issue #270).
 *
 * `useAccountReset` is mocked (not the API client), matching
 * `PersonalAccessTokens.test.tsx`'s convention for a destructive action behind
 * a confirmation dialog: the dialog's OWN logic — which counts render, which
 * "kept" line shows per scope, whether the typed phrase matches — is what
 * these tests are about, not the hook's fetch/error plumbing (covered by
 * `useAccountReset.test.ts`).
 *
 * Run for BOTH scopes, because the "kept" line and the required phrase differ
 * between them and a suite that only ever mounted `scope="data"` could not
 * tell a scope mix-up from a real pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';

vi.mock('../../../hooks/useAccountReset', () => ({
  useAccountReset: vi.fn(),
}));

import { useAccountReset } from '../../../hooks/useAccountReset';
import {
  ResetAccountDialog,
  type ResetAccountDialogProps,
} from '../../../components/settings/ResetAccountDialog';
import type { AccountDataSummary, AccountResetResult, AccountResetScope } from '../../../types';

const mockUseAccountReset = vi.mocked(useAccountReset);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUMMARY: AccountDataSummary = {
  counts: {
    practice_attempts: 42,
    mock_interviews: 0,
    readiness_snapshots: 5,
    daily_activity: 0,
  },
  phrases: {
    data: 'DELETE MY DATA',
    data_and_key: 'DELETE EVERYTHING',
  },
};

function resultFor(scope: AccountResetScope): AccountResetResult {
  return {
    scope,
    deleted: { practice_attempts: 42, readiness_snapshots: 5 },
    aiKeyRemoved: scope === 'data_and_key',
  };
}

const mockReset = vi.fn();
const mockClearResetError = vi.fn();
const mockRefresh = vi.fn();

function setHookState({
  summary = SUMMARY,
  isLoading = false,
  isResetting = false,
  resetError = null as string | null,
} = {}) {
  mockUseAccountReset.mockReturnValue({
    summary,
    isLoading,
    loadError: null,
    isResetting,
    resetError,
    reset: mockReset,
    refresh: mockRefresh,
    clearResetError: mockClearResetError,
  });
}

function renderDialog(overrides: Partial<ResetAccountDialogProps> = {}) {
  const onClose = vi.fn();
  const onReset = vi.fn();
  const props: ResetAccountDialogProps = {
    open: true,
    scope: 'data',
    onClose,
    onReset,
    ...overrides,
  };
  const utils = render(<ResetAccountDialog {...props} />);
  return { ...utils, onClose, onReset };
}

// ---------------------------------------------------------------------------

describe.each([['data'], ['data_and_key']] as const)(
  'ResetAccountDialog — scope=%s',
  (scope) => {
    beforeEach(() => {
      vi.clearAllMocks();
      setHookState();
      mockReset.mockResolvedValue(resultFor(scope));
    });

    const phrase = SUMMARY.phrases[scope];
    const confirmLabel = scope === 'data' ? 'Erase my data' : 'Erase everything';

    it('renders the non-zero counts and omits the zero ones', () => {
      renderDialog({ scope });

      expect(screen.getByText('42 practice attempts')).toBeInTheDocument();
      expect(screen.getByText('5 readiness snapshots')).toBeInTheDocument();
      expect(screen.queryByText(/mock interviews/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/days of recorded activity/i)).not.toBeInTheDocument();
    });

    it('always keeps sign-in and the account', () => {
      renderDialog({ scope });
      expect(screen.getByText('Your sign-in and account stay.')).toBeInTheDocument();
    });

    it(
      scope === 'data'
        ? 'keeps the AI key — mentioned'
        : 'removes the AI key — NOT mentioned as kept',
      () => {
        renderDialog({ scope });
        const aiKeyKept = screen.queryByText('Your saved AI key stays.');
        if (scope === 'data') {
          expect(aiKeyKept).toBeInTheDocument();
        } else {
          expect(aiKeyKept).not.toBeInTheDocument();
        }
      },
    );

    it('disables the confirm button initially', () => {
      renderDialog({ scope });
      expect(screen.getByRole('button', { name: confirmLabel })).toBeDisabled();
    });

    it('keeps the confirm button disabled for a wrong phrase, and never calls reset', async () => {
      const user = userEvent.setup();
      renderDialog({ scope });

      await user.type(screen.getByLabelText(new RegExp(`Type ${phrase} to confirm`)), 'nope');

      expect(screen.getByRole('button', { name: confirmLabel })).toBeDisabled();
      expect(mockReset).not.toHaveBeenCalled();
    });

    it('enables the confirm button once the exact phrase is typed', async () => {
      const user = userEvent.setup();
      renderDialog({ scope });

      await user.type(screen.getByLabelText(new RegExp(`Type ${phrase} to confirm`)), phrase);

      expect(screen.getByRole('button', { name: confirmLabel })).toBeEnabled();
    });

    it('calls reset(scope, phrase) on confirm, then onReset and onClose on success', async () => {
      const user = userEvent.setup();
      const { onClose, onReset } = renderDialog({ scope });

      await user.type(screen.getByLabelText(new RegExp(`Type ${phrase} to confirm`)), phrase);
      await user.click(screen.getByRole('button', { name: confirmLabel }));

      await waitFor(() => expect(mockReset).toHaveBeenCalledWith(scope, phrase));
      await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('shows the error and does NOT call onReset when the hook reports a resetError', async () => {
      // The hook's `reset()` never throws (see useAccountReset.test.ts) — a
      // failed attempt resolves `undefined` and sets `resetError`, which is
      // what the dialog actually renders on. Mirror both halves of that
      // contract here.
      mockReset.mockResolvedValue(undefined);
      setHookState({ resetError: 'Wrong confirmation phrase.' });

      const user = userEvent.setup();
      const { onClose, onReset } = renderDialog({ scope });

      await user.type(screen.getByLabelText(new RegExp(`Type ${phrase} to confirm`)), phrase);
      await user.click(screen.getByRole('button', { name: confirmLabel }));

      await waitFor(() => expect(mockReset).toHaveBeenCalledWith(scope, phrase));
      expect(screen.getByRole('alert')).toHaveTextContent('Wrong confirmation phrase.');
      expect(onReset).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('gives the phrase field an accessible name naming the required phrase', () => {
      renderDialog({ scope });
      expect(
        screen.getByLabelText(`Type ${phrase} to confirm`),
      ).toBeInTheDocument();
    });
  },
);

// ---------------------------------------------------------------------------
// Behavior shared across scopes
// ---------------------------------------------------------------------------

describe('ResetAccountDialog — loading state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a loading affordance instead of a broken/empty list while summary is undefined', () => {
    setHookState({ summary: undefined, isLoading: true });
    renderDialog();

    // No consequence list yet — nothing from a previous or default summary
    // leaks through while the real one is still loading.
    expect(screen.queryByText(/practice attempts/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing yet/i)).not.toBeInTheDocument();
    // No usable phrase field either — nothing to type against yet.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erase my data' })).toBeDisabled();
  });

  it('shows the "nothing recorded" line when every count is zero', () => {
    setHookState({
      summary: { counts: {}, phrases: SUMMARY.phrases },
    });
    renderDialog();

    expect(
      screen.getByText('Nothing yet — your account has no recorded data.'),
    ).toBeInTheDocument();
  });
});

describe('ResetAccountDialog — reopening / changing scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setHookState();
    mockReset.mockResolvedValue(resultFor('data'));
  });

  it('clears a typed value when the scope changes', async () => {
    const user = userEvent.setup();
    const { rerender } = renderDialog({ scope: 'data' });

    const dataField = screen.getByLabelText(/Type DELETE MY DATA to confirm/);
    await user.type(dataField, 'DELETE MY DATA');
    expect(screen.getByRole('button', { name: 'Erase my data' })).toBeEnabled();

    rerender(
      <ResetAccountDialog open scope="data_and_key" onClose={vi.fn()} onReset={vi.fn()} />,
    );

    const keyField = await screen.findByLabelText(/Type DELETE EVERYTHING to confirm/);
    expect(keyField).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Erase everything' })).toBeDisabled();
  });

  it('clears a stale resetError via clearResetError when the dialog reopens', () => {
    const { rerender } = renderDialog({ open: false, scope: 'data' });
    mockClearResetError.mockClear();

    rerender(<ResetAccountDialog open scope="data" onClose={vi.fn()} onReset={vi.fn()} />);

    expect(mockClearResetError).toHaveBeenCalled();
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdateAvailableSnackbar } from '../../components/pwa/UpdateAvailableSnackbar';
import {
  notifyUpdateReady,
  resetUpdateStateForTests,
} from '../../sw/registerServiceWorker';

// =============================================================================
// "A new version is available"  (issue #359, epic #345)
// =============================================================================
//
// The acceptance criterion is that a new deployment reaches an already-installed
// client WITHOUT the learner clearing site data. The mechanism has two halves,
// and this suite covers the visible one: the worker installs and waits (asserted
// in `service-worker.test.ts`: no `skipWaiting()` on install), and this banner
// is what turns that waiting worker into something a person can act on.
//
// `notifyUpdateReady` is the seam. Driving it directly is deliberate — jsdom
// implements no `navigator.serviceWorker`, so the alternative is a suite that
// mocks the entire registration API and ends up asserting the mock.
// =============================================================================

describe('UpdateAvailableSnackbar', () => {
  beforeEach(() => resetUpdateStateForTests());
  afterEach(() => resetUpdateStateForTests());

  it('renders nothing until an update is actually detected', () => {
    render(<UpdateAvailableSnackbar />);

    expect(screen.queryByText(/new version is available/i)).not.toBeInTheDocument();
  });

  it('renders the affordance when an update is detected', () => {
    render(<UpdateAvailableSnackbar />);

    act(() => notifyUpdateReady(vi.fn()));

    expect(screen.getByText(/a new version is available/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });

  it('applies the update when Reload is pressed', async () => {
    // This is the `postMessage({ type: 'SKIP_WAITING' })` the worker's own
    // message handler is waiting for — see `service-worker.test.ts`.
    const user = userEvent.setup();
    const applyUpdate = vi.fn();
    render(<UpdateAvailableSnackbar />);

    act(() => notifyUpdateReady(applyUpdate));
    await user.click(screen.getByRole('button', { name: /reload/i }));

    expect(applyUpdate).toHaveBeenCalledOnce();
  });

  it('tells a component that mounts AFTER the update was detected', () => {
    // A deployment can land while the tab is on a lazy route that has not
    // finished loading. The publisher latches, so the banner is not lost.
    act(() => notifyUpdateReady(vi.fn()));

    render(<UpdateAvailableSnackbar />);

    expect(screen.getByText(/a new version is available/i)).toBeInTheDocument();
  });

  it('can be closed without applying the update', async () => {
    // Closing is not the same as updating: the waiting worker stays waiting and
    // takes over on the next navigation. Nothing is lost by dismissing.
    const user = userEvent.setup();
    const applyUpdate = vi.fn();
    render(<UpdateAvailableSnackbar />);

    act(() => notifyUpdateReady(applyUpdate));
    await user.click(screen.getByRole('button', { name: /close/i }));

    // `waitFor`, because MUI's Snackbar keeps its children mounted for the
    // duration of the exit transition.
    await waitFor(() =>
      expect(screen.queryByText(/a new version is available/i)).not.toBeInTheDocument(),
    );
    expect(applyUpdate).not.toHaveBeenCalled();
  });
});

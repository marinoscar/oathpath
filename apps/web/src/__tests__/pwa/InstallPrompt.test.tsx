import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InstallPrompt } from '../../components/pwa/InstallPrompt';
import { INSTALL_PROMPT_DISMISSED_KEY } from '../../hooks/useInstallPrompt';

// =============================================================================
// The install offer  (issue #359, epic #345)
// =============================================================================
//
// Two acceptance criteria, both asserted here: "offered once and dismissible",
// and "never an interstitial".
//
// The second is asserted structurally rather than visually — the offer is a
// Snackbar, so it is `position: fixed`, it takes no focus, and it covers
// nothing. What a test CAN pin down is that it never renders unless the browser
// itself said the app is installable, and that it never comes back once
// dismissed. Both are the difference between an offer and a nag.
// =============================================================================

/**
 * A stand-in for Chromium's `BeforeInstallPromptEvent`, which no other browser
 * and no jsdom implements.
 */
function fireBeforeInstallPrompt(prompt = vi.fn(async () => undefined)) {
  const event = new Event('beforeinstallprompt') as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };
  event.prompt = prompt;
  event.userChoice = Promise.resolve({ outcome: 'accepted' as const });
  act(() => {
    window.dispatchEvent(event);
  });
  return { event, prompt };
}

describe('InstallPrompt', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders nothing until the browser says the app is installable', () => {
    // No `beforeinstallprompt`, no offer. An install button that is always
    // there and does nothing on iOS is exactly the noise this avoids.
    render(<InstallPrompt />);

    expect(screen.queryByText(/home screen/i)).not.toBeInTheDocument();
  });

  it('offers the install once beforeinstallprompt fires', () => {
    render(<InstallPrompt />);

    fireBeforeInstallPrompt();

    expect(screen.getByText(/add to your home screen/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /install/i })).toBeInTheDocument();
  });

  it('is dismissible', async () => {
    const user = userEvent.setup();
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();

    await user.click(screen.getByRole('button', { name: /close/i }));

    // `waitFor`, because MUI's Snackbar keeps its children mounted for the
    // duration of the exit transition.
    await waitFor(() =>
      expect(screen.queryByText(/add to your home screen/i)).not.toBeInTheDocument(),
    );
  });

  it('persists the dismissal', async () => {
    const user = userEvent.setup();
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();

    await user.click(screen.getByRole('button', { name: /close/i }));

    expect(window.localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY)).toBe('true');
  });

  it('does not reappear after dismissal, even on a fresh mount and a fresh event', async () => {
    // THE "offered once" CRITERION. Chromium re-fires `beforeinstallprompt` on
    // every page load while the app stays installable, so an offer that only
    // remembered in component state would be back on the learner's next visit.
    const user = userEvent.setup();
    const first = render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    await user.click(screen.getByRole('button', { name: /close/i }));
    first.unmount();

    render(<InstallPrompt />);
    fireBeforeInstallPrompt();

    expect(screen.queryByText(/add to your home screen/i)).not.toBeInTheDocument();
  });

  it('shows the browser dialog on Install and then stops offering', async () => {
    const user = userEvent.setup();
    const prompt = vi.fn(async () => undefined);
    render(<InstallPrompt />);
    fireBeforeInstallPrompt(prompt);

    await user.click(screen.getByRole('button', { name: /install/i }));

    expect(prompt).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByText(/add to your home screen/i)).not.toBeInTheDocument(),
    );
    // Re-offering something the learner just answered — either way — is the
    // nagging the criterion rules out.
    expect(window.localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY)).toBe('true');
  });

  it('stops offering once the app reports itself installed', async () => {
    // Installed by any route — the button above, or the browser's own menu.
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    expect(screen.getByText(/add to your home screen/i)).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event('appinstalled'));
    });

    await waitFor(() =>
      expect(screen.queryByText(/add to your home screen/i)).not.toBeInTheDocument(),
    );
    expect(window.localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY)).toBe('true');
  });

  it('survives localStorage throwing, which is Safari private mode', () => {
    // Not a hypothetical: `localStorage` getters throw outright there, and an
    // unguarded read would take the whole app down at mount.
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('SecurityError');
      });

    expect(() => render(<InstallPrompt />)).not.toThrow();

    getItem.mockRestore();
  });
});

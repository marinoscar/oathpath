/**
 * ONE form component, two chromes — asserted structurally (issue #77, epic #50).
 *
 * `/setup/journey` (#72) and `/settings/journey` (#77) ask the same six
 * questions, and #77's acceptance criterion is not "the settings page has a
 * form that looks the same" but "the form component is the one `/setup/journey`
 * uses, IMPORTED NOT COPIED". A duplicated component would satisfy every
 * behavioural test in `UserJourneyPage.test.tsx` on the day it was copied, and
 * would drift a release later — the copy that drifts first being the COPY
 * itself, which is this component's whole deliverable.
 *
 * So the proof here is module identity rather than appearance. `vi.mock`
 * replaces exactly one module path, and both pages are then rendered: a page
 * holding a forked copy would render its own fields and fail. Reading the
 * imports of the two files would prove much less — a copy could import a
 * DIFFERENT module of the same shape, and the assertion would still read as
 * though it had checked something.
 *
 * This lives in its own file because `vi.mock` is file-scoped: every other
 * journey suite needs the real form.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { AuthContext } from '../../contexts/AuthContext';
import { mockUser } from '../utils/test-utils';

/**
 * THE one module. Both pages must resolve to this exact specifier for the mock
 * to reach them, which is the assertion.
 */
vi.mock('../../components/journey/JourneyProfileForm', () => ({
  JourneyProfileForm: ({ submitLabel }: { submitLabel?: string }) => (
    <div data-testid="shared-journey-form" data-submit-label={submitLabel} />
  ),
  // Re-exported because `OrientationPage.test.tsx` imports it from the same
  // module; mocking a module replaces ALL of its exports, so anything the pages
  // (or their imports) reach for has to exist here too.
  resolveTestVersionForFilingDate: () => null,
}));

import OrientationPage from '../../pages/OrientationPage';
import UserJourneyPage from '../../pages/UserJourneyPage';

function renderWithAuth(element: ReactElement) {
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
      <MemoryRouter>{element}</MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('JourneyProfileForm — shared by both chromes, not duplicated', () => {
  it('is the component /setup/journey renders', () => {
    renderWithAuth(<OrientationPage />);
    expect(screen.getByTestId('shared-journey-form')).toBeInTheDocument();
  });

  it('is the component /settings/journey renders — the SAME module, mocked once', () => {
    renderWithAuth(<UserJourneyPage />);
    expect(screen.getByTestId('shared-journey-form')).toBeInTheDocument();
  });

  it('differs between the two chromes only by props', () => {
    // The settings page is not handing off anywhere, so its action says what
    // it does; orientation continues into the app.
    const { unmount } = renderWithAuth(<OrientationPage />);
    expect(screen.getByTestId('shared-journey-form')).toHaveAttribute(
      'data-submit-label',
      'Save and continue',
    );
    unmount();

    renderWithAuth(<UserJourneyPage />);
    expect(screen.getByTestId('shared-journey-form')).toHaveAttribute(
      'data-submit-label',
      'Save changes',
    );
  });

  it('has no second copy of the form component anywhere under src/', () => {
    // The complement of the mock: module identity proves the two pages agree,
    // and this proves nobody has landed a parallel implementation beside it.
    // Written against the file NAME rather than its contents so it cannot be
    // fooled by reformatting.
    const componentsDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../',
    );
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/JourneyProfileForm\.tsx$/.test(entry.name)) found.push(full);
      }
    };
    walk(componentsDir);

    expect(found).toHaveLength(1);
    expect(readFileSync(found[0], 'utf8')).toContain('export function JourneyProfileForm');
  });
});

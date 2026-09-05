import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { render, mockAdminUser } from '../utils/test-utils';
import { setViewportWidth } from '../setup';
import { BottomNav } from '../../components/navigation/BottomNav';

// =============================================================================
// Safe-area insets  (issue #359, epic #345)
// =============================================================================
//
// The acceptance criterion in the issue's own words: "`BottomNav` no longer
// sits under the home indicator on a gesture-bar device."
//
// Asserted against the EMITTED CSS RULES rather than `getComputedStyle`, the
// same technique `components/common/Layout.test.tsx` uses and for a related
// reason: jsdom does not implement `env()` at all, so a computed read reports
// an empty string whether the declaration is there or not — it would pass
// identically against the unfixed component.
//
// The paired assertion, that `<main>`'s bottom padding gained the same inset
// WITHOUT its breakpoint moving, lives in `Layout.test.tsx` next to the
// coupled-gate comment it belongs to.
// =============================================================================

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { usePermissions } from '../../hooks/usePermissions';

const mockUsePermissions = vi.mocked(usePermissions);

const PHONE = 375;

function emittedRulesFor(element: Element): string {
  const emotionClass = [...element.classList].find((name) => name.startsWith('css-'));
  expect(emotionClass, 'element carries no emotion class').toBeDefined();

  return [...document.querySelectorAll('style')]
    .map((style) => style.textContent ?? '')
    .join('')
    .split('}}')
    .filter((block) => block.includes(`.${emotionClass}{`))
    .join('}}');
}

describe('BottomNav safe-area insets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue({
      permissions: new Set<string>(),
      roles: new Set(['viewer']),
      hasPermission: () => false,
      hasAnyPermission: vi.fn(),
      hasAllPermissions: vi.fn(),
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isAdmin: false,
    });
    setViewportWidth(PHONE);
  });

  function renderBar() {
    render(<BottomNav />, { wrapperOptions: { route: '/', user: mockAdminUser } });
    act(() => setViewportWidth(PHONE));
    return screen.getByRole('button', { name: 'Home' }).closest('.MuiPaper-root')!;
  }

  it('pads the fixed bar by the bottom inset, so the labels clear the home indicator', () => {
    const paper = renderBar();

    expect(emittedRulesFor(paper)).toMatch(/padding-bottom:env\(safe-area-inset-bottom\)/);
  });

  it('pads the horizontal insets too, for a rounded display in landscape', () => {
    // The bar is `left: 0; right: 0`, so the outermost tabs otherwise sit under
    // the corner radius when a phone is turned sideways.
    const rules = emittedRulesFor(renderBar());

    expect(rules).toMatch(/padding-left:env\(safe-area-inset-left\)/);
    expect(rules).toMatch(/padding-right:env\(safe-area-inset-right\)/);
  });

  it('keeps the inset on the Paper, so the bar surface still reaches the screen edge', () => {
    // Padding on the inner `BottomNavigation` instead would leave the inset
    // strip transparent and show the scrolling page through it.
    const paper = renderBar();

    expect(paper.className).toContain('MuiPaper-root');
    expect(emittedRulesFor(paper)).toMatch(/position:fixed/);
    expect(emittedRulesFor(paper)).toMatch(/bottom:0/);
  });
});

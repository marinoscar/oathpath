/**
 * `SessionCelebration` — the earned sentence at the top of the practice
 * debrief (issue #138, epic #56 / E7 "Habit", `docs/specs/habit-streaks.md`
 * §8).
 *
 * The RULE is tested in `celebration-copy.test.ts`, against a table, with no
 * render in the loop. This file tests only what the component adds on top of
 * it: that it renders what the function returned rather than anything of its
 * own, that assistive technology is told, and that the motion is decoration a
 * learner can switch off without losing a word of the copy.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SessionCelebration } from '../../../components/home/SessionCelebration';
import type { CelebrationCopy } from '../../../components/home/celebration-copy';

const GOAL_MET: CelebrationCopy = {
  kind: 'goal',
  headline: 'That is 5 minutes today — your goal.',
  detail: 'That makes 4 days in a row.',
};

let restoreMatchMedia: (() => void) | null = null;

/** Makes `(prefers-reduced-motion: reduce)` match, delegating other queries. */
function preferReducedMotion(): void {
  const original = window.matchMedia;
  restoreMatchMedia = () => {
    window.matchMedia = original;
  };
  window.matchMedia = ((query: string) => {
    if (query.includes('prefers-reduced-motion')) {
      return {
        matches: true,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    }
    return original(query);
  }) as typeof window.matchMedia;
}

afterEach(() => {
  restoreMatchMedia?.();
  restoreMatchMedia = null;
});

describe('SessionCelebration', () => {
  it('renders the selected headline and detail verbatim', () => {
    render(<SessionCelebration copy={GOAL_MET} />);

    expect(screen.getByText('That is 5 minutes today — your goal.')).toBeInTheDocument();
    expect(screen.getByText('That makes 4 days in a row.')).toBeInTheDocument();
  });

  it('renders no second line when the rule found no second fact', () => {
    render(<SessionCelebration copy={{ ...GOAL_MET, detail: null }} />);

    expect(screen.getByText('That is 5 minutes today — your goal.')).toBeInTheDocument();
    expect(screen.queryByText(/days in a row/)).not.toBeInTheDocument();
  });

  it('announces itself politely, so it is not missed by a screen reader', () => {
    render(<SessionCelebration copy={GOAL_MET} />);

    const panel = screen.getByRole('status');
    expect(panel).toHaveAttribute('aria-live', 'polite');
    expect(panel).toHaveTextContent('That is 5 minutes today — your goal.');
  });

  it('animates in by default', () => {
    render(<SessionCelebration copy={GOAL_MET} />);

    expect(screen.getByTestId('session-celebration')).toHaveAttribute(
      'data-motion',
      'animated',
    );
  });

  it('suppresses the motion under prefers-reduced-motion, keeping every word', () => {
    preferReducedMotion();
    render(<SessionCelebration copy={GOAL_MET} />);

    const panel = screen.getByTestId('session-celebration');
    expect(panel).toHaveAttribute('data-motion', 'reduced');
    // §8: "the identical specific, earned copy with no confetti, no ring
    // animation, and no motion at all standing in for it."
    expect(panel).toHaveTextContent('That is 5 minutes today — your goal.');
    expect(panel).toHaveTextContent('That makes 4 days in a row.');
  });
});

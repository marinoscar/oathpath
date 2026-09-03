/**
 * `ConsistencyCard` — Home's goal ring, streak and freeze budget (issue #138,
 * epic #56 / E7 "Habit", `docs/specs/habit-streaks.md` §4.5, §4.6, §8).
 *
 * WHAT THESE TESTS PROTECT, in order of how quietly each would break:
 *
 *  1. **Every number on screen is the server's.** The ring, the streak, the
 *     longest run and the freeze count are all fields of one response. A
 *     browser-side recount — of the streak's "today or yesterday" anchor rule
 *     especially (§4.1) — would agree with the server most days and disagree
 *     at 2pm on the one day the rule exists for. Asserted by serving numbers
 *     that could not have been derived from each other and requiring exactly
 *     those.
 *  2. **Freezes are protection, never scarcity (§4.5).** This is a product
 *     rule, so it is tested as one: the copy for a held freeze must read as
 *     cover the learner has, and a learner holding none must be shown NO
 *     freeze line at all — no "0 left", no countdown, nothing.
 *  3. **The zero state is an invitation.** A learner with nothing yet reads
 *     what a session costs, not what they are missing.
 *  4. **Motion is opt-out.** Under `prefers-reduced-motion` the ring's fill
 *     transition is suppressed outright, not shortened.
 *  5. **It fits a 360px phone and does not change across the `sm` boundary** —
 *     none of `CLAUDE.md`'s five coupled gates is touched by this surface.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';

import { ConsistencyCard } from '../../../components/home/ConsistencyCard';
import { setViewportWidth } from '../../setup';
import {
  emptyEngagementSummary,
  engagementSummary,
} from '../../utils/engagement-fixtures';
import type { EngagementSummary } from '../../../types';

const HEADING_ID = 'daily-goal-heading';
const PHONE = 360;
const SM = 600;

function renderCard(engagement: EngagementSummary = engagementSummary()) {
  return render(<ConsistencyCard engagement={engagement} headingId={HEADING_ID} />);
}

/**
 * Makes `(prefers-reduced-motion: reduce)` match for the duration of a test,
 * delegating every other query to the suite's own width-aware mock so
 * breakpoints keep working. Restored by the `afterEach` below.
 */
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

let restoreMatchMedia: (() => void) | null = null;

afterEach(() => {
  restoreMatchMedia?.();
  restoreMatchMedia = null;
  setViewportWidth(1440);
});

// =============================================================================
// 1. The measured ring
// =============================================================================

describe('ConsistencyCard — the goal ring', () => {
  it('reports today’s measured minutes against the learner’s own goal', () => {
    renderCard(
      engagementSummary({
        dailyGoalMinutes: 10,
        today: {
          date: '2026-04-10',
          practiceSeconds: 240,
          attempts: 4,
          correct: 3,
          goalMet: false,
        },
      }),
    );

    const ring = screen.getByRole('progressbar');
    expect(ring).toHaveAttribute('aria-valuenow', '4');
    expect(ring).toHaveAttribute('aria-valuemax', '10');
    expect(ring).toHaveAttribute('aria-valuetext', '4 minutes of 10 today');
  });

  it('rounds down, never up — 4 minutes 55 seconds is 4 minutes', () => {
    renderCard(
      engagementSummary({
        dailyGoalMinutes: 5,
        today: {
          date: '2026-04-10',
          practiceSeconds: 295,
          attempts: 4,
          correct: 4,
          goalMet: false,
        },
      }),
    );

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4');
  });

  it('says the goal is met when the SERVER says so — never by its own arithmetic', () => {
    // `goalMet` is monotonic (§2.3): a day earned under a 5-minute goal stays
    // earned after the learner raises the goal to 15. Recomputing
    // `seconds >= goal * 60` in the browser would silently un-earn it, so the
    // fixture is exactly that case: 300 measured seconds, a 15-minute goal,
    // and `goalMet: true`.
    renderCard(
      engagementSummary({
        dailyGoalMinutes: 15,
        today: {
          date: '2026-04-10',
          practiceSeconds: 300,
          attempts: 5,
          correct: 5,
          goalMet: true,
        },
      }),
    );

    expect(screen.getByText('That is 5 minutes today — your goal.')).toBeInTheDocument();
  });
});

// =============================================================================
// 2. The streak
// =============================================================================

describe('ConsistencyCard — the streak', () => {
  it('renders the server’s current streak prominently and the longest run beside it', () => {
    // 4 and 9 could not be derived from one another, or from `recentDays`.
    renderCard(engagementSummary({ streak: { current: 4, longest: 9 } }));

    const streak = screen.getByTestId('streak');
    expect(within(streak).getByText('4')).toBeInTheDocument();
    expect(within(streak).getByText('days in a row')).toBeInTheDocument();
    expect(within(streak).getByText('Your longest run so far is 9 days.')).toBeInTheDocument();
  });

  it('says "day in a row" for a streak of one', () => {
    renderCard(engagementSummary({ streak: { current: 1, longest: 1 } }));

    const streak = screen.getByTestId('streak');
    expect(within(streak).getByText('day in a row')).toBeInTheDocument();
    expect(within(streak).getByText('Your longest run so far is 1 day.')).toBeInTheDocument();
  });
});

// =============================================================================
// 3. Freezes — protection, never a countdown (§4.5)
// =============================================================================

describe('ConsistencyCard — freezes', () => {
  it('states a held freeze as cover the learner already has', () => {
    renderCard(
      engagementSummary({ streak: { current: 4, longest: 9 }, freezes: { remaining: 2, max: 2 } }),
    );

    expect(
      screen.getByText('Your streak is protected today — you have 2 streak freezes in hand.'),
    ).toBeInTheDocument();
  });

  it('never counts down, and never names the ceiling', () => {
    renderCard(engagementSummary({ freezes: { remaining: 1, max: 2 } }));

    const card = screen.getByTestId('daily-goal');
    const text = card.textContent ?? '';
    expect(text).toContain('1 streak freeze in hand');
    // §4.5's forbidden shapes: a remaining-count, a ceiling, an expiry.
    expect(text).not.toMatch(/left|remaining|only|1 of 2|out of 2|expire/i);
  });

  it('says nothing at all about freezes when the learner holds none', () => {
    // "0 freezes left" is a scarcity counter with the numeral changed. The
    // absence of protection is not a fact this surface owes anybody.
    renderCard(engagementSummary({ freezes: { remaining: 0, max: 2 } }));

    expect(screen.getByTestId('daily-goal').textContent ?? '').not.toMatch(/freeze/i);
  });
});

// =============================================================================
// 4. The zero state — an invitation, never a deficit
// =============================================================================

describe('ConsistencyCard — a learner with nothing yet', () => {
  it('invites a session instead of reporting a shortfall', () => {
    renderCard(emptyEngagementSummary({ dailyGoalMinutes: 5 }));

    expect(
      screen.getByText('5 minutes is enough today — a quick session covers your goal.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No streak yet')).toBeInTheDocument();
    expect(screen.getByText('Practise today and your streak starts today.')).toBeInTheDocument();
  });

  it('names no failure, no loss and no missed day', () => {
    renderCard(emptyEngagementSummary());

    const text = screen.getByTestId('daily-goal').textContent ?? '';
    expect(text).not.toMatch(/missed|lost|broke|behind|fail|haven’t|haven't|don’t|don't/i);
  });

  it('still reports the honest measured zero to assistive technology', () => {
    // The zero is REAL now — E7 measures the day — so the ring reports it
    // rather than refusing to, which is what E1's placeholder had to do while
    // nothing was tracked (`journey-shell.md` §10).
    renderCard(emptyEngagementSummary({ dailyGoalMinutes: 5 }));

    const ring = screen.getByRole('progressbar');
    expect(ring).toHaveAttribute('aria-valuenow', '0');
    expect(ring).toHaveAttribute('aria-valuetext', 'no minutes of 5 today');
  });

  it('draws no filled arc when nothing has been measured', () => {
    renderCard(emptyEngagementSummary());

    expect(screen.queryByTestId('goal-ring-progress')).not.toBeInTheDocument();
  });
});

// =============================================================================
// 5. Motion
// =============================================================================

describe('ConsistencyCard — motion', () => {
  it('animates the ring’s fill by default', () => {
    renderCard();

    const arc = screen.getByTestId('goal-ring-progress');
    expect(arc).toHaveAttribute('data-motion', 'animated');
    expect(arc.getAttribute('style') ?? '').toContain('stroke-dashoffset');
  });

  it('suppresses the fill animation entirely under prefers-reduced-motion', () => {
    preferReducedMotion();
    renderCard();

    const arc = screen.getByTestId('goal-ring-progress');
    expect(arc).toHaveAttribute('data-motion', 'reduced');
    // Suppressed, not shortened: no transition at all.
    expect(arc.getAttribute('style') ?? '').toContain('transition: none');
  });

  it('shows the identical measured content with motion suppressed', () => {
    const { container: animated, unmount } = renderCard();
    const withMotion = animated.textContent;
    unmount();

    preferReducedMotion();
    const { container: still } = renderCard();
    expect(still.textContent).toBe(withMotion);
  });
});

// =============================================================================
// 6. Width
// =============================================================================

describe('ConsistencyCard — width', () => {
  it('renders the same content at 360px and across the sm boundary', async () => {
    setViewportWidth(PHONE);
    const { container } = renderCard();
    const atPhone = container.textContent;
    expect(atPhone).toContain('days in a row');

    await act(async () => setViewportWidth(SM - 1));
    expect(container.textContent).toBe(atPhone);

    await act(async () => setViewportWidth(SM));
    expect(container.textContent).toBe(atPhone);

    await act(async () => setViewportWidth(1200));
    expect(container.textContent).toBe(atPhone);
  });
});

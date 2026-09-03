/**
 * `PracticeQueueSummary` — the "Your queue" band (issue #90, epic #54 / E5).
 *
 * Two rules are load-bearing here, mirrored from the component's own header,
 * and every test below defends one of them.
 *
 *  1. **THE HEADLINE IS THREE BRANCHES IN A FIXED PRIORITY ORDER**, not a
 *     generic "N questions in your queue": review-first (`due + weak > 0`),
 *     then new-first, then a caught-up sentence once neither is true. A
 *     regression that inverted the priority — e.g. leading with `new` even
 *     when review evidence exists — would still "read fine" by itself, so
 *     each branch is asserted against a fixture where the OTHER branches'
 *     conditions are also non-zero, to prove the priority order and not just
 *     the sentence in isolation.
 *
 *  2. **THE BREAKDOWN IS A REAL `<dl>`**, with `dt` (label) before `dd`
 *     (count) in DOM order — a definition list reads correctly to assistive
 *     technology with no ARIA at all, which a row of styled `<div>`s would
 *     need to fake. That structure is asserted directly rather than assumed.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PracticeQueueSummary } from '../../../components/practice/PracticeQueueSummary';
import type { PracticeQueue } from '../../../types';

const HEADING_ID = 'practice-queue-heading';

function makeQueue(overrides: Partial<PracticeQueue> = {}): PracticeQueue {
  return {
    testVersionCode: 'v2008',
    total: 100,
    due: 0,
    weak: 0,
    new: { total: 0, byCategory: [] },
    learning: 0,
    mastered: 0,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Headline priority — review, then new, then caught up
// -----------------------------------------------------------------------------

describe('the headline', () => {
  it('leads with review when due + weak > 0, even though new material also remains', () => {
    // `new.total` and `learning`/`mastered` are all non-zero here on purpose —
    // this fixture would satisfy either of the other two branches, so a
    // regression that fell through to them would still pass a test built on
    // an all-review fixture alone.
    render(
      <PracticeQueueSummary
        queue={makeQueue({ due: 3, weak: 2, new: { total: 10, byCategory: [] }, learning: 4, mastered: 5 })}
        headingId={HEADING_ID}
      />,
    );

    expect(screen.getByText('5 questions ready to review.')).toBeInTheDocument();
    expect(
      screen.getByText(/due and struggling questions come up first/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/you haven.t seen yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/caught up/i)).not.toBeInTheDocument();
  });

  it('uses singular agreement for exactly one review question', () => {
    render(
      <PracticeQueueSummary queue={makeQueue({ due: 1, weak: 0 })} headingId={HEADING_ID} />,
    );

    expect(screen.getByText('1 question ready to review.')).toBeInTheDocument();
  });

  it('falls back to new material once review evidence is exhausted, even with mastered questions on the board', () => {
    render(
      <PracticeQueueSummary
        queue={makeQueue({
          due: 0,
          weak: 0,
          new: { total: 8, byCategory: [] },
          mastered: 20,
        })}
        headingId={HEADING_ID}
      />,
    );

    expect(screen.getByText("8 questions you haven't seen yet.")).toBeInTheDocument();
    expect(
      screen.getByText(/every new question you answer is more evidence/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ready to review/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/caught up/i)).not.toBeInTheDocument();
  });

  it('says the honest thing — caught up — only once both due+weak and new are zero', () => {
    render(
      <PracticeQueueSummary
        queue={makeQueue({ due: 0, weak: 0, new: { total: 0, byCategory: [] }, learning: 6, mastered: 14 })}
        headingId={HEADING_ID}
      />,
    );

    expect(screen.getByText("You're caught up for now.")).toBeInTheDocument();
    expect(
      screen.getByText(/keep sampling what you already know/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ready to review/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/you haven.t seen yet/i)).not.toBeInTheDocument();
  });

  it('renders the caught-up branch for a brand-new learner with every count at zero, without crashing', () => {
    render(<PracticeQueueSummary queue={makeQueue()} headingId={HEADING_ID} />);

    expect(screen.getByText("You're caught up for now.")).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// The breakdown — a real <dl>, all five counts, server numbers verbatim
// -----------------------------------------------------------------------------

describe('the breakdown', () => {
  it('renders all five counts from the fixture exactly as the server sent them', () => {
    const { container } = render(
      <PracticeQueueSummary
        queue={makeQueue({ due: 3, weak: 2, new: { total: 10, byCategory: [] }, learning: 7, mastered: 42 })}
        headingId={HEADING_ID}
      />,
    );

    const dl = container.querySelector('dl');
    expect(dl).not.toBeNull();

    const pairs = ['Due', 'Weak', 'New', 'Learning', 'Mastered'].map((label) => {
      const dt = screen.getByText(label);
      expect(dt.tagName.toLowerCase()).toBe('dt');
      return dt;
    });

    // Each dt is immediately followed by its dd, inside the dl — the actual
    // accessible structure, not just "the text is somewhere on the page".
    for (const dt of pairs) {
      expect(dl).toContainElement(dt);
      const dd = dt.nextElementSibling;
      expect(dd?.tagName.toLowerCase()).toBe('dd');
    }

    expect(screen.getByText('3').tagName.toLowerCase()).toBe('dd');
    expect(screen.getByText('2').tagName.toLowerCase()).toBe('dd');
    expect(screen.getByText('10').tagName.toLowerCase()).toBe('dd');
    expect(screen.getByText('7').tagName.toLowerCase()).toBe('dd');
    expect(screen.getByText('42').tagName.toLowerCase()).toBe('dd');
  });

  it('renders every count as a literal 0 for a brand-new learner, not an omitted stat', () => {
    render(<PracticeQueueSummary queue={makeQueue()} headingId={HEADING_ID} />);

    // Five stats, each showing 0 — the breakdown never hides a bucket just
    // because it is currently empty.
    expect(screen.getAllByText('0')).toHaveLength(5);
  });
});

// -----------------------------------------------------------------------------
// Accessible region
// -----------------------------------------------------------------------------

describe('the section as a whole', () => {
  it('labels the section from the same id its heading carries, so assistive tech announces it sensibly', () => {
    render(
      <PracticeQueueSummary queue={makeQueue({ due: 1 })} headingId={HEADING_ID} />,
    );

    const heading = screen.getByRole('heading', { level: 2, name: 'Your queue' });
    expect(heading).toHaveAttribute('id', HEADING_ID);

    const section = heading.closest('section');
    expect(section).toHaveAttribute('aria-labelledby', HEADING_ID);
  });
});

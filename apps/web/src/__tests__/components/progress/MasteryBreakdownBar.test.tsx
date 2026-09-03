/**
 * `MasteryBreakdownBar` — the shared five-state breakdown `/progress` renders
 * for both the overall summary and every category card.
 *
 * Issue #94, epic #54 / E5 "Memory".
 *
 * Two things are load-bearing here, so each gets its own describe block:
 *
 *  1. **The segments are proportional to the real counts**, in
 *     `MASTERY_STATE_ORDER` (least to most progressed), and a zero-count
 *     state contributes no segment.
 *  2. **The breakdown is not colour-only.** The bar itself carries
 *     `role="img"` and a summarising `aria-label`, and the legend beneath it
 *     is a real `<dl>` pairing every state's plain-language label
 *     (`masteryStateDisplay`, not the raw enum value) with its count — so a
 *     screen reader or a colour-blind reader gets the same information as the
 *     coloured segments, per `CLAUDE.md`'s accessibility baseline.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { MasteryBreakdownBar } from '../../../components/progress/MasteryBreakdownBar';
import type { MasteryStateCounts } from '../../../types';

function counts(overrides: Partial<MasteryStateCounts> = {}): MasteryStateCounts {
  return {
    new: 0,
    learning: 0,
    review: 0,
    lapsed: 0,
    mastered: 0,
    ...overrides,
  };
}

describe('MasteryBreakdownBar — proportions', () => {
  it('sizes each segment to its share of the total, in least-to-most-progressed order', () => {
    const byState = counts({ new: 2, learning: 1, review: 3, lapsed: 1, mastered: 3 });
    const { container } = render(
      <MasteryBreakdownBar byState={byState} total={10} aria-label="Test breakdown" />,
    );

    const bar = screen.getByRole('img', { name: 'Test breakdown' });
    // One rendered child per non-zero state, left to right in
    // `MASTERY_STATE_ORDER` — new, learning, review, lapsed, mastered.
    const segments = Array.from(bar.children) as HTMLElement[];
    expect(segments).toHaveLength(5);

    const expectedPercents = [20, 10, 30, 10, 30];
    segments.forEach((segment, i) => {
      expect(getComputedStyle(segment).width).toBe(`${expectedPercents[i]}%`);
    });

    // Sanity: this is the same container the bar renders into, not a stray
    // match elsewhere on the page.
    expect(container.querySelectorAll('[role="img"]')).toHaveLength(1);
  });

  it('renders no segment at all for a state with zero questions', () => {
    // Only two of the five states have any questions — the bar must render
    // exactly two children, not five with three collapsed to 0% width (which
    // would still add empty elements a screen reader has to skip past).
    const byState = counts({ learning: 4, mastered: 6 });
    render(<MasteryBreakdownBar byState={byState} total={10} aria-label="Sparse" />);

    const bar = screen.getByRole('img', { name: 'Sparse' });
    expect(bar.children).toHaveLength(2);
  });

  it('renders one full-width segment when every question is in a single state', () => {
    const byState = counts({ mastered: 8 });
    render(<MasteryBreakdownBar byState={byState} total={8} aria-label="All mastered" />);

    const bar = screen.getByRole('img', { name: 'All mastered' });
    const [segment] = Array.from(bar.children) as HTMLElement[];
    expect(getComputedStyle(segment).width).toBe('100%');
  });
});

describe('MasteryBreakdownBar — the zero-total case', () => {
  it('renders no bar at all for an empty scope, never a segment claiming a share of nothing', () => {
    render(<MasteryBreakdownBar byState={counts()} total={0} aria-label="Empty scope" />);

    // `total === 0` is a real value — a defensive client does not divide by
    // it, and it must not render a bar (with `role="img"`) that would imply a
    // measurement of an empty category.
    expect(screen.queryByRole('img', { name: 'Empty scope' })).not.toBeInTheDocument();
  });

  it('still renders the legend for a zero-total scope, every state at 0', () => {
    render(<MasteryBreakdownBar byState={counts()} total={0} aria-label="Empty scope" />);

    // The legend is not gated on `total > 0` — it names all five states even
    // when there is nothing to show, so the shape of the breakdown is never a
    // mystery.
    for (const label of ['New', 'Learning', 'In review', 'Lapsed', 'Mastered']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByText('0')).toHaveLength(5);
  });

  it('does not crash when called with an all-zero `byState` but a nonzero total', () => {
    // Defensive: a caller passing a total that disagrees with the sum of
    // `byState` (should not happen server-side, but a defensive client does
    // not divide by zero or throw on the mismatch either).
    expect(() =>
      render(<MasteryBreakdownBar byState={counts()} total={5} aria-label="Mismatched" />),
    ).not.toThrow();
  });
});

describe('MasteryBreakdownBar — not colour-only', () => {
  it('gives the bar an aria-label summarising the breakdown, not just coloured segments', () => {
    const byState = counts({ mastered: 3, lapsed: 2 });
    render(
      <MasteryBreakdownBar
        byState={byState}
        total={5}
        aria-label="3 of 5 mastered, 2 lapsed"
      />,
    );

    expect(
      screen.getByRole('img', { name: '3 of 5 mastered, 2 lapsed' }),
    ).toBeInTheDocument();
  });

  it('pairs every state with its plain-language label and count in a real definition list', () => {
    const byState = counts({ new: 4, learning: 2, review: 1, lapsed: 1, mastered: 2 });
    const { container } = render(
      <MasteryBreakdownBar byState={byState} total={10} aria-label="Full breakdown" />,
    );

    const dl = container.querySelector('dl');
    expect(dl).not.toBeNull();

    const expectations: Array<[string, string]> = [
      ['New', '4'],
      ['Learning', '2'],
      ['In review', '1'],
      ['Lapsed', '1'],
      ['Mastered', '2'],
    ];
    for (const [label, count] of expectations) {
      const dt = screen.getByText(label);
      expect(dt.tagName).toBe('DT');
      // Each label sits directly beside its own count, not just present
      // somewhere on the page — scoping the count lookup to the label's own
      // parent is what makes the pairing (not just the presence) assertable.
      const dd = within(dt.parentElement as HTMLElement).getByText(count, {
        selector: 'dd',
      });
      expect(dd.parentElement).toBe(dt.parentElement);
    }
  });

  it('never renders the raw MasteryState enum values as user-facing text', () => {
    const byState = counts({ lapsed: 1, mastered: 1 });
    render(<MasteryBreakdownBar byState={byState} total={2} aria-label="Raw values" />);

    // The legend says "Lapsed" and "Mastered" (plain language via
    // `masteryStateDisplay`), never the lowercase wire values `lapsed`/`mastered`
    // as their own text nodes.
    expect(screen.queryByText('lapsed')).not.toBeInTheDocument();
    expect(screen.queryByText('mastered')).not.toBeInTheDocument();
  });
});

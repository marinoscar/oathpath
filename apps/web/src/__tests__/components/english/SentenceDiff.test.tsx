/**
 * `SentenceDiff` — the word-level diff renderer (issue #144, epic #59 / E10).
 *
 * The page test covers the flow that produces a diff. What this file protects
 * is the ONE acceptance criterion that is a property of the mark-up itself
 * rather than of the flow: **the diff is legible to a screen reader, and it is
 * not colour-only.**
 *
 * That is testable in exactly one honest way — read the accessible text and the
 * non-colour attributes, and assert the finding is present in both. If a future
 * edit carried "missing" only in `color: error.main`, every assertion about
 * `textContent` below would fail, which is the point. A test that asserted a
 * class name or a palette token instead would keep passing through exactly that
 * regression.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssBaseline, ThemeProvider } from '@mui/material';

import { darkTheme, lightTheme } from '../../../theme';
import { SentenceDiff, summarise } from '../../../components/english/SentenceDiff';
import type { EnglishDiffOp } from '../../../types';

const MATCHED: EnglishDiffOp[] = [
  { kind: 'match', reference: 'we', hypothesis: 'we', referenceIndex: 0 },
  { kind: 'match', reference: 'pay', hypothesis: 'pay', referenceIndex: 1 },
  { kind: 'match', reference: 'taxes', hypothesis: 'taxes', referenceIndex: 2 },
];

const MIXED: EnglishDiffOp[] = [
  { kind: 'delete', reference: 'we', hypothesis: null, referenceIndex: 0 },
  { kind: 'substitute', reference: 'pay', hypothesis: 'paid', referenceIndex: 1 },
  { kind: 'match', reference: 'taxes', hypothesis: 'taxes', referenceIndex: 2 },
  { kind: 'insert', reference: null, hypothesis: 'already', referenceIndex: 3 },
];

function renderDiff(
  ops: EnglishDiffOp[],
  counts: { substitutions: number; deletions: number; insertions: number },
  theme = lightTheme,
) {
  return render(
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <SentenceDiff diff={ops} {...counts} />
    </ThemeProvider>,
  );
}

describe('summarise', () => {
  it('says every word matched when there is nothing to report', () => {
    expect(summarise(0, 0, 0)).toBe('Every word matched.');
  });

  it('counts in words, singular and plural, and joins them readably', () => {
    expect(summarise(0, 1, 0)).toBe('One word missing.');
    expect(summarise(1, 0, 0)).toBe('One word changed.');
    expect(summarise(0, 0, 2)).toBe('2 extra words.');
    expect(summarise(1, 1, 1)).toBe(
      'One word missing, one word changed and one extra word.',
    );
  });
});

describe('the diff is not colour-only', () => {
  it('names every difference in the accessible text', () => {
    const { container } = renderDiff(MIXED, {
      substitutions: 1,
      deletions: 1,
      insertions: 1,
    });

    const text = container.textContent ?? '';

    // CHANNEL 1 — the words. Each finding is a real text node, in reading
    // order, so a screen reader reads the sentence and its corrections as one
    // continuous sentence.
    expect(text).toMatch(/missing word:\s*we\./i);
    expect(text).toMatch(/you said paid instead of pay\./i);
    expect(text).toMatch(/extra word:\s*already\./i);

    // CHANNEL 2 — the prose summary, first in reading order.
    expect(
      screen.getByText('One word missing, one word changed and one extra word.'),
    ).toBeInTheDocument();
  });

  it('carries the same findings in SHAPE, so they survive a greyscale screen', () => {
    const { container } = renderDiff(MIXED, {
      substitutions: 1,
      deletions: 1,
      insertions: 1,
    });

    // A missing word is struck through and a changed word is underlined —
    // legible with no colour perception at all, and legible in a forced-colours
    // mode where the palette is discarded by the OS.
    //
    // Read from the COMPUTED style rather than an inline `style` attribute:
    // `sx` compiles to an emotion class, so an attribute assertion would pass
    // trivially by finding nothing and prove the opposite of what it claims.
    const decorations = Array.from(container.querySelectorAll('span')).map(
      (span) => window.getComputedStyle(span).textDecoration,
    );
    expect(decorations.some((value) => value.includes('line-through'))).toBe(true);
    expect(decorations.some((value) => value.includes('underline'))).toBe(true);

    // An extra word sits in brackets — the shape channel for the one op kind
    // that has no reference word to decorate.
    expect(container.textContent).toContain('[already]');
  });

  it('does not read every correction twice', () => {
    const { container } = renderDiff(MIXED, {
      substitutions: 1,
      deletions: 1,
      insertions: 1,
    });

    // The visible rendering of each correction is `aria-hidden`; the words
    // above are the single accessible copy. Without this, a screen-reader user
    // hears "missing word: we" and then "we" again with no explanation.
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);

    // The icons are decorative — never the only carrier of a finding, and never
    // announced.
    container.querySelectorAll('svg').forEach((icon) => {
      expect(icon.closest('[aria-hidden="true"]')).not.toBeNull();
    });
  });

  it('shows a key only for the marks actually on screen', () => {
    const { container } = renderDiff(MIXED, {
      substitutions: 1,
      deletions: 1,
      insertions: 1,
    });
    expect(container.textContent).toContain('what you said instead');

    // A perfect reading has no marks, so a key explaining three of them would
    // be noise AND a claim that something is there which is not.
    const perfect = renderDiff(MATCHED, {
      substitutions: 0,
      deletions: 0,
      insertions: 0,
    });
    expect(perfect.container.textContent).not.toContain('what you said instead');
    expect(perfect.container.textContent).toContain('Every word matched.');
  });

  it('explains why a learner who read "first" is looking at a digit', () => {
    renderDiff(MATCHED, { substitutions: 0, deletions: 0, insertions: 0 });

    // The diff renders the SCORER's normalised tokens, not the sentence's own
    // spelling — otherwise it would show a diff that was not the one computed.
    expect(
      screen.getByText(/numbers written as digits/i),
    ).toBeInTheDocument();
  });

  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ])('renders the same findings in the %s theme', (_name, theme) => {
    const { container } = renderDiff(
      MIXED,
      { substitutions: 1, deletions: 1, insertions: 1 },
      theme,
    );

    expect(container.textContent).toMatch(/missing word:\s*we\./i);
    expect(container.textContent).toMatch(/you said paid instead of pay\./i);
  });
});

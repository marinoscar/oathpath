/**
 * The remaining destination stub — `/progress` (issue #69, epic #50).
 *
 * `/learn` and `/practice` WERE the other two, and are not any more. #121
 * replaced Learn with the real destination once #111 gave the API a read
 * surface over the question bank; #76 (epic #52) replaced Practice with the
 * real one once #73 gave it a session API. Each is dropped from `PAGES` rather
 * than kept with a weakened assertion, because every claim below is
 * specifically about an EMPTY state — the verbatim two sentences, the "no
 * delivery promise" rule, the single `h1` with nothing else on the page — and
 * none of them is true of a screen that renders content.
 * `__tests__/pages/LearnPage.test.tsx` and `__tests__/pages/PracticePage.test.tsx`
 * are what cover those two now.
 *
 * `docs/specs/journey-shell.md` §8.1 and §8.2 still describe the superseded
 * empty states; neither is read by any test any more.
 *
 * WHAT THESE TESTS ACTUALLY PROTECT, in order of how quietly each would break:
 *
 *  1. **The copy is the spec's, verbatim.** `docs/specs/journey-shell.md` §8 is
 *     READ HERE rather than restated — the same technique
 *     `config/destinations.test.ts` uses on `App.tsx`'s route list, for the
 *     same reason: a hand-copied expectation drifts the first time the spec is
 *     edited, which is the exact moment the assertion is supposed to fire. §8's
 *     copy was reviewed against `VISION.md`'s tone and promises no delivery
 *     date; a reworded page would pass a `toBeInTheDocument()` on some other
 *     sentence and nothing would report the honesty rule as broken.
 *  2. **The page is a page, not a redirect or a blank.** §2.3 makes this
 *     structural: the rail and the bottom bar name these destinations at every
 *     width, and §4's `nextAction` contract points learners at these exact
 *     paths.
 *  3. **One `h1`, and the copy is in the reading order a screen reader gets.**
 *  4. **Nothing is width-gated.** The whole page must be present at 360px, and
 *     identical at the `sm` (600px) boundary the shell changes class at.
 */

import { describe, it, expect } from 'vitest';
import { act, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { render } from '../utils/test-utils';
import { setViewportWidth } from '../setup';
import ProgressPage from '../../pages/ProgressPage';

const SPEC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../docs/specs/journey-shell.md',
);

/**
 * The two sentences §8 declares for one destination, read out of the spec.
 *
 * Quoted strings only, whitespace-collapsed: §8 wraps its copy across lines and
 * the surrounding prose is unquoted, so `"…"` is what separates the copy from
 * the reasoning around it.
 */
function specCopy(heading: string): string[] {
  const source = readFileSync(SPEC, 'utf8');
  const section = source.split(`### ${heading}`)[1]?.split('###')[0] ?? '';
  const quotes = [...section.matchAll(/"([^"]+)"/g)].map((match) =>
    match[1].replace(/\s+/g, ' ').trim(),
  );
  // Guards the parser: a silently-empty list would make every assertion below
  // pass vacuously, which is the failure mode this whole approach exists to
  // avoid.
  expect(quotes.length, `${heading} copy not found in the spec`).toBe(2);
  return quotes;
}

const PAGES = [
  { name: 'Progress', heading: '8.3', element: <ProgressPage /> },
] as const;

const PHONE = 360;
const SM = 600;

describe.each(PAGES)('$name stub page', ({ name, heading, element }) => {
  it('renders the spec copy verbatim — both sentences, neither reworded', () => {
    render(element);

    for (const sentence of specCopy(heading)) {
      // `normalizer` off is deliberate: the assertion is that the string is the
      // spec's, character for character, not that it merely looks similar.
      expect(
        screen.getByText(sentence, { collapseWhitespace: true }),
        `${name} does not render the spec sentence: ${sentence.slice(0, 40)}…`,
      ).toBeInTheDocument();
    }
  });

  it('promises no date — no "soon", no timeline (spec §8)', () => {
    const { container } = render(element);
    const text = container.textContent ?? '';

    for (const forbidden of [/\bsoon\b/i, /coming (in|to)\b/i, /next update/i, /\b20\d\d\b/]) {
      expect(text, `${name} makes a delivery promise`).not.toMatch(forbidden);
    }
  });

  it('gives the page exactly one h1, naming the destination', () => {
    render(element);

    const headings = screen.getAllByRole('heading');
    expect(headings).toHaveLength(1);
    expect(headings[0].tagName).toBe('H1');
    expect(headings[0]).toHaveTextContent(name);
  });

  it('offers a real link back to Home, not a click handler on a div', () => {
    render(element);

    // A `RouterLink`, so it is focusable, middle-clickable and keyboard-usable.
    const back = screen.getByRole('link', { name: /back to home/i });
    expect(back).toHaveAttribute('href', '/');
  });

  it('is neither a redirect nor a blank page (spec §2.3)', () => {
    // The rail must never be a promise the router breaks: the destination
    // exists in the bar from day one, so the route renders content from day
    // one.
    const { container } = render(element);

    expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(200);
  });

  it('renders the whole page at 360px and unchanged across the sm boundary', async () => {
    // Nothing here is width-gated, and it must stay that way: a stub that hid
    // its second sentence on a phone would hide the only thing telling the
    // learner what to do instead.
    setViewportWidth(PHONE);
    const { container } = render(element);
    const atPhone = container.textContent;

    await act(async () => setViewportWidth(SM - 1));
    expect(container.textContent).toBe(atPhone);

    await act(async () => setViewportWidth(SM));
    expect(container.textContent).toBe(atPhone);
  });

  it('renders identically in the dark theme', () => {
    // The empty state colours everything from palette tokens, so the dark
    // theme is a re-render rather than a second design.
    const { container } = render(element, { wrapperOptions: { theme: 'dark' } });

    expect(container.textContent).toContain(specCopy(heading)[0]);
    expect(screen.getByRole('link', { name: /back to home/i })).toBeInTheDocument();
  });
});

describe('DestinationEmptyState — theme safety', () => {
  it('names no literal colour, so both themes come from the palette', () => {
    // jsdom performs no layout and MUI's palette is resolved at render, so a
    // hardcoded `#1f2937` (the mockups' ink) would render "correctly" in every
    // test above and be unreadable in the dark theme in a browser. The source
    // is the only place that difference is visible.
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../components/journey/DestinationEmptyState.tsx',
      ),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\brgba?\(/);
  });
});

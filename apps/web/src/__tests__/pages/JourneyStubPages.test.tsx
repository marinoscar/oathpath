/**
 * The destination stubs — all three are gone now (issue #69, epic #50).
 *
 * `/learn`, `/practice` and `/progress` each started as an empty state and
 * has since been replaced. #121 replaced Learn with the real destination once
 * #111 gave the API a read surface over the question bank; #76 (epic #52)
 * replaced Practice once #73 gave it a session API; #94 (epic #54 / E5
 * "Memory") replaced Progress once #86 gave it a mastery-aggregate endpoint.
 * None is kept here with a weakened assertion, because every claim this file
 * used to make was specifically about an EMPTY state — the verbatim two
 * sentences, the "no delivery promise" rule, the single `h1` with nothing else
 * on the page — and none of them is true of a screen that renders content.
 * `__tests__/pages/LearnPage.test.tsx` and `__tests__/pages/PracticePage.test.tsx`
 * cover those two now; Progress's own coverage is `ProgressPage.test.tsx`.
 *
 * `docs/specs/journey-shell.md` §8.1, §8.2 and §8.3 still describe the three
 * superseded empty states; none is read by any test any more.
 *
 * `DestinationEmptyState` itself is not dead code — `LearnPage.tsx`'s own
 * header still calls it "the same superseded-not-deleted relationship" every
 * one of these pages had with it, and the theme-safety test below keeps
 * covering the shared component directly now that no page under test renders
 * it any more.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

describe('DestinationEmptyState — theme safety', () => {
  it('names no literal colour, so both themes come from the palette', () => {
    // jsdom performs no layout and MUI's palette is resolved at render, so a
    // hardcoded `#1f2937` (the mockups' ink) would render "correctly" in a
    // render-based test and be unreadable in the dark theme in a browser. The
    // source is the only place that difference is visible.
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

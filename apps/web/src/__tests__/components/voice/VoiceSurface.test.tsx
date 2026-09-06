/**
 * The full-screen voice surface (issue #356, epic #345).
 *
 * `PracticeSessionPage.voiceSurface.test.tsx` covers the SWAP — entering the
 * surface when a session starts, leaving it with everything intact. This file
 * covers the surface itself, and every case here exists because of a specific
 * way the screen could quietly stop doing its job:
 *
 *  1. **ONE VIEWPORT, AND THE DOCUMENT NEVER SCROLLS.** jsdom performs no
 *     layout, so "it fits 360x640" cannot be measured — it has to be asserted
 *     STRUCTURALLY, and the structure is what actually guarantees it: a
 *     `position: fixed`, `overflow: hidden`, `100dvh` (with the `100vh`
 *     fallback) root takes no document flow at all, every region that can
 *     overflow scrolls inside itself, and the controls are outside every one
 *     of those regions. A measured assertion in jsdom would be a tautology
 *     over zeroes; these are the properties a browser derives the layout from.
 *  2. **THE FOUR STATES ARE LEGIBLE WITHOUT COLOUR AND WITHOUT MOTION.** Both
 *     halves are asserted directly: four distinct WORDS and four distinct
 *     SHAPES, and under `prefers-reduced-motion` the same word and the same
 *     shape with the animation frame loop never started.
 *  3. **`getLevel()` IS CONSUMED.** It has published a level forty times a
 *     second since #347 with zero consumers. A meter that silently stopped
 *     polling would look exactly like a quiet room.
 *  4. **EXACTLY ONE LIVE REGION**, counted as assistive technology counts them
 *     — an `aria-hidden` subtree contains none, which is the whole reason the
 *     loop's own player is hidden rather than merely tucked away.
 *  5. **STOP AND "TYPE INSTEAD" AT EVERY PHASE.** All seven, from the controls
 *     side rather than from the loop's.
 */

import { ThemeProvider } from '@mui/material';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  VOICE_SURFACE_KEY_NOTE,
  VOICE_SURFACE_TITLE,
  VoiceSurface,
  formatElapsed,
  visibleSpokenTurn,
} from '../../../components/voice/VoiceSurface';
import {
  VOICE_VISUAL_DISPLAY,
  voiceVisualState,
} from '../../../components/voice/voiceVisualState';
import type { VoiceVisualState } from '../../../components/voice/voiceVisualState';
import type { ConversationPhase } from '../../../hooks/useConversationSession';
import { lightTheme } from '../../../theme';
import { setViewportWidth } from '../../setup';

// -----------------------------------------------------------------------------
// Reading the CSS that was actually emitted.
//
// The properties this file cares about — `position`, `overflow`, `100dvh`,
// `env(safe-area-inset-*)` — are exactly the ones jsdom's `getComputedStyle`
// cannot answer: it evaluates no `@supports` block and resolves no `env()`. So
// the assertions read the RULES emotion inserted for the element's own classes,
// which is the same text a browser would apply. `@supports` nests as
// `@supports (…){.css-hash{…}}`, so the inner rule is matched by the same
// pattern as the outer one and both land in the returned text.
// -----------------------------------------------------------------------------

function rulesFor(element: Element): string {
  const stylesheets = Array.from(document.querySelectorAll('style'))
    .map((tag) => tag.textContent ?? '')
    .join('\n');

  return Array.from(element.classList)
    .filter((name) => name.startsWith('css-'))
    .flatMap((name) => {
      const found: string[] = [];
      // Selector AND body, because the selector is where a pseudo-class lives:
      // `:focus-visible` is emitted as `.css-hash:focus-visible{…}`, and a
      // pattern anchored on `{` right after the class name would miss exactly
      // the rule that proves focus is visible.
      const pattern = new RegExp(`([^{}]*\\.${name}[^{}]*)\\{([^}]*)\\}`, 'g');
      let match = pattern.exec(stylesheets);
      while (match) {
        found.push(`${match[1]}{${match[2]}}`);
        match = pattern.exec(stylesheets);
      }
      return found;
    })
    .join(';')
    .replace(/\s+/g, '');
}

/**
 * The live regions ASSISTIVE TECHNOLOGY would find.
 *
 * A live region inside an `aria-hidden` subtree is not exposed at all, so
 * counting raw selector hits would count the loop's hidden player and report
 * two where a screen reader has one. This is the count that matches what a
 * learner using a screen reader actually experiences.
 */
function liveRegions(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      '[aria-live],[role="status"],[role="alert"],[role="log"]',
    ),
  ).filter((element) => element.closest('[aria-hidden="true"]') === null);
}

/** `prefers-reduced-motion: reduce` answers true; every other query is unchanged. */
function installReducedMotion(): () => void {
  const original = window.matchMedia;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => {
      if (query.includes('prefers-reduced-motion')) {
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        };
      }
      return original(query);
    },
  });
  return () => {
    Object.defineProperty(window, 'matchMedia', { writable: true, value: original });
  };
}

const ALL_PHASES: ConversationPhase[] = [
  'idle',
  'preparing',
  'speakingQuestion',
  'listening',
  'processing',
  'speakingAnswer',
  'advancing',
];

const VISUAL_STATES: VoiceVisualState[] = ['idle', 'listening', 'thinking', 'speaking'];

let getLevel: ReturnType<typeof vi.fn>;
let onStop: ReturnType<typeof vi.fn>;
let onTypeInstead: ReturnType<typeof vi.fn>;

function renderSurface(overrides: Partial<Parameters<typeof VoiceSurface>[0]> = {}) {
  const props = {
    phase: 'listening' as ConversationPhase,
    phaseText: 'Listening. Answer when you are ready.',
    notice: null,
    questionNumber: 1,
    questionPrompt: 'What is the supreme law of the land?',
    position: 2,
    planned: 5,
    getLevel,
    heard: null,
    spokenTurn: [],
    retryBoundary: null,
    onStop,
    onTypeInstead,
    ...overrides,
  };

  return render(
    <ThemeProvider theme={lightTheme}>
      <VoiceSurface {...props} />
    </ThemeProvider>,
  );
}

function surface(): HTMLElement {
  return screen.getByRole('region', { name: VOICE_SURFACE_TITLE });
}

beforeEach(() => {
  getLevel = vi.fn(() => 0.4);
  onStop = vi.fn();
  onTypeInstead = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

// -----------------------------------------------------------------------------
// The pure parts
// -----------------------------------------------------------------------------

describe('the pure helpers', () => {
  it('narrows seven phases onto four pictures, exhaustively', () => {
    expect(ALL_PHASES.map(voiceVisualState)).toEqual([
      'idle',
      'thinking',
      'speaking',
      'listening',
      'thinking',
      'speaking',
      'thinking',
    ]);
  });

  it('withholds the retry-deferred tail of a spoken turn, and only that', () => {
    const turn = ['Not quite.', 'Try that once more.', 'The answer is the Constitution.'];

    // No retry available: the whole turn is safe to show.
    expect(visibleSpokenTurn(turn, null)).toEqual(turn);
    // A retry is armed at index 2 — everything from there on is the tail, and
    // the tail is where the accepted answer is. Showing it turns the retry
    // into a repeat-after-me, which is the defect #345 names.
    expect(visibleSpokenTurn(turn, 2)).toEqual([turn[0], turn[1]]);
    // `k === length` is legitimate: a retry armed with nothing deferred.
    expect(visibleSpokenTurn(turn, turn.length)).toEqual(turn);
    // An older server that sends neither field renders nothing rather than
    // throwing — the fields are read defensively for the same reason
    // `outcome.ts` never indexes a `Record` and hopes.
    expect(visibleSpokenTurn(undefined, undefined)).toEqual([]);
  });

  it('formats the elapsed clock with a padded seconds field', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(9_000)).toBe('0:09');
    expect(formatElapsed(74_500)).toBe('1:14');
    expect(formatElapsed(-1)).toBe('0:00');
  });
});

// -----------------------------------------------------------------------------
// 1. One viewport, no document scroll
// -----------------------------------------------------------------------------

describe('one viewport, and the document never scrolls', () => {
  it('is a fixed, clipped, dynamic-viewport-height layer with a `100vh` fallback', () => {
    renderSurface();
    const rules = rulesFor(surface());

    // Fixed and clipped: it occupies no document flow, so mounting it cannot
    // add a pixel of page height whatever it contains.
    expect(rules).toContain('position:fixed');
    expect(rules).toContain('overflow:hidden');

    // Both heights, in that order — `100vh` measures against the LARGEST
    // viewport, so it is only ever the fallback. The `@supports` guard is the
    // one `Layout.tsx` models.
    expect(rules).toContain('height:100vh');
    expect(rules).toContain('height:100dvh');
  });

  it('respects `env(safe-area-inset-*)` on all four sides', () => {
    renderSurface();
    const rules = rulesFor(surface());

    // #359 set `viewport-fit=cover`, which is what makes these non-zero on a
    // phone. Top keeps the timer out from under a notch; bottom keeps Stop out
    // from under a home indicator.
    expect(rules).toContain('env(safe-area-inset-top)');
    expect(rules).toContain('env(safe-area-inset-bottom)');
    expect(rules).toContain('env(safe-area-inset-left)');
    expect(rules).toContain('env(safe-area-inset-right)');
  });

  it('locks the document body while it is up, and restores it exactly', () => {
    document.body.style.overflow = '';
    const view = renderSurface();
    expect(document.body.style.overflow).toBe('hidden');
    view.unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('scrolls a long question INSIDE its own container, never the page', () => {
    renderSurface({
      questionPrompt:
        'Name one thing Benjamin Franklin is famous for, and then name another, and another, at a length no phone viewport has ever accommodated.',
    });

    const scrollers = Array.from(
      surface().querySelectorAll<HTMLElement>('[data-scrollable="true"]'),
    );
    expect(scrollers.length).toBeGreaterThan(0);

    for (const scroller of scrollers) {
      const rules = rulesFor(scroller);
      expect(rules).toContain('overflow-y:auto');
      // `min-height: 0` is what actually lets a flex child shrink below its
      // content and scroll. Without it the child grows instead and pushes the
      // controls off the bottom of the viewport — which is the failure, not a
      // detail of it.
      expect(rules).toContain('min-height:0');
    }
  });

  it.each([...ALL_PHASES])(
    'keeps Stop and "Type instead" outside every scrolling region, at %s',
    (phase) => {
      // 360x640 — the smallest viewport this product targets.
      act(() => setViewportWidth(360));
      renderSurface({ phase, phaseText: '' });

      for (const name of [/^stop$/i, /type instead/i]) {
        const control = screen.getByRole('button', { name });
        expect(control).toBeInTheDocument();
        // THE CLAIM, structurally: no ancestor of either control scrolls, so
        // there is no scroll position at which either is off screen. jsdom
        // cannot measure a viewport; this is the property a browser derives
        // the answer from.
        expect(control.closest('[data-scrollable="true"]')).toBeNull();
      }
    },
  );
});

// -----------------------------------------------------------------------------
// 2. Legible without colour, and without motion
// -----------------------------------------------------------------------------

describe('the four states, without colour and without motion', () => {
  it('gives each state its own word and its own shape', () => {
    const seen = VISUAL_STATES.map((state) => {
      const view = renderSurface({
        phase: ({
          idle: 'idle',
          listening: 'listening',
          thinking: 'processing',
          speaking: 'speakingQuestion',
        } as const)[state],
        phaseText: '',
      });

      const visual = view.container.querySelector<HTMLElement>('[data-voice-state]');
      const shape = view.container.querySelector<HTMLElement>('[data-shape]');
      const record = {
        state: visual?.dataset.voiceState,
        shape: shape?.dataset.shape,
        stroke: shape?.dataset.stroke,
        label: within(visual as HTMLElement).getByText(
          VOICE_VISUAL_DISPLAY[state].label,
        ).textContent,
      };
      view.unmount();
      return record;
    });

    expect(seen.map((entry) => entry.state)).toEqual(VISUAL_STATES);
    // FOUR DIFFERENT WORDS and FOUR DIFFERENT GEOMETRIES. Either one alone is
    // enough to tell the states apart, which is what "colour is never the
    // signal" means in practice — and both survive a greyscale screenshot.
    expect(new Set(seen.map((entry) => entry.label)).size).toBe(4);
    expect(new Set(seen.map((entry) => entry.shape)).size).toBe(4);
    expect(new Set(seen.map((entry) => entry.stroke)).size).toBe(4);
  });

  it('polls `getLevel()` while listening — the first consumer that hook has had', async () => {
    renderSurface({ phase: 'listening' });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    expect(getLevel).toHaveBeenCalled();
    // The level reaches the DOM as a transform written straight onto the node,
    // never as React state — forty re-renders a second to move one ring is the
    // thing `getLevel`'s own doc comment refuses.
    const meter = screen.getByTestId('voice-level-meter');
    expect(meter.style.transform).toMatch(/^scale\(1\.2/);
  });

  it('reads no level at all in a state that is not listening', async () => {
    renderSurface({ phase: 'processing' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(getLevel).not.toHaveBeenCalled();
  });

  it('honours `prefers-reduced-motion`: same word, same shape, nothing moving', async () => {
    const restore = installReducedMotion();
    try {
      const view = renderSurface({ phase: 'listening' });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });

      // NOT MERELY A SLOWER ANIMATION — the frame loop is never started, so
      // nothing is polled and nothing is written.
      expect(getLevel).not.toHaveBeenCalled();
      expect(screen.getByTestId('voice-level-meter').style.transform).toBe('scale(1)');

      const visual = view.container.querySelector<HTMLElement>('[data-voice-state]');
      expect(visual?.dataset.motion).toBe('static');
      // The state is still completely legible: the word and the shape are the
      // signal, and neither was ever carried by the movement.
      expect(within(visual as HTMLElement).getByText('Listening')).toBeInTheDocument();
      expect(
        view.container.querySelector('[data-shape]')?.getAttribute('data-shape'),
      ).toBe('rings');
      // And there is no spinner to degrade into a meaningless static circle.
      expect(view.container.querySelector('.MuiCircularProgress-root')).toBeNull();
    } finally {
      restore();
    }
  });
});

// -----------------------------------------------------------------------------
// 3. Exactly one live region
// -----------------------------------------------------------------------------

describe('exactly one live region', () => {
  it('has one, and the hidden player inside it adds none', () => {
    renderSurface({
      phaseText: 'Listening. Answer when you are ready.',
      // Stands in for the loop's own `QuestionAudio`, which carries a
      // `role="status"` of its own saying almost exactly what the phase line
      // already says.
      children: (
        <div role="status" aria-live="polite">
          Reading the question aloud.
        </div>
      ),
    });

    const regions = liveRegions(surface());
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveTextContent('Listening. Answer when you are ready.');
  });

  it('announces the phase, what was heard and the verdict as ONE utterance', () => {
    renderSurface({
      phase: 'speakingAnswer',
      phaseText: 'Telling you the answer.',
      heard: 'the Constitution',
      spokenTurn: ['That’s right.', 'The answer is the Constitution.'],
      retryBoundary: null,
    });

    const [region] = liveRegions(surface());
    expect(region).toHaveTextContent('Telling you the answer.');
    expect(region).toHaveTextContent('We heard “the Constitution”');
    expect(region).toHaveTextContent('That’s right.');
    expect(region).toHaveTextContent('The answer is the Constitution.');
  });

  it('keeps the question OUT of the live region', () => {
    renderSurface({ questionPrompt: 'What is the supreme law of the land?' });

    const heading = screen.getByRole('heading', {
      level: 2,
      name: 'What is the supreme law of the land?',
    });
    // `role="status"` is atomic: a question inside it would be re-read in full
    // on every phase change, five times a question. It is a heading instead,
    // reachable on demand, and the loop reads it aloud anyway.
    expect(heading.closest('[role="status"]')).toBeNull();
  });

  it('withholds the retry-deferred tail from the screen as well as the audio', () => {
    renderSurface({
      phase: 'speakingAnswer',
      phaseText: 'Telling you the answer.',
      heard: 'the declaration',
      spokenTurn: ['Not quite.', 'The answer is the Constitution.'],
      retryBoundary: 1,
    });

    expect(screen.getByText('Not quite.')).toBeInTheDocument();
    expect(screen.queryByText('The answer is the Constitution.')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// 4. The timer, the key note, the headings, the keyboard
// -----------------------------------------------------------------------------

describe('the guardrails and the keyboard', () => {
  it('shows an elapsed timer that runs, and says whose key this is spending', () => {
    vi.useFakeTimers();
    try {
      renderSurface();
      expect(screen.getByText('Elapsed 0:00')).toBeInTheDocument();
      expect(screen.getByText(VOICE_SURFACE_KEY_NOTE)).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(65_000);
      });
      expect(screen.getByText('Elapsed 1:05')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('measures from the SESSION start it is given, not from its own mount', () => {
    // ISSUE #387. This component is mounted and unmounted by its host for
    // reasons that have nothing to do with a session ending — a re-read of the
    // session after every question used to do exactly that — and the clock is
    // a COST figure on the learner's own key, so one that restarts
    // systematically under-reports what a session is spending.
    renderSurface({ startedAt: Date.now() - 65_000 });
    expect(screen.getByText('Elapsed 1:05')).toBeInTheDocument();
  });

  it('falls back to mount for a host that has no session start to hand over', () => {
    renderSurface({ startedAt: null });
    expect(screen.getByText('Elapsed 0:00')).toBeInTheDocument();
  });

  it('never runs backwards, whatever start the host re-reports', () => {
    // A clock that jumped DOWN is the failure being fixed, so it is worth
    // being unable to express rather than merely careful about: a re-mint
    // publishing a fresh timestamp, or a handover between transports, can only
    // ever leave the clock alone.
    const view = renderSurface({ startedAt: Date.now() - 65_000 });
    expect(screen.getByText('Elapsed 1:05')).toBeInTheDocument();

    view.rerender(
      <ThemeProvider theme={lightTheme}>
        <VoiceSurface
          phase="listening"
          phaseText="Listening. Answer when you are ready."
          notice={null}
          questionNumber={1}
          questionPrompt="What is the supreme law of the land?"
          position={2}
          planned={5}
          getLevel={getLevel}
          heard={null}
          startedAt={Date.now()}
          spokenTurn={[]}
          retryBoundary={null}
          onStop={onStop}
          onTypeInstead={onTypeInstead}
        />
      </ThemeProvider>,
    );

    expect(screen.getByText('Elapsed 1:05')).toBeInTheDocument();
    expect(screen.queryByText('Elapsed 0:00')).toBeNull();
  });

  it('does not put the clock in the live region', () => {
    renderSurface();
    // A per-second announcement of a running clock is the single most hostile
    // thing a screen reader could be asked to do.
    expect(screen.getByText('Elapsed 0:00').closest('[role="status"]')).toBeNull();
  });

  it('has one `h1`, with the question as the `h2` under it', () => {
    renderSurface();

    const headings = screen.getAllByRole('heading');
    expect(headings.filter((heading) => heading.tagName === 'H1')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      VOICE_SURFACE_TITLE,
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'What is the supreme law of the land?',
    );
  });

  it('is reachable from the keyboard, with focus that is actually visible', async () => {
    const user = userEvent.setup();
    renderSurface();

    // The surface takes focus on entry, so the learner is inside it rather
    // than on a detached node the browser reset to `<body>`.
    expect(surface()).toHaveFocus();

    await user.tab();
    const stop = screen.getByRole('button', { name: /^stop$/i });
    expect(stop).toHaveFocus();
    expect(rulesFor(stop)).toContain(':focus-visible');
    expect(rulesFor(stop)).toContain('outline:3pxsolid');

    await user.tab();
    expect(screen.getByRole('button', { name: /type instead/i })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(onTypeInstead).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });
});

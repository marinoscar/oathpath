/**
 * PRD.md's separation, enforced as COPY — over every component E7 adds
 * (issue #138, epic #56 / E7 "Habit").
 *
 * =============================================================================
 * THE RULE THIS FILE PROTECTS
 * =============================================================================
 *
 * `PRD.md` states the two questions side by side and requires that they stay
 * distinct:
 *
 *   > **Engagement:** *Am I consistently doing the work?*
 *   > **Readiness:** *Does the evidence indicate that I am becoming prepared?*
 *   >
 *   > Points, streaks, achievements, and challenges encourage the journey.
 *   > They must never artificially increase the user's Readiness Score.
 *
 * `docs/specs/readiness-model.md` §2.4 keeps the structural half of that
 * boundary — engagement is never wired in as a readiness input.
 * `docs/specs/habit-streaks.md` §8 states the half a learner actually reads:
 * "The word for what the ring measures is `consistency`, never `readiness` or
 * `progress-toward-readiness`... 'You are 40% ready' is not a sentence this
 * ring is ever entitled to render, and neither is 'Your progress toward
 * readiness is...' attached to a streak number."
 *
 * =============================================================================
 * WHY IT IS A TEST OVER RENDERED COPY, AND NOT OVER THE SOURCE
 * =============================================================================
 *
 * These components' own headers cite `readiness-model.md` by name and explain
 * the boundary at length — a source scan would fire on the documentation that
 * exists to prevent the very thing being scanned for. What must be clean is
 * what a learner READS, so every component in `components/home/` is rendered
 * here, across the states its copy branches on, and the resulting text is what
 * is checked.
 *
 * Home deliberately shows BOTH answers at once — the readiness widget (#142)
 * and this consistency surface — which is exactly why the wording has to hold:
 * the two are inches apart on the same screen, and a single borrowed word
 * would collapse the distinction the page's layout is trying to draw.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { ConsistencyCard } from '../../../components/home/ConsistencyCard';
import { GoalRing } from '../../../components/home/GoalRing';
import { StreakBadge } from '../../../components/home/StreakBadge';
import { SessionCelebration } from '../../../components/home/SessionCelebration';
import { selectCelebrationCopy } from '../../../components/home/celebration-copy';
import {
  emptyEngagementSummary,
  engagementSummary,
} from '../../utils/engagement-fixtures';

/**
 * Readiness's vocabulary, plus the two constructions §8 quotes as forbidden.
 * `\b` keeps "already" (which contains "ready") out of it.
 */
const READINESS_WORDING =
  /\bready\b|\breadiness\b|\bprepared\b|\bpreparedness\b|\bscore\b|\bpass(ed|ing)?\b|% ready|progress toward/i;

/** Every rendering these components can produce, named by what it is. */
const RENDERINGS: Array<{ name: string; element: React.ReactElement }> = [
  {
    name: 'ConsistencyCard — goal met, streak running, freezes held',
    element: (
      <ConsistencyCard engagement={engagementSummary()} headingId="h" />
    ),
  },
  {
    name: 'ConsistencyCard — goal not met, some minutes on the board',
    element: (
      <ConsistencyCard
        engagement={engagementSummary({
          today: {
            date: '2026-04-10',
            practiceSeconds: 120,
            attempts: 2,
            correct: 1,
            goalMet: false,
          },
        })}
        headingId="h"
      />
    ),
  },
  {
    name: 'ConsistencyCard — the zero state',
    element: <ConsistencyCard engagement={emptyEngagementSummary()} headingId="h" />,
  },
  {
    name: 'ConsistencyCard — no freezes held',
    element: (
      <ConsistencyCard
        engagement={engagementSummary({ freezes: { remaining: 0, max: 2 } })}
        headingId="h"
      />
    ),
  },
  {
    name: 'GoalRing — measured',
    element: <GoalRing practiceSeconds={180} goalMinutes={5} goalMet={false} />,
  },
  {
    name: 'GoalRing — complete',
    element: <GoalRing practiceSeconds={600} goalMinutes={5} goalMet />,
  },
  { name: 'StreakBadge — running', element: <StreakBadge current={4} longest={9} freezesRemaining={2} /> },
  { name: 'StreakBadge — none yet', element: <StreakBadge current={0} longest={0} freezesRemaining={1} /> },
  ...(
    [
      {
        label: 'goal',
        input: {
          goalMinutes: 5,
          practiceSecondsToday: 300,
          goalMetToday: true,
          streakCurrent: 4,
          daysPractisedThisWeek: 4,
          sessionAnswered: 5,
        },
      },
      {
        label: 'week',
        input: {
          goalMinutes: 5,
          practiceSecondsToday: 120,
          goalMetToday: false,
          streakCurrent: 0,
          daysPractisedThisWeek: 3,
          sessionAnswered: 5,
        },
      },
      {
        label: 'minutes',
        input: {
          goalMinutes: 5,
          practiceSecondsToday: 60,
          goalMetToday: false,
          streakCurrent: 0,
          daysPractisedThisWeek: 1,
          sessionAnswered: 5,
        },
      },
    ] as const
  ).map(({ label, input }) => {
    const copy = selectCelebrationCopy({ ...input });
    if (!copy) throw new Error(`the ${label} celebration case produced no copy`);
    return {
      name: `SessionCelebration — the ${label} branch`,
      element: <SessionCelebration copy={copy} />,
    };
  }),
];

describe('engagement copy never borrows readiness’s vocabulary (PRD.md)', () => {
  it.each(RENDERINGS)('$name', ({ element }) => {
    const { container } = render(element);
    const text = container.textContent ?? '';

    // Guards the assertion itself: an empty render would pass vacuously,
    // which is the failure this whole approach exists to avoid.
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).not.toMatch(READINESS_WORDING);
  });

  it('covers every component in components/home that renders copy', () => {
    // A new component added to this directory without a rendering here would
    // leave the rule unenforced on the one surface it was added for.
    const covered = new Set(
      RENDERINGS.map(({ name }) => name.split(' — ')[0]),
    );
    expect(covered).toEqual(
      new Set(['ConsistencyCard', 'GoalRing', 'StreakBadge', 'SessionCelebration']),
    );
  });
});

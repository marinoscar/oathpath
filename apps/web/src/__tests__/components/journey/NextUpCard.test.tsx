/**
 * `NextUpCard` — the one recommendation Home renders (issue #74, epic #50).
 *
 * Mirrors the component's own header: `title`/`reason`/`path` are rendered
 * VERBATIM, with no local copy keyed on `kind`, and `kind` is used for
 * exactly one presentational thing — the icon. This file asserts both halves
 * directly, one case per declared kind — including the newest, `interview`
 * (E8, epic #57 / #140), which the source added to `KIND_ICONS` alongside
 * `review` (E5) and the four E1–E3 kinds.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { NextUpCard } from '../../../components/journey/NextUpCard';
import type { NextAction, NextActionKind } from '../../../types';

const HEADING_ID = 'next-up-heading';

function renderCard(nextAction: NextAction) {
  return render(
    <MemoryRouter>
      <NextUpCard nextAction={nextAction} headingId={HEADING_ID} />
    </MemoryRouter>,
  );
}

// One fixture per declared kind, and the icon `KIND_ICONS` maps it to —
// verified against the map in `NextUpCard.tsx` rather than assumed.
const CASES: Record<
  NextActionKind,
  { action: NextAction; iconTestId: string; buttonName: string }
> = {
  orientation: {
    action: {
      kind: 'orientation',
      title: 'Finish setting up your plan.',
      reason: "A couple of quick questions, then you're ready to start.",
      path: '/setup/journey',
    },
    iconTestId: 'PlaylistAddCheckOutlinedIcon',
    // `/setup/journey` is owned by no destination, so the label falls
    // through to the honest generic fallback.
    buttonName: 'Continue',
  },
  interview_countdown: {
    action: {
      kind: 'interview_countdown',
      title: '12 days until your interview',
      reason: 'Start with the material, then build up to full practice.',
      path: '/learn',
    },
    iconTestId: 'EventAvailableOutlinedIcon',
    buttonName: 'Go to Learn',
  },
  explore: {
    action: {
      kind: 'explore',
      title: "See what's here so far.",
      reason: "Take a look at what's ready.",
      path: '/learn',
    },
    iconTestId: 'ExploreOutlinedIcon',
    buttonName: 'Go to Learn',
  },
  practice: {
    action: {
      kind: 'practice',
      title: 'Practise five questions.',
      reason: 'Answering in your own words is what makes an answer stick.',
      path: '/practice',
    },
    iconTestId: 'RecordVoiceOverOutlinedIcon',
    buttonName: 'Go to Practice',
  },
  // The newest kind (E5, #82): due/lapsed evidence to go back over, per
  // `study-coach.ts`'s `recommendStudyAction`.
  review: {
    action: {
      kind: 'review',
      title: '4 questions are due for review.',
      reason: 'Going back over these now is what makes them stick.',
      path: '/practice',
    },
    iconTestId: 'AutorenewOutlinedIcon',
    buttonName: 'Go to Practice',
  },
  // The newest kind (E8, #140): a full mock interview. The ONE kind whose
  // path is not `/practice` itself — `/practice/interviews` is its own screen,
  // and a card inviting a learner to rehearse an interview that landed them on
  // the five-question drill would be exactly the mismatch `NEXT_ACTION_PATHS`
  // exists to prevent. The button still reads "Go to Practice" because
  // `owns('/practice', …)` covers the subtree: it is content within that
  // destination, not a destination of its own.
  interview: {
    action: {
      kind: 'interview',
      title: 'Try a full mock interview.',
      reason: 'You have practised enough to rehearse the real thing.',
      path: '/practice/interviews',
    },
    iconTestId: 'HistoryEduOutlinedIcon',
    buttonName: 'Go to Practice',
  },
};

describe('NextUpCard — one case per kind', () => {
  for (const [kind, { action, iconTestId, buttonName }] of Object.entries(CASES) as [
    NextActionKind,
    (typeof CASES)[NextActionKind],
  ][]) {
    it(`renders the server's ${kind} title, reason and path verbatim, with the right icon`, () => {
      renderCard(action);

      // title/reason: rendered exactly as the server wrote them, not a local
      // rewording keyed on kind.
      expect(screen.getByText(action.title)).toBeInTheDocument();
      expect(screen.getByText(action.reason)).toBeInTheDocument();

      // The one thing that IS keyed on kind: a purely decorative glyph.
      const icon = screen.getByTestId(iconTestId);
      expect(icon).toHaveAttribute('aria-hidden');

      // The link goes to the server's own path, unexamined.
      const link = screen.getByRole('link', { name: buttonName });
      expect(link).toHaveAttribute('href', action.path);
    });
  }
});

describe('NextUpCard — no local copy keyed on kind', () => {
  it('renders whatever the server says even when it does not match any real recommendation', () => {
    // A title/reason the recommender would never actually produce for
    // `explore` — proves the card has no `switch (kind)` of its own that
    // would otherwise render its OWN plausible-sounding copy instead.
    renderCard({
      kind: 'explore',
      title: 'A title the recommender has never produced.',
      reason: 'A reason invented purely by this test.',
      path: '/learn',
    });

    expect(
      screen.getByText('A title the recommender has never produced.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('A reason invented purely by this test.'),
    ).toBeInTheDocument();
  });

  it('falls back to a neutral icon for a kind the bundle does not know about yet, without throwing', () => {
    // `iconFor`'s documented fallback: an older bundle receiving a `kind` a
    // newer server has started sending. Must render the card's actual copy,
    // never crash the page.
    //
    // This case used `interview` as its stand-in until E8 (#140) shipped that
    // kind for real, at which point the stand-in stopped standing in for
    // anything — the point of this test is a kind `KIND_ICONS` genuinely does
    // NOT hold, so it needs one that is still unclaimed. E9/E11's voice work is
    // the next plausible widening, and if it ever lands this line moves on to
    // whatever is unclaimed then.
    renderCard({
      kind: 'voice_interview' as NextActionKind,
      title: 'Your interview is coming up.',
      reason: 'A kind this bundle has never heard of.',
      path: '/practice',
    });

    expect(screen.getByText('Your interview is coming up.')).toBeInTheDocument();
    expect(screen.getByTestId('ExploreOutlinedIcon')).toBeInTheDocument();
  });
});

describe('NextUpCard — accessible structure', () => {
  it('labels the card section from the same id the heading carries', () => {
    renderCard(CASES.review.action);

    const heading = screen.getByRole('heading', { level: 2, name: 'Next up' });
    expect(heading).toHaveAttribute('id', HEADING_ID);

    const section = heading.closest('section') ?? heading.closest('[role="region"]');
    expect(section).toHaveAttribute('aria-labelledby', HEADING_ID);
  });

  it('renders no second heading for the title line, keeping one heading per card', () => {
    renderCard(CASES.practice.action);

    // "Next up" is the section's only heading; the title beneath it is a
    // prominent paragraph, not a competing h-level.
    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });
});

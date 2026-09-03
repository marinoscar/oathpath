/**
 * `ReadinessWidget` — the compact readiness card on Home (issue #142, epic
 * #55 / E6).
 *
 * Mirrors `NextUpCard.test.tsx`'s shape: a `MemoryRouter`-wrapped render,
 * with the component under test isolated from `HomePage` itself (that
 * integration is `HomePage.test.tsx`'s own "the readiness widget" suite).
 */

import type { ComponentProps } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ReadinessWidget } from '../../../components/readiness/ReadinessWidget';
import { cappedReadinessSnapshot, readinessSnapshot } from '../../utils/readiness-fixtures';

const HEADING_ID = 'readiness-widget-heading';

function renderWidget(props: Partial<ComponentProps<typeof ReadinessWidget>> = {}) {
  return render(
    <MemoryRouter>
      <ReadinessWidget
        readiness={readinessSnapshot()}
        previousScore={null}
        headingId={HEADING_ID}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('ReadinessWidget', () => {
  it("renders the server's score and a link to /progress", () => {
    renderWidget({ readiness: readinessSnapshot({ score: 59 }) });

    expect(screen.getByText('59')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /see your progress/i })).toHaveAttribute(
      'href',
      '/progress',
    );
  });

  it('renders no trend at all when previousScore is null — never a fabricated one-point trend', () => {
    renderWidget({ previousScore: null });

    expect(screen.queryByText(/since your last check/i)).not.toBeInTheDocument();
  });

  it('renders an honest "up" trend from two real scores', () => {
    renderWidget({ readiness: readinessSnapshot({ score: 65 }), previousScore: 59 });

    expect(screen.getByText('Up 6 points since your last check.')).toBeInTheDocument();
  });

  it('renders an honest "down" trend from two real scores', () => {
    renderWidget({ readiness: readinessSnapshot({ score: 50 }), previousScore: 59 });

    expect(screen.getByText('Down 9 points since your last check.')).toBeInTheDocument();
  });

  it('renders a short cap hint when capped, and links to Progress rather than restating the full sentence', () => {
    renderWidget({ readiness: cappedReadinessSnapshot() });

    expect(screen.getByText(/limited interview practice/i)).toBeInTheDocument();
    // The compact hint is deliberately NOT the full §3 sentence — that lives
    // on `/progress` only.
    expect(
      screen.queryByText(
        'Your civics knowledge is strong, but you have limited interview practice. Completing two mock interviews is the best way to strengthen your readiness now.',
      ),
    ).not.toBeInTheDocument();
  });

  it('renders no cap hint when capReason is null', () => {
    renderWidget({ readiness: readinessSnapshot({ capReason: null }) });

    expect(screen.queryByText(/limited interview practice/i)).not.toBeInTheDocument();
  });

  it('names its region after the heading id it was given', () => {
    renderWidget();

    const heading = screen.getByRole('heading', { level: 2, name: 'Readiness' });
    expect(heading).toHaveAttribute('id', HEADING_ID);
    expect(screen.getByRole('region', { name: 'Readiness' })).toBeInTheDocument();
  });
});

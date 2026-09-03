/**
 * `OfficerCard` — one thing the officer said (issue #140, epic #57 / E8).
 *
 * Two properties worth protecting:
 *
 *  1. **The text is rendered verbatim, with its own line breaks.** A civics
 *     officer turn is the acknowledgement, a blank line, and then the
 *     question's `prompt` read VERBATIM from the database — the question text
 *     never passes through the model (`mock-interview.md` §5.1), and
 *     `pre-wrap` is what keeps the server's own break where it put it.
 *  2. **Nothing on this card reflects how the learner is doing**, because
 *     nothing tells it. It is handed text and a phase, and that is all.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { OfficerCard } from '../../../components/interview/OfficerCard';

const CIVICS_TURN =
  'Thank you. Let us continue.\n\nWhat is the supreme law of the land?';

describe('OfficerCard', () => {
  it('renders the officer’s words and the phase they belong to', () => {
    render(<OfficerCard text={CIVICS_TURN} phase="civics" isCurrent />);

    expect(screen.getByText(/What is the supreme law of the land\?/)).toBeInTheDocument();
    expect(screen.getByText('Civics questions')).toBeInTheDocument();
  });

  it('keeps the server’s own line break between acknowledgement and question', () => {
    const { container } = render(<OfficerCard text={CIVICS_TURN} phase="civics" />);

    const paragraph = Array.from(container.querySelectorAll('p')).find((node) =>
      node.textContent?.includes('supreme law'),
    );
    expect(paragraph).toBeDefined();
    expect(paragraph?.textContent).toBe(CIVICS_TURN);
    expect(window.getComputedStyle(paragraph as Element).whiteSpace).toBe('pre-wrap');
  });

  it('says the officer is responding only while the first tokens are in flight', () => {
    const { rerender } = render(<OfficerCard text="" phase="civics" isCurrent isStreaming />);
    expect(screen.getByText(/The officer is responding/)).toBeInTheDocument();

    // Once any text has arrived it is its own evidence that something is
    // happening, and a second "working" line under it would be noise.
    rerender(<OfficerCard text="Thank you." phase="civics" isCurrent isStreaming />);
    expect(screen.queryByText(/The officer is responding/)).not.toBeInTheDocument();
  });

  it('renders no verdict vocabulary of its own', () => {
    const { container } = render(<OfficerCard text={CIVICS_TURN} phase="civics" isCurrent />);

    // The practice screens' words, which have no business on this one.
    for (const word of ['Correct', 'Not a match', 'Partly right', 'Skipped']) {
      expect(container.innerHTML).not.toContain(word);
    }
  });
});

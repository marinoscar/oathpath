/**
 * `PhaseProgress` — where the learner is, and never how they are doing
 * (issue #140, epic #57 / E8).
 *
 * The one thing worth protecting here is an ABSENCE: this line may say
 * "Question 4 of 10" and may never say how many were right
 * (`docs/specs/mock-interview.md` §10). The shape it is handed makes that
 * structurally true — `InterviewProgress` has no `civicsCorrect` field — so
 * these tests check the two facts it does render and the boundary cases where a
 * naive `+ 1` would print a question nobody is going to be asked.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PhaseProgress } from '../../../components/interview/PhaseProgress';

describe('PhaseProgress', () => {
  it('names the phase and the part of six it is', () => {
    render(<PhaseProgress phase="civics" progress={{ civicsAsked: 0, civicsPlanned: 10 }} />);

    expect(screen.getByText(/Part 3 of 6/)).toBeInTheDocument();
    expect(screen.getByText(/Civics questions/)).toBeInTheDocument();
  });

  it('counts the question awaiting an answer, not the ones already answered', () => {
    // `civicsAsked` counts ANSWERED questions, so three answered means the
    // fourth is on the table.
    render(<PhaseProgress phase="civics" progress={{ civicsAsked: 3, civicsPlanned: 10 }} />);

    expect(screen.getByText('Question 4 of 10')).toBeInTheDocument();
  });

  it('never counts past the plan', () => {
    render(<PhaseProgress phase="civics" progress={{ civicsAsked: 10, civicsPlanned: 10 }} />);

    expect(screen.getByText('Question 10 of 10')).toBeInTheDocument();
    expect(screen.queryByText('Question 11 of 10')).not.toBeInTheDocument();
  });

  it('drops the question count outside the civics phase', () => {
    // "Question 7 of 10" beside a closing statement would be describing a
    // question nobody is going to be asked.
    render(<PhaseProgress phase="closing" progress={{ civicsAsked: 6, civicsPlanned: 10 }} />);

    expect(screen.getByText(/Closing/)).toBeInTheDocument();
    expect(screen.queryByText(/^Question /)).not.toBeInTheDocument();
  });

  it('drops the question count once the interview only awaits completion', () => {
    render(
      <PhaseProgress
        phase="civics"
        progress={{ civicsAsked: 6, civicsPlanned: 10 }}
        awaitingCompletion
      />,
    );

    expect(screen.queryByText(/^Question /)).not.toBeInTheDocument();
  });

  it('renders the reading and writing phases honestly rather than hiding them', () => {
    // §2.4: a learner who is never told those segments exist may walk into the
    // real interview believing they rehearsed something they never saw.
    render(<PhaseProgress phase="reading" progress={{ civicsAsked: 6, civicsPlanned: 10 }} />);

    expect(screen.getByText(/Part 4 of 6 · Reading test/)).toBeInTheDocument();
  });

  it('names a phase this bundle has never heard of without breaking', () => {
    // A server that deploys independently WILL send one eventually.
    render(<PhaseProgress phase="deliberation" progress={null} />);

    expect(screen.getByText('This part of the interview')).toBeInTheDocument();
  });

  it('renders nothing at all before the first turn has been read', () => {
    const { container } = render(<PhaseProgress phase={null} progress={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

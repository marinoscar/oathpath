/**
 * `RetentionChoice` — the transcript decision, off by default
 * (issue #140, epic #57 / E8).
 *
 * The load-bearing test here is the FIRST one, and it protects a default rather
 * than a behaviour: `docs/specs/mock-interview.md` §15 rejects
 * retention-on-by-default with "the conservative-handling posture applies to
 * the DEFAULT, not only to the OPTION", and a learner who never touches this
 * control must not end up in the permissive state. That is a one-character
 * regression away at all times, and nothing else on the screen would look
 * different if it happened.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RetentionChoice } from '../../../components/interview/RetentionChoice';

describe('RetentionChoice', () => {
  it('is off unless the caller says otherwise, and reports being turned on', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(<RetentionChoice checked={false} onChange={onChange} />);

    const control = screen.getByRole('switch', {
      name: /keep a transcript of this interview/i,
    });
    expect(control).not.toBeChecked();

    await user.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('states exactly what turning it on keeps', () => {
    // §8.2's table: the applicant's own turn text, the response text on every
    // graded answer, and the grader's written feedback (which quotes the
    // learner's phrasing often enough that storing it would be a second,
    // indirect way to retain their words).
    render(<RetentionChoice checked={false} onChange={vi.fn()} />);

    expect(
      screen.getByText(/we keep everything you type during this interview/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/your answers in your own words/i)).toBeInTheDocument();
    expect(screen.getByText(/written feedback on them/i)).toBeInTheDocument();
  });

  it('states what is kept either way, so “off” cannot read as “this won’t count”', () => {
    // §8.3, the honest other half: what retention off costs is the ability to
    // re-read one's own phrasing, not the record of what happened.
    render(<RetentionChoice checked={false} onChange={vi.fn()} />);

    expect(
      screen.getByText(/we keep every question you were asked/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/won’t be able to re-read it later/i)).toBeInTheDocument();
  });

  it('has a real label bound to the switch', () => {
    render(<RetentionChoice checked onChange={vi.fn()} />);

    // Found BY ITS ACCESSIBLE NAME, which is only possible through a real
    // `<label>` — a nearby `<span>` would not do it.
    expect(
      screen.getByRole('switch', { name: /keep a transcript of this interview/i }),
    ).toBeChecked();
  });
});

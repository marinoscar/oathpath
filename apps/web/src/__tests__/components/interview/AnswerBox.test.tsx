/**
 * `AnswerBox` — the one control an applicant has (issue #140, epic #57 / E8).
 *
 * Two absences and one presence:
 *
 *  * **No reveal and no skip.** `PracticeSessionPage` has both; a rehearsal has
 *    neither, because a real officer does not show an applicant the accepted
 *    answer and there is no `skipped` field on a turn body at all
 *    (`interview-turn.dto.ts`). "Coaching decreases as realism increases" is
 *    the rule (`VISION.md`, Product Principle 7).
 *  * **An empty answer is a real answer**, so the submit button does not go
 *    dead on an empty field: rejecting it would make "I don't know" the one
 *    thing this rehearsal refuses to let a nervous person say.
 *  * **A real `<label>`**, found by accessible name.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AnswerBox } from '../../../components/interview/AnswerBox';

describe('AnswerBox', () => {
  it('has a real label and sends what was typed', async () => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(
      <AnswerBox value="the Constitution" onChange={onChange} onSubmit={onSubmit} />,
    );

    expect(screen.getByLabelText(/your answer/i)).toHaveValue('the Constitution');

    await user.click(screen.getByRole('button', { name: /^answer$/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('accepts an empty answer rather than disabling the button', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    render(<AnswerBox value="" onChange={vi.fn()} onSubmit={onSubmit} />);

    const button = screen.getByRole('button', { name: /^answer$/i });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    expect(
      screen.getByText(/you can answer without typing anything/i),
    ).toBeInTheDocument();
  });

  it('offers no reveal and no skip', () => {
    render(<AnswerBox value="" onChange={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /show me the answer/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /skip/i })).toBeNull();
  });

  it('waits its turn while the officer is still speaking', async () => {
    const onSubmit = vi.fn();
    render(<AnswerBox value="something" onChange={vi.fn()} onSubmit={onSubmit} disabled />);

    expect(screen.getByLabelText(/your answer/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /answer|sending/i })).toBeDisabled();
  });

  it('sends on Enter and breaks the line on Shift+Enter', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    render(<AnswerBox value="Congress" onChange={vi.fn()} onSubmit={onSubmit} />);

    const field = screen.getByLabelText(/your answer/i);
    field.focus();

    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSubmit).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

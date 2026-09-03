/**
 * `EndInterviewControl` — one tap, reachable in every phase
 * (issue #140, epic #57 / E8).
 *
 * The property worth protecting is that it is NEVER DISABLED, including while a
 * turn is streaming and while the completion request is in flight. The moment
 * somebody most wants out of a rehearsal of a stressful conversation is the
 * moment it is going badly, and a control that greys out exactly then is a
 * control that is not really there.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EndInterviewControl } from '../../../components/interview/EndInterviewControl';

describe('EndInterviewControl', () => {
  it('ends the interview on one press, with no confirmation step', async () => {
    const onEnd = vi.fn();
    const user = userEvent.setup();

    render(<EndInterviewControl onEnd={onEnd} />);

    await user.click(screen.getByRole('button', { name: /end this interview/i }));
    expect(onEnd).toHaveBeenCalledTimes(1);
    // No dialog, no "are you sure?": leaving is not destructive here — it
    // completes the interview and produces a real debrief.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stays pressable while a completion is already in flight', () => {
    render(<EndInterviewControl onEnd={vi.fn()} pending />);

    const button = screen.getByRole('button', { name: /finishing/i });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('says “finish” when finishing is the only thing left to do', () => {
    render(<EndInterviewControl onEnd={vi.fn()} variant="finish" />);

    expect(
      screen.getByRole('button', { name: /finish and see how it went/i }),
    ).toBeInTheDocument();
  });
});

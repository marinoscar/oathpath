/**
 * "End this interview" — reachable in every phase, including mid-stream.
 *
 * Issue #140, epic #57 / E8.
 *
 * =============================================================================
 * ONE TAP, AND IT DOES NOT DISCARD THE INTERVIEW
 * =============================================================================
 *
 * There is no confirmation dialog, and there is no "are you sure?" — because
 * leaving is not destructive here. Pressing this aborts whatever the officer is
 * saying and calls `POST /api/interviews/:id/complete`, so the interview ENDS
 * with a real debrief rather than being abandoned mid-sentence. A learner who
 * needs to stop gets the same record as one who reached the closing statement;
 * they simply reached it sooner.
 *
 * That is also why the button is never disabled while a turn is streaming. The
 * moment somebody most wants out of a rehearsal of a stressful conversation is
 * the moment it is going badly, and a control that greys out exactly then is a
 * control that is not really there. `useMockInterview.complete()` fires the
 * abort before it sends the request, so the words being generated on the
 * learner's own key stop as well.
 *
 * =============================================================================
 * QUIET, AND NOT AN ALARM
 * =============================================================================
 *
 * A `text` button in the inherited colour, not `error`, not `contained`, and
 * not shouting. Ending early is an ordinary thing a person is allowed to do,
 * and colouring it as damage would be this screen making a judgement about it.
 */

import { Button } from '@mui/material';

export interface EndInterviewControlProps {
  onEnd: () => void;
  /** True while the completion request is in flight. */
  pending?: boolean;
  /**
   * The label. `'end'` while the interview is running, `'finish'` once the
   * officer has finished and the only remaining action is completing it — the
   * same call either way, said the way the moment deserves.
   */
  variant?: 'end' | 'finish';
}

export function EndInterviewControl({
  onEnd,
  pending = false,
  variant = 'end',
}: EndInterviewControlProps) {
  const finishing = variant === 'finish';

  return (
    <Button
      // Never `disabled` on `pending` alone: see the file header. The one thing
      // it guards against is a double-send, which `completeInterview` is
      // idempotent about anyway.
      variant={finishing ? 'contained' : 'text'}
      // The finish action is the one thing left to do, so it carries the
      // primary colour. Ending EARLY does not: it is an ordinary choice, and
      // dressing it as the recommended one would be this screen nudging.
      color={finishing ? 'primary' : 'inherit'}
      size={finishing ? 'large' : 'medium'}
      onClick={onEnd}
      aria-busy={pending}
      sx={finishing ? undefined : { ml: -1 }}
    >
      {pending
        ? 'Finishing…'
        : finishing
          ? 'Finish and see how it went'
          : 'End this interview'}
    </Button>
  );
}

export default EndInterviewControl;

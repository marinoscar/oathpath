/**
 * What the device preflight found, said once, in the same words the failure
 * would have used later.
 *
 * Issue #349, epic #345. Two screens render this — the practice picker, before
 * a session starts, and the hands-free panel, beside the Start control — and
 * the whole reason it is one component is that they must say the SAME sentence.
 * A learner who is told "no microphone was found on this device" on the picker
 * and something else beside the Start button has been given two accounts of one
 * fact, and has no way to tell which one is current.
 *
 * =============================================================================
 * THE COPY IS `describeCaptureProblem`'s. THIS FILE WRITES NONE OF IT.
 * =============================================================================
 *
 * `problem.message` and `problem.remedy` are rendered verbatim, straight off
 * the table in `useAudioCapture.ts`. There is deliberately no wording of this
 * component's own between them, no "we checked and…" preamble, and no
 * summarising heading — every one of those would be a second voice describing
 * the same problem, free to drift from the seven-remedies table the moment
 * either changes.
 *
 * =============================================================================
 * `severity="warning"`, NEVER `"error"`
 * =============================================================================
 *
 * Nothing has failed. The learner has not lost an answer, a session, or any
 * progress: typing is on the same screen and works (`docs/specs/voice.md` §5),
 * so this is a control that will not be available, not a thing that broke.
 * `VISION.md`'s tone rule — calm, specific, never blaming the person — and the
 * seven remedies exist precisely so that this can be a next step rather than an
 * alarm.
 *
 * `role="status"` for the same reason: nothing here should interrupt a screen
 * reader as though something had gone wrong.
 */

import { Alert, AlertTitle, Typography } from '@mui/material';

import type { AudioCaptureProblem } from '../../hooks/useAudioCapture';

export interface MicrophoneReadinessNoticeProps {
  /** The named problem, or `null` to render nothing at all. */
  problem: AudioCaptureProblem | null;
  /**
   * The shared `AudioContext` is suspended, so the spoken cues are silent.
   *
   * A SEPARATE, SMALLER FACT, and never merged into `problem`: it is not one of
   * the seven capture failures (nothing about the microphone is wrong), it does
   * not stop a session, and its remedy is one tap rather than a browser
   * setting. Rendered as a caption underneath so a learner who is relying on
   * the rising cue to know the microphone opened is told it will not sound —
   * `playEarcon` on a suspended context is an unannounced no-op, which is the
   * one failure mode of the audio cues that is invisible from the screen.
   */
  audioSuspended?: boolean;
  /** Optional `sx` passthrough, so each host controls its own spacing. */
  sx?: React.ComponentProps<typeof Alert>['sx'];
}

/** The one sentence about silent cues. Short, and not an alarm. */
export const AUDIO_SUSPENDED_MESSAGE =
  'The spoken cues are paused by this browser, so you may not hear the tone when the microphone opens. Tapping the page brings them back.';

export function MicrophoneReadinessNotice({
  problem,
  audioSuspended = false,
  sx,
}: MicrophoneReadinessNoticeProps) {
  if (!problem && !audioSuspended) return null;

  if (!problem) {
    return (
      <Alert severity="info" role="status" sx={sx}>
        {AUDIO_SUSPENDED_MESSAGE}
      </Alert>
    );
  }

  return (
    <Alert severity="warning" role="status" sx={sx}>
      {/* The message is the title and the remedy is the body: they are two
          different acts — what is true, then what to do — and running them
          together as one paragraph is how the actionable half stops being
          read. */}
      <AlertTitle>{problem.message}</AlertTitle>
      {problem.remedy}
      {audioSuspended && (
        <Typography variant="caption" component="p" sx={{ mt: 1 }}>
          {AUDIO_SUSPENDED_MESSAGE}
        </Typography>
      )}
    </Alert>
  );
}

export default MicrophoneReadinessNotice;

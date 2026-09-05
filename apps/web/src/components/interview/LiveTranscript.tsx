/**
 * The spoken interview's live transcript — issue #159, epic #60 / E11.
 *
 * Both sides of the conversation as it happens, in one region assistive
 * technology announces. The text screen renders the officer's turns only
 * (`useMockInterview`'s header says why: an applicant turn is stored with
 * `text: ''` when retention is off, and an empty bubble tells a learner,
 * wordlessly and falsely, that they said nothing). Here the applicant's words
 * are the provider's live transcription rather than a stored turn, so there is
 * no empty-bubble misreading to avoid and there IS something worth showing:
 * seeing what was heard is how a learner with an accent finds out the
 * recogniser followed them, without having to wait for a grade to find out it
 * did not.
 *
 * =============================================================================
 * `text: null` IS WITHHELD, NOT SILENCE
 * =============================================================================
 *
 * The only thing ever withheld is the writing test's dictated sentence — see
 * `useRealtimeInterview`'s header for both places it is kept out of the DOM.
 * This component renders code-owned copy in its place, so the learner knows
 * exactly what is happening and no branch here has a string to print.
 *
 * =============================================================================
 * POLITE, NOT ASSERTIVE, AND MOUNTED FROM THE FIRST RENDER
 * =============================================================================
 *
 * The same two decisions `InterviewPage` makes, for the same reasons. A live
 * region inserted at the same moment as its content is commonly missed
 * entirely by assistive technology, so the region is mounted empty and only
 * ever has its contents changed. And it is `polite`: a spoken officer's
 * transcript arrives fragment by fragment, and an `assertive` region would
 * interrupt the reader on every one of them — worse than silence, and
 * unusable. `aria-busy` is set while an utterance is still arriving, so the
 * announcement waits for a settled turn.
 *
 * NO VERDICT APPEARS HERE, EVER. `InterviewPage`'s central constraint applies
 * to this screen unchanged (`mock-interview.md` §10): the real interview gives
 * no per-question feedback, so a rehearsal that did would be teaching a learner
 * to expect reassurance the actual event will never provide — and on a spoken
 * transport that reassurance would arrive in a warm human voice within a
 * second of them answering. Nothing in this component is told how they are
 * doing, and there is no prop through which it could be.
 */

import { Box, Paper, Stack, Typography } from '@mui/material';

import { OfficerCard } from './OfficerCard';
import type { RealtimeTranscriptEntry } from '../../hooks/useRealtimeInterview';

/**
 * What stands in for a withheld line.
 *
 * Says what is happening rather than leaving a gap: a learner who sees nothing
 * on screen while the officer is clearly speaking will reasonably conclude the
 * transcript is broken and stop trusting the rest of it.
 */
export const WITHHELD_LINE =
  'The officer is reading a sentence aloud for you to write down. It is not shown here — that is the test.';

export interface LiveTranscriptProps {
  entries: RealtimeTranscriptEntry[];
  /** True while the officer's words are still arriving. */
  isOfficerSpeaking?: boolean;
}

export function LiveTranscript({
  entries,
  isOfficerSpeaking = false,
}: LiveTranscriptProps) {
  const lastIndex = entries.length - 1;

  return (
    <Stack
      spacing={2}
      aria-live="polite"
      aria-busy={isOfficerSpeaking}
      aria-label="Interview transcript"
    >
      {entries.map((entry, index) =>
        entry.role === 'officer' ? (
          <OfficerCard
            key={entry.id}
            // THE ONLY BRANCH. A withheld entry renders the constant above and
            // has no text of its own to render — see the file header.
            text={entry.text ?? WITHHELD_LINE}
            phase={entry.phase}
            isCurrent={index === lastIndex}
          />
        ) : (
          <Paper
            key={entry.id}
            variant="outlined"
            sx={{
              p: { xs: 2, sm: 3 },
              // Set back from the officer's cards so the two sides of the
              // conversation read as two sides at a glance. Indentation only —
              // no colour, no alignment flip, nothing that could read as a
              // judgement about what was said.
              ml: { xs: 0, sm: 4 },
              bgcolor: 'background.default',
              borderStyle: 'dashed',
            }}
          >
            <Typography
              variant="overline"
              component="p"
              color="text.secondary"
              sx={{ display: 'block', lineHeight: 1.6 }}
            >
              You said
            </Typography>
            <Typography
              variant="body1"
              component="p"
              lang="en"
              sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}
            >
              {entry.text}
            </Typography>
          </Paper>
        ),
      )}

      {/* Only before anything has been said. Once the officer has spoken, the
          transcript is its own evidence that the connection is live, and a
          standing "listening" line under it would be noise. */}
      {entries.length === 0 && (
        <Box>
          <Typography color="text.secondary">
            The officer is about to begin. You can speak as soon as they do
            &mdash; you do not need to press anything.
          </Typography>
        </Box>
      )}
    </Stack>
  );
}

export default LiveTranscript;

/**
 * The reading and writing tests, as this interview actually conducted them.
 *
 * Issue #160, epic #60 / E11. `docs/specs/realtime-interview.md` §5,
 * `docs/specs/english-test.md` §5.
 *
 * =============================================================================
 * THE WRITING SENTENCE APPEARS HERE, AND ONLY HERE
 * =============================================================================
 *
 * `english.service.ts` states the rule this inherits: on a writing attempt the
 * sentence is "the REVEAL — the first time the learner sees the sentence they
 * were dictated". The interview screen never renders it — that is a DOM
 * invariant the realtime screen holds, and on the realtime transport the string
 * need never reach the browser as text at all, because the model speaks it. A
 * debrief is read AFTERWARDS, so showing it is not a leak; withholding it would
 * leave a learner who missed the writing test with no way to find out what they
 * were asked to write, which is the one thing this band exists to prevent.
 *
 * `segmentSentenceLabel` names which of the two situations each sentence was
 * in, so "the sentence that was dictated" explains why it is only being seen
 * now.
 *
 * =============================================================================
 * `wer` IS PRINTED ON ITS OWN SCALE, NEVER RESCALED INTO A GRADE
 * =============================================================================
 *
 * The same discipline `ReadinessMovement` applies to `0.5 of 1`: the server
 * computed a word error rate, and this prints that number rather than turning
 * it into a percentage, a star rating, or "you got most of it". `outcome` is
 * the verdict; `wer` is the measurement behind it, and a screen that derived
 * one from the other would be scoring an English attempt in the browser.
 *
 * =============================================================================
 * A SEGMENT THAT WAS NOT CONDUCTED IS NOT HERE, AND THAT IS NOT SILENCE
 * =============================================================================
 *
 * The API sends an entry only for a segment that produced a scored attempt, so
 * this list can be one item long or absent entirely. Where the learner is told
 * what a rehearsal did NOT include is `PhaseCoverage`, in the words
 * `mock-interview.md` §2.4 requires — and saying it twice, in two shapes, is
 * how the two come to disagree.
 */

import { Box, Chip, Paper, Stack, Typography } from '@mui/material';

import type { InterviewSegmentResult } from '../../types';
import { outcomeDisplay } from '../practice/outcome';
import { segmentLabel, segmentSentenceLabel } from './debriefCopy';

export interface SegmentResultsProps {
  segments: InterviewSegmentResult[];
  /** Ties the section to its heading for assistive technology. */
  headingId: string;
}

export function SegmentResults({ segments, headingId }: SegmentResultsProps) {
  if (segments.length === 0) return null;

  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography
        id={headingId}
        component="h2"
        variant="overline"
        color="text.secondary"
        sx={{ display: 'block', letterSpacing: '0.08em' }}
      >
        Reading and writing
      </Typography>

      <Stack
        component="ul"
        spacing={2}
        sx={{ mt: 2, listStyle: 'none', m: 0, p: 0, pt: 2 }}
      >
        {segments.map((segment) => {
          const verdict = outcomeDisplay(segment.outcome);

          return (
            <Paper
              component="li"
              key={segment.kind}
              variant="outlined"
              sx={{ p: { xs: 2, sm: 3 } }}
            >
              <Stack
                direction="row"
                spacing={1}
                sx={{ alignItems: 'baseline', flexWrap: 'wrap', rowGap: 1 }}
              >
                {/* `h3` under the section's `h2`, matching `DebriefQuestion`.
                    The size is design; the level is semantics. */}
                <Typography
                  variant="subtitle1"
                  component="h3"
                  sx={{ fontWeight: 600 }}
                >
                  {segmentLabel(segment.kind)}
                </Typography>
                {/* Text as well as colour — a red chip and a green chip are the
                    same chip to a learner who cannot tell them apart. */}
                <Chip label={verdict.label} color={verdict.color} size="small" />
              </Stack>

              <Box sx={{ mt: 2 }}>
                <Typography
                  variant="overline"
                  component="h4"
                  color="text.secondary"
                  sx={{ display: 'block', mb: 0.5 }}
                >
                  {segmentSentenceLabel(segment.kind)}
                </Typography>
                <Typography variant="body1" component="p" sx={{ fontWeight: 600 }}>
                  {segment.sentence}
                </Typography>
              </Box>

              {/* The server's own number, on the server's own scale. */}
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                Word error rate: {segment.wer}
              </Typography>
            </Paper>
          );
        })}
      </Stack>
    </Box>
  );
}

export default SegmentResults;

/**
 * One thing the officer said.
 *
 * Issue #140, epic #57 / E8. Rendered once per officer turn, oldest first, and
 * once more — with `isStreaming` — for the turn currently arriving.
 *
 * =============================================================================
 * DELIBERATELY QUIETER THAN THE REST OF THE APP
 * =============================================================================
 *
 * This is a rehearsal of a formal encounter, not a quiz game. No colour beyond
 * the surface and the text palette, no icon, no chip, no emoji, no celebration
 * of any kind — and nothing that changes appearance based on how the learner is
 * doing, because this component is never told how they are doing. `VISION.md`
 * asks for a product that feels familiar by the time someone walks into the
 * real interview; a card that congratulated them would be rehearsing the wrong
 * thing.
 *
 * The only visual distinction is `isCurrent`: the most recent turn is what the
 * learner is answering, so it carries the surface and the earlier ones fade
 * back. That is legibility, not judgement.
 *
 * =============================================================================
 * THE TEXT IS RENDERED AS TEXT, WITH ITS OWN LINE BREAKS
 * =============================================================================
 *
 * A civics officer turn is assembled server-side as the acknowledgement, a
 * blank line, and then the question's `prompt` read VERBATIM from the database
 * (`mock-interview.md` §5.1 — the question text never passes through the model,
 * so it cannot be paraphrased or invented). `white-space: pre-wrap` is what
 * keeps that blank line where the server put it. Never
 * `dangerouslySetInnerHTML`: part of this string was written by a model.
 */

import { Box, Paper, Typography } from '@mui/material';

import { phaseLabel } from './phases';

export interface OfficerCardProps {
  /** What the officer said. May be empty while the first tokens are in flight. */
  text: string;
  /** The phase this turn belongs to — its eyebrow. */
  phase: string;
  /** The turn the learner is answering now. Earlier turns pass `false`. */
  isCurrent?: boolean;
  /** True only for the turn whose words are still arriving. */
  isStreaming?: boolean;
}

export function OfficerCard({
  text,
  phase,
  isCurrent = false,
  isStreaming = false,
}: OfficerCardProps) {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: { xs: 2, sm: 3 },
        // The past reads as the past. `background.default` sits behind the
        // page, so an earlier turn recedes without being greyed out to the
        // point of being hard to read — a transcript a learner cannot re-read
        // is a transcript that may as well not be there.
        bgcolor: isCurrent ? 'background.paper' : 'background.default',
        borderColor: 'divider',
      }}
    >
      <Typography
        variant="overline"
        component="p"
        color="text.secondary"
        sx={{ display: 'block', lineHeight: 1.6 }}
      >
        {phaseLabel(phase)}
      </Typography>

      <Typography
        variant="body1"
        component="p"
        sx={{
          // The server's own paragraph breaks — including the blank line before
          // a civics question — are the breaks the learner reads.
          whiteSpace: 'pre-wrap',
          lineHeight: 1.7,
          // Slightly larger for the turn being answered: it is the question on
          // the table, and the ones above it are context.
          fontSize: isCurrent ? { xs: '1.05rem', sm: '1.15rem' } : undefined,
          color: isCurrent ? 'text.primary' : 'text.secondary',
        }}
      >
        {text}
      </Typography>

      {/* Only while the first tokens are still in flight. Once any text has
          arrived it is its own evidence that something is happening, and a
          second "working" line under it would be noise. */}
      {isStreaming && !text && (
        <Box sx={{ mt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            The officer is responding&hellip;
          </Typography>
        </Box>
      )}
    </Paper>
  );
}

export default OfficerCard;

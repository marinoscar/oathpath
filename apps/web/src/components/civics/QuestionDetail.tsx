/**
 * The leaf of `/learn`: one question and the answers resolved for this learner.
 *
 * Issue #121, epic #51.
 *
 * =============================================================================
 * THE HEADING OUTLINE IS THE HIERARCHY
 * =============================================================================
 *
 * The page owns the single `h1` ("Learn"); this component contributes
 * `h2` (the category), `h3` (the question) and, through `AnswerPanel`, `h4`
 * ("Answer"). So a screen-reader user moving by heading traverses exactly the
 * structure the issue asks for — category → question → answer — instead of
 * landing on three unrelated `h6`s that happened to be the right size.
 *
 * `variant` is decoupled from `component` throughout, because the level is
 * semantics and the size is design. The category is the smallest thing on
 * screen and the highest heading here; that is correct, and tying the two
 * together is how a page ends up with an `h4` between an `h1` and an `h3`.
 *
 * =============================================================================
 * NOTHING HERE INTERPRETS `answerResolution`
 * =============================================================================
 *
 * `AnswerPanel` owns all three answer states, including the `state_required`
 * one, and it owns them for the flashcard too. This file must never grow a
 * "helpful" fallback that reaches for a national answer when a state one is
 * missing — see `StateRequiredNotice`.
 */

import { Box, Divider, Stack, Typography } from '@mui/material';

import type { CivicsQuestionDetail as CivicsQuestion } from '../../types';
import { AnswerPanel } from './AnswerPanel';
import {
  SENIOR_MARKER_DESCRIPTION,
  SeniorEligibleChip,
} from './SeniorEligibleChip';

export interface QuestionDetailProps {
  question: CivicsQuestion;
  /** The learner's state as a name; see `AnswerPanel`. */
  stateName?: string | null;
}

export function QuestionDetail({ question, stateName }: QuestionDetailProps) {
  return (
    <Box>
      <Typography
        variant="overline"
        component="h2"
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        {question.category.name}
      </Typography>

      <Stack
        direction="row"
        spacing={1}
        sx={{ mt: 0.5, alignItems: 'baseline', flexWrap: 'wrap' }}
      >
        <Typography
          component="span"
          variant="body1"
          color="text.secondary"
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {question.number}.
        </Typography>
        <Typography variant="h5" component="h3" sx={{ fontWeight: 600, flex: 1 }}>
          {question.prompt}
        </Typography>
      </Stack>

      {question.seniorEligible && (
        <Box sx={{ mt: 1.5 }}>
          <SeniorEligibleChip />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {SENIOR_MARKER_DESCRIPTION}
          </Typography>
        </Box>
      )}

      <Divider aria-hidden sx={{ my: 3 }} />

      <AnswerPanel
        question={question}
        stateName={stateName}
        headingComponent="h4"
        showSources
      />
    </Box>
  );
}

export default QuestionDetail;

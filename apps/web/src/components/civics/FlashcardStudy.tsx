/**
 * Flashcard study — prompt first, reveal the answer, move on.
 *
 * Issue #121, epic #51. This is `VISION.md`'s learning progression at its very
 * first step: **See it → Understand it**, deliberately BEFORE any recall.
 *
 * =============================================================================
 * RECOGNITION ONLY. NO SCORE, NO JUDGEMENT, NO SCHEDULING. THIS IS A BOUNDARY.
 * =============================================================================
 *
 * There is no "did you get it?" control here, of any kind — no correct/not
 * pair, no easy/hard rating, no tally, no streak, and nothing written anywhere
 * when a card is revealed. That is not an omission to be filled in later by
 * whoever touches this file next; it is the design.
 *
 * The reasoning, stated once so it is not re-litigated in a review comment: a
 * learner arriving at `/learn` has been shown nothing yet. Grading their first
 * encounter with material they have not studied turns reading into an
 * unannounced test, and the result of that test would be noise — it measures
 * whether they happened to already know a fact, which is precisely what this
 * screen exists to teach them. Recall, grading and scheduling are E3–E5, on
 * screens a learner has been prepared for and against evidence
 * (`practice_attempts`) that does not exist yet.
 *
 * A future contributor asked to "just add a quick self-rating" should decline
 * and point at this comment.
 *
 * =============================================================================
 * THE REVEAL IS A REAL BUTTON, AND THE ANSWER IS ANNOUNCED
 * =============================================================================
 *
 * `<Button>` — a real `<button>`, focusable, operable with Space and Enter,
 * with a visible focus ring from the theme. Never a click handler on a Paper.
 *
 * The answer lands inside a region that is in the DOM from the first render
 * with `role="status"` (`aria-live="polite"`). That ordering is what makes it
 * announce: a live region inserted at the same moment as its content is
 * commonly missed entirely by assistive technology, because there was nothing
 * being watched when the change happened. So the region is always mounted and
 * only its contents change.
 *
 * =============================================================================
 * THE CONTROLS ARE AT THE BOTTOM, AND STAY THERE AT 360px
 * =============================================================================
 *
 * Flashcards are the screen most likely to be used one-handed on a phone, so
 * the two controls sit in one row BELOW the card, in the thumb zone, with the
 * primary action taking the width.
 *
 * The prompt and the answer each scroll INSIDE the card on a compact viewport
 * (`maxHeight` + `overflowY`) rather than growing the page. A five-answer
 * question — "What is one right in the First Amendment?" — would otherwise push
 * the reveal control off the bottom of a 360px screen at exactly the moment the
 * learner needs it. The clamp is a viewport-relative height, not a breakpoint
 * gate: it does not touch any of the five coupled gates in `Layout.tsx`, and it
 * lifts entirely at `sm`, where there is room.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

import type { CivicsQuestionSummary } from '../../types';
import { useCivicsQuestion } from '../../hooks/useCivicsQuestion';
import { AnswerPanel } from './AnswerPanel';
import { SeniorEligibleChip } from './SeniorEligibleChip';

export interface FlashcardStudyProps {
  /** The deck, in the server's order. */
  questions: CivicsQuestionSummary[];
  /** What the learner chose to study — a category name, or "All questions". */
  deckLabel: string;
  /** The learner's state as a name; see `AnswerPanel`. */
  stateName?: string | null;
}

export function FlashcardStudy({
  questions,
  deckLabel,
  stateName,
}: FlashcardStudyProps) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);

  const current = questions[index] ?? null;
  // Fetched per card rather than for the whole deck up front: a 128-question
  // version would be 128 requests to open a screen the learner may leave after
  // three cards, and the prompt — which is what they read first — is already in
  // hand from the list.
  const { question, isLoading, error } = useCivicsQuestion(current?.id ?? null);

  // A new deck starts at its own first card. Without this, switching category
  // while studying would land on card 14 of a set that has eight.
  //
  // Keyed on a SIGNATURE rather than on the array's identity: a caller that
  // derived its deck inline would hand us a new array every render, and this
  // effect would then reset the learner to card 1 on every parent re-render —
  // a bug that looks like "the Next button doesn't work".
  const deckSignature =
    questions.length === 0 ? '' : `${questions.length}:${questions[0].id}`;
  useEffect(() => {
    setIndex(0);
    setRevealed(false);
  }, [deckSignature]);

  const goTo = useCallback((next: number) => {
    setIndex(next);
    // Every move hides the answer again. This is the whole interaction: a card
    // that arrived already revealed would never be a prompt.
    setRevealed(false);
  }, []);

  if (questions.length === 0) {
    return (
      <Typography color="text.secondary">
        There are no questions to study in this part of the test yet.
      </Typography>
    );
  }

  const isLast = index === questions.length - 1;

  const primaryLabel = !revealed
    ? 'Show answer'
    : isLast
      ? 'Start over'
      : 'Next question';

  const onPrimary = () => {
    if (!revealed) {
      setRevealed(true);
      return;
    }
    goTo(isLast ? 0 : index + 1);
  };

  return (
    <Box>
      <Typography variant="h6" component="h2">
        Flashcards
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {deckLabel}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        Read the question, reveal the answer, then move on. Nothing here is
        marked or counted against you.
      </Typography>

      <Typography
        variant="caption"
        component="p"
        color="text.secondary"
        sx={{ mt: 2, fontVariantNumeric: 'tabular-nums' }}
      >
        Card {index + 1} of {questions.length}
      </Typography>

      <Paper
        variant="outlined"
        sx={{
          mt: 1,
          p: { xs: 2, sm: 3 },
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <Box sx={{ overflowY: 'auto', maxHeight: { xs: '30vh', sm: 'none' } }}>
          <Typography
            variant="overline"
            component="p"
            color="text.secondary"
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          >
            Question {current?.number}
          </Typography>
          <Typography variant="h5" component="h3" sx={{ fontWeight: 600 }}>
            {current?.prompt}
          </Typography>
          {current?.seniorEligible && (
            <Box sx={{ mt: 1.5 }}>
              <SeniorEligibleChip />
            </Box>
          )}
        </Box>

        {/* Mounted from the first render, empty until the reveal — see the
            header. `aria-live="polite"` is implied by `role="status"`; both are
            stated so a future edit that drops the role does not silently drop
            the announcement too. */}
        <Box
          role="status"
          aria-live="polite"
          sx={{ overflowY: 'auto', maxHeight: { xs: '34vh', sm: 'none' } }}
        >
          {revealed && isLoading && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                Loading the answer&hellip;
              </Typography>
            </Stack>
          )}
          {revealed && !isLoading && error && (
            <Alert severity="error">{error}</Alert>
          )}
          {revealed && !isLoading && !error && question && (
            <AnswerPanel
              question={question}
              stateName={stateName}
              headingComponent="h4"
            />
          )}
        </Box>
      </Paper>

      <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
        <Button
          variant="outlined"
          size="large"
          onClick={() => goTo(index - 1)}
          disabled={index === 0}
          // Icon-only so the primary action keeps the width at 360px. The
          // accessible name is explicit rather than inferred from an icon.
          aria-label="Previous card"
          sx={{ minWidth: 56 }}
        >
          <ArrowBackIcon />
        </Button>
        <Button
          variant="contained"
          size="large"
          onClick={onPrimary}
          sx={{ flex: 1 }}
        >
          {primaryLabel}
        </Button>
      </Stack>
    </Box>
  );
}

export default FlashcardStudy;

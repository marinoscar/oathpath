/**
 * The middle level of `/learn`: a page of questions, each a link to its answer.
 *
 * Issue #121, epic #51.
 *
 * =============================================================================
 * THE OFFICIAL NUMBER IS SHOWN, BECAUSE IT IS WHAT THE QUESTION IS CALLED
 * =============================================================================
 *
 * `civics_questions.number` is the official number within the version, and it
 * is never reassigned once content ships. A learner comparing notes with a
 * study group, a study guide, or a USCIS PDF refers to "question 43" — a list
 * that renumbered from 1 within each category would make every one of those
 * conversations wrong.
 *
 * =============================================================================
 * PAGINATION IS LINKS, NOT A CLICK HANDLER
 * =============================================================================
 *
 * `PaginationItem component={RouterLink}` — same reasoning as the rows: page 3
 * is a place, so Back returns to page 2, and a learner can open a question in a
 * new tab without losing their place. `siblingCount={0}` keeps the control
 * inside 360px; the server's own `page` drives it, never a local counter that
 * could disagree with what was actually fetched.
 *
 * =============================================================================
 * THE 65/20 MARKER IS EXPLAINED WHERE IT APPEARS
 * =============================================================================
 *
 * The chip is two digits and a slash. The sentence explaining it renders once
 * per list, and only when at least one row carries the marker — an explanation
 * for a symbol that is not on screen is noise, and a symbol with no explanation
 * anywhere is a puzzle.
 */

import {
  Box,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Pagination,
  PaginationItem,
  Stack,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import type { CivicsQuestionSummary } from '../../types';
import {
  SENIOR_MARKER_DESCRIPTION,
  SeniorEligibleChip,
} from './SeniorEligibleChip';

export interface QuestionListProps {
  questions: CivicsQuestionSummary[];
  /** Question id → the `/learn` URL that opens its answer. */
  hrefForQuestion: (questionId: string) => string;
  /** Page number → the `/learn` URL for that page of this same list. */
  hrefForPage: (page: number) => string;
  /** The page the SERVER answered with. */
  page: number;
  totalPages: number;
  total: number;
}

export function QuestionList({
  questions,
  hrefForQuestion,
  hrefForPage,
  page,
  totalPages,
  total,
}: QuestionListProps) {
  const anySenior = questions.some((question) => question.seniorEligible);

  if (questions.length === 0) {
    return (
      <Typography color="text.secondary">
        There are no questions in this part of the test yet.
      </Typography>
    );
  }

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: anySenior ? 0.5 : 2 }}>
        {total} {total === 1 ? 'question' : 'questions'}
      </Typography>

      {anySenior && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {SENIOR_MARKER_DESCRIPTION}
        </Typography>
      )}

      <List disablePadding>
        {questions.map((question) => (
          <ListItem key={question.id} disablePadding>
            <ListItemButton
              component={RouterLink}
              to={hrefForQuestion(question.id)}
              sx={{ borderRadius: 1, alignItems: 'flex-start', py: 1.5 }}
            >
              {/* The number as its own column, so prompts of very different
                  lengths still line up and the list scans vertically at
                  360px. `minWidth` rather than a fixed width: `128.` is wider
                  than `3.` and must not be clipped. */}
              <Typography
                component="span"
                variant="body2"
                color="text.secondary"
                sx={{ minWidth: 36, pt: 0.25, fontVariantNumeric: 'tabular-nums' }}
              >
                {question.number}.
              </Typography>
              <ListItemText
                primary={question.prompt}
                secondary={
                  question.seniorEligible ? (
                    <Box component="span" sx={{ display: 'inline-flex', mt: 0.5 }}>
                      <SeniorEligibleChip />
                    </Box>
                  ) : null
                }
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>

      {totalPages > 1 && (
        <Stack sx={{ mt: 3, alignItems: 'center' }}>
          <Pagination
            page={page}
            count={totalPages}
            siblingCount={0}
            size="small"
            // The control is a navigation landmark's worth of links; naming it
            // is what stops a screen reader announcing "1 2 3" with no context.
            getItemAriaLabel={(type, itemPage, selected) =>
              type === 'page'
                ? `${selected ? 'Page ' : 'Go to page '}${itemPage}`
                : `Go to ${type} page`
            }
            renderItem={(item) => (
              <PaginationItem
                component={RouterLink}
                to={hrefForPage(item.page ?? 1)}
                {...item}
              />
            )}
          />
        </Stack>
      )}
    </Box>
  );
}

export default QuestionList;

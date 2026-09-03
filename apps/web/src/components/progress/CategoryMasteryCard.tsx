/**
 * One category's coverage and mastery — a card in `/progress`'s category grid.
 *
 * Issue #94, epic #54 / E5 "Memory".
 *
 * =============================================================================
 * SCOPE DECISION: A PER-CATEGORY WEAK COUNT AND RETRY, NOT A PER-QUESTION LIST
 * =============================================================================
 *
 * `GET /api/progress/mastery` (issue #86) returns category/state AGGREGATES —
 * `byState.lapsed`, not which questions are lapsed. There is no endpoint
 * anywhere in `apps/api/src/practice` or `apps/api/src/civics` that lists
 * individual due/weak questions with enough identity to retry one directly;
 * `GET /api/practice/queue` (issue #78) returns the same shape of flat bucket
 * COUNTS this page's sibling reads, not rows. Building a literal per-question
 * list here would mean inventing a new endpoint this issue does not scope.
 *
 * So "weak" is answered at the grain the data actually supports: this card
 * shows `byState.lapsed` — the one bucket `mastery/selector.ts`'s own
 * `classifyMasteryBucket` counts as weak UNCONDITIONALLY (a `learning`/`review`
 * question crosses into weak only with `lapses >= WEAK_LAPSES_THRESHOLD` or
 * `correctStreak === 0`, neither of which this aggregate exposes per
 * category) — and its retry starts a `category`-kind session over the WHOLE
 * category, through the exact `createPracticeSession` call `/practice`
 * already uses. That session's own selector then applies the full weak/due
 * ordering server-side, so the one-tap retry still lands the learner on their
 * weakest questions first even though this card could not name them.
 */

import { Box, Button, Card, CardContent, Typography } from '@mui/material';
import ReplayIcon from '@mui/icons-material/Replay';

import type { ProgressMasteryCategory } from '../../types';
import { MasteryBreakdownBar } from './MasteryBreakdownBar';

export interface CategoryMasteryCardProps {
  category: ProgressMasteryCategory;
  /** True while THIS category's retry session is being created. */
  isStarting: boolean;
  /** True while a DIFFERENT category's retry is in flight — disables this button too. */
  disabled: boolean;
  onRetry: (category: ProgressMasteryCategory) => void;
  headingId: string;
}

export function CategoryMasteryCard({
  category,
  isStarting,
  disabled,
  onRetry,
  headingId,
}: CategoryMasteryCardProps) {
  const lapsedCount = category.byState.lapsed;

  return (
    <Card component="section" aria-labelledby={headingId} variant="outlined">
      <CardContent sx={{ p: { xs: 2, sm: 2.5 } }}>
        <Typography id={headingId} component="h3" variant="subtitle1" sx={{ fontWeight: 600 }}>
          {category.categoryName}
        </Typography>
        <Typography color="text.secondary" variant="body2" sx={{ mt: 0.5 }}>
          {category.masteredCount} of {category.totalQuestions} mastered
        </Typography>

        <Box sx={{ mt: 1.5 }}>
          <MasteryBreakdownBar
            byState={category.byState}
            total={category.totalQuestions}
            aria-label={`${category.categoryName}: ${category.masteredCount} of ${category.totalQuestions} mastered`}
          />
        </Box>

        {lapsedCount > 0 && (
          <Box
            sx={{
              mt: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 1,
            }}
          >
            <Typography variant="body2" color="error.main">
              {lapsedCount} {lapsedCount === 1 ? 'question needs' : 'questions need'} review
            </Typography>
            <Button
              size="small"
              variant="outlined"
              color="error"
              startIcon={<ReplayIcon />}
              onClick={() => onRetry(category)}
              disabled={disabled}
            >
              {isStarting ? 'Starting…' : 'Practice this section'}
            </Button>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

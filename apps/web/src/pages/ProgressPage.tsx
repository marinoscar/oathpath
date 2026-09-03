/**
 * Progress (`/progress`) — coverage and mastery, by category, plus the
 * weak list.
 *
 * Issue #94, epic #54 / E5 "Memory". This SUPERSEDES the designed empty state
 * #69 shipped here (`components/journey/DestinationEmptyState`) — the same
 * superseded-not-deleted relationship `PracticePage.tsx` (#76) has with its
 * own E1 stub. `docs/specs/journey-shell.md` §8.3 still describes the copy
 * this replaces.
 *
 * =============================================================================
 * WHAT THIS PAGE READS, AND WHAT IT DOES NOT
 * =============================================================================
 *
 * One request, `GET /api/progress/mastery` (issue #86): whole-bank coverage
 * (`attempted`/`totalQuestions`), whole-bank mastery counts (`byState`), and
 * the same breakdown per category. This page renders that response and
 * nothing it computed itself — no client-side aggregation, no re-deriving
 * "mastered" from attempts, because the server already did that against the
 * live `question_mastery` rows.
 *
 * =============================================================================
 * SCOPE DECISION: THE WEAK LIST IS PER-CATEGORY, NOT PER-QUESTION
 * =============================================================================
 *
 * See `components/progress/CategoryMasteryCard.tsx`'s header for the full
 * reasoning — the short version: the mastery endpoint returns aggregates,
 * not individual question rows, and no endpoint in this codebase lists
 * per-question weak/due questions with retry identity. "Needs review" here
 * means "this category has at least one `lapsed` question" (the one weak
 * signal the aggregate exposes precisely, and the one bucket
 * `mastery/selector.ts` counts as weak unconditionally), and the one-tap
 * retry starts a `category`-kind session over the whole category — the exact
 * `createPracticeSession` call `/practice` already makes — whose own
 * server-side ordering serves the weakest questions in it first.
 *
 * =============================================================================
 * THREE STATES, KEPT APART — SAME DISCIPLINE AS `/practice`
 * =============================================================================
 *
 * Loading, empty (`attempted === 0`, a brand-new learner) and failed are
 * three different things to say. An empty bank is a sentence, never a chart
 * at zero or a ring showing nothing — `VISION.md`'s honesty rule, the same
 * one `usePracticeSessions`'s own header states. A failed fetch renders an
 * error with a retry, never a blank page pretending there is nothing to show.
 *
 * =============================================================================
 * WHAT THIS PAGE IS NOT
 * =============================================================================
 *
 * Not a settings surface — `CLAUDE.md`'s Settings UI Pattern does not apply.
 * No new `DESTINATIONS` entry either: `/progress` has been one since E1
 * (`config/destinations.ts`), and this file only fills in the route that
 * already existed. One `h1` ("Progress"), an `h2` per band, mobile-first with
 * every responsive value stepping at `sm` (600px) — none of `CLAUDE.md`'s
 * five coupled breakpoint gates is touched.
 */

import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Container,
  Divider,
  Grid,
  LinearProgress,
  List,
  ListItem,
  Typography,
} from '@mui/material';
import ReplayIcon from '@mui/icons-material/Replay';
import { Link as RouterLink, useNavigate } from 'react-router-dom';

import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { CategoryMasteryCard } from '../components/progress/CategoryMasteryCard';
import { MasteryBreakdownBar } from '../components/progress/MasteryBreakdownBar';
// The same `/settings/journey` destination `/practice` already links unfinished
// setup to — imported rather than re-spelled, so a route rename only has one
// place to change.
import { SET_STATE_PATH as PLAN_PATH } from '../components/civics/StateRequiredNotice';
import { useIsMounted } from '../hooks/useIsMounted';
import { useLearnerProfile } from '../contexts/LearnerProfileContext';
import { useProgressMastery } from '../hooks/useProgressMastery';
import { createPracticeSession } from '../services/api';
import type { ProgressMasteryCategory } from '../types';

export default function ProgressPage() {
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const { profile, isLoading: isProfileLoading } = useLearnerProfile();
  const testVersionCode = profile?.testVersionCode ?? null;

  const { mastery, isLoading, error, refresh } = useProgressMastery(testVersionCode);

  /** Which category's retry session is in flight — a category id, or null. */
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  const retry = async (category: ProgressMasteryCategory) => {
    setRetrying(category.categoryId);
    setRetryError(null);
    try {
      const state = await createPracticeSession({
        kind: 'category',
        categoryId: category.categoryId,
      });
      if (!isMounted()) return;
      navigate(`/practice/sessions/${state.session.id}`);
    } catch (err) {
      if (isMounted()) {
        setRetryError(
          err instanceof Error
            ? err.message
            : 'A practice session could not be started.',
        );
        setRetrying(null);
      }
    }
  };

  if (isProfileLoading) {
    return (
      <Container maxWidth="md" disableGutters>
        <Box role="status" aria-live="polite" aria-label="Loading Progress">
          <LoadingSpinner />
        </Box>
      </Container>
    );
  }

  // Weak categories, worst first — the same predicate
  // `CategoryMasteryCard` renders its own retry on.
  const weakCategories = (mastery?.categories ?? [])
    .filter((category) => category.byState.lapsed > 0)
    .sort((a, b) => b.byState.lapsed - a.byState.lapsed);

  return (
    <Container maxWidth="md" disableGutters>
      <Box sx={{ py: { xs: 1, sm: 2 } }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
          Progress
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          How much of the test you&rsquo;ve covered, and how well you actually
          know it &mdash; by section.
        </Typography>

        <Divider aria-hidden sx={{ mt: 2, mb: 3 }} />

        {!testVersionCode ? (
          <Alert severity="info" role="status">
            We don&rsquo;t know which civics test applies to you yet, so
            there&rsquo;s no progress to show. Tell us your filing date in
            your plan and this page will fill in as you practise.
            <Box sx={{ mt: 1.5 }}>
              <Button
                component={RouterLink}
                to={PLAN_PATH}
                size="small"
                variant="outlined"
                color="inherit"
              >
                Open your plan
              </Button>
            </Box>
          </Alert>
        ) : error ? (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void refresh()}>
                Try again
              </Button>
            }
          >
            {error}
          </Alert>
        ) : isLoading ? (
          <Box role="status" aria-live="polite" aria-label="Loading Progress">
            <LoadingSpinner />
          </Box>
        ) : !mastery || mastery.attempted === 0 ? (
          // The honest empty state — no chart, no ring, no fabricated zero.
          <Box component="section" aria-labelledby="progress-empty-heading">
            <Typography
              id="progress-empty-heading"
              variant="overline"
              component="h2"
              color="text.secondary"
              sx={{ display: 'block' }}
            >
              Nothing to show yet
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
              You haven&rsquo;t practised yet, so there&rsquo;s no evidence to
              show. Once you answer some questions, your coverage and mastery
              show up here, by section.
            </Typography>
            <Button
              component={RouterLink}
              to="/practice"
              variant="contained"
              sx={{ mt: 2 }}
            >
              Go to Practice
            </Button>
          </Box>
        ) : (
          <>
            {retryError && (
              <Alert severity="error" sx={{ mb: 3 }}>
                {retryError}
              </Alert>
            )}

            {/* -----------------------------------------------------------
                1. Overall summary.
                ----------------------------------------------------------- */}
            <Box component="section" aria-labelledby="progress-overall-heading">
              <Typography
                id="progress-overall-heading"
                variant="overline"
                component="h2"
                color="text.secondary"
                sx={{ display: 'block' }}
              >
                Overall
              </Typography>

              <Typography sx={{ mt: 1 }}>
                {mastery.attempted} of {mastery.totalQuestions} questions
                attempted
              </Typography>
              <LinearProgress
                variant="determinate"
                value={(mastery.attempted / mastery.totalQuestions) * 100}
                sx={{ mt: 1, height: 8, borderRadius: 4 }}
                aria-label={`${mastery.attempted} of ${mastery.totalQuestions} questions attempted`}
              />

              <Box sx={{ mt: 2.5 }}>
                <MasteryBreakdownBar
                  byState={mastery.byState}
                  total={mastery.totalQuestions}
                  aria-label={`Mastery breakdown across all ${mastery.totalQuestions} questions`}
                />
              </Box>
            </Box>

            {/* -----------------------------------------------------------
                2. Needs review — the weak list, one tap from a retry.
                ----------------------------------------------------------- */}
            {weakCategories.length > 0 && (
              <Box
                component="section"
                aria-labelledby="progress-weak-heading"
                sx={{ mt: 4 }}
              >
                <Typography
                  id="progress-weak-heading"
                  variant="overline"
                  component="h2"
                  color="text.secondary"
                  sx={{ display: 'block' }}
                >
                  Needs review
                </Typography>
                <Typography color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
                  Sections with at least one question you&rsquo;ve recently
                  gotten wrong more than once. Practising the section serves
                  those questions first.
                </Typography>

                <List disablePadding sx={{ mt: 1 }}>
                  {weakCategories.map((category) => (
                    <ListItem
                      key={category.categoryId}
                      disablePadding
                      sx={{
                        py: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 1,
                        flexWrap: 'wrap',
                      }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography sx={{ fontWeight: 500 }}>
                          {category.categoryName}
                        </Typography>
                        <Typography variant="body2" color="error.main">
                          {category.byState.lapsed}{' '}
                          {category.byState.lapsed === 1 ? 'question' : 'questions'}{' '}
                          need review
                        </Typography>
                      </Box>
                      <Button
                        size="small"
                        variant="outlined"
                        color="error"
                        startIcon={<ReplayIcon />}
                        onClick={() => void retry(category)}
                        disabled={retrying !== null}
                      >
                        {retrying === category.categoryId
                          ? 'Starting…'
                          : 'Practice this section'}
                      </Button>
                    </ListItem>
                  ))}
                </List>
              </Box>
            )}

            {/* -----------------------------------------------------------
                3. By category — the full coverage and mastery breakdown.
                ----------------------------------------------------------- */}
            <Box component="section" aria-labelledby="progress-categories-heading" sx={{ mt: 4 }}>
              <Typography
                id="progress-categories-heading"
                variant="overline"
                component="h2"
                color="text.secondary"
                sx={{ display: 'block' }}
              >
                By section
              </Typography>

              {mastery.categories.length === 0 ? (
                <Typography color="text.secondary" sx={{ mt: 1 }}>
                  There are no sections in your test version yet.
                </Typography>
              ) : (
                <Grid container spacing={2} sx={{ mt: 0.5 }}>
                  {mastery.categories.map((category) => (
                    <Grid key={category.categoryId} size={{ xs: 12, sm: 6 }}>
                      <CategoryMasteryCard
                        category={category}
                        isStarting={retrying === category.categoryId}
                        disabled={retrying !== null}
                        onRetry={(c) => void retry(c)}
                        headingId={`progress-category-${category.categoryId}-heading`}
                      />
                    </Grid>
                  ))}
                </Grid>
              )}
            </Box>
          </>
        )}
      </Box>
    </Container>
  );
}

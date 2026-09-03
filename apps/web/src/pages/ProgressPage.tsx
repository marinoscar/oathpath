/**
 * Progress (`/progress`) — readiness (score, breakdown, cap, trend,
 * recommendation, narrative), plus coverage and mastery by category and the
 * weak list.
 *
 * Issue #94/#139, epic #54 / E5 "Memory" and epic #55 / E6 "Readiness and
 * Progress". This is "Progress v2" — it SUPERSEDES neither the mastery
 * sections E5 shipped here nor the empty state #69 shipped before that
 * (`components/journey/DestinationEmptyState`, still described by
 * `docs/specs/journey-shell.md` §8.3); it ADDS the readiness surface on top
 * of them, per `docs/specs/readiness-model.md`.
 *
 * =============================================================================
 * TWO INDEPENDENT DATA SOURCES, TWO INDEPENDENT LOADING/ERROR STATES
 * =============================================================================
 *
 * `useProgressMastery` (E5) and `useReadiness`/`useReadinessHistory` (E6) are
 * three separate requests that settle independently and are rendered in two
 * separate regions. This is a DELIBERATE DEPARTURE from `HomePage.tsx`'s own
 * "one combined loading flag" discipline: Home combines its two reads
 * because painting either half without the other produces a screen that
 * looks finished but is lying (a stage path with no recommendation behind
 * it, or vice versa) — the two are read TOGETHER because they describe one
 * indivisible thing, the learner's current journey position.
 *
 * Readiness and mastery are not that. They are two different, individually
 * complete answers to two different questions ("how ready am I overall" vs.
 * "what do I know, by section"), and a learner whose readiness call is slow
 * or down still deserves to see their mastery breakdown the moment it
 * arrives, not a page held hostage to whichever of three requests is
 * slowest. Each section below owns its own loading spinner and its own
 * retryable error, exactly the way `ProgressPage` v1 already owned one
 * region's worth of state before this file had a second and third source to
 * coordinate.
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
 * THREE STATES, KEPT APART — SAME DISCIPLINE AS `/practice`, PER SECTION
 * =============================================================================
 *
 * Loading, empty (`attempted === 0`, a brand-new learner) and failed are
 * three different things to say, in EVERY section of this page. An empty or
 * unmeasured value is a sentence, never a chart at zero or a ring showing
 * nothing — `VISION.md`'s honesty rule, the same one `usePracticeSessions`'s
 * own header states and `readiness.ts`'s "no evidence yet" rule extends to
 * the three structurally-unwired components. A failed fetch renders an
 * error with a retry, never a blank page pretending there is nothing to
 * show.
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
 *
 * `<TrustFooter />` (§9.3, `components/journey/TrustFooter.tsx`) renders at
 * the end — VISION.md/ROADMAP require every readiness surface to carry the
 * standing disclaimer, and Home already renders it; this is Progress's own
 * render of the exact same, unmodified component.
 */

import { useState } from 'react';
import {
  Alert,
  AlertTitle,
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
import { ReadinessBreakdown } from '../components/progress/ReadinessBreakdown';
import { ReadinessScoreDial } from '../components/progress/ReadinessScoreDial';
import {
  findPreviousReadinessScore,
  readinessTrendText,
} from '../components/progress/readiness';
import { TrustFooter } from '../components/journey/TrustFooter';
// The same `/settings/journey` destination `/practice` already links unfinished
// setup to — imported rather than re-spelled, so a route rename only has one
// place to change.
import { SET_STATE_PATH as PLAN_PATH } from '../components/civics/StateRequiredNotice';
import { useIsMounted } from '../hooks/useIsMounted';
import { useLearnerProfile } from '../contexts/LearnerProfileContext';
import { useProgressMastery } from '../hooks/useProgressMastery';
import { useReadiness } from '../hooks/useReadiness';
import { useReadinessHistory } from '../hooks/useReadinessHistory';
import { createPracticeSession } from '../services/api';
import type { ProgressMasteryCategory } from '../types';

export default function ProgressPage() {
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const { profile, isLoading: isProfileLoading } = useLearnerProfile();
  const testVersionCode = profile?.testVersionCode ?? null;

  const { mastery, isLoading, error, refresh } = useProgressMastery(testVersionCode);
  const {
    readiness,
    isLoading: isReadinessLoading,
    error: readinessError,
    refresh: refreshReadiness,
  } = useReadiness();
  // History is a trend enhancement, not a load-bearing read: a slow or
  // failed history call quietly omits the trend sentence rather than
  // blocking or erroring the readiness section it sits inside. See
  // `readinessTrendText`'s own header on why one data point renders no
  // trend at all rather than a fabricated one.
  const { history: readinessHistory, isLoading: isHistoryLoading } = useReadinessHistory();

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

        {/* -----------------------------------------------------------------
            Readiness — score, breakdown, cap, trend, recommendation, guide.
            Its own loading/error state, independent of the mastery sections
            below (see this file's own header for why).
            ----------------------------------------------------------------- */}
        <Box component="section" aria-labelledby="progress-readiness-heading" sx={{ mb: 4 }}>
          <Typography
            id="progress-readiness-heading"
            variant="overline"
            component="h2"
            color="text.secondary"
            sx={{ display: 'block' }}
          >
            Readiness
          </Typography>

          {readinessError ? (
            <Alert
              severity="error"
              sx={{ mt: 1 }}
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => void refreshReadiness()}
                >
                  Try again
                </Button>
              }
            >
              {readinessError}
            </Alert>
          ) : isReadinessLoading ? (
            <Box role="status" aria-live="polite" aria-label="Loading readiness">
              <LoadingSpinner />
            </Box>
          ) : readiness ? (
            <>
              <ReadinessScoreDial score={readiness.score} stage={readiness.stage} />

              {/* The trend — silently omitted with fewer than two points or
                  while history is still loading, never a fabricated single-
                  point direction. */}
              {!isHistoryLoading &&
                (() => {
                  const previousScore = findPreviousReadinessScore(readiness, readinessHistory);
                  const trend = readinessTrendText(readiness.score, previousScore);
                  return trend ? (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                      {trend}
                    </Typography>
                  ) : null;
                })()}

              <Box sx={{ mt: 3 }}>
                <ReadinessBreakdown
                  components={readiness.components}
                  evidenceCounts={readiness.evidenceCounts}
                />
              </Box>

              {/* "What improves this most" — always the server's own
                  `topRecommendation`, rendered verbatim. When
                  `capReason === 'typed_only'`, the API's `title`/`reason`
                  ARE §3's fixed cap sentence (`componentKey: null`), so this
                  one card is both the cap notice and the recommendation —
                  rendering the identical copy a second time in a separate
                  Alert would repeat the exact sentence rather than reinforce
                  it. */}
              <Box sx={{ mt: 3 }}>
                <Typography
                  variant="overline"
                  component="h3"
                  color="text.secondary"
                  sx={{ display: 'block' }}
                >
                  What improves this most
                </Typography>
                <Alert
                  severity={readiness.capReason === 'typed_only' ? 'info' : 'success'}
                  icon={false}
                  // A `role="status"`, not the MUI default `"alert"` — this
                  // card is standing content on page load, not a transient,
                  // assertively-announced error. The unfinished-plan notice
                  // above (`!testVersionCode`) makes the identical override
                  // for the identical reason.
                  role="status"
                  sx={{ mt: 1 }}
                >
                  <AlertTitle sx={{ fontWeight: 600 }}>
                    {readiness.topRecommendation.title}
                  </AlertTitle>
                  <Typography variant="body2">{readiness.topRecommendation.reason}</Typography>
                  <Button
                    component={RouterLink}
                    to={readiness.topRecommendation.path}
                    size="small"
                    variant="outlined"
                    color="inherit"
                    sx={{ mt: 1.5 }}
                  >
                    Go
                  </Button>
                </Alert>
              </Box>

              {/* The Progress Guide — absent is silent, never an error
                  state (`docs/specs/readiness-model.md` §9). */}
              {readiness.narrative && (
                <Box sx={{ mt: 3 }}>
                  <Typography
                    variant="overline"
                    component="h3"
                    color="text.secondary"
                    sx={{ display: 'block' }}
                  >
                    Progress Guide
                  </Typography>
                  <Box
                    component="blockquote"
                    sx={{
                      m: 0,
                      mt: 1,
                      pl: 2,
                      borderLeft: '4px solid',
                      borderColor: 'primary.main',
                    }}
                  >
                    <Typography sx={{ fontStyle: 'italic', maxWidth: '65ch' }}>
                      {readiness.narrative}
                    </Typography>
                  </Box>
                </Box>
              )}
            </>
          ) : null}
        </Box>

        <Divider aria-hidden sx={{ mb: 3 }} />

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

        <TrustFooter />
      </Box>
    </Container>
  );
}

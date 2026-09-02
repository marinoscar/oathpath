/**
 * Learn (`/learn`) — the first real learner screen in the product.
 *
 * Issue #121, epic #51. This replaces the designed empty state #69 shipped
 * (`components/journey/DestinationEmptyState`), which existed so the rail would
 * never be a promise the router breaks. #111 gave the API a read surface over
 * the whole question bank, resolved for the caller's own state; this page is
 * what displays it.
 *
 * It is `VISION.md`'s learning progression at step one — **See it → Understand
 * it** — deliberately before any recall. See `FlashcardStudy` for why there is
 * no score anywhere on this screen and why that is a boundary rather than a
 * gap.
 *
 * =============================================================================
 * FOUR VIEWS, ONE ROUTE, AND THE VIEW LIVES IN THE QUERY STRING
 * =============================================================================
 *
 *   /learn                          the categories
 *   /learn?category=<id|all>        that category's questions (&page=N)
 *   /learn?q=<question id>          one question and its answers
 *   /learn?category=…&mode=study    flashcards over that deck
 *
 * The query string rather than child routes, for one specific reason: #69
 * settled the destination set, and `config/destinations.ts` maps `learn` to the
 * single prefix `/learn`. Query parameters change no route table, no
 * `DESTINATION_ROUTES` entry and nothing the route-ownership test checks, while
 * still giving every view a real URL — so the browser's Back button walks
 * question → list → categories, a question can be opened in a new tab, and a
 * learner can bookmark where they were.
 *
 * Every transition is therefore a real `<a>` produced by `RouterLink`, not an
 * `onClick` that mutates local state. That is also why `learnHref` exists in
 * one place: four surfaces build these URLs, and four hand-assembled query
 * strings is how `?category=` and `?categoryId=` end up coexisting.
 *
 * =============================================================================
 * THE TEST VERSION COMES FROM THE PROFILE. THERE IS NO PICKER.
 * =============================================================================
 *
 * `LearnerProfileContext` loaded the learner's profile ONCE for the session, so
 * this page reads `testVersionCode` from context rather than fetching it per
 * navigation. The categories route needs it because the version is in its path;
 * the question routes are NOT told it, because the API already defaults to the
 * caller's own version and a browser that "helpfully" sent the code it holds
 * would be a second copy of a decision the server owns.
 *
 * A learner with no resolved version has not finished setup rather than hit an
 * error, and is told exactly that, with the link that fixes it.
 *
 * =============================================================================
 * BREAKPOINTS
 * =============================================================================
 *
 * Mobile-first, and every responsive value on this page steps at `sm` (600px),
 * never `md`. Nothing here touches any of the five coupled gates listed in
 * `CLAUDE.md` — this page only agrees with them.
 */

import { Alert, Box, Button, Container, Divider, Stack, Typography } from '@mui/material';
import StyleOutlinedIcon from '@mui/icons-material/StyleOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';

import { useLearnerProfile } from '../contexts/LearnerProfileContext';
import { useCivicsCategories } from '../hooks/useCivicsCategories';
import { useCivicsDeck } from '../hooks/useCivicsDeck';
import { useCivicsQuestion } from '../hooks/useCivicsQuestion';
import { useCivicsQuestions } from '../hooks/useCivicsQuestions';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { CategoryList } from '../components/civics/CategoryList';
import { FlashcardStudy } from '../components/civics/FlashcardStudy';
import { QuestionDetail } from '../components/civics/QuestionDetail';
import { QuestionList } from '../components/civics/QuestionList';
// The same `/settings/journey` page `StateRequiredNotice` links to. Imported
// rather than re-spelled: two literals for one destination is how one of them
// survives a route rename.
import { SET_STATE_PATH as PLAN_PATH } from '../components/civics/StateRequiredNotice';

/** The one place `/learn`'s query parameters are spelled. */
const PARAM = {
  category: 'category',
  page: 'page',
  question: 'q',
  mode: 'mode',
} as const;

/** `?category=all` — every question in the learner's version, unfiltered. */
const ALL_CATEGORIES = 'all';

/** Matches the API's own default, so page 1 holds what the server would send. */
const LIST_PAGE_SIZE = 20;

interface LearnHrefParams {
  category?: string | null;
  page?: number | null;
  question?: string | null;
  study?: boolean;
}

/**
 * Builds a `/learn` URL. Absent and default values are OMITTED, so the plain
 * category list is `/learn` and page 1 is not `?page=1` — a URL that carries
 * its defaults invites two spellings of the same place, and the Back button
 * then walks through both.
 */
export function learnHref({
  category,
  page,
  question,
  study,
}: LearnHrefParams): string {
  const params = new URLSearchParams();
  if (category) params.set(PARAM.category, category);
  if (page && page > 1) params.set(PARAM.page, String(page));
  if (question) params.set(PARAM.question, question);
  if (study) params.set(PARAM.mode, 'study');
  const query = params.toString();
  return query ? `/learn?${query}` : '/learn';
}

export default function LearnPage() {
  const {
    profile,
    testVersions,
    states,
    isLoading: isProfileLoading,
  } = useLearnerProfile();
  const [searchParams] = useSearchParams();

  const questionId = searchParams.get(PARAM.question);
  const isStudy = searchParams.get(PARAM.mode) === 'study';
  const categoryParam = searchParams.get(PARAM.category);
  // A junk `?page=abc` reads as page 1 rather than as `NaN`, which would be
  // sent to the API and come back a 400 for a URL the learner most likely
  // edited by hand or truncated when sharing.
  const pageParam = Number.parseInt(searchParams.get(PARAM.page) ?? '1', 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const testVersionCode = profile?.testVersionCode ?? null;
  const versionLabel =
    testVersions.find((version) => version.code === testVersionCode)?.label ??
    null;

  // The learner's own state, by name. `AnswerPanel` falls back to the code the
  // server resolved against, so a lookup miss degrades to `TX` rather than to
  // a state-specific answer with no state on it.
  const stateName =
    states.find((state) => state.code === profile?.stateCode)?.name ?? null;

  const { categories, isLoading: areCategoriesLoading, error: categoriesError } =
    useCivicsCategories(testVersionCode);

  const categoryId =
    categoryParam && categoryParam !== ALL_CATEGORIES ? categoryParam : undefined;

  // Which view is on screen, in priority order. A question wins over a deck
  // wins over a list, so a URL carrying more than one of them is never
  // ambiguous.
  const view = questionId
    ? 'question'
    : isStudy
      ? 'study'
      : categoryParam
        ? 'list'
        : 'categories';

  const list = useCivicsQuestions({
    categoryId,
    page,
    pageSize: LIST_PAGE_SIZE,
    enabled: view === 'list',
  });
  const study = useCivicsDeck(categoryId, view === 'study');
  const detail = useCivicsQuestion(view === 'question' ? questionId : null);

  const currentCategory = categories.find(
    (category) => category.id === categoryParam,
  );
  const deckLabel = currentCategory?.name ?? 'All questions';

  // ---------------------------------------------------------------------------
  // The two states that are not a view at all
  // ---------------------------------------------------------------------------

  if (isProfileLoading) {
    return (
      <Container maxWidth="md">
        <LoadingSpinner />
      </Container>
    );
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: { xs: 1, sm: 2 } }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
          Learn
        </Typography>
        {versionLabel && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            The official questions for the {versionLabel}.
          </Typography>
        )}

        <Divider aria-hidden sx={{ mt: 2, mb: 3 }} />

        {/* No resolved test version. This is unfinished setup, not a failure,
            and it is said that way — with the one link that fixes it. The same
            posture `StateRequiredNotice` takes for a missing state, down to the
            polite `role="status"`: nothing has gone wrong, so nothing should
            interrupt a screen reader as though it had. */}
        {!testVersionCode ? (
          <Alert severity="info" role="status">
            We don&rsquo;t know which civics test applies to you yet, so there
            are no questions to show. Tell us your filing date in your plan and
            the questions for your test version will appear here.
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
        ) : categoriesError ? (
          <Alert severity="error">{categoriesError}</Alert>
        ) : areCategoriesLoading ? (
          <LoadingSpinner />
        ) : (
          <>
            {/* Every view but the first opens with a real link back up the
                hierarchy, in the same place, so the way out never moves. */}
            {view !== 'categories' && (
              <Button
                component={RouterLink}
                to={
                  view === 'list' || !categoryParam
                    ? learnHref({})
                    : learnHref({ category: categoryParam, page })
                }
                startIcon={<ArrowBackIcon />}
                size="small"
                sx={{ mb: 2, ml: -1 }}
              >
                {/* The label names WHERE THE LINK GOES, not where the learner
                    came from: a question opened straight from a bookmark has no
                    list behind it, and "Back to the questions" would then point
                    at the categories. */}
                {view === 'list' || !categoryParam
                  ? 'All categories'
                  : 'Back to the questions'}
              </Button>
            )}

            {view === 'categories' && (
              <>
                {/* Flashcards are one tap from the destination itself, not two.
                    Studying is what a learner came here to do, and burying the
                    entry behind "pick a category first" makes the common case
                    the longer one. `fullWidth` at `xs` because on a phone this
                    IS the primary action of the screen. */}
                <Button
                  component={RouterLink}
                  to={learnHref({ category: ALL_CATEGORIES, study: true })}
                  variant="contained"
                  startIcon={<StyleOutlinedIcon />}
                  sx={{ mb: 3, width: { xs: '100%', sm: 'auto' } }}
                >
                  Study all questions with flashcards
                </Button>

                <CategoryList
                  categories={categories}
                  hrefForCategory={(id) => learnHref({ category: id })}
                />
              </>
            )}

            {view === 'list' && (
              <>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={2}
                  sx={{
                    mb: 2,
                    alignItems: { xs: 'stretch', sm: 'center' },
                    justifyContent: 'space-between',
                  }}
                >
                  <Typography variant="h6" component="h2">
                    {deckLabel}
                  </Typography>
                  <Button
                    component={RouterLink}
                    to={learnHref({ category: categoryParam, study: true })}
                    variant="contained"
                    startIcon={<StyleOutlinedIcon />}
                  >
                    Study with flashcards
                  </Button>
                </Stack>

                {list.error ? (
                  <Alert severity="error">{list.error}</Alert>
                ) : list.isLoading ? (
                  <LoadingSpinner />
                ) : (
                  <QuestionList
                    questions={list.questions}
                    page={list.page}
                    totalPages={list.totalPages}
                    total={list.total}
                    hrefForQuestion={(id) =>
                      learnHref({
                        category: categoryParam,
                        page,
                        question: id,
                      })
                    }
                    hrefForPage={(next) =>
                      learnHref({ category: categoryParam, page: next })
                    }
                  />
                )}
              </>
            )}

            {view === 'study' &&
              (study.error ? (
                <Alert severity="error">{study.error}</Alert>
              ) : study.isLoading ? (
                <LoadingSpinner />
              ) : (
                <FlashcardStudy
                  questions={study.deck}
                  deckLabel={deckLabel}
                  stateName={stateName}
                />
              ))}

            {view === 'question' &&
              (detail.error ? (
                <Alert severity="error">{detail.error}</Alert>
              ) : detail.isLoading || !detail.question ? (
                <LoadingSpinner />
              ) : (
                <QuestionDetail
                  question={detail.question}
                  stateName={stateName}
                />
              ))}
          </>
        )}
      </Box>
    </Container>
  );
}

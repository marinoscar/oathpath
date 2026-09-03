/**
 * Practice (`/practice`) — the real destination.
 *
 * Issue #76, epic #52. This SUPERSEDES the designed empty state #69 shipped
 * here (`components/journey/DestinationEmptyState`), the same
 * superseded-not-deleted relationship `LearnPage.tsx` has with E1's `/learn`
 * stub — `docs/specs/practice-sessions.md` §12 records it explicitly, and
 * `journey-shell.md` §8.2 still describes the copy this replaces.
 *
 * Four things, in the order a learner needs them:
 *
 *  0. **Your queue** — real counts from `GET /api/practice/queue` (issue #90,
 *     epic #54 / E5 "Memory"), read as a coach's assessment rather than a
 *     dashboard: what is due or struggling, what is still new, what is
 *     mastered. Comes BEFORE any action, on purpose — see
 *     `components/practice/PracticeQueueSummary.tsx`'s own header.
 *  1. **Quick 5** — one click, one request, straight into a session. Its
 *     copy and icon are biased by the same due-or-weak count `0` shows, but
 *     it still POSTs `kind: 'quick'` unchanged (see the section below on why
 *     there is no `kind: 'review'` to request yet).
 *  2. **By category** — the sections of their own test version, each showing
 *     how many of its questions are still new (`queue.new.byCategory`).
 *  3. **Mock interview** — the way into `/practice/interviews` (issue #145,
 *     epic #57 / E8). See the section on it below.
 *  4. **Recent sessions** — what they were just doing, and the way back into it.
 *
 * =============================================================================
 * THERE IS NO `kind: 'review' | 'weak' | 'mixed'` REQUEST ON THIS PAGE
 * =============================================================================
 *
 * `PracticeSessionKind` already declares those three values
 * (`CLAUDE.md`'s "Adding a practice session kind"), but
 * `createPracticeSessionSchema` has not been widened to accept them yet, so
 * requesting one here would be a 400 the picker caused rather than the
 * coaching this page is supposed to do. Selector v2 (`mastery/selector.ts`)
 * already orders a `quick` session's questions due-first, so band 1 biases
 * its COPY toward what starting one will actually surface instead of
 * inventing a session kind the API does not yet accept. Widening the schema
 * to offer a genuine "review session" is a separate, later change.
 *
 * =============================================================================
 * QUICK 5 IS ONE CLICK, NOT A CONFIGURATION FORM
 * =============================================================================
 *
 * `POST /api/practice/sessions { kind: 'quick' }` and navigate. No count
 * picker, no difficulty selector, no "which category?" step — `plannedCount`
 * defaults to 5 server-side and is clamped down to what is actually available,
 * so "4 of 5" on the summary screen is always honest without the client
 * knowing anything about the pool.
 *
 * That matters beyond taste, because **Home's Next-up card takes this exact
 * path**. E3 re-points `interview_countdown` at `/practice` (§12), so a learner
 * following the one recommendation on their front page lands here; if starting
 * required filling in a form first, the recommendation would be a detour rather
 * than an action.
 *
 * Starting a session also closes any session still `in_progress` — server-side,
 * in the same request — which is why this button never has to ask "you already
 * have one open, what would you like to do?". There is no such state to
 * reconcile. The recent-sessions band is refreshed afterwards for the same
 * reason: a row that said "In progress" a moment ago has just become a row that
 * was left unfinished.
 *
 * =============================================================================
 * THE MOCK INTERVIEW IS ITS OWN BAND, AND ITS COPY IS A WARNING LABEL
 * =============================================================================
 *
 * Issue #145. It is a band alongside Quick 5 and By category rather than a
 * third button inside "Start practising", because it is not the same kind of
 * act: a Quick 5 is five questions with feedback after each one, and a mock
 * interview is a twenty-minute rehearsal that says nothing at all until the
 * end. Putting them side by side as peers would let a learner tap into the
 * second expecting the first.
 *
 * So the copy states the two things that make it different — it is longer than
 * five questions, and there is no feedback until it finishes — BEFORE the
 * learner commits, so the choice is deliberate. That is
 * `docs/specs/mock-interview.md` §10's rule reaching one screen further back:
 * the real interview gives no per-question signal, a rehearsal that did would
 * be coaching a learner to expect reassurance the actual event will never
 * provide, and a learner who was not told that reads its absence as the product
 * being broken.
 *
 * It links rather than POSTing. Unlike Quick 5, starting an interview needs a
 * decision first — `transcriptRetained`, §8.1's per-interview choice — and
 * `/practice/interviews` is the screen that asks for it. A one-click start here
 * would either skip the question or answer it on the learner's behalf.
 *
 * It is shown to everyone with a resolved test version, and NOT gated on the
 * journey stage. The stage gate belongs to Home's Next-up card, which is a
 * recommendation and must offer the single most useful true thing; this is a
 * menu, and a menu that hides an option a learner is entitled to choose is a
 * product deciding for them (`VISION.md`'s Product Principle 9).
 *
 * =============================================================================
 * AN EMPTY HISTORY IS AN EMPTY STATE, NEVER A FABRICATED ZERO
 * =============================================================================
 *
 * A learner with no attempts sees a sentence saying there is nothing here yet.
 * NOT a chart with a flat line, not "0% correct", not a ring at zero, and not a
 * disabled-looking dashboard implying data that has not arrived. `VISION.md`'s
 * honesty rule and `journey-shell.md` §10 are the same rule from two
 * directions: a fabricated zero is indistinguishable at a glance from a real
 * measurement, and a learner cannot tell which one they are looking at.
 *
 * The three states are kept apart all the way down from `usePracticeSessions`:
 * loading, empty, and failed are three different things to say, and only the
 * middle one is an empty state. A failed fetch renders an error with a retry —
 * never a blank page, and never a page that quietly pretends the learner has
 * never practised.
 *
 * =============================================================================
 * WHAT THIS PAGE IS NOT
 * =============================================================================
 *
 * It is not a settings surface, so `CLAUDE.md`'s Settings UI Pattern does not
 * apply: there is no `ADMIN_SECTIONS` or `USER_SETTINGS_SECTIONS` entry, no
 * `SettingsHub` binding and no permission string to mirror from a controller,
 * and adding any of them would be wrong rather than thorough.
 *
 * There is also NO NEW `DESTINATIONS` ENTRY. `/practice` has been one since E1
 * (#69), owned by `config/destinations.ts` — read that file's header for why a
 * second declaration is the exact split-brain the destination model exists to
 * prevent. The two new routes underneath it (`/practice/sessions/:id` and its
 * summary) need no entry either: `owns('/practice', …)` covers the whole
 * subtree, which is why the rail keeps highlighting Practice inside a session.
 *
 * =============================================================================
 * WIDTH AND HEADINGS
 * =============================================================================
 *
 * One `h1` ("Practice") with an `h2` on each of the five bands (Your queue,
 * Start practising, Practise one section, Mock interview, Recent sessions).
 * Mobile-first,
 * every responsive value steps at `sm` (600px), and none of `CLAUDE.md`'s five
 * coupled gates is touched — this page only agrees with them.
 */

import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Container,
  Divider,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Typography,
} from '@mui/material';
import AutorenewOutlinedIcon from '@mui/icons-material/AutorenewOutlined';
import BoltIcon from '@mui/icons-material/Bolt';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import HistoryEduOutlinedIcon from '@mui/icons-material/HistoryEduOutlined';
import { Link as RouterLink, useNavigate } from 'react-router-dom';

import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { PracticeQueueSummary } from '../components/practice/PracticeQueueSummary';
import { RecentSessions } from '../components/practice/RecentSessions';
import { INTERVIEWS_PATH } from '../components/interview/paths';
// The same `/settings/journey` page the civics state notice links to. Imported
// rather than re-spelled: two literals for one destination is how one of them
// survives a route rename.
import { SET_STATE_PATH as PLAN_PATH } from '../components/civics/StateRequiredNotice';
import { useCivicsCategories } from '../hooks/useCivicsCategories';
import { useIsMounted } from '../hooks/useIsMounted';
import { useLearnerProfile } from '../contexts/LearnerProfileContext';
import { usePracticeQueue } from '../hooks/usePracticeQueue';
import { usePracticeSessions } from '../hooks/usePracticeSessions';
import { createPracticeSession } from '../services/api';
import type { CreatePracticeSessionInput } from '../types';

export default function PracticePage() {
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const { profile, isLoading: isProfileLoading } = useLearnerProfile();

  // The learner's test version comes from the profile the context already
  // loaded ONCE for the session — never re-fetched per navigation, and never
  // sent to the practice API, which resolves it from the caller's own row.
  const testVersionCode = profile?.testVersionCode ?? null;

  const {
    categories,
    isLoading: areCategoriesLoading,
    error: categoriesError,
  } = useCivicsCategories(testVersionCode);

  const {
    sessions,
    isLoading: areSessionsLoading,
    error: sessionsError,
    refresh: refreshSessions,
  } = usePracticeSessions();

  const {
    queue,
    isLoading: isQueueLoading,
    error: queueError,
    refresh: refreshQueue,
  } = usePracticeQueue(testVersionCode);

  // Same gate `study-coach.ts`'s `recommendStudyAction` fires its `review`
  // rung on (`memory-model.md` §6) — reused here so the Quick 5 action reads
  // as the same coach as Home's Next-up card, not a second opinion. There is
  // no `kind: 'review'` this page can request (declared, unwired — see the
  // header on `PracticeQueueSummary`); selector v2 already orders a `quick`
  // session's questions due-first, so biasing the COPY toward what a Quick 5
  // will actually surface is the honest thing to do without asking the API
  // for a kind it would 400 on.
  const reviewCount = queue ? queue.due + queue.weak : 0;

  // `categoryId -> newCount`, so the "by section" list can show where
  // coverage is thinnest without a second request — `queue.new.byCategory` is
  // the exact same count `mastery/selector.ts` would draw a `category`
  // session's new questions from.
  const newCountByCategory = useMemo(
    () => new Map(queue?.new.byCategory.map((c) => [c.categoryId, c.newCount]) ?? []),
    [queue],
  );

  /** Which start is in flight — `'quick'` or a category id. */
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const start = async (input: CreatePracticeSessionInput, key: string) => {
    setStarting(key);
    setStartError(null);
    try {
      const state = await createPracticeSession(input);
      if (!isMounted()) return;
      navigate(`/practice/sessions/${state.session.id}`);
    } catch (err) {
      if (isMounted()) {
        setStartError(
          err instanceof Error
            ? err.message
            : 'A practice session could not be started.',
        );
        setStarting(null);
        // Starting closes any session that was still open, and a failed start
        // may still have changed nothing — either way the band on screen is no
        // longer known to be current, so it is re-read rather than left to
        // claim something stale.
        void refreshSessions();
      }
    }
  };

  if (isProfileLoading) {
    return (
      <Container maxWidth="md" disableGutters>
        <Box role="status" aria-live="polite" aria-label="Loading Practice">
          <LoadingSpinner />
        </Box>
      </Container>
    );
  }

  return (
    <Container maxWidth="md" disableGutters>
      <Box sx={{ py: { xs: 1, sm: 2 } }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
          Practice
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          Answer in your own words and see how it went &mdash; what matched,
          what didn&rsquo;t, and what the accepted answer was.
        </Typography>

        <Divider aria-hidden sx={{ mt: 2, mb: 3 }} />

        {/* No resolved test version: unfinished setup, not a failure, and said
            that way — with the one link that fixes it. The same posture
            `/learn` takes, down to the polite `role="status"`: nothing has gone
            wrong, so nothing should interrupt a screen reader as though it
            had. */}
        {!testVersionCode ? (
          <Alert severity="info" role="status">
            We don&rsquo;t know which civics test applies to you yet, so there
            are no questions to practise. Tell us your filing date in your plan
            and practice will open up here.
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
        ) : (
          <>
            {startError && (
              <Alert severity="error" sx={{ mb: 3 }}>
                {startError}
              </Alert>
            )}

            {/* -----------------------------------------------------------
                0. Your queue — the coach's read of the evidence, BEFORE any
                   action is offered. What actually needs doing surfaces
                   first; the Quick 5 button below is the one action that
                   already answers it.
                ----------------------------------------------------------- */}
            <Box sx={{ mb: 4 }}>
              {queueError ? (
                <Alert
                  severity="error"
                  action={
                    <Button color="inherit" size="small" onClick={() => void refreshQueue()}>
                      Try again
                    </Button>
                  }
                >
                  {queueError}
                </Alert>
              ) : isQueueLoading ? (
                <Box role="status" aria-live="polite" aria-label="Loading your queue">
                  <LoadingSpinner />
                </Box>
              ) : queue && queue.total === 0 ? (
                // Honest, not fabricated: the bank itself has nothing in it
                // for this test version, which is different from "you
                // haven't attempted anything yet" (that is the `new` bucket,
                // rendered as a real, non-zero count below).
                <Alert severity="info" role="status">
                  There are no questions loaded for your test version yet.
                </Alert>
              ) : queue ? (
                <PracticeQueueSummary queue={queue} headingId="practice-queue-heading" />
              ) : null}
            </Box>

            {/* -----------------------------------------------------------
                1. Quick 5 — the one prominent action on this page. Its copy
                   and icon follow `reviewCount` (`queue.due + queue.weak`)
                   because selector v2 already orders a `quick` session
                   due-first — the button still POSTs `kind: 'quick'`
                   unchanged, only what it SAYS adapts to what it will
                   actually surface.
                ----------------------------------------------------------- */}
            <Box component="section" aria-labelledby="practice-quick-heading">
              <Typography
                id="practice-quick-heading"
                variant="overline"
                component="h2"
                color="text.secondary"
                sx={{ display: 'block' }}
              >
                Start practising
              </Typography>
              <Typography color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
                {reviewCount > 0
                  ? `Five questions, due and struggling ones first — you have ${reviewCount} of those waiting.`
                  : "Five questions from across your test, chosen for you — ones you haven't seen yet come first."}
              </Typography>
              <Button
                variant="contained"
                size="large"
                startIcon={reviewCount > 0 ? <AutorenewOutlinedIcon /> : <BoltIcon />}
                onClick={() => void start({ kind: 'quick' }, 'quick')}
                disabled={starting !== null}
                // Full width on a phone, where this IS the action of the
                // screen; its own width from `sm` up, where a stretched
                // primary button reads as the only thing to do here.
                sx={{ mt: 2, width: { xs: '100%', sm: 'auto' } }}
              >
                {starting === 'quick'
                  ? 'Starting…'
                  : reviewCount > 0
                    ? 'Review now'
                    : 'Start a Quick 5'}
              </Button>
            </Box>

            {/* -----------------------------------------------------------
                2. By category.
                ----------------------------------------------------------- */}
            <Box
              component="section"
              aria-labelledby="practice-categories-heading"
              sx={{ mt: 4 }}
            >
              <Typography
                id="practice-categories-heading"
                variant="overline"
                component="h2"
                color="text.secondary"
                sx={{ display: 'block' }}
              >
                Practise one section
              </Typography>

              {categoriesError ? (
                <Alert severity="error" sx={{ mt: 1 }}>
                  {categoriesError}
                </Alert>
              ) : areCategoriesLoading ? (
                <LoadingSpinner />
              ) : categories.length === 0 ? (
                <Typography color="text.secondary" sx={{ mt: 1 }}>
                  There are no sections to practise in your test version yet.
                </Typography>
              ) : (
                // Buttons, not links, and deliberately: each one POSTs a new
                // session and lands on a URL that does not exist until the
                // server has created it. An `<a href>` here would be a promise
                // the router could not keep on a middle-click.
                //
                // The server's order is preserved and never sorted — the
                // official categories are not alphabetical (Government
                // precedes History precedes Integrated Civics), and a
                // well-meant `localeCompare` here would quietly renumber the
                // exam.
                <List disablePadding sx={{ mt: 1 }}>
                  {categories.map((category) => {
                    // Where the queue data has a natural place to land: the
                    // same `new.byCategory` breakdown `PracticeQueueSummary`
                    // reads from, one count per section, so a learner can see
                    // where coverage is thinnest without a second screen.
                    // Omitted (not "0 new") once a section has nothing left
                    // unattempted — a real, honest fact, not a discouraging
                    // zero next to a section that is actually done.
                    const newCount = newCountByCategory.get(category.id) ?? 0;
                    const secondary =
                      starting === category.id
                        ? 'Starting…'
                        : newCount > 0
                          ? `${category.section} · ${newCount} new`
                          : category.section;

                    return (
                      <ListItem key={category.id} disablePadding>
                        <ListItemButton
                          onClick={() =>
                            void start(
                              { kind: 'category', categoryId: category.id },
                              category.id,
                            )
                          }
                          disabled={starting !== null}
                          sx={{ borderRadius: 1 }}
                        >
                          <ListItemText primary={category.name} secondary={secondary} />
                          <ChevronRightIcon color="action" />
                        </ListItemButton>
                      </ListItem>
                    );
                  })}
                </List>
              )}
            </Box>

            {/* -----------------------------------------------------------
                3. Mock interview — a LINK, not a POST, and copy that says
                   what it is before the learner commits to twenty minutes
                   of it. See the header.
                ----------------------------------------------------------- */}
            <Box
              component="section"
              aria-labelledby="practice-interview-heading"
              sx={{ mt: 4 }}
            >
              <Typography
                id="practice-interview-heading"
                variant="overline"
                component="h2"
                color="text.secondary"
                sx={{ display: 'block' }}
              >
                Mock interview
              </Typography>
              <Typography color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
                A rehearsal of the interview itself, with an officer who asks
                and moves on. It runs longer than five questions and tells you
                nothing until it finishes &mdash; the real one doesn&rsquo;t
                either. Worth choosing when you have a quiet stretch of time.
              </Typography>
              <Button
                component={RouterLink}
                to={INTERVIEWS_PATH}
                variant="outlined"
                size="large"
                startIcon={<HistoryEduOutlinedIcon />}
                // Its own width from `sm` up. Full width on a phone, where a
                // half-width secondary action beside nothing reads as broken —
                // but `outlined`, never `contained`: Quick 5 above is the
                // action of this screen, and two filled buttons would be the
                // page failing to say which.
                sx={{ mt: 2, width: { xs: '100%', sm: 'auto' } }}
              >
                Start a mock interview
              </Button>
            </Box>

            {/* -----------------------------------------------------------
                4. Recent sessions.
                ----------------------------------------------------------- */}
            <Box sx={{ mt: 4 }}>
              {sessionsError ? (
                <Alert
                  severity="error"
                  action={
                    <Button
                      color="inherit"
                      size="small"
                      onClick={() => void refreshSessions()}
                    >
                      Try again
                    </Button>
                  }
                >
                  {sessionsError}
                </Alert>
              ) : areSessionsLoading ? (
                <LoadingSpinner />
              ) : sessions.length === 0 ? (
                <Box component="section" aria-labelledby="practice-recent-heading">
                  <Typography
                    id="practice-recent-heading"
                    variant="overline"
                    component="h2"
                    color="text.secondary"
                    sx={{ display: 'block' }}
                  >
                    Recent sessions
                  </Typography>
                  {/* The honest empty state. No chart, no zero, no ring. */}
                  <Typography color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
                    You haven&rsquo;t practised yet. Once you do, your recent
                    sessions show up here so you can pick up where you left off.
                  </Typography>
                </Box>
              ) : (
                <RecentSessions
                  sessions={sessions}
                  headingId="practice-recent-heading"
                />
              )}
            </Box>
          </>
        )}
      </Box>
    </Container>
  );
}

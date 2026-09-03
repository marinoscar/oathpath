/**
 * Home (`/`) — the journey.
 *
 * Issue #74, epic #50, from `docs/specs/journey-shell.md` §9 and its two
 * mockups (`journey-shell/home-{360,600}.svg`).
 *
 * =============================================================================
 * WHAT THIS PAGE REPLACED, AND WHY
 * =============================================================================
 *
 * Until this issue Home was the starter template's dashboard: a
 * `UserProfileCard` and the `QuickActions` shortcut grid. It told a learner
 * their own display name and offered them their settings — and answered none of
 * the three questions `VISION.md` says the home screen must answer every time it
 * opens: *Where am I? What should I do next? Am I becoming more ready?*
 *
 * It is also the screen a learner lands on the instant orientation finishes, so
 * it was the first thing the product said after asking six personal questions.
 *
 * Both components came OFF this page, and because this page was their only
 * mount point they were rendered nowhere afterwards. Issue #188 deleted them
 * rather than carry live, tested, unmounted code whose green suites gave no
 * signal that nothing shipped them; `git log -- apps/web/src/components/home`
 * has them if they are ever wanted back.
 *
 * Deleting them cost nothing because every destination they offered stays
 * reachable. The profile card's content lives on `/settings/profile`, and the
 * identity it displayed (name, email, avatar) is in the AppBar's user menu on
 * every screen. The shortcut grid's two targets were `SETTINGS_DESTINATION` and
 * `CONSOLE_DESTINATION`: the first is the user menu's one navigation row, the
 * second is `RAIL_PINNED_DESTINATIONS`, which the navigation rail draws. That
 * is asserted, not asserted-by-hand: see "leaves both removed destinations
 * reachable elsewhere" in `__tests__/pages/HomePage.test.tsx`.
 *
 * =============================================================================
 * EVERY ANSWER ON THIS PAGE COMES FROM THE SERVER
 * =============================================================================
 *
 * `GET /api/journey/home` and `GET /api/journey/stages` (#65). The stage
 * registry is NOT re-declared in `apps/web/src/config` — §6 puts the one
 * declaration in the API, exactly as `notification-events.ts` and
 * `ai-model-roles.ts` do — and the Next-up card's title, reason and path are
 * rendered as they arrive, with no local table of copy keyed on `kind`. §4's
 * recommender already decided what to say; a second copy in the browser would
 * disagree with it the first time either was edited, and both would still
 * render something plausible.
 *
 * =============================================================================
 * THE HONESTY RULE (§10) IS WHY THE LOADING AND ERROR STATES LOOK LIKE THIS
 * =============================================================================
 *
 * Nothing journey-shaped renders until BOTH requests have settled. Painting a
 * stage path before the home payload arrives would show eight dots with none
 * marked; painting the Next-up card first would show a recommendation with no
 * stage to place it against. Either is a screen a learner cannot tell from a
 * finished one, which is §10's failure mode in a different costume — so
 * `useJourneyHome` keeps one loading flag over both reads and this page waits
 * for it.
 *
 * On failure the page says so and offers a retry. It does NOT fall back to a
 * local stage list or a guessed countdown: an unavailable API is a visible,
 * recoverable problem, and an invented journey is neither.
 *
 * The trust footer renders in ALL THREE states. §9.3 says "always visible on
 * Home", and it is as true while loading as it is afterwards.
 *
 * =============================================================================
 * WIDTH
 * =============================================================================
 *
 * One column at every width, in a `maxWidth="md"` container — the mockups
 * differ only in how the prose wraps. Every responsive value here steps at `sm`
 * (600px), never `md`, agreeing with the five coupled gates named in
 * `CLAUDE.md` without touching or duplicating any of them.
 *
 * =============================================================================
 * THE READINESS WIDGET (#142, epic #55 / E6) HAS ITS OWN, INDEPENDENT
 * LOADING/ERROR STATE — A DELIBERATE DEPARTURE FROM THE RULE ABOVE
 * =============================================================================
 *
 * `useJourneyHome`'s ONE combined flag exists because `home` and `stages`
 * describe one indivisible thing (§10, this file's own header above): a
 * stage path with no recommendation behind it, or vice versa, is a screen
 * that LOOKS finished but is lying. Readiness is not that — it is a third,
 * independently complete answer to a different question ("am I becoming
 * more ready?"), and folding it into the same combined flag would mean a
 * slow or unavailable readiness call blocks the stage path, the Next-up
 * card and the countdown from ever appearing, none of which readiness has
 * anything to do with. So `useReadiness`/`useReadinessHistory` are read
 * separately, and the widget renders its own compact loading/error state —
 * still gated behind the main journey load (it has no reason to appear
 * before the stage it sits beside does), but never the reverse. This is the
 * identical reasoning `ProgressPage.tsx`'s own header gives for the same
 * choice on `/progress`.
 *
 * =============================================================================
 * THE CONSISTENCY SURFACE (#138, epic #56 / E7) — THE THIRD INDEPENDENT READ
 * =============================================================================
 *
 * `ConsistencyCard` replaces E1's goal-ring placeholder with the measured
 * value §10 was always waiting for: `GET /api/engagement/summary` now reports
 * today's practice seconds, the streak and the freeze budget
 * (`docs/specs/habit-streaks.md` §4.6), so the ring reports a MEASUREMENT
 * rather than declining to. It reads through its own hook and renders its own
 * loading and error state, for the same reason the readiness widget does: a
 * slow engagement call must not hold the stage path off the screen, and a
 * failed one must leave no ring behind — an invented ring is indistinguishable
 * from a measured one, which is the half of §10 that E7 does not retire.
 *
 * The two answers sit inches apart on this page and speak DIFFERENT
 * vocabularies on purpose. Readiness answers "does the evidence indicate I am
 * becoming prepared"; the ring and the streak answer "am I consistently doing
 * the work" (`PRD.md`, `habit-streaks.md` §8). Neither borrows the other's
 * words, and a test asserts it.
 */

import { Alert, Box, Button, Container, Typography } from '@mui/material';

import { InterviewCountdown } from '../components/journey/InterviewCountdown';
import { JourneyPath } from '../components/journey/JourneyPath';
import { NextUpCard } from '../components/journey/NextUpCard';
import { TrustFooter } from '../components/journey/TrustFooter';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ConsistencyCard } from '../components/home/ConsistencyCard';
import { ReadinessWidget } from '../components/readiness/ReadinessWidget';
import { findPreviousReadinessScore } from '../components/progress/readiness';
import { useAuth } from '../contexts/AuthContext';
import { useEngagementSummary } from '../hooks/useEngagementSummary';
import { useJourneyHome } from '../hooks/useJourneyHome';
import { useReadiness } from '../hooks/useReadiness';
import { useReadinessHistory } from '../hooks/useReadinessHistory';

export default function HomePage() {
  const { user } = useAuth();
  const { home, stages, isLoading, error, refresh } = useJourneyHome();
  const {
    readiness,
    isLoading: isReadinessLoading,
    error: readinessError,
    refresh: refreshReadiness,
  } = useReadiness();
  const { history: readinessHistory } = useReadinessHistory();
  const {
    engagement,
    isLoading: isEngagementLoading,
    error: engagementError,
    refresh: refreshEngagement,
  } = useEngagementSummary();

  // A greeting, not a status. It is the only thing on this page that does not
  // come from the journey API, and it is safe to render immediately because it
  // makes no claim about the learner's progress — unlike everything below it.
  const greeting = user?.displayName
    ? `Welcome back, ${user.displayName}`
    : 'Welcome back';

  return (
    <Container maxWidth="md" disableGutters>
      {/* `<main>` already supplies `p: 3`; this is the page's own vertical
          rhythm on top of it, not its gutters. */}
      <Box sx={{ py: { xs: 1, sm: 2 } }}>
        <Typography
          variant="h4"
          component="h1"
          sx={{
            fontWeight: 600,
            // Legible rather than cramped at 360px: `h4` is 2.125rem, which
            // wraps a two-word name onto a third line on a phone.
            fontSize: { xs: '1.75rem', sm: '2.125rem' },
          }}
        >
          {greeting}
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 1, mb: { xs: 3, sm: 4 } }}>
          Here&rsquo;s where you are and what to do next.
        </Typography>

        {isLoading && (
          // A spinner, not a skeleton of the finished page: a greyed-out ring
          // and eight grey dots are precisely the "is this loaded or is this my
          // data?" ambiguity §10 is about.
          <Box role="status" aria-live="polite" aria-label="Loading your journey">
            <LoadingSpinner />
          </Box>
        )}

        {!isLoading && error && (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void refresh()}>
                Try again
              </Button>
            }
          >
            {/* The failure is named plainly and NOTHING is guessed in its
                place. A stage path drawn from a local fallback would look
                identical to a real one. */}
            We couldn&rsquo;t load your journey just now. {error}
          </Alert>
        )}

        {!isLoading && !error && home && stages && (
          <>
            <JourneyPath
              stages={stages}
              currentStageKey={home.stage}
              headingId="journey-path-heading"
            />

            {/* Its own micro loading/error state — see this file's own
                header on why it is not folded into the flag above. */}
            {isReadinessLoading ? (
              <Box
                role="status"
                aria-live="polite"
                aria-label="Loading readiness"
                sx={{ mb: { xs: 3, sm: 4 } }}
              >
                <LoadingSpinner size={28} />
              </Box>
            ) : readinessError ? (
              <Alert
                severity="error"
                sx={{ mb: { xs: 3, sm: 4 } }}
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
            ) : readiness ? (
              <ReadinessWidget
                readiness={readiness}
                previousScore={findPreviousReadinessScore(readiness, readinessHistory)}
                headingId="readiness-widget-heading"
              />
            ) : null}

            <NextUpCard
              nextAction={home.nextAction}
              headingId="next-up-heading"
            />

            <InterviewCountdown home={home} headingId="interview-heading" />

            {/* The measured goal ring, the streak and the freeze budget
                (#138, epic #56 / E7) — with its own independent loading and
                error state, for the identical reason the readiness widget
                above has one: this is a third, separately complete answer,
                and a slow engagement read must not hold the stage path, the
                Next-up card or the countdown off the screen. */}
            {isEngagementLoading ? (
              <Box
                role="status"
                aria-live="polite"
                aria-label="Loading your daily goal"
                sx={{ mb: { xs: 3, sm: 4 } }}
              >
                <LoadingSpinner size={28} />
              </Box>
            ) : engagementError ? (
              <Alert
                severity="error"
                sx={{ mb: { xs: 3, sm: 4 } }}
                action={
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => void refreshEngagement()}
                  >
                    Try again
                  </Button>
                }
              >
                {/* Named plainly, with NO ring drawn in its place. A ring
                    painted from a guess is indistinguishable from a measured
                    one — `journey-shell.md` §10's rule, which E7 satisfies by
                    measuring rather than by retiring. */}
                {engagementError}
              </Alert>
            ) : engagement ? (
              <ConsistencyCard engagement={engagement} headingId="daily-goal-heading" />
            ) : null}
          </>
        )}

        <TrustFooter />
      </Box>
    </Container>
  );
}

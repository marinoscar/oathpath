/**
 * The mock interview debrief (`/practice/interviews/:id/debrief`).
 *
 * Issue #145, epic #57 / E8. `docs/specs/mock-interview.md` §11.
 *
 * =============================================================================
 * THIS IS THE FIRST PLACE A VERDICT APPEARS, AND THE ONLY ONE
 * =============================================================================
 *
 * §10 keeps every earlier surface free of one, deliberately and structurally:
 * a turn's terminal frame carries officer text, a phase and a pacing count with
 * no outcome field; `InterviewProgress` has `civicsAsked` and `civicsPlanned`
 * and no `civicsCorrect`; `GET /api/interviews/:id` returns `debrief: null`
 * until the interview is `completed`; and `InterviewPage` imports nothing from
 * `components/practice/outcome.ts`, with a test asserting that vocabulary never
 * reaches it.
 *
 * The engine knew whether each answer was right the instant it graded it,
 * recorded it, used it to choose the next question and to run the stop rule —
 * and sent none of it. This page is where all of it lands at once. That is why
 * every band below is a fact and none of them is a characterisation.
 *
 * =============================================================================
 * NO NUMBER ON THIS PAGE WAS COMPUTED IN THE BROWSER
 * =============================================================================
 *
 * §11: "the web renders these numbers; it never computes a pass rule or a score
 * of its own". Concretely, and each is a thing this page could plausibly do and
 * does not:
 *
 *   * **The pass mark is `civics.threshold`, echoed by the API from the
 *     `civics_test_versions` row this interview was created against.** A `6` or
 *     a `12` typed anywhere in this subtree would be the exact failure the
 *     engine reads that row to avoid — "a threshold in code is a threshold that
 *     will one day disagree with the seeded data" — reintroduced one layer up.
 *     Two seeded versions with two different thresholds ship today, so it would
 *     not even be a theoretical bug. `debriefCopy.ts` owns every sentence the
 *     number appears in, and a test renders a debrief with a NON-DEFAULT
 *     threshold and requires it on screen.
 *   * **`passed` is the server's boolean**, never re-derived from `correct` and
 *     `threshold`.
 *   * **`delta` is the server's**, never `score - previousScore`.
 *   * **`capMessage` is rendered verbatim**, never re-typed from `PRD.md`.
 *
 * A test renders a debrief whose numbers are internally arbitrary — a score
 * that does not follow from its own delta, a `passed` that does not follow from
 * its own counts — and requires the page to show exactly what it was given.
 * That assertion only passes for a page that computes nothing.
 *
 * =============================================================================
 * THE COPY RULES ARE ACCEPTANCE CRITERIA (§11.1)
 * =============================================================================
 *
 * Honest about a failed civics section without being punitive: **name the
 * questions, not the person.** "These questions were missed" — never "you
 * struggled with government questions". No shaming, no faux-cheerful
 * minimising, and no exclamation marks on a failure.
 *
 * This is `VISION.md`'s Product Principle 9 ("Respect the User: Never
 * patronize, shame, or underestimate the learner") applied to the single moment
 * in this product most likely to tempt a shortcut into either false comfort or
 * unearned bluntness. A failed mock interview is real, useful information; the
 * debrief's job is to state it plainly and point at what to do next, not to
 * soften it into vagueness or sharpen it into judgment.
 *
 * The sentences all live in `components/interview/debriefCopy.ts` so they can
 * be read as a table and tested as one, and `InterviewDebriefPage.test.tsx`
 * asserts the failure copy contains none of the second-person-judgment
 * vocabulary, against a list the test derives explicitly with `VISION.md` cited
 * beside it.
 *
 * =============================================================================
 * A `debrief` OF NULL IS NOT AN ERROR
 * =============================================================================
 *
 * It means the interview is still in progress, and the honest response is to
 * send the learner back into it rather than to show them a broken result screen
 * or an error they cannot act on. `PracticeSummaryPage` makes the identical
 * move for an `in_progress` session, with `replace` so Back does not bounce
 * straight through here again.
 *
 * An `abandoned` interview can also carry a null debrief — it was never
 * completed, so nothing was computed for it. That one is not redirected
 * anywhere (there is no interview left to resume), and gets a sentence saying
 * what happened.
 *
 * =============================================================================
 * WIDTH, HEADINGS AND WHAT THIS PAGE IS NOT
 * =============================================================================
 *
 * One `h1` ("Interview debrief"), an `h2` on each band, `h3` on each question
 * and `h4` inside a question — so a screen-reader user moving by heading walks
 * result → questions → this question → its accepted answer. Every responsive
 * value steps at `sm` (600px) and none of `CLAUDE.md`'s five coupled breakpoint
 * gates is touched; this page only agrees with them.
 *
 * Not a settings surface: no `ADMIN_SECTIONS` / `USER_SETTINGS_SECTIONS` entry,
 * no `SettingsHub` binding, no permission string. And NO `destinations.ts`
 * entry — `owns('/practice', …)` already covers this whole subtree, exactly as
 * it covers `/practice/sessions/:id/summary`. §14 states the same
 * reachability-versus-content distinction: this is content within the Practice
 * destination, not a destination of its own.
 */

import {
  Alert,
  Box,
  Button,
  Container,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Link as RouterLink, Navigate, useParams } from 'react-router-dom';

import { CivicsResultPanel } from '../components/interview/CivicsResultPanel';
import { DebriefQuestion } from '../components/interview/DebriefQuestion';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { NextStep } from '../components/interview/NextStep';
import { PhaseCoverage } from '../components/interview/PhaseCoverage';
import { ReadinessMovement } from '../components/interview/ReadinessMovement';
import { SegmentResults } from '../components/interview/SegmentResults';
import { SpokenSummary } from '../components/interview/SpokenSummary';
import { TrustFooter } from '../components/journey/TrustFooter';
import {
  focusAreasIntro,
  missedQuestionsIntro,
} from '../components/interview/debriefCopy';
import {
  INTERVIEWS_PATH,
  interviewPath,
} from '../components/interview/paths';
import { formatSessionDate } from '../components/practice/outcome';
import { useInterviewDebrief } from '../hooks/useInterviewDebrief';

export default function InterviewDebriefPage() {
  const { id } = useParams<{ id: string }>();
  const { detail, isLoading, error, refresh } = useInterviewDebrief(id);

  if (isLoading) {
    return (
      <Container maxWidth="md" disableGutters>
        <Box role="status" aria-live="polite" aria-label="Loading your debrief">
          <LoadingSpinner />
        </Box>
      </Container>
    );
  }

  if (error || !detail) {
    return (
      <Container maxWidth="md" disableGutters>
        <Box sx={{ py: { xs: 1, sm: 2 } }}>
          <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
            Interview debrief
          </Typography>
          <Alert
            severity="error"
            sx={{ mt: 3 }}
            action={
              <Button color="inherit" size="small" onClick={() => void refresh()}>
                Try again
              </Button>
            }
          >
            {error ?? 'That interview could not be loaded.'}
          </Alert>
          <Button
            component={RouterLink}
            to={INTERVIEWS_PATH}
            startIcon={<ArrowBackIcon />}
            sx={{ mt: 3, ml: -1 }}
          >
            Back to mock interviews
          </Button>
        </Box>
      </Container>
    );
  }

  const { interview, debrief } = detail;

  // STILL RUNNING: there is no debrief because the interview has not finished,
  // which is not an error — it is a learner who followed a link to a debrief
  // that does not exist yet. Back into the interview, with `replace` so Back
  // does not bounce straight through here again.
  if (!debrief && interview.status === 'in_progress') {
    return <Navigate to={interviewPath(interview.id)} replace />;
  }

  const started = formatSessionDate(interview.startedAt);

  // NEVER COMPLETED, so nothing was ever computed for it. Not redirected — there
  // is no interview left to resume — and nothing is invented in place of the
  // result it never had, the same posture `PracticeSummaryPage` takes for an
  // abandoned session with no stored summary.
  if (!debrief) {
    return (
      <Container maxWidth="md" disableGutters>
        <Box sx={{ py: { xs: 1, sm: 2 } }}>
          <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
            Interview debrief
          </Typography>
          {started && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {started}
            </Typography>
          )}
          <Alert severity="info" role="status" sx={{ mt: 3 }}>
            This interview was never finished, so there is no debrief for it.
            You can start a new one whenever you have the time.
          </Alert>
          <Button
            component={RouterLink}
            to={INTERVIEWS_PATH}
            startIcon={<ArrowBackIcon />}
            sx={{ mt: 3, ml: -1 }}
          >
            Back to mock interviews
          </Button>
        </Box>
      </Container>
    );
  }

  const missedIntro = missedQuestionsIntro(debrief.civics.passed);
  const focusIntro = focusAreasIntro(debrief.focusAreas);

  // ONLY FOR AN INTERVIEW THAT CARRIED BOTH TRANSPORTS — §7's dropped-
  // connection fallback, which finishes over the text transport with the same
  // interview id. On an all-spoken run the same "Answered aloud" label on every
  // card is noise `SpokenSummary` has already said once, and on an all-typed
  // one it is a distinction with nothing to distinguish. This is presentation
  // derived from the server's own counts, never a measurement taken here.
  const mixedTransports =
    debrief.spoken.answers > 0 &&
    debrief.spoken.answers < debrief.questions.length;

  return (
    <Container maxWidth="md" disableGutters>
      <Box sx={{ py: { xs: 1, sm: 2 } }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
          Interview debrief
        </Typography>
        {started && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {started}
          </Typography>
        )}

        <Divider aria-hidden sx={{ mt: 2, mb: 3 }} />

        {/* ---------------------------------------------------------------
            1. The result, and why the section ended where it did.
            --------------------------------------------------------------- */}
        <CivicsResultPanel
          civics={debrief.civics}
          headingId="debrief-civics-heading"
        />

        {/* ---------------------------------------------------------------
            2. How the spoken half went — counted off this interview's own
               attempt rows, and absent entirely when nothing was spoken.
            --------------------------------------------------------------- */}
        {debrief.spoken.answers > 0 && (
          <Box sx={{ mt: 4 }}>
            <SpokenSummary
              spoken={debrief.spoken}
              headingId="debrief-spoken-heading"
            />
          </Box>
        )}

        {/* ---------------------------------------------------------------
            3. Where to focus — the server's own deterministic aggregation
               of category names with at least one miss. Absent, rather than
               rendered empty, when there is nothing to point at.
            --------------------------------------------------------------- */}
        {focusIntro && (
          <Box
            component="section"
            aria-labelledby="debrief-focus-heading"
            sx={{ mt: 4 }}
          >
            <Typography
              id="debrief-focus-heading"
              variant="overline"
              component="h2"
              color="text.secondary"
              sx={{ display: 'block', letterSpacing: '0.08em' }}
            >
              Where to focus
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
              {focusIntro}
            </Typography>
            <Stack component="ul" spacing={0.5} sx={{ mt: 1, m: 0, pl: 3 }}>
              {debrief.focusAreas.map((area) => (
                <Typography component="li" key={area}>
                  {area}
                </Typography>
              ))}
            </Stack>
          </Box>
        )}

        {/* ---------------------------------------------------------------
            4. Question by question — what was asked, what passed, and what
               would have been accepted.
            --------------------------------------------------------------- */}
        <Box
          component="section"
          aria-labelledby="debrief-questions-heading"
          sx={{ mt: 4 }}
        >
          <Typography
            id="debrief-questions-heading"
            variant="overline"
            component="h2"
            color="text.secondary"
            sx={{ display: 'block', letterSpacing: '0.08em' }}
          >
            Question by question
          </Typography>

          {/* Present only on a miss, and it points at the QUESTIONS — see
              `debriefCopy.ts` on why there is no congratulatory counterpart
              when the section was passed. */}
          {missedIntro && (
            <Typography color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
              {missedIntro}
            </Typography>
          )}

          {debrief.questions.length === 0 ? (
            // No civics question was reached at all — an interview ended
            // during small talk, say. Said plainly rather than left as an
            // empty list under a heading.
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              No civics questions were asked in this interview.
            </Typography>
          ) : (
            <Stack
              component="ul"
              spacing={2}
              sx={{ mt: 2, listStyle: 'none', m: 0, p: 0, pt: 2 }}
            >
              {debrief.questions.map((question) => (
                <DebriefQuestion
                  key={question.questionId}
                  question={question}
                  showInputMode={mixedTransports}
                />
              ))}
            </Stack>
          )}
        </Box>

        {/* ---------------------------------------------------------------
            5. The reading and writing tests, when this rehearsal conducted
               them (E11 §5). Absent for every text interview — where a
               rehearsal says what it did NOT include is the band below.
            --------------------------------------------------------------- */}
        {debrief.segments.length > 0 && (
          <Box sx={{ mt: 4 }}>
            <SegmentResults
              segments={debrief.segments}
              headingId="debrief-segments-heading"
            />
          </Box>
        )}

        {/* ---------------------------------------------------------------
            6. What this rehearsal covered — including, out loud, what it
               did not. §2.4.
            --------------------------------------------------------------- */}
        <Box sx={{ mt: 4 }}>
          <PhaseCoverage
            phases={debrief.phases}
            headingId="debrief-phases-heading"
          />
        </Box>

        {/* ---------------------------------------------------------------
            7. What this interview did to readiness — the server's numbers,
               rendered.
            --------------------------------------------------------------- */}
        <Box sx={{ mt: 4 }}>
          <ReadinessMovement
            readiness={debrief.readiness}
            headingId="debrief-readiness-heading"
          />
        </Box>

        {/* ---------------------------------------------------------------
            8. THE DEBRIEF ENDS ON THE ENGINE'S OWN RECOMMENDATION, not on a
               generic prompt (issue #160). `PRD.md` requires the score above
               to be explainable AND paired with a next action; the engine has
               just worked out what that action is for this learner, and the
               two links below are navigation rather than advice.
            --------------------------------------------------------------- */}
        <Box sx={{ mt: 4 }}>
          <NextStep
            readiness={debrief.readiness}
            headingId="debrief-next-heading"
          />
        </Box>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ mt: 4, alignItems: { xs: 'stretch', sm: 'center' } }}
        >
          {/* NAVIGATION, NOT A RECOMMENDATION — the recommendation is the card
              above, and it is the engine's. Both are invitations rather than
              pushes: no countdown, no streak, nothing a learner could lose,
              because `VISION.md` forbids manufacturing pressure by name and
              the screen read straight after a failed rehearsal is the one most
              tempting to sell urgency on. */}
          <Button component={RouterLink} to={INTERVIEWS_PATH} variant="outlined">
            Try another interview
          </Button>
          <Button component={RouterLink} to="/practice" variant="outlined">
            Back to Practice
          </Button>
        </Stack>

        {/* THE STANDING DISCLAIMER, on the one screen in this product that
            hands a learner a pass/fail verdict AND a readiness score in the
            same view. `VISION.md`: "Trust is not legal copy buried in
            settings. It is part of the user experience." `HomePage` and
            `ProgressPage` already carry it wherever a readiness number is
            rendered, and this page renders one — the identical component and
            the identical sentence, never a second wording of it. */}
        <TrustFooter />
      </Box>
    </Container>
  );
}

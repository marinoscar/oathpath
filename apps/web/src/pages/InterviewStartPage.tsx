/**
 * Mock interview — the start screen (`/practice/interviews`).
 *
 * Issue #140, epic #57 / E8. Two things, in the order a learner needs them:
 * what this is about to be, and the one decision they have to make before it
 * begins.
 *
 * =============================================================================
 * THE RETENTION CHOICE IS MADE HERE, ONCE, AND NEVER AGAIN
 * =============================================================================
 *
 * `transcriptRetained` is a per-interview field on `POST /api/interviews`, off
 * by default in the DTO and at the database level, and this is the only screen
 * that ever asks about it. It is asked BEFORE the interview starts because
 * there is nothing to retain yet at that moment — consenting to keep words you
 * have already said is not the same decision — and because a standing setting
 * would apply to every future interview, including one a learner starts without
 * re-checking what their prior self configured (`mock-interview.md` §8.1, §15).
 *
 * `RetentionChoice` owns the copy; see that file for which sentence comes from
 * §8.2's table and why the second one exists.
 *
 * =============================================================================
 * WHAT THIS PAGE SAYS ABOUT THE INTERVIEW, AND WHY EACH SENTENCE IS THERE
 * =============================================================================
 *
 * Three facts, all of which are surprising to someone who has only used the
 * practice screens, and all of which are better learned here than discovered
 * mid-rehearsal:
 *
 *   1. **No feedback until the end.** §10. The real interview gives no
 *      per-question signal, so neither does this — and a learner who expected
 *      one would read its absence as the product being broken.
 *   2. **It can end early, in either direction.** §4.1. The early stop is the
 *      single most structurally distinctive thing about the real civics test,
 *      and a learner who has never met it does not know the number of questions
 *      is not fixed.
 *   3. **The reading and writing tests are not in it yet.** §2.4. Said here as
 *      well as by the officer's own turns, because a learner who is told only
 *      once, mid-interview, may reasonably come away believing they rehearsed a
 *      segment they never saw.
 *
 * =============================================================================
 * WHAT THIS PAGE IS NOT
 * =============================================================================
 *
 * It is not a settings surface, so `CLAUDE.md`'s Settings UI Pattern does not
 * apply — no registry entry, no `SettingsHub` binding, no permission string to
 * mirror. And it adds NO `DESTINATIONS` entry: `owns('/practice', …)` already
 * covers this whole subtree, exactly as it covers `/practice/sessions/:id`, so
 * the rail keeps highlighting Practice inside an interview. `mock-interview.md`
 * §14 states the same reachability-versus-content distinction `CLAUDE.md` draws
 * for tabs versus destinations.
 *
 * =============================================================================
 * THE HISTORY BAND (#145) — AND WHY IT IS ON THIS SCREEN
 * =============================================================================
 *
 * This block used to say the history list "is issue #145's, not this one's:
 * `GET /api/interviews` exists and is deliberately not bound yet". It is bound
 * now, and it lives here rather than on `/practice` for the same reason
 * `RecentSessions` lives on `/practice` rather than on `/`: the place a learner
 * goes to start one of a thing is the place they expect to find the ones they
 * already did.
 *
 * §12 gives the reason the endpoint exists at all: a completed debrief has to
 * be reachable again later, because "did I do better on my second mock
 * interview than my first" is a real question this product should be able to
 * answer, and a debrief that existed only as the response to the `complete`
 * call that produced it could not answer it.
 *
 * **An empty history is an EMPTY STATE, never a fabricated zero** — no "0
 * interviews", no flat chart, no ring at zero. Loading, empty and failed stay
 * three distinct things to say, all the way down from `useInterviews`, exactly
 * as `/practice` keeps them for its own recent-sessions band: a fabricated zero
 * is indistinguishable at a glance from a real measurement, and a learner
 * cannot tell which one they are looking at.
 *
 * =============================================================================
 * WIDTH AND HEADINGS
 * =============================================================================
 *
 * One `h1` ("Mock interview") with an `h2` on each band. Mobile-first, every
 * responsive value steps at `sm` (600px), and none of `CLAUDE.md`'s five
 * coupled breakpoint gates is touched — this page only agrees with them.
 */

import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Container,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Link as RouterLink, useNavigate } from 'react-router-dom';

import { InterviewHistory } from '../components/interview/InterviewHistory';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { RetentionChoice } from '../components/interview/RetentionChoice';
import { interviewPath } from '../components/interview/paths';
import { useInterviews } from '../hooks/useInterviews';
import { useIsMounted } from '../hooks/useIsMounted';
import { createInterview } from '../services/api';

export default function InterviewStartPage() {
  const navigate = useNavigate();
  const isMounted = useIsMounted();

  // The history band's own read. It is never awaited before the start controls
  // render: starting an interview is what this screen is for, and a slow or
  // failed history read must not hold the button that does it off the screen.
  const {
    interviews,
    isLoading: areInterviewsLoading,
    error: interviewsError,
    refresh: refreshInterviews,
  } = useInterviews();

  // FALSE, and the initial value is the whole point — see the file header.
  const [transcriptRetained, setTranscriptRetained] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const handleStart = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const state = await createInterview({ transcriptRetained });
      if (!isMounted()) return;
      navigate(interviewPath(state.interview.id));
    } catch (err) {
      if (isMounted()) {
        setStartError(
          err instanceof Error
            ? err.message
            : 'This interview could not be started.',
        );
        setStarting(false);
      }
    }
  };

  return (
    <Container maxWidth="md" disableGutters>
      <Box sx={{ py: { xs: 1, sm: 2 } }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
          Mock interview
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
          A rehearsal of the interview itself &mdash; an officer asks, you
          answer, and it moves on. It is meant to feel like the real thing
          rather than like practice.
        </Typography>

        <Divider aria-hidden sx={{ mt: 2, mb: 3 }} />

        {startError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {startError}
          </Alert>
        )}

        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <Typography variant="h6" component="h2" sx={{ fontWeight: 600 }}>
            What to expect
          </Typography>

          <Stack spacing={1.5} sx={{ mt: 2, maxWidth: '60ch' }}>
            <Typography variant="body2" color="text.secondary">
              You won&rsquo;t be told how you are doing while it runs. There is
              no score, no tick and no correction between questions &mdash; the
              real interview doesn&rsquo;t give you one either. Everything comes
              at the end.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              The civics section can finish early, in either direction. An
              officer who has heard enough correct answers stops, and so does
              one who has heard enough wrong ones.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              The reading and writing tests are not part of this rehearsal yet.
              The officer will say so when it reaches them, so you know they
              exist and that you have not practised them here.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              You can end it at any point. Ending early still finishes the
              interview properly and still shows you how it went.
            </Typography>
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mt: 3 }}>
          <Typography variant="h6" component="h2" sx={{ fontWeight: 600 }}>
            Before you begin
          </Typography>

          <Box sx={{ mt: 2 }}>
            <RetentionChoice
              checked={transcriptRetained}
              onChange={setTranscriptRetained}
              disabled={starting}
            />
          </Box>
        </Paper>

        <Box sx={{ mt: 3 }}>
          <Button
            variant="contained"
            size="large"
            onClick={() => void handleStart()}
            disabled={starting}
            fullWidth={false}
          >
            {starting ? 'Starting…' : 'Start the interview'}
          </Button>
        </Box>

        {/* -----------------------------------------------------------
            The history band. Three distinct states, and only the middle
            one is an empty state — see this file's header.
            ----------------------------------------------------------- */}
        <Box sx={{ mt: 4 }}>
          {interviewsError ? (
            <Alert
              severity="error"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => void refreshInterviews()}
                >
                  Try again
                </Button>
              }
            >
              {interviewsError}
            </Alert>
          ) : areInterviewsLoading ? (
            <LoadingSpinner />
          ) : interviews.length === 0 ? (
            <Box component="section" aria-labelledby="interview-history-heading">
              <Typography
                id="interview-history-heading"
                variant="overline"
                component="h2"
                color="text.secondary"
                sx={{ display: 'block' }}
              >
                Your interviews
              </Typography>
              {/* The honest empty state. No count, no chart, no zero. */}
              <Typography color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
                You haven&rsquo;t sat a mock interview yet. Once you do, each
                one shows up here so you can read back how it went.
              </Typography>
            </Box>
          ) : (
            <InterviewHistory
              interviews={interviews}
              headingId="interview-history-heading"
            />
          )}
        </Box>

        <Button
          component={RouterLink}
          to="/practice"
          startIcon={<ArrowBackIcon />}
          sx={{ mt: 4, ml: -1 }}
        >
          Back to Practice
        </Button>
      </Box>
    </Container>
  );
}

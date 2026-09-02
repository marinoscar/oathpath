/**
 * Practice summary (`/practice/sessions/:id/summary`) — the debrief.
 *
 * Issue #79, epic #52.
 *
 * =============================================================================
 * READ FROM THE SERVER, ALWAYS. NEVER FROM NAVIGATION STATE.
 * =============================================================================
 *
 * This page fetches `GET /api/practice/sessions/:id` and renders that, exactly
 * as it would for a session finished five minutes ago or five months ago. It
 * would be one request cheaper to carry the completed session through
 * `navigate(path, { state })` from the session screen — and it would make the
 * page **blank on the one visit that matters most**: reopening it from Recent
 * sessions, from a bookmark, or after a reload, when there is no navigation
 * state at all. Issue #79 names that case directly: it must render identically
 * when revisited later.
 *
 * The same request is also what makes the debrief honest. `summary` is computed
 * by the server from the attempt rows that were actually written, and each
 * attempt carries its own frozen `answerSnapshot` — the accepted answers **as
 * they stood when that attempt was graded**. A dynamic answer changes by design
 * (`civics-content.md` §4), so a page that re-resolved answers here would
 * silently re-grade the learner's history every time an officeholder changed.
 *
 * =============================================================================
 * THREE SESSION STATES, AND ONLY ONE OF THEM HAS A TALLY
 * =============================================================================
 *
 *   * **`completed`** → the persisted `summary`, then the per-question list.
 *   * **`abandoned`** (closed because the learner started another session) →
 *     **no tally at all**, the attempts it did produce, and one sentence saying
 *     what happened. There is no stored summary for it, and computing one here
 *     from the attempts would be this page inventing a number the evidence
 *     table never recorded — the same fabrication a zero-progress chart would
 *     be on an empty `/practice`.
 *   * **`in_progress`** → not a summary at all. The learner is sent back to the
 *     session to finish it, because a "summary" of an unfinished session is a
 *     partial score presented as a result.
 *
 * =============================================================================
 * WIDTH, HEADINGS AND WHAT THIS PAGE IS NOT
 * =============================================================================
 *
 * One `h1` ("Practice summary"), `h2` on each section, `h3` on each question and
 * `h4` inside a question — so a screen-reader user moving by heading walks
 * summary → questions → this question → its answer. Every responsive value
 * steps at `sm` (600px) and none of `CLAUDE.md`'s five coupled gates is touched.
 *
 * Not a settings surface: no `ADMIN_SECTIONS` / `USER_SETTINGS_SECTIONS` entry,
 * no `SettingsHub` binding, no permission string — see `PracticeSessionPage`'s
 * header. `/practice` already owns this route through `config/destinations.ts`.
 */

import { useState } from 'react';
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
import ReplayIcon from '@mui/icons-material/Replay';
import { Link as RouterLink, Navigate, useNavigate, useParams } from 'react-router-dom';

import { AttemptReview } from '../components/practice/AttemptReview';
import { SummaryTally } from '../components/practice/SummaryTally';
import {
  formatSessionDate,
  sessionKindLabel,
} from '../components/practice/outcome';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { usePracticeSession } from '../hooks/usePracticeSession';
import { useIsMounted } from '../hooks/useIsMounted';
import { createPracticeSession } from '../services/api';

export default function PracticeSummaryPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const { detail, isLoading, error, refresh } = usePracticeSession(id);

  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  /**
   * Practise again — the SAME SHAPE of session, not a repeat of the same
   * questions.
   *
   * A `category` session starts another one in that category; anything else
   * starts a Quick 5. There is deliberately no "retry the ones I got wrong":
   * that is E5's spaced-repetition selection (`review` / `weak`), which the
   * create endpoint refuses today with a 400, and faking it here by pinning a
   * question list would produce a session whose `kind` lies about how its
   * questions were chosen.
   */
  const handlePractiseAgain = async () => {
    if (!detail) return;
    setStarting(true);
    setStartError(null);
    try {
      const started =
        detail.session.kind === 'category' && detail.session.categoryId
          ? await createPracticeSession({
              kind: 'category',
              categoryId: detail.session.categoryId,
            })
          : await createPracticeSession({ kind: 'quick' });
      if (isMounted()) navigate(`/practice/sessions/${started.session.id}`);
    } catch (err) {
      if (isMounted()) {
        setStartError(
          err instanceof Error
            ? err.message
            : 'A new practice session could not be started.',
        );
        setStarting(false);
      }
    }
  };

  if (isLoading) {
    return (
      <Container maxWidth="md" disableGutters>
        <Box role="status" aria-live="polite" aria-label="Loading your summary">
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
            Practice summary
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
            {error ?? 'That practice session could not be loaded.'}
          </Alert>
          <Button
            component={RouterLink}
            to="/practice"
            startIcon={<ArrowBackIcon />}
            sx={{ mt: 3, ml: -1 }}
          >
            Back to Practice
          </Button>
        </Box>
      </Container>
    );
  }

  const { session, attempts } = detail;

  // An unfinished session has no summary to show. Back to the session itself,
  // with `replace` so Back does not bounce straight through here again.
  if (session.status === 'in_progress') {
    return <Navigate to={`/practice/sessions/${session.id}`} replace />;
  }

  const started = formatSessionDate(session.startedAt);

  return (
    <Container maxWidth="md" disableGutters>
      <Box sx={{ py: { xs: 1, sm: 2 } }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
          Practice summary
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {sessionKindLabel(session.kind)}
          {started ? ` · ${started}` : ''}
        </Typography>

        <Divider aria-hidden sx={{ mt: 2, mb: 3 }} />

        {startError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {startError}
          </Alert>
        )}

        {session.summary ? (
          <SummaryTally summary={session.summary} headingId="summary-tally-heading" />
        ) : (
          // No stored summary: this session was closed when a later one
          // started. Its attempts are still real evidence and are still listed
          // below — what is missing is a tally, and nothing here invents one.
          <Alert severity="info" role="status">
            This session was left unfinished when you started another one, so
            there&rsquo;s no final tally for it. What you answered is still
            below.
          </Alert>
        )}

        <Typography
          variant="overline"
          component="h2"
          color="text.secondary"
          sx={{ display: 'block', mt: 4, letterSpacing: '0.08em' }}
        >
          Question by question
        </Typography>

        {attempts.length === 0 ? (
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            You didn&rsquo;t answer anything in this session.
          </Typography>
        ) : (
          <Stack
            component="ul"
            spacing={2}
            sx={{ mt: 2, listStyle: 'none', m: 0, p: 0, pt: 2 }}
          >
            {attempts.map((attempt) => (
              <AttemptReview key={attempt.id} attempt={attempt} />
            ))}
          </Stack>
        )}

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ mt: 4, alignItems: { xs: 'stretch', sm: 'center' } }}
        >
          <Button
            variant="contained"
            size="large"
            startIcon={<ReplayIcon />}
            onClick={() => void handlePractiseAgain()}
            disabled={starting}
          >
            {starting ? 'Starting…' : 'Practise again'}
          </Button>
          <Button component={RouterLink} to="/practice" variant="outlined">
            Back to Practice
          </Button>
        </Stack>
      </Box>
    </Container>
  );
}

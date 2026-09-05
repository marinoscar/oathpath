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
 * THE SESSION-END CELEBRATION (#138, epic #56 / E7) IS EARNED, OR ABSENT
 * =============================================================================
 *
 * `docs/specs/habit-streaks.md` §8: the copy is "specific and earned, derived
 * from real response fields — never a generic exclamation". So the celebration
 * reads `GET /api/engagement/summary` and hands its fields to
 * `selectCelebrationCopy` (`components/home/celebration-copy.ts`), a pure
 * function tested against a table; this page renders whatever it returns and
 * NOTHING when it returns `null`.
 *
 * The engagement read is deliberately NOT part of this page's loading gate.
 * The tally and the per-question review are what this page owes the learner,
 * and neither depends on today's minutes; blocking them behind a third request
 * would make a slow engagement summary look like a slow debrief. A celebration
 * that arrives a moment later, or not at all, costs nothing — a WRONG one, or
 * a generic one standing in for a missing measurement, is what §8 forbids.
 *
 * It also carries no readiness wording, ever (§8, `PRD.md`): consistency and
 * readiness answer two different questions and this surface only ever speaks
 * about the first.
 *
 * =============================================================================
 * THE COACH'S CLOSING WORD (#352, epic #345) IS RENDERED, NOT COMPOSED
 * =============================================================================
 *
 * `session.coachReaction` is one line in the learner's chosen coach voice
 * about how the whole session went. The server has computed it since #320 and
 * nothing rendered it for two epics, because the web's `PracticeSession` type
 * did not carry the field — so the end of a session, the most natural moment
 * for a coach to say anything, was silent.
 *
 * This page renders what it is sent and picks nothing. `null` means silence —
 * an abandoned session with no summary to react to, or a learner who has set
 * `coach.reactions` to `false` — and silence renders as NOTHING, not as an
 * empty region reserving space for a line that is never coming. There is no
 * suppression branch here: the preference became `null` once, server-side.
 *
 * In Voice mode the session screen has already SPOKEN the same string on its
 * way here, from the same response's `spokenTurn`. One selection, said and
 * shown.
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
import { SessionCelebration } from '../components/home/SessionCelebration';
import {
  countDaysPractisedThisWeek,
  selectCelebrationCopy,
} from '../components/home/celebration-copy';
import { SummaryTally } from '../components/practice/SummaryTally';
import {
  formatSessionDate,
  sessionKindLabel,
} from '../components/practice/outcome';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { useEngagementSummary } from '../hooks/useEngagementSummary';
import { usePracticeSession } from '../hooks/usePracticeSession';
import { useIsMounted } from '../hooks/useIsMounted';
import { createPracticeSession } from '../services/api';

export default function PracticeSummaryPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const { detail, isLoading, error, refresh } = usePracticeSession(id);
  // The celebration's own read (#138, epic #56 / E7). It is never awaited
  // before the debrief renders: the tally and the per-question review are
  // this page's job, and a slow or unavailable engagement summary must not
  // hold either off the screen. When it has not arrived — or failed — there
  // is simply no celebration, which is what `docs/specs/habit-streaks.md` §8
  // asks for over a sentence that would have fitted anybody.
  const { engagement } = useEngagementSummary();

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

  /**
   * The session-end celebration (§8) — SELECTED BY THE PURE FUNCTION, NEVER
   * BY THIS PAGE.
   *
   * Every input is a field of a response: today's measured seconds and the
   * server's own `goalMet`, the streak the streak engine computed, the
   * `recentDays` window, and the answered count on the summary that was
   * persisted at completion. Nothing is derived from navigation state or from
   * how long this page happened to be open.
   *
   * `null` in three cases, all of which render nothing at all: no engagement
   * summary yet (still loading, or the read failed), no stored summary (an
   * abandoned session, which has no tally either), or a session that produced
   * nothing measurable.
   */
  /**
   * The coach's line about the whole session, trimmed — or `''`.
   *
   * `''` in exactly the cases the server sends `null`: an abandoned session
   * with no stored summary to react to, and a learner who has turned
   * `coach.reactions` off. Both render nothing at all, and NEITHER is a branch
   * this page owns: suppression happened once, server-side, in
   * `toCoachReaction`. Trimmed for the same reason `AiFeedbackCard` trims its
   * own reaction — an all-whitespace string must render nothing rather than an
   * empty paragraph with margins around it.
   */
  const sessionReaction = (session.coachReaction?.text ?? '').trim();

  const celebration =
    engagement && session.summary
      ? selectCelebrationCopy({
          goalMinutes: engagement.dailyGoalMinutes,
          practiceSecondsToday: engagement.today.practiceSeconds,
          goalMetToday: engagement.today.goalMet,
          streakCurrent: engagement.streak.current,
          daysPractisedThisWeek: countDaysPractisedThisWeek(engagement.recentDays),
          sessionAnswered: session.summary.answered,
        })
      : null;

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

        {celebration && <SessionCelebration copy={celebration} />}

        {sessionReaction && (
          // THE COACH'S CLOSING WORD (#352, epic #345).
          //
          // DIRECTLY UNDER THE TALLY, for the reason `AiFeedbackCard.tsx` puts
          // an attempt's reaction directly under its verdict: the tally is the
          // verdict of the session, and the coach's line sits BESIDE that
          // judgement rather than wearing it. Above the tally it would read as
          // the result; below it, it reads as the coach's remark about the
          // result, which is what it is.
          //
          // NO icon, NO chip, NO coloured surface, and no heading — the same
          // three deliberate omissions that card makes. Anything framing it
          // would make a joke look like a system message and give the
          // personality a visual weight the numbers deliberately keep.
          //
          // `role="status"` so assistive technology announces it: it is the
          // one piece of this page that is the coach speaking rather than the
          // record reporting, and a line nobody hears is a line only sighted
          // learners get. In Voice mode the session screen has already SPOKEN
          // this same string on its way here (`PracticeSessionPage`'s
          // `handleFinish`), from the server's own `spokenTurn` — one
          // selection, rendered and said.
          <Typography
            variant="body1"
            component="p"
            role="status"
            sx={{ mt: 3, mb: 1 }}
          >
            {sessionReaction}
          </Typography>
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

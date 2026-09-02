/**
 * Practice session (`/practice/sessions/:id`) — one question at a time.
 *
 * Issue #79, epic #52. The screen where a learner **produces** an answer
 * instead of recognizing one, which is the entire reason E3 exists as its own
 * step: `/learn` (E2) is `VISION.md`'s "See it → Understand it", deliberately
 * before any recall, and this is the first place recall is asked for.
 *
 * =============================================================================
 * THE ONE CONSTRAINT THIS WHOLE SCREEN IS BUILT AROUND
 * =============================================================================
 *
 * **THE ACCEPTED ANSWERS MUST NOT BE ANYWHERE ON THIS PAGE — not in the visible
 * layout, not in a hidden element, not in a collapsed panel, not in a prefetched
 * response sitting in a state variable — until the learner has submitted,
 * skipped, or asked to see them.**
 *
 * If the answer is in the page while the learner is typing, the exercise stops
 * being recall and becomes recognition: the learner reads the answer, types it,
 * and the evidence table records that they knew it. `VISION.md` puts the cost
 * plainly — recognition is not preparation — and the damage is invisible from
 * inside the product, because every screen still looks right, every test still
 * passes, and the readiness number that comes out of E6 is computed from
 * attempts that measured nothing.
 *
 * Three things keep it true, and all three have to stay:
 *
 *  1. **The API is built for it.** `nextQuestion` is a `PracticeQuestion`:
 *     `id`, `number`, `prompt`, `categoryId`, `dynamicScope`, and nothing else.
 *     `apps/api/src/practice/dto/practice-question.dto.ts` carries a
 *     compile-time proof that no answer-shaped field can be added to it.
 *  2. **This page never asks for a question detail.** There is no
 *     `getCivicsQuestion(id)` here, and there must not be one — not "to show
 *     the category", not "to prefetch the next card", not to render a hint.
 *     That call returns the resolved answers; making it is how the answers get
 *     into the browser one render before they are earned.
 *  3. **`AttemptFeedback` cannot be rendered without a graded attempt.** It
 *     takes a `PracticeAttemptResult` and nothing else, so there is no props
 *     shape in which this page could hand it answers early. The answers reach
 *     the DOM at the same moment the attempt row exists in the database.
 *
 * A reviewer asked to "just render the answer behind a `display: none` so the
 * reveal is instant" should decline and point here: the DOM is the page, and an
 * answer a learner can find with View Source or a screen reader's browse mode
 * is an answer that is on the screen.
 *
 * =============================================================================
 * THREE WAYS TO END A QUESTION, AND WHY "SHOW ME THE ANSWER" IS ONE OF THEM
 * =============================================================================
 *
 *   * **Submit** — the cold attempt. `{ responseText, durationMs }`.
 *   * **Show me the answer** — `{ responseText?, revealed: true, durationMs }`.
 *     It still submits whatever is typed, so a learner who half-knew it is
 *     still graded on their words rather than losing them.
 *   * **Skip** — `{ skipped: true }`. Recorded, never dropped: a skip is what
 *     "I have no idea" looks like, and discarding it would leave the readiness
 *     model unable to tell a question a learner keeps avoiding from one they
 *     have never been shown.
 *
 * All three write exactly one immutable `practice_attempts` row, and all three
 * come back with `acceptedAnswers`. The API returns the answers with every
 * grade on purpose — immediate feedback in one round trip — which is why
 * `revealed` is NOT set on an ordinary submit even though the answers appear a
 * moment later.
 *
 * That distinction is worth defending, because setting `revealed: true` on
 * every submit is the obvious shortcut and it would be a quiet disaster:
 * `revealed` is how E5 learns that a correct answer was produced cold rather
 * than copied, `summary.revealed` would become equal to `summary.answered` on
 * every session ever recorded, and the signal would be gone from the evidence
 * table with nothing in the schema to notice. The flag means what its DTO says
 * it means — "the learner had the accepted answer in front of them **for this
 * question**" — and on a cold submit they did not.
 *
 * The consequence is that the self-mark control appears after **Show me the
 * answer** and not after a cold submit, because that is exactly where the API
 * accepts it (a 409 otherwise). `AttemptFeedback` explains that trade-off from
 * the other side, and says the one quiet sentence that keeps the absence from
 * looking like the product refusing to listen.
 *
 * =============================================================================
 * RELOADING MID-SESSION RESUMES FROM THE SERVER
 * =============================================================================
 *
 * Every fact on this screen comes from `GET /api/practice/sessions/:id` —
 * which question is next, how many are answered, how many were planned. Nothing
 * is carried through `navigate(..., { state })`, nothing is counted in the
 * browser, and no attempt is buffered locally. So a reload, a crash, a closed
 * tab or a second tab all resume at the same place with every recorded attempt
 * intact, and two tabs cannot disagree about the count. `usePracticeSession`'s
 * header has the full argument.
 *
 * =============================================================================
 * WHAT THIS PAGE IS NOT
 * =============================================================================
 *
 * It is not a settings surface, so `CLAUDE.md`'s Settings UI Pattern — the
 * registry entry in `ADMIN_SECTIONS` / `USER_SETTINGS_SECTIONS`, the
 * `SettingsHub` binding, the permission string mirrored from a controller —
 * does not apply to it, and adding a card for it would be wrong rather than
 * thorough. `/practice` is a BAR DESTINATION, already declared in
 * `config/destinations.ts` by E1 (#69); `owns('/practice', …)` covers this
 * route and its summary sibling with no new entry, which is why
 * `destinations.test.ts` keeps passing as these routes are added.
 *
 * =============================================================================
 * ACCESSIBILITY AND WIDTH
 * =============================================================================
 *
 * One `h1` (the destination), the question prompt as the `h2` under it, and the
 * feedback's "Accepted answer" label as the `h3` under that. The answer field
 * has a real `<label>` (MUI's `TextField label`), and it takes focus on every
 * new question so a keyboard or screen-reader user is never hunting for where
 * to type. The verdict lands inside a `role="status"` region that is MOUNTED
 * FROM THE FIRST RENDER and only ever has its contents changed — a live region
 * inserted at the same moment as its content is commonly missed entirely by
 * assistive technology.
 *
 * Mobile-first, and every responsive value steps at `sm` (600px), never `md`.
 * None of `CLAUDE.md`'s five coupled gates is touched here; this page only
 * agrees with them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Container,
  Divider,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Link as RouterLink, Navigate, useNavigate, useParams } from 'react-router-dom';

import { AttemptFeedback } from '../components/practice/AttemptFeedback';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { usePracticeSession } from '../hooks/usePracticeSession';
import { useIsMounted } from '../hooks/useIsMounted';
import {
  completePracticeSession,
  recordPracticeAttempt,
  selfMarkPracticeAttempt,
} from '../services/api';
import type {
  PracticeAttemptResult,
  PracticeProgress,
  PracticeQuestion,
  RecordPracticeAttemptInput,
} from '../types';
import { sessionKindLabel } from '../components/practice/outcome';

/** The three ways to end a question, for disabling the right control. */
type Pending = 'answer' | 'reveal' | 'skip' | 'complete' | null;

/** `/practice/sessions/:id/summary` for one id, spelled once. */
export function practiceSummaryPath(sessionId: string): string {
  return `/practice/sessions/${sessionId}/summary`;
}

export default function PracticeSessionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const { detail, isLoading, error, refresh } = usePracticeSession(id);

  // The question on screen and the count beside it. Seeded from the server's
  // answer and then advanced from each attempt result — which carries both, so
  // the count is never incremented in the browser.
  const [question, setQuestion] = useState<PracticeQuestion | null>(null);
  const [progress, setProgress] = useState<PracticeProgress | null>(null);
  const [response, setResponse] = useState('');
  const [result, setResult] = useState<PracticeAttemptResult | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selfMarkError, setSelfMarkError] = useState<string | null>(null);
  const [selfMarking, setSelfMarking] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  /** When the question on screen was first shown, for an honest `durationMs`. */
  const askedAtRef = useRef<number | null>(null);

  // Seeded from the server on load and on refresh. `detail`'s identity changes
  // only when a fetch resolves, so this does not fight the in-session
  // advancement below.
  useEffect(() => {
    if (!detail) return;
    setQuestion(detail.nextQuestion);
    setProgress(detail.progress);
    setResult(null);
    setResponse('');
  }, [detail]);

  const questionId = question?.id ?? null;

  // A new question restarts the clock and takes the focus. Both are keyed on
  // the question's id rather than on a render, so neither fires while the
  // learner is reading their feedback for the same question.
  useEffect(() => {
    askedAtRef.current = questionId ? Date.now() : null;
    if (questionId && !result) inputRef.current?.focus();
    // `result` is deliberately in the dependency list: after Next clears it,
    // the field returns and must take focus again for the next question.
  }, [questionId, result]);

  /**
   * Milliseconds from question shown to submit — or `undefined`.
   *
   * ABSENT, never `0`. `0` is a claim, and a false one: that the learner
   * answered instantly. `practice-sessions.md` §2.2 makes the same argument
   * `ai_usage_events` makes for nullable token counts.
   */
  const elapsedMs = useCallback((): number | undefined => {
    const askedAt = askedAtRef.current;
    if (askedAt === null) return undefined;
    const elapsed = Date.now() - askedAt;
    return elapsed > 0 ? elapsed : undefined;
  }, []);

  const submitAttempt = useCallback(
    async (
      input: Omit<RecordPracticeAttemptInput, 'questionId'>,
      mode: Pending,
    ) => {
      if (!id || !question) return;
      setPending(mode);
      setActionError(null);
      setSelfMarkError(null);
      try {
        const graded = await recordPracticeAttempt(id, {
          questionId: question.id,
          ...input,
        });
        if (isMounted()) setResult(graded);
      } catch (err) {
        if (isMounted()) {
          setActionError(
            err instanceof Error
              ? err.message
              : 'That answer could not be recorded.',
          );
        }
      } finally {
        if (isMounted()) setPending(null);
      }
    },
    [id, isMounted, question],
  );

  const trimmed = response.trim();

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) return;
    void submitAttempt(
      { responseText: trimmed, durationMs: elapsedMs() },
      'answer',
    );
  };

  const handleReveal = () => {
    // Whatever is typed still goes with it. A learner who wrote half the answer
    // and gave up is graded on their words, not on the blank they would have
    // submitted — and the matcher may well accept them.
    void submitAttempt(
      {
        responseText: trimmed || undefined,
        revealed: true,
        durationMs: elapsedMs(),
      },
      'reveal',
    );
  };

  const handleSkip = () => {
    // NO `responseText`, ever: a skip carrying text is a 400 server-side, and
    // rightly — storing text against `outcome: 'skipped'` would record a
    // response nobody submitted.
    void submitAttempt({ skipped: true, durationMs: elapsedMs() }, 'skip');
  };

  const handleNext = () => {
    if (!result) return;
    setQuestion(result.nextQuestion);
    setProgress(result.progress);
    setResult(null);
    setResponse('');
  };

  const handleSelfMark = async () => {
    if (!id || !result) return;
    setSelfMarking(true);
    setSelfMarkError(null);
    try {
      const updated = await selfMarkPracticeAttempt(id, result.attempt.id);
      // The SERVER'S attempt replaces ours. The verdict on screen then reads
      // `correct` / `self` because that is what was written, not because this
      // component decided the claim was granted.
      if (isMounted()) setResult({ ...result, attempt: updated });
    } catch (err) {
      if (isMounted()) {
        setSelfMarkError(
          err instanceof Error
            ? err.message
            : 'That could not be marked correct.',
        );
      }
    } finally {
      if (isMounted()) setSelfMarking(false);
    }
  };

  const handleFinish = async () => {
    if (!id) return;
    setPending('complete');
    setActionError(null);
    try {
      await completePracticeSession(id);
      if (isMounted()) navigate(practiceSummaryPath(id), { replace: true });
    } catch (err) {
      if (isMounted()) {
        setActionError(
          err instanceof Error
            ? err.message
            : 'This session could not be finished.',
        );
        setPending(null);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // The states that are not a question
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <Container maxWidth="md" disableGutters>
        <Box role="status" aria-live="polite" aria-label="Loading your session">
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
            Practice
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

  const { session } = detail;

  // A session that is no longer in progress has no question to ask and cannot
  // be completed (an abandoned one is a 409). Its summary is the honest screen
  // for it, and `replace` keeps the dead URL out of the history stack so Back
  // does not bounce straight through here again.
  if (session.status !== 'in_progress') {
    return <Navigate to={practiceSummaryPath(session.id)} replace />;
  }

  const planned = progress?.planned ?? session.plannedCount;
  const answered = result ? result.progress.answered : (progress?.answered ?? 0);
  // While a question is open it is the NEXT one; once it is graded, the count
  // is what the server just reported. Both come from persisted rows.
  const position = result ? answered : Math.min(answered + 1, planned);
  const isLastQuestion = result ? result.nextQuestion === null : false;
  const finished = !question && !result;

  return (
    <Container maxWidth="md" disableGutters>
      <Box sx={{ py: { xs: 1, sm: 2 } }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
          Practice
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {sessionKindLabel(session.kind)}
        </Typography>

        <Divider aria-hidden sx={{ mt: 2, mb: 3 }} />

        {/* Progress as TEXT first. The bar under it is decorative and
            `aria-hidden`: a progress bar with no number is unreadable to a
            screen reader, and one with a number announces the same fact
            twice. */}
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {finished
            ? `${answered} of ${planned} answered`
            : `Question ${position} of ${planned}`}
        </Typography>
        <LinearProgress
          aria-hidden
          variant="determinate"
          value={planned > 0 ? Math.min(100, (answered / planned) * 100) : 0}
          sx={{ mt: 1, mb: 3, borderRadius: 1 }}
        />

        {actionError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {actionError}
          </Alert>
        )}

        {question && (
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography
              variant="overline"
              component="p"
              color="text.secondary"
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            >
              Question {question.number}
            </Typography>
            <Typography variant="h5" component="h2" sx={{ fontWeight: 600 }}>
              {question.prompt}
            </Typography>

            {/* The form is a real `<form>` so Enter submits, which is what a
                learner typing an answer expects. */}
            <Box component="form" onSubmit={handleSubmit} sx={{ mt: 3 }}>
              <TextField
                // A REAL `<label>` — MUI's `label` prop renders one bound to
                // the input, so this is never a placeholder pretending.
                label="Your answer"
                value={response}
                onChange={(event) => setResponse(event.target.value)}
                inputRef={inputRef}
                fullWidth
                autoComplete="off"
                // Off, deliberately: the browser's spell-check and
                // autocorrect on a civics answer offer a different word than
                // the learner meant, and the matcher is comparing text.
                spellCheck={false}
                disabled={pending !== null || result !== null}
                helperText="Type it the way you would say it. Spelling and capitalisation are not judged."
              />

              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                sx={{
                  mt: 2,
                  alignItems: { xs: 'stretch', sm: 'center' },
                }}
              >
                <Button
                  type="submit"
                  variant="contained"
                  size="large"
                  disabled={!trimmed || pending !== null || result !== null}
                >
                  {pending === 'answer' ? 'Checking…' : 'Submit'}
                </Button>
                <Button
                  variant="outlined"
                  onClick={handleReveal}
                  disabled={pending !== null || result !== null}
                >
                  {pending === 'reveal' ? 'Showing…' : 'Show me the answer'}
                </Button>
                <Button
                  variant="text"
                  color="inherit"
                  onClick={handleSkip}
                  disabled={pending !== null || result !== null}
                >
                  {pending === 'skip' ? 'Skipping…' : 'Skip'}
                </Button>
              </Stack>
            </Box>
          </Paper>
        )}

        {/* MOUNTED FROM THE FIRST RENDER AND EMPTY UNTIL THERE IS A VERDICT.
            That ordering is what makes the announcement happen at all — see the
            file header — and it is also, structurally, where the accepted
            answers appear for the first time. Nothing renders into this region
            except a graded `PracticeAttemptResult`. */}
        <Box role="status" aria-live="polite" sx={{ mt: 3 }}>
          {result && (
            <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
              <AttemptFeedback
                result={result}
                onNext={isLastQuestion ? () => void handleFinish() : handleNext}
                nextLabel={
                  pending === 'complete'
                    ? 'Finishing…'
                    : isLastQuestion
                      ? 'See your summary'
                      : 'Next question'
                }
                onSelfMark={() => void handleSelfMark()}
                selfMarking={selfMarking}
                selfMarkError={selfMarkError}
              />
            </Paper>
          )}
        </Box>

        {finished && (
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6" component="h2">
              That&rsquo;s everything in this session.
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              Finish it to see how it went, question by question.
            </Typography>
            <Button
              variant="contained"
              size="large"
              onClick={() => void handleFinish()}
              disabled={pending === 'complete'}
              sx={{ mt: 3 }}
            >
              {pending === 'complete' ? 'Finishing…' : 'Finish and see your summary'}
            </Button>
          </Paper>
        )}

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

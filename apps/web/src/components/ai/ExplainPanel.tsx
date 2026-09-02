/**
 * "Explain this answer" — the streamed tutor explanation, and every state it
 * can end in.
 *
 * Issue #125, epic #53. Mounted in exactly two places today, both of which are
 * a moment where a learner has just met an answer and may not understand it:
 * `/learn`'s question detail (`components/civics/QuestionDetail`) and the
 * practice session screen, immediately after the verdict.
 *
 * =============================================================================
 * IT NEVER STARTS BY ITSELF
 * =============================================================================
 *
 * The stream begins on a press, never on mount, never on a question becoming
 * visible, and never on a verdict arriving. Each explanation is generated on
 * the LEARNER'S OWN AI KEY, so an auto-start would spend somebody's money on
 * every card they scrolled past — and `/learn` is a screen people scroll.
 * `useExplanation`'s header has the rest of that argument, including why the
 * abort signal is threaded all the way into `fetch`.
 *
 * =============================================================================
 * FOUR ENDINGS, AND THREE OF THEM ARE NOT ERRORS
 * =============================================================================
 *
 *   `complete`        the explanation is whole.
 *   `stopped`         the learner stopped it. What arrived stays on screen.
 *   `unavailable`     NO CALL WAS ATTEMPTED. Nothing is broken, nothing was
 *                     spent, and this renders the SHARED `AiNotReady` (#43) —
 *                     never an error alert, never a toast, never a spinner
 *                     that keeps spinning. Its one sentence, "this is not a
 *                     problem with your key", is the reason `/api/ai/status`
 *                     returns two flags at all, and re-writing that sentence
 *                     here is how it gets dropped.
 *   `state_required`  a state-scope question and no state on the profile. NOT
 *                     an AI fact: the remedy is a profile field, so this
 *                     renders `StateRequiredNotice` — the same component
 *                     `/learn` already shows for the same learner and the same
 *                     question. `civics-explain.service.ts` explains at length
 *                     why the API makes this its own terminal frame rather
 *                     than a fifth `unavailable` cause.
 *
 * Only `error` is an error, and it keeps whatever text arrived: those tokens
 * were really generated and really paid for.
 *
 * =============================================================================
 * `no_user_key` IS THE ONE `unavailable` CAUSE THIS COMPONENT ANSWERS ITSELF
 * =============================================================================
 *
 * `AiNotReady` says, correctly and deliberately, that nothing is wrong on the
 * learner's side. That is true of `ai_disabled`, `role_unbound` and
 * `capability_unsupported` — all three are an administrator's unfinished
 * configuration. It is NOT true of `no_user_key`, where the learner genuinely
 * has no key stored and the remedy is theirs.
 *
 * `AiNotReady` takes no prop for that distinction, and giving it one would put
 * a second, contradictory message inside the component whose whole job is the
 * first one. So this cause gets its own short alert pointing at the page that
 * fixes it, and the shared component is left saying only what it is for. In
 * practice a keyless learner is hard-blocked into `/setup/ai-key` by
 * `RequireAiKey` (#39) long before they reach this panel, so this branch is
 * the belt to that braces — but a silent panel would be the worst possible
 * answer to "why is nothing happening", and this is not free to omit.
 *
 * =============================================================================
 * ACCESSIBILITY: TWO REGIONS, AND THE REASON THEY ARE SEPARATE
 * =============================================================================
 *
 * The explanation streams into a region that is `aria-live="polite"` and
 * `aria-busy` WHILE STREAMING. Both halves matter. Without the live region a
 * screen-reader user is handed a panel that fills silently; with the live
 * region and no `aria-busy`, they are read a fragment on every token — "The
 * Const", "itution is", "the sup" — which is worse than silence.
 *
 * The terminal state is therefore announced by a SEPARATE `role="status"` line
 * that is mounted from the first render and only ever has its text changed. A
 * live region inserted at the same moment as its content is commonly missed
 * entirely, which is the same reasoning `PracticeSessionPage` gives for its own
 * verdict region.
 *
 * Everything focusable is a real `<button>`; the Stop control replaces the
 * Explain control in place, so keyboard focus never lands on a disabled node.
 */

import { useEffect } from 'react';
import { Alert, AlertTitle, Box, Button, Stack, Typography } from '@mui/material';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import CircularProgress from '@mui/material/CircularProgress';
import { Link as RouterLink } from 'react-router-dom';

import { AiNotReady } from './AiNotReady';
import { StateRequiredNotice } from '../civics/StateRequiredNotice';
import { useOptionalAiStatus } from '../../contexts/AiStatusContext';
import { useExplanation } from '../../hooks/useExplanation';

/** Where a learner stores their own AI key (`USER_SETTINGS_SECTIONS`). */
export const AI_KEY_SETTINGS_PATH = '/settings/ai';

/**
 * What `AiNotReady` calls this feature in its first line.
 *
 * Reads as "An explanation is not available yet" — a sentence about the thing
 * the learner just asked for, which is what that prop exists to make possible.
 */
const FEATURE_NAME = 'An explanation';

export interface ExplainPanelProps {
  /** The civics question to explain. The only input the endpoint takes. */
  questionId: string;

  /**
   * The button's label.
   *
   * Different on the two surfaces on purpose: after a practice verdict the
   * learner is asking "why was that the answer", while on `/learn` they are
   * asking about an answer already in front of them.
   */
  label?: string;

  /**
   * The heading level for the panel's own heading.
   *
   * Passed by the caller because only the caller knows what sits above it —
   * `h3` under `/learn`'s question, `h3` under the practice verdict. The size
   * is design and the level is semantics, exactly as `QuestionDetail` and
   * `AcceptedAnswers` treat theirs.
   */
  headingComponent?: 'h2' | 'h3' | 'h4' | 'h5';
}

export function ExplainPanel({
  questionId,
  label = 'Explain this answer',
  headingComponent = 'h3',
}: ExplainPanelProps) {
  const {
    text,
    status,
    isStreaming,
    unavailableCause,
    error,
    start,
    stop,
  } = useExplanation(questionId);

  // Optional on purpose: this panel renders inside screens that are not about
  // AI and must not blank out when the status provider is absent. See
  // `useOptionalAiStatus`.
  const aiStatus = useOptionalAiStatus();

  /**
   * The cached "your administrator has not finished" fact.
   *
   * Read BEFORE the learner presses anything, so the button can be disabled
   * with a reason instead of failing on a press. `null` (unknown, or no
   * provider) is treated as available — the endpoint is the authority, and a
   * cache that cannot be read must never remove a feature.
   */
  const systemBlocked = aiStatus?.status ? !aiStatus.status.systemReady : false;

  /**
   * The endpoint said `unavailable` for an ADMINISTRATOR-side reason.
   *
   * `no_user_key` is excluded because `AiNotReady`'s message is not true of it
   * — see the file header.
   */
  const adminUnavailable =
    status === 'unavailable' && unavailableCause !== 'no_user_key';

  /**
   * The server has just told us something the cached status disagrees with.
   *
   * Re-read it, so `AiNotReady` (which renders from the cache, not from this
   * frame) has the fact it needs and so every other AI surface on the page
   * stops offering something that will not work. Fires once per terminal
   * frame, never in a loop: `refresh` does not change `status`.
   */
  const refreshAiStatus = aiStatus?.refresh;
  useEffect(() => {
    if (adminUnavailable) void refreshAiStatus?.();
  }, [adminUnavailable, refreshAiStatus]);

  const hasStarted = status !== 'idle';
  const showBody = hasStarted;

  return (
    <Box sx={{ mt: 3 }}>
      <Typography
        variant="overline"
        component={headingComponent}
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        Still not clear?
      </Typography>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ mt: 1, alignItems: { xs: 'stretch', sm: 'center' } }}
      >
        {isStreaming ? (
          // REPLACES the Explain button rather than sitting beside it, so
          // focus never lands on a control that has just been disabled.
          <Button
            variant="outlined"
            color="inherit"
            onClick={stop}
            startIcon={<CircularProgress size={14} color="inherit" />}
          >
            Stop
          </Button>
        ) : (
          <Button
            variant="outlined"
            startIcon={<AutoAwesomeOutlinedIcon />}
            onClick={() => start()}
            // Disabled AND EXPLAINED — the alert below says why, and an
            // unexplained dead button is the thing this pair exists to avoid.
            disabled={systemBlocked}
          >
            {hasStarted && text ? 'Explain again' : label}
          </Button>
        )}
      </Stack>

      {/* The pre-press blocked state. `AiNotReady` renders nothing at all when
          the system is ready, so this is mounted for exactly the case it
          describes — and only under a real provider, which `systemBlocked`
          being true already implies.

          EXACTLY ONE `AiNotReady` PER PANEL, which is what `!adminUnavailable`
          is doing here. When the stream reports an administrator-side cause
          this component refreshes the cached status, so a moment later
          `systemBlocked` becomes true as well — and without this guard the
          same alert would render twice, once above the button and once below
          it, reading as two separate problems with the same cause. */}
      {systemBlocked && !adminUnavailable && <AiNotReady feature={FEATURE_NAME} />}

      {showBody && (
        <Box sx={{ mt: 2 }}>
          {/* THE STREAMING REGION. Polite while it fills, busy while tokens are
              still arriving. See the file header for why both are needed. */}
          <Typography
            component="div"
            variant="body1"
            aria-live="polite"
            aria-busy={isStreaming}
            aria-label="Explanation"
            sx={{
              // `pre-wrap`, so the paragraph breaks a model writes are the
              // paragraph breaks a learner reads. Never `dangerouslySetInnerHTML`
              // — this is text from a model, rendered as text.
              whiteSpace: 'pre-wrap',
              // A comfortable measure at every width; legible at 360px because
              // nothing here is fixed-width.
              lineHeight: 1.7,
            }}
          >
            {text}
          </Typography>

          {isStreaming && !text && (
            <Typography variant="body2" color="text.secondary">
              Working on it…
            </Typography>
          )}

          {/* THE TERMINAL ANNOUNCEMENT, in its own region so a screen reader is
              told the explanation finished without being read the whole thing
              a second time. Mounted with the body and only ever changed. */}
          <Typography
            role="status"
            variant="caption"
            component="p"
            color="text.secondary"
            sx={{ mt: 1 }}
          >
            {terminalNote(status)}
          </Typography>

          {status === 'state_required' && (
            <Box sx={{ mt: 2 }}>
              <StateRequiredNotice />
            </Box>
          )}

          {adminUnavailable && <AiNotReady feature={FEATURE_NAME} />}

          {status === 'unavailable' && unavailableCause === 'no_user_key' && (
            // The one cause that IS the learner's to fix. See the file header
            // for why this is not a prop on `AiNotReady`.
            <Alert severity="info" sx={{ mt: 2 }}>
              <AlertTitle>Add your AI key to see explanations</AlertTitle>
              <Typography variant="body2" sx={{ mb: 1 }}>
                Explanations are generated on your own AI key, and there
                isn&rsquo;t one saved on your account yet.
              </Typography>
              <Button
                size="small"
                variant="outlined"
                component={RouterLink}
                to={AI_KEY_SETTINGS_PATH}
              >
                Add your key
              </Button>
            </Alert>
          )}

          {status === 'error' && (
            <Alert
              severity="error"
              sx={{ mt: 2 }}
              action={
                <Button color="inherit" size="small" onClick={() => start()}>
                  Try again
                </Button>
              }
            >
              {error ?? 'That explanation could not be finished.'}
            </Alert>
          )}
        </Box>
      )}
    </Box>
  );
}

/**
 * The sentence announced when the stream ends, or `''` while it runs.
 *
 * Empty rather than "Streaming…" on purpose: the busy region above already
 * carries that fact, and a second live region repeating it turns one state
 * change into two announcements.
 */
function terminalNote(status: string): string {
  switch (status) {
    case 'complete':
      return 'Explanation finished.';
    case 'stopped':
      return 'You stopped this explanation.';
    case 'unavailable':
      return 'No explanation is available right now.';
    case 'state_required':
      return 'This answer depends on your state.';
    case 'error':
      return 'This explanation did not finish.';
    default:
      return '';
  }
}

export default ExplainPanel;

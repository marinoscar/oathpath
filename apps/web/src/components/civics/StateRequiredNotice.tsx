/**
 * "Set your state to see this answer" — the `state_required` UI state.
 *
 * Issue #121, epic #51, from `docs/specs/civics-content.md` §5.
 *
 * =============================================================================
 * THIS IS A FIRST-CLASS STATE, NOT AN ERROR, AND NOT AN EMPTY LIST
 * =============================================================================
 *
 * A `state`-scope question ("Who is the governor of your state now?") asked by
 * a learner whose plan has no state on it resolves 200, with the question
 * intact, `answers: []`, `verifiedAt: null` and
 * `answerResolution: 'state_required'`. The spec rejects the two obvious
 * alternatives BY NAME, and this component is what taking that seriously looks
 * like on screen:
 *
 *   * **Hiding the question** would show the learner fewer questions than their
 *     own test version promises, with nothing explaining the gap.
 *   * **Guessing a state** — the most common one, the alphabetically first —
 *     would hand them a specific, memorable answer that does not apply to them,
 *     with no signal that it might not. That is strictly worse than an honest
 *     "we don't know yet", because nothing downstream can tell it happened.
 *
 * So: the question is shown, the answer is not invented, the reason is stated
 * in plain language, and the fix is one link away.
 *
 * THE LINK IS A REAL `RouterLink` to `/settings/journey` — the page that edits
 * the learner's plan, including the state field this is missing. Focusable,
 * middle-clickable and correct with a keyboard, never an `onClick` on a
 * button-shaped div.
 */

import { Alert, AlertTitle, Button, Typography } from '@mui/material';
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';
import { Link as RouterLink } from 'react-router-dom';

/** Where the state actually gets set. The `Your plan` settings page (#77). */
export const SET_STATE_PATH = '/settings/journey';

export function StateRequiredNotice() {
  return (
    // `info`, not `warning` and not `error`: nothing has gone wrong and the
    // learner has done nothing incorrectly. The application simply does not
    // know something it needs, and says so.
    //
    // `role="status"` OVERRIDES MUI's DEFAULT `role="alert"`, and deliberately.
    // `JourneyProfileForm` states the reasoning for the identical case: an
    // assertive role interrupts a screen reader for something that is not a
    // fault. It also matters structurally here — on a flashcard this notice
    // lands INSIDE the polite region `FlashcardStudy` already mounts, and an
    // assertive region nested in a polite one is how the same sentence gets
    // announced twice.
    <Alert
      severity="info"
      role="status"
      icon={<PlaceOutlinedIcon fontSize="inherit" />}
    >
      <AlertTitle>Set your state to see this answer</AlertTitle>
      <Typography variant="body2" sx={{ mb: 1.5 }}>
        The answer to this question depends on where you live, and your plan
        doesn&rsquo;t say which state or territory that is yet. We won&rsquo;t
        show you another state&rsquo;s answer in its place &mdash; it
        wouldn&rsquo;t apply to you.
      </Typography>
      <Button
        component={RouterLink}
        to={SET_STATE_PATH}
        size="small"
        variant="outlined"
        color="inherit"
      >
        Set your state
      </Button>
    </Alert>
  );
}

export default StateRequiredNotice;

/**
 * `Text | Voice` — the one control, rendered on both screens that offer it.
 *
 * Issue #350, epic #345. #313 shipped this picker inside
 * `PracticeSessionPage`, where the choice could only be made after a session
 * row already existed. #350 moves the decision one screen earlier, onto
 * `/practice`, and the session screen keeps its copy for reversibility — so
 * there are now TWO places the same choice is offered and exactly one place it
 * is built.
 *
 * =============================================================================
 * IT IS TWO-VALUED, AND THE TRANSPORT IS NOT IN IT
 * =============================================================================
 *
 * `Voice` means "the best voice loop this deployment can run", never a named
 * transport. E15 adds a realtime path beside the existing turn-by-turn one, and
 * a three-way picker would ask a learner to choose between implementations they
 * have no basis to judge — and would strand a stored preference naming a role
 * an administrator later unbound. Which machinery answers "Voice" is decided
 * where the machinery lives; this control decides only whether the learner is
 * talking or typing.
 *
 * =============================================================================
 * ABSENT, NOT DISABLED — AND THAT GATE IS THE CALLER'S
 * =============================================================================
 *
 * With no `transcribe` model bound there is no Voice on this deployment, and
 * the whole group goes rather than the Voice button greying out (`voice.md`
 * §1's "hidden, not disabled" rule; `conversation-mode.md` §10's own row). The
 * condition is deliberately NOT inside this component: both callers already
 * hold `transcribeBound` for other reasons, and both mount
 * `VoiceUnavailableNotice` — which renders the explanation, and nothing at all
 * when the status has not settled — beside where this would have been. A
 * component that hid ITSELF would leave the notice and the control deciding
 * separately whether Voice exists, which is the split this file exists to
 * prevent on the other axis.
 *
 * =============================================================================
 * ACCESSIBILITY
 * =============================================================================
 *
 * The GROUP carries the accessible name: the two buttons say what they do, and
 * "How you want to answer" says what they are a choice between, which is what a
 * screen-reader user needs before either label means anything. `ToggleButton`
 * renders real `<button>`s, so Tab and Enter/Space work with nothing added.
 */

import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import MicIcon from '@mui/icons-material/Mic';

/**
 * Which control the learner is answering with.
 *
 * PRESENTATION ONLY. Nothing about a session — the questions already answered,
 * the progress counter, the attempt rows — lives in or below this value, so
 * flipping it can never lose any of them. What an attempt actually records is
 * `inputMode`, decided at submit time from whether the text in the field came
 * from the microphone.
 */
export type AnswerMode = 'text' | 'voice';

/**
 * The group's accessible name, exported so a test names it once.
 *
 * Both screens render the same string BY IMPORTING IT, which is what lets a
 * single query find the control on either one.
 */
export const ANSWER_MODE_GROUP_LABEL = 'How you want to answer';

export interface AnswerModeChoiceProps {
  /** The mode in force. Never `null` — there is no third state. */
  value: AnswerMode;
  /** The learner picked a mode. Only ever called with a DIFFERENT one. */
  onChange: (next: AnswerMode) => void;
  sx?: SxProps<Theme>;
}

export function AnswerModeChoice({ value, onChange, sx }: AnswerModeChoiceProps) {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={value}
      aria-label={ANSWER_MODE_GROUP_LABEL}
      sx={sx}
      onChange={(_event, next: AnswerMode | null) => {
        // MUI reports `null` when the already-active button is pressed again.
        // Ignored: there is no third state, and clearing the choice would leave
        // a learner with neither control on screen.
        if (next) onChange(next);
      }}
    >
      <ToggleButton value="text">
        <KeyboardIcon fontSize="small" sx={{ mr: 0.5 }} />
        Text
      </ToggleButton>
      <ToggleButton value="voice">
        <MicIcon fontSize="small" sx={{ mr: 0.5 }} />
        Voice
      </ToggleButton>
    </ToggleButtonGroup>
  );
}

export default AnswerModeChoice;

/**
 * "What you heard" — the field a dictated sentence is typed into.
 *
 * Extracted from `WritingPracticePage` (#147, epic #59 / E10) so the realtime
 * interview's writing segment (#159, epic #60 / E11) can conduct the same test
 * without forking it. Two screens, one exercise: the practice screen scores
 * through `POST /api/english/attempts`, the interview relays through
 * `POST /api/interviews/:id/realtime/tool-calls`, and everything a learner
 * touches between hearing the sentence and submitting their answer is this.
 *
 * =============================================================================
 * THE FOUR ATTRIBUTES ARE THE COMPONENT. THEY ARE NOT POLISH.
 * =============================================================================
 *
 * `autoComplete`, `autoCorrect`, `autoCapitalize` and `spellCheck` are all off,
 * ON THE REAL ELEMENT — `slotProps.htmlInput` lands them on the `<textarea>`
 * itself, where a browser reads them. The same names on the `TextField` wrapper
 * would satisfy a careless test and be ignored by every browser.
 *
 * Each one is disqualifying rather than untidy, because each silently changes
 * what is being measured. The writing test asks whether this learner can write
 * English they have only HEARD. A phone that capitalises the first word,
 * autocorrects "sitizen" to "citizen", or offers the rest of a sentence from
 * its own history is answering part of the question for them — and the score
 * that comes back is then reported as their English writing ability. A learner
 * told they are ready on the strength of their keyboard's spelling is being
 * told something false about the interview they are about to sit.
 *
 * =============================================================================
 * IT NEVER RECEIVES THE SENTENCE, AND HAS NO PROP TO PUT ONE IN
 * =============================================================================
 *
 * `docs/specs/english-test.md` §4's rule, held by shape rather than by
 * remembering: there is no `sentence` prop, no placeholder, no `title` and no
 * helper text that could carry a hint. Showing the sentence would change the
 * test from "can this learner write English they hear" to "can this learner
 * copy text", and the second says nothing useful about readiness.
 *
 * The helper text is the one sentence that IS safe to say, and it is there for
 * a reason: `english-scoring.ts` normalises case and punctuation before
 * scoring, so a learner agonising over a capital letter is spending their
 * attention on something that cannot affect the result.
 */

import { Box, Button, Stack, TextField } from '@mui/material';
import type { FormEvent } from 'react';

export interface DictationAnswerProps {
  /** What the learner has typed. */
  value: string;
  onChange: (value: string) => void;
  /** Called with the trimmed answer. Never fires while it is empty. */
  onSubmit: (value: string) => void;
  /** True while the answer is being scored. */
  pending?: boolean;
  /**
   * True once the answer is in and the field should stop accepting.
   *
   * Separate from `pending` because they are different states: `pending` is
   * "this is on its way", `submitted` is "it has been answered and there is
   * nothing more to type here".
   */
  submitted?: boolean;
  /** The submit button's label. Defaults to the practice screen's. */
  submitLabel?: string;
  /** The submit button's label while `pending`. */
  pendingLabel?: string;
}

export function DictationAnswer({
  value,
  onChange,
  onSubmit,
  pending = false,
  submitted = false,
  submitLabel = 'Check my writing',
  pendingLabel = 'Checking…',
}: DictationAnswerProps) {
  const trimmed = value.trim();
  const locked = pending || submitted;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || locked) return;
    onSubmit(trimmed);
  };

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ mt: 3 }}>
      <TextField
        // A REAL `<label>`: MUI's `label` prop renders one bound to the field,
        // never a placeholder pretending to be one.
        label="What you heard"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        fullWidth
        multiline
        minRows={2}
        disabled={locked}
        // ALL FOUR OFF, ON THE REAL ELEMENT. See the file header for why each
        // one of the four is disqualifying rather than untidy.
        slotProps={{
          htmlInput: {
            autoComplete: 'off',
            autoCorrect: 'off',
            autoCapitalize: 'off',
            spellCheck: false,
          },
        }}
        helperText="Spelling and capitalisation are not judged, so write it the way you heard it."
      />

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ mt: 2, alignItems: { xs: 'stretch', sm: 'center' } }}
      >
        <Button
          type="submit"
          variant="contained"
          size="large"
          disabled={!trimmed || locked}
        >
          {pending ? pendingLabel : submitLabel}
        </Button>
      </Stack>
    </Box>
  );
}

export default DictationAnswer;

import { z } from 'zod';

import { coachPersonaSchema } from '../../common/schemas/user-settings-namespaces.schema';

// =============================================================================
// `coachReaction` — the wire shape (issue #320, epic #305)
// =============================================================================
//
// One short line, in the voice the learner chose, about the thing that just
// happened. Attached to a `practice_attempts` row's response shape and to a
// completed session's, and stored NOWHERE.
//
// -----------------------------------------------------------------------------
// COMPUTED AT READ TIME, NEVER PERSISTED
// -----------------------------------------------------------------------------
//
// No column, no migration, no write. `docs/specs/coach-personality.md` §9 is
// the argument in full; the short version is that this is FLAVOUR, not
// judgement. The row is already the evidence record — the outcome, the grading
// method, the frozen answer snapshot — and none of that changes. Freezing a
// reaction line beside it would mean copy we may improve next month is stuck
// verbatim on every attempt answered before the edit, and a backfill of jokes
// is not a migration anybody should ever have to write.
//
// It stays consistent between the live screen and the summary re-read WITHOUT
// being stored, because `reactionLine` is a pure function of (persona, event,
// seed) and all three inputs are already frozen: the persona is the learner's
// setting, the event is derived from columns that no longer change, and the
// seed is the row's own id. See `select-line.ts`.
//
// -----------------------------------------------------------------------------
// NULLABLE, AND `null` IS A REAL ANSWER
// -----------------------------------------------------------------------------
//
// `null` means "this learner has turned reactions off" (`coach.reactions ===
// false`), and a client must render NOTHING for it — not a placeholder, not an
// empty region that reserves space for a line that is never coming. Nullable
// rather than optional for the same reason the AI-grading trio is: a value a
// client can branch on beats a missing key it has to guess about.
//
// The `persona` rides along rather than being looked up client-side, so a
// screen can style or attribute the line without holding its own copy of the
// registry — which `personas.ts`'s own header rules out.
// =============================================================================

export const coachReactionSchema = z.object({
  /**
   * The line itself. A constant drawn from `reaction-lines.ts`, never
   * interpolated with anything: no question text, no learner response, no
   * score. See that file's "NO INTERPOLATION, EVER".
   */
  text: z.string(),

  /**
   * Which voice it was said in — the learner's own resolved persona, resolved
   * server-side from `user_settings` and never from a request parameter.
   *
   * Note what determinism does and does not promise here. The line is stable
   * for a FIXED persona: the same attempt, read live and read again on the
   * summary screen, produces the same text. A learner who switches persona
   * afterwards gets the new voice on their past attempts too, and that is
   * correct rather than a violation — the reaction is computed at read time
   * precisely so that changing coaches changes the coach, not only the coach's
   * next sentence.
   *
   * The field is on the wire so a screen can attribute or style the line
   * without keeping its own copy of the registry, which `personas.ts`'s own
   * header rules out.
   */
  persona: coachPersonaSchema,
});

export type CoachReactionResponse = z.infer<typeof coachReactionSchema>;

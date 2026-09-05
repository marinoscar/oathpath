// =============================================================================
// Reaction-line selection (issue #318, epic #305 "The Coach's personality")
// =============================================================================
//
// One pure, total function: given a persona, a reaction event and a seed,
// return the line the coach says. No clock, no randomness, no I/O, no Nest.
//
// -----------------------------------------------------------------------------
// WHY IT IS DETERMINISTIC IN `seed`, AND WHY THAT IS NOT A NICETY
// -----------------------------------------------------------------------------
//
// `AiFeedbackCard.tsx` is deliberately ONE component used by both the live
// session screen and the summary review, and its own header says why: "a
// judgement that changes when you look at it again is corrosive in a way a
// missing feature is not."
//
// A reaction line is not a judgement, but a learner does not read it as a
// separate category of thing. If this function re-rolled its choice on every
// call, a learner who was told one joke about a miss live and a DIFFERENT joke
// about the same miss on the summary screen would read that as the product
// having two reactions to one event — reintroducing exactly the defect that
// component's design already prevents, on an axis its author never had to
// consider because nothing before this epic picked from more than one line for
// the same fact.
//
// The seed is the attempt id: stable, already on the row, already the thing
// that identifies "this answer" rather than "this render". Nothing is stored
// (`docs/specs/coach-personality.md` §9) precisely because nothing needs to
// be — the inputs to a deterministic function are already frozen.
//
// -----------------------------------------------------------------------------
// WHY A HAND-WRITTEN HASH RATHER THAN `crypto`
// -----------------------------------------------------------------------------
//
// FNV-1a, eight lines, no import. `crypto.createHash` would be deterministic
// too, and stronger, and neither property is wanted here: this is not a
// security decision, it is a spread decision, and making a pure content module
// import a runtime for it costs more than the eight lines. A reader can also
// verify by inspection that this returns the same number for the same string
// forever, which is the actual guarantee the paragraph above needs.
//
// -----------------------------------------------------------------------------
// WHY IT IS TOTAL
// -----------------------------------------------------------------------------
//
// An unknown persona or event returns a safe neutral line rather than
// `undefined`. The same open-set-on-the-wire discipline `outcome.ts`'s
// `outcomeDisplay` already applies: a newer server's value means something
// this build has never heard of, and rendering nothing — or worse, crashing —
// is not better than saying the one thing that is certainly true.
// =============================================================================

import { COACH_REACTION_LINES, NEUTRAL_REACTION_LINE } from './reaction-lines';
import type { CoachReactionEvent } from './reaction-lines';
import type { CoachPersona } from './personas';

/**
 * A 32-bit FNV-1a hash of `seed`.
 *
 * `>>> 0` on the way out because the multiply overflows into the sign bit and
 * a negative index is not an index.
 */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    // The FNV prime, 16777619, as the shift/add form that stays inside a
    // 32-bit integer in JavaScript. A plain `hash * 16777619` loses precision
    // above 2^53 and stops being reproducible across engines.
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }

  return hash >>> 0;
}

/**
 * The line this coach says about this event, for this attempt.
 *
 * Pure, total, and deterministic in `seed`: the same three arguments return
 * the same string forever, and different seeds spread across the cell's
 * available lines.
 *
 * @param persona the learner's resolved persona
 * @param event   what just happened
 * @param seed    a stable id for the thing being reacted to — an attempt id
 *                for an answer, a session id for a session summary. NEVER a
 *                timestamp, a render count, or anything else that differs
 *                between two reads of the same fact.
 */
export function reactionLine(
  persona: string,
  event: string,
  seed: string,
): string {
  const personaLines = COACH_REACTION_LINES[persona as CoachPersona];
  if (!personaLines) return NEUTRAL_REACTION_LINE;

  const lines = personaLines[event as CoachReactionEvent];
  if (!lines || lines.length === 0) return NEUTRAL_REACTION_LINE;

  return lines[hashSeed(seed) % lines.length];
}

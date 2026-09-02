import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  US_STATE_AND_TERRITORY_CODES,
  isValidStateOrTerritoryCode,
} from '../../common/constants/us-states.constants';

// =============================================================================
// PUT /api/civics/dynamic-answers — request body (#117, epic #51)
// =============================================================================
//
// One correction to one dynamic answer. civics-content.md §4 fixes what that
// means: the open row is CLOSED and a new one is OPENED, in one transaction.
// There is no field here that names an existing answer row, and that is the
// point — an id to update would be an in-place edit, which §4 refuses because
// `practice_attempts.answer_snapshot` (E3) must keep pointing at text a
// learner was actually shown. The address of the correction is the SLOT
// (`questionId` + `stateCode`), never a row.
//
// -----------------------------------------------------------------------------
// `sourceNote` IS REQUIRED, AND IT IS THE ONLY REQUIRED FIELD THAT COULD HAVE
// BEEN OPTIONAL
// -----------------------------------------------------------------------------
//
// The column is nullable (`civics_answers.source_note`), so nothing at the
// database level would stop an unsourced admin edit. That is exactly why the
// requirement lives here. `VISION.md`'s "OathPath owns the truth" is a promise
// a learner can check — `sourceNote` is served on the learner-facing answer —
// and an admin route that let a name be changed with no citation would make
// the runtime path the one place in this epic where provenance is optional,
// while the content-PR path (§6) demands it of every row.
//
// -----------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT ACCEPTED
// -----------------------------------------------------------------------------
//
//   * `verifiedAt` — always `Clock.now()` at write time. It records when a
//     HUMAN CONFIRMED the text, and the human is the caller, confirming now.
//     A client-supplied value would let the freshness a learner reads
//     ("current as of …") be asserted rather than earned.
//   * `sort` — the correction writes into the slot the open row already
//     occupies (see the service). Letting a caller choose is how a question
//     ends up with two simultaneously open slots, the §3.3 bug the database
//     cannot catch.
//   * `effectiveTo` — set on the closed row from `effectiveFrom`, so the two
//     rows are contiguous by construction. Two independent fields could
//     express a gap or an overlap, and §4 requires neither exist.
//   * a question `prompt`, `category` or `dynamicScope` — those are content,
//     changed by a reviewed PR and a reseed (§6–§7), out of scope for #117.
//
// `z.strictObject`, so each of the above is a 400 naming the field rather than
// a value that looked accepted and was dropped.
// =============================================================================

/**
 * A real-world instant, as `YYYY-MM-DD` or a full ISO-8601 timestamp.
 *
 * A calendar date is the common case and what a date picker sends — a Speaker
 * is sworn in on a day, not at a millisecond — and it is read as UTC midnight.
 * A precise timestamp is accepted for the case where the hour genuinely
 * matters and the citation gives one.
 *
 * Kept as a STRING here and converted in the service. Piping it to a `Date` in
 * this schema would be tidier to read and would break OpenAPI generation:
 * zod cannot represent a `Date` in JSON Schema, so the published document
 * would lose this field's shape (or fail to build) for the sake of one line.
 */
export const realWorldInstantSchema = z.union([
  z.iso.datetime({ offset: true }),
  z.iso.date(),
]);

/**
 * The same instant, converted to a `Date` for the service.
 *
 * A separate schema rather than a `.pipe()` on the one above, so the DTO the
 * OpenAPI document is generated from stays a string. It also keeps the one
 * `Date` conversion in this epic's write path inside a schema: nothing in
 * `src/civics/` constructs a `Date` directly, which is what makes
 * civics-content.md §10's grep worth running.
 */
export const realWorldInstantAsDate = realWorldInstantSchema.pipe(
  z.coerce.date(),
);

/** Generous bounds. They exist to stop abuse, not to shape legitimate content. */
const MAX_ANSWER_TEXT = 2000;
const MAX_SOURCE_NOTE = 2000;

export const updateCivicsDynamicAnswerSchema = z.strictObject({
  /**
   * The question whose answer is being corrected.
   *
   * Its `dynamicScope` is read from the database and decides everything else:
   * a `none`-scope question is a 400 (civics-content.md §9), a `national` one
   * forbids `stateCode`, a `state` one requires it. None of that can be
   * decided here, because a schema cannot see the row.
   */
  questionId: z.uuid(),

  /**
   * Which state's answer, for a `state`-scope question.
   *
   * REQUIRED for `state` scope and REJECTED for `national` — both checked in
   * the service, where the question's scope is known. Neither is silently
   * tolerated: a `stateCode` accepted and ignored on a national question would
   * let an admin believe they had corrected Ohio's copy of a national fact,
   * and a missing one on a state question would have to guess a state, which
   * §5 rejects for the learner-facing path for the same reason.
   *
   * Uppercased before validation and checked against the same 56-code constant
   * `learner_profiles.state_code` uses, so an answer cannot be written for a
   * state no learner can select.
   */
  stateCode: z
    .string()
    .trim()
    .transform((code) => code.toUpperCase())
    .refine(isValidStateOrTerritoryCode, {
      message: `stateCode must be one of the ${US_STATE_AND_TERRITORY_CODES.length} US state or territory codes`,
    })
    .optional(),

  /** The new accepted answer, verbatim. */
  text: z.string().trim().min(1).max(MAX_ANSWER_TEXT),

  /**
   * The citation this correction rests on — which official document or record
   * the new text and its effective date come from.
   *
   * Required. See the header.
   */
  sourceNote: z.string().trim().min(1).max(MAX_SOURCE_NOTE),

  /**
   * When the new answer became correct IN THE REAL WORLD.
   *
   * Optional, with `Clock.now()` as the stated fallback (§4, §9) — the honest
   * value when no precise date is knowable, e.g. correcting a transcription
   * mistake that was never true at any point. When the date IS knowable it
   * should be sent: it is the instant the previous row is closed at, so the
   * two rows meet exactly there, and it is what makes a past practice attempt
   * explicable against the answer that was correct on its own date.
   */
  effectiveFrom: realWorldInstantSchema.optional(),
});

export type UpdateCivicsDynamicAnswer = z.infer<
  typeof updateCivicsDynamicAnswerSchema
>;

export class UpdateCivicsDynamicAnswerDto extends createZodDto(
  updateCivicsDynamicAnswerSchema,
) {}

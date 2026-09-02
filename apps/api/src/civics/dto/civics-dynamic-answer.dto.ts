import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// The admin dynamic-answer surface — response bodies (#117, epic #51)
// =============================================================================
//
// Two shapes: what a `national`- or `state`-scope question looks like to an
// administrator who maintains its answer, and what one correction returns.
//
// -----------------------------------------------------------------------------
// THIS IS A DIFFERENT VIEW OF `civics_answers` FROM THE LEARNER'S ONE
// -----------------------------------------------------------------------------
//
// `civics-question.dto.ts`'s `civicsAnswerSchema` describes an answer AS
// RESOLVED FOR A CALLER: the rows correct **now**, for **that learner's**
// state, with the effective dates deliberately left off because a learner has
// no use for them.
//
// An administrator's view is the opposite on every one of those points. It is
// not per-caller (there is no "my state" on an admin screen); it lists the OPEN
// row — the one a correction will close — rather than the row a learner is
// being served this instant; and the effective dates are the whole subject of
// the page, because civics-content.md §4's lifecycle is expressed entirely in
// them.
//
// Those two facts can differ, and the difference is legitimate. A correction
// entered ahead of time (`effectiveFrom` next Tuesday) opens a row that is not
// yet what a learner is served, while the row it closed remains current until
// then. `effectiveFrom` and `effectiveTo` are on the wire here precisely so an
// admin can see that state of affairs rather than be confused by it.
//
// So: a separate schema, not an extension of the learner one. Sharing it would
// force one of the two audiences to receive fields that mean something else to
// them.
// =============================================================================

/**
 * The two scopes this surface administers.
 *
 * `none` is absent ON PURPOSE and its absence is load-bearing, not an
 * oversight — see `update-civics-dynamic-answer.dto.ts` and
 * civics-content.md §9. A static answer changes through a reviewed content PR
 * with provenance (§6–§7); an admin edit path to the same rows would be a
 * second, weaker-reviewed way to change them.
 */
export const civicsAdminScopeSchema = z.enum(['national', 'state']);

export type CivicsAdminScope = z.infer<typeof civicsAdminScopeSchema>;

/** One `civics_answers` row, as an administrator sees it. */
export const civicsDynamicAnswerSchema = z.object({
  id: z.uuid(),

  /** The accepted answer, verbatim. */
  text: z.string(),

  /**
   * Which slot this row occupies among a question's simultaneously correct
   * answers (civics-content.md §3.1).
   *
   * Always `0` for well-formed dynamic content — there is one current
   * President — and on the wire anyway because a correction writes into the
   * slot the open row already occupies, so an admin looking at a mis-loaded
   * row at slot 1 can see that is what they are looking at.
   */
  sort: z.number().int(),

  /** The state this answer is for, or null for a `national` answer. */
  stateCode: z.string().nullable(),

  /** When a human last confirmed this text against the authoritative source. */
  verifiedAt: z.iso.datetime(),

  /**
   * When this became the correct answer in the real world.
   *
   * NOT when the row was written: civics-content.md §4 requires a correction
   * to carry the sourced real-world date of the change, so the closed row and
   * the new one stay contiguous with no gap and no overlap.
   */
  effectiveFrom: z.iso.datetime(),

  /**
   * When this stopped being correct, or null for the OPEN row.
   *
   * Null is the only "is this current" signal this table has — there is no
   * `isCurrent` boolean, deliberately (civics-content.md §3).
   */
  effectiveTo: z.iso.datetime().nullable(),

  /** The citation this row's text and dates come from. */
  sourceNote: z.string().nullable(),
});

export type CivicsDynamicAnswerResponse = z.infer<
  typeof civicsDynamicAnswerSchema
>;

/** The question fields an administrator needs to recognise what they are editing. */
export const civicsDynamicAnswerQuestionSchema = z.object({
  questionId: z.uuid(),

  /** `v2008` or `v2025`. A question exists per version, and so does its answer. */
  testVersionCode: z.string(),

  /** The official question number within its version — how a reviewer names it. */
  number: z.number().int(),

  /** The question text, verbatim. */
  prompt: z.string(),

  categoryId: z.uuid(),

  dynamicScope: civicsAdminScopeSchema,
});

export const civicsDynamicAnswerItemSchema =
  civicsDynamicAnswerQuestionSchema.extend({
    /**
     * The currently OPEN row per slot — `effectiveTo IS NULL`.
     *
     * One entry for a `national` question. For a `state` question, one per
     * state that has an open answer: 56 unfiltered, or one when the request
     * narrowed to a single `stateCode`.
     *
     * Closed rows are not served here. They are never deleted (§4) and stay
     * readable for the audit trail and for E3's `answer_snapshot`, but an
     * administrator corrects the open row and only the open row.
     */
    answers: z.array(civicsDynamicAnswerSchema),

    /**
     * State codes in scope of this request that have NO open answer.
     *
     * Empty for a `national` question. For a `state` question it is the gap
     * list: unfiltered, every one of the 56 codes in
     * `US_STATES_AND_TERRITORIES` with no open row; filtered to one state,
     * either that code or nothing.
     *
     * On the wire because the gap is invisible otherwise. A learner in Wyoming
     * whose governor row was never loaded sees an unanswerable question and
     * has no way to report it; this field is how the administrator responsible
     * finds out first. It is the same designed-absence posture §5 takes for a
     * learner with no state set — state the gap plainly rather than let a
     * short list imply completeness.
     */
    missingStateCodes: z.array(z.string()),
  });

export type CivicsDynamicAnswerItem = z.infer<
  typeof civicsDynamicAnswerItemSchema
>;

export const civicsDynamicAnswerUpdateResultSchema =
  civicsDynamicAnswerQuestionSchema.extend({
    /** The state the correction applies to, or null for a `national` answer. */
    stateCode: z.string().nullable(),

    /**
     * The row that was CLOSED by this write, already carrying its new
     * `effectiveTo` — or null when the slot had no open row at all (content
     * that was never loaded for this state, the gap `missingStateCodes`
     * reports).
     *
     * Returned, rather than left for the client to have remembered, because
     * the whole point of the lifecycle is that the previous answer is not
     * destroyed. A response that showed only the new value would read exactly
     * like the in-place edit civics-content.md §4 refuses to perform.
     */
    previous: civicsDynamicAnswerSchema.nullable(),

    /** The row that was OPENED by this write. Now the current answer. */
    current: civicsDynamicAnswerSchema,
  });

export type CivicsDynamicAnswerUpdateResult = z.infer<
  typeof civicsDynamicAnswerUpdateResultSchema
>;

export class CivicsDynamicAnswerDto extends createZodDto(
  civicsDynamicAnswerSchema,
) {}

export class CivicsDynamicAnswerItemDto extends createZodDto(
  civicsDynamicAnswerItemSchema,
) {}

export class CivicsDynamicAnswerUpdateResultDto extends createZodDto(
  civicsDynamicAnswerUpdateResultSchema,
) {}

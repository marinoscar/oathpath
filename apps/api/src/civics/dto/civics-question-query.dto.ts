import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/civics/questions — query parameters (issue #111, epic #51)
// =============================================================================
//
// `page` / `pageSize` are copied field for field from
// `allowlist/dto/allowlist-query.dto.ts`, including the 1-100 bound and the
// default of 20. civics-content.md §8 requires exactly that: "using the same
// `page`/`pageSize` query-parameter shape `AllowlistController` already
// establishes rather than a second pagination convention". This API already has
// two list-body shapes (see `common/decorators/api-data-response.decorator.ts`
// on `flat` vs `nested`), which is one more than it should have; adding a third
// pagination INPUT shape on top of that is not a cost worth paying for a
// reference-content list.
//
// -----------------------------------------------------------------------------
// THERE IS NO `userId` AND NO `stateCode` HERE, AND THAT IS THE SECURITY SHAPE
// -----------------------------------------------------------------------------
//
// Resolution inputs — which learner, and which state — come from
// `@CurrentUser('id')` and that user's own `learner_profiles` row, never from
// the query string. civics-content.md §8 states it as a structural rule, and it
// is the same one `journey.controller.ts` holds to: a parameter that could name
// another learner does not exist, so there is nothing to forget to authorise.
//
// `z.strictObject` makes that checkable rather than merely true today — a
// `?stateCode=TX` is a 400, not a silently ignored parameter, so a client
// written against a misremembered contract fails loudly instead of quietly
// memorising Texas's governor.
// =============================================================================

export const civicsQuestionQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),

  /**
   * Restrict to one test version.
   *
   * **Omitting it does not mean "every version".** It falls back to the
   * caller's own `learner_profiles.test_version_code`, because a learner
   * studying the 2025 test has no use for the 2008 bank and a list mixing both
   * would show them 228 questions where their own version promises 128. Only a
   * caller whose profile has no resolved version yet — orientation not
   * finished — sees the whole bank, which is the honest answer for someone we
   * genuinely cannot narrow for.
   */
  testVersionCode: z.string().min(1).optional(),

  /** Restrict to one category, by the `id` from the categories route. */
  categoryId: z.uuid().optional(),

  /**
   * Restrict to the senior-eligible subset, or to its complement.
   *
   * An EXPLICIT filter, with no implicit default from the caller's
   * `senior_exemption`. civics-content.md §5 is emphatic that senior exemption
   * filters the question SET and never an answer, and §8 lists this as a filter
   * rather than as a personalisation — a learner claiming the 65/20
   * accommodation is still entitled to browse the full bank, and a list that
   * silently shrank to 20 questions with nothing saying why would be the same
   * unexplained gap §5 rejects for `state`-scope questions.
   */
  seniorEligible: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .optional(),
});

export type CivicsQuestionQuery = z.infer<typeof civicsQuestionQuerySchema>;

export class CivicsQuestionQueryDto extends createZodDto(
  civicsQuestionQuerySchema,
) {}

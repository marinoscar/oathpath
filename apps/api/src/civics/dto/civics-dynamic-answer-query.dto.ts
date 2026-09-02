import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  US_STATE_AND_TERRITORY_CODES,
  isValidStateOrTerritoryCode,
} from '../../common/constants/us-states.constants';
import { civicsAdminScopeSchema } from './civics-dynamic-answer.dto';

// =============================================================================
// GET /api/civics/dynamic-answers — query parameters (#117, epic #51)
// =============================================================================
//
// `page` / `pageSize` are the same shape `AllowlistController` established and
// `civics-question-query.dto.ts` already reuses — same bounds, same default of
// 20. civics-content.md §8 requires that of the learner-facing list and there
// is no argument for a second convention one route along.
//
// **THE PAGE IS OVER QUESTIONS, NOT OVER ANSWER ROWS.** A `state`-scope
// question has up to 56 open answers and they are one editable unit: a page
// boundary falling between Ohio and Oklahoma would split a single screen's
// content across two requests for no gain. So one item is one question with
// its answers attached, and `total` counts questions.
//
// -----------------------------------------------------------------------------
// `stateCode` IS A FILTER HERE, AND THAT IS NOT THE THING #111 FORBIDS
// -----------------------------------------------------------------------------
//
// `civics-question-query.dto.ts` rejects `?stateCode=` outright, because on a
// learner route the state is a RESOLUTION INPUT — honouring it would serve one
// learner another state's answer. Nothing is resolved here. This surface is
// gated on `system_settings:read`, shows every state's answer at once by
// default, and the parameter only narrows which of them come back. There is no
// per-caller answer for it to subvert.
//
// It is still `z.strictObject`, so a misremembered parameter is a 400 rather
// than a filter that silently did nothing — an admin who believes they are
// looking at Ohio must not be shown all 56 states and told nothing.
// =============================================================================

export const civicsDynamicAnswerQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),

  /**
   * Restrict to one test version.
   *
   * Omitted means BOTH versions, unlike the learner-facing list — which falls
   * back to the caller's own resolved version. An administrator has no
   * "their own" test version, and the content they maintain spans every
   * version that ships.
   */
  testVersionCode: z.string().trim().min(1).optional(),

  /**
   * Restrict to `national` or to `state` questions.
   *
   * There is no `none` value to pass. It is not filtered out by the service as
   * an afterthought: this surface's domain is the two dynamic scopes, and a
   * `none` question is not addressable through it at all.
   */
  dynamicScope: civicsAdminScopeSchema.optional(),

  /**
   * Narrow a `state` question's answers to one state.
   *
   * Uppercased before validation, so `?stateCode=tx` is corrected rather than
   * rejected for a difference that carries no meaning — the same kindness
   * `update-journey-profile.dto.ts` extends to the learner-facing field, and
   * validated against the same 56-code constant so the two cannot drift.
   *
   * It narrows `answers` and `missingStateCodes`; it does NOT drop `national`
   * questions from the page, whose answers do not vary by state and are
   * returned unchanged.
   */
  stateCode: z
    .string()
    .trim()
    .transform((code) => code.toUpperCase())
    .refine(isValidStateOrTerritoryCode, {
      message: `stateCode must be one of the ${US_STATE_AND_TERRITORY_CODES.length} US state or territory codes`,
    })
    .optional(),
});

export type CivicsDynamicAnswerQuery = z.infer<
  typeof civicsDynamicAnswerQuerySchema
>;

export class CivicsDynamicAnswerQueryDto extends createZodDto(
  civicsDynamicAnswerQuerySchema,
) {}

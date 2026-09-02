import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/ai/usage — response body (issue #37, epic #25)
// =============================================================================
//
// THIS IS RECORDED USAGE, NOT A BILL, AND THE RESPONSE HAS TO MAKE THAT
// EXPRESSIBLE. Three facts stand behind that:
//
//   1. Token counts are not dollars. Pricing differs per model, changes
//      without notice, and this application does not carry a price table.
//   2. A call that fails mid-stream records `null` — unknown — and
//      `callsWithUnknownUsage` below is how many of those there were.
//   3. The authoritative number is the user's own OpenAI dashboard.
//
// So the response deliberately has NO currency field, no estimated cost, and
// no "spent" naming. #42's page states the caveat on screen and links to the
// dashboard. Presenting an approximate figure as a bill is the failure to
// avoid, and adding a `costUsd` here is how it would start.
//
// CALLER-SCOPED. The route takes no user id — the same rule the key routes
// hold, and for the same reason.
// =============================================================================

/** One row of a breakdown, by model or by role. */
export const aiUsageBreakdownSchema = z.object({
  /** The model id, or the role key, depending on which breakdown this is. */
  key: z.string(),

  calls: z.number().int(),

  /**
   * Summed known token counts for this key.
   *
   * Calls with unknown usage contribute nothing here and are counted in
   * `callsWithUnknownUsage` on the summary instead.
   */
  totalTokens: z.number().int(),
});

export const aiUsageResponseSchema = z.object({
  /** Inclusive start of the window this summarises. */
  since: z.iso.datetime(),

  /** Every call in the window, successful or not. */
  calls: z.number().int(),

  /** Calls that completed. The remainder failed. */
  successfulCalls: z.number().int(),

  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),

  /**
   * Calls whose token counts are unknown.
   *
   * SURFACED, NOT HIDDEN. It is the honest caveat on every figure above: a
   * summary with 40 unaccounted calls is a different thing from one with none,
   * and the page can say so rather than presenting a total as complete.
   */
  callsWithUnknownUsage: z.number().int(),

  /** Heaviest first. Stable order across renders. */
  byModel: z.array(aiUsageBreakdownSchema),

  /** The same, by the job the call served. */
  byRole: z.array(aiUsageBreakdownSchema),
});

export type AiUsageResponse = z.infer<typeof aiUsageResponseSchema>;

export class AiUsageResponseDto extends createZodDto(aiUsageResponseSchema) {}

// -----------------------------------------------------------------------------
// Compile-time proof that this response makes no billing claim
// -----------------------------------------------------------------------------
//
// Unlike the other proofs in this module, this one is not about secrets. It is
// about a claim the data cannot support: a currency figure computed from token
// counts, over a window that includes calls whose consumption is unknown,
// against prices this application does not have.
//
// If you are here because this line went red: the number you are adding is a
// guess presented as a bill. Link the user to their OpenAI dashboard instead —
// that is where the authoritative figure lives, and #42's page already does.

type BillingFieldNames =
  | 'cost'
  | 'costUsd'
  | 'amount'
  | 'amountDue'
  | 'price'
  | 'spend'
  | 'spentUsd'
  | 'currency'
  | 'balance'
  | 'invoice';

export type AiUsageMakesNoBillingClaim =
  Extract<keyof AiUsageResponse, BillingFieldNames> extends never ? true : never;

export const AI_USAGE_MAKES_NO_BILLING_CLAIM: AiUsageMakesNoBillingClaim = true;

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// POST /api/account/reset — response body (issue #270)
// =============================================================================
//
// What actually happened, so the "Danger zone" screen can confirm it rather
// than merely trust that a 200 meant something specific. `scope` echoes the
// request; `deleted` is the per-table row counts `AccountResetService.reset`
// captured while deleting (the transaction's tables PLUS `storageObjects`,
// deleted separately — see `AccountResetService.reset`'s own comment for
// why that happens outside the transaction); `aiKeyRemoved` says whether the
// `data_and_key` branch actually ran.
//
// `deleted` IS A `Record<string, number>`, matching `AccountDataSummaryDto
// .counts` for the identical reason: an open, code-owned set of table names
// that a UI renders as a list, not a fixed object shape this DTO would have
// to keep in step with `ACCOUNT_RESET_TABLES` by hand.
//
// `aiKeyRemoved` IS A SEPARATE BOOLEAN, NOT INFERRED FROM `scope ===
// 'data_and_key'`. The two usually agree, but stating the OUTCOME rather
// than making the client re-derive it from the request it already sent is
// what lets this field also answer "did the key removal branch actually
// execute" if `AccountResetService.reset`'s own logic for gating it ever
// grows more conditions than a bare scope check.
// =============================================================================

export const accountResetResultSchema = z.object({
  /** Which destructive scope this reset invoked. Echoes the request. */
  scope: z.enum(['data', 'data_and_key']),

  /**
   * Rows deleted, keyed by table name — every table `ACCOUNT_RESET_TABLES`
   * declares, plus `storage_objects` for the blobs `ObjectsService.delete`
   * removed outside the transaction.
   */
  deleted: z.record(z.string(), z.number().int().nonnegative()),

  /**
   * Was the caller's own stored AI key removed?
   *
   * `true` only when `scope === 'data_and_key'` AND
   * `AiUserKeyService.purgeForDeletedUser` actually ran. `false` on the
   * `data` scope, where the key is deliberately preserved.
   */
  aiKeyRemoved: z.boolean(),
});

export type AccountResetResult = z.infer<typeof accountResetResultSchema>;

export class AccountResetResultDto extends createZodDto(
  accountResetResultSchema,
) {}

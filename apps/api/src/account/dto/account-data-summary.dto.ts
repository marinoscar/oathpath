import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/account/data-summary — response body (issue #270)
// =============================================================================
//
// What the "Danger zone" screen shows BEFORE a caller commits to anything:
// how many rows exist in each table `AccountResetService.reset` would touch,
// and the two phrases they will need to type back to actually do it. This is
// read-only and destroys nothing — see `AccountResetService.summarize`,
// which runs one `count({ where: { userId } })` per table and never a
// `deleteMany`.
//
// `counts` IS KEYED BY THE SAME `table` STRINGS `ACCOUNT_RESET_TABLES`
// DECLARES (`practice_attempts`, `mock_interviews`, ...), plus
// `storage_objects`, which `ACCOUNT_RESET_TABLES` deliberately does not list
// because it is deleted through `ObjectsService.delete`, not a `tx.<model>
// .deleteMany`, outside the transaction (see that constant's own comment).
// A `Record<string, number>` rather than one named field per table, matching
// this application's convention for an open, code-owned key set that a UI
// iterates rather than destructures field by field — the same shape
// `AiUsageEvent.roleKey` and the notification registry's event keys already
// take for the identical reason: a thirteen-branch object literal here would
// be the one place this list is spelled out a second time, and the one place
// most likely to fall one entry behind when a fourteenth table is added.
//
// `phrases` IS `ACCOUNT_RESET_PHRASES` ITSELF, ECHOED BACK, deliberately —
// not because the client cannot import a shared constant (it is one npm
// workspace over, in an API module the web does not depend on), but so the
// confirmation screen renders the exact string the server will check,
// sourced from the one place that check reads from, rather than a value
// hand-copied into a web component that could quietly go stale the next time
// either phrase changes.
// =============================================================================

export const accountDataSummarySchema = z.object({
  /**
   * Row counts, keyed by table name (`practice_attempts`, `mock_interviews`,
   * `storage_objects`, ...). Every key `ACCOUNT_RESET_TABLES` declares is
   * present, plus `storage_objects`.
   */
  counts: z.record(z.string(), z.number().int().nonnegative()),

  /** The exact phrase each scope requires, verbatim from `ACCOUNT_RESET_PHRASES`. */
  phrases: z.object({
    data: z.string(),
    data_and_key: z.string(),
  }),
});

export type AccountDataSummary = z.infer<typeof accountDataSummarySchema>;

export class AccountDataSummaryDto extends createZodDto(
  accountDataSummarySchema,
) {}

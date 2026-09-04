import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AccountResetScope } from '../account-reset.constants';

// =============================================================================
// POST /api/account/reset — request body (issue #270)
// =============================================================================
//
// `scope` picks which of `ACCOUNT_RESET_PHRASES`' two entries governs the
// request; `confirmationPhrase` is what the caller must have typed back. Zod
// enforces the SHAPE here — a real scope, a non-empty string — and
// `AccountResetService.reset` enforces the CONTENT, comparing the trimmed
// phrase against the scope's exact phrase before anything is deleted. Two
// different layers, two different jobs, and deliberately not merged: this
// schema does NOT validate the phrase's content, because that check is a
// security control (see `ACCOUNT_RESET_PHRASES`'s own comment for why it is
// re-verified server-side) and belongs next to the comparison it protects,
// not in the transport layer.
//
// `z.enum(['data', 'data_and_key'])` IS WRITTEN OUT, NOT DERIVED FROM
// `Object.keys(ACCOUNT_RESET_PHRASES)`. Zod's enum needs a literal tuple
// type at compile time, which `Object.keys` cannot produce without a cast
// that would defeat the exhaustiveness check below. The compile-time proof
// after the schema is what stands in for deriving it: it fails to compile
// the moment `AccountResetScope` gains or loses a member this literal does
// not already name, so the two cannot silently drift apart the way a cast
// could let them.
// =============================================================================

export const resetAccountSchema = z.object({
  /** Which destructive scope this request invokes. See `ACCOUNT_RESET_PHRASES`. */
  scope: z.enum(['data', 'data_and_key']),

  /**
   * The phrase the caller typed back, verbatim except for leading/trailing
   * whitespace (which `AccountResetService.reset` trims before comparing —
   * a stray newline from a copy-paste must not turn a correct phrase into a
   * refused one). `.min(1)` only — no upper bound worth enforcing on a
   * short, fixed phrase, and no `.trim()` here: trimming happens once, in
   * the service, next to the comparison it feeds, not silently inside
   * validation where a caller inspecting the DTO would not see it.
   */
  confirmationPhrase: z.string().min(1),
});

export type ResetAccountInput = z.input<typeof resetAccountSchema>;

export class ResetAccountDto extends createZodDto(resetAccountSchema) {}

// -----------------------------------------------------------------------------
// Compile-time proof that the schema's `scope` enum and `AccountResetScope`
// name the same set, in both directions
// -----------------------------------------------------------------------------

type SchemaScopeMatchesConstant =
  ResetAccountInput['scope'] extends AccountResetScope
    ? AccountResetScope extends ResetAccountInput['scope']
      ? true
      : never
    : never;

export const RESET_ACCOUNT_SCOPE_MATCHES_CONSTANT: SchemaScopeMatchesConstant =
  true;

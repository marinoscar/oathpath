import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/ai/status — response body (issue #36, epic #25)
// =============================================================================
//
// TWO INDEPENDENT FACTS, AND THERE IS NO COMBINED FLAG. That is the entire
// design of this endpoint, and the one thing not to "simplify".
//
// The two have different severities and different remedies:
//
//   userKeyConfigured === false  -> the web HARD-BLOCKS into /setup/ai-key
//   systemReady === false        -> the user is LET IN; AI surfaces fail at
//                                   the point of use with an explicit message
//
// Merging them produces the exact failure this shape exists to avoid: a user
// blocked by missing ADMIN configuration being told to add a key they already
// have. That is the most confusing thing this surface could do — it sends
// someone to fix the one thing that is not wrong.
//
// If you are here to add a `ready` boolean because "the client always checks
// both": the client checks both because the answers mean different things.
// =============================================================================

export const aiStatusResponseSchema = z.object({
  /**
   * Does THIS caller have a key stored?
   *
   * A single indexed existence check on `credentials`' `@@unique([purpose,
   * name])`. Never a decrypt, never a provider call.
   *
   * `false` is a hard block, and it is framed to the user as a first-run
   * onboarding step rather than an error — because that is what it is.
   */
  userKeyConfigured: z.boolean(),

  /**
   * Has the administrator finished configuring AI?
   *
   * Provider chosen, master switch on, and every WIRED role bound. Only the
   * wired roles count: four of the six are declared and inert, and requiring
   * them would mean a fresh install could never become ready no matter what an
   * admin did.
   *
   * `false` is NOT a block. See the header.
   */
  systemReady: z.boolean(),

  /**
   * Is the master switch on?
   *
   * Broken out from `systemReady` so the point-of-use message can say
   * something specific — "your administrator has turned AI off" is a different
   * sentence from "your administrator has not chosen models yet", and an admin
   * reading either needs to know which control to touch.
   */
  enabled: z.boolean(),

  /** Has a provider been selected at all? Same reasoning as `enabled`. */
  providerConfigured: z.boolean(),

  /**
   * Wired roles with no model bound, by key.
   *
   * NAMES ONLY — no model ids, no provider configuration, no key hint. A
   * non-admin caller learns that the system is not ready and which of the
   * app's own capabilities are affected; they learn nothing about the
   * organisation's credential or its provider settings, which they have no
   * business seeing. The role keys are already public: the same list is
   * embedded in the client that renders these features.
   */
  unboundRoles: z.array(z.string()),
});

export type AiStatusResponse = z.infer<typeof aiStatusResponseSchema>;

export class AiStatusResponseDto extends createZodDto(aiStatusResponseSchema) {}

// -----------------------------------------------------------------------------
// Compile-time proof that the status grew no secret or admin-only field
// -----------------------------------------------------------------------------
//
// This response is read by EVERY authenticated user on EVERY navigation, which
// makes it the widest-read payload in the application and the worst place for
// a convenience field. The two that would be reached for first are a `hint`
// ("show which key is configured") and the bound model ids ("so the client can
// show what it will use") — both are administrator-facing configuration, and
// both belong on `GET /api/ai-settings`, which is gated.
//
// `ready` is in the list for a different reason: it is not a secret, it is the
// merged flag this endpoint exists to refuse. A build break is a better
// explanation than a code review.

type ForbiddenFieldNames =
  | 'apiKey'
  | 'key'
  | 'hint'
  | 'secret'
  | 'token'
  | 'provider'
  | 'models'
  | 'ready';

export type AiStatusCarriesNoSecret =
  Extract<keyof AiStatusResponse, ForbiddenFieldNames> extends never
    ? true
    : never;

export const AI_STATUS_CARRIES_NO_SECRET: AiStatusCarriesNoSecret = true;

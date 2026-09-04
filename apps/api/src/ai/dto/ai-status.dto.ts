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
   * Has the administrator finished configuring the AI the PRODUCT ITSELF needs?
   *
   * Provider chosen, master switch on, and every wired TEXT role — `tutor` and
   * `grader` — bound. Deliberately NOT "every wired role": since E9 (#88) the
   * wired set also holds `transcribe` and `speak`, and a deployment with no
   * voice bindings is a smaller product, not a broken one. Under the older
   * "every wired role" rule, wiring those two would have flipped every
   * existing installation to `false` on deploy — an admin who changed nothing
   * watching a working system report itself broken.
   *
   * So this is a statement about the roles the hard-blocking navigation gate
   * and `AiNotReady` depend on. A VOICE SURFACE MUST NOT READ IT: it gates on
   * its own role's binding, which {@link unboundRoles} names.
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
   * EVERY wired role with no model bound, by key — a wider set than
   * {@link systemReady} is computed over, on purpose.
   *
   * `transcribe` and `speak` appear here when unbound (E9, #88) even though
   * their absence does not make `systemReady` false. That is what this field
   * is for: a voice surface needs to know that ITS role is the one the
   * administrator has not configured, so it can say so and fall back, rather
   * than reading a single system-wide boolean that is `true` and then failing
   * at the point of use with no explanation. An UNWIRED role is never listed —
   * nothing dispatches to it, so nothing has been left undone.
   *
   * NAMES ONLY — no model ids, no provider configuration, no key hint. A
   * non-admin caller learns which of the app's own capabilities are affected;
   * they learn nothing about the organisation's credential or its provider
   * settings, which they have no business seeing. The role keys are already
   * public: the same list is embedded in the client that renders these
   * features.
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

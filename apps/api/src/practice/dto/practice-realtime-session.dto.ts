import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AiUnavailableCause } from '../../ai/ai-dispatch.service';

// =============================================================================
// POST /api/practice/sessions/:id/realtime-session — response (#353, E15)
// =============================================================================
//
// A discriminated union on `status`, ALWAYS HTTP 200, exactly as
// `ai-speech.dto.ts` and `interview-realtime-session.dto.ts` already establish
// — the same shape, the same three members, and the same reasoning, which
// those files state in full and this one does not repeat:
// `HttpExceptionFilter` suppresses detail in production and the web client
// funnels a non-2xx into generic failure handling, so a 404 or a 503 here
// would discard the one fact the response exists to carry.
//
// -----------------------------------------------------------------------------
// THE SUCCESS BODY IS A CREDENTIAL
// -----------------------------------------------------------------------------
//
// The second route in this API whose 200 carries a bearer secret rather than
// data (the first is the interview's own mint). Three fields, and the list is
// closed:
//
//   * `clientSecret` — the ephemeral secret, minted per session, useless the
//     moment it expires and useless outside the one practice session it was
//     scoped for (its `instructions` and `tools` were built for it).
//   * `expiresAt` — the PROVIDER's own expiry, echoed rather than computed. A
//     browser that cannot date its secret cannot know when to re-mint, and a
//     value derived here would disagree by the round trip plus the clock skew,
//     in the direction that tells a browser it still has time it does not have.
//   * `modelId` — which realtime model the secret was minted against, because
//     the browser has to name one when it opens the connection.
//
// Nothing about the session's configuration comes back: not the instructions,
// not the tool list, not the question, not the planned count. A client that
// needed any of it would be a client deciding something the server decides.
//
// `Cache-Control: no-store` is set ON THE ROUTE (see `practice.controller.ts`),
// not described here: a cached mint response is a bearer credential sitting in
// a shared cache or a browser's disk cache for longer than the secret is valid,
// which is a liability with no corresponding benefit — it cannot open a second
// session even while it is still readable.
// =============================================================================

/**
 * Why no mint was attempted, mirroring `AiUnavailableCause` exactly.
 *
 * A LITERAL SET RATHER THAN `z.string()`, so the published document tells a
 * client the four branches it must handle. Kept honest by
 * {@link PracticeRealtimeSessionCauseCoversDispatcher} at the bottom of this
 * file.
 */
export const practiceRealtimeSessionUnavailableCauseSchema = z.enum([
  'no_user_key',
  'ai_disabled',
  'role_unbound',
  'capability_unsupported',
]);

/**
 * The role this response can name.
 *
 * A ONE-MEMBER ENUM, not a bare string. `realtime` is an `AI_MODEL_ROLES` key
 * and it is persisted — it keys the admin's `models` map and lands in
 * `ai_usage_events.roleKey` — and a client reads it back as
 * `unboundRoles.includes(role)` on `GET /api/ai/status`, which is only
 * meaningful if the spelling is identical on both surfaces.
 */
export const practiceRealtimeSessionRoleSchema = z.literal('realtime');

/** A session was minted. See this file's header for why the list is closed. */
export const practiceRealtimeSessionOkSchema = z.object({
  status: z.literal('ok'),

  /**
   * The ephemeral, single-session client secret.
   *
   * NEVER THE LEARNER'S OWN API KEY, which does not leave this process on any
   * code path (`docs/specs/ai-settings.md` §4.2) and does not start leaving it
   * here. The compile-time proof at the bottom of this file is what keeps a
   * field a long-lived key would naturally travel in off this type.
   */
  clientSecret: z.string(),

  /** When {@link clientSecret} stops being usable, as the PROVIDER reported it. */
  expiresAt: z.iso.datetime(),

  /** The realtime model this secret was minted against. */
  modelId: z.string(),
});

/**
 * No mint was attempted, and why.
 *
 * Carries no secret, no expiry and no model: nothing ran, and the fields a
 * caller would reach for do not exist rather than being null.
 */
export const practiceRealtimeSessionUnavailableSchema = z.object({
  status: z.literal('unavailable'),
  cause: practiceRealtimeSessionUnavailableCauseSchema,

  /** Always `realtime` — the role that could not be served. */
  role: practiceRealtimeSessionRoleSchema,
});

/**
 * The mint was attempted and did not produce a usable session.
 *
 * DISTINCT FROM `unavailable`, and the distinction is what a client renders:
 * "spoken practice is not set up here" is a state a learner can do nothing
 * about and should fall back from — to E13's hands-free loop, or to typing —
 * while "that did not work" is worth a retry button first.
 */
export const practiceRealtimeSessionFailedSchema = z.object({
  status: z.literal('failed'),

  /** A short, stable, GROUP-able code. Never a message. */
  errorCode: z.string(),

  /** A diagnosable, redacted sentence. Never a credential of either kind. */
  error: z.string(),
});

export const practiceRealtimeSessionResponseSchema = z.discriminatedUnion(
  'status',
  [
    practiceRealtimeSessionOkSchema,
    practiceRealtimeSessionUnavailableSchema,
    practiceRealtimeSessionFailedSchema,
  ],
);

export type PracticeRealtimeSessionOkResponse = z.infer<
  typeof practiceRealtimeSessionOkSchema
>;
export type PracticeRealtimeSessionUnavailableResponse = z.infer<
  typeof practiceRealtimeSessionUnavailableSchema
>;
export type PracticeRealtimeSessionFailedResponse = z.infer<
  typeof practiceRealtimeSessionFailedSchema
>;
export type PracticeRealtimeSessionResponse = z.infer<
  typeof practiceRealtimeSessionResponseSchema
>;

// -----------------------------------------------------------------------------
// The DTO classes: ONE PER UNION MEMBER, never one per union
// -----------------------------------------------------------------------------
//
// `createZodDto` builds a CLASS and a class cannot extend a union (TS2509), so
// each variant is published on its own and the controller composes them with
// `oneOf` plus a `status` discriminator — the arrangement `ai-speech.dto.ts`
// already explains at length.

export class PracticeRealtimeSessionOkDto extends createZodDto(
  practiceRealtimeSessionOkSchema,
) {}
export class PracticeRealtimeSessionUnavailableDto extends createZodDto(
  practiceRealtimeSessionUnavailableSchema,
) {}
export class PracticeRealtimeSessionFailedDto extends createZodDto(
  practiceRealtimeSessionFailedSchema,
) {}

// -----------------------------------------------------------------------------
// Compile-time proof that no long-lived credential can travel on this response
// -----------------------------------------------------------------------------
//
// `ai.types.ts` carries this proof on the provider's own realtime types, and
// `interview-realtime-session.dto.ts` carries it on the other mint route. None
// of the three is redundant: a field added to this type is not a field added to
// either of those, and this is the type an HTTP handler serialises.
//
// `clientSecret` is deliberately not on the forbidden list, and the omission is
// the point — an ephemeral secret is what this route exists to produce. What
// must never appear beside it is a field a long-lived key would naturally be
// put in: `apiKey` ("the browser needs to talk to OpenAI"), a generic `token`,
// or a `session` blob echoing the provider's own payload.
//
// If you are here because this line went red: you are about to hand a browser a
// credential that does not expire. The provider mints an ephemeral one.

type ForbiddenFieldNames =
  | 'apiKey'
  | 'openaiApiKey'
  | 'userApiKey'
  | 'key'
  | 'password'
  | 'secret'
  | 'token'
  | 'credential'
  | 'authorization'
  | 'session'
  | 'userId';

/** Every key of every member of a union, distributed. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

export type PracticeRealtimeSessionCarriesNoLongLivedKey =
  Extract<
    KeysOfUnion<PracticeRealtimeSessionResponse>,
    ForbiddenFieldNames
  > extends never
    ? true
    : never;

export const PRACTICE_REALTIME_SESSION_CARRIES_NO_LONG_LIVED_KEY: PracticeRealtimeSessionCarriesNoLongLivedKey =
  true;

// -----------------------------------------------------------------------------
// Compile-time proof that the published cause set IS the dispatcher's cause set
// -----------------------------------------------------------------------------
//
// Assignability in BOTH directions, so the two are the same set rather than
// merely overlapping. A fifth dispatcher cause reaching the wire as a value no
// client handles, or a removed cause still documented as reachable, are both
// build breaks here.

export type PracticeRealtimeSessionCauseCoversDispatcher =
  AiUnavailableCause extends z.infer<
    typeof practiceRealtimeSessionUnavailableCauseSchema
  >
    ? z.infer<
        typeof practiceRealtimeSessionUnavailableCauseSchema
      > extends AiUnavailableCause
      ? true
      : never
    : never;

export const PRACTICE_REALTIME_SESSION_CAUSE_COVERS_DISPATCHER: PracticeRealtimeSessionCauseCoversDispatcher =
  true;

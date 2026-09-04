import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AiUnavailableCause } from '../../ai/ai-dispatch.service';

// =============================================================================
// POST /api/interviews/:id/realtime-session — response (issue #157, epic #60)
// =============================================================================
//
// A discriminated union on `status`, ALWAYS HTTP 200, exactly as
// `ai-speech.dto.ts` already establishes for the two speech routes — the same
// shape, the same three members, and the same reasoning, which that file states
// in full and this one does not repeat: `HttpExceptionFilter` suppresses detail
// in production and the web client funnels a non-2xx into generic failure
// handling, so a 404 or a 503 here would discard the one fact the response
// exists to carry.
//
// -----------------------------------------------------------------------------
// THE SUCCESS BODY IS A CREDENTIAL, AND IT IS THE ONLY ONE IN THIS API
// -----------------------------------------------------------------------------
//
// Every other 200 in this application carries data. This one carries a bearer
// secret that can open a realtime session and spend the learner's own AI quota
// for as long as it is valid. `docs/specs/realtime-interview.md` §12's second
// locked decision is what the shape below implements: "The browser never sees
// the learner's API key — only an ephemeral, interview-scoped secret."
//
// Three fields, and the list is closed:
//
//   * `clientSecret` — the ephemeral secret, minted per session, useless the
//     moment it expires and useless outside the one interview it was scoped
//     for (its `instructions` and `tools` were built from that interview).
//   * `expiresAt` — the PROVIDER's own expiry, echoed rather than computed. A
//     browser that cannot date its secret cannot know when to re-mint, and §3's
//     resume-while-`in_progress` rule needs the number.
//   * `modelId` — which realtime model the secret was minted against, because
//     the browser has to name one when it opens the connection and deriving it
//     from the settings row a second time on the client is a second place the
//     answer can be stale.
//
// Nothing about the session's configuration comes back: not the instructions,
// not the tool list, not the interview's phase. A client that needed any of it
// would be a client deciding something the server decides.
//
// -----------------------------------------------------------------------------
// `Cache-Control: no-store` IS SET ON THE ROUTE, NOT DESCRIBED HERE
// -----------------------------------------------------------------------------
//
// See `interviews.controller.ts`. A cached mint response is a client secret
// sitting in a shared cache or a browser's disk cache for longer than the
// secret is valid, which is a liability with no corresponding benefit: it
// cannot open a second session even while it is still readable.
// =============================================================================

/**
 * Why no mint was attempted, mirroring `AiUnavailableCause` exactly.
 *
 * A LITERAL SET RATHER THAN `z.string()`, so the published document tells a
 * client the four branches it must handle. Kept honest by
 * {@link RealtimeSessionCauseCoversDispatcher} at the bottom of this file —
 * the same device, and the same reason, as `ai-speech.dto.ts`'s own copy.
 */
export const realtimeSessionUnavailableCauseSchema = z.enum([
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
export const realtimeSessionRoleSchema = z.literal('realtime');

/** A session was minted. See this file's header for why the list is closed. */
export const realtimeSessionOkSchema = z.object({
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

  /**
   * When {@link clientSecret} stops being usable, as the PROVIDER reported it.
   *
   * Never recomputed from a local clock: the provider anchors the expiry to
   * its own at mint time, and a value derived here would disagree by the round
   * trip plus the skew — in the direction that tells a browser it still has
   * time it does not have.
   */
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
export const realtimeSessionUnavailableSchema = z.object({
  status: z.literal('unavailable'),
  cause: realtimeSessionUnavailableCauseSchema,

  /** Always `realtime` — the role that could not be served. */
  role: realtimeSessionRoleSchema,
});

/**
 * The mint was attempted and did not produce a usable session.
 *
 * DISTINCT FROM `unavailable`, and the distinction is what a client renders:
 * "voice interviews are not set up here" is a state a learner can do nothing
 * about and should fall back to the text transport for, while "that did not
 * work" is worth a retry button before falling back.
 *
 * `error` is the provider's own message, already redacted and truncated. It
 * never contains a key, and never the secret this route mints.
 */
export const realtimeSessionFailedSchema = z.object({
  status: z.literal('failed'),

  /** A short, stable, GROUP-able code. Never a message. */
  errorCode: z.string(),

  /** A diagnosable, redacted sentence. Never a credential of either kind. */
  error: z.string(),
});

export const realtimeSessionResponseSchema = z.discriminatedUnion('status', [
  realtimeSessionOkSchema,
  realtimeSessionUnavailableSchema,
  realtimeSessionFailedSchema,
]);

export type RealtimeSessionOkResponse = z.infer<typeof realtimeSessionOkSchema>;
export type RealtimeSessionUnavailableResponse = z.infer<
  typeof realtimeSessionUnavailableSchema
>;
export type RealtimeSessionFailedResponse = z.infer<
  typeof realtimeSessionFailedSchema
>;
export type RealtimeSessionResponse = z.infer<
  typeof realtimeSessionResponseSchema
>;

// -----------------------------------------------------------------------------
// The DTO classes: ONE PER UNION MEMBER, never one per union
// -----------------------------------------------------------------------------
//
// `createZodDto` builds a CLASS and a class cannot extend a union (TS2509), so
// each variant is published on its own and the controller composes them with
// `oneOf` plus a `status` discriminator — the arrangement `ai-speech.dto.ts`
// already explains at length.

export class RealtimeSessionOkDto extends createZodDto(
  realtimeSessionOkSchema,
) {}
export class RealtimeSessionUnavailableDto extends createZodDto(
  realtimeSessionUnavailableSchema,
) {}
export class RealtimeSessionFailedDto extends createZodDto(
  realtimeSessionFailedSchema,
) {}

// -----------------------------------------------------------------------------
// Compile-time proof that no long-lived credential can travel on this response
// -----------------------------------------------------------------------------
//
// `ai.types.ts` carries this proof on the provider's own realtime types; this
// is the same proof at the LAST layer before a browser, where the mistake would
// actually cost something. The two are not redundant: a field added here is not
// a field added there, and this is the type an HTTP handler serialises.
//
// `clientSecret` is deliberately not on the forbidden list, and the omission is
// the point — an ephemeral secret is what this route exists to produce. What
// must never appear beside it is a field a long-lived key would naturally be
// put in: `apiKey` ("the browser needs to talk to OpenAI"), a generic `token`,
// or a `session` blob echoing the provider's own payload, which on OpenAI's
// realtime endpoint contains rather more than the secret.
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

export type RealtimeSessionCarriesNoLongLivedKey =
  Extract<
    KeysOfUnion<RealtimeSessionResponse>,
    ForbiddenFieldNames
  > extends never
    ? true
    : never;

export const REALTIME_SESSION_CARRIES_NO_LONG_LIVED_KEY: RealtimeSessionCarriesNoLongLivedKey =
  true;

// -----------------------------------------------------------------------------
// Compile-time proof that the published cause set IS the dispatcher's cause set
// -----------------------------------------------------------------------------
//
// Assignability in BOTH directions, so the two are the same set rather than
// merely overlapping. A fifth dispatcher cause reaching the wire as a value no
// client handles, or a removed cause still documented as reachable, are both
// build breaks here.

export type RealtimeSessionCauseCoversDispatcher =
  AiUnavailableCause extends z.infer<typeof realtimeSessionUnavailableCauseSchema>
    ? z.infer<
        typeof realtimeSessionUnavailableCauseSchema
      > extends AiUnavailableCause
      ? true
      : never
    : never;

export const REALTIME_SESSION_CAUSE_COVERS_DISPATCHER: RealtimeSessionCauseCoversDispatcher =
  true;

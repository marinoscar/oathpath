import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_PROVIDER_KINDS } from '../ai-settings.schema';

// =============================================================================
// POST /api/ai-settings/test and /api/ai/key/test — response body
// (issues #32 and #35, epic #25)
// =============================================================================
//
// THESE ENDPOINTS ANSWER 200 EVEN WHEN THE TEST FAILED. That is the design,
// not an oversight, and it is the single most important thing in this file.
//
// A failed test is a SUCCESSFUL DIAGNOSTIC — the endpoint did exactly what it
// was asked to do, and the answer is "OpenAI says this key is revoked".
//
// Returning 4xx/5xx for that answer loses it. This app's error envelope is
// `{ code, message, details }` produced by `HttpExceptionFilter`, a shape the
// web client funnels into generic failure handling; and the filter suppresses
// detail in production by design. The provider's actual text — the one fact
// worth having — would arrive as "Request failed". So the outcome travels as a
// normal payload, in a body whose `success` field the caller must read.
//
// A real 4xx/5xx still means what it always means here: not authenticated, not
// permitted, a malformed request, or a bug. Those are transport failures of
// the endpoint. A refused connection is a result.
//
// `success` IS THE ONLY SUCCESS SIGNAL. A caller that treats HTTP 200 as "the
// key works" reports success for every misconfiguration in existence.
//
// ONE SHAPE FOR BOTH ENDPOINTS, deliberately. The admin's server-key test and
// a user's personal-key test ask the same question of the same provider
// method; two shapes would mean the web needs two renderers for one dialog,
// and the per-role half — the part most likely to be got wrong — would be
// written twice.
// =============================================================================

/**
 * Whether one bound model is reachable on the key that was tested.
 *
 * PER ROLE, NOT ONE BOOLEAN, and this is the reason both test endpoints exist
 * rather than a bare "is this key valid" check. The admin binds model ids
 * using the SERVER key; a user's personal key may sit in a different
 * organisation or tier with no access to those models. A key that
 * authenticates and cannot reach the `grader` model does not work for this
 * application, and testing only `GET /v1/models` would pass it.
 */
export const aiRoleReachabilitySchema = z.object({
  /** The role whose binding was probed: 'tutor', 'grader', … */
  roleKey: z.string(),

  /** The model id that was probed. Echoed so the UI can name it. */
  modelId: z.string(),

  reachable: z.boolean(),

  /**
   * THE PROVIDER'S ACTUAL ERROR FOR THIS ROLE, VERBATIM. Null when reachable.
   *
   * `The model 'gpt-5.4' does not exist or you do not have access to it`,
   * `Your organization must be verified to use this model`. Not a category,
   * not a rewritten sentence — "model not found" and "your org must be
   * verified" demand completely different actions, and flattening them
   * discards the only information the caller came for.
   *
   * Already through `SecretRedactor` and the length cap in
   * `BaseAiProvider.formatError`, the single exit path for provider error
   * text, so it carries no key.
   */
  error: z.string().nullable(),
});

export const aiTestResultSchema = z.object({
  /**
   * Did the key authenticate AND reach every model it was asked about?
   *
   * A CONJUNCTION. A key that authenticates but cannot reach the `grader`
   * model does not work for this application, and reporting it as a success is
   * how a user finishes onboarding into a product that then fails on their
   * first practice answer.
   */
  success: z.boolean(),

  /**
   * Did the key itself authenticate?
   *
   * SEPARATE FROM `success` because the two have different remedies. A key
   * that fails here is wrong or revoked — replace it. A key that passes here
   * and still fails overall belongs to an organisation without access to the
   * bound models — a different problem, and told only "the test failed" the
   * caller would replace a perfectly good key.
   */
  authenticated: z.boolean(),

  /**
   * One entry per role probed. Empty when authentication itself failed, or
   * when there was nothing to probe.
   */
  roles: z.array(aiRoleReachabilitySchema),

  /**
   * Which provider carried (or refused) the test.
   *
   * Null only when no provider was configured, i.e. nothing was attempted.
   */
  providerKind: z.enum(AI_PROVIDER_KINDS).nullable(),

  /**
   * The summary failure, verbatim and redacted. Null on success.
   *
   * Configuration problems detected BEFORE a provider is reached — no provider
   * chosen, AI disabled, no key stored — come back through this same field,
   * because to the admin they are the same question ("why did that not
   * work?"), and answering half of them in a different shape means the UI
   * needs two code paths to display one sentence.
   */
  error: z.string().nullable(),

  /** When the attempt was made. */
  attemptedAt: z.iso.datetime(),
});

/** The POST /test response body (inside the global `{ data }` envelope). */
export type AiTestResult = z.infer<typeof aiTestResultSchema>;

export class AiTestResultDto extends createZodDto(aiTestResultSchema) {}

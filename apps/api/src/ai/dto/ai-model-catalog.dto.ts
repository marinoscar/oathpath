import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_CAPABILITY_FAMILIES } from '../ai-model-roles';

// =============================================================================
// GET /api/ai-settings/models — response body (issue #31, epic #25)
// =============================================================================
//
// TWO THINGS IN ONE RESPONSE, and that is deliberate rather than lazy: the
// classified model catalog, and the model-ROLE registry.
//
// The admin page needs both to render one control — a select per role, filtered
// to the family that role needs — and fetching them separately would mean two
// round trips whose results can disagree (a role added between the two calls),
// plus two loading states for one widget.
//
// THE ROLE REGISTRY TRAVELS OVER THE WIRE RATHER THAN BEING DUPLICATED IN
// `apps/web/src/config`. That is option 1 of the three
// `notifications/notification-events.ts` weighs, chosen for the same reason: a
// duplicate with a test asserting the two agree is DETECTION rather than
// prevention, and it breaks the epic's one-registry-entry promise directly.
// The web gets the server's answer.
//
// THERE IS NO KEY IN THIS RESPONSE, in any shape. The catalog is fetched
// server-side precisely because the browser cannot hold the server key, and
// nothing here echoes an Authorization header or a credential hint. There is a
// compile-time proof at the bottom of this file.
// =============================================================================

/** One model, as classified by the provider. */
export const aiModelSchema = z.object({
  /** The provider's own model id, exactly as it must be sent back on save. */
  id: z.string(),

  /** Which family it was classified into. See `ai-model-roles.ts`. */
  family: z.enum(AI_CAPABILITY_FAMILIES),

  /**
   * The parsed generation, or null when the id carries none we recognise.
   *
   * NULL MEANS UNKNOWN, NEVER OLD. Such a model is shown under the show-all
   * view rather than filtered out, so an upstream naming change can never
   * become an empty dropdown with no workaround.
   */
  generation: z.number().nullable(),

  /** Provider-reported creation time, when it supplies one. */
  createdAt: z.iso.datetime().nullable(),
});

/** One model role, mirrored from the API's registry. */
export const aiModelRoleSchema = z.object({
  /** Stable key. Also the property name in the settings row's `models` map. */
  key: z.string(),

  label: z.string(),

  description: z.string(),

  /** The capability family a model must belong to to serve this role. */
  capability: z.enum(AI_CAPABILITY_FAMILIES),

  /**
   * Is anything dispatching to this role yet?
   *
   * `false` means declared and inert — the admin page renders it with the
   * registry's `disabled` treatment rather than hiding it, so an admin can see
   * what is coming without being able to configure something that does
   * nothing.
   */
  wired: z.boolean(),
});

export const aiModelCatalogResponseSchema = z.object({
  /**
   * The models, already filtered for this view.
   *
   * Empty is a legitimate answer — a provider genuinely has no models in a
   * family, or the floor excluded them all. `notConfigured` and `error` below
   * are what distinguish that from "we could not ask".
   */
  models: z.array(aiModelSchema),

  /** The six role slots, so the page renders one select per role. */
  roles: z.array(aiModelRoleSchema),

  /**
   * No server key is stored, so nothing was attempted.
   *
   * A SEPARATE FIELD FROM `error`, and the distinction is the point: this is
   * the state of every fresh install, and rendering it as a failure makes a
   * brand-new system look broken. The page says "add a key to see the model
   * list", not "something went wrong".
   */
  notConfigured: z.boolean(),

  /**
   * Why the fetch failed, verbatim from the provider after redaction and the
   * length cap. Null when it succeeded or when nothing was attempted.
   *
   * SAFE TO SURFACE: the reader holds `system_settings:read`, and the text has
   * already been through the single exit path in `BaseAiProvider.formatError`
   * — the same guarantee `test-email-result.dto.ts` documents at length.
   */
  error: z.string().nullable(),

  /** The floor that was applied, echoed so the page can explain the filter. */
  minGeneration: z.number(),

  /** Whether the show-all escape hatch was engaged for this response. */
  showAll: z.boolean(),
});

export type AiModelCatalogResponse = z.infer<
  typeof aiModelCatalogResponseSchema
>;

export class AiModelCatalogResponseDto extends createZodDto(
  aiModelCatalogResponseSchema,
) {}

// -----------------------------------------------------------------------------
// Compile-time proof that the catalog response grew no secret-bearing field
// -----------------------------------------------------------------------------
//
// The obvious-looking addition here is a convenience echo of the key's hint
// ("so the page can show which key produced this list"). That belongs on
// `GET /api/ai-settings`, which already carries `apiKeyStatus` and is the
// endpoint about the key. This one is about models.

type SecretFieldNames =
  | 'apiKey'
  | 'key'
  | 'hint'
  | 'authorization'
  | 'secret'
  | 'token';

export type AiModelCatalogCarriesNoSecret =
  Extract<keyof AiModelCatalogResponse, SecretFieldNames> extends never
    ? true
    : never;

export const AI_MODEL_CATALOG_CARRIES_NO_SECRET: AiModelCatalogCarriesNoSecret =
  true;

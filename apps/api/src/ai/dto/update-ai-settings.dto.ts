import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { aiSettingsSchema } from '../ai-settings.schema';

// =============================================================================
// PUT /api/ai-settings — request body (issue #30, epic #25)
// =============================================================================
//
// DERIVED FROM `aiSettingsSchema`, NOT RESTATED. Every field below reaches
// into `aiSettingsSchema.shape`, so a rule that changes there — a new provider
// kind, a tightened floor — changes here in the same edit. A restated copy is
// how a settings page starts accepting a value the reader rejects, which
// surfaces as "I saved it and AI still doesn't work" with nothing in the
// response to explain it.
//
// -----------------------------------------------------------------------------
// THE KEY IS THE ONLY ADDITION, AND IT IS WRITE-ONLY
// -----------------------------------------------------------------------------
//
// `apiKey` exists on the REQUEST and on nothing else. It is never in
// `aiSettingsSchema` (that file carries a compile-time proof of its absence),
// never in the persisted blob — `aiSettingsSchema.parse()` in the service
// strips it, because zod drops unknown keys — and never in the response DTO
// next door, which carries its own proof.
//
// So the value's entire lifetime is: request body -> service ->
// `CredentialsService.setSecret` -> AES-GCM ciphertext in `credentials.secret`.
// There is no branch on which it can travel back out.
//
// -----------------------------------------------------------------------------
// BLANK PRESERVES — DO NOT "NORMALISE" THE KEY
// -----------------------------------------------------------------------------
//
// The form renders the key box EMPTY, because the stored value is unreadable
// by design. An empty submission therefore means "keep what is stored" and can
// never mean "erase it".
//
// That contract is easy to defeat from here, and the ways all look like
// tidying up:
//
//   * `.trim()` — a key whose leading/trailing whitespace is significant
//     becomes a different key, and authentication starts failing with no
//     visible cause.
//   * `.min(1)` — a blank submission becomes a 400, so an admin changing a
//     model binding can no longer save the form without retyping a secret they
//     cannot see.
//   * `.default('')` / coercion — turns "absent" into a value, and any code
//     downstream that distinguishes the two now sees the wrong one.
//
// So: `z.string()` with a length ceiling and nothing else. `.nullish()`
// because a JSON body deserialises an omitted field to `undefined` and an
// explicitly-cleared one to `null`, and the admin means the same thing by
// both.
// =============================================================================

/**
 * Length ceiling on the submitted key.
 *
 * Not a security control — it is a bound on what a paste accident can push
 * into an encrypted column, so a multi-megabyte body is refused by the
 * validator rather than by Postgres. Generous enough for any real API key,
 * including a long project-scoped one.
 */
const MAX_API_KEY_LENGTH = 1024;

/**
 * A model binding an admin has left empty.
 *
 * A `<Select>` with no selection submits `''`, and a reset controlled
 * component submits `null`. Both mean "not bound", which the persisted schema
 * expresses as `null`.
 *
 * Accepted as a UNION rather than converted with `z.preprocess`, deliberately:
 * a preprocess is a `ZodTransform`, and `zod`'s `toJSONSchema` — which
 * nestjs-zod calls to publish this DTO into the OpenAPI document — throws on
 * an unrepresentable transform. The union is representable, so the published
 * schema stays honest about what the endpoint actually accepts. The conversion
 * to `null` happens once, in `AiSettingsService.update`.
 */
const modelBinding = z.union([z.literal(''), z.string().trim().min(1).max(200), z.null()]);

export const updateAiSettingsSchema = aiSettingsSchema.extend({
  // Widened to tolerate an emptied form control. The rules themselves still
  // come from `aiSettingsSchema.shape` for everything but this.
  models: z.record(z.string(), modelBinding).optional(),

  /**
   * The server OpenAI API key. WRITE-ONLY — see the header.
   *
   * Blank (absent, `null`, or `''`) preserves whatever is stored. Erasing a
   * stored key is a separate control, and is deliberately not expressible
   * through this field.
   */
  apiKey: z.string().max(MAX_API_KEY_LENGTH).nullish(),
});

/**
 * The PUT body as a CLIENT MAY SEND IT, key included.
 *
 * `z.input`, NOT `z.infer`. `minModelGeneration` carries a `.default()`, so
 * the inferred OUTPUT type marks it required while the endpoint accepts a body
 * that omits it — zod fills the default. Typing the parameter as the output
 * would make the compiler demand a field of every caller that the runtime does
 * not, which is a type that lies in the direction that costs the most: it is
 * the request contract, and the OpenAPI document published from this schema
 * says optional.
 */
export type UpdateAiSettingsInput = z.input<typeof updateAiSettingsSchema>;

export class UpdateAiSettingsDto extends createZodDto(updateAiSettingsSchema) {}

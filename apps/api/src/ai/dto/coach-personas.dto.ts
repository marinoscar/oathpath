import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { coachPersonaSchema } from '../../common/schemas/user-settings-namespaces.schema';

// =============================================================================
// GET /api/ai/coach/personas — response body (issue #320, epic #305)
// =============================================================================
//
// The four coaches a learner may choose between, as the settings page needs
// them: what to call each one, what choosing it changes, and one line in its
// voice so the choice can be read before it is made.
//
// -----------------------------------------------------------------------------
// FOUR FIELDS. `promptFragment` IS NOT ONE OF THEM, AND NEVER WILL BE.
// -----------------------------------------------------------------------------
//
// `AI_COACH_PERSONAS` entries carry five fields; this schema declares four.
// The fifth, `promptFragment`, is prose that exists solely to be concatenated
// into a system message server-side (`personas.ts`, and issue #319's builders),
// and a response that carried it would widen what a client-side read can see
// for no gain at all — the same reason `AiDispatchService`'s resolved model id
// and credential never reach a client either.
//
// The controller enforces this by writing out the four fields explicitly
// rather than by spreading the registry entry and deleting one key: a
// projection names what it serves, so a sixth field added to `CoachPersonaDef`
// tomorrow is served by nothing until somebody decides it should be. A
// spread-minus-delete has the opposite default and serves it immediately.
//
// The compile-time proof at the bottom of this file and the key-set assertion
// in `test/ai-coach.integration.spec.ts` are the two mechanical halves of the
// same guarantee — one fails the build, the other fails on the actual bytes.
// =============================================================================

export const coachPersonaSummarySchema = z.object({
  /**
   * The stable, PERSISTED key — the exact string a learner's
   * `coach.persona` setting stores. What a client sends back to
   * `PATCH /api/user-settings`.
   */
  key: coachPersonaSchema,

  /** The name on the settings card. Sentence case, one or two words. */
  label: z.string(),

  /** What choosing this changes, in the learner's terms. Product copy. */
  description: z.string(),

  /**
   * One line in this persona's voice, so a learner can read what they are
   * choosing before they choose it.
   *
   * A REPRESENTATIVE line, not a sample from the bank's distribution — a
   * learner comparing four cards is comparing voices, not sampling. The bank
   * itself (`reaction-lines.ts`) is never served: it is content this API
   * selects from, not a list a client picks out of.
   */
  sampleLine: z.string(),
});

export const coachPersonasResponseSchema = z.object({
  /**
   * Every persona this build knows, in registry order — which is the order
   * `/settings/coach` renders the cards in, `supportive` (the default) first.
   */
  personas: z.array(coachPersonaSummarySchema),
});

export type CoachPersonaSummary = z.infer<typeof coachPersonaSummarySchema>;
export type CoachPersonasResponse = z.infer<typeof coachPersonasResponseSchema>;

export class CoachPersonasResponseDto extends createZodDto(
  coachPersonasResponseSchema,
) {}

// -----------------------------------------------------------------------------
// Compile-time proof that the projection grew no server-side field
// -----------------------------------------------------------------------------
//
// The same device `ai-status.dto.ts` uses for its own forbidden fields, and
// for the same reason: a build break is a better explanation than a code
// review. `reactionLines` and `bank` are listed alongside `promptFragment`
// because they are the second thing somebody would reach for ("let the client
// pick a line") — and `docs/specs/coach-personality.md` §8 rules that out for
// a reason beyond tidiness: the web never holds the bank, so the selection and
// its determinism stay in one place.

type ForbiddenPersonaFieldNames =
  | 'promptFragment'
  | 'prompt'
  | 'fragment'
  | 'reactionLines'
  | 'lines'
  | 'bank';

export type CoachPersonaSummaryCarriesNoPrompt =
  Extract<keyof CoachPersonaSummary, ForbiddenPersonaFieldNames> extends never
    ? true
    : never;

export const COACH_PERSONA_SUMMARY_CARRIES_NO_PROMPT: CoachPersonaSummaryCarriesNoPrompt =
  true;

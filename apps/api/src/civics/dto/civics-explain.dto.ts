import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// POST /api/civics/questions/:id/explain — the request body (issue #120, E4)
// =============================================================================
//
// ONE OPTIONAL FIELD, AND THE BODY ITSELF IS OPTIONAL. `POST … /explain` with
// no body at all is the ordinary case — "explain this question" — and the whole
// body exists so a learner can add the one thing that makes an explanation
// personal: what specifically confuses them.
//
// -----------------------------------------------------------------------------
// WHAT IS NOT HERE IS THE POINT: NO `stateCode`, NO `userId`, NO `language`
// -----------------------------------------------------------------------------
//
// The learner is `@CurrentUser('id')`; their state comes from their own
// `learner_profiles` row through the same resolution `GET /api/civics/
// questions/{id}` uses; and the language comes from that row's
// `explanation_language`. None of the three is a parameter, so none of them is
// a check somebody has to remember to make — the identical structural rule
// `civics-question-query.dto.ts` and `journey.controller.ts` already hold to,
// and civics-content.md §8 states for this surface.
//
// A `language` field is worth naming as a rejection rather than an omission,
// because it is the one an API client would most reasonably expect. It is left
// out for two reasons. The learner's language is a SETTING they already chose
// (E1 collects `explanation_language` and, until this endpoint, nothing read
// it); making it a per-request parameter would mean two places disagree about
// what language this learner reads, and the request would win over the person's
// own saved preference. And a free-text language field is a free-text string
// that lands in a prompt on every call — a strictly worse injection surface
// than a validated column, for a capability nobody asked for.
//
// `z.strictObject`, so an unknown key is a 400 naming it rather than something
// silently dropped. A client sending `{ "stateCode": "TX" }` learns
// immediately that this API does not resolve answers for a state you name; a
// client whose parameter was ignored would go on believing it worked.
// =============================================================================

export const civicsExplainSchema = z
  .strictObject({
    /**
     * What the learner wants help with, in their own words.
     *
     * UNTRUSTED INPUT THAT REACHES A PROMPT. `explain-prompt.ts` delimits it,
     * labels it as data and strips the characters that could forge a delimiter;
     * this bound is the other half — 200 characters is a sentence, which is
     * what "what is confusing you?" is answered with, and it keeps a learner
     * from pasting an essay into a system prompt's context.
     *
     * The cap lives HERE rather than in the prompt builder on purpose: a 400
     * naming `focus` is a contract a client can see and fix, while silent
     * truncation inside the builder would make the API's real limit invisible.
     *
     * `.trim()` before the length check so trailing whitespace is not what puts
     * a request over the line, and so `"   "` is the empty note it plainly is.
     */
    focus: z.string().trim().max(200).optional(),
  })
  // WHY A DEFAULT AND NOT A REQUIRED BODY. `POST` with no body — no
  // `Content-Type`, no bytes — arrives at the pipe as `undefined`, and a bare
  // `strictObject` rejects that with "expected object, received undefined".
  // Sending `{}` to ask a question is a ceremony with no meaning, so the empty
  // body is the documented ordinary call and the default is what makes it one.
  .default({});

export type CivicsExplainInput = z.infer<typeof civicsExplainSchema>;

export class CivicsExplainDto extends createZodDto(civicsExplainSchema) {}

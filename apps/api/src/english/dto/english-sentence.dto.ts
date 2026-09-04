import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/english/next — query and response (issue #136, epic #59 / E10)
// =============================================================================
//
// One sentence to read aloud, or one to hear and type back.
//
// -----------------------------------------------------------------------------
// `text` IS RETURNED FOR BOTH KINDS, WRITING INCLUDED. THAT IS NOT A LEAK.
// -----------------------------------------------------------------------------
//
// `docs/specs/english-test.md` §4's rule is that the writing sentence is
// **never rendered on screen** before submission — a learner who can see it is
// copying, not writing English they heard. That is a DOM invariant, enforced on
// the writing screen (#147), not a network one, and the difference is
// load-bearing rather than a convenience:
//
// Dictation's DEFAULT is the browser's own `window.speechSynthesis` (§4, and
// `docs/specs/voice.md` §2's "no binding required, no admin configuration, no
// per-call cost"). `speechSynthesis.speak()` takes a STRING, in the browser. So
// the client must hold the text to say it at all, on every deployment, with no
// admin action — which is precisely the property §4 locks. Withholding `text`
// here would leave exactly one way to hear a writing sentence: a server-side
// synthesis call through the optional `speak` role, which §4 names an "optional
// premium upgrade... never the only way to hear the sentence". A
// server-side-only dictation path would make the free default impossible and
// silently convert an unbound deployment's writing test into nothing at all.
//
// The honest statement of the boundary: the API serves the sentence, the
// writing screen never paints it, and the screen — not this DTO — is where that
// invariant lives and is tested.
// =============================================================================

/**
 * The two segments. Mirrors the `EnglishSegmentKind` Postgres enum exactly.
 *
 * A literal set rather than `z.string()`, so the published document tells a
 * client the two branches it has to handle, and so a third segment would be a
 * compile error at every call site rather than a value nobody renders.
 */
export const englishSegmentKindSchema = z.enum(['reading', 'writing']);

export type EnglishSegmentKind = z.infer<typeof englishSegmentKindSchema>;

export const englishNextQuerySchema = z.strictObject({
  /**
   * Which segment to draw from. REQUIRED — there is no default, deliberately.
   *
   * A default would have to be one of the two, and whichever it was, a client
   * that forgot the parameter would silently practise the wrong skill and
   * record evidence under the wrong `kind`. The two banks are validated against
   * two different USCIS vocabulary lists (§1.1, "the lists are not the same"),
   * so they are not interchangeable in either direction.
   */
  kind: englishSegmentKindSchema,
});

export type EnglishNextQuery = z.infer<typeof englishNextQuerySchema>;

export class EnglishNextQueryDto extends createZodDto(englishNextQuerySchema) {}

export const englishSentenceSchema = z.object({
  id: z.uuid(),

  kind: englishSegmentKindSchema,

  /**
   * The vocabulary-list revision this sentence was composed and validated
   * against — never a version of the sentence's own text (`schema.prisma`,
   * `EnglishSentence.version`). Returned so a client can tell that a bank it
   * cached yesterday has been superseded.
   */
  version: z.string(),

  /** Display order within `(kind, version)`. */
  ordinal: z.number().int(),

  /** See this file's header for why this is present on a writing sentence. */
  text: z.string(),

  /**
   * The USCIS vocabulary categories this sentence's own words resolve to —
   * DERIVED by the content loader from the same word-by-word validation pass
   * §1.4 already runs, never hand-authored. Sorted.
   */
  vocabTags: z.array(z.string()),

  /**
   * How many word tokens the scorer will compare against — WER's own
   * denominator (`english-scoring.ts`), not `text.split(' ').length`.
   *
   * The two genuinely differ: `normalizeAnswer` collapses "President of the
   * United States" to one token and drops a leading article, so a client
   * counting words itself would show a learner a different number from the one
   * their outcome was computed against. It is computed here, from the same
   * function that scores, so it cannot disagree.
   */
  wordCount: z.number().int(),
});

export type EnglishSentenceResponse = z.infer<typeof englishSentenceSchema>;

export const englishNextResponseSchema = z.object({
  /**
   * `null` when the bank for this kind is empty.
   *
   * An honest absence rather than a 404 (`civics-content.md` §5's designed-
   * absence idiom): "there are no sentences loaded for this kind" is a true
   * statement about a valid request, and a 404 would say the ROUTE was wrong.
   */
  sentence: englishSentenceSchema.nullable(),
});

export type EnglishNextResponse = z.infer<typeof englishNextResponseSchema>;

export class EnglishSentenceDto extends createZodDto(englishSentenceSchema) {}
export class EnglishNextDto extends createZodDto(englishNextResponseSchema) {}

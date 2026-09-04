import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { englishSegmentKindSchema } from './english-sentence.dto';

// =============================================================================
// GET /api/english/progress — response body (issue #136, epic #59 / E10)
// =============================================================================
//
// The caller's own history with the English bank, at three grains: every
// sentence, every vocabulary tag, and each of the two kinds.
//
// -----------------------------------------------------------------------------
// THE PER-TAG ROLLUP IS COMPUTED, NOT STORED — AND THAT IS WHY IT IS HERE
// -----------------------------------------------------------------------------
//
// `english_sentences.vocabTags` is itself DERIVED by the content loader from
// the word-by-word validation pass §1.4 already has to run, never hand-authored
// (`schema.prisma`'s own column comment). This rollup is one more derivation on
// top of the same rows: which USCIS vocabulary categories has this learner
// actually demonstrated, and which have they never got right. Nothing is stored
// for it and nothing needs to be — a stored tag rollup would be a second copy
// of a fact `english_sentences` and `english_attempts` already jointly hold,
// free to drift the moment either the vocabulary files are corrected or an
// attempt is written.
//
// It answers a question the per-sentence list cannot: "PLACES" appearing in
// three failed sentences is a learner who cannot spell state and city names,
// which no single sentence's outcome says.
//
// -----------------------------------------------------------------------------
// SCOPED TO THE CURRENT VOCABULARY REVISION, LIKE `next` — deliberately
// -----------------------------------------------------------------------------
//
// Both this endpoint and `GET /api/english/next` resolve "the current bank"
// through the SAME `resolveCurrentVersion` (`sentence-selection.ts`), so a
// progress screen can never count a bank the practice screen does not draw
// from. The alternative — progress over every sentence ever loaded — would make
// `sentencesTotal` a denominator that includes sentences no learner can be
// served, so a learner who passed every sentence available to them would see
// less than 100%.
//
// The cost is real and worth naming: after a vocabulary revision, attempts
// against superseded sentences stop appearing here. They are not deleted and
// they still count as evidence in their own rows; they simply describe
// sentences nobody is offered any more.
// =============================================================================

const outcomeSchema = z.enum(['correct', 'partial', 'incorrect']);

export const englishSentenceProgressSchema = z.object({
  sentenceId: z.uuid(),
  kind: englishSegmentKindSchema,

  /** The sentence itself — this endpoint is a review surface, so nothing is hidden. */
  text: z.string(),

  ordinal: z.number().int(),

  vocabTags: z.array(z.string()),

  /**
   * How many rows this learner has for this sentence. `0` for a sentence they
   * have never been served — every sentence in the current bank appears here,
   * attempted or not, because "never tried" is the fact a coverage screen most
   * needs and an absent row would render as a gap the client has to explain.
   */
  attempts: z.number().int(),

  /**
   * The BEST outcome ever recorded, `null` when there are none.
   *
   * Best, not latest, and both are reported because they answer different
   * questions: `bestOutcome` is "have they ever done this correctly" — the same
   * per-sentence-best credit §6.2's readiness component uses — while
   * `lastOutcome` is "how did it go the most recent time". A learner who passed
   * a sentence in March and slipped on it yesterday is not the same as one who
   * has never passed it, and one field cannot say so.
   */
  bestOutcome: outcomeSchema.nullable(),

  lastOutcome: outcomeSchema.nullable(),

  /** The most recent attempt's own WER — how close it was, not merely whether it missed. */
  lastWer: z.number().nullable(),

  lastAnsweredAt: z.iso.datetime().nullable(),
});

export const englishVocabTagProgressSchema = z.object({
  /** A USCIS vocabulary category heading, verbatim (`PEOPLE`, `CIVICS`, …). */
  tag: z.string(),

  /** Sentences in the current bank carrying this tag — the honest denominator. */
  sentencesTotal: z.number().int(),

  /** Of those, how many this learner has attempted at all. */
  sentencesAttempted: z.number().int(),

  /**
   * Of those, how many they have EVER got `correct` — per-sentence best, so a
   * sentence passed once and missed twice counts as passed, exactly as §6.2's
   * readiness credit counts it.
   */
  sentencesPassed: z.number().int(),

  /** Every attempt at every sentence carrying this tag. */
  attempts: z.number().int(),
});

export const englishKindProgressSchema = z.object({
  kind: englishSegmentKindSchema,

  sentencesTotal: z.number().int(),
  sentencesAttempted: z.number().int(),
  sentencesPassed: z.number().int(),
  attempts: z.number().int(),

  /**
   * The mean WER across every attempt of this kind, or `null` when there are
   * none.
   *
   * `null`, never `0`: a mean of zero is a perfect record, which is the exact
   * opposite of "no record", and reporting one for a learner who has never
   * practised would be the most flattering possible lie.
   */
  averageWer: z.number().nullable(),

  /** Which vocabulary revision these counts are drawn from. `null` when the bank is empty. */
  version: z.string().nullable(),
});

export const englishProgressSchema = z.object({
  /** Every sentence in the current bank, both kinds, in `(kind, ordinal)` order. */
  sentences: z.array(englishSentenceProgressSchema),

  /** Every tag present in the current bank, alphabetical. */
  vocabTags: z.array(englishVocabTagProgressSchema),

  /** Exactly two entries, `reading` then `writing`, present even when empty. */
  byKind: z.array(englishKindProgressSchema),
});

export type EnglishSentenceProgress = z.infer<
  typeof englishSentenceProgressSchema
>;
export type EnglishVocabTagProgress = z.infer<
  typeof englishVocabTagProgressSchema
>;
export type EnglishKindProgress = z.infer<typeof englishKindProgressSchema>;
export type EnglishProgressResponse = z.infer<typeof englishProgressSchema>;

export class EnglishProgressDto extends createZodDto(englishProgressSchema) {}

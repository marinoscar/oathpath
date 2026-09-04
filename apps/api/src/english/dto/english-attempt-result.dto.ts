import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { englishSegmentKindSchema } from './english-sentence.dto';

// =============================================================================
// POST /api/english/attempts — response body (issue #136, epic #59 / E10)
// =============================================================================
//
// Two shapes, discriminated on `status`, and BOTH ARE HTTP 200.
//
// -----------------------------------------------------------------------------
// `misheard` IS THE ABSENCE OF A RECORDED FAILURE — NOT AN OUTCOME
// -----------------------------------------------------------------------------
//
// `docs/specs/english-test.md` §3 states it as plainly as it can be stated, and
// this file is where the wire keeps the promise: when a reading transcript is
// not trusted, NOTHING is written to `english_attempts` — no row, no
// `outcome: 'incorrect'`, nothing — and the learner is offered a retry.
// `EnglishOutcome` has three values and `misheard` is not one of them
// (`schema.prisma`); it exists only here, as a `status`, because it describes
// what the SERVER did with the submission rather than how the learner did.
//
// The reason is the one §3 gives: a reading attempt's entire evidentiary
// content IS the transcript. A civics practice attempt records what the learner
// KNEW — the transcript is a means of finding out, and even a mistrusted one is
// evidence that an attempt happened. A reading attempt records whether the
// learner could produce a specific, exact sequence of words, computed over that
// transcript's own text; if the transcript is not trustworthy there is no fact
// left to record. Writing an `incorrect` row would misrepresent a transcription
// failure as a reading failure.
//
// This is a deliberate divergence from practice, where `misheard` IS a
// `failure_cause` on a row that IS written (`docs/specs/voice.md` §3.1). Both
// specs are right about their own table; the divergence is stated in both
// places rather than left for a reader to reconcile.
//
// -----------------------------------------------------------------------------
// A MISHEARING IS NOT A CLIENT ERROR, SO IT IS NOT A 4xx
// -----------------------------------------------------------------------------
//
// The request was well formed, the caller did nothing wrong, and the response
// carries real content the screen needs — the diff and the WER, so the learner
// can see WHAT WAS HEARD and judge for themselves whether to re-record or type
// it instead. A 4xx would route all of that into a client's generic
// error-handling path and the learner would get "something went wrong" for a
// state that is neither wrong nor theirs to fix. The same posture the AI
// surfaces already take for `unavailable` (`ai-speech.dto.ts`, and
// `docs/specs/ai-evaluation.md` §4).
//
// -----------------------------------------------------------------------------
// `text` IS ON BOTH VARIANTS, AND ON A WRITING ATTEMPT IT IS THE REVEAL
// -----------------------------------------------------------------------------
//
// The writing screen never rendered the sentence (§4). This response is the
// first time the learner sees it — beside their own words and the diff between
// them, which is the entire feedback moment for the writing test.
// =============================================================================

/** The four alignment operations, mirroring `DiffOpKind` in `english-scoring.ts`. */
export const englishDiffOpKindSchema = z.enum([
  'match',
  'substitute',
  'delete',
  'insert',
]);

/**
 * One aligned position, exactly as `english-scoring.ts` produced it and exactly
 * as `english_attempts.diff_ops` stores it.
 *
 * Published as a real schema rather than `z.unknown()` because a client renders
 * it word by word: `reference` is `null` for an `insert` (a word the learner
 * produced that is not in the sentence), `hypothesis` is `null` for a `delete`
 * (a word of the sentence they did not produce), and `referenceIndex` is the
 * position in the NORMALISED reference the op belongs to — what lets a renderer
 * lay the diff over the sentence rather than beside it.
 */
export const englishDiffOpSchema = z.object({
  kind: englishDiffOpKindSchema,
  reference: z.string().nullable(),
  hypothesis: z.string().nullable(),
  referenceIndex: z.number().int(),
});

/**
 * Everything both variants carry: what was compared, and how it came out as a
 * measurement.
 *
 * The split is not cosmetic — `outcome` and `attemptId` live on `scored` alone
 * precisely because a misheard submission produced neither.
 */
const englishScoreFieldsSchema = z.object({
  sentenceId: z.uuid(),

  kind: englishSegmentKindSchema,

  /** The sentence itself. On a writing attempt this is the reveal — see header. */
  text: z.string(),

  /** What the learner submitted, verbatim. Normalisation is never written back. */
  responseText: z.string(),

  /**
   * `errors / referenceTokenCount` (§2.2) — the rate against what SHOULD have
   * been produced, never against what was, which is what makes two attempts at
   * the same sentence comparable however much either over- or under-said.
   */
  wer: z.number(),

  /** `substitutions + deletions + insertions` — the raw count §2.3 reads FIRST. */
  errors: z.number().int(),

  substitutions: z.number().int(),
  deletions: z.number().int(),
  insertions: z.number().int(),

  /** WER's denominator, reported so a client can check the arithmetic. */
  referenceTokenCount: z.number().int(),

  /** The full alignment, in reference order, insertions interleaved. */
  diff: z.array(englishDiffOpSchema),

  /** What was actually compared, after `normalizeAnswer`. Both sides, so a
   * learner can see WHY "President of the United States" matched "President". */
  normalizedReference: z.string(),
  normalizedHypothesis: z.string(),
});

/** The submission was scored and one `english_attempts` row was written. */
export const englishAttemptScoredSchema = englishScoreFieldsSchema.extend({
  status: z.literal('scored'),

  /** The row that was written. Its existence is the difference between the two variants. */
  attemptId: z.uuid(),

  /** §2.3's compound rule, applied identically to both kinds. */
  outcome: z.enum(['correct', 'partial', 'incorrect']),

  /** From the injected `Clock`, never a client-supplied instant. */
  answeredAt: z.iso.datetime(),

  /** As stored: the recogniser's confidence for a reading attempt, `null` for a
   * writing attempt or when the provider reported none. Never defaulted to 0. */
  asrConfidence: z.number().nullable(),

  /** As stored. Recorded, never gating — §4. */
  replayCount: z.number().int(),
});

/**
 * The transcript was not trusted, so NOTHING WAS WRITTEN. See this file's
 * header.
 *
 * Carries no `attemptId` and no `outcome`, and their absence is the point:
 * there is no row to name and no verdict to report. What it does carry is the
 * diff and the WER, so the retry screen can show the learner what was heard.
 */
export const englishAttemptMisheardSchema = englishScoreFieldsSchema.extend({
  status: z.literal('misheard'),

  /**
   * The confidence that triggered this — always present here, always strictly
   * below `ASR_CONFIDENCE_THRESHOLD`, and echoed so a client can say how sure
   * the recogniser actually was rather than only that it was unsure.
   */
  asrConfidence: z.number(),

  /**
   * The threshold it fell below, so the copy on the retry screen never hard-codes
   * a second copy of `0.6` that can drift from the server's.
   */
  confidenceThreshold: z.number(),
});

/**
 * `POST /api/english/attempts`'s response.
 *
 * Discriminated on `status`, so a client's `switch` is exhaustive and a new
 * variant is a compile error at every call site rather than a shape nobody
 * handles.
 */
export const englishAttemptResultSchema = z.discriminatedUnion('status', [
  englishAttemptScoredSchema,
  englishAttemptMisheardSchema,
]);

export type EnglishDiffOpResponse = z.infer<typeof englishDiffOpSchema>;
export type EnglishAttemptScoredResponse = z.infer<
  typeof englishAttemptScoredSchema
>;
export type EnglishAttemptMisheardResponse = z.infer<
  typeof englishAttemptMisheardSchema
>;
export type EnglishAttemptResult = z.infer<typeof englishAttemptResultSchema>;

// -----------------------------------------------------------------------------
// ONE DTO CLASS PER UNION MEMBER, never one per union
// -----------------------------------------------------------------------------
//
// `createZodDto` builds a CLASS, and a class cannot extend a union (TS2509).
// `ai-speech.dto.ts` documents the same constraint and the same resolution: each
// variant is its own published schema and the controller composes them with
// `oneOf` + a `status` discriminator. The union stays the source of truth in
// TypeScript; these classes are how the shape reaches the document.

export class EnglishAttemptScoredDto extends createZodDto(
  englishAttemptScoredSchema,
) {}
export class EnglishAttemptMisheardDto extends createZodDto(
  englishAttemptMisheardSchema,
) {}

// -----------------------------------------------------------------------------
// Compile-time proof that no attempt response can carry audio or a path to it
// -----------------------------------------------------------------------------
//
// `schema.prisma`'s `EnglishAttempt` block promises there is no audio column
// "and none by proxy — not ever". The way that guarantee would most plausibly
// be undone is not a `storage_objects` FK: it is a convenience field on the way
// back — `audio` ("so the learner can hear what they said"), then `url` or
// `path` ("so they can hear it again later"), and the FIRST of them is what
// makes the second look reasonable. A build break is a better explanation than
// a code review.

type ForbiddenResultFieldNames =
  | 'audio'
  | 'bytes'
  | 'url'
  | 'path'
  | 'filename'
  | 'recordingId';

/** Every key of every member of a union, distributed. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

export type EnglishAttemptResultCarriesNoAudio =
  Extract<
    KeysOfUnion<EnglishAttemptResult>,
    ForbiddenResultFieldNames
  > extends never
    ? true
    : never;

export const ENGLISH_ATTEMPT_RESULT_CARRIES_NO_AUDIO: EnglishAttemptResultCarriesNoAudio =
  true;

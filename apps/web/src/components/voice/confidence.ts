/**
 * How much doubt is too much doubt to hand a learner a transcript unexamined.
 *
 * Issue #104, epic #58 / E9. One number and one predicate, in one file,
 * because both are read from more than one place on the practice screen (the
 * confirmation copy, and the "record it again" invitation beside it) and a
 * second `0.6` typed inline is a second place that drifts on the next edit —
 * after which the same recording is described two different ways on the same
 * card, with nothing failing to say so.
 *
 * =============================================================================
 * THIS VALUE CHANGES WORDS. IT NEVER DECIDES AN OUTCOME.
 * =============================================================================
 *
 * The server owns the verdict: `PracticeService.recordAttempt` compares the
 * `asrConfidence` the client reported against its own
 * `ASR_CONFIDENCE_THRESHOLD` (`apps/api/src/ai/ai.types.ts`) and writes
 * `practice_attempts.failure_cause = 'misheard'` when the outcome is not
 * `correct`. Nothing here writes, sends, or implies a grade — the web never
 * sends a verdict, and `record-attempt.dto.ts` names `failureCause` and
 * `misheard` in its forbidden-field list to keep it that way.
 *
 * So this constant MIRRORS the API's rather than sharing it (there is no
 * endpoint that serves it, and the copy has to be chosen before the request is
 * made). The mirror is safe precisely because of what it does NOT control: if
 * the two ever drift, a learner is invited to re-read a transcript that the
 * server went on to trust, or not invited when it did not — a wording
 * mismatch, never a wrong record.
 *
 * STRICTLY BELOW, never at-or-below, matching the server exactly: `0.6` is
 * trusted. The boundary has to fall on one side, and trusting the transcript
 * is the side that cannot invent a mishearing that did not happen.
 *
 * =============================================================================
 * NULL IS UNKNOWN. UNKNOWN IS NOT LOW.
 * =============================================================================
 *
 * {@link isLowConfidence} returns `false` for `null`, and that is the whole
 * reason it exists as a named function rather than as `(confidence ?? 0) <
 * THRESHOLD` at each call site. Several transcription models — the
 * `gpt-4o-transcribe` family among them — report no confidence at all, so a
 * `null` is ordinary rather than exceptional. Coalescing it to `0` would win
 * the comparison every single time and greet every learner on those
 * deployments with "that may not be what you said" about a transcript nothing
 * was ever uncertain about.
 */

/** The API's `ASR_CONFIDENCE_THRESHOLD`, mirrored. See the file header. */
export const ASR_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Was this transcription uncertain enough to invite a correction?
 *
 * `false` for `null`/`undefined` — unknown is not low — and `false` at exactly
 * the threshold.
 */
export function isLowConfidence(confidence: number | null | undefined): boolean {
  if (confidence === null || confidence === undefined) return false;
  return confidence < ASR_CONFIDENCE_THRESHOLD;
}

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
 *
 * NO PRODUCTION CALLER SINCE #348, AND THAT IS SAID RATHER THAN LEFT TO BE
 * NOTICED. Both screens that used to call it now call {@link spokenDoubt},
 * which answers the same question plus the third state this one cannot express.
 * It is kept for two reasons, neither of them "in case": it is the named
 * statement of the threshold rule that `docs/specs/english-test.md` §2 and
 * §7 and `docs/specs/voice.md` §3 both cite BY NAME as the semantics they
 * mirror, and it is defined in terms of `spokenDoubt` — so it cannot drift
 * from the rule those documents are describing, which a second inline
 * comparison would.
 */
export function isLowConfidence(confidence: number | null | undefined): boolean {
  return spokenDoubt(confidence) === 'low';
}

/**
 * How much this application actually knows about how well it heard a learner.
 *
 * =============================================================================
 * THREE STATES, BECAUSE `null` WAS TWO OF THEM (issue #348, epic #345)
 * =============================================================================
 *
 * {@link isLowConfidence} is a two-way answer to a three-way question, and the
 * missing third is the one most learners are actually in:
 *
 *   * `'low'` — measured, and below the threshold. Say so plainly: this is
 *     more likely our mistake than theirs.
 *   * `'trusted'` — measured, and at or above it. Nothing to apologise for.
 *   * `'unmeasured'` — NOTHING WAS MEASURED, and nothing on this deployment
 *     ever will be. The `gpt-4o-transcribe` family reports no confidence at
 *     all, so `docs/specs/voice.md` §3's misheard protection cannot fire here;
 *     `confidenceAvailable: false` on the transcription response is the server
 *     saying so out loud instead of leaving a silent `null` to be read as
 *     "fine".
 *
 * `'unmeasured'` IS NOT `'low'`, AND MUST NEVER BE TREATED AS ONE. Collapsing
 * it would greet every learner on the recommended model with "that may not be
 * what you said" about a transcript nothing was ever uncertain about — the
 * exact failure the "unknown is not low" rule exists to prevent, arriving by a
 * different route. What it earns instead is *honesty*: we cannot tell how
 * clearly that came through, so please read it.
 *
 * `'unmeasured'` IS NOT AN ERROR EITHER. Nothing is broken and no
 * administrator action would help. The protection a measured score would have
 * bought is replaced by the one that never needed a score — the learner sees
 * the words that will be, or were, graded and can correct them — and that
 * affordance is unconditional on every spoken screen, on every deployment.
 *
 * DEFAULTS TO TODAY'S BEHAVIOUR when `confidenceAvailable` is not threaded
 * through: an unscored transcription from a caller that does not know whether a
 * score was possible is `'trusted'`, exactly as `isLowConfidence` has always
 * returned `false` for it. A page that has not been taught the new fact must
 * not start apologising.
 *
 * @param confidence the recogniser's own score, or `null`/`undefined`.
 * @param confidenceAvailable the deployment fact from
 *   `SpeechTranscriptionOk.confidenceAvailable`. Omitted, or `null`, means "we
 *   have not been told", which resolves toward the quieter answer.
 */
export type SpokenDoubt = 'low' | 'trusted' | 'unmeasured';

export function spokenDoubt(
  confidence: number | null | undefined,
  confidenceAvailable?: boolean | null,
): SpokenDoubt {
  // A NUMBER SETTLES IT, whatever the deployment says it can do. A model that
  // reported a score for this recording measured this recording, and the
  // measurement is the more specific fact.
  if (typeof confidence === 'number') {
    return confidence < ASR_CONFIDENCE_THRESHOLD ? 'low' : 'trusted';
  }

  return confidenceAvailable === false ? 'unmeasured' : 'trusted';
}

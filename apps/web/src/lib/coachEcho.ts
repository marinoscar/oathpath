/**
 * Did the coach hear ITSELF? — issue #399, epic #345 / E15.
 *
 * =============================================================================
 * WHAT THIS IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT
 * =============================================================================
 *
 * On the realtime transport the coach's voice comes out of a loudspeaker while
 * the learner's microphone is open, full duplex, by design
 * (`services/realtimeConnection.ts`'s header forbids every gate that would
 * close it). Browser echo cancellation is best-effort and fails routinely on a
 * phone held at volume, so the model can and does hear its own question return
 * — and, believing it to be an answer, calls `grade_answer` with it.
 *
 * THIS IS A PROVENANCE CHECK, NOT A GRADING ONE. It answers "did these words
 * just come out of our own speaker?" It does not know what a right answer is,
 * has no access to one, and cannot express a verdict: its entire output is a
 * boolean about where a string came from. The grading ladder remains
 * `PracticeService.recordAttempt`'s, on the server, and remains the only one —
 * `realtime-practice.md` §5.
 *
 * IT LIVES IN ITS OWN MODULE FOR TWO REASONS, and only one of them is tidiness.
 * A pure function over two strings is testable without a connection, a mint or
 * a fake provider. And `useRealtimePractice.ts` is a relay whose absences are
 * asserted against its own source — the normalisation this needs is exactly the
 * shape a client-side grading ladder would start as, so it belongs somewhere
 * that says in its own header what it is for and what it refuses to become.
 *
 * =============================================================================
 * WHY THE RULE IS DELIBERATELY BLUNT
 * =============================================================================
 *
 * A false positive costs a learner a recorded attempt: the call is refused, no
 * `practice_attempts` row is written, and they are asked the question again.
 * That is recoverable but not free, so the rule refuses only where the reading
 * is not seriously in doubt — the words ARE the coach's, in the coach's order.
 * There is no fuzzy matching, no edit distance and no library: those trade a
 * clear rule for a threshold nobody can reason about at the moment it fires.
 */

/**
 * How many words a partial echo needs before it is refused.
 *
 * THE WHOLE OF THE FALSE-POSITIVE DEFENCE, and the number is small on purpose.
 * A learner's genuine answer is occasionally a run of words the question also
 * contained — "the president" inside "who is the president now" — and refusing
 * those would discard real evidence of a real (if wrong) answer. Five words in
 * the coach's own order is long enough that a learner reaching it is reciting
 * the question rather than answering it, and short enough to catch the clipped
 * echoes that arrive when the first syllable is lost.
 *
 * An EXACT match is refused at any length, because a one-word utterance
 * identical to a one-word coach line is not a coincidence worth protecting.
 */
export const ECHO_MIN_CONTAINED_WORDS = 5;

/**
 * The words of one utterance, comparable.
 *
 * Case and punctuation go, because a recogniser's capitalisation and commas are
 * its own invention and differ between two transcriptions of identical audio.
 * Nothing else does: no stemming, no stop-word removal, no synonyms. Every one
 * of those would start deciding that two DIFFERENT sentences mean the same
 * thing, which is the judgement this function must never make.
 */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** Is `needle` the same run of words, in order, somewhere inside `haystack`? */
function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Are these the coach's own words, coming back?
 *
 * `transcript` is what a `grade_answer` call claims the learner said;
 * `coachUtterance` is what the coach most recently finished saying, as the
 * provider transcribed its OWN output. `false` whenever there is nothing to
 * compare against — an unknown provenance is not a suspicious one, and refusing
 * on a missing coach transcript would refuse every answer on a deployment whose
 * model does not emit one.
 */
export function isLikelyCoachEcho(
  transcript: string,
  coachUtterance: string | null,
): boolean {
  if (!coachUtterance) return false;

  const said = words(transcript);
  const spoken = words(coachUtterance);
  if (said.length === 0 || spoken.length === 0) return false;

  // The whole utterance, word for word. The commonest shape by far: the
  // microphone picked the question up cleanly.
  if (said.length === spoken.length && containsSequence(spoken, said)) {
    return true;
  }

  // A clipped echo — the tail of the question, or the middle of it. Bounded by
  // {@link ECHO_MIN_CONTAINED_WORDS} so a short genuine answer that happens to
  // reuse the question's phrasing is still graded.
  //
  // ONE DIRECTION ONLY, and that is the point: the transcript must fit INSIDE
  // what the coach said. A learner whose answer is longer than the question, or
  // merely different from it, is never touched by this.
  return (
    said.length >= ECHO_MIN_CONTAINED_WORDS && containsSequence(spoken, said)
  );
}

export default isLikelyCoachEcho;

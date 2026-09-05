/**
 * What the debrief SAYS about a finished civics section — in ONE file, as pure
 * functions over the server's own response.
 *
 * Issue #145, epic #57 / E8. `docs/specs/mock-interview.md` §11.1 makes the
 * copy on this screen an acceptance criterion rather than a matter of taste, so
 * it lives where it can be read as a table and tested as one, instead of spread
 * through JSX as three inline ternaries — the same one-named-file argument
 * `components/practice/outcome.ts` and `components/interview/phases.ts` both
 * make for their own vocabularies.
 *
 * =============================================================================
 * RULE 1: EVERY NUMBER IN EVERY SENTENCE BELOW COMES FROM THE RESPONSE
 * =============================================================================
 *
 * `threshold` and `planned` are interpolated from the
 * {@link InterviewCivicsResult} this module is handed, which the API echoed
 * from the `civics_test_versions` row the interview was created against. **A 6
 * or a 12 typed into this file would be the exact failure the whole feature was
 * built to avoid**, reintroduced one layer up: `civics_test_versions`' own
 * schema comment states it as "a threshold in code is a threshold that will one
 * day disagree with the seeded data", and §11 extends it to the client
 * verbatim — a client that hardcoded the number "instead of reading it back
 * from the same row the engine read it from" has recreated the divergence the
 * database row exists to prevent. There are two seeded versions today with two
 * different thresholds (6 of 10, and 12 of 20), so the bug would not even be
 * theoretical.
 *
 * For the same reason nothing here DERIVES a number either. There is no
 * `asked - correct`, no percentage, no count of missed questions: the web never
 * recomputes a pass rule or a score (§11), and a derived count is the first
 * thing to disagree with the server the day `partial` starts appearing in an
 * interview's outcomes. The sentences below name the numbers the response
 * carries and nothing else.
 *
 * =============================================================================
 * RULE 2: NAME THE QUESTIONS, NEVER THE PERSON
 * =============================================================================
 *
 * §11.1, which is `VISION.md`'s Product Principle 9 — "Respect the User: Never
 * patronize, shame, or underestimate the learner" — applied to the single
 * moment in this product most likely to tempt a shortcut into either false
 * comfort or unearned bluntness.
 *
 * So: **"these questions were missed", never "you struggled with government
 * questions".** The subject of a failure sentence here is always the evidence,
 * never the learner. Concretely, this file contains
 *
 *   * no characterisation of the learner ("struggled", "weak", "careless"),
 *   * no faux-cheerful minimising ("don't worry", "nearly there!"),
 *   * no exclamation mark anywhere on a failure, and
 *   * no advice the learner did not ask for about what they "should have" done.
 *
 * A failed mock interview is real, useful information. The debrief's job is to
 * state it plainly and point at what to do next — not to soften it into
 * vagueness or sharpen it into judgment. `InterviewDebriefPage.test.tsx` asserts
 * the absence of that vocabulary directly, against a list derived in the test
 * with `VISION.md` cited beside it, so a later rewrite that reached for a
 * kinder-sounding characterisation fails rather than ships.
 *
 * =============================================================================
 * RULE 3: THE THREE STOP REASONS READ DIFFERENTLY, BECAUSE THEY ARE DIFFERENT
 * =============================================================================
 *
 * §4.1 makes the early stop a first-class outcome rather than an optimisation,
 * and a learner who sees "6 of 10 asked" with no explanation is looking at what
 * reads like a bug. The three sentences below are the explanation, and they are
 * genuinely three:
 *
 *   * `threshold_reached` — the pass mark was reached, so the officer stopped
 *     asking. Nothing was cut short and nothing is missing.
 *   * `threshold_unreachable` — enough answers had been missed that reaching
 *     the pass mark was no longer possible, so the section ended. This is the
 *     one that most needs saying out loud: without it, the learner sees a
 *     short, failed section and has no way to tell it apart from the interview
 *     breaking.
 *   * `all_asked` — every planned question was asked. The ordinary case, and it
 *     still gets a sentence, because silence here would leave the learner
 *     wondering whether one of the other two had happened quietly.
 */

import type {
  InterviewCivicsResult,
  InterviewReadinessSummary,
  InterviewSpokenSummary,
  InterviewStopReason,
} from '../../types';

/**
 * The one-line verdict on the civics section.
 *
 * Plain, and deliberately not a grade: "Not passed", never "FAILED", never an
 * emoji, never a score out of 100. The number a learner actually wants for
 * their real interview is readiness, computed by the server over the whole
 * evidence table — which is on this page too, further down, where the server
 * put it.
 */
export function civicsVerdictLabel(passed: boolean): string {
  return passed ? 'Civics section passed' : 'Civics section not passed';
}

/**
 * The counts, as one sentence — `4 of 8 answered correctly. 6 of 10 is the
 * pass mark for this test.`
 *
 * BOTH NUMBERS OF BOTH PAIRS COME FROM THE RESPONSE. `asked` rather than
 * `planned` in the first half is the point of having both: an early stop means
 * the learner was asked fewer questions than were planned, and reporting the
 * plan as though it were the ask would tell them they left questions
 * unanswered when the officer never asked them.
 */
export function civicsCountsSentence(civics: InterviewCivicsResult): string {
  return (
    `${civics.correct} of ${civics.asked} answered correctly. ` +
    `${civics.threshold} of ${civics.planned} is the pass mark for this test.`
  );
}

/**
 * Why the civics section ended — one honest sentence per reason.
 *
 * `stopReason` is a closed union in TypeScript and an OPEN set on the wire (the
 * server deploys independently of this bundle), so this takes a plain `string`
 * and ends in a fallback, exactly as `phaseLabel` and `outcomeDisplay` do. The
 * fallback claims nothing about WHY it ended, because a reason this build has
 * never heard of is one it cannot honestly explain.
 */
export function stopReasonSentence(
  stopReason: string,
  civics: InterviewCivicsResult,
): string {
  const reason = stopReason as InterviewStopReason;

  if (reason === 'threshold_reached') {
    return (
      `The officer stopped after ${civics.asked} of ${civics.planned} questions: ` +
      `${civics.threshold} correct is the pass mark, and it had been reached. ` +
      'The real interview ends the civics section the same way.'
    );
  }

  if (reason === 'threshold_unreachable') {
    return (
      `The section ended after ${civics.asked} of ${civics.planned} questions. ` +
      `${civics.threshold} correct answers are needed to pass, and enough had ` +
      'been missed by that point that reaching it was no longer possible. The ' +
      'real interview stops there too.'
    );
  }

  if (reason === 'all_asked') {
    return `All ${civics.planned} planned questions were asked.`;
  }

  return `The section ended after ${civics.asked} of ${civics.planned} questions.`;
}

/**
 * The line that introduces the per-question list when the section was not
 * passed — or null when it was.
 *
 * THE SUBJECT IS THE QUESTIONS. Not "the ones you got wrong", not "where you
 * went wrong": the sentence points at the evidence and at what to do with it,
 * and carries no count, because a count assembled here is a number the server
 * did not send (see this file's Rule 1).
 *
 * Null when passed rather than a congratulatory alternative — the verdict line
 * above already said the section was passed, and a second sentence celebrating
 * it is the manufactured cheer `VISION.md` rules out.
 */
export function missedQuestionsIntro(passed: boolean): string | null {
  if (passed) return null;
  return (
    'The questions that were missed are below, each with the answers that ' +
    'would have been accepted.'
  );
}

/**
 * The line above `focusAreas` — or null when there is nothing to point at.
 *
 * `focusAreas` is the server's own deterministic aggregation: the category
 * names with at least one non-`correct` outcome in THIS interview, computed by
 * grouping the attempts, never written by a model (§11). The sentence says
 * exactly that and no more — it does not tell the learner what it means about
 * them, and it does not turn "one missed question in American Government" into
 * "American Government is a weak area".
 */
export function focusAreasIntro(focusAreas: string[]): string | null {
  if (focusAreas.length === 0) return null;
  return focusAreas.length === 1
    ? 'At least one answer was missed in this section:'
    : 'At least one answer was missed in each of these sections:';
}

/**
 * How the readiness change reads — from `delta` and `previousScore`, NEVER from
 * subtracting one score from another.
 *
 * The direction comes from the server's own `delta` and the comparison point
 * from its own `previousScore`. Two fields rather than one subtraction is not
 * redundancy: `readiness-model.md` computes a delta against the immediately
 * prior snapshot, and a browser that recomputed it from whatever two numbers it
 * happened to hold would silently produce a different answer the moment those
 * are not the same two snapshots.
 *
 * Null when there is no previous score — a learner's first snapshot has nothing
 * to compare against, and rendering "+0" or "no change" would claim a
 * measurement nobody made.
 */
export function readinessChangeSentence(
  delta: number | null,
  previousScore: number | null,
): string | null {
  if (delta === null || previousScore === null) return null;
  if (delta > 0) return `Up ${delta} from ${previousScore}.`;
  if (delta < 0) return `Down ${Math.abs(delta)} from ${previousScore}.`;
  return `Unchanged from ${previousScore}.`;
}

// =============================================================================
// The spoken dimension (issue #160, epic #60 / E11)
// =============================================================================
//
// `docs/specs/realtime-interview.md` §5, §6, §8. Rules 1-3 above apply to every
// sentence below unchanged, and one of them does most of the work here:
// **every number comes from the response**. `spoken.answers`, `spoken.correct`
// and `spoken.misheard` are counted server-side over this interview's own
// attempt rows, and nothing in this file counts a chip on screen or subtracts
// one count from another.
//
// -----------------------------------------------------------------------------
// RULE 4: A MISHEARING IS DESCRIBED, NEVER EXCUSED AND NEVER CHARGED
// -----------------------------------------------------------------------------
//
// `voice.md` §3 is the whole argument: a nervous applicant misheard by the
// recogniser mid-interview must not take a penalty for an accent or a noisy
// connection rather than for anything they got wrong. The copy below therefore
// says what happened — the recogniser was not confident — and says what follows
// from it in this debrief, which is precisely that the question is left off the
// list of sections to review.
//
// It deliberately does NOT say "this was not counted against you". That would
// be a claim about the civics tally, and it would be false: the engine's stop
// rule graded the words it was handed, so a mishearing does sit in
// `civics.correct`'s denominator. Overstating the protection would be a
// comforting sentence a learner could check and find wrong, which is worse than
// the honest, narrower one.

/**
 * The one-sentence summary of the spoken half — or null when nothing was
 * spoken, which is every text interview.
 *
 * `x of y` in the same shape {@link civicsCountsSentence} already uses, so the
 * two bands read as one screen rather than two.
 */
export function spokenSummarySentence(
  spoken: InterviewSpokenSummary,
): string | null {
  if (spoken.answers === 0) return null;

  const answers = spoken.answers === 1 ? 'answer' : 'answers';
  return (
    `${spoken.answers} ${answers} spoken aloud, ` +
    `${spoken.correct} accepted.`
  );
}

/**
 * The note about answers the recogniser could not make out — or null when there
 * were none.
 *
 * The second sentence is the narrow, checkable claim described in Rule 4 above:
 * a misheard question is genuinely absent from `focusAreas`, because
 * `buildInterviewDebrief` excludes it there and nowhere else.
 */
export function misheardNote(spoken: InterviewSpokenSummary): string | null {
  if (spoken.misheard === 0) return null;

  const [answer, was] =
    spoken.misheard === 1 ? ['answer', 'was'] : ['answers', 'were'];
  return (
    `${spoken.misheard} ${answer} ${was} not heard clearly. ` +
    `Marked below, and left off the list of sections to look at again.`
  );
}

/**
 * What the reading and writing bands are called, and the one line under each.
 *
 * The reading sentence was on screen while it was read; the writing sentence
 * was NOT — `english.service.ts` calls the post-attempt sentence "the REVEAL —
 * the first time the learner sees the sentence they were dictated", and this
 * screen is where that reveal happens for an interview. Naming that in the
 * label is the difference between a learner reading "here is the sentence" and
 * a learner understanding why they are only seeing it now.
 */
export function segmentLabel(kind: string): string {
  if (kind === 'reading') return 'Reading test';
  if (kind === 'writing') return 'Writing test';
  // A segment kind this build has never heard of. Says only what is certainly
  // true, the same open-set-on-the-wire discipline `phaseLabel` follows.
  return 'This segment';
}

/** The line above the sentence itself. */
export function segmentSentenceLabel(kind: string): string {
  if (kind === 'reading') return 'The sentence to read aloud';
  if (kind === 'writing') return 'The sentence that was dictated';
  return 'The sentence';
}

/**
 * Whether the score's structural ceiling still applies, said in terms of the
 * evidence that lifted it — or null while it does apply.
 *
 * -----------------------------------------------------------------------------
 * THIS IS NOT A SECOND COPY OF `capMessage`, AND MUST NEVER BECOME ONE
 * -----------------------------------------------------------------------------
 *
 * `capMessage` is the server's own fixed sentence, quoted from `PRD.md` by way
 * of `readiness-model.md` §3, and it is rendered verbatim while the cap
 * applies. There is no server sentence for the other side of that boundary,
 * because until this epic nothing on this screen could cross it and say
 * anything useful: a learner who had just passed their first mock interview saw
 * the capped sentence disappear and nothing take its place, which reads as the
 * product losing interest rather than as a ceiling lifting.
 *
 * So this sentence is assembled here, from the server's own two evidence counts
 * and no others — `readiness-engine.ts`'s cap reads exactly those two paths
 * (`evidenceCounts.spoken.attempts` and `evidenceCounts.interview.attempts`),
 * and naming a third would claim the cap responds to something it does not.
 * `english` is deliberately not among them, for the reason the engine's own
 * header spends a paragraph on: reading and writing English sentences is not
 * evidence that a learner can answer a civics question aloud.
 *
 * Null while the cap applies, so the two sentences can never both be on screen.
 */
export function capLiftedSentence(
  readiness: InterviewReadinessSummary,
): string | null {
  if (readiness.capReason !== null) return null;

  const spoken = readiness.spokenComponent.evidenceCount;
  const interviews = readiness.interviewComponent.evidenceCount;

  const evidence: string[] = [];
  if (spoken > 0) {
    evidence.push(
      `${spoken} civics ${spoken === 1 ? 'question' : 'questions'} answered aloud`,
    );
  }
  if (interviews > 0) {
    evidence.push(
      `${interviews} mock ${interviews === 1 ? 'interview' : 'interviews'} passed`,
    );
  }

  // Neither count above zero cannot happen — `capReason` is null precisely when
  // one of them is — but a response is a response, and a sentence with an empty
  // list in the middle of it is worse than no sentence at all.
  if (evidence.length === 0) return null;

  return `The score cap no longer applies: ${evidence.join(' and ')}.`;
}

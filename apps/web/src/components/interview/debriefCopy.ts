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

import type { InterviewCivicsResult, InterviewStopReason } from '../../types';

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

/**
 * What a failure cause is CALLED IN FRONT OF A LEARNER — in one file.
 *
 * Issue #125, epic #53. `PracticeFailureCause` is a database enum whose six
 * values (`not_known`, `not_recalled`, `expression`, `misheard`, `nervous`,
 * `unknown`) are written to `practice_attempts.failure_cause` by the AI grading
 * rung. `docs/specs/ai-evaluation.md` §8 defines each one and the observable
 * signal that distinguishes it; this file is the other half of that table — the
 * sentence a person reads.
 *
 * =============================================================================
 * THE RAW ENUM VALUE MUST NEVER REACH THE SCREEN
 * =============================================================================
 *
 * `not_recalled` is a column value. Rendered as-is it is a machine telling
 * somebody they were "not_recalled", which is worse than saying nothing:
 * unreadable to most people, faintly clinical to the rest, and — for a product
 * whose whole audience is people studying in a second language — a snap
 * judgement delivered in the vocabulary of a schema.
 *
 * A test asserts directly that no member of {@link FAILURE_CAUSE_KEYS} appears
 * anywhere in the rendered DOM, which is why every lookup here returns copy or
 * returns `null`, and never returns its input.
 *
 * =============================================================================
 * WHY A TOTAL `Record` HERE, WHEN `outcome.ts` DELIBERATELY REFUSES ONE
 * =============================================================================
 *
 * `outcome.ts` takes a plain `string` and falls back, because its unions are
 * closed in TypeScript and OPEN on the wire — the API can produce an outcome or
 * a session kind this bundle has never heard of. The same is true here, so
 * {@link failureCauseCopy} is a TOTAL `Record<PracticeFailureCause, …>` (the
 * compiler rejects the file the day a seventh cause is added to the union, and
 * a test asserts every key is present) while {@link failureCauseDisplay} still
 * takes a `string | null` and returns `null` for anything it does not
 * recognise.
 *
 * `null` means RENDER NOTHING. It does not mean render the value, and it does
 * not mean render a placeholder. A cause this build cannot put into words is a
 * cause it has nothing honest to say about, and an attempt with no diagnosis
 * beside it is a complete, correct screen — see `AiFeedbackCard`.
 *
 * =============================================================================
 * TONE: `VISION.md`'s AI Personality, applied one sentence at a time
 * =============================================================================
 *
 * Warm, specific, never blaming, and never condescending about English. Three
 * rules held every line below to:
 *
 *  1. **Second person, present tense, about the ANSWER — not about the person.**
 *     "You mixed up two answers that look alike", never "you are confused".
 *     The evidence table records what one response did on one question; it
 *     supports no claim about who the learner is.
 *  2. **`expression` is the one this product exists for, and it is stated as a
 *     WIN.** `VISION.md` is explicit that difficulty answering must never be
 *     read as incapability, and this cause is precisely the case where the
 *     learner KNEW the civics and the English got in the way. The sentence
 *     therefore leads with "You knew this" — the fact — and names the English
 *     as the obstacle without a hint that it is a deficiency.
 *  3. **`unknown` promises nothing.** The grader ran and could not tell, which
 *     is a real and honest answer (§8 rejects forcing a confident guess). So
 *     the copy says only that the answer did not match, and asks nothing of the
 *     learner it has no grounds to ask.
 */

import type { PracticeFailureCause } from '../../types';

/** One cause, in learner-facing language. */
export interface FailureCauseCopy {
  /**
   * The headline — a short sentence naming what happened on THIS question.
   *
   * A sentence rather than a label ("Recall") because a label invites the
   * reader to generalise it into a category they belong to, and a sentence
   * about one answer stays about one answer.
   */
  headline: string;

  /**
   * The line under it: what that means, and what (if anything) helps.
   *
   * Never an instruction the learner cannot act on, and never a promise about
   * their readiness — that number is E6's and is computed from evidence, not
   * from encouragement.
   */
  detail: string;
}

/**
 * The six causes, in learner-facing language. THE ONE PLACE THIS COPY LIVES.
 *
 * Total over `PracticeFailureCause`: adding a seventh value to that union
 * breaks the build here, which is the point — a new cause with no copy would
 * otherwise reach a learner as a blank space or as its own column value.
 */
export const failureCauseCopy: Record<PracticeFailureCause, FailureCauseCopy> = {
  not_known: {
    headline: 'This one looks new to you.',
    // Not "you don't know this". The signal is that the response was unrelated
    // to any accepted answer on ONE attempt, which is a fact about the answer,
    // and the useful reading of it is that this is a question still to learn
    // rather than one already lost.
    detail:
      'Your answer didn’t line up with what’s accepted here, so this is one to learn rather than one to recall. Reading the answer through once is a fine place to start.',
  },

  not_recalled: {
    headline: 'You know this material — you reached for a neighbour.',
    // §8's signal: a well-formed, real member of the same confusable category —
    // a different branch of government, a previous officeholder. Naming that
    // precisely is what separates this from `not_known`, and it is genuinely
    // good news for the learner, so the copy says so.
    detail:
      'What you wrote is a real answer, just not the one this question asks for. Answers that sit close together are the ones worth practising side by side.',
  },

  expression: {
    // THE CAUSE THIS PRODUCT EXISTS FOR. See rule 2 in the file header — the
    // fact comes first, and the English is named as the obstacle it was on this
    // answer, never as a deficiency in the person.
    headline: 'You knew this — the English was the hard part.',
    detail:
      'Your answer means the right thing. Saying it closer to the accepted wording makes it easier for an officer to follow on the day, and the civics behind it is already there.',
  },

  misheard: {
    // E9's, and unreachable today: `grading.ts` coerces a model that offers it
    // to `unknown` because nothing in a typed attempt can support it. Written
    // anyway — a row from a later epic must be readable by this build.
    headline: 'That answers a different question.',
    detail:
      'What you wrote is a good answer to something else that was asked. It’s worth hearing this question read aloud once more.',
  },

  nervous: {
    // E8's, same story as `misheard` above.
    headline: 'The answer was in there.',
    detail:
      'You started, corrected yourself, and got to it. That happens in a real interview too, and it counts for more than a tidy first try.',
  },

  unknown: {
    // THE HONEST DEFAULT. The grader ran and could not tell which of the other
    // five this was, so this copy claims nothing about why — see rule 3.
    headline: 'This one didn’t match.',
    detail:
      'We can’t tell from this answer alone what got in the way. The accepted answer is below, and trying it again later will say more than guessing now would.',
  },
};

/**
 * Every cause key, as strings.
 *
 * Derived from the copy table rather than restated, so it cannot fall behind
 * it. Exported for the test that asserts none of these raw values is ever in
 * the DOM.
 */
export const FAILURE_CAUSE_KEYS = Object.keys(
  failureCauseCopy,
) as PracticeFailureCause[];

/**
 * The copy for one recorded cause, or `null` when there is nothing to say.
 *
 * Takes `string | null` rather than the union on purpose (see the file header):
 * `null` is the ordinary case — a deterministically graded attempt carries no
 * cause at all — and an unrecognised value from a newer server is treated
 * exactly the same way, because this build has nothing true to say about
 * either. NEVER RETURNS ITS INPUT.
 */
export function failureCauseDisplay(
  cause: string | null | undefined,
): FailureCauseCopy | null {
  if (!cause) return null;
  return failureCauseCopy[cause as PracticeFailureCause] ?? null;
}

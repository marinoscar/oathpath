import type { CoachReactionResponse } from '../ai/dto/coach-reaction.dto';
import type { GradingVerdict } from './grading';
import type { PracticeAnswerSnapshot } from './dto/practice-attempt.dto';

// =============================================================================
// The spoken turn (issue #351, epic #345 "The conversation the coach has")
// =============================================================================
//
// One pure, total function: given the facts a `practice_attempts` row already
// carries plus the coach line `toAttemptResponse` already computed, return the
// ORDERED LIST OF STRINGS the coach says about that attempt.
//
// -----------------------------------------------------------------------------
// THE DEFECT THIS EXISTS TO FIX
// -----------------------------------------------------------------------------
//
// Before this module, the hands-free loop said exactly one thing after grading:
//
//     spokenAnswer: graded.acceptedAnswers[0]?.text ?? null
//
// The raw first accepted-answer string. No verdict, no reason, no coach. A
// learner who was RIGHT and a learner who was WRONG heard byte-identical audio
// — "the Constitution" either way — and had to guess which had happened. Every
// piece needed to tell them apart was already computed and already on the
// response; all four were render-only, reachable by `AiFeedbackCard.tsx` and by
// nothing that speaks.
//
// So the fix is not new information. It is the ORDER and the SELECTION of
// information that already exists, decided once, on the server, where both
// transports read it — E13's request/response loop today and E15's realtime one
// later. Composing it here rather than in the client is what makes one edit
// change what both of them say.
//
// -----------------------------------------------------------------------------
// THE ORDER, AND WHO AUTHORS EACH ELEMENT
// -----------------------------------------------------------------------------
//
//   1. Acknowledgement of what was heard — ON A MISS ONLY. Echoing a right
//      answer back at somebody who just gave it is padding, and padding in a
//      hands-free loop is time a walking learner cannot skip. The ONE element
//      that carries the learner's own words (see the interpolation rule below).
//   2. The verdict — ALWAYS. This is the element whose absence was the bug.
//   3. The reason — ONLY when `gradingMethod === 'ai'`, and then the grader's
//      own `feedback` sentence, verbatim. When no grader ran there IS no
//      reason, and the engine says nothing rather than inventing one: a
//      diagnosis of a learner that nothing actually made is the one thing this
//      product must never speak aloud (`practice-attempt.dto.ts` makes the same
//      argument about why `failureCause` is nullable rather than absent).
//   4. The accepted answer — on a miss or a skip, never on a correct answer,
//      and never when `answerResolution === 'state_required'` (there is no
//      resolved answer to read; the learner has not set their state).
//   5. The coach's persona reaction line — unless `coach.reactions` is off.
//      LAST, because the invariant floor wants the forward action last.
//
// -----------------------------------------------------------------------------
// THE RETRY BOUNDARY, AND WHY THE RETURN SHAPE IS `{ lines, retryBoundary }`
// -----------------------------------------------------------------------------
//
// The second defect this fixes: the loop read the accepted answer aloud and
// THEN invited a retry. A retry offered after the answer has been spoken is not
// a retry — it is a repeat-after-me, and the `correct` attempt it records
// proves nothing about recall.
//
// Three shapes were considered for expressing "these lines come before the
// retry offer, these come after":
//
//   (a) `{ before: string[]; after: string[] }`. Rejected: it forces every
//       consumer — including the ones that never offer a retry, which is most
//       of them — to concatenate two arrays to get the plain reading order, and
//       it makes the wire field `spokenTurn` something other than the
//       `string[]` issue #351 specifies.
//   (b) Omit the accepted answer entirely when a retry is armed. Rejected on a
//       product ground: a learner who DECLINES the retry (or whose client has
//       spent its one-per-question budget) would then never hear the answer at
//       all, and the turn would have to be recomposed to give it to them.
//   (c) **Chosen.** One flat `string[]` in reading order, plus an index saying
//       where the deferred tail begins.
//
// So: `lines` is the whole turn, in order, and `retryBoundary` is an index into
// it. `null` means no retry is available for this attempt — speak all of it.
// A number `k` means a retry IS armed: speak `lines.slice(0, k)`, offer the
// retry, and speak `lines.slice(k)` only if the learner declines it or the
// client has no retry left to spend. `k === lines.length` is legitimate and
// means "a retry is armed and nothing is deferred" — the `state_required` case,
// where there was no accepted answer to hold back.
//
// **When a retry is armed, the accepted answer moves to the tail — AFTER the
// coach's line rather than before it.** That is a deliberate, conditional
// reordering of elements 4 and 5, not an oversight. Element 5 is last in the
// ordinary turn "because the invariant floor wants the forward action last";
// when a retry is armed the forward action IS the retry, so the coach's line
// stays adjacent to it — immediately before the offer — and the answer becomes
// the fallback the learner hears only once retrying is off the table. Putting
// the coach line after the boundary would mean a learner who takes the retry
// never hears it, which is exactly backwards for `answer.misheard`, the cell
// whose entire job is to say "that was the microphone, not you, go again".
//
// The client decides WHETHER to offer a retry (it owns the per-question budget
// this server has no way to see). This module decides only what is safe to say
// before one and what must wait until after — which is the half that was wrong.
//
// -----------------------------------------------------------------------------
// NO INTERPOLATION, WITH EXACTLY ONE NAMED EXCEPTION
// -----------------------------------------------------------------------------
//
// Every string in {@link SPOKEN_VERDICT_LINES} is a CONSTANT. No question
// prompt, no learner response, no score, no count — the same rule
// `reaction-lines.ts` states for the coach bank, and `reaction-lines.spec.ts`'s
// banned-topic lint is run over this bank too (see `spoken-turn.spec.ts`), so
// a line that trips E14's floor is a failing build rather than something a
// learner hears.
//
// The three frames below interpolate, and each interpolates exactly one thing,
// named here so the list is auditable:
//
//   * {@link spokenAcknowledgement} — the learner's own transcript, ECHOED and
//     never judged. This is the one place learner text reaches speech, and it
//     is why element 1 exists at all: on a miss, a learner needs to know what
//     was heard before they can act on being told it missed.
//   * {@link spokenAcceptedAnswer} — the accepted answer text, read out of the
//     attempt's own frozen `answerSnapshot`. Never re-resolved (see
//     `practice-attempt.dto.ts` on why that snapshot is frozen).
//   * The reason, which is the grader's `feedback` string passed through
//     UNFRAMED and verbatim.
//
// None of the three is model-authored copy about the learner: two are the
// learner's/the database's own words, and the third is the grader's single
// sentence, already capped and already validated by `gradingVerdictSchema`.
//
// -----------------------------------------------------------------------------
// WHAT THIS MODULE IS NOT
// -----------------------------------------------------------------------------
//
// It makes no AI call, and adds none anywhere. The persona reaches speech as a
// CURATED bank line read verbatim (epic #345's locked decision), never as a
// model-authored verdict — `composeSpokenTurn` is handed the line
// `toAttemptResponse` already selected and does nothing but position it.
//
// It imports no Nest, no Prisma, no Clock and no provider — the same discipline
// `grading.ts`, `attempt-event.ts` and `select-line.ts` each state for
// themselves — so `spoken-turn.spec.ts` calls it directly, with no database.
//
// It changes no grade. There is no path from this file into `outcome`,
// `gradingMethod`, mastery, readiness or a session summary, and there must
// never be one: a coach's wording is read AFTER every one of those has already
// finished deciding what happened.
//
// FILE LOCATION: issue #351's body proposes `practice/realtime/spoken-turn.ts`.
// It is here, at `practice/spoken-turn.ts`, because nothing about it is
// realtime-specific — its first and, today, only consumer is the ordinary
// `POST /api/practice/sessions/{id}/attempts` response, which is precisely how
// the fix lands on the transport that already exists rather than only on the
// one a sibling issue adds.
// =============================================================================

/**
 * Which verdict line an attempt gets.
 *
 * Six keys rather than the ten `CoachReactionEvent` has, because a verdict is
 * not a reaction: `answer.correct` and `answer.correct_run` are the same
 * verdict said twice ("that was right"), and the difference between them is
 * flavour the coach's own line already carries.
 */
export type SpokenVerdictKey =
  | 'misheard'
  | 'self_marked'
  | 'correct'
  | 'partial'
  | 'incorrect'
  | 'skipped';

/**
 * The verdict bank — code-owned, constant, reviewable in a diff.
 *
 * One line per key, deliberately: variety across repeated answers is
 * `reaction-lines.ts`'s job and it does it with a seed. A verdict that varied
 * would make the ONE sentence a learner must be able to parse instantly into
 * the sentence they have to listen to hardest.
 *
 * Written to be SPOKEN, which is why none of these is `outcome.ts`'s chip
 * label. "Not a match" is a caption under a coloured chip; nobody says it out
 * loud to another person.
 */
export const SPOKEN_VERDICT_LINES: Readonly<Record<SpokenVerdictKey, string>> =
  Object.freeze({
    // FIRST IN PRECEDENCE, and never phrased as a judgement of the speaker.
    // `docs/specs/voice.md` §3: a mishearing is a statement about the
    // microphone, never about the person — the same precedence
    // `coachEventForAttempt` applies for the same reason.
    misheard: 'I’m not sure I caught that.',
    self_marked: 'Marked as correct.',
    correct: 'That’s right.',
    partial: 'That’s part of it.',
    incorrect: 'That one didn’t match.',
    skipped: 'We’ll come back to that one.',
  });

/**
 * The one element that carries the learner's own words. Echoed, never judged.
 *
 * No adjective, no assessment, no comment on how it was said — E14's floor rule
 * 1 forbids remarking on a learner's English, accent or pronunciation, and the
 * safest way to hold that line in a frame that quotes speech is for the frame
 * to contain no opinion at all.
 */
export function spokenAcknowledgement(heard: string): string {
  return `I heard: ${heard}.`;
}

/**
 * The accepted answer, framed so it cannot be mistaken for the verdict.
 *
 * The frame is the entire point: the unframed string was what the loop used to
 * say, and an unframed answer after a verdict still reads to the ear as "…and
 * this is what you said". `The answer is:` makes it what it is.
 */
export function spokenAcceptedAnswer(answer: string): string {
  return `The answer is: ${answer}.`;
}

/**
 * Everything {@link composeSpokenTurn} reads, and nothing else.
 *
 * NARROWED FROM THE ROW ON PURPOSE, exactly as `CoachAttemptFacts` is: stating
 * the fields as a type is what lets a test construct one in a line, and what
 * stops this function from quietly growing a dependency on a column a caller
 * reading a narrowed `select` would not have loaded.
 */
export interface SpokenTurnFacts {
  /** The recorded outcome. */
  readonly outcome: 'correct' | 'partial' | 'incorrect' | 'skipped';

  /** Who or what made the call — `exact` | `self` | `ai`. */
  readonly gradingMethod: 'exact' | 'self' | 'ai';

  /**
   * The recorded failure cause, or null when no grader ran.
   *
   * A plain nullable string rather than the six-value enum, for
   * `CoachAttemptFacts`' stated reason: a row written by a newer build carrying
   * a seventh cause is data this function still maps, not a compile error at
   * every call site. Only `misheard` is ever compared against.
   */
  readonly failureCause: string | null;

  /**
   * The grader's structured verdict, or null when no grader ran.
   *
   * Only `feedback` is read, and only when `gradingMethod === 'ai'` — see the
   * header on why a reason with no grader behind it is never spoken.
   */
  readonly aiFeedback: Pick<GradingVerdict, 'feedback'> | null;

  /**
   * How the attempt's answers resolved, from its own frozen snapshot.
   *
   * `state_required` suppresses element 4 entirely: there is no resolved answer
   * to read, and reading nothing is honest where reading "there was no correct
   * answer" would be a lie about the question
   * (`practice-attempt.dto.ts`, `answerResolution`).
   */
  readonly answerResolution: PracticeAnswerSnapshot['answerResolution'];

  /**
   * The accepted answers frozen at grading time, in slot order.
   *
   * The FIRST is read aloud. Speaking all of them would turn "name one branch
   * of the government" into three sentences of audio for a learner who needed
   * one — and the screen, which can show a list without costing time, already
   * shows every one of them.
   */
  readonly acceptedAnswers: ReadonlyArray<{ readonly text: string }>;

  /**
   * What the recogniser produced for a spoken attempt, or null.
   *
   * Null for a typed attempt and for a skip — there is nothing that was
   * "heard", so element 1 is skipped rather than filled with a guess.
   */
  readonly heard: string | null;

  /**
   * Whether a retry of this attempt is available at all.
   *
   * DECIDED BY THE CALLER, from the attempt's own columns, never here: it is a
   * statement about what the server would accept
   * (`PracticeService.requireRetryTarget`'s conditions), and this module has no
   * session, no repository and no way to ask. The client's own per-question
   * retry budget narrows it further and is invisible from the server, which is
   * why `retryBoundary` describes an OPPORTUNITY rather than an instruction.
   */
  readonly retryArmed: boolean;

  /**
   * The coach's line for this attempt, or null when `coach.reactions` is off.
   *
   * PASSED IN, ALREADY SELECTED. `toAttemptResponse` has already run
   * `reactionLine` for the response's own `coachReaction` field, and re-running
   * it here would be a second selection free to disagree with the first — the
   * live screen saying one thing and the speaker saying another about the same
   * answer.
   */
  readonly coachReaction: Pick<CoachReactionResponse, 'text'> | null;
}

/** The composed turn. See the header for why the shape is this and not two arrays. */
export interface SpokenTurn {
  /** The whole turn, in reading order. Never null, possibly one element. */
  readonly lines: string[];

  /**
   * Index into {@link lines} at which the retry-deferred tail begins, or null
   * when no retry is available for this attempt.
   *
   * `null` → speak every line. `k` → speak `lines.slice(0, k)`, offer the
   * retry, and speak `lines.slice(k)` only once retrying is off the table.
   */
  readonly retryBoundary: number | null;
}

/**
 * Which verdict this attempt gets.
 *
 * THE SAME PRECEDENCE `coachEventForAttempt` APPLIES, and for the same reasons
 * stated there — `misheard` ahead of the outcome because it is a fact about the
 * microphone, `self` ahead of `correct` because the learner did something
 * different. Two functions with the same precedence is a risk; the mitigation
 * is that this one is four lines long, sits beside its own test, and is asserted
 * against `coachEventForAttempt`'s ordering in `spoken-turn.spec.ts` so the two
 * cannot drift into telling a learner two different stories about one answer.
 */
export function spokenVerdictKey(
  facts: Pick<SpokenTurnFacts, 'outcome' | 'gradingMethod' | 'failureCause'>,
): SpokenVerdictKey {
  if (facts.failureCause === 'misheard') return 'misheard';
  if (facts.gradingMethod === 'self') return 'self_marked';
  return facts.outcome;
}

/**
 * The ordered list of strings the coach says about one graded attempt.
 *
 * PURE AND TOTAL: no clock, no randomness, no I/O, no Nest, no Prisma. The same
 * facts return the same array forever, which is what lets the immediate
 * response to `POST .../attempts` and every later re-read of that attempt speak
 * identically — the determinism guarantee
 * `docs/specs/coach-personality.md` §7 already makes for the coach's line,
 * extended to the whole turn at no cost because every input is already frozen.
 *
 * ALWAYS RETURNS AT LEAST ONE LINE. Element 2 is unconditional: an attempt was
 * recorded, so there is a verdict, and the silence this whole issue exists to
 * fix must not be reachable by any combination of inputs.
 */
export function composeSpokenTurn(facts: SpokenTurnFacts): SpokenTurn {
  const lines: string[] = [];

  // A skip is a miss for every purpose in this function: nothing was recalled,
  // and the accepted answer is owed either way.
  const missed = facts.outcome !== 'correct';

  // 1. WHAT WAS HEARD — on a miss only, and only when there is something that
  //    was actually heard. A typed attempt and a skip both reach here with
  //    `heard: null` and skip this element rather than echoing an empty string.
  if (missed && facts.heard !== null && facts.heard.trim() !== '') {
    lines.push(spokenAcknowledgement(facts.heard.trim()));
  }

  // 2. THE VERDICT — always. The element whose absence was the defect.
  lines.push(SPOKEN_VERDICT_LINES[spokenVerdictKey(facts)]);

  // 3. THE REASON — only when a grader actually ran. `gradingMethod` is the
  //    field that answers "did a grader run", not `failureCause`: the server
  //    writes `failureCause: 'misheard'` itself, with no model involved
  //    (`practice-attempt.dto.ts`'s ONE EXCEPTION note), so a cause-based test
  //    here would speak a reason no grader ever gave.
  const reason = facts.aiFeedback?.feedback?.trim() ?? '';
  if (facts.gradingMethod === 'ai' && reason !== '') {
    lines.push(reason);
  }

  // 4. THE ACCEPTED ANSWER — on a miss or a skip, and never on `state_required`.
  const acceptedAnswer =
    missed && facts.answerResolution === 'resolved'
      ? (facts.acceptedAnswers[0]?.text?.trim() ?? '')
      : '';
  const answerLine =
    acceptedAnswer === '' ? null : spokenAcceptedAnswer(acceptedAnswer);

  // 5. THE COACH — unless reactions are off, in which case NOTHING stands in
  //    for it. Not a placeholder, not a neutral substitute: `null` means the
  //    learner asked for silence here and gets it (`coach-reaction.dto.ts`).
  const coachLine = facts.coachReaction?.text ?? null;

  if (facts.retryArmed) {
    // The conditional reordering the header argues for: the coach's line stays
    // immediately before the retry offer, and the answer becomes the tail.
    if (coachLine !== null) lines.push(coachLine);

    const retryBoundary = lines.length;
    if (answerLine !== null) lines.push(answerLine);

    return { lines, retryBoundary };
  }

  if (answerLine !== null) lines.push(answerLine);
  if (coachLine !== null) lines.push(coachLine);

  return { lines, retryBoundary: null };
}

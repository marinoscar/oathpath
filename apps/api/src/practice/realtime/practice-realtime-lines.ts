// =============================================================================
// The lines this transport authors itself (issue #354, epic #345 / E15)
// =============================================================================
//
// Three of the five tools return words the coach must say, and only one of them
// has a composer already:
//
//   * `grade_answer` and `skip_question` return `composeSpokenTurn`'s output
//     (`practice/spoken-turn.ts`, issue #351) verbatim — the verdict, the
//     reason, the accepted answer and the coach's line, in the order that
//     module decides. Nothing in THIS file is involved in an answered question.
//   * `next_question` and `repeat_question` return the question's own
//     `civics_questions.prompt`, verbatim, and nothing else. There is no
//     constant here for them either: a frame around a question ("Here's the
//     next one: …") would be application copy wrapped around exam material, and
//     `realtime-practice.md` §4's "say them as given" rule is easiest to keep
//     when what is given is exactly one string from the database.
//   * `end_session` is the one turn with no database string behind it, and this
//     file is that one line.
//
// -----------------------------------------------------------------------------
// WHY A CONSTANT AND NOT A MODEL-AUTHORED CLOSING
// -----------------------------------------------------------------------------
//
// The session instructions already tell the coach to say what a tool returns
// and never to add a sentence of its own. Returning nothing here would be an
// invitation to break exactly that rule at the one moment it matters most — the
// last thing the learner hears — and a model composing its own sign-off is a
// model summarising how the session went, which is a verdict by another name
// (`practice-realtime-tools.ts`' `END_SESSION_REASONS` header rejects the same
// thing on the way in).
//
// -----------------------------------------------------------------------------
// WHAT THE LINE MAY NOT CONTAIN, AND WHAT ENFORCES IT
// -----------------------------------------------------------------------------
//
//   * NO COUNT, NO SCORE, NO DIGIT. The summary screen shows what was answered;
//     a spoken figure here would be a second account of it, composed at a
//     different moment from different data. This is
//     `practice-realtime-instructions.ts`' "THE PROMPT BELOW CONTAINS NO DIGIT
//     AT ALL" rule, applied to the one string that transport speaks last.
//   * NO PRAISE OR COMMISERATION PROPORTIONAL TO THE RESULT. "Nice work" after
//     a session a learner struggled through is the product telling somebody
//     something it did not check; the coach's own reaction lines are E14's
//     mechanism for anything of that shape, and they are chosen per attempt
//     against the actual outcome.
//   * NOTHING ON `banned-topics.ts`' LIST — asserted by a lint over this
//     constant in `practice-realtime-lines.spec.ts`, the same lint
//     `reaction-lines.spec.ts` and `spoken-turn.spec.ts` already run over their
//     own banks. A line that trips E14's floor is a failing build rather than
//     something a learner hears.
// =============================================================================

/**
 * What the coach says when the session ends, however it ended.
 *
 * ONE LINE FOR BOTH REASONS — a learner who asked to stop and a session that
 * ran out of questions hear the same sentence. Two lines would make the
 * closing a report on which of the two happened, and the learner who stopped
 * early already knows they stopped early; being told so is the mildest possible
 * version of the pressure `VISION.md` rules out ("We should never create
 * pressure, shame, fear, or unhealthy compulsion").
 *
 * FORWARD-POINTING, per `COACH_INVARIANT_FLOOR`'s closing rule — the last thing
 * said is a door, not a grade.
 */
export const PRACTICE_REALTIME_CLOSING_LINE =
  'That’s the end of this practice session. Your progress is saved — come back whenever you’re ready.';

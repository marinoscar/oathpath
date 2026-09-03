import type { InterviewPhase } from './phases';

// =============================================================================
// Code-owned officer phrasing (issue #123, epic #57 / E8 "Mock interview")
// =============================================================================
//
// Two lists of strings, both owned by this repository and reviewable in a pull
// request, both pure data with no runtime dependency of any kind:
//
//   1. {@link N400_PROMPTS} — the generic, non-identifying application
//      rehearsal prompts.
//   2. {@link FALLBACK_OFFICER_LINES} — the neutral phrasing used when AI
//      dispatch is unavailable or failed.
//
// -----------------------------------------------------------------------------
// THE N-400 PROMPTS ASK FOR NO REAL DATA. EVER.
// -----------------------------------------------------------------------------
//
// OathPath does not ask for, collect, or store a learner's real N-400 answers.
// Not their travel dates, not their addresses, not their employers, not their
// arrests, not their marriages. The application rehearsal exists to make the
// SHAPE of that part of the interview familiar — an officer will move through
// your application and ask you about it, in English, while you are nervous —
// and none of that requires the product to hold a single true fact about the
// applicant.
//
// The rule, with its failure mode, stated as a contrast:
//
//   CORRECT:  "The officer will ask about your travel history outside the
//              United States. Practise how you would answer."
//   WRONG:    "How many trips have you taken outside the United States since
//              2020?"
//
// The wrong shape is not wrong because it is rude. It is wrong because a
// learner will answer it truthfully — that is the whole point of a rehearsal —
// and the moment they do, this application is holding immigration-sensitive
// personal history it never needed, in a transcript, in a database, in a
// backup, in a support engineer's screen share. The correct shape gets the
// same rehearsal value while making that data physically absent.
//
// **These prompts being code-owned and reviewable — never model-generated — is
// what keeps that from drifting.** A model asked to "play an officer reviewing
// the applicant's N-400" will produce the wrong shape, fluently and
// plausibly, on some fraction of runs, and no code review will ever see the
// prompts it produced. Here, changing what the officer asks means editing this
// array, in a diff, in front of a reviewer. That is the entire mechanism, and
// it is why AI is allowed to vary the wording of a turn but is not the source
// of what the turn asks for.
// =============================================================================

/**
 * Generic, non-identifying N-400 rehearsal prompts.
 *
 * Every entry names a TOPIC the officer will cover and invites the learner to
 * practise how they would answer. No entry requests a date, a place, a name, a
 * number, or any other fact about the person — see this file's header for the
 * rule and its failure mode.
 */
export const N400_PROMPTS: readonly string[] = [
  'The officer will ask about your travel history outside the United States. Practise how you would answer.',
  'The officer will ask about where you have lived and worked in the last five years. Practise how you would answer.',
  'The officer will ask about your marital history and your family. Practise how you would answer.',
  'The officer will ask whether you have ever been arrested, cited, or detained by any law enforcement officer. Practise how you would answer.',
  'The officer will ask about your willingness to take the Oath of Allegiance and to support the Constitution. Practise how you would answer.',
];

/**
 * The neutral, code-owned line for each turn kind, used when
 * `AiDispatchService` returns `unavailable` or `failed`.
 *
 * -----------------------------------------------------------------------------
 * AN UNAVAILABLE MODEL CHANGES THE WORDING AND NEVER THE OUTCOME
 * -----------------------------------------------------------------------------
 *
 * When AI is configured, a model may phrase the officer's turn — warmer, more
 * varied, responsive to what the learner just said. When it is not, these
 * lines are used instead. What must be identical either way is everything the
 * interview MEANS: which phase the interview is in, which question is asked,
 * whether an answer was correct, whether the civics section stopped and why,
 * and whether the learner passed. All of that is decided by
 * `interview-engine.ts` from the version row and the learner's answers, with
 * no model in the loop at all — so an outage degrades an interview's prose and
 * cannot degrade its result.
 *
 * The tone is the officer's: formal, courteous, brief. Note in particular that
 * {@link FALLBACK_OFFICER_LINES.acknowledgement} reveals nothing about whether
 * the answer was right. A fallback line that said "correct" would be a verdict
 * delivered by the wording layer, which is exactly the boundary above.
 */
export const FALLBACK_OFFICER_LINES: Record<
  InterviewPhase | 'greeting' | 'acknowledgement',
  string
> = {
  greeting:
    'Good morning. Please have a seat. I am going to ask you some questions today. Please answer in English.',
  smalltalk: 'How are you doing today?',
  n400: 'I would like to go over some of the information from your application.',
  civics: 'I am now going to ask you the civics questions.',
  reading:
    'This practice interview does not include the reading test. We will skip that part today and continue.',
  writing:
    'This practice interview does not include the writing test. We will skip that part today and continue.',
  closing: 'That is the end of my questions. Thank you for your time today.',
  acknowledgement: 'Thank you.',
};

/**
 * The fallback line for one turn, with the interview's opening greeting used
 * in place of the phase line on the very first turn.
 *
 * A thin reader over {@link FALLBACK_OFFICER_LINES} rather than a second
 * source of phrasing: it selects a line, it never composes one.
 */
export function fallbackOfficerLine(phase: InterviewPhase, isFirstTurn: boolean): string {
  return isFirstTurn ? FALLBACK_OFFICER_LINES.greeting : FALLBACK_OFFICER_LINES[phase];
}

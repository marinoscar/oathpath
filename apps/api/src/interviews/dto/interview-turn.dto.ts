import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// POST /api/interviews/:id/turns — request body (issue #133, epic #57 / E8)
// =============================================================================
//
// `docs/specs/mock-interview.md` §12 specifies the whole body as `{ text }` —
// the applicant's reply to the most recent officer turn — and the omissions are
// the design:
//
//   * NO `questionId`. Which question this answer belongs to is the engine's
//     own `nextPrompt` over state rebuilt from the interview's own row and
//     turns. A client that could name the question could answer a question it
//     was never asked, or re-answer one it already got wrong — and the
//     interview's `civics_asked`/`civics_correct` tally, which the pass rule
//     and the readiness count both read, would be a tally of whatever the
//     client chose to submit.
//   * NO `skipped`, NO `revealed`, NO `hintUsed`. Practice has all three
//     (`record-attempt.dto.ts`); an interview has none of them, because none of
//     the affordances they record exists inside one. §6.1 and §10: there is no
//     reveal and no hint in a rehearsal, and "coaching decreases as realism
//     increases" (`VISION.md`'s Product Principle 7) is the reason. An empty
//     answer is still an answer here — the applicant said nothing useful and
//     the officer moves on, exactly as at the real event.
//   * NO `phase`. The engine knows which phase the interview is in; a
//     client-supplied one could file a small-talk reply into the civics tally.
//     `applyAnswer` throws on a phase disagreement for precisely that reason,
//     and the way to never provoke it is to have no field that could disagree.
//
// -----------------------------------------------------------------------------
// THERE IS NO USER ID FIELD, AND THERE NEVER WILL BE
// -----------------------------------------------------------------------------
//
// The learner is `@CurrentUser('id')`; the interview is resolved by
// `InterviewsService.requireInterview`, which filters on that id in the `where`
// of the one query that loads an interview. `z.strictObject` plus the
// compile-time proof below is the same pair `create-interview.dto.ts` carries.
// =============================================================================

/**
 * The longest applicant turn accepted, in characters.
 *
 * A BOUND ON ONE REQUEST, not a statement about how much a learner may say.
 * Two things sit downstream of this string and both are worth bounding: it is
 * written to `mock_interview_turns.text` (when retention is on), and it is
 * interpolated into the officer's phrasing prompt as the one untrusted input
 * (`officer-prompt.ts`). A megabyte of text would be a megabyte of prompt, paid
 * for on the learner's own key, for a sentence of acknowledgement. 2000
 * characters is far beyond any real spoken answer to a civics question and
 * comfortably above a full application-rehearsal reply.
 */
export const MAX_TURN_TEXT_LENGTH = 2000;

export const interviewTurnSchema = z.strictObject({
  /**
   * What the applicant said, verbatim.
   *
   * ALLOWED TO BE EMPTY AFTER TRIMMING, and that is not an oversight. An
   * applicant who says nothing has still taken their turn: the officer
   * acknowledges and moves on, the answer grades `incorrect` through the same
   * deterministic rung any other non-matching answer takes, and the interview
   * proceeds. Rejecting it with a 400 would make "I don't know" the one thing a
   * rehearsal of a high-stakes conversation refuses to let a nervous person
   * say.
   */
  text: z.string().max(MAX_TURN_TEXT_LENGTH),
});

export type InterviewTurnInput = z.infer<typeof interviewTurnSchema>;

export class InterviewTurnDto extends createZodDto(interviewTurnSchema) {}

// -----------------------------------------------------------------------------
// Compile-time proof that no caller-supplied identity or decision crept in
// -----------------------------------------------------------------------------
//
// If you are here because this line went red: you are adding a field that names
// a user, names the question being answered, or states a phase or an outcome.
// All four are the engine's or the grading ladder's, never the client's — see
// this file's header.

type ForbiddenTurnFieldNames =
  | 'userId'
  | 'user_id'
  | 'id'
  | 'learnerId'
  | 'email'
  | 'questionId'
  | 'phase'
  | 'outcome'
  | 'correct'
  | 'interviewId'
  | 'mockInterviewId';

export type InterviewTurnNamesNoUser = Extract<
  keyof InterviewTurnInput,
  ForbiddenTurnFieldNames
> extends never
  ? true
  : never;

export const INTERVIEW_TURN_NAMES_NO_USER: InterviewTurnNamesNoUser = true;

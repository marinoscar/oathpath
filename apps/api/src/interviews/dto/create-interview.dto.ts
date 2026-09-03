import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// POST /api/interviews — request body (issue #133, epic #57 / E8)
// =============================================================================
//
// ONE FIELD. `docs/specs/mock-interview.md` §12 specifies the whole body as
// `{ transcriptRetained?: boolean }`, and the reason the list is that short is
// §8 and §12 together: everything else an interview needs — which question
// bank it draws from, which pass rule grades it, whether the 65/20 senior
// accommodation applies — is read from the caller's OWN `learner_profiles` row
// and can never be claimed by a request.
//
// -----------------------------------------------------------------------------
// `transcriptRetained` DEFAULTS TO `false` HERE **AND** IN THE DATABASE
// -----------------------------------------------------------------------------
//
// Both, on purpose, and neither is redundant with the other.
// `mock_interviews.transcript_retained` carries `@default(false)` so that a
// code path which forgets the column entirely — a script, a backfill, a new
// entry point written next year — still gets the private outcome; the schema's
// own comment calls that "the conservative stance must survive a bug, not
// merely a correctly-written call site". The `.default(false)` here is the
// other half: a client that omits the field gets a defined `false` in the
// service's own input type rather than `undefined`, so no branch downstream has
// to decide what an absent choice means.
//
// §15 records the two rejected alternatives, and both are worth keeping in
// view from this file:
//
//   * RETENTION ON BY DEFAULT lost because "the conservative-handling posture
//     applies to the DEFAULT, not only to the OPTION" — a learner who never
//     touches this control must not end up in the permissive state.
//   * RETENTION AS A USER SETTING (a `study`/`interviews` namespace field) lost
//     because a standing setting applies to every future interview, including
//     one a learner starts without re-checking what their prior self
//     configured. It is a per-interview decision, made in the moment, visible
//     on that interview's own row.
//
// -----------------------------------------------------------------------------
// THERE IS NO USER ID FIELD, AND THERE NEVER WILL BE
// -----------------------------------------------------------------------------
//
// The learner is `@CurrentUser('id')` and nothing else, and the compile-time
// proof at the bottom of this file is the same one
// `create-practice-session.dto.ts` and `update-journey-profile.dto.ts` both
// carry. `z.strictObject` makes an unknown key a 400 naming it, rather than
// something a later edit might start honouring.
// =============================================================================

export const createInterviewSchema = z.strictObject({
  /**
   * Whether this interview keeps the learner's own words.
   *
   * `false` (the default) still records the interview's full STRUCTURE — every
   * turn, in order, in its phase, naming the question it asked and the graded
   * attempt it produced — and still records every outcome, grading method and
   * frozen answer snapshot. What it withholds is specifically the record of
   * what the learner SAID: `mock_interview_turns.text` is written empty for
   * applicant turns, `practice_attempts.response_text` is null, and
   * `practice_attempts.ai_feedback` is omitted entirely (§8.2 — a grader's
   * feedback sentence quotes the response often enough that storing it would
   * be a second, indirect way to retain the learner's words).
   *
   * The honest cost, stated at §8.3 and worth stating here too: a learner who
   * declines retention cannot re-read their own phrasing afterwards. They can
   * still see every question they were asked, every accepted answer, and
   * whether they got it right.
   */
  transcriptRetained: z.boolean().default(false),
});

export type CreateInterviewInput = z.infer<typeof createInterviewSchema>;

export class CreateInterviewDto extends createZodDto(createInterviewSchema) {}

// -----------------------------------------------------------------------------
// Compile-time proof that no caller-supplied identity, bank or verdict crept in
// -----------------------------------------------------------------------------
//
// If you are here because this line went red: you are adding a field that names
// a user, picks a question bank or pass rule, or states an outcome. The caller
// is `@CurrentUser('id')`; the bank and the senior accommodation come from that
// caller's own `learner_profiles` row; the outcome is the engine's.
//
// `seniorExemption` in particular is not an oversight to be corrected later. A
// request that could set it would let any learner sit the smaller pool against
// the lower pass mark — an interview they are told they passed, drawn from a
// bank they are not entitled to. That is the exact "the product tells a learner
// they are ready for a test it did not administer" failure the engine's own
// `planCivicsQuestions` comment calls the most expensive lie this product could
// tell.

type ForbiddenCreateInterviewFieldNames =
  | 'userId'
  | 'user_id'
  | 'id'
  | 'learnerId'
  | 'email'
  | 'testVersionCode'
  | 'seniorExemption'
  | 'stateCode'
  | 'status'
  | 'mode'
  | 'passedCivics'
  | 'civicsAsked'
  | 'civicsCorrect'
  | 'result';

export type CreateInterviewNamesNoUser = Extract<
  keyof CreateInterviewInput,
  ForbiddenCreateInterviewFieldNames
> extends never
  ? true
  : never;

export const CREATE_INTERVIEW_NAMES_NO_USER: CreateInterviewNamesNoUser = true;

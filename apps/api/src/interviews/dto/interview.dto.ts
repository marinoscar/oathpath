import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { INTERVIEW_PHASES } from '../engine';
import { interviewDebriefSchema } from './interview-debrief.dto';

// =============================================================================
// Mock interview response shapes (issue #133, epic #57 / E8)
// =============================================================================
//
// One interview header, one transcript turn, the list row, and the two payloads
// the interview loop returns: create (`POST /api/interviews`) and resume/review
// (`GET /api/interviews/:id`). The turn endpoint returns none of these — it is
// `text/event-stream` and its frames are declared in `interviews.service.ts`
// beside the generator that produces them, exactly as
// `CivicsExplainFrame` sits beside `CivicsExplainService`.
//
// -----------------------------------------------------------------------------
// NO SHAPE HERE CARRIES A VERDICT WHILE THE INTERVIEW IS RUNNING
// -----------------------------------------------------------------------------
//
// §10 is a rule about the whole surface, not only about the turn endpoint, so
// it has to hold for the resume payload too — a client that could poll
// `GET /api/interviews/:id` mid-interview and read per-question outcomes would
// have defeated it just as thoroughly as a turn response that returned them.
//
// The mechanism is that {@link interviewTurnSchema} has no outcome field at
// all: a transcript turn carries who spoke, in which phase, what was said, and
// (for a civics officer turn) which question was read. There is nowhere to put
// a grade. `progress` carries `civicsAsked`/`civicsPlanned` and deliberately
// NOT `civicsCorrect` — "6 of 10 asked" is pacing, which a real interview also
// gives you; "4 of 6 correct" is a running score, which it does not.
//
// The debrief is the one shape that carries outcomes, and it is only ever
// populated once `status` is `completed`.
// =============================================================================

/** The interview's lifecycle state — `mock_interviews.status`. */
export const interviewStatusSchema = z.enum([
  'in_progress',
  'completed',
  'abandoned',
]);

/** Text or voice. `text` for every row this epic writes; E9/E11 wire the other. */
export const interviewModeSchema = z.enum(['text', 'voice']);

/**
 * One mock interview's header row.
 *
 * `passedCivics` is on the header rather than only in the debrief because it is
 * the column `readiness.service.ts` counts — `status: 'completed'` AND
 * `passedCivics: true` — and a list row that could not show it would make the
 * one number the readiness `interview` component is built from invisible on the
 * screen that lists interviews.
 *
 * It is `false` on every `in_progress` row, which is honest rather than
 * premature: the civics phase has not finished, so the learner has not passed
 * it. `mock_interviews.passed_civics` carries `@default(false)` for the same
 * reason.
 */
export const interviewSchema = z.object({
  id: z.uuid(),
  mode: interviewModeSchema,
  status: interviewStatusSchema,

  /** The bank and pass rule this interview was created against. */
  testVersionCode: z.string(),

  /**
   * Frozen at start time from the profile, never re-read at completion —
   * `mock_interviews.senior_exemption`'s own schema comment gives the reason:
   * which pair of columns on the version row governs this interview must not
   * change halfway through because the learner edited their profile in another
   * tab.
   */
  seniorExemption: z.boolean(),

  /** §8.1's per-interview choice, made before the interview started. */
  transcriptRetained: z.boolean(),

  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),

  civicsAsked: z.number().int(),
  civicsCorrect: z.number().int(),
  passedCivics: z.boolean(),
});

/**
 * One line of the transcript.
 *
 * `text` MAY BE EMPTY, AND EMPTY IS MEANINGFUL — `mock_interview_turns.text`'s
 * own schema comment says so, and §8.2 is the rule: with retention off, an
 * applicant turn is written with `text: ''` deliberately. The interview's
 * structure survives (a turn happened, in this phase, in this order, naming
 * this question) while the learner's own words do not.
 *
 * A client rendering a transcript must therefore treat an empty applicant turn
 * as "not kept", not as "said nothing" — the interview's own
 * `transcriptRetained` flag is what tells the two apart, which is why it is on
 * the header above.
 */
export const interviewTurnRecordSchema = z.object({
  id: z.uuid(),
  turnIndex: z.number().int(),
  role: z.enum(['officer', 'applicant']),
  phase: z.enum(INTERVIEW_PHASES),

  /** Set only on a civics OFFICER turn — which question was read. */
  questionId: z.uuid().nullable(),

  text: z.string(),
  createdAt: z.iso.datetime(),
});

/**
 * How far through the civics section this interview is.
 *
 * PACING, NEVER SCORE. See this file's header on why `civicsCorrect` is absent
 * from this object even though it is present on the header row: the header is
 * read by a list and by a completed-interview screen, and this object is what a
 * live interview renders beside the officer's turn.
 *
 * `civicsPlanned` is N from the version row. It is the number the ask-list was
 * drawn for, so a learner stopped early at 6 of 10 can still see that a full
 * run would have been 10 — which is the fact that makes the early stop legible
 * as a mechanic rather than as a bug.
 */
export const interviewProgressSchema = z.object({
  civicsAsked: z.number().int(),
  civicsPlanned: z.number().int(),
});

/**
 * What `POST /api/interviews` returns: the new interview and the officer's
 * opening turn.
 *
 * `awaitingCompletion` is false here by construction — an interview that had
 * run out of phases before its first turn would be an interview with no phases.
 * It is on the shape anyway because the same shape is embedded in the resume
 * payload below, where it is the flag that tells a client to show "finish" in
 * place of the answer box.
 */
export const interviewStateSchema = z.object({
  interview: interviewSchema,

  /**
   * The officer turns produced by this exchange, in order — usually one.
   *
   * AN ARRAY BECAUSE ONE EXCHANGE CAN PRODUCE SEVERAL. The reading and writing
   * phases consume no applicant answer (§2.4: one honest officer line each,
   * then the phase is over), and neither does the closing statement, so the
   * last civics answer of an interview is followed by three officer turns in a
   * row: "we do not do the reading test here", "we do not do the writing test
   * here", and the closing. A singular field would have forced either three
   * round-trips for turns nobody can reply to, or a concatenation that hid
   * which line belonged to which phase from the transcript.
   */
  officerTurns: z.array(interviewTurnRecordSchema),

  progress: interviewProgressSchema,

  /**
   * True once the engine has no further prompt: the only remaining action is
   * `POST /api/interviews/:id/complete` (§2.5).
   */
  awaitingCompletion: z.boolean(),
});

/**
 * What `GET /api/interviews/:id` returns — one route for a live interview and
 * for a finished one, the same "one route serves both live and historical
 * state" shape `GET /api/practice/sessions/{id}` already takes (§12).
 */
export const interviewDetailSchema = z.object({
  interview: interviewSchema,

  /** The whole transcript so far, oldest first. */
  turns: z.array(interviewTurnRecordSchema),

  progress: interviewProgressSchema,
  awaitingCompletion: z.boolean(),

  /**
   * The stored debrief, or null while the interview is not `completed`.
   *
   * READ OUT OF `mock_interviews.result`, never recomputed — that column is
   * written once at completion and is what makes a debrief re-readable months
   * later. §10 is why it is null before then: a debrief available mid-interview
   * would be the verdict no turn response is allowed to carry, reachable
   * through a second door.
   */
  debrief: interviewDebriefSchema.nullable(),
});

/**
 * A row in the caller's interview list.
 *
 * The header row and nothing else. No turn count, no per-question detail: §12's
 * reason for this endpoint is comparing attempts over time ("did I do better on
 * my second mock interview than my first"), and `civicsAsked`/`civicsCorrect`/
 * `passedCivics` on the header already answer that. A learner who wants the
 * detail opens the interview.
 */
export const interviewListItemSchema = interviewSchema;

export type InterviewStatus = z.infer<typeof interviewStatusSchema>;
export type InterviewResponse = z.infer<typeof interviewSchema>;
export type InterviewTurnRecord = z.infer<typeof interviewTurnRecordSchema>;
export type InterviewProgress = z.infer<typeof interviewProgressSchema>;
export type InterviewState = z.infer<typeof interviewStateSchema>;
export type InterviewDetail = z.infer<typeof interviewDetailSchema>;
export type InterviewListItem = z.infer<typeof interviewListItemSchema>;

export class InterviewDto extends createZodDto(interviewSchema) {}
export class InterviewTurnRecordDto extends createZodDto(
  interviewTurnRecordSchema,
) {}
export class InterviewStateDto extends createZodDto(interviewStateSchema) {}
export class InterviewDetailDto extends createZodDto(interviewDetailSchema) {}
export class InterviewListItemDto extends createZodDto(
  interviewListItemSchema,
) {}

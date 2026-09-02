import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { practiceAttemptSchema } from './practice-attempt.dto';
import { practiceQuestionSchema } from './practice-question.dto';

// =============================================================================
// Practice session response shapes (issue #73, epic #52)
// =============================================================================
//
// One session header, the summary computed at completion, the list row, and the
// three payloads the practice loop returns: create, resume/review, and graded
// attempt.
// =============================================================================

/**
 * The per-outcome tally computed at completion and persisted in
 * `practice_sessions.summary`.
 *
 * **Derived, never authoritative.** Every number here is aggregated from the
 * session's own `practice_attempts` rows at the moment `complete` is called —
 * nothing the client sent contributes to it, and nothing reads it to decide
 * whether an attempt was correct. It is a cached rendering so the summary
 * screen and the recent-sessions list do not re-aggregate on every read, which
 * is exactly what practice-sessions.md §2.1 says the column is for. If it ever
 * disagreed with the attempts, the attempts are right.
 */
export const practiceSessionSummarySchema = z.object({
  /** Copied from the session so the stored summary reads on its own. */
  plannedCount: z.number().int(),

  /** How many attempts the session actually produced. May be under `plannedCount`. */
  answered: z.number().int(),

  correct: z.number().int(),
  partial: z.number().int(),
  incorrect: z.number().int(),
  skipped: z.number().int(),

  /**
   * How many of the `correct` above were self-marked rather than matched.
   *
   * Broken out because "was it right" and "how do we know" are independent
   * facts (§9): a session of five correct answers, four of them self-marked, is
   * not the same evidence as five matched ones, and a summary that reported
   * only `correct` would flatten the difference E5 exists to weigh.
   */
  selfMarked: z.number().int(),

  /** How many attempts had the answer revealed at some point. */
  revealed: z.number().int(),

  /** How many opened a hint. */
  hintUsed: z.number().int(),

  /**
   * Total reported time, or null when NO attempt reported one.
   *
   * Null rather than 0, for the reason `durationMs` itself is nullable: zero
   * would be a claim that the session took no time. `timedAttempts` says how
   * many attempts the total actually covers, so a partial total cannot be
   * mistaken for a complete one.
   */
  totalDurationMs: z.number().int().nullable(),

  /** How many attempts contributed a duration to `totalDurationMs`. */
  timedAttempts: z.number().int(),
});

export const practiceSessionSchema = z.object({
  id: z.uuid(),

  /** `quick` or `category` — the two kinds E3 wires (§4). */
  kind: z.enum(['quick', 'category', 'review', 'weak', 'mixed']),

  /**
   * `in_progress` | `completed` | `abandoned`. There is deliberately no
   * `paused`: a learner who closes the tab is still `in_progress`, and nothing
   * downstream needs to tell that apart from one being answered right now (§5).
   */
  status: z.enum(['in_progress', 'completed', 'abandoned']),

  /**
   * The bank this session drew from, recorded ON THE SESSION rather than
   * derived from the learner's profile at read time — a profile's test version
   * can change (a corrected filing date), and a session must keep saying which
   * bank it actually drew from (§2.1).
   */
  testVersionCode: z.string(),

  /** Set only for `kind: 'category'`; null for every other kind. */
  categoryId: z.uuid().nullable(),

  plannedCount: z.number().int(),
  startedAt: z.iso.datetime(),

  /** Null while `in_progress`; stamped once on `completed` or `abandoned`. */
  completedAt: z.iso.datetime().nullable(),

  /** Null while `in_progress` — there is nothing to summarise yet (§2.1). */
  summary: practiceSessionSummarySchema.nullable(),
});

/**
 * A row of the recent-sessions list.
 *
 * Carries live counts alongside the stored `summary` rather than only the
 * summary, because an `in_progress` or `abandoned` session HAS no summary and
 * still has real attempts behind it — a learner who answered three of five and
 * left should see three, not a blank row.
 */
export const practiceSessionListItemSchema = practiceSessionSchema.extend({
  /** Attempts recorded, counted from the rows. */
  answeredCount: z.number().int(),

  /** Of those, how many are `outcome: 'correct'`, self-marked included. */
  correctCount: z.number().int(),
});

/**
 * How far through the session the learner is.
 *
 * `answered` is counted from the persisted attempts on every response, never
 * incremented client-side, so two tabs and a resumed session all agree.
 */
export const practiceProgressSchema = z.object({
  answered: z.number().int(),
  planned: z.number().int(),
});

/**
 * The create-session and resume payloads.
 *
 * `nextQuestion` is the PROMPT-ONLY shape — see `practice-question.dto.ts` on
 * why that is a separate type and not this one with the answers blanked. Null
 * when the session is finished or has nothing left to ask.
 */
export const practiceSessionStateSchema = z.object({
  session: practiceSessionSchema,
  nextQuestion: practiceQuestionSchema.nullable(),
  progress: practiceProgressSchema,
});

/** Resume or review: the session, everything recorded so far, and what's next. */
export const practiceSessionDetailSchema = practiceSessionStateSchema.extend({
  /** The session's attempts, oldest first — the order they were answered in. */
  attempts: z.array(practiceAttemptSchema),
});

/**
 * The graded-attempt payload.
 *
 * `acceptedAnswers` is here and NOWHERE EARLIER. This is the moment the answer
 * has been earned: the learner has produced a response (or skipped, or
 * revealed) and the attempt is recorded, so showing them what was accepted is
 * feedback rather than a hint. Returning it with the grade rather than on a
 * second request is what makes immediate feedback one round trip — and it is
 * the same list frozen into `attempt.answerSnapshot.answers`, so the screen and
 * the permanent record cannot disagree.
 */
export const practiceAttemptResultSchema = z.object({
  attempt: practiceAttemptSchema,

  /** What the grade was made against. Empty on `state_required`. */
  acceptedAnswers: practiceAttemptSchema.shape.answerSnapshot.shape.answers,

  /** The next unanswered question, prompt only, or null when the session is done. */
  nextQuestion: practiceQuestionSchema.nullable(),

  progress: practiceProgressSchema,
});

export type PracticeSessionSummary = z.infer<typeof practiceSessionSummarySchema>;
export type PracticeSessionResponse = z.infer<typeof practiceSessionSchema>;
export type PracticeSessionListItem = z.infer<
  typeof practiceSessionListItemSchema
>;
export type PracticeProgress = z.infer<typeof practiceProgressSchema>;
export type PracticeSessionState = z.infer<typeof practiceSessionStateSchema>;
export type PracticeSessionDetail = z.infer<typeof practiceSessionDetailSchema>;
export type PracticeAttemptResult = z.infer<typeof practiceAttemptResultSchema>;

export class PracticeSessionSummaryDto extends createZodDto(
  practiceSessionSummarySchema,
) {}
export class PracticeSessionDto extends createZodDto(practiceSessionSchema) {}
export class PracticeSessionListItemDto extends createZodDto(
  practiceSessionListItemSchema,
) {}
export class PracticeSessionStateDto extends createZodDto(
  practiceSessionStateSchema,
) {}
export class PracticeSessionDetailDto extends createZodDto(
  practiceSessionDetailSchema,
) {}
export class PracticeAttemptResultDto extends createZodDto(
  practiceAttemptResultSchema,
) {}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { JOURNEY_STAGE_KEYS } from '../journey-stages';
import { NEXT_ACTION_KINDS } from '../next-action';

// =============================================================================
// GET /api/journey/home — response body (issue #65, epic #50)
// =============================================================================
//
// `VISION.md` asks Home three questions — Where am I? What should I do next?
// Am I becoming more ready? — and this payload answers the first two from the
// server so that three different screens cannot answer them three ways.
//
// The third question is E6's, and E1 answers it honestly by not pretending to:
// see `dailyGoal.tracked` below.
// =============================================================================

/**
 * The daily goal widget's data.
 *
 * `tracked` IS LITERALLY `false` IN E1, AND THERE IS NO `minutesToday`.
 *
 * journey-shell.md §10 is the rule: a ring reading "0 of 5 minutes" because
 * nothing is tracked yet is INDISTINGUISHABLE from a learner who genuinely did
 * zero minutes today. The zero is technically accurate and functionally a lie,
 * because the learner has no way to tell the two apart. So this object carries
 * the goal the learner set — a real fact, which they chose — and an explicit
 * flag saying no session data exists, which is the honest empty state Home
 * renders instead of a fabricated number.
 *
 * When E7 lands session tracking it adds the measured field alongside and
 * flips `tracked`. A contributor tempted to add `minutesToday: 0` before then
 * has picked the branch §10 rules out.
 */
export const dailyGoalSchema = z.object({
  /** The learner's own target, from their profile. */
  minutes: z.number().int(),

  /**
   * Whether anything is actually being measured against that target. `false`
   * for the whole of E1 — no practice sessions exist to measure.
   */
  tracked: z.boolean(),
});

/** The one recommendation Home renders. See `next-action.ts`. */
export const nextActionSchema = z.object({
  /**
   * Enumerated from the recommender's own array, so a kind added in E3/E5/E8
   * widens this schema in the same edit.
   */
  kind: z.enum(NEXT_ACTION_KINDS),

  title: z.string(),
  reason: z.string(),

  /**
   * One of the recommender's hardcoded paths — never a value assembled from
   * user input, and never a route that redirects to `/`. That invariant is
   * enforced structurally by the closed `kind` union rather than by this
   * schema; see `next-action.ts` and journey-shell.md §4.1.
   */
  path: z.string(),
});

export const journeyHomeResponseSchema = z.object({
  /** One of the eight stage keys. The answer to "Where am I?". */
  stage: z.enum(JOURNEY_STAGE_KEYS as unknown as [string, ...string[]]),

  /** `YYYY-MM-DD`, or null when no interview is booked. */
  interviewDate: z.string().nullable(),

  /**
   * Whole CALENDAR days from today to the interview, in the learner's own
   * timezone; negative once the date has passed, null when none is set.
   *
   * COMPUTED SERVER-SIDE THROUGH `Clock.calendarDateIn`, never in a component
   * and never from elapsed milliseconds. journey-shell.md §4.4 and §9.1 both
   * insist this is a real server-computed integer: a browser dividing a
   * timestamp difference by 86 400 000 gets the wrong answer across a DST
   * boundary, and "13 days" versus "14 days" is not a rounding detail to
   * somebody counting down to their naturalization interview.
   */
  daysUntilInterview: z.number().int().nullable(),

  /**
   * Whether the interview date is already behind the learner.
   *
   * Sent as its own fact rather than left for a client to derive from a
   * negative `daysUntilInterview`, so every surface agrees on where the
   * boundary is. Today counts as NOT past.
   */
  interviewPast: z.boolean(),

  dailyGoal: dailyGoalSchema,
  nextAction: nextActionSchema,
});

export type JourneyHomeResponse = z.infer<typeof journeyHomeResponseSchema>;

export class JourneyHomeResponseDto extends createZodDto(
  journeyHomeResponseSchema,
) {}

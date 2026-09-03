import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/engagement/summary — response body (issue #119, epic #56 / E7)
// =============================================================================
//
// `docs/specs/habit-streaks.md` §4.6's field list, given a wire shape here —
// that section fixes the fields and explicitly leaves "a DTO's exact key
// casing... the implementing issue's own concern".
//
// Everything Home's goal ring, the streak badge and the session-end
// celebration (§8) need to stop rendering `journey-shell.md` §10's honest
// placeholder and start rendering the measured value it was always waiting
// for — and NOTHING readiness-shaped. There is no `score` here, no
// `capReason`, no component breakdown: engagement answers "am I consistently
// doing the work" and readiness answers "does the evidence indicate I am
// becoming prepared" (§1), and a client that could read one off the other
// would be the first step toward conflating them.
//
// `today` is always present, including for a learner with no `daily_activity`
// row yet — with honest zeros and `goalMet: false`, which is exactly true of a
// day nothing has happened on. A nullable `today` would make every consumer
// write the same zero-filling branch, and each one would be a place the ring
// could render "unknown" for a day whose answer is plainly "nothing yet".
// =============================================================================

const engagementDaySchema = z.object({
  /** `YYYY-MM-DD` — a LOCAL calendar day in `timezone`, never an instant (§3). */
  date: z.string(),
  practiceSeconds: z.number().int(),
  attempts: z.number().int(),
  correct: z.number().int(),
  /** Monotonic (§2.3): once true for a day, never false again — including after the learner raises their goal. */
  goalMet: z.boolean(),
});

const engagementRecentDaySchema = z.object({
  date: z.string(),
  goalMet: z.boolean(),
  /** True only for a day settlement covered with a freeze (§4.4) — a recorded freeze, never a fabricated practice day. */
  freezeUsed: z.boolean(),
  practiceSeconds: z.number().int(),
});

export const engagementSummarySchema = z.object({
  /** The learner's own `learner_profiles.daily_goal_minutes` — what the ring is measured against. */
  dailyGoalMinutes: z.number().int(),

  /** Today's row, or honest zeros for a day with no row yet. */
  today: engagementDaySchema,

  streak: z.object({
    /** Consecutive qualifying local days ending TODAY OR YESTERDAY (§4.1) — never `0` merely because the evening's session has not happened yet. */
    current: z.number().int(),
    /** The longest such run anywhere in this learner's history, not only the run touching today. */
    longest: z.number().int(),
  }),

  freezes: z.object({
    /** Held after this request's settlement. Presented as protection the learner already has, never a scarcity counter (§4.5). */
    remaining: z.number().int(),
    /** The ceiling (`STREAK_FREEZE_MAX`, `streaks/freeze-settlement.ts`), so a client never hardcodes it. */
    max: z.number().int(),
  }),

  /** The IANA zone every `date` above was computed in — the learner's own `learner_profiles.timezone`. */
  timezone: z.string(),

  /**
   * The last 14 local days, OLDEST FIRST, one entry per day whether or not a
   * row exists — a day with no row reports zeros, which is what actually
   * happened on it.
   */
  recentDays: z.array(engagementRecentDaySchema),
});

export type EngagementSummaryResponse = z.infer<typeof engagementSummarySchema>;

export class EngagementSummaryDto extends createZodDto(engagementSummarySchema) {}

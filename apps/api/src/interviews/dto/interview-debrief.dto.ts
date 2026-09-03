import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { INTERVIEW_PHASES } from '../engine';

// =============================================================================
// The debrief (issue #133, epic #57 / E8) — `docs/specs/mock-interview.md` §11
// =============================================================================
//
// What `POST /api/interviews/:id/complete` returns, and what
// `GET /api/interviews/:id` returns forever afterwards out of
// `mock_interviews.result`. §12 requires the second: a debrief that existed
// only as a one-time response to the call that produced it could not answer
// "did I do better on my second mock interview than my first", which is a real
// question this product should be able to answer.
//
// -----------------------------------------------------------------------------
// THE FIRST INFORMATION ABOUT PERFORMANCE THE LEARNER HAS SEEN
// -----------------------------------------------------------------------------
//
// §10: no verdict, no score, no hint, no correct/incorrect signal reaches the
// learner from any turn response. The engine knew whether an answer was right
// the instant it graded it, recorded that, used it to choose the next question
// and to run the stop rule — and never sent it. This object is the first place
// any of it exists where the learner can see it, which is why every field below
// is a fact and none of them is a characterisation.
//
// §11.1's copy rule, applied to the SHAPE rather than left to whoever writes
// the screen: name the questions, not the person. `focusAreas` is a list of
// category names computed from this interview's own attempts; there is no
// `weaknesses` string, no `assessment` paragraph, and no field a model wrote.
// `VISION.md`'s Product Principle 9 — "never patronize, shame, or underestimate
// the learner" — is easiest to hold when the response has nowhere to put a
// judgement.
//
// -----------------------------------------------------------------------------
// EVERY NUMBER HERE IS ECHOED FROM A ROW. NONE IS RE-DERIVED CLIENT-SIDE.
// -----------------------------------------------------------------------------
//
// `planned` and `threshold` come from the `civics_test_versions` row this
// interview was created against, carried through the engine's `InterviewPassRule`
// and written into this object. §11 is explicit about why the response carries
// them at all: "a client that hardcoded `6` would be exactly the 'a threshold
// in code is a threshold that will one day disagree with the seeded data'
// failure the issue's own problem statement names, reintroduced one layer up if
// the debrief re-typed the number instead of reading it back from the same row
// the engine read it from."
// =============================================================================

/** Why the civics phase ended — the engine's own `CivicsStopReason`, on the wire. */
export const interviewStopReasonSchema = z.enum([
  'threshold_reached',
  'threshold_unreachable',
  'all_asked',
]);

/**
 * The civics section's result.
 *
 * `asked` and `planned` are DIFFERENT NUMBERS whenever the early stop fired,
 * and that difference is the product feature §4.1 describes rather than an
 * accounting quirk: a real officer who has heard enough correct answers stops,
 * and so does one who has heard enough wrong ones. A learner seeing "6 of 10
 * asked" with `stopReason: 'threshold_reached'` is seeing the thing this epic
 * exists to rehearse.
 */
export const interviewCivicsResultSchema = z.object({
  /** N — how many questions the ask-list was drawn for. From the version row. */
  planned: z.number().int(),

  /** How many the early stop or the exhausted plan actually reached. */
  asked: z.number().int(),

  correct: z.number().int(),

  /** T — how many had to be correct. From the version row, never a constant. */
  threshold: z.number().int(),

  passed: z.boolean(),

  /** True when `asked < planned` — the stop rule fired before the plan ran out. */
  stoppedEarly: z.boolean(),

  stopReason: interviewStopReasonSchema,
});

/**
 * One civics question as it was actually asked and graded.
 *
 * `acceptedAnswers` COMES FROM THE FROZEN `answer_snapshot` ON THE ATTEMPT ROW,
 * never from a live re-query — §11 says so and `practice-sessions.md` §6 gives
 * the reason this whole product inherits: a `national`- or `state`-scope answer
 * changes by design, so re-resolving at read time would show a learner who
 * answered "who is the Speaker of the House" correctly in June a debrief
 * claiming they were wrong, because someone else holds the office now.
 *
 * `acceptedAnswers` survives with retention off. §8.2: the evidence of what
 * happened is kept regardless; what is withheld is the learner's own words.
 * That is what lets this array still say "accepted answers were: Congress,
 * legislative, …" for a learner who declined to keep their transcript.
 */
export const interviewDebriefQuestionSchema = z.object({
  questionId: z.uuid(),
  number: z.number().int(),
  prompt: z.string(),
  categoryName: z.string(),
  outcome: z.enum(['correct', 'partial', 'incorrect', 'skipped']),
  acceptedAnswers: z.array(z.string()),
});

/**
 * Each phase, and whether this rehearsal actually conducted it.
 *
 * `reading` and `writing` are `'skipped'` in text mode, and RECORDING that is
 * the point rather than a formality — §2.4 names the harm silence would cause:
 * a learner who reads a debrief listing only the four phases that ran "has no
 * way to tell 'this rehearsal did not cover reading and writing yet' apart from
 * 'OathPath forgot to mention reading and writing exist'". The first is an
 * honest, temporary product limitation. The second is a learner walking into
 * their real interview believing they rehearsed a segment they never saw.
 */
export const interviewPhaseStatusSchema = z.object({
  kind: z.enum(INTERVIEW_PHASES),
  status: z.enum(['completed', 'skipped']),
});

/**
 * The readiness recompute this completion triggered.
 *
 * READ BACK FROM `ReadinessService`, never computed here and never recomputed
 * on the client. §11: "the web renders these numbers; it never computes a pass
 * rule or a score of its own".
 *
 * `previousScore`/`delta` are null on a learner's very first snapshot — there
 * is no earlier score to compare against, and rendering `+0` would claim a
 * measurement nobody made.
 */
export const interviewReadinessSchema = z.object({
  score: z.number().int(),
  previousScore: z.number().int().nullable(),
  delta: z.number().int().nullable(),
  capReason: z.enum(['typed_only']).nullable(),

  /**
   * The fixed cap copy, verbatim, when `capReason` is non-null — and null
   * otherwise.
   *
   * READ BACK OFF THE SNAPSHOT'S OWN `topRecommendation.reason` rather than
   * re-typed here. `readiness/top-recommendation.ts`'s `cappedRecommendation()`
   * is where that sentence lives, quoted from `PRD.md` by way of
   * `readiness-model.md` §3; a second literal in this file would be a second
   * place the product's own words could drift from themselves, which is exactly
   * what §11's "verbatim" is asking us not to do.
   */
  capMessage: z.string().nullable(),

  /** The `interview` component (§2.8) — `min(mockInterviewsPassed / 2, 1)`. */
  interviewComponent: z.object({
    value: z.number(),
    /** `mockInterviewsPassed` — completed interviews with `passedCivics`. */
    evidenceCount: z.number().int(),
  }),
});

export const interviewDebriefSchema = z.object({
  civics: interviewCivicsResultSchema,
  questions: z.array(interviewDebriefQuestionSchema),
  phases: z.array(interviewPhaseStatusSchema),

  /**
   * Category names with at least one non-`correct` outcome in THIS interview.
   *
   * DETERMINISTIC, NO MODEL CALL — §11 states this outright, and it is the same
   * kind of plain aggregation `study-coach.ts`'s `reviewCount` already is.
   * Asking a model to "summarise the learner's weak areas" would put a
   * non-reproducible sentence into the one response §5.3 requires to be
   * explainable, and would risk the characterisation §11.1 forbids.
   */
  focusAreas: z.array(z.string()),

  readiness: interviewReadinessSchema,
});

export type InterviewStopReason = z.infer<typeof interviewStopReasonSchema>;
export type InterviewCivicsResult = z.infer<typeof interviewCivicsResultSchema>;
export type InterviewDebriefQuestion = z.infer<
  typeof interviewDebriefQuestionSchema
>;
export type InterviewPhaseStatus = z.infer<typeof interviewPhaseStatusSchema>;
export type InterviewReadinessSummary = z.infer<typeof interviewReadinessSchema>;
export type InterviewDebrief = z.infer<typeof interviewDebriefSchema>;

export class InterviewDebriefDto extends createZodDto(interviewDebriefSchema) {}

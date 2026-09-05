import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { readinessTopRecommendationSchema } from '../../readiness/dto/readiness-snapshot.dto';
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

  /**
   * How this answer reached the officer — `practice_attempts.input_mode`,
   * echoed (issue #160, epic #60 / E11).
   *
   * ONE INTERVIEW CAN CARRY BOTH VALUES, which is the reason this is per
   * question rather than one flag on the debrief. `realtime-interview.md` §7
   * has a learner whose connection drops fall back to the text transport with
   * the same interview id and no loss of progress, so the honest record of a
   * half-spoken interview is exactly this: the answers that were spoken say
   * so, and the ones that were typed say so, because that is what the rows
   * say.
   */
  inputMode: z.enum(['typed', 'spoken']),

  /**
   * True when this answer's row carries `failure_cause: 'misheard'` — the
   * recogniser was not confident it heard what was said (§4.2,
   * `voice.md` §3).
   *
   * A SEPARATE FIELD FROM `outcome`, NEVER A NINTH OUTCOME VALUE. The
   * attempt row keeps both facts and so does this: `outcome` is what the
   * grading ladder concluded about the words it was given, and this is
   * whether we believe those were the learner's words. Collapsing the two
   * would lose the case the distinction exists for — a low-confidence
   * transcript that scored `correct` anyway, which is recorded normally and
   * is not a mishearing at all (`isMisheardAttempt`'s own third condition).
   */
  misheard: z.boolean(),

  /**
   * `practice_attempts.asr_confidence` — the number the flag above was
   * concluded from, so a reader of the debrief can see the evidence rather
   * than take the verdict on faith.
   *
   * NULL MEANS UNKNOWN AND NEVER LOW, the identical reading the column and
   * the tool argument both already carry. Null on every typed answer, and
   * also on a spoken one from a provider that reported no confidence.
   */
  asrConfidence: z.number().nullable(),
});

/**
 * How the spoken half of this interview went — issue #160, epic #60 / E11,
 * `docs/specs/realtime-interview.md` §6 and §8.
 *
 * -----------------------------------------------------------------------------
 * THREE COUNTS OVER THIS INTERVIEW'S OWN ATTEMPT ROWS, AND NOTHING ELSE
 * -----------------------------------------------------------------------------
 *
 * Every one of them is a `practice_attempts` row this interview wrote, counted:
 * `answers` is the rows carrying `input_mode: 'spoken'`, `correct` is those of
 * them whose `outcome` is `correct`, and `misheard` is those carrying
 * `failure_cause: 'misheard'`. There is no field here for how fluent the
 * learner sounded, how nervous they seemed, or how the conversation felt —
 * §4.2 discards any verdict the model implied, and a "spoken performance"
 * summary assembled from the model's impression would let that verdict back in
 * through a door the tool contract closed. If it is not on a row, it is not
 * here.
 *
 * `correct` IS EXACTLY WHAT READINESS'S `spoken` COMPONENT COUNTS
 * (`readiness-engine.ts`'s `computeSpoken`, over `input_mode: 'spoken' AND
 * outcome: 'correct'`), which is what lets the readiness band on this same page
 * be explainable: the learner can see the answers that produced the movement,
 * on the same screen as the movement. §8 is why no readiness code changed for
 * that — a realtime interview credits `spoken` and `interview` both, because it
 * writes into the identical rows every other source of that evidence writes
 * into.
 *
 * ALL THREE ARE `0` ON A TEXT INTERVIEW, and the object is still present. An
 * absent block and a block of zeros are the same fact here — no answer was
 * spoken — and a nullable field would only give a renderer two ways to say it.
 */
export const interviewSpokenSummarySchema = z.object({
  /** `practice_attempts` rows from this interview with `input_mode: 'spoken'`. */
  answers: z.number().int(),

  /** Of those, the ones graded `correct` — the `spoken` component's own evidence. */
  correct: z.number().int(),

  /** Of those, the ones carrying `failure_cause: 'misheard'`. */
  misheard: z.number().int(),
});

/**
 * One conducted English segment — the reading or the writing test, as it was
 * actually scored (issue #160; `realtime-interview.md` §5,
 * `english-test.md` §5).
 *
 * -----------------------------------------------------------------------------
 * READ OFF AN `english_attempts` ROW, WHICH IS THE ONLY PLACE THIS EVIDENCE LIVES
 * -----------------------------------------------------------------------------
 *
 * §5: "never a `practice_attempts` row, because reading and writing evidence
 * has always lived in its own table". So a segment result is not one of the
 * `questions` above and never will be — the two are different tables because
 * they measure different things, and merging them in the response would ask the
 * screen to render a word-error rate beside an accepted-answers list.
 *
 * A SEGMENT THE INTERVIEW DID NOT CONDUCT IS ABSENT, never an entry with zeros:
 * `phases` is where "this rehearsal did not include the reading test" is said,
 * in the words §2.4 requires, and saying it twice in two shapes invites the two
 * to disagree.
 *
 * A MISHEARD READING ATTEMPT IS ABSENT TOO, AND THAT IS NOT AN OMISSION.
 * `english-test.md` §3 writes NO row for a reading transcript the recogniser
 * did not trust — `misheard` there is the ABSENCE of a recorded failure, the
 * one place this codebase diverges from `practice_attempts` — so there is
 * genuinely nothing stored for this object to be built from, and inventing an
 * entry saying "you were misheard while reading" would be this debrief's only
 * claim not traceable to a row. What a learner sees instead is the attempt they
 * did complete, because the officer asks again.
 */
export const interviewSegmentResultSchema = z.object({
  kind: z.enum(['reading', 'writing']),

  /** `english_attempts.outcome` — three values, no `skipped` (`english-test.md` §5). */
  outcome: z.enum(['correct', 'partial', 'incorrect']),

  /**
   * The sentence itself, from `english_sentences.text`.
   *
   * SHOWN HERE EVEN FOR THE WRITING SEGMENT, and that is the rule rather than
   * an exception to it: `english.service.ts` calls the post-attempt sentence
   * "the REVEAL — the first time the learner sees the sentence they were
   * dictated". The never-shown invariant governs the interview screen, before
   * the answer is scored; a debrief is read afterwards, and a learner who
   * cannot see what they were asked to write cannot learn anything from having
   * missed it.
   */
  sentence: z.string(),

  /**
   * The word error rate the outcome was computed from — `english_attempts.wer`.
   *
   * Carried so the screen can report a near miss as one. It is NOT re-derived
   * into a percentage, a grade or a characterisation anywhere; `outcome` is the
   * verdict, and this is the measurement behind it.
   */
  wer: z.number(),
});

/**
 * Each phase, and whether this rehearsal actually conducted it.
 *
 * `reading` and `writing` are `'skipped'` in text mode — and, since issue #160,
 * `'completed'` on a realtime interview that actually conducted them
 * (`realtime-interview.md` §5). The status is decided from THIS interview's own
 * scored segment attempts, never from `mock_interviews.mode`: a voice interview
 * whose connection dropped before the reading test, or one whose learner had
 * already exhausted the sentence bank, conducted no more of it than a text
 * interview did, and a mode flag would report otherwise.
 *
 * RECORDING the skip is the point rather than a formality — §2.4 names the harm silence would cause:
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

  /**
   * The `spoken` component (§2.7) — `min(distinctQuestionsCorrectSpoken / 20, 1)`
   * (issue #160, epic #60 / E11).
   *
   * -----------------------------------------------------------------------------
   * THE SECOND HALF OF WHY A VOICE INTERVIEW WEIGHS MORE, ON THE SCREEN THAT
   * EARNED IT
   * -----------------------------------------------------------------------------
   *
   * `realtime-interview.md` §8: `interview` counts a pass regardless of
   * transport, while `spoken` counts distinct questions answered correctly with
   * `input_mode: 'spoken'`. A realtime interview credits BOTH; a typed one
   * credits only the first. Until this field existed, the debrief showed the
   * half that does not distinguish them and hid the half that does — so a
   * learner who had just spent twenty minutes answering aloud saw the identical
   * readiness band a typed rehearsal produces, with the extra credit they had
   * genuinely earned nowhere on the page. `PRD.md` requires the score to be
   * explainable; a component that moved and was not shown is the specific way
   * it stops being.
   *
   * `evidenceCount` is `distinctQuestionsCorrectSpoken` — the learner's
   * lifetime count across all sources, NOT this interview's own. That is the
   * number the component is computed from, and this object reports components.
   * How many of them came from this interview is `spoken.correct` on the
   * debrief itself, and the two are deliberately different questions.
   */
  spokenComponent: z.object({
    value: z.number(),
    /** `distinctQuestionsCorrectSpoken` — lifetime, across every source. */
    evidenceCount: z.number().int(),
  }),

  /**
   * The snapshot's own `topRecommendation` — the single next action the
   * readiness engine produced for this learner (issue #160).
   *
   * -----------------------------------------------------------------------------
   * THE SCHEMA IS IMPORTED FROM `readiness/dto`, NEVER RESTATED
   * -----------------------------------------------------------------------------
   *
   * A second declaration of these four fields would be a second place they can
   * drift from the object `ReadinessService` actually returns, which is the
   * same argument `ai-model-roles.ts` and `notification-events.ts` both make
   * for reading a registry over the wire instead of copying it. It is a
   * one-line import, and it is the whole guarantee.
   *
   * `PRD.md` requires a readiness score to be explainable AND paired with a
   * next action. The debrief carried the explanation and ended on a generic
   * pair of buttons; this is the action, chosen by the engine from this
   * learner's own weighted headroom (`top-recommendation.ts` §8.2) rather than
   * by whoever wrote the screen. Note the rule that file states about itself
   * and this field inherits: a recommendation must POINT AT the destination it
   * names, which is why `path` travels with the copy rather than being decided
   * by the client.
   */
  recommendation: readinessTopRecommendationSchema,
});

export const interviewDebriefSchema = z.object({
  civics: interviewCivicsResultSchema,
  questions: z.array(interviewDebriefQuestionSchema),

  /** How the spoken half went, counted off this interview's own attempt rows. */
  spoken: interviewSpokenSummarySchema,

  /**
   * The English segments this interview actually conducted and scored, in
   * `INTERVIEW_PHASES` order (reading before writing).
   *
   * EMPTY FOR EVERY TEXT INTERVIEW, which is every interview E8 ever ran: the
   * two phases are announced and skipped there, and `phases` below is where
   * that is said.
   */
  segments: z.array(interviewSegmentResultSchema),

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
export type InterviewSpokenSummary = z.infer<typeof interviewSpokenSummarySchema>;
export type InterviewSegmentResult = z.infer<typeof interviewSegmentResultSchema>;
export type InterviewReadinessSummary = z.infer<typeof interviewReadinessSchema>;
export type InterviewDebrief = z.infer<typeof interviewDebriefSchema>;

export class InterviewDebriefDto extends createZodDto(interviewDebriefSchema) {}

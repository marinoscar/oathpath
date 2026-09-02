import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { MAX_RESPONSE_LENGTH } from '../answer-matching';

// =============================================================================
// POST /api/practice/sessions/:id/attempts — request body (#73, epic #52)
// =============================================================================
//
// One attempt at one question: what the learner typed, whether they skipped,
// whether they had already seen the answer, and how long it took them.
//
// -----------------------------------------------------------------------------
// THE CLIENT REPORTS WHAT HAPPENED. IT NEVER REPORTS THE VERDICT.
// -----------------------------------------------------------------------------
//
// There is no `outcome`, no `correct`, no `gradingMethod` and no `score` here,
// and the compile-time proof at the bottom of this file keeps it that way.
// Grading is `matchAnswer` (practice-sessions.md §7) run on the server against
// the answers resolved at that instant, and the ONLY route by which a learner's
// own judgement enters the record is the separate, explicit self-mark endpoint
// — which records `gradingMethod: 'self'` precisely so E5's mastery model can
// weigh it differently (§9). A `correct: true` accepted here would make that
// distinction unrecordable: an asserted pass would be indistinguishable in the
// evidence table from a verified one, and "verified, not assumed" is the rule
// the whole readiness model rests on.
//
// `revealed`, `hintUsed`, `durationMs` and `skipped` ARE client-reported, and
// that is not the same concession. They are facts about the learner's own
// session that the server has no other way to observe — it cannot see that a
// hint was opened — and each of them can only ever WEAKEN the evidence a
// correct answer provides (§9.1). A client that lied about them would be
// understating its own learner's recall, which is the harmless direction.
// =============================================================================

export const recordAttemptSchema = z
  .strictObject({
    /**
     * Which question this attempt answers.
     *
     * Checked in the service against the session's own scope — its test
     * version, and its category when it has one — so an attempt cannot record
     * evidence for a question the session was never drawing from.
     */
    questionId: z.uuid(),

    /**
     * The learner's raw, unmodified input. Stored verbatim; normalisation
     * happens only inside the matcher and is never written back.
     *
     * Bounded at {@link MAX_RESPONSE_LENGTH}, the same 2000 characters
     * `matchAnswer` declines to look past. The matcher reports a longer
     * response `incorrect` rather than throwing, so this bound is not about
     * protecting the grader — it is about what gets STORED: `response_text` is
     * `@db.Text` with no schema-level bound, and there is no reason to keep a
     * megabyte of pasted text in the evidence table that no grader, debrief or
     * mastery computation will ever read. A 400 naming the field tells the
     * learner something true and fixable; silently storing it does not.
     */
    responseText: z.string().max(MAX_RESPONSE_LENGTH).optional(),

    /**
     * Wall-clock milliseconds from question shown to submit.
     *
     * Optional, and ABSENT rather than `0` when the client cannot report one —
     * a resumed session after a page reload has no start instant to measure
     * from. `0` would be a claim, and a false one: that the learner answered
     * instantly. Same reasoning `ai_usage_events` gives for nullable token
     * counts (practice-sessions.md §2.2).
     */
    durationMs: z.number().int().min(0).optional(),

    /**
     * The learner moved on without answering.
     *
     * Recorded, never dropped: `outcome: 'skipped'` with `responseText: null`.
     * A skip is real evidence — it is what "I have no idea" looks like — and
     * discarding it would leave the readiness model unable to tell a question
     * a learner keeps avoiding from one they have never been shown.
     */
    skipped: z.boolean().default(false),

    /**
     * The learner had the accepted answer in front of them for this question.
     *
     * Independent of `outcome`: revealing does not make a wrong answer right,
     * and a correct answer that was revealed first is weaker recall evidence
     * than one produced cold (§9.1). It is also the precondition for
     * self-marking — see the self-mark route.
     */
    revealed: z.boolean().default(false),

    /**
     * The learner opened a hint before submitting.
     *
     * Distinct from `revealed`: a hint narrows the field without giving the
     * answer away, so a correct outcome with `hintUsed: true` is real but
     * weaker evidence — "weaker evidence, not disqualified evidence"
     * (§9.1). Nothing in E3 reads it; E5's evidence weighting is the first
     * reader, and the fact cannot be reconstructed after the fact, which is
     * exactly why it is captured now.
     */
    hintUsed: z.boolean().default(false),
  })
  .superRefine((body, ctx) => {
    // A skip with text in it is a contradiction the server would have to
    // resolve silently — and either resolution loses something. Storing the
    // text against `outcome: 'skipped'` records a response nobody submitted;
    // dropping it throws away what the learner typed. Rejecting says which one
    // the client meant to send, which is the only honest answer.
    if (body.skipped && body.responseText !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['responseText'],
        message:
          'A skipped attempt carries no response — send skipped: true with no responseText, or send the response without skipped',
      });
    }
  });

export type RecordAttemptInput = z.infer<typeof recordAttemptSchema>;

export class RecordAttemptDto extends createZodDto(recordAttemptSchema) {}

// -----------------------------------------------------------------------------
// Compile-time proof that the client cannot send a verdict or an identity
// -----------------------------------------------------------------------------
//
// If you are here because this line went red: you are letting the request state
// its own result. Grading happens in `PracticeService` through `matchAnswer`,
// and the one path by which a learner's own judgement is recorded is the
// self-mark route, which stamps `gradingMethod: 'self'` so it can be weighed.

type ForbiddenAttemptFieldNames =
  | 'userId'
  | 'user_id'
  | 'id'
  | 'sessionId'
  | 'outcome'
  | 'correct'
  | 'isCorrect'
  | 'score'
  | 'gradingMethod'
  | 'answerSnapshot'
  | 'answeredAt'
  | 'source';

export type RecordAttemptNamesNoVerdict = Extract<
  keyof RecordAttemptInput,
  ForbiddenAttemptFieldNames
> extends never
  ? true
  : never;

export const RECORD_ATTEMPT_NAMES_NO_VERDICT: RecordAttemptNamesNoVerdict = true;

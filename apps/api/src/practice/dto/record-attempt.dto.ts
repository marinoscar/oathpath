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
//
// -----------------------------------------------------------------------------
// THE FIVE VOICE FIELDS (issue #104, epic #58 / E9) ARE THE SAME CATEGORY
// -----------------------------------------------------------------------------
//
// `inputMode`, `promptMode`, `transcript`, `asrConfidence` and
// `retryOfAttemptId` are all facts about the learner's own session that the
// server cannot observe for itself, for one concrete reason: **the recording
// never reaches it.** Audio is transcribed and discarded at the point of
// capture (`docs/specs/voice.md` §4, and `schema.prisma`'s own "NO COLUMN HERE
// CAN HOLD AUDIO" block on `PracticeAttempt`), so there is no server-side
// artefact from which "was this spoken", "was the prompt heard", "what did the
// recogniser return" or "how sure was it" could ever be reconstructed. Not
// capturing them now means they are gone.
//
// NONE OF THEM STATES A RESULT, and the one that comes closest —
// `asrConfidence` — is deliberately not one. It says how sure the RECOGNISER
// was about the text, never whether the ANSWER was right; the server alone
// turns a low value into `failure_cause: 'misheard'`, after grading, in
// `PracticeService.recordAttempt`. A client-supplied `failureCause` (or a
// `misheard` boolean) would be a verdict by another name — which is why both
// are named in the forbidden list at the bottom of this file.
//
// And a client that lied about them still fails in the harmless direction:
// claiming `spoken` when a learner typed, or a low confidence when the
// recogniser was certain, can only route an attempt to `misheard` — a cause
// that never makes an answer count as correct and never advances mastery. It
// cannot manufacture a pass.
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

    // -------------------------------------------------------------------------
    // Voice (issue #104, epic #58 / E9). See this file's header for why these
    // five are client-reported and why none of them is a verdict.
    // -------------------------------------------------------------------------

    /**
     * How the learner produced this answer: typed at a keyboard, or spoken
     * aloud and transcribed.
     *
     * `default('typed')` rather than required, and that default is doing real
     * work: every client written before E9 keeps sending exactly the body it
     * always sent and keeps meaning exactly what it always meant. Making it
     * required would turn a new capability into a breaking change to the one
     * route the whole practice loop runs through.
     *
     * Recorded, not derived. `transcript` being present might look like it
     * could stand in for this, but it cannot: a learner who spoke, was
     * transcribed, and then cleared the box and typed their answer instead is
     * a `typed` attempt with a recognition behind it, and only the client was
     * there to see which happened. E6's `spoken` readiness component counts
     * distinct questions answered correctly with `inputMode: 'spoken'`, so
     * this field is what a "can you do this out loud?" signal is built from —
     * a guess here would be a guess in the readiness score.
     */
    inputMode: z.enum(['typed', 'spoken']).default('typed'),

    /**
     * How the QUESTION reached the learner: read on screen, or heard aloud.
     *
     * Independent of {@link inputMode}, and the four combinations are all
     * real: read-and-typed (the pre-E9 shape), heard-and-spoken (the closest
     * rehearsal of the actual interview), heard-and-typed (a learner
     * practising listening comprehension without speaking on a bus), and
     * read-and-spoken (a learner who wants to hear themselves answer). None
     * of the four is inferable from the other field, so both are stored.
     */
    promptMode: z.enum(['read', 'heard']).default('read'),

    /**
     * For a spoken attempt: the text the learner CONFIRMED they said.
     *
     * NOT the raw recogniser output as it came back — the confirmed text,
     * after the confirm-before-grade step (`docs/specs/voice.md` §3) in which
     * the learner sees the transcription and may edit it before anything is
     * graded. That step is the whole anti-penalty mechanism behind VISION.md
     * line 228's promise that a learner is never "unfairly penalized for
     * accent or speech-recognition errors", and storing words the learner
     * never agreed they said would make the column that is supposed to prove
     * the promise into the one that breaks it. The column's own comment in
     * `schema.prisma` states the same rule.
     *
     * Bounded at {@link MAX_RESPONSE_LENGTH} for the identical storage reason
     * `responseText` is, one field up — `transcript` is `@db.Text` with no
     * schema-level bound either.
     *
     * Sent ALONGSIDE `responseText`, not instead of it. They hold the same
     * string on a spoken attempt today; they are two fields because they
     * answer two questions that merely happen to share an answer right now —
     * "what was graded" and "what came back from the recogniser and was
     * confirmed" — and a later epic that grades something other than the
     * confirmed transcript must not have to guess which one a historical row
     * meant.
     */
    transcript: z.string().max(MAX_RESPONSE_LENGTH).optional(),

    /**
     * The recogniser's own confidence in that transcription, in `[0, 1]`.
     *
     * -------------------------------------------------------------------------
     * ABSENT MEANS UNKNOWN. ABSENT IS NOT ZERO.
     * -------------------------------------------------------------------------
     *
     * Optional with no default, and a client that has no confidence to report
     * MUST omit it rather than send `0` — several transcription models (the
     * `gpt-4o-transcribe` family among them) report no confidence at all, so
     * "we do not have one" is an ordinary case, not an error. A defaulted `0`
     * would be a claim, and a specific, confident-sounding false one: that
     * the recogniser was certain it heard nothing. That claim is not inert —
     * it is below `ASR_CONFIDENCE_THRESHOLD`, so it would route a perfectly
     * good answer to `failure_cause: 'misheard'`. A defaulted `1` fails in
     * the mirror direction, silently exempting every unscored transcription
     * from that check. `null` is the only honest value, and it is the one the
     * column stores (`schema.prisma`, `asrConfidence`).
     *
     * It is NOT a verdict, and that distinction is what lets it be
     * client-reported at all: it describes how sure the RECOGNISER was about
     * the TEXT, never whether the answer was right. The server decides what a
     * low value means, after grading — see `PracticeService.recordAttempt`.
     */
    asrConfidence: z.number().min(0).max(1).optional(),

    /**
     * This attempt is a retry of an earlier attempt at the SAME question in
     * the SAME session, which it supersedes.
     *
     * The one legitimate second attempt at a question inside one session
     * (`docs/specs/voice.md` §3.3): a learner whose answer was misheard is
     * offered another go, and the corrected answer is written as a NEW row
     * linked back to the original rather than as an edit of it. The original
     * survives as the honest record that a mishearing happened; the retry is
     * the actual evidence of whether the learner knew the answer.
     *
     * The id is not taken on trust. `recordAttempt` admits it only when it
     * names an attempt belonging to this caller, this session and this
     * question, which is not itself a retry and has not already been
     * superseded — anything else is the 409 the one-attempt-per-question
     * guard has always thrown. See that method for the full argument.
     *
     * NOT restricted to a spoken attempt: `voice.md` §3.1's own worked example
     * has the learner answering the retry by typing it ("or they type it"),
     * and refusing that would force a learner whose microphone keeps failing
     * to abandon the question entirely.
     */
    retryOfAttemptId: z.uuid().optional(),
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

    // -------------------------------------------------------------------------
    // The voice fields have to agree with each other, and a 400 is the only
    // honest way to say they do not (issue #104, epic #58 / E9)
    // -------------------------------------------------------------------------
    //
    // Every rule below rejects a body whose fields make two incompatible
    // claims about the same event. The alternative — accepting it and letting
    // the server pick a winner — writes a row into the evidence table that
    // describes something that did not happen, and `practice_attempts` is the
    // one table in this product that E5, E6, E7 and E8 all read as fact.

    // A typed attempt has no recognition step, so there is nothing for either
    // field to be about. Silently dropping them would be worse than it looks:
    // `asrConfidence` is the input to the `misheard` mapping, so a stray low
    // value on a typed attempt would attribute a wrong answer to a recogniser
    // that never ran — the exact "manufactured diagnosis" the failure-cause
    // taxonomy exists to prevent (`docs/specs/ai-evaluation.md` §8).
    if (body.inputMode === 'typed' && body.transcript !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['transcript'],
        message:
          'A transcript belongs to a spoken attempt — send inputMode: "spoken", or send the attempt without a transcript',
      });
    }

    if (body.inputMode === 'typed' && body.asrConfidence !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['asrConfidence'],
        message:
          'asrConfidence belongs to a spoken attempt — send inputMode: "spoken", or send the attempt without it',
      });
    }

    // A spoken attempt that was actually answered MUST say what was heard and
    // confirmed. Without it the row claims a recognition happened and keeps no
    // record of what came out of it, which makes the confirm-before-grade
    // promise (§3) unauditable after the fact — the one property the column
    // was added to make checkable.
    if (
      body.inputMode === 'spoken' &&
      !body.skipped &&
      body.transcript === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['transcript'],
        message:
          'A spoken attempt must carry the transcript the learner confirmed — send it, or send skipped: true',
      });
    }

    // The same contradiction the `responseText` rule above rejects, one field
    // over: a skip is the learner declining to answer, so there is no
    // confirmed transcript of an answer they never gave.
    if (body.skipped && body.transcript !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['transcript'],
        message:
          'A skipped attempt carries no transcript — send skipped: true with no transcript, or send the transcript without skipped',
      });
    }

    // And no confidence either, for the same reason plus a sharper one: a
    // confidence score is only ever ABOUT a transcript, and `recordAttempt`
    // maps a low one onto `failure_cause: 'misheard'` for any outcome that is
    // not `correct` — `skipped` included. Rejecting the pair here is what
    // keeps a learner who pressed "skip" from being told a recogniser
    // mishears them, which is a story about themselves that nothing observed.
    if (body.skipped && body.asrConfidence !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['asrConfidence'],
        message:
          'A skipped attempt carries no asrConfidence — there was no answer to transcribe',
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
  | 'source'
  // ---------------------------------------------------------------------------
  // E9's three (issue #104, epic #58)
  // ---------------------------------------------------------------------------
  //
  // `failureCause` is WHY an answer missed — a diagnosis of the learner,
  // written only after the server has graded the response, and the most
  // consequential single value in the row for what a debrief tells somebody
  // about themselves. `docs/specs/ai-evaluation.md` §8 is explicit that a
  // cause must be READ from a signal rather than guessed; a client-supplied
  // one is a guess with no signal behind it at all, and would let a client
  // put `misheard` on any wrong answer it wanted excused.
  //
  // `transcriptConfidence` and `misheard` are named because they are the two
  // shapes the same mistake takes when it is not called `failureCause`. The
  // first is a plausible-looking near-miss for `asrConfidence` that a future
  // contributor could add beside it without noticing there are now two
  // fields feeding one threshold; the second is the verdict itself wearing a
  // boolean. The threshold comparison lives on the server
  // (`ASR_CONFIDENCE_THRESHOLD`, `PracticeService.recordAttempt`) precisely
  // so a client reports the measurement and never the conclusion.
  | 'failureCause'
  | 'transcriptConfidence'
  | 'misheard';

export type RecordAttemptNamesNoVerdict = Extract<
  keyof RecordAttemptInput,
  ForbiddenAttemptFieldNames
> extends never
  ? true
  : never;

export const RECORD_ATTEMPT_NAMES_NO_VERDICT: RecordAttemptNamesNoVerdict = true;

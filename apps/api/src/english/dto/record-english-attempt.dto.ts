import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { MAX_RESPONSE_LENGTH } from '../../practice/answer-matching';

// =============================================================================
// POST /api/english/attempts — request body (issue #136, epic #59 / E10)
// =============================================================================
//
// One reading or writing attempt at one sentence: the text the learner produced
// and, for a reading attempt, how sure the recogniser was about it.
//
// -----------------------------------------------------------------------------
// THE CLIENT REPORTS WHAT HAPPENED. IT NEVER REPORTS THE VERDICT.
// -----------------------------------------------------------------------------
//
// The same rule `practice/dto/record-attempt.dto.ts` states for a civics
// attempt, restated here because this is a different table with a different
// scorer and inheriting the reasoning silently is how it gets lost. There is no
// `outcome`, no `wer`, no `diffOps` and no `errors` field here, and the
// compile-time proof at the bottom of this file keeps it that way: scoring is
// `scoreEnglishAttempt` (english-test.md §2) run on the server against the
// sentence's own text, and there is no self-mark escape hatch on this surface
// at all — unlike practice, where a learner may assert a match the matcher
// missed, "I did read that sentence correctly" is not a judgement a learner is
// positioned to make about their own pronunciation.
//
// `kind` is not a field either, and that one is not about verdicts: the segment
// is a property of the SENTENCE (`english_sentences.kind`), read from the row
// the id names. A client-supplied `kind` could disagree with it, and the
// disagreement would land in `english_attempts.kind` — the column the `english`
// readiness component groups by (§6) — where it would quietly credit reading
// evidence for a writing attempt.
//
// -----------------------------------------------------------------------------
// `asrConfidence` IS A MEASUREMENT, NOT A VERDICT — WHICH IS WHY IT IS HERE
// -----------------------------------------------------------------------------
//
// It says how sure the RECOGNISER was about the text, never whether the reading
// was right. The server alone compares it against `ASR_CONFIDENCE_THRESHOLD`
// and decides what a low value means, in `EnglishService.recordAttempt`, AFTER
// scoring — see that method for the three conditions.
//
// The reason it can be client-reported at all is that the recording never
// reaches the server: audio is transcribed and discarded at the point of
// capture (`docs/specs/voice.md` §4, and `schema.prisma`'s own "NO
// STORAGE/AUDIO COLUMN HERE" block on `EnglishAttempt`), so there is no
// server-side artefact from which the recogniser's confidence could be
// reconstructed. Not capturing it now means it is gone.
//
// And a client that lied about it fails in the harmless direction: a fabricated
// low confidence can only route an attempt to `misheard`, which writes NO ROW
// AT ALL (§3). It cannot manufacture a pass, and it cannot manufacture a
// recorded failure either.
// =============================================================================

// `z.strictObject`, so `{ "userId": "…" }` or `{ "outcome": "correct" }` is a
// 400 NAMING the key rather than something silently dropped. There is no user
// id on this route by any means; a client that sent one should learn that
// immediately instead of believing it worked.
export const recordEnglishAttemptSchema = z.strictObject({
    /**
     * Which sentence this attempt answers.
     *
     * Loaded server-side; a missing sentence is a 404. Its `kind` and its
     * `text` — the scoring reference — both come from that row, never from
     * this body.
     */
    sentenceId: z.uuid(),

    /**
     * The text actually scored: exactly what the learner typed (writing), or
     * the transcript they CONFIRMED (reading).
     *
     * Never the raw, unedited recogniser output — the confirm-before-grade step
     * (`docs/specs/voice.md` §3, reused verbatim by english-test.md §3) is the
     * whole anti-penalty mechanism behind VISION.md's promise that a learner is
     * never penalised for an accent, and storing words the learner never agreed
     * they said would make the column that proves the promise the one that
     * breaks it.
     *
     * REQUIRED, unlike practice's `responseText`. There is no `skipped` here to
     * be the other branch: english-test.md §5.1 is explicit that a declined
     * segment produces no row at all, so a request that reaches this endpoint
     * is by definition an attempt with text behind it. An empty string is
     * permitted and scores honestly — every reference token deleted, `wer` of
     * `1`, `incorrect` — because a learner who submitted nothing did submit
     * nothing.
     *
     * Bounded at {@link MAX_RESPONSE_LENGTH}, imported rather than retyped:
     * `english_attempts.response_text` is `@db.Text` with no schema-level
     * bound, and there is no reason to keep a megabyte of pasted text in an
     * evidence table no scorer, progress rollup or readiness computation will
     * ever read past the first 200 tokens of (`MAX_ALIGNED_TOKENS`).
     */
    responseText: z.string().max(MAX_RESPONSE_LENGTH),

    /**
     * The recogniser's own confidence in that transcript, in `[0, 1]`.
     *
     * -------------------------------------------------------------------------
     * ABSENT MEANS UNKNOWN. ABSENT IS NOT ZERO.
     * -------------------------------------------------------------------------
     *
     * Optional with NO DEFAULT, and a client that has no confidence to report
     * MUST omit it rather than send `0`. Several transcription models (the
     * `gpt-4o-transcribe` family among them) report none at all, so "we do not
     * have one" is an ordinary case. A defaulted `0` would be a specific,
     * confident-sounding false claim — that the recogniser was certain it heard
     * nothing — and it is not inert: it sits below `ASR_CONFIDENCE_THRESHOLD`,
     * so it would route every unscored transcription to `misheard` and a
     * learner would never get a row recorded at all. `ASR_CONFIDENCE_THRESHOLD`'s
     * own doc states the rule this field obeys: "Unknown is not low."
     *
     * READING ONLY. A writing attempt carrying one is a 400 raised in the
     * service, not here, because only the sentence row knows the kind — see
     * `EnglishService.recordAttempt`.
     */
    asrConfidence: z.number().min(0).max(1).optional(),

    /**
     * How many times the learner asked to hear the dictated sentence again
     * before submitting (§4).
     *
     * NOTHING IS GATED ON THIS, EVER. No limit is enforced, no outcome changes,
     * and no screen may show it back as a penalty. It is recorded because
     * needing four repeats is itself a signal worth having about listening
     * comprehension — a signal for later coaching copy, never one that grades
     * the attempt it is attached to. §4 makes the reason explicit and VISION.md
     * line 389 is the rule behind it: penalising replays would punish exactly
     * the honest, information-seeking behaviour (asking to hear it again rather
     * than guessing) this product should want.
     *
     * `default(0)` rather than optional-and-null: zero replays is a real,
     * ordinary measurement, not an absence, and a client that never implements
     * the replay button is truthfully reporting none.
     *
     * WRITING ONLY. A reading sentence is read from the screen, so there is no
     * dictation prompt to replay; a non-zero count on a reading attempt is a
     * 400 in the service, for the same reason `asrConfidence` on a writing
     * attempt is.
     */
    replayCount: z.number().int().min(0).default(0),
});

export type RecordEnglishAttemptInput = z.infer<
  typeof recordEnglishAttemptSchema
>;

export class RecordEnglishAttemptDto extends createZodDto(
  recordEnglishAttemptSchema,
) {}

// -----------------------------------------------------------------------------
// Compile-time proof that the client cannot send a verdict or an identity
// -----------------------------------------------------------------------------
//
// The same device `record-attempt.dto.ts` uses, aimed at this table's own
// vocabulary. If you are here because this line went red: you are letting the
// request state its own result, or letting it name whose result it is.
//
// The six names, and why each is on the list rather than merely absent:
//
//   `outcome`   — the verdict itself. §2.3's compound rule is computed from the
//                 alignment, on the server; a client-supplied one would make
//                 every `english_attempts` row an assertion instead of a
//                 measurement, and the `english` readiness component (§6) reads
//                 those rows as fact.
//   `wer`       — the verdict wearing a number. `wer` is stored precisely so a
//                 later reader can see how close an `incorrect` attempt was
//                 (§5.2); a supplied one would be an unfalsifiable claim about
//                 a computation that never ran.
//   `diffOps`   — the verdict wearing a data structure, and the one a UI
//                 renders. It is exactly what the alignment already produced —
//                 accepting one would mean storing a diff that need not
//                 correspond to the text beside it in the same row.
//   `userId`    — whose attempt this is. `@CurrentUser('id')` is the only
//                 source of a user id on this whole module, which is what makes
//                 cross-user writes structurally impossible rather than
//                 checked.
//   `kind`      — read from `english_sentences.kind`. See this file's header:
//                 a client-supplied kind could disagree with the sentence's own
//                 and would land in the column readiness groups by.
//   `answeredAt`— when. From the injected `Clock` (CLAUDE.md's "Using the
//                 Clock"), so a `X-Test-Clock` header pins it in a test and
//                 nothing else can. A client-supplied timestamp would let an
//                 attempt be backdated into — or out of — §6.1's rolling 30-day
//                 readiness window.

type ForbiddenEnglishAttemptFieldNames =
  | 'outcome'
  | 'wer'
  | 'diffOps'
  | 'diff'
  | 'errors'
  | 'userId'
  | 'user_id'
  | 'id'
  | 'kind'
  | 'answeredAt'
  | 'misheard';

export type RecordEnglishAttemptNamesNoVerdict = Extract<
  keyof RecordEnglishAttemptInput,
  ForbiddenEnglishAttemptFieldNames
> extends never
  ? true
  : never;

export const RECORD_ENGLISH_ATTEMPT_NAMES_NO_VERDICT: RecordEnglishAttemptNamesNoVerdict =
  true;

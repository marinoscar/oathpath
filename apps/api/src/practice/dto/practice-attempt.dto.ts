import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { coachReactionSchema } from '../../ai/dto/coach-reaction.dto';
import { gradingVerdictSchema, GRADING_FAILURE_CAUSES } from '../grading';
import { practiceQuestionSchema } from './practice-question.dto';

// =============================================================================
// A recorded attempt, and the answer snapshot frozen with it (#73, epic #52)
// =============================================================================
//
// This is the read shape of one `practice_attempts` row — the table epic #52
// calls "the single evidence table for the whole product". E5 reads it for
// mastery, E6 for readiness, E7 for engagement, and E8 writes into it with
// `source: 'mock_interview'`. On the wire it is also what a debrief screen
// renders, months or years after the attempt happened.
// =============================================================================

/**
 * One accepted answer, exactly as it stood when the attempt was graded.
 *
 * `sourceNote` is deliberately not copied in. The snapshot's job is to record
 * WHAT the learner was graded against, and the citation for a fact is a live
 * property of the current `civics_answers` row (readable at
 * `GET /api/civics/questions/:id`), not part of the verdict. Freezing it too
 * would grow every attempt row for a field no debrief renders.
 */
export const practiceSnapshotAnswerSchema = z.object({
  id: z.uuid(),

  /** The accepted answer's text, verbatim, as of grading time. */
  text: z.string(),

  /** Which slot it occupied among simultaneously correct answers. */
  sort: z.number().int(),

  /** The state it applied to, or null for a national or static answer. */
  stateCode: z.string().nullable(),

  /** When a human last verified this exact text — copied, not re-read. */
  verifiedAt: z.iso.datetime(),
});

// -----------------------------------------------------------------------------
// WHY THIS IS FROZEN AND NEVER RE-RESOLVED AT READ TIME
// -----------------------------------------------------------------------------
//
// practice-sessions.md §6 is the full argument; the short version is that a
// `national`- or `state`-scope answer's text CHANGES by design. civics-content.md
// §4 never edits one in place — a correction closes the old row and opens a new
// one — so re-running resolution when a debrief is opened would grade every past
// attempt against whichever answer is open today.
//
// The concrete failure that prevents: a learner answers "who is the Speaker of
// the House" correctly in June 2026, a new Speaker is sworn in the following
// January, and their debrief now reads "you answered Jane Q. Doe; the correct
// answer is John R. Roe" for a question they got RIGHT. That is not a debrief.
// It is the product telling a learner they used to know something they still
// know — on an application whose entire premise is building accurate confidence.
//
// So the snapshot is written once, at grading time, from the answers the grade
// was actually made against, and read back whole forever. It is a plain `Json`
// column for the same reason `SystemSettings.value` is: a document with a stable
// shape, read as a unit, never queried on its internal fields.
export const practiceAnswerSnapshotSchema = z.object({
  /**
   * The instant resolution ran — `Clock.now()`, never a wall-clock read.
   *
   * Distinct from the attempt's `answeredAt` in principle (they are the same
   * request, so the same pinned instant in practice) and kept inside the
   * document so the snapshot explains itself without its row: a reader holding
   * only this JSON can say which moment's answers these were.
   */
  resolvedAt: z.iso.datetime(),

  /**
   * Whether the answers below are this learner's answers, and if not, why.
   *
   * `state_required` is civics-content.md §5's fourth row, frozen: a
   * `state`-scope question graded for a learner with no `state_code`. The
   * answer list is EMPTY and the attempt is recorded `skipped` — never
   * `incorrect`, because the learner was not wrong; we could not resolve what
   * right was. A debrief reading this can honestly say "you hadn't set your
   * state yet" instead of "there was no correct answer to this question,"
   * which would be a lie about the question.
   *
   * Practice never SELECTS such a question (see `question-selection.ts`), so
   * this value only appears when a client posted a question id it was not
   * handed. It is recorded rather than rejected because the attempt happened.
   */
  answerResolution: z.enum(['resolved', 'state_required']),

  /** The state the answers were resolved for, or null. */
  resolvedForStateCode: z.string().nullable(),

  /**
   * EVERY answer the resolver returned at that moment, not only the one that
   * matched.
   *
   * A `none`-scope question has several simultaneously correct answers ("name
   * one branch of the government" has three); keeping only the matched one
   * would discard real information a debrief renders — "you said Congress; the
   * President and the courts were also accepted."
   *
   * Note what is NOT stored beside them: which answer matched, and by which
   * rule. Both are recoverable exactly, at any time, by re-running the pure
   * `matchAnswer` over `responseText` and this frozen list — the matcher takes
   * no clock, no database and no configuration, so it returns the same verdict
   * forever. Freezing the INPUTS to a deterministic function is what makes
   * storing its outputs redundant; the verdict the product acts on lives in the
   * row's own `outcome`/`gradingMethod` columns, where a query can reach it.
   */
  answers: z.array(practiceSnapshotAnswerSchema),
});

export const practiceAttemptSchema = z.object({
  id: z.uuid(),

  /** The enclosing session, or null for an attempt with none (E8's shape). */
  sessionId: z.uuid().nullable(),

  questionId: z.uuid(),

  /** The question's prompt, so a review screen needs no second round trip. */
  question: practiceQuestionSchema,

  /**
   * `practice` for everything this epic writes. `mock_interview` is E8's, into
   * this same table rather than a parallel one (practice-sessions.md §3).
   */
  source: z.enum(['practice', 'mock_interview']),

  /**
   * How the learner produced this answer.
   *
   * Written from the request since E9 (issue #104, epic #58); every row from
   * before it reads `typed`, which is what those attempts were.
   */
  inputMode: z.enum(['typed', 'spoken']),

  /** How the question reached them — read on screen, or heard aloud (E9). */
  promptMode: z.enum(['read', 'heard']),

  /** The learner's raw input, or null for a skip. Never normalised in place. */
  responseText: z.string().nullable(),

  /**
   * `correct` | `partial` | `incorrect` | `skipped`.
   *
   * `partial` is declared and unreachable from E3's grading path: exact match
   * plus normalisation is binary by construction, and weighing a response's
   * MEANING against a multi-part answer is exactly E4's semantic grader
   * (practice-sessions.md §8).
   */
  outcome: z.enum(['correct', 'partial', 'incorrect', 'skipped']),

  /**
   * Who or what made the call — `exact` | `self` | `ai`.
   *
   * Read together with `outcome`, never merged into it. "Was it right" and
   * "how do we know" are independent facts: a summary tally needs only the
   * first, and E5's mastery model must discount the second, which is the whole
   * reason a `self_correct` outcome value was rejected (§9).
   */
  gradingMethod: z.enum(['exact', 'self', 'ai']),

  /** The learner saw the accepted answer for this question. */
  revealed: z.boolean(),

  /** The learner opened a hint before submitting. */
  hintUsed: z.boolean(),

  /** Milliseconds, or null when the client could not report one. Never 0. */
  durationMs: z.number().int().nullable(),

  // ---------------------------------------------------------------------------
  // The AI grading rung's output — all three NULL TOGETHER (issue #116, E4)
  // ---------------------------------------------------------------------------
  //
  // A DETERMINISTICALLY GRADED ATTEMPT CARRIES NULL FOR ALL THREE. That is the
  // normal case, not a degraded one: `gradingMethod: 'exact'` (a match, a skip,
  // or a miss whose grading call was unavailable or failed) and
  // `gradingMethod: 'self'` never produce any of these values.
  //
  // ONE EXCEPTION, ADDED BY E9 (issue #104, epic #58), and it is a real one
  // rather than a caveat: `failureCause: 'misheard'` is written by the SERVER
  // from `asrConfidence`, with `aiFeedback` and `aiUsageEventId` null, because
  // no model was involved in reaching it. A client must therefore not treat a
  // non-null `failureCause` as proof that a grader ran — `gradingMethod` is
  // the field that answers that, and it still does.
  //
  // Nullable rather than optional, for the reason the whole ladder exists: a
  // client that received an ABSENT field could reasonably render a placeholder
  // cause or a "why did I miss this?" panel with nothing behind it, and the one
  // thing this product must not do is show a learner a diagnosis of themselves
  // that no grader ever made. `null` is a value a client can branch on; a
  // missing key is a shape it has to guess about.

  /**
   * Why the response missed, when a grader ran — never a guess.
   *
   * NULL AND `unknown` ARE DIFFERENT ANSWERS, and both reach the wire. Null
   * means no grader ran; `unknown` means one ran and honestly could not tell
   * (schema.prisma, `PracticeFailureCause`). A client collapsing them would be
   * treating "never asked" and "asked and told nothing conclusive" as the same
   * fact about a learner.
   *
   * All six values are declared because the column has six. `misheard` and
   * `nervous` are E9's and E8's — nothing in this epic writes either, and
   * `grading.ts` coerces a model that offers one to `unknown` — but a row from
   * a later epic must not be unrenderable by a client built today.
   */
  failureCause: z.enum(GRADING_FAILURE_CAUSES).nullable(),

  /**
   * The grader's structured verdict, verbatim, and nothing else.
   *
   * THE SAME SCHEMA THE MODEL'S REPLY WAS VALIDATED AGAINST — imported, not
   * restated — so the shape stored, the shape validated and the shape served
   * cannot drift into three shapes. Never the prompt, never a raw completion:
   * see the column's own comment in schema.prisma.
   */
  aiFeedback: gradingVerdictSchema.nullable(),

  /**
   * The `ai_usage_events` row this attempt's grading call produced.
   *
   * Present so a verdict can be traced to what it cost. Null both when no call
   * was made and when the usage write itself failed — the attempt is the
   * evidence, the usage row is accounting for it, and the evidence is never
   * held back for the accounting.
   */
  aiUsageEventId: z.uuid().nullable(),

  // ---------------------------------------------------------------------------
  // Voice (issue #104, epic #58 / E9)
  // ---------------------------------------------------------------------------

  /**
   * For a spoken attempt: the text the learner confirmed they said.
   *
   * Null for a typed attempt and for a skip — there was no recognition step to
   * record. Distinct from `responseText` on purpose; see the column's own
   * comment in `schema.prisma` and the request DTO's.
   */
  transcript: z.string().nullable(),

  /**
   * The recogniser's confidence for that transcription, in `[0, 1]`.
   *
   * NULL MEANS UNKNOWN AND IS NEVER 0. Not every transcription model reports
   * one, so null is ordinary rather than an error — and a client must not fill
   * it in, because below `ASR_CONFIDENCE_THRESHOLD` is what the server reads
   * as a probable mishearing.
   *
   * On the wire so a client can explain ITS OWN behaviour to itself, never so
   * it can be shown to a learner as a number: "41% confident" is a diagnostic
   * detail a naturalization-interview learner has no way to act on
   * (`docs/specs/voice.md` §3.1). What they see is the transcript, editable.
   */
  asrConfidence: z.number().min(0).max(1).nullable(),

  /**
   * The earlier attempt this one supersedes, or null.
   *
   * Set only on a retry (`voice.md` §3.2). The attempt it names stays in the
   * table and is still returned by `GET /api/practice/sessions/:id` — it is
   * evidence that a mishearing happened — but it is excluded from that
   * response's `progress.answered` and from the session's stored summary, so
   * a mishearing and its correction read as one answered question. A review
   * screen renders the pair from this link.
   */
  retryOfAttemptId: z.uuid().nullable(),

  /** When the attempt resolved, from the server's own `Clock`. */
  answeredAt: z.iso.datetime(),

  /** See {@link practiceAnswerSnapshotSchema}. Frozen, never re-resolved. */
  answerSnapshot: practiceAnswerSnapshotSchema,

  // ---------------------------------------------------------------------------
  // The coach's reaction (issue #320, epic #305 / E14)
  // ---------------------------------------------------------------------------
  //
  // ON THE ATTEMPT ITSELF, NOT ONLY ON THE `POST .../attempts` WRAPPER, and
  // that placement is the whole point rather than a convenience. This schema
  // is what `GET /api/practice/sessions/{id}` returns for every recorded
  // attempt, so putting the field here is what makes the re-read path carry a
  // reaction at all — and the re-read path is where
  // `docs/specs/coach-personality.md` §7's determinism guarantee is actually
  // observable: the same attempt, live and on the summary screen, shows the
  // same line. A field only on the immediate response would have made that
  // guarantee untestable and, for a learner, untrue.
  //
  // NOT PERSISTED. No column is added to `practice_attempts` for it, and none
  // will be — see `coach-reaction.dto.ts`'s header and §9. It is derived, on
  // every read, from the row's own `outcome`/`gradingMethod`/`failureCause`,
  // the learner's persona setting, and the row's id as the seed.
  //
  // `null` when the learner has turned reactions off (`coach.reactions ===
  // false`). A client renders NOTHING for that — not a placeholder, and not a
  // reserved empty region.

  /** One line in the learner's chosen voice, or null. See above. */
  coachReaction: coachReactionSchema.nullable(),
});

export type PracticeSnapshotAnswer = z.infer<typeof practiceSnapshotAnswerSchema>;
export type PracticeAnswerSnapshot = z.infer<typeof practiceAnswerSnapshotSchema>;
export type PracticeAttemptResponse = z.infer<typeof practiceAttemptSchema>;

export class PracticeAttemptDto extends createZodDto(practiceAttemptSchema) {}

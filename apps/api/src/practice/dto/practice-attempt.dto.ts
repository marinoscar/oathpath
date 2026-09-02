import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

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

  /** `typed` for everything this epic writes; `spoken` waits for E9. */
  inputMode: z.enum(['typed', 'spoken']),

  /** `read` for everything this epic writes; `heard` waits for E9. */
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

  /** When the attempt resolved, from the server's own `Clock`. */
  answeredAt: z.iso.datetime(),

  /** See {@link practiceAnswerSnapshotSchema}. Frozen, never re-resolved. */
  answerSnapshot: practiceAnswerSnapshotSchema,
});

export type PracticeSnapshotAnswer = z.infer<typeof practiceSnapshotAnswerSchema>;
export type PracticeAnswerSnapshot = z.infer<typeof practiceAnswerSnapshotSchema>;
export type PracticeAttemptResponse = z.infer<typeof practiceAttemptSchema>;

export class PracticeAttemptDto extends createZodDto(practiceAttemptSchema) {}

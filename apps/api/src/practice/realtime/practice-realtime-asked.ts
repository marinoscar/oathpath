// =============================================================================
// Which question this connection was told to say (issue #354, epic #345 / E15)
// =============================================================================
//
// A tiny, bounded, in-process map from a practice session id to the question
// this API last handed a realtime model to speak — its id AND its exact words.
//
// -----------------------------------------------------------------------------
// WHY IT EXISTS: THE SELECTOR IS DELIBERATELY NOT DETERMINISTIC
// -----------------------------------------------------------------------------
//
// It is tempting to think a practice session needs no memory of what it asked,
// because `PracticeService.getSession` already reports a `nextQuestion` and a
// question stays "next" until it is answered. It does not.
// `mastery/selector.ts` shuffles — with real, unseeded randomness, on purpose
// ("determinism where it matters is bought by injecting the shuffle, not by
// seeding it", its own header) — so `nextQuestion` is a FRESH DRAW on every
// read. Two reads a second apart legitimately name two different questions,
// with nothing wrong anywhere.
//
// That makes the derived `nextQuestion` unusable as an identity for the
// question the coach actually spoke, and the consequence of using it anyway
// would land on the learner: they answer the question they heard, the draw has
// since moved, and `decideGradeAnswer` refuses their answer as naming the
// wrong question. So the question in the air is remembered, here, by the one
// thing that knows it — the code that handed it over.
//
// THE PROMPT IS STORED TOO, not just the id, and that is what makes
// `repeat_question` honest: it returns the same words, not a fresh lookup that
// could have been re-resolved in between. It is also what keeps this directory
// free of any database access at all (`practice-realtime-purity.spec.ts`).
//
// -----------------------------------------------------------------------------
// WHAT IT HOLDS, AND WHY IT IS THE WHOLE QUESTION (issue #402)
// -----------------------------------------------------------------------------
//
// It used to hold an id and a prompt, because those were the two things the
// MODEL needed. The screen needs the same fact and was resolving it
// independently — `PracticeSessionPage` rendered `GET /api/practice/sessions/:id`'s
// own `nextQuestion`, which, per the paragraph above, is a fresh draw. So the
// learner read one question and was asked another aloud, from the first
// question of every spoken session onward, and answered the one they could
// hear. Nothing was mis-graded (the answer is recorded against the question the
// ledger names, which is the spoken one), but the screen was lying about which
// question was outstanding.
//
// The entry is therefore the whole `PracticeQuestion` — the SAME prompt-only
// object `getSession` would have returned — so the tool result can carry it out
// to the browser and the screen can render exactly what the coach was handed.
// A `PracticeQuestion` is answer-free by construction and carries its own
// compile-time proof of that (`dto/practice-question.dto.ts`), which is why
// widening this entry costs no new argument about what a ledger may hold.
//
// -----------------------------------------------------------------------------
// IN-PROCESS, AND WHY THAT IS THE RIGHT PLACE FOR IT
// -----------------------------------------------------------------------------
//
// The alternative was a column (or a `practice_session_turns` table) recording
// each serve. Rejected, and not only because this issue forbids a migration: a
// durable row per spoken question would be a second account of the session's
// progress, able to disagree with `practice_attempts` — the hazard
// `PracticeService` avoids by computing `answered` from the rows every time,
// and the one `conversation-mode.md` §14 cites for rejecting a session-level
// `mode` column. Nothing durable depends on this fact, and nothing durable is
// lost when it goes.
//
// -----------------------------------------------------------------------------
// WHAT HAPPENS WHEN IT IS WRONG, WHICH IT IS ALLOWED TO BE
// -----------------------------------------------------------------------------
//
//   * IT FORGOT (a process restart, a second replica, a connection re-minted
//     after a drop). Every tool that needs a question in the air is refused —
//     `grade_answer` and `skip_question` with `no_answer_outstanding`,
//     `repeat_question` likewise — and each refusal's instruction is "call
//     next_question and say what it returns". The learner is asked a question
//     again (possibly a different one, since the draw is random) and answers
//     that instead. One turn is spent; NOTHING IS RECORDED WRONG, and nothing
//     already recorded is affected — every attempt was committed before the
//     connection dropped.
//
//     This is the honest floor rather than a shortcoming to engineer away: a
//     re-minted connection has genuinely lost the conversation, and no
//     server-side record of "what was spoken aloud" exists to restore it from
//     without inventing the durable second account rejected above.
//
//   * IT REMEMBERS TOO MUCH (the question it holds has since been answered —
//     a duplicate that raced, an attempt recorded by another transport).
//     {@link PracticeRealtimeAskedLedger.outstanding} takes the session's own
//     answered question ids and drops a remembered entry that appears among
//     them, so a stale entry resolves to "nothing outstanding" on its own with
//     no invalidation call to get wrong. Without that check a stale entry would
//     deadlock the session: `next_question` refused because an answer is
//     outstanding, and `grade_answer` refused as a duplicate, for ever.
//
// -----------------------------------------------------------------------------
// BOUNDED, WITH NO CLOCK
// -----------------------------------------------------------------------------
//
// One entry per session, overwritten in place, capped at
// {@link ASKED_LEDGER_MAX_ENTRIES}; the oldest insertion is dropped when the
// cap is passed (`Map` iterates in insertion order, so the first key is the
// oldest).
//
// A TTL was the obvious alternative and was rejected: it would need `Clock`
// injected into a structure that otherwise has no notion of time, purely to
// expire entries whose expiry costs exactly what an eviction costs — the "it
// forgot" case above. A size cap is what actually bounds memory, and it does so
// without a second thing to test.
// =============================================================================

import type { PracticeQuestion } from '../dto/practice-question.dto';

/**
 * How many sessions' served questions are remembered at once.
 *
 * Sized for concurrent realtime CONNECTIONS, not for sessions in the database:
 * an entry exists only between one `next_question` and the answer that follows
 * it, and every realtime connection is a learner with a live microphone paying
 * their own provider by the minute. A few thousand of those simultaneously is
 * far past anything this deployment shape reaches, and the cost of the cap
 * being hit is a redundant spoken question, not an error.
 */
export const ASKED_LEDGER_MAX_ENTRIES = 4096;

/**
 * What was handed over: the prompt-only question, exactly as it was served.
 *
 * AN ALIAS RATHER THAN A NARROWER STRUCT OF ITS OWN. The two consumers want
 * different halves of it — the model wants `prompt` (that is what
 * `repeat_question` says back), the screen wants `number` and `prompt` — and a
 * struct holding a subset would be a third description of one row, free to
 * disagree with both. `PracticeQuestion` is already the shape this application
 * serves a question in, and already carries the proof that it can never grow an
 * answer field.
 */
export type AskedQuestion = PracticeQuestion;

/**
 * The questions realtime connections have been told to say but not yet had
 * answered.
 *
 * A CLASS RATHER THAN A MODULE-LEVEL `Map`, so a test constructs its own and
 * two tests cannot leak state into each other — and so the eviction rule has
 * somewhere to live that is not a comment.
 */
export class PracticeRealtimeAskedLedger {
  private readonly served = new Map<string, AskedQuestion>();

  /** How many sessions are currently remembered. Exposed for its own test. */
  get size(): number {
    return this.served.size;
  }

  /** Remember the question, and its words, handed to this session's model. */
  record(sessionId: string, question: AskedQuestion): void {
    // DELETE FIRST, so re-serving a session's question moves it to the end of
    // the insertion order. Without it a long conversation's entry would keep
    // its original position and could be evicted while still live, in front of
    // sessions that have been idle since.
    this.served.delete(sessionId);
    this.served.set(sessionId, question);

    if (this.served.size > ASKED_LEDGER_MAX_ENTRIES) {
      const oldest = this.served.keys().next();
      if (!oldest.done) this.served.delete(oldest.value);
    }
  }

  /**
   * The question this session is waiting on, or null.
   *
   * `answeredQuestionIds` is the session's own recorded attempts, from
   * `PracticeService.getSession`. A remembered question that appears among them
   * has been answered — by a call that raced this one, or on another transport
   * — and is dropped here rather than returned. See this file's header on why
   * that self-healing check is what keeps a stale entry from deadlocking a
   * session.
   */
  outstanding(
    sessionId: string,
    answeredQuestionIds: ReadonlySet<string>,
  ): AskedQuestion | null {
    const remembered = this.served.get(sessionId);

    if (remembered === undefined) return null;

    if (answeredQuestionIds.has(remembered.id)) {
      this.served.delete(sessionId);
      return null;
    }

    return remembered;
  }

  /** Forget this session's question: it has been answered, skipped, or ended. */
  clear(sessionId: string): void {
    this.served.delete(sessionId);
  }
}

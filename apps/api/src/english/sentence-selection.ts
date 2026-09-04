import type { EnglishScoreOutcome } from './english-scoring';

// =============================================================================
// Which sentence comes next (issue #136, epic #59 / E10)
// =============================================================================
//
// `docs/specs/english-test.md` §7 leaves "the exact `next` sentence-selection
// algorithm (which sentence, avoiding recent repeats)" to this issue. This file
// is that decision, and nothing else: rows in, one row out.
//
// A standalone, pure module for the reason `practice/question-selection.ts`,
// `civics/answer-resolution.ts` and this epic's own `english-scoring.ts` all
// give: the rule must never drift, so it lives in exactly one named file,
// unit-tested directly over plain objects, with nothing else allowed to hold a
// second opinion about it. It imports one TYPE and nothing else — no
// `@nestjs/*`, no Prisma client, no `Clock`.
//
// -----------------------------------------------------------------------------
// DETERMINISTIC, WITH NO RANDOMNESS ANYWHERE — DELIBERATELY UNLIKE PRACTICE
// -----------------------------------------------------------------------------
//
// `question-selection.ts` shuffles inside each group, and states why: two
// learners with identical histories should not be handed identical Quick 5s.
// This module does the opposite, and the difference is a property of the
// content, not a change of mind. There are 36 seeded sentences, ~18 per kind,
// against a civics bank of 100+ questions — a bank that small is not a pool to
// sample from, it is a short list to walk. Walking it in a stated order means:
//
//   1. a learner sees every untried sentence before repeating any sentence,
//      which is the acceptance criterion this ordering exists to satisfy;
//   2. the sentence they got wrong three days ago comes back before the one
//      they passed yesterday, without a scheduler, a due date, or a second
//      table — the ordering IS the review policy at this size;
//   3. a test can assert the exact sentence, not "one of these", so a
//      regression in the bucket order fails rather than reshuffles.
//
// If this bank ever grows to civics's size, ordering alone stops being a
// sufficient review policy and the answer is `question_mastery`'s own scheduler
// (E5), not a shuffle bolted on here.
//
// -----------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------------------------------------------------------
//
// No spaced repetition, no `due_at`, no ease factor. `english_attempts` has no
// mastery sibling table (`english-test.md` §5's own "no `sessionId`, no
// session" note is the same restraint one table over), and inventing a weaker
// scheduler here would mean a later epic arrives to find two of them competing,
// with the worse one already deciding what learners see.
// =============================================================================

/**
 * The columns selection actually reads. Deliberately narrower than the row —
 * `text`, `vocabTags` and the provenance columns play no part in choosing.
 */
export interface SelectableSentence {
  readonly id: string;
  /** The vocabulary-list revision this sentence was composed against. */
  readonly version: string;
  /** Display/selection order within `(kind, version)`. */
  readonly ordinal: number;
}

/**
 * One prior attempt, as this module needs it.
 *
 * Kind is NOT a field here: the caller filters by kind in the `where` of the
 * query that loads these, so every row reaching this function is already the
 * right kind. A `kind` field would be a second place that filter could be got
 * wrong, and the wrong one would be silent — a reading attempt aging a writing
 * sentence out of the untried bucket.
 */
export interface SentenceAttemptRecord {
  readonly sentenceId: string;
  readonly outcome: EnglishScoreOutcome;
  readonly answeredAt: Date;
}

/**
 * Compare two vocabulary-revision strings, newest LAST.
 *
 * Natural order, not lexicographic: the versions in
 * `english-sentences.json` are `v1`-shaped, and plain string comparison would
 * put `v10` before `v2` — a revision that silently serves the wrong bank on the
 * tenth edit of a file nobody expects to be edited often. Digit runs compare as
 * numbers, everything else compares as text, so `v2` < `v10` and `v1` < `v1a`.
 *
 * Exported for its own test: this is the one piece of {@link selectNextSentence}
 * that fails invisibly rather than loudly.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string): string[] => value.match(/\d+|\D+/g) ?? [];
  const left = parts(a);
  const right = parts(b);

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;

    const bothNumeric = /^\d+$/.test(l) && /^\d+$/.test(r);
    if (bothNumeric) {
      const diff = Number(l) - Number(r);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }

    if (l !== r) return l < r ? -1 : 1;
  }

  return 0;
}

/**
 * The newest vocabulary revision present among these sentences, or `null` when
 * there are none.
 *
 * Selection and progress BOTH call this rather than each resolving "the current
 * bank" for themselves — two answers to that question is exactly the
 * silent-disagreement shape this codebase's shared constants exist to prevent,
 * and here it would present as a progress screen counting a bank the practice
 * screen never draws from.
 */
export function resolveCurrentVersion(
  sentences: readonly SelectableSentence[],
): string | null {
  let current: string | null = null;
  for (const sentence of sentences) {
    if (current === null || compareVersions(sentence.version, current) > 0) {
      current = sentence.version;
    }
  }
  return current;
}

/** The four buckets, in the order they are drained. Exported for the tests. */
export type SentenceBucket = 'untried' | 'failed' | 'partial' | 'passed';

/**
 * The most recent attempt per sentence, plus which sentence was answered last
 * overall.
 *
 * Ties on `answeredAt` are broken by INPUT ORDER, last wins — the rows arrive
 * ordered `answeredAt` ascending from the query, so "last" is "newest" and two
 * attempts written inside the same millisecond resolve to the one the database
 * returned second rather than to whichever the iteration happened to reach.
 */
function latestBySentence(attempts: readonly SentenceAttemptRecord[]): {
  latest: Map<string, SentenceAttemptRecord>;
  mostRecentSentenceId: string | null;
} {
  const ordered = [...attempts].sort(
    (a, b) => a.answeredAt.getTime() - b.answeredAt.getTime(),
  );

  const latest = new Map<string, SentenceAttemptRecord>();
  let mostRecentSentenceId: string | null = null;

  for (const attempt of ordered) {
    latest.set(attempt.sentenceId, attempt);
    mostRecentSentenceId = attempt.sentenceId;
  }

  return { latest, mostRecentSentenceId };
}

/**
 * Sort a bucket of already-attempted sentences oldest-attempt-first.
 *
 * `ordinal` breaks a timestamp tie so the result is a total order rather than
 * whatever `Array.prototype.sort` stability happens to preserve for the rows
 * the query happened to return.
 */
function byOldestAttempt(
  latest: Map<string, SentenceAttemptRecord>,
): (a: SelectableSentence, b: SelectableSentence) => number {
  return (a, b) => {
    const at = latest.get(a.id)?.answeredAt.getTime() ?? 0;
    const bt = latest.get(b.id)?.answeredAt.getTime() ?? 0;
    return at - bt || a.ordinal - b.ordinal;
  };
}

/**
 * Every candidate for this learner and kind, in the order they should be
 * served — untried, then failed, then partial, then passed.
 *
 * Exported because it is what makes {@link selectNextSentence}'s one-row answer
 * checkable: a test can assert the whole walk rather than call the picker
 * repeatedly and simulate attempts it did not make.
 *
 * The `mostRecentSentenceId` exclusion is NOT applied here — see
 * {@link selectNextSentence}, which owns it, because "unless it is the only
 * candidate" is a decision about the final pick, not about the ordering.
 */
export function orderCandidates<S extends SelectableSentence>(
  sentences: readonly S[],
  attempts: readonly SentenceAttemptRecord[],
): S[] {
  const version = resolveCurrentVersion(sentences);
  if (version === null) return [];

  // WITHIN THE RESOLVED VERSION ONLY (§1.2's append-don't-mutate content rule):
  // a new vocabulary revision is a new set of rows, and a learner practising
  // today should be served today's bank. Attempts against a superseded
  // revision still count for the sentence they were made against — they simply
  // describe a sentence nobody is offered any more.
  const current = sentences.filter((sentence) => sentence.version === version);

  const { latest } = latestBySentence(attempts);

  const untried: S[] = [];
  const failed: S[] = [];
  const partial: S[] = [];
  const passed: S[] = [];

  for (const sentence of current) {
    const last = latest.get(sentence.id);
    if (last === undefined) untried.push(sentence);
    else if (last.outcome === 'incorrect') failed.push(sentence);
    else if (last.outcome === 'partial') partial.push(sentence);
    else passed.push(sentence);
  }

  // Untried is ordered by `ordinal` — the composer's own order, which is the
  // only ordering that exists for a sentence with no history at all. The other
  // three are ordered least-recently-seen first, so a bucket cannot starve its
  // own tail.
  untried.sort((a, b) => a.ordinal - b.ordinal);
  const oldestFirst = byOldestAttempt(latest);
  failed.sort(oldestFirst);
  partial.sort(oldestFirst);
  passed.sort(oldestFirst);

  return [...untried, ...failed, ...partial, ...passed];
}

/**
 * The next sentence to serve, or `null` when the bank for this kind is empty.
 *
 * Total: no throw for any input, including an empty bank, an empty history, or
 * a history naming sentences that are no longer in the bank.
 *
 * -----------------------------------------------------------------------------
 * THE JUST-ANSWERED EXCLUSION, AND WHY IT IS "UNLESS IT IS THE ONLY CANDIDATE"
 * -----------------------------------------------------------------------------
 *
 * The sentence behind this learner's single most recent attempt of this kind is
 * removed from consideration, so submitting an answer and asking for the next
 * sentence never hands back the sentence just submitted. Without it the `failed`
 * bucket would loop: a learner who misses a sentence is immediately offered the
 * same sentence, which they have just been shown the answer to, which measures
 * nothing.
 *
 * It is a preference, not a rule, because a bank of one sentence exists — a
 * kind with a single row, or a future revision that ships one sentence at a
 * time. Serving the same sentence again is a worse experience than serving
 * something else; serving NOTHING, and rendering "no sentences available" over a
 * bank that plainly has one, is a lie. So the exclusion is dropped rather than
 * allowed to empty the list.
 */
export function selectNextSentence<S extends SelectableSentence>(
  sentences: readonly S[],
  attempts: readonly SentenceAttemptRecord[],
): S | null {
  const candidates = orderCandidates(sentences, attempts);
  if (candidates.length === 0) return null;

  const { mostRecentSentenceId } = latestBySentence(attempts);
  if (mostRecentSentenceId === null) return candidates[0];

  const withoutJustAnswered = candidates.filter(
    (sentence) => sentence.id !== mostRecentSentenceId,
  );

  return withoutJustAnswered.length > 0
    ? withoutJustAnswered[0]
    : candidates[0];
}

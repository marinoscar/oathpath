import type { DynamicScope } from '../civics/answer-resolution';

// =============================================================================
// Question selection, v1 (issue #73, epic #52 / E3)
// =============================================================================
//
// practice-sessions.md §4's two shipped selectors — "Quick 5" and "by
// category" — reduced to the two decisions that are actually rules rather than
// queries: WHICH questions a learner may be asked at all, and IN WHAT ORDER.
//
// A standalone module, like `civics/answer-resolution.ts`,
// `journey/test-version-resolution.ts` and this epic's own
// `answer-matching.ts`, for the reason all three give: the rule must never
// drift, so it lives in exactly one named file, unit-tested directly over plain
// objects, with nothing else allowed to inline a second opinion about it.
//
// Consequently this file imports nothing but a type. No `@nestjs/*`, no Prisma
// client, no `Clock` — selection has no notion of "now" (whether a learner has
// seen a question before is a fact about rows that exist, not about the hour),
// and every function here is pure and total.
//
// -----------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------------------------------------------------------
//
// No spaced repetition, no difficulty weighting, no "least recently attempted"
// ordering within the seen group. §4 assigns all of that to E5, which owns
// `question_mastery` and the `review`/`weak`/`mixed` session kinds; E3 has no
// scheduling data to draw on because the table does not exist yet. Inventing a
// weaker version of that ordering here would mean E5 arrives to find two
// schedulers competing, and the worse one already writing evidence rows.
// =============================================================================

/** The columns selection actually reads. Deliberately narrower than the row. */
export interface SelectableQuestion {
  readonly id: string;
  readonly dynamicScope: DynamicScope;
}

/**
 * Reorder a list. Injected so ordering is testable without stubbing globals.
 *
 * Must return a NEW array and must not mutate its input — every caller here
 * passes an array it is about to keep using.
 */
export type Shuffle = <T>(items: readonly T[]) => T[];

/**
 * Fisher-Yates over a copy, using `Math.random`.
 *
 * `Math.random` and not a seeded generator, and that is a real choice: a seeded
 * shuffle would make a session reproducible, which sounds like a testing win
 * and is a product loss — two learners with identical histories would be handed
 * identical Quick 5s in identical order, and one learner restarting a session
 * would get the same five questions back. Determinism where it matters is
 * bought differently here: every function in this module that HAS a rule takes
 * the shuffle as a parameter, so a spec passes the identity function and
 * asserts the rule exactly, with nothing random left in the assertion.
 */
export const shuffleRandomly: Shuffle = <T>(items: readonly T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/**
 * Whether a question can be graded honestly for a learner with this state.
 *
 * The one exclusion: a `state`-scope question asked of a learner who has no
 * `state_code`. civics-content.md §5's fourth row calls that `state_required` —
 * there is no correct answer to resolve, because the answer depends on a fact
 * about the learner nobody has supplied.
 *
 * **Practice removes those questions from the pool rather than serving them.**
 * That is a deliberate divergence from the civics READ API, which serves the
 * question with `answerResolution: 'state_required'` and an empty answer list,
 * and the two are right for opposite reasons. §5's rule is that the product
 * must not hide a question and must not guess an answer — reading the bank,
 * hiding it would show a learner fewer questions than their test version
 * promises with nothing explaining the gap, so it is shown with an honest "we
 * don't know yet".
 *
 * Practice is not a view of the bank. It is a graded exercise, and there is no
 * honest grade available: whatever the learner types, the only outcome
 * `answer_snapshot` could record is `skipped` against an empty accepted-answer
 * list (practice-sessions.md §6). Serving it would spend one of the five
 * questions in a Quick 5 on an exercise that cannot teach or measure anything,
 * and would end with a screen that has no answer to show. The gap is not
 * unexplained either — the learner's own orientation is where the state is set,
 * and the whole bank is still readable at `/learn`.
 *
 * Note what this does NOT exclude: a `national`-scope question, whose answer
 * varies over time but not by learner, and a `state`-scope question for a
 * learner who HAS a state. Both resolve to a real accepted answer.
 */
export function isAnswerable(
  question: SelectableQuestion,
  learnerStateCode: string | null,
): boolean {
  return question.dynamicScope !== 'state' || Boolean(learnerStateCode);
}

/** {@link isAnswerable}, over a list. Order preserved; input never mutated. */
export function excludeUnanswerable<T extends SelectableQuestion>(
  questions: readonly T[],
  learnerStateCode: string | null,
): T[] {
  return questions.filter((question) => isAnswerable(question, learnerStateCode));
}

/**
 * Unseen questions first, then seen ones, each group shuffled independently.
 *
 * "Unseen" means no `practice_attempts` row exists for this learner and this
 * question, ACROSS THEIR WHOLE HISTORY — not within this session, and not
 * within practice sessions alone. The membership test is against the ids a
 * `groupBy` over `practice_attempts` returned for this user, which is the query
 * the shipped `[userId, questionId, answeredAt]` index exists to serve
 * (practice-sessions.md §2.2). Once E8 writes mock-interview attempts into the
 * same table, a question answered in an interview counts as seen here too, for
 * free and correctly — that is precisely the payoff §3 predicts from one
 * evidence table rather than two.
 *
 * Why unseen first: a learner who has answered 60 of 100 questions and starts a
 * Quick 5 should be shown the 40 they have never met before they are shown a
 * sixth repetition of the one they got right on day one. §4 states it as this
 * epic's selector, with "least-recently-attempted once every question has been
 * seen" as the fallback E5 turns into real scheduling.
 *
 * Why each group is shuffled rather than the whole list: shuffling the union
 * would destroy the partition, which is the only rule this function has.
 * Shuffling WITHIN a group is what stops the selector serving the same
 * questions in the same order every session — with a stable database ordering
 * and no shuffle, question 1 would be the first question of every session a
 * learner ever starts, and the tail of the bank would be reached only by
 * someone who completed dozens.
 *
 * Pure: `questions` and `seenQuestionIds` are read, never mutated, and the
 * result is a new array.
 */
export function orderUnseenFirst<T extends SelectableQuestion>(
  questions: readonly T[],
  seenQuestionIds: ReadonlySet<string>,
  shuffle: Shuffle = shuffleRandomly,
): T[] {
  const unseen: T[] = [];
  const seen: T[] = [];

  for (const question of questions) {
    (seenQuestionIds.has(question.id) ? seen : unseen).push(question);
  }

  return [...shuffle(unseen), ...shuffle(seen)];
}

/**
 * The whole v1 selector: drop what cannot be graded, then order unseen-first.
 *
 * The two steps are exported separately as well, because a caller that has
 * already filtered (the resume path, which excludes what this session has
 * answered) still needs the ordering rule, and a spec should be able to assert
 * either one without the other.
 *
 * `excluded` is applied BEFORE the partition rather than after: a question
 * already answered in this session is not a candidate at all, and leaving it in
 * to be filtered later would let it displace a real candidate from a
 * `take`-bounded selection.
 */
export function selectQuestions<T extends SelectableQuestion>(
  questions: readonly T[],
  options: {
    readonly learnerStateCode: string | null;
    readonly seenQuestionIds: ReadonlySet<string>;
    readonly excludeQuestionIds?: ReadonlySet<string>;
    readonly shuffle?: Shuffle;
  },
): T[] {
  const excluded = options.excludeQuestionIds;

  const candidates = excludeUnanswerable(
    excluded ? questions.filter((q) => !excluded.has(q.id)) : questions,
    options.learnerStateCode,
  );

  return orderUnseenFirst(candidates, options.seenQuestionIds, options.shuffle);
}

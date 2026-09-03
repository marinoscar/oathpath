import {
  excludeUnanswerable,
  shuffleRandomly,
  type SelectableQuestion,
  type Shuffle,
} from '../question-selection';
import type { MasteryState } from './scheduler';

// =============================================================================
// Question selection, v2 (issue #78, epic #54 / E5 "Memory")
// =============================================================================
//
// question-selection.ts's own header named exactly this moment: "§4 assigns
// [spaced repetition] to E5, which owns `question_mastery` ... E3 has no
// scheduling data to draw on because the table does not exist yet." The table
// exists now (issue #71), `nextSchedule` exists now (issue #75), and this
// file is what turns that live mastery state into an ordering — the mastery-
// aware superset of v1's "unseen questions first, then seen, each shuffled"
// rule.
//
// v1's pure primitives are REUSED, not reimplemented: `excludeUnanswerable`
// (a `state`-scope question is un-gradeable for a learner with no state, in
// v1 and v2 alike) and `Shuffle`/`shuffleRandomly` (the same non-seeded
// randomness argument question-selection.ts's own header makes — determinism
// where it matters is bought by injecting the shuffle, not by seeding it).
// question-selection.ts itself is untouched: it is still what a category
// with zero mastery history degenerates to, and its own tests keep asserting
// it directly.
//
// -----------------------------------------------------------------------------
// FIVE BUCKETS, IN THIS ORDER — FOUR NAMED BY THE ISSUE, ONE NECESSARY GLUE
// BUCKET
// -----------------------------------------------------------------------------
//
// Issue #78 names four buckets — due, lapsed/weak, new, mastered-sample — and
// they do not partition every `question_mastery` state a real learner can be
// in. A `learning` question the learner is making ordinary, un-struggling
// progress on (not weak) and a `review` question not yet due are neither
// "new" nor any of the other three named buckets, and every candidate
// question has to end up somewhere or the selector would silently shrink the
// pool `PracticeService.createSession` clamps `plannedCount` against. STEADY
// is that fifth, undocumented-by-the-issue bucket — ordinary in-progress
// questions, not urgent, not fresh — and it sits between NEW and MASTERED:
// broadening coverage of the bank (new) still outranks re-serving a question
// already on track, and a question already on track still outranks spending
// a slot re-verifying one that is already mastered.
//
//   1. DUE      — `state IN (review, lapsed)` AND `dueAt <= now`, the
//                 scheduler's own literal due queue. Ordered `dueAt` ASC —
//                 most overdue first.
//   2. WEAK      — `state = lapsed` (regardless of `dueAt` — a question
//                 lapsed moments ago has `dueAt` a day out per
//                 `LAPSE_INTERVAL_DAYS` and would otherwise wait a full day
//                 to resurface, which is backwards for a question just
//                 missed), UNION `state IN (learning, review)` AND
//                 (`lapses >= WEAK_LAPSES_THRESHOLD` OR `correctStreak = 0`).
//                 See {@link WEAK_LAPSES_THRESHOLD}'s own comment for why
//                 that predicate, exactly. Ordered by `lapses` DESC then
//                 `lastAttemptAt` ASC (oldest-touched, most-lapsed first) —
//                 the questions causing the most trouble, least recently
//                 revisited, surface first within this bucket.
//   3. NEW       — no `question_mastery` row, or `state = new`. Ordered by
//                 CATEGORY COVERAGE, round-robin: the category with the
//                 fewest `mastered` questions among the candidates goes
//                 first, one question at a time per category, cycling —
//                 never every unseen question from one category before the
//                 next category is touched at all. See
//                 {@link orderNewByCategoryCoverage}.
//   4. STEADY    — everything else with a mastery row: `learning` making
//                 ordinary progress, or `review` not yet due. Shuffled; no
//                 stronger rule than v1's "seen" bucket had.
//   5. MASTERED  — `state = mastered`. Ordered by `lastAttemptAt` ASC —
//                 least-recently-attempted first. See
//                 {@link orderMasteredByRecency}'s own comment for why this,
//                 and not a probabilistic weighting, is "the sample".
//
// A caller that only needs some of these questions (a Quick 5 needs 5) takes
// them off the FRONT of the returned array — the same contract v1's
// `selectQuestions` already had. The whole pool is still ordered end to end
// so `PracticeService`'s `plannedCount` clamp and its "no questions at all"
// 409 both keep working unchanged.
// =============================================================================

/** The mastery columns a bucket decision or an ordering rule reads. */
export interface QuestionMasterySnapshot {
  readonly state: MasteryState;
  readonly dueAt: Date | null;
  readonly lapses: number;
  readonly correctStreak: number;
  readonly lastAttemptAt: Date | null;
}

/** A question as the v2 selector needs to see it — v1's shape, plus its category. */
export interface MasterySelectableQuestion extends SelectableQuestion {
  readonly categoryId: string;
}

/**
 * How many `lapses` (an objectively-graded regression FROM `review` or
 * `mastered`, per scheduler.ts's state machine — not an ordinary miss on a
 * question never yet proven) puts a `learning`/`review` question in the WEAK
 * bucket even when it is not currently due.
 *
 * `2`, not `1`: a single lapse is what the scheduler's own state machine
 * already treats as an ordinary event on the path back through `learning` —
 * every regression lapses once. Flagging weak at `lapses >= 1` would put
 * every question that has EVER slipped a single time permanently ahead of
 * fresh content, which is a broader claim than "struggling" warrants. Two or
 * more is a real, repeated pattern the review queue should react to.
 */
export const WEAK_LAPSES_THRESHOLD = 2;

/** Which ordering bucket one question's mastery state falls into, right now. */
export type MasteryBucket = 'due' | 'weak' | 'new' | 'steady' | 'mastered';

/**
 * The single classification rule, shared by the selector below AND by
 * `PracticeService.getQueue` (`GET /api/practice/queue`) — one place a
 * question's mastery state is turned into "which pile is this in", so the
 * queue's counts can never drift from what a session would actually select
 * next. `now` is a plain parameter, exactly like `nextSchedule` — no `Clock`,
 * no I/O, total over its input.
 */
export function classifyMasteryBucket(
  mastery: QuestionMasterySnapshot | undefined,
  now: Date,
): MasteryBucket {
  if (!mastery || mastery.state === 'new') {
    return 'new';
  }

  if (
    (mastery.state === 'review' || mastery.state === 'lapsed') &&
    mastery.dueAt !== null &&
    mastery.dueAt.getTime() <= now.getTime()
  ) {
    return 'due';
  }

  if (mastery.state === 'lapsed') {
    return 'weak';
  }

  if (
    (mastery.state === 'learning' || mastery.state === 'review') &&
    (mastery.lapses >= WEAK_LAPSES_THRESHOLD || mastery.correctStreak === 0)
  ) {
    return 'weak';
  }

  if (mastery.state === 'mastered') {
    return 'mastered';
  }

  return 'steady';
}

/**
 * NEW questions, round-robin across categories, the category with the fewest
 * MASTERED candidates going first.
 *
 * "Round-robin" and not "sort by category" is the part of §3's rule that
 * actually does the work: sorting would still front-load one whole category
 * before touching the next, which is precisely the uneven coverage the issue
 * asks this bucket to avoid. One question per category per pass instead
 * broadens the learner's exposure across the bank evenly as a session (or a
 * resumed one, pulling further down the list) consumes more of it.
 *
 * Each category's own members are shuffled first (the same non-seeded
 * randomness v1 uses within its unseen/seen groups) so which of a category's
 * several new questions comes up first is not itself deterministic.
 */
function orderNewByCategoryCoverage<T extends MasterySelectableQuestion>(
  freshQuestions: readonly T[],
  masteredCountByCategory: ReadonlyMap<string, number>,
  shuffle: Shuffle,
): T[] {
  const byCategory = new Map<string, T[]>();
  for (const question of freshQuestions) {
    const group = byCategory.get(question.categoryId);
    if (group) {
      group.push(question);
    } else {
      byCategory.set(question.categoryId, [question]);
    }
  }

  const categoryOrder = [...byCategory.keys()].sort((a, b) => {
    const diff = (masteredCountByCategory.get(a) ?? 0) - (masteredCountByCategory.get(b) ?? 0);
    // Tie-broken by category id for a STABLE order — two categories with the
    // same mastered count must not silently reorder between two calls with
    // identical input, which a comparator returning 0 for ties risks under
    // some engines' sort implementations.
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  const shuffledByCategory = new Map(
    categoryOrder.map((categoryId) => [categoryId, shuffle(byCategory.get(categoryId)!)] as const),
  );

  const result: T[] = [];
  for (let index = 0; result.length < freshQuestions.length; index += 1) {
    for (const categoryId of categoryOrder) {
      const group = shuffledByCategory.get(categoryId)!;
      if (index < group.length) {
        result.push(group[index]);
      }
    }
  }

  return result;
}

/**
 * MASTERED questions, least-recently-attempted first.
 *
 * "The sample" IS this ordering, not a separate random draw on top of it:
 * whatever slice off the FRONT of the whole selector's result a caller ends
 * up taking (a Quick 5 that ran out of due/weak/new/steady content and has to
 * reach into mastered questions to fill its five) is, by construction, the
 * mastered questions the learner has gone the longest without demonstrating.
 *
 * Deterministic recency, not a probabilistic weighting, is the deliberate
 * choice here: a weighted-random draw would occasionally re-serve a
 * recently-mastered question ahead of one untouched for months, which is
 * exactly backwards for "keep mastery being verified rather than assumed" —
 * the question most overdue for re-verification should be the one most
 * likely to be asked, not merely likelier-than-average.
 */
function orderMasteredByRecency<T extends MasterySelectableQuestion>(
  masteredQuestions: readonly T[],
  masteryByQuestionId: ReadonlyMap<string, QuestionMasterySnapshot>,
): T[] {
  return [...masteredQuestions].sort((a, b) => {
    const attemptedAtA = masteryByQuestionId.get(a.id)?.lastAttemptAt?.getTime() ?? 0;
    const attemptedAtB = masteryByQuestionId.get(b.id)?.lastAttemptAt?.getTime() ?? 0;
    return attemptedAtA - attemptedAtB;
  });
}

/**
 * The whole v2 selector: drop what cannot be graded (v1's rule, unchanged),
 * then order by mastery — due, then weak, then new-by-coverage, then steady,
 * then mastered-by-recency. See this file's header for the full bucket list
 * and why each is ordered the way it is.
 *
 * `excludeQuestionIds` and the answerability filter both apply BEFORE
 * bucketing, matching v1's `selectQuestions` for the identical reason: a
 * question already answered in this session is not a candidate at all.
 */
export function selectQuestionsV2<T extends MasterySelectableQuestion>(
  questions: readonly T[],
  options: {
    readonly learnerStateCode: string | null;
    readonly masteryByQuestionId: ReadonlyMap<string, QuestionMasterySnapshot>;
    readonly now: Date;
    readonly excludeQuestionIds?: ReadonlySet<string>;
    readonly shuffle?: Shuffle;
  },
): T[] {
  const shuffle = options.shuffle ?? shuffleRandomly;
  const excluded = options.excludeQuestionIds;

  const candidates = excludeUnanswerable(
    excluded ? questions.filter((question) => !excluded.has(question.id)) : questions,
    options.learnerStateCode,
  );

  const due: T[] = [];
  const weak: T[] = [];
  const fresh: T[] = [];
  const steady: T[] = [];
  const mastered: T[] = [];

  // Mastered-per-category, computed over the SAME candidate set the "new"
  // bucket is drawn from — the coverage rule is about broadening this
  // session's own pool, not the whole bank's lifetime history.
  const masteredCountByCategory = new Map<string, number>();

  for (const question of candidates) {
    const mastery = options.masteryByQuestionId.get(question.id);
    const bucket = classifyMasteryBucket(mastery, options.now);

    switch (bucket) {
      case 'due':
        due.push(question);
        break;
      case 'weak':
        weak.push(question);
        break;
      case 'new':
        fresh.push(question);
        break;
      case 'steady':
        steady.push(question);
        break;
      case 'mastered':
        mastered.push(question);
        masteredCountByCategory.set(
          question.categoryId,
          (masteredCountByCategory.get(question.categoryId) ?? 0) + 1,
        );
        break;
    }
  }

  due.sort((a, b) => {
    const dueAtA = options.masteryByQuestionId.get(a.id)!.dueAt!.getTime();
    const dueAtB = options.masteryByQuestionId.get(b.id)!.dueAt!.getTime();
    return dueAtA - dueAtB;
  });

  weak.sort((a, b) => {
    const masteryA = options.masteryByQuestionId.get(a.id)!;
    const masteryB = options.masteryByQuestionId.get(b.id)!;
    if (masteryB.lapses !== masteryA.lapses) {
      return masteryB.lapses - masteryA.lapses;
    }
    const attemptedAtA = masteryA.lastAttemptAt?.getTime() ?? 0;
    const attemptedAtB = masteryB.lastAttemptAt?.getTime() ?? 0;
    return attemptedAtA - attemptedAtB;
  });

  return [
    ...due,
    ...weak,
    ...orderNewByCategoryCoverage(fresh, masteredCountByCategory, shuffle),
    ...shuffle(steady),
    ...orderMasteredByRecency(mastered, options.masteryByQuestionId),
  ];
}

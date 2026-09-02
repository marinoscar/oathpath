import type { Prisma } from '@prisma/client';

// =============================================================================
// Answer resolution (issue #111, epic #51)
// =============================================================================
//
// civics-content.md §5's resolution table, as a pure function over rows plus
// the one Prisma `where` fragment that decides which rows are current at all.
//
// It is a standalone module rather than a `CivicsService` method for the same
// reason `journey/test-version-resolution.ts` is one: the rule must never
// drift, so it lives in exactly one named file, unit-tested directly, with
// nothing else allowed to inline it. Every branch of §5's table is reachable
// here without DI, HTTP, or a database.
//
// -----------------------------------------------------------------------------
// THIS FILE CONSTRUCTS NO `Date` OF ITS OWN, AND NEITHER DOES ANY OTHER
// -----------------------------------------------------------------------------
//
// Every function that needs "now" takes it as a parameter, supplied by the
// caller from the injected `Clock` (#63). Grep this module's non-test sources
// for a bare `Date` construction and the result is empty, comments included —
// the same checkable property `src/journey/` already holds to, and the rule
// civics-content.md §10 restates for this epic specifically.
// =============================================================================

/** The three values of the `CivicsDynamicScope` Postgres enum. */
export type DynamicScope = 'none' | 'national' | 'state';

/**
 * Whether an answer set could be resolved for the caller at all.
 *
 *  - `resolved`       — the answers below are this caller's answers.
 *  - `state_required` — a `state`-scope question and the caller has no
 *                       `state_code`. The answer list is EMPTY, deliberately.
 *
 * civics-content.md §5 rejects both alternatives explicitly: hiding the
 * question would show a learner fewer questions than their test version
 * promises with nothing explaining the gap, and defaulting to some state would
 * hand them a specific, memorable WRONG answer with no signal it might not
 * apply. An honest "we don't know yet" is the only remaining option, and it
 * has to be legible to the client — hence a discriminator on the wire rather
 * than an empty array the client has to guess the meaning of.
 */
export type AnswerResolutionStatus = 'resolved' | 'state_required';

/** The columns resolution actually reads. Deliberately narrower than the row. */
export interface ResolvableAnswer {
  readonly sort: number;
  readonly stateCode: string | null;
  /**
   * Read only as a tie-break (see {@link selectAnswers}). Resolution does NOT
   * compare it against the clock — {@link currentAnswerWhere} already did.
   */
  readonly effectiveFrom: Date;
}

/**
 * The `where` fragment selecting the rows that are correct **as of `now`**.
 *
 * For every row the content loader writes today this is exactly
 * civics-content.md §3's `effective_to IS NULL`, because a loaded answer's
 * `effectiveFrom` is in the past and its `effectiveTo` is null. The two extra
 * clauses matter for the one case §4 creates and §3's prose does not cover:
 *
 *  - `effectiveFrom <= now` — a row that does not take effect until next
 *    Tuesday is not the current answer today. Without this clause a correction
 *    entered ahead of time would be served as fact before it was true.
 *  - `effectiveTo IS NULL OR effectiveTo > now` — §4's close-then-open
 *    transaction stamps the OLD row's `effectiveTo` and the NEW row's
 *    `effectiveFrom` with the same real-world instant. If that instant is in
 *    the future, treating "closed" as "not current" would leave the question
 *    with NO current answer for the whole interval between now and then —
 *    a question that manifestly has one. Reading the boundary against the
 *    clock keeps the two rows contiguous the way §4 intends, and keeps
 *    exactly one of them current at any instant.
 *
 * A superseded row — closed at an instant already past — matches neither
 * clause and can never be served.
 *
 * `now` is a parameter, never read here. That is what lets a spec pin it with
 * `X-Test-Clock` and assert the boundary instead of sleeping.
 */
export function currentAnswerWhere(now: Date): Prisma.CivicsAnswerWhereInput {
  return {
    effectiveFrom: { lte: now },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
  };
}

/**
 * The `state_code` an answer query should filter on, per §5's table, and
 * whether resolution is possible at all.
 *
 * `none` and `national` ignore the learner's state entirely: the correct
 * answer to "name one branch of the government" or "who is the President" does
 * not vary by where the learner lives, and both scopes' rows carry
 * `state_code: NULL`.
 */
export function resolveAnswerScope(
  scope: DynamicScope,
  learnerStateCode: string | null,
): { status: AnswerResolutionStatus; stateCode: string | null } {
  if (scope !== 'state') {
    return { status: 'resolved', stateCode: null };
  }

  if (!learnerStateCode) {
    // §5's fourth row. NOT a 404, NOT a hidden question, NOT a national answer
    // standing in for a state one.
    return { status: 'state_required', stateCode: null };
  }

  return { status: 'resolved', stateCode: learnerStateCode };
}

/**
 * Choose which of the current rows to serve, given the question's scope.
 *
 * `rows` must already have been narrowed by {@link currentAnswerWhere} and by
 * the state filter {@link resolveAnswerScope} returns.
 *
 * A `none`-scope question keeps EVERY row: "name one branch of the government"
 * has three simultaneously correct answers, each in its own slot
 * (§3.1). A `national`- or `state`-scope question keeps exactly ONE — there is
 * one current President — and the one kept is the lowest `sort`.
 *
 * Reading "the lowest slot" rather than filtering `sort = 0` literally is
 * deliberate: §3.3 records that the database cannot enforce that a dynamic
 * question only ever uses slot 0 (an index predicate cannot see the
 * question's `dynamic_scope`), so a mis-loaded row at `sort: 1` is possible.
 * Filtering on `sort = 0` would answer such a question with NOTHING; taking
 * the lowest slot degrades to serving one answer instead of none. Both readings
 * are identical for well-formed content, and this one fails softer.
 *
 * The per-slot deduplication is defence, not a designed feature: the partial
 * unique index (§3.2) already guarantees at most one open row per
 * `(question, state, sort)`, and the clock predicate above cannot produce an
 * overlap from a well-formed close-then-open pair. If two rows ever did claim
 * one slot, serving the later `effectiveFrom` is at least deterministic, rather
 * than leaving the answer to row order.
 */
export function selectAnswers<T extends ResolvableAnswer>(
  scope: DynamicScope,
  rows: readonly T[],
): T[] {
  const ordered = [...rows].sort(
    (a, b) =>
      a.sort - b.sort || b.effectiveFrom.getTime() - a.effectiveFrom.getTime(),
  );

  const bySlot = new Map<string, T>();
  for (const row of ordered) {
    const slot = `${row.stateCode ?? ''}:${row.sort}`;
    if (!bySlot.has(slot)) {
      bySlot.set(slot, row);
    }
  }

  const selected = [...bySlot.values()];
  return scope === 'none' ? selected : selected.slice(0, 1);
}

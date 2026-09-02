import {
  excludeUnanswerable,
  isAnswerable,
  orderUnseenFirst,
  selectQuestions,
  type SelectableQuestion,
  type Shuffle,
} from './question-selection';

// =============================================================================
// question-selection — tests (issue #73, epic #52 / E3)
// =============================================================================
//
// practice-sessions.md §4's v1 selector, reduced to the two rules this module
// actually owns: WHICH questions a learner may be asked at all
// (`isAnswerable`/`excludeUnanswerable`), and IN WHAT ORDER
// (`orderUnseenFirst`), plus `selectQuestions`, which composes the two exactly
// the way `PracticeService.candidateQuestions` calls it.
//
// Every function here is pure and takes an injectable `Shuffle`, so every test
// below passes the identity shuffle and asserts partitions and ordering
// exactly — nothing in this file depends on `Math.random`, and nothing here
// needs Nest, Prisma, or a `Clock`.
// =============================================================================

/** Identity shuffle: returns a NEW array in the SAME order. */
const identity = <T>(items: readonly T[]): T[] => [...items];

/** A minimal selectable question, with an id short enough to read in a list. */
function q(id: string, dynamicScope: SelectableQuestion['dynamicScope'] = 'none'): SelectableQuestion {
  return { id, dynamicScope };
}

describe('isAnswerable', () => {
  it('is answerable for a none-scope question regardless of state', () => {
    expect(isAnswerable(q('q1', 'none'), null)).toBe(true);
    expect(isAnswerable(q('q1', 'none'), 'TX')).toBe(true);
  });

  it('is answerable for a national-scope question regardless of state', () => {
    // A national answer varies over time, not by learner — the whole reason
    // it does not need a state to resolve.
    expect(isAnswerable(q('q1', 'national'), null)).toBe(true);
    expect(isAnswerable(q('q1', 'national'), 'TX')).toBe(true);
  });

  it('is answerable for a state-scope question ONLY when the learner has a state', () => {
    expect(isAnswerable(q('q1', 'state'), 'TX')).toBe(true);
    expect(isAnswerable(q('q1', 'state'), null)).toBe(false);
  });
});

describe('excludeUnanswerable', () => {
  it('drops state-scope questions for a learner with no state, keeping order', () => {
    const questions = [q('a', 'none'), q('b', 'state'), q('c', 'national'), q('d', 'state')];

    expect(excludeUnanswerable(questions, null).map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('keeps every question for a learner who has a state', () => {
    const questions = [q('a', 'none'), q('b', 'state'), q('c', 'national')];

    expect(excludeUnanswerable(questions, 'TX').map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate its input array', () => {
    const questions = [q('a', 'state'), q('b', 'none')];
    const original = [...questions];

    excludeUnanswerable(questions, null);

    expect(questions).toEqual(original);
  });
});

describe('orderUnseenFirst', () => {
  it('puts every unseen question ahead of every seen one', () => {
    const questions = [q('seen-1'), q('unseen-1'), q('seen-2'), q('unseen-2')];
    const seen = new Set(['seen-1', 'seen-2']);

    const ordered = orderUnseenFirst(questions, seen, identity);

    expect(ordered.map((x) => x.id)).toEqual(['unseen-1', 'unseen-2', 'seen-1', 'seen-2']);
  });

  it('preserves each group’s relative order under the identity shuffle', () => {
    // With `identity` as the shuffle, the partition is deterministic even
    // though the real default (`shuffleRandomly`) is not — this is exactly
    // why the shuffle is injected rather than baked in.
    const questions = [q('u3'), q('s1'), q('u1'), q('s2'), q('u2')];
    const seen = new Set(['s1', 's2']);

    const ordered = orderUnseenFirst(questions, seen, identity);

    expect(ordered.map((x) => x.id)).toEqual(['u3', 'u1', 'u2', 's1', 's2']);
  });

  it('returns every question, unseen-first, when nothing has been seen', () => {
    const questions = [q('a'), q('b'), q('c')];

    const ordered = orderUnseenFirst(questions, new Set(), identity);

    expect(ordered.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns every question in the seen group when all have been seen', () => {
    const questions = [q('a'), q('b')];
    const seen = new Set(['a', 'b']);

    const ordered = orderUnseenFirst(questions, seen, identity);

    expect(ordered.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('calls the shuffle once per group, not once for the combined list', () => {
    // Shuffling the union would destroy the unseen/seen partition — the ONE
    // rule this function has. Recording each call's input proves the shuffle
    // was applied to each group separately rather than to the whole array.
    //
    // A hand-written generic function rather than `jest.fn(identity)`:
    // `Shuffle` is itself a generic `<T>(items: readonly T[]) => T[]`, and
    // neither a `jest.Mock` nor a function monomorphic in `SelectableQuestion`
    // can satisfy that polymorphism structurally — only a function declaring
    // its own `<T>` can be assigned to a `Shuffle`-typed parameter.
    const calls: SelectableQuestion[][] = [];
    const shuffle: Shuffle = function <T>(items: readonly T[]): T[] {
      calls.push([...items] as unknown as SelectableQuestion[]);
      return [...items];
    };
    const questions = [q('u1'), q('s1'), q('u2')];
    const seen = new Set(['s1']);

    orderUnseenFirst(questions, seen, shuffle);

    expect(calls).toHaveLength(2);
    expect(calls[0].map((x) => x.id)).toEqual(['u1', 'u2']);
    expect(calls[1].map((x) => x.id)).toEqual(['s1']);
  });

  it('does not mutate its input array or the seen set', () => {
    const questions = [q('a'), q('b')];
    const original = [...questions];
    const seen = new Set(['a']);
    const seenCopy = new Set(seen);

    orderUnseenFirst(questions, seen, identity);

    expect(questions).toEqual(original);
    expect(seen).toEqual(seenCopy);
  });
});

describe('selectQuestions', () => {
  it('filters unanswerable questions BEFORE partitioning by seen/unseen', () => {
    const questions = [q('a', 'none'), q('b', 'state'), q('c', 'none')];

    const result = selectQuestions(questions, {
      learnerStateCode: null,
      seenQuestionIds: new Set(),
      shuffle: identity,
    });

    expect(result.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('excludes questions already answered in the CURRENT session before ordering', () => {
    // `excludeQuestionIds` is applied ahead of the unseen/seen partition, so a
    // question this session already asked never displaces a real candidate
    // from a `take`-bounded selection.
    const questions = [q('a'), q('b'), q('c')];

    const result = selectQuestions(questions, {
      learnerStateCode: 'TX',
      seenQuestionIds: new Set(),
      excludeQuestionIds: new Set(['b']),
      shuffle: identity,
    });

    expect(result.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('composes exclusion, unanswerability, and unseen-first ordering together', () => {
    const questions = [
      q('seen-none', 'none'),
      q('unseen-state-no-state', 'state'),
      q('unseen-none', 'none'),
      q('excluded-none', 'none'),
      q('unseen-national', 'national'),
    ];

    const result = selectQuestions(questions, {
      learnerStateCode: null,
      seenQuestionIds: new Set(['seen-none']),
      excludeQuestionIds: new Set(['excluded-none']),
      shuffle: identity,
    });

    // `unseen-state-no-state` is gone (unanswerable), `excluded-none` is gone
    // (already answered this session), and what remains is unseen-first.
    expect(result.map((x) => x.id)).toEqual(['unseen-none', 'unseen-national', 'seen-none']);
  });

  it('defaults to the real random shuffle when none is injected', () => {
    // Not asserting an order — asserting the function still runs and returns
    // every candidate when the caller does not care to control the shuffle.
    const questions = [q('a'), q('b'), q('c')];

    const result = selectQuestions(questions, {
      learnerStateCode: 'TX',
      seenQuestionIds: new Set(),
    });

    expect(result.map((x) => x.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array when every candidate is filtered out', () => {
    const questions = [q('a', 'state'), q('b', 'state')];

    const result = selectQuestions(questions, {
      learnerStateCode: null,
      seenQuestionIds: new Set(),
      shuffle: identity,
    });

    expect(result).toEqual([]);
  });
});

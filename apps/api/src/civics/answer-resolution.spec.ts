import {
  currentAnswerWhere,
  resolveAnswerScope,
  selectAnswers,
} from './answer-resolution';

// =============================================================================
// answer-resolution — tests (issue #111, epic #51)
// =============================================================================
//
// civics-content.md §5's table, one row of it per describe block, plus the
// clock predicate that decides which rows are eligible at all.
//
// These are pure functions, so every branch is reachable here without DI, HTTP
// or a database — including the ones that are awkward to stage over the wire (a
// correction scheduled for next week, two rows claiming one slot).
// =============================================================================

const NOW = new Date('2026-06-01T12:00:00Z');

/** A row as `selectAnswers` reads it, plus an id so assertions can name one. */
function answer(
  id: string,
  overrides: Partial<{ sort: number; stateCode: string | null; effectiveFrom: Date }> = {},
) {
  return {
    id,
    sort: 0,
    stateCode: null,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('currentAnswerWhere', () => {
  it('requires the answer to have taken effect and not yet been closed', () => {
    // Both halves matter, and neither is redundant: without the lower bound a
    // correction entered ahead of time would be served as fact before it was
    // true, and without the `gt` half a correction scheduled for a future
    // instant would leave the question with NO current answer in the meantime.
    expect(currentAnswerWhere(NOW)).toEqual({
      effectiveFrom: { lte: NOW },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: NOW } }],
    });
  });

  it('reads no clock of its own — the instant is the one it was given', () => {
    const other = new Date('2030-01-01T00:00:00Z');

    expect(currentAnswerWhere(other)).toEqual({
      effectiveFrom: { lte: other },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: other } }],
    });
  });
});

describe('resolveAnswerScope', () => {
  it('ignores the learner’s state for a `none`-scope question', () => {
    expect(resolveAnswerScope('none', 'TX')).toEqual({
      status: 'resolved',
      stateCode: null,
    });
  });

  it('ignores the learner’s state for a `national`-scope question', () => {
    // The correct answer to "who is the President" does not vary by where the
    // learner lives, and the row carries `state_code: NULL`.
    expect(resolveAnswerScope('national', 'TX')).toEqual({
      status: 'resolved',
      stateCode: null,
    });
  });

  it('resolves a `state`-scope question against the learner’s own state', () => {
    expect(resolveAnswerScope('state', 'TX')).toEqual({
      status: 'resolved',
      stateCode: 'TX',
    });
  });

  it.each(['DC', 'PR', 'GU', 'VI', 'AS', 'MP'])(
    'resolves for %s the same way it does for a state',
    (code) => {
      // civics-content.md §5: the territories are not an edge case to add
      // later. The 2008 test's own content covers "no U.S. senators" for
      // territory residents, so a Puerto Rico learner has a real answer row.
      expect(resolveAnswerScope('state', code)).toEqual({
        status: 'resolved',
        stateCode: code,
      });
    },
  );

  it.each([
    ['null', null],
    ['an empty string', ''],
  ])(
    'reports `state_required` when the learner’s state is %s, rather than guessing',
    (_label, stateCode) => {
      // NOT a national answer standing in for a state one, and NOT the first
      // state alphabetically. §5 rejects both by name: a guess hands the
      // learner a specific, memorable WRONG answer with no signal it might not
      // apply to them.
      expect(resolveAnswerScope('state', stateCode)).toEqual({
        status: 'state_required',
        stateCode: null,
      });
    },
  );
});

describe('selectAnswers', () => {
  it('keeps every alternative for a `none`-scope question', () => {
    // "Name one branch of the government" — three simultaneously correct
    // answers, each in its own slot. An implementation that took only the
    // first would silently mark two thirds of them wrong.
    const rows = [
      answer('legislative', { sort: 0 }),
      answer('executive', { sort: 1 }),
      answer('judicial', { sort: 2 }),
    ];

    expect(selectAnswers('none', rows).map((r) => r.id)).toEqual([
      'legislative',
      'executive',
      'judicial',
    ]);
  });

  it('orders a `none`-scope question’s alternatives by slot, not by row order', () => {
    const rows = [
      answer('judicial', { sort: 2 }),
      answer('legislative', { sort: 0 }),
      answer('executive', { sort: 1 }),
    ];

    expect(selectAnswers('none', rows).map((r) => r.id)).toEqual([
      'legislative',
      'executive',
      'judicial',
    ]);
  });

  it('keeps exactly one answer for a `national`-scope question', () => {
    expect(selectAnswers('national', [answer('the-president')])).toHaveLength(1);
  });

  it('keeps exactly one answer for a `state`-scope question', () => {
    expect(
      selectAnswers('state', [answer('tx-governor', { stateCode: 'TX' })]),
    ).toHaveLength(1);
  });

  it('serves the lowest slot when a dynamic question was mis-loaded above slot 0', () => {
    // §3.3: the partial unique index cannot see the question's `dynamic_scope`,
    // so nothing in the database stops a national answer being written at
    // `sort: 1`. Filtering `sort = 0` literally would answer such a question
    // with NOTHING; taking the lowest slot degrades to one answer instead of
    // none. Identical for well-formed content, softer failure otherwise.
    const rows = [answer('stray', { sort: 1 })];

    expect(selectAnswers('national', rows).map((r) => r.id)).toEqual(['stray']);
  });

  it('breaks a two-rows-in-one-slot tie deterministically, by latest effectiveFrom', () => {
    // Defence, not a designed feature — the partial unique index already makes
    // this unreachable for well-formed data. If it ever happened, the answer
    // must not depend on row order.
    const rows = [
      answer('older', { effectiveFrom: new Date('2020-01-01T00:00:00Z') }),
      answer('newer', { effectiveFrom: new Date('2026-01-01T00:00:00Z') }),
    ];

    expect(selectAnswers('national', rows).map((r) => r.id)).toEqual(['newer']);
    expect(selectAnswers('national', [...rows].reverse()).map((r) => r.id)).toEqual([
      'newer',
    ]);
  });

  it('treats a national slot and a per-state slot on one question as different slots', () => {
    // §3.1: they differ in `state_code`, so they never collide.
    const rows = [
      answer('national', { stateCode: null }),
      answer('texas', { stateCode: 'TX' }),
    ];

    expect(selectAnswers('none', rows)).toHaveLength(2);
  });

  it('returns an empty list for an empty input rather than throwing', () => {
    expect(selectAnswers('state', [])).toEqual([]);
  });

  it('does not mutate the rows it was given', () => {
    const rows = [answer('b', { sort: 1 }), answer('a', { sort: 0 })];

    selectAnswers('none', rows);

    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

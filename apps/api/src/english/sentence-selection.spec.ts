import {
  compareVersions,
  orderCandidates,
  resolveCurrentVersion,
  selectNextSentence,
  type SelectableSentence,
  type SentenceAttemptRecord,
} from './sentence-selection';

// =============================================================================
// sentence-selection — tests (issue #136, epic #59 / E10)
// =============================================================================
//
// The rule, asserted directly over plain objects: no Prisma, no Nest, no
// service, no HTTP. The whole reason this module is standalone is that its rule
// can be pinned exactly, and every assertion here names the EXACT sentence
// rather than "one of these" — which is only possible because selection is
// deterministic (see the module header on why it is, deliberately unlike
// `question-selection.ts`).
// =============================================================================

const S1 = 'aaaaaaa1-1111-4111-8111-111111111111';
const S2 = 'aaaaaaa2-2222-4222-8222-222222222222';
const S3 = 'aaaaaaa3-3333-4333-8333-333333333333';
const S4 = 'aaaaaaa4-4444-4444-8444-444444444444';

function sentence(
  id: string,
  ordinal: number,
  version = 'v1',
): SelectableSentence {
  return { id, ordinal, version };
}

const BANK = [
  sentence(S1, 1),
  sentence(S2, 2),
  sentence(S3, 3),
  sentence(S4, 4),
];

function attempt(
  sentenceId: string,
  outcome: 'correct' | 'partial' | 'incorrect',
  isoDay: string,
): SentenceAttemptRecord {
  return { sentenceId, outcome, answeredAt: new Date(isoDay) };
}

describe('compareVersions', () => {
  it('orders digit runs numerically, so v10 is newer than v2', () => {
    // The failure this exists to prevent is silent: lexicographically `v10`
    // sorts BEFORE `v2`, so the tenth revision of a vocabulary file would
    // serve the second revision's bank forever, with nothing to say so.
    expect(compareVersions('v2', 'v10')).toBeLessThan(0);
    expect(compareVersions('v10', 'v2')).toBeGreaterThan(0);
  });

  it('orders non-numeric segments as text and reports equality', () => {
    expect(compareVersions('v1', 'v1')).toBe(0);
    expect(compareVersions('v1', 'v1a')).toBeLessThan(0);
    expect(compareVersions('2026-01', '2026-02')).toBeLessThan(0);
  });
});

describe('resolveCurrentVersion', () => {
  it('is null for an empty bank', () => {
    expect(resolveCurrentVersion([])).toBeNull();
  });

  it('is the newest revision present, not the last row seen', () => {
    expect(
      resolveCurrentVersion([
        sentence(S1, 1, 'v2'),
        sentence(S2, 2, 'v10'),
        sentence(S3, 3, 'v1'),
      ]),
    ).toBe('v10');
  });
});

describe('selectNextSentence — bucket order', () => {
  it('serves untried sentences first, in ordinal order', () => {
    expect(selectNextSentence(BANK, [])?.id).toBe(S1);
  });

  it('serves an untried sentence ahead of one just passed — the acceptance criterion', () => {
    // S1 was answered correctly a moment ago. S2, S3 and S4 have never been
    // seen. A just-passed sentence must never come ahead of an untried one.
    const next = selectNextSentence(BANK, [
      attempt(S1, 'correct', '2026-09-01T10:00:00Z'),
    ]);

    expect(next?.id).toBe(S2);
  });

  it('drains untried, then failed, then partial, then passed', () => {
    // S2 failed EARLIEST of the three attempted, S3 partial, S4 passed — and
    // S1 has never been tried at all. The whole walk is asserted rather than
    // one pick, so a reordering of the buckets fails here rather than
    // surviving as a subtler regression.
    const history = [
      attempt(S2, 'incorrect', '2026-09-01T10:00:00Z'),
      attempt(S3, 'partial', '2026-09-02T10:00:00Z'),
      attempt(S4, 'correct', '2026-09-03T10:00:00Z'),
    ];

    expect(orderCandidates(BANK, history).map((s) => s.id)).toEqual([
      S1,
      S2,
      S3,
      S4,
    ]);
  });

  it('reads only the MOST RECENT outcome per sentence, not the worst or the first', () => {
    // S2 failed, then was corrected. It belongs in `passed`, behind S3 which
    // is still failing — a learner who has fixed a sentence should not keep
    // being handed it.
    const history = [
      attempt(S2, 'incorrect', '2026-09-01T10:00:00Z'),
      attempt(S3, 'incorrect', '2026-09-02T10:00:00Z'),
      attempt(S2, 'correct', '2026-09-03T10:00:00Z'),
    ];

    const ordered = orderCandidates(BANK, history).map((s) => s.id);

    expect(ordered.indexOf(S3)).toBeLessThan(ordered.indexOf(S2));
  });

  it('orders within a bucket least-recently-seen first', () => {
    // Both failed; S4 was seen longer ago, so it comes back first.
    const history = [
      attempt(S4, 'incorrect', '2026-09-01T10:00:00Z'),
      attempt(S2, 'incorrect', '2026-09-05T10:00:00Z'),
      // S1 and S3 out of the way, in the `passed` bucket.
      attempt(S1, 'correct', '2026-09-06T10:00:00Z'),
      attempt(S3, 'correct', '2026-09-07T10:00:00Z'),
    ];

    expect(orderCandidates(BANK, history).map((s) => s.id)).toEqual([
      S4,
      S2,
      S1,
      S3,
    ]);
  });
});

describe('selectNextSentence — the just-answered exclusion', () => {
  it('never returns the sentence answered most recently', () => {
    // Every sentence has been passed, so `passed` is the only bucket and S4 —
    // least recently seen — would ordinarily be first. Make S4 the most recent
    // instead and it must be skipped, even though its own bucket position says
    // otherwise.
    const history = [
      attempt(S1, 'correct', '2026-09-01T10:00:00Z'),
      attempt(S2, 'correct', '2026-09-02T10:00:00Z'),
      attempt(S3, 'correct', '2026-09-03T10:00:00Z'),
      attempt(S4, 'incorrect', '2026-09-04T10:00:00Z'),
    ];

    // S4 is the only member of `failed`, so it heads the ordering...
    expect(orderCandidates(BANK, history)[0].id).toBe(S4);
    // ...and is nonetheless not what gets served, because it was just answered.
    expect(selectNextSentence(BANK, history)?.id).toBe(S1);
  });

  it('serves the just-answered sentence anyway when it is the only candidate', () => {
    // A bank of one. The exclusion is a preference, not a rule: rendering "no
    // sentences available" over a bank that plainly has one would be a lie,
    // and a worse one than a repeat.
    const single = [sentence(S1, 1)];
    const history = [attempt(S1, 'incorrect', '2026-09-01T10:00:00Z')];

    expect(selectNextSentence(single, history)?.id).toBe(S1);
  });
});

describe('selectNextSentence — versions', () => {
  it('draws only from the newest revision present', () => {
    const mixed = [
      sentence(S1, 1, 'v1'),
      sentence(S2, 2, 'v1'),
      sentence(S3, 1, 'v2'),
    ];

    // S1 has the lowest ordinal and has never been tried, but it belongs to a
    // superseded revision — the current bank is v2 and contains only S3.
    expect(orderCandidates(mixed, []).map((s) => s.id)).toEqual([S3]);
    expect(selectNextSentence(mixed, [])?.id).toBe(S3);
  });

  it('ignores history naming sentences outside the current revision', () => {
    const mixed = [sentence(S1, 1, 'v1'), sentence(S3, 1, 'v2')];

    // The learner's only attempt is against a retired sentence. It must not
    // suppress the one sentence that is actually available.
    const history = [attempt(S1, 'correct', '2026-09-01T10:00:00Z')];

    expect(selectNextSentence(mixed, history)?.id).toBe(S3);
  });
});

describe('selectNextSentence — empty and degenerate input', () => {
  it('is null for an empty bank', () => {
    expect(selectNextSentence([], [])).toBeNull();
    expect(
      selectNextSentence([], [attempt(S1, 'correct', '2026-09-01T10:00:00Z')]),
    ).toBeNull();
  });

  it('does not throw on history for sentences that no longer exist at all', () => {
    expect(
      selectNextSentence(BANK, [
        attempt('deadbeef-0000-4000-8000-000000000000', 'incorrect', '2026-09-01T10:00:00Z'),
      ])?.id,
    ).toBe(S1);
  });
});

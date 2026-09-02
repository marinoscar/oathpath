import {
  TEST_VERSION_V2008,
  TEST_VERSION_V2025,
  V2025_FILING_CUTOFF,
  filedFromFor,
  resolveTestVersionCode,
} from './test-version-resolution';

// =============================================================================
// Civics test version resolution — tests (issue #65, epic #50)
// =============================================================================
//
// The cutoff is a boundary, so the boundary is what is tested: the day before,
// the day itself, and the day after. An off-by-one here would silently hand a
// learner the wrong test — the wrong question count, the wrong pass threshold,
// and eventually the wrong content — with nothing on screen to reveal it.
// =============================================================================

describe('resolveTestVersionCode', () => {
  it('pins the cutoff at 2025-10-20', () => {
    // Asserted as a literal on purpose. This constant is the one place the
    // date exists, so a change to it is a product decision, and this line is
    // what makes that change deliberate rather than incidental.
    expect(V2025_FILING_CUTOFF).toBe('2025-10-20');
  });

  it('resolves a filing the day before the cutoff to the 2008 test', () => {
    expect(resolveTestVersionCode('2025-10-19')).toBe(TEST_VERSION_V2008);
  });

  it('resolves a filing ON the cutoff to the 2025 test', () => {
    // "on or after" — the cutoff day itself is a 2025 filing.
    expect(resolveTestVersionCode('2025-10-20')).toBe(TEST_VERSION_V2025);
  });

  it('resolves a filing the day after the cutoff to the 2025 test', () => {
    expect(resolveTestVersionCode('2025-10-21')).toBe(TEST_VERSION_V2025);
  });

  it.each([
    ['1999-01-01', TEST_VERSION_V2008],
    ['2024-12-31', TEST_VERSION_V2008],
    ['2026-09-02', TEST_VERSION_V2025],
    ['2099-12-31', TEST_VERSION_V2025],
  ])('resolves %s to %s', (filingDate, expected) => {
    expect(resolveTestVersionCode(filingDate)).toBe(expected);
  });

  it('is a pure function of the date, with no notion of "now"', () => {
    // The same input answers the same way whatever the system clock says,
    // which is why the resolver takes no Clock. Establishing this by moving
    // fake time under it is the cheapest way to keep a future refactor from
    // quietly introducing a time dependency.
    jest.useFakeTimers().setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const before = resolveTestVersionCode('2025-10-20');
    jest.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const after = resolveTestVersionCode('2025-10-20');
    jest.useRealTimers();

    expect(before).toBe(after);
    expect(before).toBe(TEST_VERSION_V2025);
  });
});

describe('filedFromFor', () => {
  it('reports the cutoff as the 2025 test’s lower bound', () => {
    expect(filedFromFor(TEST_VERSION_V2025)).toBe(V2025_FILING_CUTOFF);
  });

  it('reports no lower bound for the 2008 test', () => {
    // Null rather than an invented earliest date: the 2008 test applies to
    // every filing before the cutoff, and this product has no reason to name
    // a start date it cannot source.
    expect(filedFromFor(TEST_VERSION_V2008)).toBeNull();
  });

  it('reports no lower bound for a version it has no rule for', () => {
    // A future revision row inserted before this file learns about it must
    // not be given a fabricated eligibility date.
    expect(filedFromFor('v2031')).toBeNull();
  });
});

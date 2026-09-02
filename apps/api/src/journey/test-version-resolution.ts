// =============================================================================
// Civics test version resolution (issue #65, epic #50)
// =============================================================================
//
// USCIS changed the civics test for applicants who filed Form N-400 on or
// after 20 October 2025. A learner tells us their filing date; the SERVER
// decides which test applies. This file is the whole of that decision.
//
// -----------------------------------------------------------------------------
// THE CUTOFF DATE APPEARS EXACTLY ONCE IN THIS REPOSITORY, AND IT IS HERE
// -----------------------------------------------------------------------------
//
// journey-shell.md §11 rejects "computing `test_version_code` live from
// `filing_date` on every read" for precisely this reason: recomputing the
// cutoff at each call site is a second place the logic can drift from the
// first, the day the cutoff needs a historical carve-out. §3.2 makes the same
// point from the column's side — the version is resolved ONCE, at orientation
// submit time, and stored.
//
// So: no call site inlines `'2025-10-20'`, no call site re-derives it from a
// row, and nothing outside this file knows the rule. A future carve-out (a
// grace period, a per-state exception, a third test revision) is an edit to
// {@link resolveTestVersionCode} and to nothing else.
//
// -----------------------------------------------------------------------------
// E2 OWNS CONTENT PROVENANCE; THIS IS THE SINGLE PLACE TO CORRECT THE DATE
// -----------------------------------------------------------------------------
//
// E1 ships the test-version SHAPE, not the question bank. E2 (#51) loads the
// versioned, provenance-tracked content, hashes it into
// `civics_test_versions.content_hash`, and is the epic that verifies every
// content-derived figure against the authoritative USCIS source — the seeded
// pass thresholds and senior accommodation included (journey-shell.md §3.1).
//
// If E2's verification finds this cutoff differs from the authoritative
// source, THIS CONSTANT is the correction, and the only one: nothing else in
// the codebase encodes the date, so there is no second edit to remember and no
// call site that can keep the old answer.
// =============================================================================

/**
 * The Form N-400 filing date, inclusive, from which the 2025 civics test
 * applies. `YYYY-MM-DD` — a calendar date, not an instant, because a filing
 * happened on a day and no timezone should be able to move which day that was.
 *
 * The one place this date exists. See the header.
 */
export const V2025_FILING_CUTOFF = '2025-10-20';

/** The pre-2025 civics test. Matches the seeded `civics_test_versions.code`. */
export const TEST_VERSION_V2008 = 'v2008';

/** The 2025 civics test. Matches the seeded `civics_test_versions.code`. */
export const TEST_VERSION_V2025 = 'v2025';

/**
 * Which civics test applies to someone who filed Form N-400 on `filingDate`.
 *
 * @param filingDate a `YYYY-MM-DD` calendar date, already validated by the
 *   caller's schema. Zero-padded ISO dates compare correctly as strings, which
 *   is why this needs no `Date` and therefore no notion of "now" — the answer
 *   depends only on the date given, so it is stable forever and identical in
 *   every timezone.
 *
 * The comparison is `>=`: a filing ON the cutoff day is a 2025 filing.
 */
export function resolveTestVersionCode(filingDate: string): string {
  return filingDate >= V2025_FILING_CUTOFF
    ? TEST_VERSION_V2025
    : TEST_VERSION_V2008;
}

/**
 * The earliest filing date a test version applies to, or `null` when it has no
 * lower bound (the 2008 test applies to every filing before the cutoff, with
 * no start date this product needs to name).
 *
 * DERIVED, NOT A COLUMN. `civics_test_versions` deliberately stores the test's
 * SHAPE — how many questions, what passes — and not the eligibility rule,
 * because the rule is about filing dates rather than about the test, and a
 * column would put the cutoff in a second place (a seeded row) that this
 * file's whole purpose is to prevent. `GET /api/journey/profile` serves this
 * alongside each row so the orientation form can explain which test a date
 * will select, without the browser learning the rule either.
 *
 * Returns `null` for an unknown code: a version this file has no rule for has
 * no honest lower bound to report, and inventing one would be the same class
 * of fabricated fact journey-shell.md §10 rules out.
 */
export function filedFromFor(testVersionCode: string): string | null {
  switch (testVersionCode) {
    case TEST_VERSION_V2025:
      return V2025_FILING_CUTOFF;
    case TEST_VERSION_V2008:
      return null;
    default:
      return null;
  }
}

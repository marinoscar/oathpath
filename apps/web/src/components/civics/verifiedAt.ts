/**
 * "Current as of …" — how a `verifiedAt` instant becomes a date on screen.
 *
 * Issue #121, epic #51. One function, in one file, for the same reason
 * `apps/api/src/journey/test-version-resolution.ts` puts the filing cutoff in
 * one named file: the question list, the question detail and the back of every
 * flashcard all render this, and three inline `toLocaleDateString` calls is how
 * two of those screens end up disagreeing about how fresh the same fact is.
 *
 * =============================================================================
 * FORMATTED IN UTC, DELIBERATELY
 * =============================================================================
 *
 * `verifiedAt` is an instant, but what it means to a learner is a CALENDAR DAY
 * — the day a human reviewer confirmed this text against the official source.
 * Rendering it in the browser's own zone would move that day backwards by one
 * for anybody west of UTC whenever the stamp lands near midnight, so the same
 * verification would read as a different date depending on where it was opened.
 * A provenance claim that changes with the reader's timezone is not a
 * provenance claim.
 *
 * The LOCALE is deliberately the reader's (`undefined`), because the month name
 * and field order are presentation, and nothing about them can shift which day
 * is being asserted.
 */

const FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
};

/**
 * Formats an ISO instant as the calendar day it names in UTC.
 *
 * Returns null for null and for anything unparseable, so a caller renders
 * NOTHING rather than the string `Invalid Date` — a freshness claim nobody can
 * read is worse than no freshness claim, and this is content a learner is being
 * asked to trust.
 */
export function formatVerifiedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, FORMAT).format(date);
}

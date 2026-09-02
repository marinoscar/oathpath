/**
 * The interview countdown, and the invitation to set a date when there is none.
 *
 * Issue #74, epic #50, `docs/specs/journey-shell.md` §4.4 and §9.
 *
 * =============================================================================
 * THE DAY COUNT IS THE SERVER'S. NOTHING HERE COMPUTES IT.
 * =============================================================================
 *
 * `daysUntilInterview` arrives already counted, in whole CALENDAR days, in the
 * learner's own timezone, through the API's `Clock` (§4.4). This component
 * renders that integer and does no arithmetic on `interviewDate` at all.
 *
 * That restraint is the entire point of the field existing. A browser computing
 * `(interview - now) / 86_400_000` is wrong across a daylight-saving boundary
 * and wrong again for a learner whose device clock or timezone differs from the
 * profile they told us about — and "13 days" instead of "14 days" is not a
 * rounding detail to somebody counting down to their naturalization interview.
 *
 * `interviewDate` IS used, for one thing only: naming the date. Even that is
 * formatted from its `YYYY-MM-DD` parts through an explicit UTC timezone rather
 * than `new Date(s).toLocaleDateString()`, which parses a bare date string as
 * UTC midnight and then prints it in the viewer's local zone — showing 3
 * November to anybody west of Greenwich for a 4 November interview. See
 * `formatInterviewDate`.
 *
 * =============================================================================
 * A PAST DATE IS NOT A COUNTDOWN, AND IS NOT COUNTED UP
 * =============================================================================
 *
 * `interviewPast` gets its own honest state. We do not know how the interview
 * went — nobody has told us — so "your interview was 12 days ago" would be a
 * claim dressed as a status, which is the shape of fabricated confidence §10
 * rules out. It says the date has passed and offers the one thing that is
 * actually useful: a way to update it.
 *
 * `interviewPast` is read as its own fact rather than derived from a negative
 * count, so this surface and the API agree on where the boundary is (today is
 * NOT past).
 */

import { Box, Button, Typography } from '@mui/material';
import EventOutlinedIcon from '@mui/icons-material/EventOutlined';
import { Link as RouterLink } from 'react-router-dom';

import type { JourneyHome } from '../../types';

/**
 * Where a learner changes this date — the `Your plan` card #77 shipped.
 *
 * A route, not a fragment: `/settings` is a hub of separate routes, so a
 * `#`-anchor would land on the hub with the field one more click away and
 * nothing would report it as broken.
 */
const JOURNEY_SETTINGS_PATH = '/settings/journey';

/**
 * `YYYY-MM-DD` → a readable date, WITHOUT crossing a timezone on the way.
 *
 * The API sends a DAY, not an instant. `new Date('2026-11-04')` is UTC
 * midnight, and `toLocaleDateString()` then renders it in the viewer's zone —
 * one day early for every negative offset, which is most of the United States.
 * Building the date from its parts and formatting it back in UTC keeps the day
 * the learner typed the day the learner sees.
 *
 * Returns `null` for anything that is not a well-formed date string, so a
 * surprising value from the server degrades to "no date shown" rather than to
 * "Invalid Date" on the front page.
 */
export function formatInterviewDate(isoDate: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** "1 day", "12 days" — plural agreement, and nothing else. */
function dayCount(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

export interface InterviewCountdownProps {
  home: Pick<JourneyHome, 'interviewDate' | 'daysUntilInterview' | 'interviewPast'>;
  /** Ties the section to its heading for assistive technology. */
  headingId: string;
}

export function InterviewCountdown({ home, headingId }: InterviewCountdownProps) {
  const { interviewDate, daysUntilInterview, interviewPast } = home;
  const formatted = interviewDate ? formatInterviewDate(interviewDate) : null;

  return (
    <Box component="section" aria-labelledby={headingId} sx={{ mb: { xs: 3, sm: 4 } }}>
      <Typography
        id={headingId}
        component="h2"
        variant="overline"
        color="text.secondary"
        sx={{ display: 'block', letterSpacing: '0.08em' }}
      >
        Your interview
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mt: 1 }}>
        <EventOutlinedIcon aria-hidden color="action" sx={{ mt: 0.25, flexShrink: 0 }} />
        <Box sx={{ minWidth: 0 }}>
          {interviewDate === null ? (
            <>
              <Typography component="p" sx={{ fontWeight: 600 }}>
                No interview date yet
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mt: 0.5, maxWidth: '60ch' }}
              >
                Add the date of your naturalization interview and we&rsquo;ll count
                down with you.
              </Typography>
            </>
          ) : interviewPast ? (
            <>
              <Typography component="p" sx={{ fontWeight: 600 }}>
                Your interview date has passed
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mt: 0.5, maxWidth: '60ch' }}
              >
                {formatted
                  ? `We have it down as ${formatted}. If that has changed, update it and the countdown starts again.`
                  : 'If that has changed, update it and the countdown starts again.'}
              </Typography>
            </>
          ) : (
            <>
              {/* The number is the server's, rendered as it arrived. `0` is a
                  real, correct answer here — the interview is today — and is
                  nothing like the fabricated zero the goal ring refuses. */}
              <Typography component="p" sx={{ fontWeight: 600 }}>
                {daysUntilInterview === 0
                  ? 'Your interview is today'
                  : daysUntilInterview === null
                    ? 'Interview date set'
                    : `${dayCount(daysUntilInterview)} to go`}
              </Typography>
              {formatted && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ mt: 0.5, maxWidth: '60ch' }}
                >
                  {formatted}
                </Typography>
              )}
            </>
          )}

          {/* One affordance in all three states, and the same one: the only
              thing this surface can actually do about an interview date is send
              you to where it is edited. Its LABEL differs, because "Add" and
              "Update" are different promises and a link that lies about which
              one it is, is the kind of small dishonesty this epic is about. */}
          <Button
            component={RouterLink}
            to={JOURNEY_SETTINGS_PATH}
            size="small"
            sx={{ mt: 1, ml: -1 }}
          >
            {interviewDate === null ? 'Add your interview date' : 'Update your interview date'}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}

export default InterviewCountdown;

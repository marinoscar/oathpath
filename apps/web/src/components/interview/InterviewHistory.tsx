/**
 * "Your interviews" — the history band on `/practice/interviews`.
 *
 * Issue #145, epic #57 / E8. Built to the shape of
 * `components/practice/RecentSessions.tsx`, which is the same band answering
 * the same kind of question one level up, so the two read as one product rather
 * than as two lists that happen to sit on adjacent screens.
 *
 * =============================================================================
 * WHY A HISTORY LIST IS PART OF THE FEATURE AND NOT A NICETY
 * =============================================================================
 *
 * `docs/specs/mock-interview.md` §12 gives the reason `GET /api/interviews`
 * exists at all, and it is this band: **"did I do better on my second mock
 * interview than my first" is a real, expected question this product should be
 * able to answer**, and it cannot be answered if a debrief exists only as a
 * one-time response to the `complete` call that produced it. Every completed
 * row here links to a stored debrief that is still exactly as it was written.
 *
 * =============================================================================
 * WHAT A ROW CLAIMS, AND WHAT IT DELIBERATELY DOES NOT
 * =============================================================================
 *
 * `civicsAsked`, `civicsCorrect` and `passedCivics` come off the header row,
 * computed server-side. The row does no arithmetic on them: no percentage, no
 * "you passed 2 of 3 interviews", no trend arrow between two rows. A percentage
 * over eight answers is a precision the evidence does not support, and the
 * number a learner actually wants — readiness — is computed by the server over
 * the whole evidence table and rendered on the debrief and on `/progress`.
 *
 * `passedCivics` is `false` on every `in_progress` row, honestly rather than
 * prematurely: the civics section has not finished, so it has not been passed.
 * That is exactly why an unfinished row shows **no verdict at all** here rather
 * than a "not passed" chip it has not earned — and why it shows no counts
 * either. `docs/specs/mock-interview.md` §10 is a rule about the whole surface,
 * not only about the turn endpoint: a learner mid-interview who could read
 * "2 correct" off a list has been given the running score the live screen
 * refuses them, through a second door.
 *
 * =============================================================================
 * A FINISHED INTERVIEW LINKS TO ITS DEBRIEF; AN UNFINISHED ONE RESUMES
 * =============================================================================
 *
 * Two different affordances because they are two different acts, and both are
 * REAL `RouterLink`s — focusable, middle-clickable, and showing their target in
 * the status bar — never an `onClick` on a row-shaped div.
 *
 * An unfinished row's Resume is a separate button rather than the whole row
 * being a link, so its accessible name is the word "Resume" and not the row's
 * entire text read aloud — `RecentSessions` makes the same choice for the same
 * reason.
 *
 * An `abandoned` interview links to its debrief like a completed one. It cannot
 * be resumed (`POST /api/interviews/:id/complete` answers 409 for it), but a
 * `debrief` of null on that route is handled by the debrief page itself, which
 * says what state the interview is in rather than showing a broken screen.
 */

import {
  Box,
  Button,
  Chip,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { Link as RouterLink } from 'react-router-dom';

import type { InterviewListItem } from '../../types';
import { formatSessionDate } from '../practice/outcome';
import { interviewDebriefPath, interviewPath } from './paths';

export interface InterviewHistoryProps {
  interviews: InterviewListItem[];
  /** Ties the section to its heading for assistive technology. */
  headingId: string;
}

/**
 * What an interview's status is called on screen. Never throws.
 *
 * A `Record` with a fallback rather than a total lookup, the same open-set
 * discipline `sessionStatusLabel` and `phaseLabel` follow: `InterviewStatus` is
 * closed in TypeScript and open on the wire, and a row whose status this bundle
 * has never heard of is still a row the learner is entitled to read.
 *
 * `abandoned` is deliberately NOT called "abandoned" on screen. The database
 * calls it that because the row needs a name; a learner who closed a tab did
 * not abandon anything, and telling them they did is a judgement the product
 * has no business making — `sessionStatusLabel`'s own comment, and the same
 * `VISION.md` principle, applied to the more consequential of the two lists.
 */
const STATUS_LABELS: Record<string, string> = {
  in_progress: 'In progress',
  completed: 'Completed',
  abandoned: 'Left unfinished',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? 'Recorded';
}

/**
 * `${date} · 6 of 10 asked · 5 correct` — only the parts that are true, and
 * only once the interview is over.
 *
 * NOTHING BUT A DATE ON AN `in_progress` ROW. See the file header: counts on an
 * unfinished interview are the running score §10 keeps off the live screen.
 */
function describe(interview: InterviewListItem): string {
  const parts: string[] = [];
  const started = formatSessionDate(interview.startedAt);
  if (started) parts.push(started);

  if (interview.status !== 'in_progress') {
    parts.push(`${interview.civicsAsked} asked`);
    // Omitted rather than shown as zero when nothing was asked: "0 correct"
    // beside "0 asked" reads as a result, and there is no result yet.
    if (interview.civicsAsked > 0) parts.push(`${interview.civicsCorrect} correct`);
  }

  return parts.join(' · ');
}

export function InterviewHistory({ interviews, headingId }: InterviewHistoryProps) {
  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography
        id={headingId}
        variant="overline"
        component="h2"
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        Your interviews
      </Typography>

      <List disablePadding sx={{ mt: 1 }}>
        {interviews.map((interview) => {
          const secondary = describe(interview);

          if (interview.status === 'in_progress') {
            return (
              <ListItem
                key={interview.id}
                disableGutters
                secondaryAction={
                  <Button
                    component={RouterLink}
                    to={interviewPath(interview.id)}
                    variant="outlined"
                    size="small"
                  >
                    Resume
                  </Button>
                }
              >
                <ListItemText
                  primary={
                    <>
                      Mock interview{' '}
                      <Chip
                        label={statusLabel(interview.status)}
                        size="small"
                        sx={{ ml: 0.5 }}
                      />
                    </>
                  }
                  secondary={secondary}
                />
              </ListItem>
            );
          }

          return (
            <ListItem key={interview.id} disablePadding>
              <ListItemButton
                component={RouterLink}
                to={interviewDebriefPath(interview.id)}
                sx={{ borderRadius: 1 }}
              >
                <ListItemText
                  primary={
                    <>
                      Mock interview{' '}
                      {/* The verdict, as WORDS first, and only on a finished
                          interview — the only kind that has one.

                          Neutral rather than `error` on a miss, unlike the
                          debrief's own chip, and the difference is deliberate:
                          the debrief reports ONE result the learner just sat
                          and should read plainly, while this is a history a
                          learner scans. A column of red down the side of their
                          own record is the product characterising them across
                          time, which is precisely what §11.1 keeps the verdict
                          from doing. The words say the same thing either
                          way. */}
                      <Chip
                        label={
                          interview.passedCivics
                            ? 'Civics passed'
                            : 'Civics not passed'
                        }
                        color={interview.passedCivics ? 'success' : 'default'}
                        size="small"
                        sx={{ ml: 0.5 }}
                      />
                      {interview.status !== 'completed' && (
                        <Chip
                          label={statusLabel(interview.status)}
                          size="small"
                          sx={{ ml: 0.5 }}
                        />
                      )}
                    </>
                  }
                  secondary={secondary}
                />
                <ChevronRightIcon color="action" />
              </ListItemButton>
            </ListItem>
          );
        })}
      </List>
    </Box>
  );
}

export default InterviewHistory;

/**
 * "Recent sessions" — the third band of `/practice`.
 *
 * Issue #76, epic #52.
 *
 * =============================================================================
 * WHAT EACH ROW CLAIMS, AND WHY THE COUNTS COME FROM THE ROW AND NOT THE SUMMARY
 * =============================================================================
 *
 * `answeredCount` and `correctCount` are counted live from the attempt rows on
 * every request, ALONGSIDE the stored `summary`. That matters here specifically:
 * an `in_progress` or `abandoned` session has no summary at all, and a band
 * that read `session.summary.correct` would render a blank row for a learner
 * who answered three of five and left. Three is what happened, and three is
 * what the row says.
 *
 * The row deliberately does NOT show a percentage. "60%" over three answers is
 * a precision the evidence does not support, and readiness — the number a
 * learner actually wants — is E6's, computed over the whole evidence table with
 * the interview's own threshold in front of it.
 *
 * =============================================================================
 * A FINISHED SESSION LINKS TO ITS SUMMARY; AN UNFINISHED ONE OFFERS RESUME
 * =============================================================================
 *
 * Two different affordances because they are two different acts, and both are
 * REAL `RouterLink`s — focusable, middle-clickable, and showing their target in
 * the status bar — never an `onClick` on a row-shaped div.
 *
 * An unfinished row's Resume is a separate button rather than the whole row
 * being a link, so its accessible name is the word "Resume" and not the row's
 * entire text read aloud. An abandoned session gets the summary link like a
 * completed one: it cannot be resumed (the API refuses to complete it — it was
 * closed when a later session started), but the attempts it produced are real
 * and worth reading back.
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

import type { PracticeSessionListItem } from '../../types';
import { formatSessionDate, sessionKindLabel, sessionStatusLabel } from './outcome';

export interface RecentSessionsProps {
  sessions: PracticeSessionListItem[];
  /** Ties the section to its heading for assistive technology. */
  headingId: string;
}

/** `${date} · 3 of 5 answered · 2 correct` — only the parts that are true. */
function describe(session: PracticeSessionListItem): string {
  const parts: string[] = [];
  const started = formatSessionDate(session.startedAt);
  if (started) parts.push(started);
  parts.push(`${session.answeredCount} of ${session.plannedCount} answered`);
  // Omitted rather than shown as zero when nothing was answered: "0 correct"
  // beside "0 of 5 answered" reads as a result, and there is no result yet.
  if (session.answeredCount > 0) parts.push(`${session.correctCount} correct`);
  return parts.join(' · ');
}

export function RecentSessions({ sessions, headingId }: RecentSessionsProps) {
  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography
        id={headingId}
        variant="overline"
        component="h2"
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        Recent sessions
      </Typography>

      <List disablePadding sx={{ mt: 1 }}>
        {sessions.map((session) => {
          const label = sessionKindLabel(session.kind);
          const secondary = describe(session);

          if (session.status === 'in_progress') {
            return (
              <ListItem
                key={session.id}
                disableGutters
                secondaryAction={
                  <Button
                    component={RouterLink}
                    to={`/practice/sessions/${session.id}`}
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
                      {label}{' '}
                      <Chip
                        label={sessionStatusLabel(session.status)}
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
            <ListItem key={session.id} disablePadding>
              <ListItemButton
                component={RouterLink}
                to={`/practice/sessions/${session.id}/summary`}
                sx={{ borderRadius: 1 }}
              >
                <ListItemText
                  primary={
                    session.status === 'completed' ? (
                      label
                    ) : (
                      <>
                        {label}{' '}
                        <Chip
                          label={sessionStatusLabel(session.status)}
                          size="small"
                          sx={{ ml: 0.5 }}
                        />
                      </>
                    )
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

export default RecentSessions;

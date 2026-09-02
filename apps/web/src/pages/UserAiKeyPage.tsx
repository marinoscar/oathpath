/**
 * Settings → AI key (`/settings/ai`).
 *
 * Issue #42, epic #25. Once a user is past onboarding (#41) they still need a
 * permanent home to replace a rotated key, remove it, and see what they have
 * spent — the whole point of BYOK.
 *
 * REUSES `AiKeyForm` (#40) IN THE ORDINARY SETTINGS CHROME. One component, two
 * surfaces; it is not forked, and the props carry the only differences (Remove
 * is offered here, and there is no hand-off — the user is already where they
 * want to be).
 *
 * =============================================================================
 * THIS IS RECORDED USAGE, NOT A BILL, AND THE PAGE HAS TO SAY SO
 * =============================================================================
 *
 * Token counts are not dollars: pricing differs per model, changes without
 * notice, and this application carries no price table. Calls that fail
 * mid-stream record nothing at all — `callsWithUnknownUsage` is how many. The
 * authoritative number is the user's own OpenAI dashboard, which is linked.
 *
 * Presenting an approximate figure as a bill is the failure to avoid, and it
 * would start with someone adding a "$" to a number on this page. The API's
 * response type carries a compile-time proof that no currency field exists to
 * render; this page's job is to make the caveat visible rather than fine print.
 *
 * =============================================================================
 * NO `permission` ON THE CARD OR THE ROUTE
 * =============================================================================
 *
 * Like every card in `userSettingsSections.tsx`: every authenticated user owns
 * their own credentials, and the endpoints behind this page are `@Auth()` with
 * no permissions for the same reason. A gate here would invent an
 * authorization rule the API does not enforce — and, because a keyless user is
 * hard-blocked (#39), would leave the gated role unable to use the app at all.
 */

import {
  Alert,
  Box,
  Container,
  Link,
  MenuItem,
  Paper,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useNavigate } from 'react-router-dom';

import { AiKeyForm } from '../components/ai/AiKeyForm';
import { useAiStatus } from '../contexts/AiStatusContext';
import { useAiUsage } from '../hooks/useAiUsage';
import type { AiUsageBreakdown } from '../types';

/** Where the authoritative number lives. */
const OPENAI_USAGE_URL = 'https://platform.openai.com/usage';

/** The windows offered. Small enough to answer "lately", long enough for a month. */
const WINDOWS = [7, 30, 90] as const;

export default function UserAiKeyPage() {
  const { refresh: refreshStatus } = useAiStatus();
  const { usage, isLoading, error, days, setDays } = useAiUsage();
  const navigate = useNavigate();

  /**
   * Removing the key re-arms the first-run gate.
   *
   * The status must be refreshed BEFORE navigating, or the gate is still
   * holding the stale "key configured" answer and the user stays in an app
   * that no longer works for them. Sending them to the setup screen
   * deliberately, rather than leaving them here, is what makes the removal
   * legible: they see immediately what it did.
   */
  async function handleRemoved() {
    await refreshStatus();
    navigate('/setup/ai-key', { replace: true });
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          AI key
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Your own OpenAI key, and what it has been used for.
        </Typography>

        <Paper sx={{ p: { xs: 2, sm: 3 }, mb: 4 }}>
          <AiKeyForm headingLevel="h2" showRemove onRemoved={handleRemoved} />
        </Paper>

        <Typography variant="h5" component="h2" gutterBottom>
          Usage
        </Typography>

        {/* THE CAVEAT, ABOVE THE NUMBERS RATHER THAN BELOW THEM. A note under a
            total is read after the total has already been believed. */}
        <Alert severity="info" sx={{ mb: 2 }}>
          These are the requests OathPath has made with your key — not a bill.
          OathPath does not know what OpenAI charges, and some requests do not
          report their size. Your{' '}
          <Link href={OPENAI_USAGE_URL} target="_blank" rel="noopener noreferrer">
            OpenAI usage page
          </Link>{' '}
          is the real record.
        </Alert>

        <TextField
          select
          size="small"
          label="Period"
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          sx={{ mb: 2, minWidth: 160 }}
        >
          {WINDOWS.map((window) => (
            <MenuItem key={window} value={window}>
              Last {window} days
            </MenuItem>
          ))}
        </TextField>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {isLoading && <Skeleton variant="rounded" height={160} />}

        {!isLoading && usage && usage.calls === 0 && (
          // A SENSIBLE EMPTY STATE, not a broken chart. This is what every user
          // sees on the day they finish onboarding.
          <Paper variant="outlined" sx={{ p: 3 }}>
            <Typography variant="body1" gutterBottom>
              Nothing yet.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Once you start practising, the requests OathPath makes with your
              key will appear here.
            </Typography>
          </Paper>
        )}

        {!isLoading && usage && usage.calls > 0 && (
          <>
            <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 2 }}>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(3, 1fr)' },
                  gap: 2,
                }}
              >
                <Figure label="Requests" value={usage.calls.toLocaleString()} />
                <Figure
                  label="Tokens"
                  value={usage.totalTokens.toLocaleString()}
                />
                <Figure
                  label="Succeeded"
                  value={`${usage.successfulCalls.toLocaleString()} of ${usage.calls.toLocaleString()}`}
                />
              </Box>

              {/* SURFACED, NOT HIDDEN. A total with 40 unaccounted requests
                  behind it is a different thing from one with none, and only
                  this line lets the reader tell. */}
              {usage.callsWithUnknownUsage > 0 && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  component="p"
                  sx={{ mt: 2 }}
                >
                  {usage.callsWithUnknownUsage.toLocaleString()} of these
                  requests did not report their size, so they are not counted in
                  the token total.
                </Typography>
              )}
            </Paper>

            <Breakdown title="By model" rows={usage.byModel} />
            <Breakdown title="By activity" rows={usage.byRole} />
          </>
        )}
      </Box>
    </Container>
  );
}

/** One headline number. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="div">
        {label}
      </Typography>
      <Typography variant="h6" component="div">
        {value}
      </Typography>
    </Box>
  );
}

/**
 * One breakdown table.
 *
 * A TABLE RATHER THAN A CHART, deliberately. A chart of token counts invites
 * reading them as spend, needs a library, and is unreadable at 360px. The
 * numbers here are exact and small in count; a table says what they are
 * without implying more precision than the data has.
 */
function Breakdown({
  title,
  rows,
}: {
  title: string;
  rows: AiUsageBreakdown[];
}) {
  if (rows.length === 0) return null;

  return (
    <Paper variant="outlined" sx={{ mb: 2, overflowX: 'auto' }}>
      <Typography variant="subtitle2" component="h3" sx={{ p: 2, pb: 1 }}>
        {title}
      </Typography>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Name</TableCell>
            <TableCell align="right">Requests</TableCell>
            <TableCell align="right">Tokens</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell>{row.key}</TableCell>
              <TableCell align="right">{row.calls.toLocaleString()}</TableCell>
              <TableCell align="right">
                {row.totalTokens.toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}

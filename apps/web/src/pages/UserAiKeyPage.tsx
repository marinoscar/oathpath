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
 * THIS PAGE STILL COMPUTES NO DOLLAR FIGURE — IT JUST STOPPED PRETENDING THAT
 * WAS THE ANSWER (issue #291)
 * =============================================================================
 *
 * Token counts are not dollars: pricing differs per model, changes without
 * notice, and this application carries no price table — the API's response
 * type carries a compile-time proof that no currency field exists to render,
 * and that has not changed. What changed is where "how much have I spent"
 * gets answered: the `OpenAiSpendCard` below is a prominent, always-visible
 * link to the user's own OpenAI usage dashboard, because that dashboard is
 * the one place a real number lives. The caveat `Alert` used to carry a
 * paragraph pre-emptively arguing against a figure this page has never
 * shown; now that the real answer has its own card, the alert says the one
 * remaining thing worth saying (these are counts, not a bill) and gets out
 * of the way.
 *
 * The trend chart added below the stat Figures is EXACT RECORDED DATA, one
 * row per day from `usage.timeline` — not a projection, not a smoothing, not
 * an estimate of anything. Charting it doesn't reopen the "is this a bill"
 * question: a token count plotted over time is still a token count.
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

import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {
  Alert,
  Box,
  Button,
  Container,
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
import { useTheme } from '@mui/material/styles';
import { LineChart } from '@mui/x-charts/LineChart';
import { useNavigate } from 'react-router-dom';

import { AiKeyForm } from '../components/ai/AiKeyForm';
import { useAiStatus } from '../contexts/AiStatusContext';
import { useAiUsage } from '../hooks/useAiUsage';
import type { AiUsageBreakdown, AiUsageTimelinePoint } from '../types';

/** Where the authoritative number lives. */
const OPENAI_USAGE_URL = 'https://platform.openai.com/usage';

/** The windows offered. Small enough to answer "lately", long enough for a month. */
const WINDOWS = [7, 30, 90] as const;

/**
 * The trend line's color, in both theme modes.
 *
 * This is categorical slot 1 ("blue") from this codebase's data-viz palette
 * — chosen, rather than reached for arbitrarily, because it is also the same
 * hue family as this app's own MUI `primary` color (`theme/light.ts`'s
 * `#1976d2`, `theme/dark.ts`'s `#90caf9`). A single-series chart needs no
 * legend (see `marks-and-anatomy.md`'s "a single series needs no legend
 * box" rule) precisely because there is only one color in play, so it is
 * worth that color being the one the rest of the app already uses for "the
 * thing being highlighted".
 */
const TREND_LINE_COLOR_LIGHT = '#2a78d6';
const TREND_LINE_COLOR_DARK = '#3987e5';

/** Tick/tooltip date formatting. UTC, matching `timeline[].date`'s own UTC bucketing. */
const shortDayFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const longDayFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const compactTokenFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
});

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

        {/* ALWAYS RENDERED — loading, empty, and populated states alike. It
            costs nothing to show and answers the one question ("how much have
            I spent") that everything below this line deliberately does not. */}
        <OpenAiSpendCard />

        {/* THE CAVEAT, ABOVE THE NUMBERS RATHER THAN BELOW THEM. A note under a
            total is read after the total has already been believed. Short,
            now that the card above carries the "where's the real number"
            answer — this only needs to say what these counts are NOT. */}
        <Alert severity="info" sx={{ mb: 2 }}>
          These are request and token counts OathPath made with your key —
          not a bill, and not an estimate of one.
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

            <TokenTrendChart timeline={usage.timeline} />

            <Breakdown title="By model" rows={usage.byModel} />
            <Breakdown title="By activity" rows={usage.byRole} />
          </>
        )}
      </Box>
    </Container>
  );
}

/**
 * THE ACTUAL ANSWER TO "HOW MUCH HAVE I SPENT."
 *
 * Not a card that computes this app's own number — a card that sends the
 * reader to OpenAI's, which is the only number that is ever correct (it
 * knows the per-model price, the promotional credits, the org-level
 * discounts — none of which this app has any way to see). It sits above
 * every count on this page and is rendered unconditionally: someone with
 * zero recorded calls still has an OpenAI account worth checking, and
 * someone with ten thousand calls still wants the link, not a repeat of the
 * token total they just saw.
 */
function OpenAiSpendCard() {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: { xs: 2, sm: 3 },
        mb: 2,
        display: 'flex',
        flexDirection: { xs: 'column', sm: 'row' },
        alignItems: { xs: 'stretch', sm: 'center' },
        justifyContent: 'space-between',
        gap: 2,
      }}
    >
      <Box>
        <Typography variant="subtitle1" component="h3">
          Your actual spending
        </Typography>
        <Typography variant="body2" color="text.secondary">
          OathPath doesn't know what OpenAI charges you. Your OpenAI account
          does — it's the real, current number.
        </Typography>
      </Box>
      <Button
        variant="outlined"
        endIcon={<OpenInNewIcon />}
        href={OPENAI_USAGE_URL}
        target="_blank"
        rel="noopener noreferrer"
        sx={{ flexShrink: 0, alignSelf: { xs: 'stretch', sm: 'center' } }}
      >
        Open OpenAI usage
      </Button>
    </Paper>
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
 * The token-usage trend, one point per day, over the selected window.
 *
 * A CHART HERE, A TABLE BELOW — deliberately different forms for different
 * jobs. `byModel`/`byRole` are a handful of rows each, and a table shows
 * exact numbers without implying more precision than a handful of rows has.
 * A trend over up to 90 days is the shape a table is bad at: nobody scans 90
 * rows to answer "is this going up" the way one glance at a line answers it.
 * (`Breakdown`'s own doc comment below made this same table-over-chart
 * argument before this page had any chart to contrast it with; both are
 * still true, about different data.)
 *
 * ONE SERIES, NOT TWO. `calls` and `totalTokens` sit on very different
 * scales (tens of requests a day vs. tens of thousands of tokens), and
 * plotting both here means either a second y-axis — which this codebase's
 * chart guidelines rule out outright, it is the single most common charting
 * mistake — or normalizing one series into meaninglessness. Tokens is the
 * series the reader came for; `calls` already has a home in the Figures
 * above and the tables below, at its own scale.
 */
function TokenTrendChart({ timeline }: { timeline: AiUsageTimelinePoint[] }) {
  const theme = useTheme();

  if (timeline.length === 0) {
    // Defensive only. The API sends one row per day of the window, including
    // zero-activity days, so this should not happen for a caller who has
    // already cleared `usage.calls > 0` above. If it ever does, render
    // nothing rather than a chart with no data behind it.
    return null;
  }

  const first = timeline[0];
  const last = timeline[timeline.length - 1];
  const firstDate = new Date(`${first.date}T00:00:00Z`);
  const lastDate = new Date(`${last.date}T00:00:00Z`);

  const rangeCaption =
    timeline.length === 1
      ? longDayFormatter.format(firstDate)
      : `${shortDayFormatter.format(firstDate)} – ${shortDayFormatter.format(lastDate)}`;

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 2 }}>
      <Typography variant="subtitle2" component="h3" id="ai-usage-trend-heading">
        Tokens per day
      </Typography>
      <Typography
        variant="body2"
        color="text.secondary"
        id="ai-usage-trend-desc"
        sx={{ mb: 2 }}
      >
        {rangeCaption} — exact recorded totals, not an estimate.
      </Typography>

      {timeline.length === 1 ? (
        // A SINGLE DAY CANNOT DRAW A TREND. One point has no slope to show,
        // and a chart holding one floating dot reads as broken rather than
        // as "not enough data yet". Say the one number in words instead —
        // this is the brand-new-account case the page has to handle without
        // looking like something failed to load.
        <Typography variant="body1">
          {first.totalTokens.toLocaleString()} tokens across{' '}
          {first.calls.toLocaleString()}{' '}
          {first.calls === 1 ? 'request' : 'requests'}.
        </Typography>
      ) : (
        <Box
          aria-labelledby="ai-usage-trend-heading"
          aria-describedby="ai-usage-trend-desc"
          sx={{ width: '100%' }}
        >
          <LineChart
            height={260}
            series={[
              {
                data: timeline.map((point) => point.totalTokens),
                label: 'Tokens',
                color:
                  theme.palette.mode === 'dark'
                    ? TREND_LINE_COLOR_DARK
                    : TREND_LINE_COLOR_LIGHT,
                area: true,
                curve: 'linear',
                // Every point gets a mark up to 21 days (~3 weeks — still
                // legible); past that, only the ends are marked so 90 daily
                // points don't turn into a solid row of dots. The line
                // itself still carries the full shape either way.
                showMark:
                  timeline.length <= 21
                    ? true
                    : ({ index }) =>
                        index === 0 || index === timeline.length - 1,
                valueFormatter: (value) =>
                  value === null ? '' : `${value.toLocaleString()} tokens`,
              },
            ]}
            xAxis={[
              {
                data: timeline.map(
                  (point) => new Date(`${point.date}T00:00:00Z`),
                ),
                scaleType: 'point',
                tickLabelStyle: { angle: -40, textAnchor: 'end', fontSize: 11 },
                // 'auto' thins ticks by measured label width rather than a
                // fixed stride, so this holds up whether the window is 7
                // days or 90 without a special case for either.
                tickLabelInterval: 'auto',
                tickLabelMinGap: 12,
                valueFormatter: (value: Date, context) =>
                  context.location === 'tick'
                    ? shortDayFormatter.format(value)
                    : longDayFormatter.format(value),
              },
            ]}
            yAxis={[
              {
                min: 0,
                label: 'Tokens',
                valueFormatter: (value: number, context: { location: string }) =>
                  context.location === 'tick'
                    ? compactTokenFormatter.format(value)
                    : value.toLocaleString(),
              },
            ]}
            grid={{ horizontal: true }}
            margin={{ left: 56, right: 16, top: 16, bottom: 56 }}
            // A single series needs no legend box — there is only one color,
            // and the heading above already names it (marks-and-anatomy.md).
            hideLegend
            // The chart's own accessible name/description, rendered as a
            // real <title>/<desc> inside the SVG — not only the visually
            // associated heading above, which the aria-labelledby/describedby
            // on this Box also points assistive tech at.
            title="Tokens per day"
            desc={`Recorded token totals per day, ${rangeCaption}.`}
            sx={{
              '& .MuiLineChart-line': { strokeWidth: 2 },
              '& .MuiLineChart-area': { fillOpacity: 0.12 },
              '& .MuiChartsAxis-line': { stroke: theme.palette.divider },
              '& .MuiChartsAxis-tick': { stroke: theme.palette.divider },
              '& .MuiChartsAxis-tickLabel': {
                fill: theme.palette.text.secondary,
              },
              '& .MuiChartsGrid-line': {
                stroke: theme.palette.divider,
                strokeOpacity: 0.6,
              },
            }}
          />
        </Box>
      )}
    </Paper>
  );
}

/**
 * One breakdown table.
 *
 * A TABLE RATHER THAN A CHART, deliberately. A chart of token counts invites
 * reading them as spend, needs a library, and is unreadable at 360px. The
 * numbers here are exact and small in count; a table says what they are
 * without implying more precision than the data has. (`TokenTrendChart`
 * above is the different case: up to 90 rows of the same shape, where a
 * table stops being the more readable form — see its own doc comment.)
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

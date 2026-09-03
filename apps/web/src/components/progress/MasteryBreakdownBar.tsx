/**
 * A stacked, segmented bar showing one scope's mastery breakdown — the shared
 * visual `/progress` uses for both the overall summary and every category
 * card, so the two read as one system rather than two ad hoc renderings of
 * the same five counts.
 *
 * Issue #94, epic #54 / E5 "Memory". No charting library: this app has none
 * (`apps/web/package.json`), and five proportional segments plus a legend
 * are exactly what `CLAUDE.md`'s guidance for this page asks for — "simple
 * bar/percentage displays" over `LinearProgress`-adjacent primitives, not a
 * new dependency.
 *
 * A ZERO-TOTAL SCOPE RENDERS NOTHING BUT ITS LEGEND, never a bar claiming a
 * segment where there are no questions at all — `total === 0` is a real
 * value (an empty category should not exist server-side, but a defensive
 * client does not divide by it).
 */

import { Box, Typography } from '@mui/material';

import type { MasteryStateCounts } from '../../types';
import { MASTERY_STATE_ORDER, masteryStateDisplay } from './mastery';

export interface MasteryBreakdownBarProps {
  byState: MasteryStateCounts;
  total: number;
  /** Ties the bar to a heading for assistive technology, e.g. a category name. */
  'aria-label': string;
}

export function MasteryBreakdownBar({
  byState,
  total,
  'aria-label': ariaLabel,
}: MasteryBreakdownBarProps) {
  const segments = MASTERY_STATE_ORDER.map((state) => ({
    state,
    count: byState[state] ?? 0,
    ...masteryStateDisplay(state),
  }));

  return (
    <Box>
      {total > 0 && (
        <Box
          role="img"
          aria-label={ariaLabel}
          sx={{
            display: 'flex',
            height: 10,
            borderRadius: 5,
            overflow: 'hidden',
            // The 2px surface gap between segments — each segment's own
            // border acts as the gap, so it survives on any background
            // without a second element per boundary.
            bgcolor: 'action.disabledBackground',
          }}
        >
          {segments
            .filter((segment) => segment.count > 0)
            .map((segment) => (
              <Box
                key={segment.state}
                sx={{
                  width: `${(segment.count / total) * 100}%`,
                  bgcolor:
                    segment.color === 'default'
                      ? 'action.disabled'
                      : `${segment.color}.main`,
                  borderRight: '2px solid',
                  borderColor: 'background.paper',
                  '&:last-of-type': { borderRight: 'none' },
                }}
              />
            ))}
        </Box>
      )}

      <Box
        component="dl"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: { xs: 1.5, sm: 2 },
          mt: 1,
          mb: 0,
        }}
      >
        {segments.map((segment) => (
          <Box
            key={segment.state}
            sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}
          >
            <Box
              aria-hidden
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                flexShrink: 0,
                bgcolor:
                  segment.color === 'default'
                    ? 'action.disabled'
                    : `${segment.color}.main`,
              }}
            />
            <Typography component="dt" variant="caption" color="text.secondary">
              {segment.label}
            </Typography>
            <Typography component="dd" variant="caption" sx={{ m: 0, fontWeight: 600 }}>
              {segment.count}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

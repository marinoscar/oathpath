/**
 * The full eight-component readiness breakdown, in plain language.
 *
 * Issue #139, epic #55 / E6, `docs/specs/readiness-model.md` §2. Renders
 * `components`/`evidenceCounts` in `READINESS_COMPONENT_ORDER` — never
 * re-sorted — with a `<dl>` structure matching `MasteryBreakdownBar`'s own
 * legend, so the two lists read as one system.
 *
 * THE HONESTY RULE (MANDATORY, §2.6-§2.8): `english`, `spoken` and
 * `interview` render "No evidence yet" rather than a `0%` bar whenever
 * `readinessHasNoEvidence` says so — never a bar or percentage that could be
 * mistaken for a real, failing measurement. The five currently-earnable
 * components always render their real value, `recall`'s own sub-5-attempt
 * `0` included — that is a genuine, already-honest server-computed answer
 * (§2.2), not a component this file has any reason to second-guess.
 */

import { Box, LinearProgress, Typography } from '@mui/material';

import type { ReadinessComponents, ReadinessEvidenceCounts } from '../../types';
import {
  READINESS_COMPONENT_LABELS,
  READINESS_COMPONENT_ORDER,
  UNWIRED_READINESS_COMPONENTS,
  readinessHasNoEvidence,
} from './readiness';

export interface ReadinessBreakdownProps {
  components: ReadinessComponents;
  evidenceCounts: ReadinessEvidenceCounts;
}

export function ReadinessBreakdown({ components, evidenceCounts }: ReadinessBreakdownProps) {
  return (
    <Box component="dl" sx={{ m: 0 }}>
      {READINESS_COMPONENT_ORDER.map((key) => {
        const label = READINESS_COMPONENT_LABELS[key];
        const noEvidence =
          UNWIRED_READINESS_COMPONENTS.has(key) &&
          readinessHasNoEvidence(key, evidenceCounts);
        const percent = Math.round(components[key].value * 100);

        return (
          <Box key={key} sx={{ mb: 2, '&:last-of-type': { mb: 0 } }}>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 1,
              }}
            >
              <Typography component="dt" variant="body2">
                {label}
              </Typography>
              <Typography
                component="dd"
                variant="body2"
                color={noEvidence ? 'text.secondary' : 'text.primary'}
                sx={{ m: 0, fontWeight: noEvidence ? 400 : 600 }}
              >
                {noEvidence ? 'No evidence yet' : `${percent}%`}
              </Typography>
            </Box>
            {!noEvidence && (
              <LinearProgress
                variant="determinate"
                value={percent}
                sx={{ height: 6, borderRadius: 3, mt: 0.5 }}
                aria-label={`${label}: ${percent}%`}
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export default ReadinessBreakdown;
